import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from contracts import SCHEMA, validate
from runtime import Blocked, Run, Stopped, atomic, read, status_snapshot
from supervisor import (ALLOWED_CODEX_MODELS, DEFAULT_CODEX_MODEL, Supervisor,
                        check_snapshot, git, github_items, initialize, main, validate_models)

SCRIPT = str(Path(__file__).with_name('supervisor.py'))


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'run'
        self.root.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def cli(self, action='start', **kwargs):
        args = [sys.executable, SCRIPT, action, '--run-dir', str(self.root)]
        if action == 'start':
            args += ['--dry-run']
        return subprocess.run(args, capture_output=True, text=True, timeout=30, **kwargs)

    def scenario(self, **kwargs):
        atomic(self.root / 'scenario.json', kwargs)

    def initialized_run(self):
        run = Run(self.root)
        initialize(run, SimpleNamespace(dry_run=True, repo=str(self.root), model='gpt-6.1-sol',
                                        review_model='gpt-6.1-sol', worker_timeout=30, ci_timeout=0))
        return run

    def wait_for(self, predicate):
        end = time.monotonic() + 10
        while time.monotonic() < end:
            if predicate():
                return
            time.sleep(0.05)
        self.fail('Timed out waiting for process fixture')

    def test_complete_dry_run_and_idempotent_resume(self):
        result = self.cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        state = read(self.root / 'checkpoint.json')
        self.assertEqual(state['status'], 'complete')
        self.assertEqual(state['model'], 'gpt-6.1-sol')
        self.assertEqual(state['review_model'], 'gpt-6.1-sol')
        self.assertEqual(len(state['phases']), 4)
        calls = read(self.root / 'fake-calls.json')
        self.assertEqual(len(calls), 7)
        self.assertEqual(len(set(c['worktree'] for c in calls)), 7)
        for i, phase in enumerate(state['phases']):
            self.assertEqual(phase['review']['head'], phase['head'])
            if i:
                self.assertEqual(phase['base'], state['phases'][i-1]['head'])
        self.assertEqual(self.cli('resume').returncode, 0)
        self.assertEqual(read(self.root / 'fake-calls.json'), calls)
        self.assertTrue((self.root / 'dry-run-passed.json').exists())
        lifecycle = read(self.root / 'supervisor.json')
        self.assertEqual(lifecycle['exit']['reason'], 'complete')
        self.assertEqual(lifecycle['action'], 'resume')

    def test_status_is_read_only_and_does_not_invent_exit_cause(self):
        atomic(self.root / 'checkpoint.json', {'status': 'running', 'phases': []})
        atomic(self.root / 'supervisor.json', {'pid': 123, 'last_heartbeat_at': 1, 'exit': None})
        before = {p.name: p.read_bytes() for p in self.root.iterdir()}
        snapshot = status_snapshot(self.root)['reconciliation']
        self.assertEqual(snapshot['lock'], 'missing')
        self.assertEqual(snapshot['diagnosis'], 'no_lock_evidence')
        self.assertEqual({p.name: p.read_bytes() for p in self.root.iterdir()}, before)
        (self.root / 'run.lock').touch()
        before = {p.name: p.read_bytes() for p in self.root.iterdir()}
        snapshot = status_snapshot(self.root)
        self.assertEqual(snapshot['reconciliation']['diagnosis'], 'exit_unobserved_cause_unknown')
        self.assertEqual(snapshot['status'], 'running')
        self.assertEqual({p.name: p.read_bytes() for p in self.root.iterdir()}, before)

    def test_status_does_not_read_attempt_outside_run(self):
        atomic(self.root / 'checkpoint.json', {'phase': 0, 'phases': [
            {'pending': {'directory': str(self.root.parent), 'role': 'review', 'head': 'abc'}}]})
        self.assertEqual(status_snapshot(self.root)['reconciliation']['pending'],
                         {'observation': 'outside_run_attempts'})

    def test_unexpected_exception_records_type_and_releases_lock(self):
        with patch.object(sys, 'argv', [SCRIPT, 'start', '--dry-run', '--run-dir', str(self.root)]), \
                patch.object(Supervisor, 'drive', side_effect=RuntimeError('fixture')):
            with self.assertRaises(RuntimeError):
                main()
        lifecycle = read(self.root / 'supervisor.json')
        self.assertEqual(lifecycle['exit']['reason'], 'unexpected_exception')
        self.assertEqual(lifecycle['exit']['exception_type'], 'RuntimeError')
        self.assertEqual(status_snapshot(self.root)['reconciliation']['lock'], 'available_at_probe')

    def test_signal_during_heartbeat_replace_does_not_reenter_atomic_write(self):
        replace = os.replace
        active = False
        sent = False
        def interrupted_replace(source, destination):
            nonlocal sent
            if active and not sent and Path(source).name == 'supervisor.json.tmp':
                sent = True
                os.kill(os.getpid(), signal.SIGTERM)
            replace(source, destination)
        def drive(supervisor):
            nonlocal active
            active = True
            supervisor.run.save()
            supervisor.run.stop_check()
        with patch.object(sys, 'argv', [SCRIPT, 'start', '--dry-run', '--run-dir', str(self.root)]), \
                patch.object(Supervisor, 'drive', drive), patch('runtime.os.replace', interrupted_replace):
            self.assertEqual(main(), 2)
        self.assertTrue(sent)
        lifecycle = read(self.root / 'supervisor.json')
        self.assertEqual(lifecycle['exit']['reason'], 'stopped')
        self.assertEqual(lifecycle['stop_signal'], 'SIGTERM')

    def test_exact_model_allowlist_enforced_for_both_roles(self):
        self.assertEqual(DEFAULT_CODEX_MODEL, 'gpt-6.1-sol')
        self.assertEqual(ALLOWED_CODEX_MODELS, {'gpt-6-luna', 'gpt-6.1-sol'})
        for allowed in ALLOWED_CODEX_MODELS:
            validate_models(allowed, allowed)
        for forbidden in ('gpt-6-sol', 'gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.6-sol', '', None):
            with self.subTest(forbidden=forbidden):
                with self.assertRaisesRegex(Blocked, 'not permitted'):
                    validate_models(forbidden, 'gpt-6.1-sol')
                with self.assertRaisesRegex(Blocked, 'not permitted'):
                    validate_models('gpt-6-luna', forbidden)

    def test_invalid_model_cli_rejected_without_running_or_checkpoint(self):
        for flag in ('--model', '--review-model'):
            with self.subTest(flag=flag):
                result = subprocess.run([sys.executable, SCRIPT, 'start', '--dry-run',
                                         '--run-dir', str(self.root), flag, 'gpt-6-astra'],
                                        capture_output=True, text=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('invalid choice', result.stderr)
                self.assertFalse((self.root / 'checkpoint.json').exists())

    def test_resume_rejects_unapproved_persisted_model(self):
        run = self.initialized_run()
        try:
            run.state['review_model'] = 'gpt-6-astra'
            run.save()
        finally:
            run.close()
        result = self.cli('resume')
        self.assertEqual(result.returncode, 2)
        self.assertIn('not permitted', result.stderr)
        self.assertFalse((self.root / 'fake-calls.json').exists())

    def test_review_repairs_use_new_execution_and_new_review(self):
        self.scenario(findings=1)
        result = self.cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = read(self.root / 'fake-calls.json')
        self.assertEqual([x['role'] for x in calls[:4]], ['implement', 'review', 'repair', 'review'])
        self.assertEqual(len({x['output'] for x in calls}), len(calls))

    def test_repair_budget_persists_across_resume(self):
        self.scenario(findings=99)
        self.assertEqual(self.cli().returncode, 2)
        calls = read(self.root / 'fake-calls.json')
        self.assertEqual(self.cli('resume').returncode, 2)
        self.assertEqual(read(self.root / 'fake-calls.json'), calls)
        self.assertEqual(read(self.root / 'checkpoint.json')['phases'][0]['repairs'], 2)

    def test_stale_sha_and_dependency_failure_stop(self):
        for scenario in ({'stale': True}, {'blocked': True}, {'exit': 9}):
            with self.subTest(scenario=scenario):
                # Each failure is independent, and no downstream work starts.
                with tempfile.TemporaryDirectory() as tmp:
                    saved = self.root
                    self.root = Path(tmp)
                    self.scenario(**scenario)
                    self.assertEqual(self.cli().returncode, 2)
                    self.assertEqual(len(read(self.root / 'fake-calls.json')), 1)
                    self.root = saved

    def test_stop_and_resume_preserves_work(self):
        self.scenario(delay=5)
        child = subprocess.Popen([sys.executable, SCRIPT, 'start', '--dry-run', '--run-dir', str(self.root)],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            self.wait_for(lambda: (self.root / 'fake-calls.json').exists())
            self.assertEqual(self.cli('stop').returncode, 0)
            self.assertEqual(child.wait(timeout=10), 2)
            self.assertEqual(read(self.root / 'checkpoint.json')['status'], 'stopped')
            self.assertEqual(read(self.root / 'supervisor.json')['exit']['reason'], 'stopped')
            self.scenario()
            resumed = self.cli('resume')
            self.assertEqual(resumed.returncode, 0, resumed.stderr)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()

    def test_stop_kills_descendant_after_launcher_exits(self):
        run = Run(self.root)
        run.state = {'deadline': time.time() + 60}
        pidfile = self.root / 'descendant.pid'
        descendant = ("import signal,time,os; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                      f"open({str(pidfile)!r}, 'w').write(str(os.getpid())); time.sleep(30)")
        leader = f"import subprocess,sys,time; subprocess.Popen([sys.executable, '-c', {descendant!r}]); time.sleep(30)"
        def interrupt(_seconds):
            self.wait_for(pidfile.exists)
            raise Stopped('fixture stop')
        try:
            with patch.object(run, 'wait', side_effect=interrupt):
                with self.assertRaises(Stopped):
                    run.execute([sys.executable, '-c', leader], self.root,
                                self.root / 'attempt', '', 40)
            pid = int(pidfile.read_text())
            stat = Path(f'/proc/{pid}/stat')
            self.assertTrue(not stat.exists() or stat.read_text().rsplit(')', 1)[1].split()[0] in ('Z', 'X'))
        finally:
            if pidfile.exists():
                try:
                    os.kill(int(pidfile.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass
            run.close()
        acquired = Run(self.root)
        acquired.close()

    def test_launcher_exit_does_not_release_live_descendant(self):
        run = Run(self.root)
        run.state = {'deadline': time.time() + 60}
        pidfile = self.root / 'descendant.pid'
        descendant = ("import signal,time,os; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                      f"open({str(pidfile)!r}, 'w').write(str(os.getpid())); time.sleep(30)")
        leader = (f"import subprocess,sys,time; subprocess.Popen([sys.executable, '-c', {descendant!r}]); "
                  "time.sleep(0.3)")
        try:
            self.assertEqual(run.execute([sys.executable, '-c', leader], self.root,
                                         self.root / 'attempt', '', 40), 0)
            stat = Path(f'/proc/{int(pidfile.read_text())}/stat')
            self.assertTrue(not stat.exists() or stat.read_text().rsplit(')', 1)[1].split()[0] in ('Z', 'X'))
        finally:
            if pidfile.exists():
                try:
                    os.kill(int(pidfile.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass
            run.close()

    def test_orphan_worker_holds_lock_after_leader_exit_until_descendant_stops(self):
        pidfile = self.root / 'descendant.pid'
        leader_pidfile = self.root / 'leader.pid'
        release = self.root / 'release-leader'
        attempt = self.root / 'attempt'
        descendant = ("import signal,time,os; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                      f"open({str(pidfile)!r}, 'w').write(str(os.getpid())); time.sleep(30)")
        leader = ("import os,subprocess,sys,time\nfrom pathlib import Path\n"
                  f"Path({str(leader_pidfile)!r}).write_text(str(os.getpid()))\n"
                  f"subprocess.Popen([sys.executable, '-c', {descendant!r}])\n"
                  f"while not Path({str(release)!r}).exists(): time.sleep(0.01)\n")
        runner = ("from pathlib import Path\nimport sys,time\nfrom runtime import Run\n"
                  f"run = Run({str(self.root)!r})\nrun.state = {{'deadline': time.time() + 60}}\n"
                  f"run.execute([sys.executable, '-c', {leader!r}], Path({str(self.root)!r}), "
                  f"Path({str(attempt)!r}), '', 40)\n")
        supervisor = subprocess.Popen([sys.executable, '-c', runner],
                                      cwd=Path(SCRIPT).parent, stdout=subprocess.DEVNULL,
                                      stderr=subprocess.DEVNULL)
        try:
            self.wait_for(lambda: pidfile.exists() and leader_pidfile.exists())
            supervisor.kill()
            supervisor.wait(timeout=5)
            release.touch()
            leader_pid = int(leader_pidfile.read_text())
            def leader_exited():
                stat = Path(f'/proc/{leader_pid}/stat')
                return not stat.exists() or stat.read_text().rsplit(')', 1)[1].split()[0] in ('Z', 'X')
            self.wait_for(leader_exited)
            with self.assertRaisesRegex(Blocked, 'lock'):
                Run(self.root)
            self.assertFalse((attempt / 'exit.json').exists())
            (self.root / 'STOP').touch()
            descendant_pid = int(pidfile.read_text())
            def descendant_stopped():
                stat = Path(f'/proc/{descendant_pid}/stat')
                return not stat.exists() or stat.read_text().rsplit(')', 1)[1].split()[0] in ('Z', 'X')
            self.wait_for(descendant_stopped)
            def lock_released():
                try:
                    run = Run(self.root)
                except Blocked:
                    return False
                run.close()
                return True
            self.wait_for(lock_released)
            self.assertFalse((attempt / 'exit.json').exists())
        finally:
            (self.root / 'STOP').touch()
            if supervisor.poll() is None:
                supervisor.kill()
                supervisor.wait()
            if pidfile.exists():
                try:
                    os.kill(int(pidfile.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def test_orphan_worker_deadline_kills_command_descendant_before_receipt(self):
        pidfile = self.root / 'descendant.pid'
        attempt = self.root / 'attempt'
        descendant = ("import signal,time,os; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                      f"open({str(pidfile)!r}, 'w').write(str(os.getpid())); time.sleep(30)")
        leader = ("import subprocess,sys,time\n"
                  f"subprocess.Popen([sys.executable, '-c', {descendant!r}])\n"
                  "time.sleep(30)\n")
        runner = ("from pathlib import Path\nimport sys,time\nfrom runtime import Run\n"
                  f"run = Run({str(self.root)!r})\nrun.state = {{'deadline': time.time() + 3}}\n"
                  f"run.execute([sys.executable, '-c', {leader!r}], Path({str(self.root)!r}), "
                  f"Path({str(attempt)!r}), '', 40)\n")
        supervisor = subprocess.Popen([sys.executable, '-c', runner],
                                      cwd=Path(SCRIPT).parent, stdout=subprocess.DEVNULL,
                                      stderr=subprocess.DEVNULL)
        try:
            self.wait_for(pidfile.exists)
            self.assertIsNone(supervisor.poll())
            supervisor.kill()
            supervisor.wait(timeout=5)
            self.wait_for(lambda: (attempt / 'exit.json').exists())
            self.assertEqual(read(attempt / 'exit.json')['returncode'], 124)
            pid = int(pidfile.read_text())
            stat = Path(f'/proc/{pid}/stat')
            self.assertTrue(not stat.exists() or stat.read_text().rsplit(')', 1)[1].split()[0] in ('Z', 'X'))
            # The timeout receipt precedes worker teardown and inherited flock release.
            def lock_released():
                try:
                    run = Run(self.root)
                except Blocked:
                    return False
                run.close()
                return True
            self.wait_for(lock_released)
        finally:
            if supervisor.poll() is None:
                supervisor.kill()
                supervisor.wait()
            if pidfile.exists():
                try:
                    os.kill(int(pidfile.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def test_setup_rejects_staging_worktree_collision_without_touching_draft(self):
        run = self.initialized_run()
        try:
            repo = run.state['repo']
            base = run.state['base']
            git(repo, 'switch', '-c', 'operator-work')
            git(repo, 'worktree', 'add', str(self.root / 'slice-2'), 'staging')
            draft = self.root / 'slice-2' / 'operator-draft.txt'
            draft.write_text('keep this draft\n')
        finally:
            run.close()
        result = self.cli('resume')
        self.assertEqual(result.returncode, 2)
        self.assertIn('registered dedicated worktree', result.stderr)
        self.assertEqual(git(self.root / 'slice-2', 'rev-parse', 'HEAD'), base)
        self.assertEqual(git(self.root / 'slice-2', 'branch', '--show-current'), 'staging')
        self.assertEqual(draft.read_text(), 'keep this draft\n')

    def test_setup_rejects_unowned_directory_even_with_matching_head(self):
        run = self.initialized_run()
        try:
            repo = run.state['repo']
            base = run.state['base']
            git(repo, 'clone', '--shared', repo, str(self.root / 'slice-2'))
            self.assertEqual(git(self.root / 'slice-2', 'rev-parse', 'HEAD'), base)
        finally:
            run.close()
        result = self.cli('resume')
        self.assertEqual(result.returncode, 2)
        self.assertIn('registered dedicated worktree', result.stderr)
        self.assertEqual(git(self.root / 'slice-2', 'rev-parse', 'HEAD'), base)

    def test_commit_and_publish_reject_phase_branch_switch(self):
        run = self.initialized_run()
        try:
            supervisor = Supervisor(run)
            p = supervisor.setup(0)
            draft = Path(p['worktree']) / 'operator-draft.txt'
            draft.write_text('keep\n')
            git(p['worktree'], 'switch', '-c', 'operator-work')
            p['commit_message'] = 'Fixture commit'
            with self.assertRaisesRegex(Blocked, 'registered dedicated worktree'):
                supervisor.commit(p)
            with self.assertRaisesRegex(Blocked, 'registered dedicated worktree'):
                supervisor.publish(p)
            self.assertEqual(git(p['worktree'], 'rev-parse', 'HEAD'), p['base'])
            self.assertEqual(draft.read_text(), 'keep\n')
            self.assertFalse((self.root / 'fake-github.json').exists())
        finally:
            run.close()

    def test_setup_recovers_registered_worktree_after_checkpoint_interruption(self):
        run = self.initialized_run()
        try:
            supervisor = Supervisor(run)
            p = supervisor.setup(0)
            p['step'] = 'setup'  # worktree add completed before the step checkpoint
            run.save()
        finally:
            run.close()
        result = self.cli('resume')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_sigkill_orphan_lock_and_receipt_recovery(self):
        self.scenario(delay=2)
        child = subprocess.Popen([sys.executable, SCRIPT, 'start', '--dry-run', '--run-dir', str(self.root)],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.wait_for(lambda: (self.root / 'fake-calls.json').exists())
        first_heartbeat = read(self.root / 'supervisor.json')['last_heartbeat_at']
        self.wait_for(lambda: read(self.root / 'supervisor.json')['last_heartbeat_at'] > first_heartbeat)
        child.kill()
        child.wait()
        self.assertEqual(status_snapshot(self.root)['reconciliation']['lock'],
                         'held_by_supervisor_or_worker')
        self.assertIsNone(read(self.root / 'supervisor.json')['exit'])
        result = self.cli('resume')
        self.assertEqual(result.returncode, 2)
        self.assertIn('lock', result.stderr)
        self.wait_for(lambda: len(list((self.root / 'attempts').glob('*/exit.json'))) == 1)
        self.wait_for(lambda: status_snapshot(self.root)['reconciliation']['lock'] == 'available_at_probe')
        before = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        snapshot = status_snapshot(self.root)['reconciliation']
        self.assertEqual(snapshot['diagnosis'], 'exit_unobserved_cause_unknown')
        self.assertEqual(snapshot['pending']['returncode'], 0)
        self.assertEqual(snapshot['pending']['observation'], 'receipt_available')
        self.assertEqual({str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}, before)
        self.scenario()
        resumed = self.cli('resume')
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        self.assertEqual(len(read(self.root / 'fake-calls.json')), 7)
        events = [json.loads(line) for line in (self.root / 'events.jsonl').read_text().splitlines()]
        self.assertEqual(len([e for e in events if e['event'] == 'worker_receipt_reconciled']), 1)
        prior = [e for e in events if e['event'] == 'previous_supervisor_observation']
        self.assertEqual(prior[-1]['diagnosis'], 'exit_unobserved_cause_unknown')

    def test_live_ci_rejects_stale_failed_and_missing(self):
        pr = {'head': {'sha': 'abc'}, 'base': {'ref': 'staging'}, 'state': 'open', 'mergeable': True}
        checks = [{'id': i, 'name': name, 'head_sha': 'abc', 'status': 'completed', 'conclusion': 'success'}
                  for i, name in enumerate(('verify', 'pr-reviewability'))]
        statuses = [{'context': 'Vercel', 'state': 'success'}]
        self.assertTrue(check_snapshot(pr, 'abc', checks, statuses)[0])
        self.assertFalse(check_snapshot(pr, 'abc', checks, [])[0])
        with self.assertRaises(Blocked):
            check_snapshot(pr, 'different', checks, statuses)
        checks[0]['conclusion'] = 'failure'
        with self.assertRaises(Blocked):
            check_snapshot(pr, 'abc', checks, statuses)
        checks[0]['conclusion'] = 'success'
        checks.append({**checks[0], 'id': 10, 'status': 'in_progress', 'conclusion': None})
        self.assertFalse(check_snapshot(pr, 'abc', checks, statuses)[0])

    def test_stop_reaches_orphan_worker_then_resume(self):
        self.scenario(delay=20)
        child = subprocess.Popen([sys.executable, SCRIPT, 'start', '--dry-run', '--run-dir', str(self.root)],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.wait_for(lambda: (self.root / 'fake-calls.json').exists())
        child.kill()
        child.wait()
        self.assertEqual(self.cli('stop').returncode, 0)
        def lock_released():
            try:
                run = Run(self.root)
            except Blocked:
                return False
            run.close()
            return True
        self.wait_for(lock_released)
        self.scenario()
        result = self.cli('resume')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_atomic_checkpoint_and_lock(self):
        run = Run(self.root)
        try:
            run.state = {'phase': 0, 'status': 'running'}
            run.save()
            self.assertEqual(read(self.root / 'checkpoint.json')['status'], 'running')
            with self.assertRaises(Blocked):
                Run(self.root)
        finally:
            run.close()

    def test_ci_failure_resume_does_not_repeat_implementation(self):
        self.scenario(ci_failure=True)
        self.assertEqual(self.cli().returncode, 2)
        state = read(self.root / 'checkpoint.json')
        self.assertEqual(state['phases'][0]['step'], 'ci')
        data = read(self.root / 'fake-github.json')
        data[state['phases'][0]['branch']]['checks'][0]['conclusion'] = 'success'
        atomic(self.root / 'fake-github.json', data)
        self.scenario()
        result = self.cli('resume')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(read(self.root / 'fake-calls.json')), 7)

    def test_resume_at_review_refreshes_ci_before_reviewer_dispatch(self):
        self.scenario(ci_failure=True)
        self.assertEqual(self.cli().returncode, 2)
        state = read(self.root / 'checkpoint.json')
        p = state['phases'][0]
        p['step'] = 'review'
        p['ci'] = {'head': p['head'], 'passed': True}  # stale; live verify still fails
        atomic(self.root / 'checkpoint.json', state)
        calls = read(self.root / 'fake-calls.json')
        result = self.cli('resume')
        self.assertEqual(result.returncode, 2)
        self.assertIn('checks failed', result.stderr)
        self.assertEqual(read(self.root / 'fake-calls.json'), calls)

    def test_interrupted_review_retry_refreshes_ci_before_new_execution(self):
        self.scenario(ci_failure=True)
        self.assertEqual(self.cli().returncode, 2)
        state = read(self.root / 'checkpoint.json')
        p = state['phases'][0]
        p['step'] = 'review'
        p['ci'] = {'head': p['head'], 'passed': True}
        p['pending'] = {'directory': str(self.root / 'attempts' / 'interrupted-review'),
                        'role': 'review', 'worktree': str(self.root / 'review'), 'head': p['head']}
        atomic(self.root / 'checkpoint.json', state)
        calls = read(self.root / 'fake-calls.json')
        result = self.cli('resume')
        self.assertEqual(result.returncode, 2)
        self.assertIn('checks failed', result.stderr)
        self.assertEqual(read(self.root / 'fake-calls.json'), calls)
        self.assertEqual(read(self.root / 'checkpoint.json')['phases'][0]['interruptions'], 1)

    def test_resume_refuses_changed_worktree_head(self):
        self.scenario(ci_failure=True)
        self.assertEqual(self.cli().returncode, 2)
        state = read(self.root / 'checkpoint.json')
        git(state['phases'][0]['worktree'], 'commit', '--allow-empty', '-m', 'Unexpected external change')
        result = self.cli('resume')
        self.assertEqual(result.returncode, 2)
        self.assertIn('HEAD drifted', result.stderr)

    def test_timeout_kills_worker_and_fails_closed(self):
        self.scenario(delay=5)
        result = subprocess.run([sys.executable, SCRIPT, 'start', '--dry-run', '--run-dir', str(self.root),
                                 '--worker-timeout', '1'], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertIn('exit 124', result.stderr)
        self.assertEqual(self.cli('resume').returncode, 2)
        self.assertEqual(len(read(self.root / 'fake-calls.json')), 1)

    def test_explicit_retry_after_worker_failure(self):
        self.scenario(exit=9)
        self.assertEqual(self.cli().returncode, 2)
        self.scenario()
        result = subprocess.run([sys.executable, SCRIPT, 'resume', '--retry-worker', '--run-dir', str(self.root)],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(read(self.root / 'fake-calls.json')), 8)

    def test_schema_does_not_accept_self_report_with_blockers(self):
        with self.assertRaises(ValueError):
            validate({key: [] for key in SCHEMA['required']})

    def test_real_start_requires_matching_dry_run(self):
        result = subprocess.run([sys.executable, SCRIPT, 'start', '--run-dir', str(self.root)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('dry-run proof', result.stderr)

    def test_real_pr_body_matches_ci_metadata_contract(self):
        run = Run(self.root)
        run.state = {'repo': str(self.root), 'dry_run': False, 'phase': 0}
        p = {'worktree': str(self.root), 'head': 'a' * 40, 'branch': 'codex/fixture',
             'name': 'slice-2', 'base': 'b' * 40, 'tests': ['offline checks'], 'dependencies': [],
             'result': {'large_pr_justification': 'Coherent unit', 'review_order': ['contracts', 'tests']}}
        try:
            with patch.object(Supervisor, 'phase_checkout'), patch('supervisor.git'), patch('supervisor.command'), patch('supervisor.github', side_effect=[[], [{'number': 1}]]):
                Supervisor(run).publish(p)
            body = (self.root / 'slice-2-pr.md').read_text()
            self.assertIn('\n- Large PR justification: ', body)
            self.assertIn('\n- Review order: ', body)
        finally:
            run.close()

    def test_github_cli_pagination_uses_installed_supported_flags(self):
        with patch('supervisor.command', return_value='{"id":1}\n{"id":2}') as call:
            self.assertEqual(github_items('commits/abc/check-runs', '.check_runs[]'), [{'id': 1}, {'id': 2}])
            self.assertNotIn('--slurp', call.call_args.args[0])
            self.assertIn('--paginate', call.call_args.args[0])

    def test_metadata_update_requires_new_ci_runs(self):
        run = Run(self.root)
        run.state = {'repo': str(self.root), 'dry_run': True, 'ci_timeout': 0}
        p = {'head': 'abc', 'after_check_ids': {'verify': 1, 'pr-reviewability': 2}}
        snapshot = {'pr': {'head': {'sha': 'abc'}, 'base': {'ref': 'staging'}, 'state': 'open'},
                    'checks': [{'id': i, 'name': name, 'head_sha': 'abc', 'status': 'completed', 'conclusion': 'success'}
                               for i, name in ((1, 'verify'), (2, 'pr-reviewability'))],
                    'statuses': [{'context': 'Vercel', 'state': 'success'}]}
        try:
            supervisor = Supervisor(run)
            with patch.object(supervisor, 'snapshot', return_value=snapshot):
                with self.assertRaises(Blocked):
                    supervisor.ci(p)
                for check in snapshot['checks']:
                    check['id'] += 10
                supervisor.ci(p)
                self.assertNotIn('after_check_ids', p)
        finally:
            run.close()


if __name__ == '__main__':
    unittest.main()
