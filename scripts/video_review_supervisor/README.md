# Local Video Review supervisor

Maintenance-only foundation; merging this code does not authorize unattended execution. The
pinned Slice 2–4 plan is historical: those application slices are already merged into staging.
Keep the original base pin and its fail-closed checks. A new application task requires separate
planning, current sandbox verification, exact-source rehearsal/review and execution authorization;
do not update BASE merely to run the old plan against current staging.

Python 3.12 standard library, Linux/WSL, sequential execution. This tool implements orchestration;
its offline fixture does **not** implement or validate the Video Review application slices.

## Commands

Run from the supervisor checkout. Keep run directories on native Linux storage, outside existing
checkouts. Paths below are the tested machine's locations. `start` runs in the foreground; use
`nohup` for overnight execution and keep Windows/WSL awake.

```bash
# Offline tests: fake Codex/GitHub, real temporary Git repositories and worker processes.
python3 -m unittest discover -s scripts/video_review_supervisor -p 'test_*.py' -v

# Complete offline rehearsal; use a fresh directory each time supervisor code changes.
python3 scripts/video_review_supervisor/supervisor.py start --dry-run --run-dir /home/arund/dev/tra-supervisor-evidence/dry-run-model-policy

# Overnight launch (the dry-run directory above must have completed with this exact code).
nohup python3 /home/arund/dev/tra-video-review-supervisor/scripts/video_review_supervisor/supervisor.py start --repo /home/arund/dev/tra-video-review-supervisor --run-dir /home/arund/dev/tra-video-review-overnight --dry-run-proof /home/arund/dev/tra-supervisor-evidence/dry-run-model-policy --model gpt-6.1-sol --review-model gpt-6.1-sol > /home/arund/dev/tra-supervisor-evidence/overnight.log 2>&1 < /dev/null &

python3 scripts/video_review_supervisor/supervisor.py status --run-dir /home/arund/dev/tra-video-review-overnight
python3 scripts/video_review_supervisor/supervisor.py stop --run-dir /home/arund/dev/tra-video-review-overnight
python3 scripts/video_review_supervisor/supervisor.py resume --run-dir /home/arund/dev/tra-video-review-overnight
```

`stop` requests termination of the active worker process group and preserves changes. `resume`
acquires the same exclusive lock, clears the stop request, rechecks prerequisites, and continues
from the checkpoint. It never calls `codex exec resume`, forks a conversation, or uses `--last`.
Use the same `nohup … resume …` form when resuming overnight. `status` is a checkpoint snapshot;
a `running` snapshot after an abrupt kill is not proof of a live supervisor. The lock is the
execution authority. Do not delete locks, worktrees, receipts, or checkpoints to force progress.

## Execution and evidence

### Read-only reconciliation and exit evidence

`status` adds a `reconciliation` object to the historical checkpoint. It probes the existing
lock without creating it, reports a pending attempt's receipt and includes `supervisor.json`.
It never starts workers, writes run files, clears STOP or validates GitHub CI.

`supervisor.json` records session/PID, start time, last heartbeat and observed exit reason
(`complete`, `stopped`, `blocked`, or `unexpected_exception`). Heartbeats update at checkpoints
and about once per second during cooperative waits; synchronous prerequisite/GitHub commands
can pause them. Heartbeat age and PID alone do not prove liveness. A held lock may belong to an
orphan worker. An available lock plus an unfinished lifecycle reports
`exit_unobserved_cause_unknown`: SIGKILL/power loss cannot write their own exit reason. Do not
infer the cause of a disconnect from this observation. Resume preserves the prior lifecycle in
`events.jsonl` before starting a new session.

Status is a momentary observation; resume must acquire the exclusive lock and revalidate source
digest, assigned HEAD and live CI. Receipt availability is not a reviewed/publishable PASS.
Successful receipt consumption logs `worker_receipt_reconciled` without repeating completed work.
Older files remain readable, but runs pinned to older code still fail closed on source-digest
mismatch. Do not replace code or edit digests to force resume of an existing run.

- Pinned source base: merged PR #302, staging `1bf68fd03860bbd0cbdbaee0bd1fb17df928ade9`.
  Live staging drift stops the run for explicit reconciliation; no automatic base sync.
- Phases: Slice 2 admission/planning/persistence; Slice 3 manual frame generation;
  Slice 4 UI/restoration/browser tests; independent read-only integrated review.
- Codex worker model policy is a strict allowlist: `gpt-6-luna` and `gpt-6.1-sol` only.
  Both implementation and independent review default to `gpt-6.1-sol` / high reasoning.
  `--model` / `--review-model` may choose **only** those two exact IDs; all older variants,
  Astra, Terra, unsupported names and silent fallbacks are rejected before a worker starts.
  Configuration is frozen at `start` and revalidated on `resume`; if a model is unavailable,
  the run blocks rather than switching models. This restricts Codex coding agents only,
  not the application's existing provider/model choices.
- Every implementation/review/repair uses a new `codex exec --ephemeral` execution, a task-specific
  prompt and `--output-schema`, JSONL events and a separate result file. Each phase owns an isolated
  feature branch/worktree; repairs preserve that phase's worktree in a new conversation. Each review
  has a separate detached worktree and a filesystem-read-only permission profile.
- Workers use supported Codex permission profiles with workspace writes or read-only source,
  plus a private writable temporary directory; `.git` is read-only. Never unrestricted access. User configuration is
  ignored for execution (existing Codex authentication is still used). Application/provider env
  secrets are not inherited. Shells get a minimal explicit PATH and TMPDIR. The Codex command-network proxy permits only
  loopback fixtures and registry.npmjs.org; external application/provider traffic is denied.
  NO_PROXY lets browser/server fixtures communicate within their sandbox namespace;
  approval policy `never` means disallowed operations fail, not permission escalation.
