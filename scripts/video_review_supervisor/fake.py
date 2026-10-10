"""Offline Codex response fixture; never calls Codex, GitHub or application providers."""
import json
from pathlib import Path
import sys
import time
from runtime import atomic, command, read

root, role, worktree, output = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3]), Path(sys.argv[4])
scenario = read(root / 'scenario.json') if (root / 'scenario.json').exists() else {}
counter = root / 'fake-calls.json'
calls = read(counter) if counter.exists() else []
calls.append({'role': role, 'worktree': str(worktree), 'output': str(output)})
atomic(counter, calls)
time.sleep(scenario.get('delay', 0))
if scenario.get('exit'):
    sys.exit(scenario['exit'])
head = command(['git', '-C', str(worktree), 'rev-parse', 'HEAD'])
if role in ('implement', 'repair'):
    (worktree / 'offline-phase.txt').write_text(f'{role} attempt {len(calls)}\n')
result = {'status': 'complete', 'head': head, 'summary': 'OFFLINE FAKE evidence only',
          'tests': ['Fake offline test: PASS (not application verification)'],
          'large_pr_justification': '', 'review_order': [],
          'contracts': ['lib/creatives/review-handoff.ts'], 'blockers': [], 'findings': []}
if role == 'review' and scenario.get('findings', 0) > sum(c['role'] == 'repair' for c in calls):
    result.update(status='findings', findings=['Fixture material finding'])
if scenario.get('stale'):
    result['head'] = '0' * 40
if scenario.get('blocked'):
    result.update(status='blocked', blockers=['Fixture dependency unavailable'])
atomic(output, result)
print(json.dumps({'type': 'fake.complete', 'role': role}))
