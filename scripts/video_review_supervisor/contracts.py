"""Bounded task contracts. No shared application interface is invented here."""
import json

REPO = 'celleree/tra-ai-marketing'
BASE = '1bf68fd03860bbd0cbdbaee0bd1fb17df928ade9'
SOURCES = ['AGENTS.md', 'docs/agent-workflow.md', 'docs/parallel-coding.md',
           'docs/image-gen-improvement.md', 'docs/image-workflow.md',
           'lib/creatives/review-handoff.ts', 'lib/video/review-selection.ts',
           'lib/video/review-selection-store.ts', 'tests/creatives/review-handoff.test.ts']
PHASES = [
    ('slice-2', 'Connect immutable Video Review selections to normal Create portfolio admission, '
     'frozen planning input, Astra planning/audit/repair, persistence and Retry/Resume.'),
    ('slice-3', 'Implement manual closed-frame-pool generation, safety assessment, fresh '
     'source-bound PNG extraction, crop checks and attachment provenance. Preserve automatic '
     'selection when no frames are selected.'),
    ('slice-4', 'Connect the Create UI to the completed pipeline, including saved revision, video '
     'inventory restoration, Profile consistency and browser integration tests.'),
    ('integration-review', 'Independently inspect the complete integrated diff from original staging '
     'through the three slices. Trace and test full Create, Retry/Resume, manual frame, automatic '
     'frame, stale revision/source and Profile flows. Verify readiness for operator testing. '
     'Identify untested paths honestly. Never claim live-provider or production proof.')]
SCHEMA = {'type': 'object', 'additionalProperties': False, 'properties': {
    'status': {'type': 'string', 'enum': ['complete', 'blocked', 'findings']},
    'head': {'type': 'string'}, 'summary': {'type': 'string'},
    'tests': {'type': 'array', 'items': {'type': 'string'}},
    'large_pr_justification': {'type': 'string'},
    'review_order': {'type': 'array', 'items': {'type': 'string'}},
    'contracts': {'type': 'array', 'items': {'type': 'string'}},
    'blockers': {'type': 'array', 'items': {'type': 'string'}},
    'findings': {'type': 'array', 'items': {'type': 'string'}}},
    'required': ['status', 'head', 'summary', 'tests', 'contracts', 'blockers', 'findings',
                 'large_pr_justification', 'review_order']}


def validate(value):
    if set(value) != set(SCHEMA['required']):
        raise ValueError('Missing or unexpected worker fields')
    if value['status'] not in ('complete', 'blocked', 'findings'):
        raise ValueError('Invalid worker status')
    for key in ('head', 'summary'):
        if not isinstance(value[key], str) or not value[key]:
            raise ValueError(f'Invalid {key}')
    if not isinstance(value['large_pr_justification'], str):
        raise ValueError('Invalid large PR justification')
    for key in ('tests', 'contracts', 'blockers', 'findings', 'review_order'):
        if not isinstance(value[key], list) or any(not isinstance(x, str) for x in value[key]):
            raise ValueError(f'Invalid {key}')
    if value['status'] == 'complete' and (value['blockers'] or value['findings'] or not value['tests']):
        raise ValueError('Complete result has blockers/findings or no verification evidence')
    return value


def prompt(phase, role, base, head, dependencies, findings):
    return f'''PROJECT: {REPO}
TASK: {PHASES[phase][1]}
ROLE: {role}. Fresh independent execution; do not use previous conversation/session history.
BASE: {base}; expected initial HEAD: {head}.
SOURCE OF TRUTH: Reread {', '.join(SOURCES)} and directly relevant runtime code/tests.
Verified upstream dependency evidence: {json.dumps(dependencies)}
Material repair findings: {json.dumps(findings)}
Read actual upstream interfaces. Never invent a competing shared contract. If a dependency,
architecture decision, approval, or required test environment is unresolved, return blocked.
Preserve Proof, draft-only claims, source hash/revision integrity, provider-ineligible analysis
JPEGs/thumbnails, fresh PNG provenance, automatic behavior without selected frames, persistent
creative identity, quotas, idempotency, paid-result reuse and current retry safety.
No merges, pushes, PR operations, deployments, paid generation, provider smoke tests, credential
changes, production data access, sandbox bypass, network-policy changes, or other worktrees. The
supervisor owns Git writes and GitHub. Do not edit .git, AGENTS.md, docs/agent-workflow.md,
docs/parallel-coding.md, .github/, .env files, or the supervisor. No parallel writers/subagents.
This bounded implementation is authorized. For implementation/repair: inspect, implement only
this phase, run focused offline tests and a completion audit. Leave changes uncommitted; the
supervisor commits them and runs real CI. Prefer <=200 substantive lines; <=400 soft ceiling.
After interruption, inspect existing changes first and complete them without duplicating work.
Attempt splitting before implementing an oversized phase. If an intermediate state would be
invalid or splitting would reduce correctness, provide large_pr_justification explaining why
and a concrete review_order. Otherwise return blocked with the executable split plan. Empty
justification/review_order are appropriate for small changes. Report actual test commands/results
and source-contract paths in the structured result.
For review/integration-review: read-only independent exact-HEAD review. Inspect the diff and
relevant contracts/tests, verify realistic execution paths and reported evidence, return ALL
material findings together. Do not implement fixes. Run offline checks only; use /tmp for output
if necessary. In the read-only source profile, Vitest's ordinary config loader cannot write
node_modules/.vite-temp; use `npm test -- --configLoader runner --no-cache tests/creatives/review-handoff.test.ts`
for that fixture (18 tests verified here). Do not interpret inability to test as PASS.
Report the exact inspected HEAD.
For every role return only the schema fields. head is the initial/inspected Git HEAD, not a
fabricated future commit. tests distinguishes executed checks from limitations.
'''
