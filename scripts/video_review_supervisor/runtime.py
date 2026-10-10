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
import uuid


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


def status_snapshot(root):
    """Read-only observations, not permission to execute or proof of CI/review validity."""
    root = Path(root)
    state = read(root / 'checkpoint.json')
    # Never create/replace the lock or acquire Run (which creates directories).
    try:
        with (root / 'run.lock').open('r') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                authority = 'available_at_probe'
            except BlockingIOError:
                authority = 'held_by_supervisor_or_worker'
    except FileNotFoundError:
        authority = 'missing'
    lifecycle = read(root / 'supervisor.json') if (root / 'supervisor.json').exists() else None
    pending = None
    index = state.get('phase', 0)
    phases = state.get('phases', [])
    if index < len(phases) and phases[index].get('pending'):
        attempt = phases[index]['pending']
        directory = Path(attempt['directory'])
        # Do not follow paths outside the run, including symlinks.
        if not directory.resolve().is_relative_to(root.resolve() / 'attempts'):
            pending = {'observation': 'outside_run_attempts'}
        else:
            receipt = directory / 'exit.json'
            pending = {'role': attempt['role'], 'assigned_head': attempt['head'],
                       'observation': 'receipt_available' if receipt.exists() else 'no_receipt'}
            if receipt.exists() and not receipt.resolve().is_relative_to(root.resolve() / 'attempts'):
                pending['observation'] = 'receipt_outside_run_attempts'
            elif receipt.exists():
                pending['returncode'] = read(receipt)['returncode']
    diagnosis = 'no_lifecycle_evidence'
    if lifecycle:
        diagnosis = 'observed_exit' if lifecycle.get('exit') else (
            'exit_unobserved_cause_unknown' if authority == 'available_at_probe'
            else 'lock_held_parent_liveness_unknown' if authority == 'held_by_supervisor_or_worker'
            else 'no_lock_evidence')
    state['reconciliation'] = {'lock': authority, 'supervisor': lifecycle,
                               'diagnosis': diagnosis, 'pending': pending,
                               'note': 'Snapshot only; resume reacquires lock and revalidates HEAD, source and CI.'}
    return state


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


def group_alive(pgid):
    # Linux/WSL: a reparented descendant can outlive the group leader. Zombies
    # cannot execute or hold the run lock, and may linger until init reaps them.
    for stat in Path('/proc').glob('[0-9]*/stat'):
        try:
            fields = stat.read_text().rsplit(')', 1)[1].split()
            if int(fields[2]) == pgid and fields[0] not in ('Z', 'X'):
                return True
        except (FileNotFoundError, ProcessLookupError, ValueError, IndexError):
            continue
    return False


def stop_group(child, grace=5):
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    end = time.monotonic() + grace
    while group_alive(child.pid) and time.monotonic() < end:
        time.sleep(0.05)
    if group_alive(child.pid):
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        while group_alive(child.pid):
            time.sleep(0.05)
    child.wait()


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
        self.lifecycle = None
        self.last_heartbeat = 0

    def begin(self, action):
        previous = read(self.root / 'supervisor.json') if (self.root / 'supervisor.json').exists() else None
        if previous:
            self.event('previous_supervisor_observation', lifecycle=previous,
                       diagnosis='observed_exit' if previous.get('exit') else 'exit_unobserved_cause_unknown')
        self.lifecycle = {'session': uuid.uuid4().hex, 'pid': os.getpid(),
                          'action': action, 'started_at': time.time(), 'exit': None}
        self.heartbeat(force=True)

    def heartbeat(self, force=False):
        if self.lifecycle and (force or time.monotonic() - self.last_heartbeat >= 1):
            self.lifecycle['last_heartbeat_at'] = time.time()
            self.lifecycle['next_step'] = self.state.get('next_step')
            atomic(self.root / 'supervisor.json', self.lifecycle)
            self.last_heartbeat = time.monotonic()

    def finish(self, reason, exception_type=None):
        if self.lifecycle:
            self.lifecycle['exit'] = {'observed_at': time.time(), 'reason': reason,
                                      'exception_type': exception_type}
            self.heartbeat(force=True)
            self.event('supervisor_exit', **self.lifecycle['exit'])

    def save(self):
        self.state['updated_at'] = time.time()
        atomic(self.root / 'checkpoint.json', self.state)
        self.heartbeat(force=True)
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
        self.heartbeat()
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
                'timeout': timeout, 'lock_fd': self.lock.fileno(), 'root': str(self.root),
                'deadline': self.state.get('deadline', time.time() + timeout)}
        atomic(directory / 'launch.json', spec)
        child = subprocess.Popen([sys.executable, __file__, str(directory / 'launch.json')],
                                 start_new_session=True, pass_fds=(self.lock.fileno(),), env=clean_env())
        try:
            while child.poll() is None:
                self.wait(0.2)
            self.stop_check()
            if group_alive(child.pid):
                stop_group(child)
        except BaseException:
            stop_group(child)
            raise
        if not receipt.exists():
            raise Blocked('Worker exited without a durable receipt; inspect preserved attempt')
        return read(receipt)['returncode']

    def close(self):
        self.lock.close()


def worker(path):
    spec = read(path)
    directory = Path(spec['directory'])
    interrupted = False

    def request_stop(_signum, _frame):
        nonlocal interrupted
        interrupted = True

    signal.signal(signal.SIGTERM, request_stop)
    # Parent may be killed: keep the inherited lock until the command group is empty.
    with (directory / 'prompt.txt').open() as inp, (directory / 'codex.jsonl').open('w') as out, (directory / 'stderr.log').open('w') as err:
        p = subprocess.Popen(spec['args'], cwd=spec['cwd'], stdin=inp, stdout=out, stderr=err,
                             env=clean_env(), pass_fds=(spec['lock_fd'],), start_new_session=True)
        end = time.monotonic() + spec['timeout']
        while p.poll() is None:
            if interrupted or (Path(spec['root']) / 'STOP').exists():
                stop_group(p, grace=1)
                return
            if time.monotonic() >= end or time.time() >= spec['deadline']:
                stop_group(p, grace=1)
                atomic(directory / 'exit.json', {'returncode': 124})
                return
            time.sleep(0.1)
        rc = p.returncode
        if group_alive(p.pid):
            stop_group(p, grace=2)
        if interrupted or (Path(spec['root']) / 'STOP').exists():
            return
        atomic(directory / 'exit.json', {'returncode': 124 if time.monotonic() >= end or time.time() >= spec['deadline'] else rc})


if __name__ == '__main__':
    worker(sys.argv[1])
