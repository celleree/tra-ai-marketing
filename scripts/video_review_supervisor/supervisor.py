#!/usr/bin/env python3
"""Sequential, restartable Video Review supervisor. Never merges or deploys."""
import argparse
import json
import os
from pathlib import Path
import signal
import shutil
import sys
import time
import uuid

from contracts import BASE, PHASES, REPO, SCHEMA, SOURCES, prompt, validate
from runtime import Blocked, Run, Stopped, atomic, command, digest, read, status_snapshot
from sandbox import options as sandbox_options

HERE = Path(__file__).resolve().parent
REQUIRED = {'verify', 'pr-reviewability', 'Vercel'}
ALLOWED_CODEX_MODELS = frozenset({'gpt-6-luna', 'gpt-6.1-sol'})
DEFAULT_CODEX_MODEL = 'gpt-6.1-sol'


def validate_models(model, review_model):
    """Hard cost guard for all Codex workers; never fall back to another model."""
    for role, value in (('implementation model', model), ('review model', review_model)):
        if not isinstance(value, str) or value not in ALLOWED_CODEX_MODELS:
            raise Blocked(f'{role} {value!r} is not permitted; only gpt-6-luna and gpt-6.1-sol are allowed')

FORBIDDEN = ('AGENTS.md', 'docs/agent-workflow.md', 'docs/parallel-coding.md',
             '.github/', '.env', 'scripts/video_review_supervisor/')


def git(repo, *args):
    return command(['git', '-C', repo, *args])


def github(*args):
    return json.loads(command(['gh', *args]))


def api(path):
    return github('api', f'repos/{REPO}/{path}')


def github_items(path, expression):
    # gh 2.45 supports --paginate/--jq, but not the newer --slurp flag.
    output = command(['gh', 'api', '--paginate', f'repos/{REPO}/{path}', '--jq', expression + ' | @json'])
    return [json.loads(line) for line in output.splitlines() if line.strip()]


def check_snapshot(pr, head, checks, statuses):
    if pr['head']['sha'] != head or pr['base']['ref'] != 'staging' or pr['state'] != 'open':
        raise Blocked('PR HEAD/base/state drifted; refusing stale evidence')
    if pr.get('mergeable') is False:
        raise Blocked('PR has merge conflicts; dependency repair requires operator action')
    current = {}
    for item in sorted(checks, key=lambda x: x.get('id', 0)):
        if item['head_sha'] != head:
            raise Blocked('GitHub returned a stale check SHA')
        current[item['name']] = 'success' if item['status'] == 'completed' and item['conclusion'] == 'success' else (
            'pending' if item['status'] != 'completed' else 'failure')
    for item in reversed(statuses):  # GitHub returns newest statuses first
        current[item['context']] = item['state']
    failed = [name for name, value in current.items() if value not in ('success', 'pending')]
    if failed:
        raise Blocked(f'Actual GitHub checks failed: {failed}')
    return REQUIRED <= current.keys() and all(x == 'success' for x in current.values()), current


