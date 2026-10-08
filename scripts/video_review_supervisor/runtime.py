"""Atomic state and bounded process execution (Linux/WSL, Python standard library)."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


class Blocked(RuntimeError):
    pass


class Stopped(Blocked):
    pass


def atomic(path, value):
    path = Path(path)
    tmp = path.with_suffix(path.suffix + '.tmp')
    with tmp.open('w') as out:
        json.dump(value, out, indent=2)
        out.write('\n')
        out.flush()
        os.fsync(out.fileno())
    os.replace(tmp, path)
    fd = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def read(path):
    return json.loads(Path(path).read_text())


def digest():
    return hashlib.sha256(b''.join(p.read_bytes() for p in sorted(Path(__file__).parent.glob('*.py')))).hexdigest()


def clean_env():
    # Do not pass application/provider credentials to subprocesses.
    keys = ('PATH', 'HOME', 'USER', 'LANG', 'TERM', 'CODEX_HOME', 'XDG_CONFIG_HOME',
            'SSL_CERT_FILE', 'SSL_CERT_DIR')
    return {**{k: os.environ[k] for k in keys if k in os.environ},
            'GIT_TERMINAL_PROMPT': '0', 'GH_PROMPT_DISABLED': '1',
            'NEXT_TELEMETRY_DISABLED': '1', 'PYTHONDONTWRITEBYTECODE': '1'}


def command(args, cwd=None, timeout=60):
    try:
        p = subprocess.run(list(map(str, args)), cwd=cwd, env=clean_env(),
                           text=True, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise Blocked(f'Command timed out: {args[:3]}') from exc
    if p.returncode:
        raise Blocked(f'Command failed ({p.returncode}): {args[:3]}: {p.stderr[-1500:]}')
    return p.stdout.strip()


class Run:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = (self.root / 'run.lock').open('a+')
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            self.lock.close()
            raise Blocked('Supervisor or orphan worker still holds the run lock') from exc
        self.state = read(self.root / 'checkpoint.json') if (self.root / 'checkpoint.json').exists() else {}

    def save(self):
        self.state['updated_at'] = time.time()
        atomic(self.root / 'checkpoint.json', self.state)
        lines = [f'STATUS: {self.state.get("status")}',
                 f'PHASE: {self.state.get("phase", 0) + 1}',
                 f'NEXT: {self.state.get("next_step")}',
                 f'BLOCKERS: {self.state.get("blockers", [])}',
                 f'MODE: {"OFFLINE FAKE" if self.state.get("dry_run") else "REAL"}']
        for phase in self.state.get('phases', []):
            lines.append(f'{phase["name"]}: {phase["step"]}; HEAD={phase["head"]}; PR={phase.get("pr")}')
            lines.append('  Completed: ' + phase.get('result', {}).get('summary', 'No implementation result'))
            lines.append('  Tests (worker evidence): ' + '; '.join(phase.get('tests', [])))
            lines.append('  GitHub CI: ' + json.dumps(phase.get('ci')))
            review = phase.get('review') or {}
            lines.append('  Independent review: ' + str(review.get('status', 'pending'))
                         + '; SHA=' + str(review.get('head', 'N/A')))
        (self.root / 'handoff.txt').write_text('\n'.join(lines) + '\n')

    def event(self, kind, **fields):
        with (self.root / 'events.jsonl').open('a') as out:
            out.write(json.dumps({'time': time.time(), 'event': kind, **fields}) + '\n')
            out.flush()
            os.fsync(out.fileno())

    def stop_check(self):
        if (self.root / 'STOP').exists():
            raise Stopped('Stop requested; resume continues from the durable checkpoint')
        if time.time() > self.state.get('deadline', float('inf')):
            raise Blocked('Eight-hour run budget exhausted; inspect before starting another run')

    def wait(self, seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            self.stop_check()
            time.sleep(min(0.2, max(0, end - time.monotonic())))

    def execute(self, args, cwd, directory, prompt, timeout):
        """Worker receipt survives parent SIGKILL. Inherited flock prevents overlap."""
        directory.mkdir(parents=True, exist_ok=True)
        receipt = directory / 'exit.json'
        if receipt.exists():
            return read(receipt)['returncode']
        (directory / 'prompt.txt').write_text(prompt)
        spec = {'args': args, 'cwd': str(cwd), 'directory': str(directory),
                'timeout': timeout, 'lock_fd': self.lock.fileno()}
        atomic(directory / 'launch.json', spec)
        child = subprocess.Popen([sys.executable, __file__, str(directory / 'launch.json')],
                                 start_new_session=True, pass_fds=(self.lock.fileno(),), env=clean_env())
        try:
            while child.poll() is None:
                self.wait(0.2)
        except BaseException:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
            raise
        if not receipt.exists():
            raise Blocked('Worker exited without a durable receipt; inspect preserved attempt')
        return read(receipt)['returncode']

    def close(self):
        self.lock.close()


def worker(path):
    spec = read(path)
    directory = Path(spec['directory'])
    # Parent may be killed: keep the inherited lock and bound the entire Codex process group.
    with (directory / 'prompt.txt').open() as inp, (directory / 'codex.jsonl').open('w') as out, (directory / 'stderr.log').open('w') as err:
        p = subprocess.Popen(spec['args'], cwd=spec['cwd'], stdin=inp, stdout=out, stderr=err,
                             env=clean_env(), pass_fds=(spec['lock_fd'],))
        try:
            rc = p.wait(timeout=spec['timeout'])
        except subprocess.TimeoutExpired:
            # kill all children, including command grandchildren, not just the CLI leader
            atomic(directory / 'exit.json', {'returncode': 124})
            os.killpg(os.getpgrp(), signal.SIGKILL)
        atomic(directory / 'exit.json', {'returncode': rc})


if __name__ == '__main__':
    worker(sys.argv[1])
