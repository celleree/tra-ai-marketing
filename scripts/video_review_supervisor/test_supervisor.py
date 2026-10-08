import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from contracts import SCHEMA, validate
from runtime import Blocked, Run, atomic, read
from supervisor import Supervisor, check_snapshot, git

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
            self.scenario()
            resumed = self.cli('resume')
            self.assertEqual(resumed.returncode, 0, resumed.stderr)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()

    def test_sigkill_orphan_lock_and_receipt_recovery(self):
        self.scenario(delay=1)
        child = subprocess.Popen([sys.executable, SCRIPT, 'start', '--dry-run', '--run-dir', str(self.root)],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.wait_for(lambda: (self.root / 'fake-calls.json').exists())
        child.kill()
        child.wait()
        result = self.cli('resume')
        self.assertEqual(result.returncode, 2)
        self.assertIn('lock', result.stderr)
        self.wait_for(lambda: len(list((self.root / 'attempts').glob('*/exit.json'))) == 1)
        self.scenario()
        resumed = self.cli('resume')
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        self.assertEqual(len(read(self.root / 'fake-calls.json')), 7)

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
            with patch('supervisor.git'), patch('supervisor.command'), patch('supervisor.github', side_effect=[[], [{'number': 1}]]):
                Supervisor(run).publish(p)
            body = (self.root / 'slice-2-pr.md').read_text()
            self.assertIn('\n- Large PR justification: ', body)
            self.assertIn('\n- Review order: ', body)
        finally:
            run.close()

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