- In the read-only review source profile, ordinary Vitest config loading writes
  `node_modules/.vite-temp` and fails. For the existing review handoff fixture, use
  `npm test -- --configLoader runner --no-cache tests/creatives/review-handoff.test.ts`;
  all 18 tests passed with this invocation on this machine.
- The deterministic supervisor alone performs exact-branch commits, non-force pushes, PR
  creation, and metadata updates. It has no merge/deployment command. It preserves protected
  branches, existing checkouts and uncommitted work. A phase directory must be a clean, registered
  worktree of this repository on its dedicated branch at setup; commit and publish recheck that
  identity. Worker changes to safeguards/env/supervisor
  paths stop before commit/push. npm dependency preparation uses `npm ci --ignore-scripts`;
  package lifecycle scripts are not executed by the unsandboxed coordinator.
- Branches stack on verified upstream HEADs. PRs target `staging` cumulatively because this
  repository's existing CI does not trigger for feature-branch PR bases. PR bodies identify
  dependencies, incremental review base, and cumulative-size justification. Do not merge all
  cumulative PRs blindly: the operator must choose an integration/merge sequence and reverify
  any resulting HEAD/base changes.
- Required `verify`, `pr-reviewability`, and `Vercel` evidence comes from live GitHub check runs and
  statuses at the assigned SHA, with PR HEAD/base/state checks. Empty, pending, stale, failed,
  cancelled or skipped checks never pass. Worker claims of PASS are only local-test evidence.
  Live exact-HEAD checks are refreshed before each new reviewer execution, including after resume.
  Check runs and legacy statuses cannot mask each other's failed/pending evidence. Optional skipped
  metadata-only jobs are not verification evidence; required skipped checks never pass. Body-only
  metadata updates require fresh reviewability, while successful verify at the unchanged SHA may
  be reused. Reviewer SHA must remain exact.
- `checkpoint.json` is atomically replaced and fsynced; it includes source-contract Git blob IDs,
  phase/base/HEAD/branch, tests, PR/CI, review, blockers and next step. `events.jsonl`, per-attempt
  prompt/schema/result/exit/JSONL/stderr files and `handoff.txt` preserve readable provenance.
- A worker inherits the run lock, so killing the supervisor cannot allow a concurrent writer.
  A successful receipt is reconciled on restart without repeating completed implementation.
  An interrupted execution without a receipt gets a fresh context that inspects retained edits.
  Commits and PR creation are reconciled against actual Git/GitHub state before retrying.
- Two material-review repairs and two interrupted-execution recoveries per phase are allowed.
  Default worker timeout is 90 minutes, CI wait is 30 minutes, and the whole run has an eight-hour
  deadline across restarts. Infrastructure failures, CI failures, unresolved dependencies,
  exceeded budgets and material final integration findings stop. They are not silently retried.
  Restart does not reset budgets. A persistent failed worker receipt requires operator diagnosis,
  not automatic repeated LLM calls.
  After diagnosing and resolving a failed CLI invocation, `resume --retry-worker --run-dir …`
  explicitly permits a fresh execution within the same two-recovery budget. A successful receipt
  cannot be repeated with this option; it never resets the overall deadline or repair limit.
- Phases must attempt splitting oversized changes; >400 lines or >10 files requires a concrete
  coherence justification and review order, assessed by the independent reviewer. Unresolved
  architecture/splitting decisions stop rather than inventing a shared interface.

## Prerequisites and limits

Authenticated Codex ChatGPT access and `gh` repo access, Git identity, supported CLI flags, working
Linux sandbox, Node/npm, ffmpeg/ffprobe, sufficient disk, package registry access, Git push/PR
permission and a working Vercel preview integration are required. Real `start` reruns offline
unit tests and requires a completed dry-run receipt matching the exact supervisor source digest.
Any supervisor-code change invalidates the previous dry-run proof and exact-HEAD independent
review. Before an unattended run, rerun offline tests/dry-run and obtain a fresh exact-HEAD
independent review and green CI/Vercel.
Missing prerequisite/checks block the run. Account quotas can still interrupt overnight work.
No production credentials, provider generation, publishing, merges or production smoke tests
are authorized by this tool. Browser integration tests must use local fixtures/mocks; if required
browser tooling cannot run in the sandbox, the worker must report that blocker. The tool does
not guarantee that all three application slices fit one night or that unseen application blockers
can be resolved without an operator.

The fake mode uses a temporary fixture Git repository plus `fake.py` for Codex and persisted fake
GitHub responses. No real repository push or model/GitHub/provider call occurs in fake mode.
Tests cover successful sequencing, exact-HEAD CI rejection, review retry exhaustion, process
termination, SIGKILL/orphan locking, durable receipt recovery, stale checkout rejection and resume.
Fake evidence is explicitly labelled and never reused as application proof.

Current CLI options were checked against installed `codex-cli 0.161.0` and
[official non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode).

## Reviewability

Risk: HIGH, because this tool coordinates unattended repository writes and safety boundaries.
Independent exact-HEAD review is required before use for unattended application implementation.

LARGE PR JUSTIFICATION: This is one executable supervisor with its fake transport, failure tests
and operator instructions. Splitting the process lock/checkpoint protocol from its worker receipt,
Git/CI gates and failure tests would leave an unverified runnable coordinator. There is no app
runtime change. The next independent unit is a future supervisor capability, not a partial runner.

REVIEW ORDER: `contracts.py` (scope/safeguards/schema), `sandbox.py` (filesystem/network permissions), `runtime.py` (durability/stop/locking),
`supervisor.py` (transitions/GitHub gates), `fake.py` and `test_supervisor.py` (failure evidence),
then these launch instructions. No repository safeguard or CI file changes.