class Supervisor:
    def __init__(self, run):
        self.run, self.s = run, run.state
        self.repo = Path(self.s['repo'])
        self.fake = self.s['dry_run']

    def save(self, step=None):
        if step:
            self.s['next_step'] = step
        self.run.save()

    def preflight(self):
        validate_models(self.s.get('model'), self.s.get('review_model'))
        if self.s['code_digest'] != digest():
            raise Blocked('Supervisor code changed since start; use a newly verified run')
        if self.fake:
            return
        if command(['codex', '--version']) != 'codex-cli 0.161.0':
            raise Blocked('Codex version changed; revalidate sandbox profiles before unattended use')
        help_text = command(['codex', 'exec', '--help'])
        for flag in ('--sandbox', '--output-schema', '--output-last-message', '--json', '--ephemeral', '--ignore-user-config'):
            if flag not in help_text:
                raise Blocked(f'Installed Codex lacks {flag}')
        command(['codex', 'login', 'status'])
        command(['gh', 'auth', 'status'])
        gh_help = command(['gh', 'api', '--help'])
        if '--paginate' not in gh_help or '--jq' not in gh_help:
            raise Blocked('GitHub CLI lacks supported paginated JSON query options')
        command(['git', 'config', 'user.name'], self.repo)
        command(['git', 'config', 'user.email'], self.repo)
        if api('branches/staging')['commit']['sha'] != BASE:
            raise Blocked('Live staging differs from the pinned PR #302 base; replan explicitly')
        pr = api('pulls/302')
        if not pr['merged'] or pr['merge_commit_sha'] != BASE:
            raise Blocked('PR #302 merge prerequisite differs')
        remote = git(self.repo, 'remote', 'get-url', 'origin')
        if remote not in (f'https://github.com/{REPO}.git', f'git@github.com:{REPO}.git'):
            raise Blocked('Unexpected origin repository')
        git(self.repo, 'fetch', 'origin', 'staging')
        if git(self.repo, 'rev-parse', 'origin/staging') != BASE:
            raise Blocked('Fetched staging differs from pinned base')
        # Exercise the installed sandbox without using an LLM or application provider.
        scratch = self.run.root / 'preflight-scratch'
        scratch.mkdir(exist_ok=True)
        command(['codex', 'sandbox', '-P', 'supervisor',
                 *sandbox_options(self.repo, scratch, True), '--', '/usr/bin/true'])
        local_tools = {name: shutil.which(name) for name in ('node', 'npm', 'ffmpeg', 'ffprobe', 'agent-browser')}
        browsers = sorted((Path.home() / '.cache/ms-playwright').glob(
            'chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell'))
        if not all(local_tools.values()) or not browsers:
            raise Blocked('Node/npm/ffmpeg/ffprobe/agent-browser or cached Chromium prerequisite missing')
        self.s['local_tools'] = {**local_tools, 'chromium': str(browsers[-1])}

    def snapshot(self, p):
        if self.fake:
            return read(self.run.root / 'fake-github.json')[p['branch']]
        pr = api(f'pulls/{p["pr"]}')
        checks = github_items(f'commits/{p["head"]}/check-runs?per_page=100', '.check_runs[]')
        statuses = github_items(f'commits/{p["head"]}/statuses?per_page=100', '.[]')
        return {'pr': pr, 'checks': checks, 'statuses': statuses}

    def ci(self, p, wait=True):
        deadline = time.monotonic() + (self.s['ci_timeout'] if wait else 0)
        while True:
            self.run.stop_check()
            snap = self.snapshot(p)
            passed, values = check_snapshot(snap['pr'], p['head'], snap['checks'], snap['statuses'])
            ids = {name: max((x.get('id', 0) for x in snap['checks'] if x['name'] == name), default=0)
                   for name in ('verify', 'pr-reviewability')}
            if p.get('after_check_ids'):
                passed = passed and all(ids[name] > old for name, old in p['after_check_ids'].items())
            p['ci'] = {'head': p['head'], 'checks': values, 'verified_at': time.time(), 'passed': passed}
            p['ci']['check_ids'] = ids
            self.save('Wait for exact-HEAD GitHub CI and Vercel')
            if passed:
                p.pop('after_check_ids', None)
                self.save()
                return
            if time.monotonic() >= deadline:
                raise Blocked('Required GitHub CI/Vercel checks missing or pending at timeout')
            self.run.wait(30)

    def dependencies(self, index):
        evidence = []
        for p in self.s['phases'][:index]:
            if p['step'] != 'complete' or p['review']['head'] != p['head']:
                raise Blocked('Upstream phase has no current independent review')
            if git(p['worktree'], 'rev-parse', 'HEAD') != p['head'] or git(p['worktree'], 'status', '--porcelain'):
                raise Blocked('Upstream worktree changed since verification')
            self.ci(p, wait=False)
            evidence.append({'phase': p['name'], 'head': p['head'], 'pr': p['pr'],
                             'contracts': p['contracts'], 'tests': p['tests']})
        return evidence

    def phase_checkout(self, p, clean=False):
        """Only the registered, dedicated worktree may receive supervisor Git writes."""
        expected = self.run.root / p['name']
        branch = f'codex/vr-{self.s["id"]}-{p["name"]}'
        if (p['name'] not in dict(PHASES) or Path(p['worktree']) != expected
                or expected.resolve() != expected
                or p['branch'] != branch or branch in ('main', 'staging')):
            raise Blocked('Phase checkout identity differs from this run')
        entries = git(self.repo, 'worktree', 'list', '--porcelain').split('\n\n')
        registered = any(
            f'worktree {expected.resolve()}' in entry.splitlines()
            and f'branch refs/heads/{branch}' in entry.splitlines()
            for entry in entries)
        if not registered or git(expected, 'symbolic-ref', '--quiet', 'HEAD') != f'refs/heads/{branch}':
            raise Blocked('Phase directory is not the registered dedicated worktree')
        common = git(expected, 'rev-parse', '--git-common-dir')
        owner = git(self.repo, 'rev-parse', '--git-common-dir')
        if (Path(expected / common).resolve() != Path(self.repo / owner).resolve()
                or (clean and git(expected, 'status', '--porcelain'))):
            raise Blocked('Phase worktree owner or cleanliness mismatch')

    def setup(self, index):
        if len(self.s['phases']) == index:
            base = self.s['phases'][-1]['head'] if index else self.s['base']
            name = PHASES[index][0]
            branch = f'codex/vr-{self.s["id"]}-{name}'
            self.s['phases'].append({'name': name, 'branch': branch, 'base': base, 'head': base,
                'worktree': str(self.run.root / name), 'step': 'setup', 'attempts': 0, 'repairs': 0,
                'interruptions': 0, 'tests': [], 'contracts': {}, 'review': None, 'ci': None,
                'pr': None, 'findings': [], 'pending': None})
            self.save('Create isolated phase worktree')
        p = self.s['phases'][index]
        if p['step'] == 'setup':
            if not Path(p['worktree']).exists():
                # Recover a branch created before interruption without deleting anything.
                branches = git(self.repo, 'branch', '--list', p['branch'])
                args = [] if branches else ['-b', p['branch']]
                git(self.repo, 'worktree', 'add', *args, p['worktree'], p['branch'] if branches else p['base'])
            self.phase_checkout(p, clean=True)
            if git(p['worktree'], 'rev-parse', 'HEAD') != p['base']:
                raise Blocked('New worktree base mismatch')
            p['contracts'] = self.contracts(p['worktree'], SOURCES)
            p['step'] = 'integration-review' if index == 3 else 'implement'
            self.save(p['step'])
        return p

    def contracts(self, worktree, paths):
        result = {}
        for path in paths:
            if Path(path).is_absolute() or '..' in Path(path).parts:
                raise Blocked('Contract path must be repository-relative')
            result[path] = git(worktree, 'rev-parse', f'HEAD:{path}')
        return result

    def prepare_dependencies(self, worktree, directory):
        if self.fake:
            return
        marker = directory / 'dependencies.json'
        lock = git(worktree, 'rev-parse', 'HEAD:package-lock.json')
        if marker.exists() and read(marker).get('lock') == lock and (Path(worktree) / 'node_modules').exists():
            return
        # Do not execute npm lifecycle scripts outside the worker sandbox.
        rc = self.run.execute(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
                              worktree, directory / 'install', '', 600)
        if rc:
            raise Blocked(f'Dependency installation failed ({rc}); see {directory / "install"}')
        atomic(marker, {'lock': lock})

    def codex(self, p, role, dependencies):
        if p['pending']:
            directory = Path(p['pending']['directory'])
            if not (directory / 'exit.json').exists():
                p['interruptions'] += 1
                if p['interruptions'] > 2:
                    raise Blocked('Interruption retry budget exhausted; preserved work needs inspection')
                p['pending'] = None
                self.save('Recover interrupted work in a NEW execution')
        if not p['pending']:
            if role == 'review':
                self.ci(p)  # persisted CI is never authority for a new reviewer
            p['attempts'] += 1
            directory = self.run.root / 'attempts' / f'{p["name"]}-{role}-{p["attempts"]}'
            worktree = Path(p['worktree'])
            if role in ('review', 'integration-review'):
                worktree = directory / 'review'
            p['pending'] = {'directory': str(directory), 'role': role, 'worktree': str(worktree), 'head': p['head']}
            self.save(f'Run fresh {role} execution')
            directory.mkdir(parents=True)
            if 'review' in role:
                git(self.repo, 'worktree', 'add', '--detach', str(worktree), p['head'])
            self.prepare_dependencies(worktree, directory)
            atomic(directory / 'schema.json', SCHEMA)
            scratch = directory / 'scratch'
            scratch.mkdir()
            args = ['codex', 'exec', '--ignore-user-config', '--ephemeral',
                    '-c', 'default_permissions="supervisor"',
                    *sandbox_options(worktree, scratch, 'review' in role),
                    '--model', self.s['review_model'] if 'review' in role else self.s['model'],
                    '-c', 'model_reasoning_effort="high"',
                    '--json', '--output-schema', str(directory / 'schema.json'),
                    '--output-last-message', str(directory / 'result.json'), '-C', str(worktree), '-']
            if self.fake:
                args = [sys.executable, str(HERE / 'fake.py'), str(self.run.root), role,
                        str(worktree), str(directory / 'result.json')]
            text = prompt(self.s['phase'], role, p['base'], p['head'], dependencies, p['findings'])
            text += '\nOriginal staging SHA for integration diff: ' + self.s['base']
            text += '\nSandbox permits loopback fixtures and npm registry only; providers remain blocked. Use NO_PROXY for localhost. Temporary outputs must use TMPDIR. Do not connect to existing operator browser sessions. Verified local tooling: ' + json.dumps(self.s.get('local_tools', {}))
            if 'review' in role:
                text += '\nWorker-reported local tests (not CI proof): ' + json.dumps(p['tests'])
                text += '\nSupervisor-verified GitHub checks: ' + json.dumps(p['ci'])
            rc = self.run.execute(args, worktree, directory, text, self.s['worker_timeout'])
        else:
            rc = read(directory / 'exit.json')['returncode']
            self.run.event('worker_receipt_reconciled', phase=p['name'], role=role,
                           head=p['head'], directory=str(directory), returncode=rc)
        if rc:
            raise Blocked(f'Codex exit {rc}; inspect {directory}; no automatic infrastructure retries')
        result = validate(read(directory / 'result.json'))
        if result['head'] != p['head'] or git(p['pending']['worktree'], 'rev-parse', 'HEAD') != p['head']:
            raise Blocked('Worker result or checkout HEAD differs from assigned exact HEAD')
        if 'review' in role and git(p['pending']['worktree'], 'status', '--porcelain'):
            raise Blocked('Read-only review changed its worktree')
        self.run.event('worker_result', phase=p['name'], role=role, head=p['head'], directory=str(directory), status=result['status'])
        return result

    def commit(self, p):
        self.phase_checkout(p)
        wt = p['worktree']
        actual = git(wt, 'rev-parse', 'HEAD')
        # Git commit may have completed just before the checkpoint write.
        if actual != p['head']:
            message = git(wt, 'log', '-1', '--format=%s')
            if git(wt, 'rev-parse', 'HEAD^') != p['head'] or message != p['commit_message'] or git(wt, 'status', '--porcelain'):
                raise Blocked('Unexpected HEAD while reconciling commit')
        else:
            files = set(git(wt, 'diff', '--name-only', 'HEAD').splitlines())
            files.update(git(wt, 'ls-files', '--others', '--exclude-standard').splitlines())
            if not files:
                raise Blocked('Implementation reported complete but produced no change')
            if any(f.startswith(FORBIDDEN) for f in files):
                raise Blocked('Worker changed a protected path; retained for inspection')
            git(wt, 'diff', '--check')
            git(wt, 'add', '--', *sorted(files))
            stats = git(wt, 'diff', '--cached', '--numstat').splitlines()
            count = sum(int(n) for line in stats for n in line.split('\t')[:2] if n.isdigit())
            if (count > 400 or len(files) > 10) and not (
                    p['result']['large_pr_justification'].strip() and p['result']['review_order']):
                raise Blocked('Oversized phase needs split/justification and review order before continuing')
            git(wt, 'commit', '-m', p['commit_message'])
            actual = git(wt, 'rev-parse', 'HEAD')
        p['head'] = actual
        p['contracts'] = self.contracts(wt, sorted(set(SOURCES + p['result']['contracts'])))
        p['step'], p['pending'] = 'publish', None
        self.save('Publish exact branch HEAD and reconcile PR')

    def publish(self, p):
        self.phase_checkout(p, clean=True)
        if self.fake:
            path = self.run.root / 'fake-github.json'
            data = read(path) if path.exists() else {}
            p['pr'] = p['pr'] or 900 + self.s['phase']
            data[p['branch']] = {'pr': {'head': {'sha': p['head']}, 'base': {'ref': 'staging'}, 'state': 'open', 'mergeable': True},
                'checks': [{'id': i, 'name': n, 'head_sha': p['head'], 'status': 'completed', 'conclusion': 'success'}
                           for i, n in enumerate(('verify', 'pr-reviewability'))],
                'statuses': [{'context': 'Vercel', 'state': 'success'}]}
            scenario = read(self.run.root / 'scenario.json') if (self.run.root / 'scenario.json').exists() else {}
            if scenario.get('ci_failure'):
                data[p['branch']]['checks'][0]['conclusion'] = 'failure'
            atomic(path, data)
        else:
            # Explicit source/destination, no force and no protected-branch writes.
            git(p['worktree'], 'push', 'origin', f'{p["head"]}:refs/heads/{p["branch"]}')
            prs = github('pr', 'list', '--repo', REPO, '--head', p['branch'], '--state', 'all',
                         '--json', 'number,state,headRefOid,baseRefName')
            if len(prs) > 1 or (prs and (prs[0]['state'] != 'OPEN' or prs[0]['baseRefName'] != 'staging')):
                raise Blocked('Existing PR no longer matches this run')
            if not prs:
                body = self.run.root / f'{p["name"]}-pr.md'
                body.write_text(f'''## Checkpoint
- Status: READY FOR REVIEW
- Branch: {p['branch']}
- Next action: Exact-HEAD CI then fresh independent review; no automatic merge.
- Blockers: NONE
## Acceptance criteria
- {PHASES[self.s['phase']][1]}
- Follow AGENTS.md and current runtime contracts.
## Reviewability
- PR scope: {p['name']} plus verified upstream dependencies.
- Stack: {json.dumps(p['dependencies'])}
- Large PR justification: Branches stack sequentially; cumulative PRs target staging because
  current CI only runs for staging/main targets. No automatic merging or workflow changes.
  Phase-specific split analysis: {p['result']['large_pr_justification'] or 'Phase is within 400 lines/10 files.'}
  Review phase diff from {p['base']}.
- Review order: Verified upstream PRs first, then this phase's contracts, runtime, and tests.
  {json.dumps(p['result']['review_order'])}
## Verification
- Focused/local (worker evidence; independently reviewed): {json.dumps(p['tests'])}
- Actual GitHub CI and Vercel are checked separately by the supervisor.
## Risk
- Level: HIGH
- Reason: Source integrity, Proof and provider attachment boundaries.
## Independent review
- Required: yes
- Status: pending
- Reviewer: fresh read-only Codex CLI execution after exact-HEAD CI
- Fresh context confirmed: pending
- Reviewed SHA: pending
- Findings/conclusion: pending
- Resolution and re-verification: pending
## Reusable learning
- Outcome: existing safeguard sufficient
- Location: existing source-integrity, Proof and paid-generation guards must be preserved.
''')
                command(['gh', 'pr', 'create', '--repo', REPO, '--base', 'staging', '--head', p['branch'],
                         '--title', f'Video Review {p["name"]}', '--body-file', str(body)])
                prs = github('pr', 'list', '--repo', REPO, '--head', p['branch'], '--state', 'open', '--json', 'number')
            p['pr'] = prs[0]['number']
        p['step'] = 'ci'
        self.save('Verify live GitHub CI and Vercel')

    def drive(self):
        self.preflight()
        while self.s['phase'] < len(PHASES):
            self.run.stop_check()
            if not self.fake and api('branches/staging')['commit']['sha'] != BASE:
                raise Blocked('Staging changed during this run; stop for dependency reconciliation')
            index = self.s['phase']
            dependencies = self.dependencies(index)
            p = self.setup(index)
            self.phase_checkout(p)
            p['dependencies'] = dependencies
            if git(p['worktree'], 'rev-parse', 'HEAD') != p['head'] and p['step'] != 'commit':
                raise Blocked('Phase HEAD drifted outside supervisor')
            if p['step'] in ('implement', 'repair', 'review', 'integration-review'):
                role = p['step']
                result = self.codex(p, role, dependencies)
                if result['status'] == 'blocked':
                    raise Blocked('Worker dependency/verification blocker: ' + '; '.join(result['blockers']))
                if 'review' in role:
                    if result['status'] == 'findings':
                        if role == 'integration-review' or p['repairs'] >= self.s['max_repairs']:
                            raise Blocked('Unresolved independent review: ' + '; '.join(result['findings']))
                        p['repairs'] += 1
                        p['findings'], p['review'], p['pending'], p['step'] = result['findings'], None, None, 'repair'
                    else:
                        p['review'] = result
                        p['review']['evidence'] = p['pending']['directory']
                        p['pending'], p['step'] = None, 'record-review' if index < 3 else 'complete'
                        if index < 3:
                            self.ci(p, wait=False)  # catch changes/reruns during review
                else:
                    if result['status'] != 'complete':
                        raise Blocked('Implementation did not complete')
                    p['tests'], p['result'] = result['tests'], result
                    p['commit_message'] = f'Video Review {p["name"]} ({self.s["id"]}, repair {p["repairs"]})'
                    p['step'] = 'commit'
                self.save(p['step'])
            elif p['step'] == 'commit':
                self.commit(p)
            elif p['step'] == 'publish':
                self.publish(p)
            elif p['step'] == 'ci':
                self.ci(p)
                p['step'] = 'review'
                self.save('Fresh independent exact-HEAD review')
            elif p['step'] == 'record-review':
                if not self.fake:
                    pr = api(f'pulls/{p["pr"]}')
                    if pr['head']['sha'] != p['head']:
                        raise Blocked('PR changed before recording independent review')
                    body = pr['body']
                    start, end = body.index('## Independent review'), body.index('## Reusable learning')
                    review = p['review']
                    section = ('## Independent review\n- Required: yes\n- Status: passed\n'
                               '- Reviewer: fresh read-only Codex CLI execution\n'
                               '- Fresh context confirmed: yes\n'
                               f'- Reviewed SHA: {p["head"]}\n- Findings/conclusion: {review["summary"]}\n'
                               f'- Resolution and re-verification: {json.dumps(review["tests"])}\n')
                    updated = body[:start] + section + body[end:]
                    if updated != body:
                        path = self.run.root / f'{p["name"]}-review-body.md'
                        path.write_text(updated)
                        p['after_check_ids'] = p['ci']['check_ids']
                        self.save('Record review metadata and wait for triggered CI reruns')
                        command(['gh', 'api', '--method', 'PATCH', f'repos/{REPO}/pulls/{p["pr"]}',
                                 '-F', f'body=@{path}'])
                p['step'] = 'final-ci'
                self.save('Recheck CI after PR review metadata update')
            elif p['step'] == 'final-ci':
                self.ci(p)
                p['step'] = 'complete'
                self.save('Phase verified')
            elif p['step'] == 'complete':
                if index < 3:
                    self.ci(p, wait=False)
                self.s['phase'] += 1
                self.save('Next phase with verified upstream code')
            else:
                raise Blocked('Unknown phase state')
        self.s['status'], self.s['blockers'] = 'complete', []
        self.save('Operator testing and manual PR merge decisions; no live generation was tested')
        if self.fake:
            atomic(self.run.root / 'dry-run-passed.json', {'digest': digest(), 'status': 'complete', 'fake': True})


def initialize(run, args):
    validate_models(args.model, args.review_model)
    if run.state:
        raise Blocked('Run already exists; use resume')
    if not args.dry_run:
        proof = read(Path(args.dry_run_proof) / 'dry-run-passed.json') if args.dry_run_proof else {}
        if proof != {'digest': digest(), 'status': 'complete', 'fake': True}:
            raise Blocked('Complete dry-run proof for this exact supervisor is required')
        command([sys.executable, '-m', 'unittest', 'discover', '-s', str(HERE), '-p', 'test_*.py'], timeout=120)
    repo = Path(args.repo).resolve()
    base = BASE
    if args.dry_run:
        repo = run.root / 'fixture-repo'
        repo.mkdir()
        command(['git', 'init', '-b', 'staging', str(repo)])
        git(repo, 'config', 'user.name', 'Offline fixture')
        git(repo, 'config', 'user.email', 'fixture@example.invalid')
        for path in SOURCES:
            f = repo / path
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text('Offline source-contract fixture\n')
        git(repo, 'add', '.')
        git(repo, 'commit', '-m', 'Offline base')
        base = git(repo, 'rev-parse', 'HEAD')
    run.state = {'version': 1, 'id': uuid.uuid4().hex[:10], 'repo': str(repo), 'base': base,
                 'phase': 0, 'phases': [], 'status': 'running', 'blockers': [],
                 'dry_run': args.dry_run, 'code_digest': digest(), 'model': args.model,
                 'review_model': args.review_model,
                 'deadline': time.time() + 8 * 60 * 60,
                 'max_repairs': 2, 'worker_timeout': args.worker_timeout, 'ci_timeout': args.ci_timeout}
    run.save()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['start', 'resume', 'status', 'stop'])
    parser.add_argument('--run-dir', required=True)
    parser.add_argument('--repo', default=str(HERE.parents[1]))
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--dry-run-proof')
    parser.add_argument('--retry-worker', action='store_true', help='On resume only: retry a diagnosed failed worker in a fresh context (bounded)')
    parser.add_argument('--model', default=DEFAULT_CODEX_MODEL, choices=sorted(ALLOWED_CODEX_MODELS))
    parser.add_argument('--review-model', default=DEFAULT_CODEX_MODEL, choices=sorted(ALLOWED_CODEX_MODELS))
    parser.add_argument('--worker-timeout', type=int, default=5400)
    parser.add_argument('--ci-timeout', type=int, default=1800)
    args = parser.parse_args()
    root = Path(args.run_dir).resolve()
    if args.action == 'status':
        print(json.dumps(status_snapshot(root), indent=2))
        return 0
    if args.action == 'stop':
        if not (root / 'checkpoint.json').exists():
            raise Blocked('Run does not exist')
        (root / 'STOP').touch()
        print('Stop requested. Active process group will be terminated; work is preserved.')
        return 0
    run = Run(root)
    try:
        run.begin(args.action)
        if args.action == 'start':
            initialize(run, args)
        elif not run.state:
            raise Blocked('No checkpoint to resume')
        if args.retry_worker:
            if args.action != 'resume' or run.state['phase'] >= len(run.state['phases']):
                raise Blocked('--retry-worker requires an existing interrupted phase')
            p = run.state['phases'][run.state['phase']]
            pending = p.get('pending')
            receipt = Path(pending['directory']) / 'exit.json' if pending else None
            if not receipt or not receipt.exists() or not read(receipt)['returncode']:
                raise Blocked('--retry-worker requires a failed worker receipt; successful work is never repeated')
            if p['interruptions'] >= 2:
                raise Blocked('Worker recovery budget exhausted')
            p['interruptions'] += 1
            p.setdefault('failed_attempts', []).append(pending)
            p['pending'] = None
            run.save()
        if run.state['status'] == 'complete':
            print((root / 'handoff.txt').read_text())
            return 0
        (root / 'STOP').unlink(missing_ok=True)
        def stop_signal(_sig, _frame):
            run.lifecycle['stop_signal'] = signal.Signals(_sig).name
            run.heartbeat(force=True)
            (root / 'STOP').touch()
        signal.signal(signal.SIGTERM, stop_signal)
        signal.signal(signal.SIGINT, stop_signal)
        run.state['status'], run.state['blockers'] = 'running', []
        Supervisor(run).drive()
        return 0
    except (Blocked, ValueError, OSError, KeyError) as exc:
        run.state['status'] = 'stopped' if isinstance(exc, Stopped) else 'blocked'
        run.state['blockers'] = [str(exc)]
        run.state['next_step'] = f'Resolve blocker, then resume --run-dir {root}'
        run.save()
        run.event('blocked', reason=str(exc))
        print(str(exc), file=sys.stderr)
        return 2
    finally:
        try:
            exc = sys.exc_info()[1]
            run.finish('unexpected_exception' if exc else run.state.get('status', 'uninitialized'),
                       type(exc).__name__ if exc else None)
        finally:
            run.close()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (Blocked, OSError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(2)
