# Agent Workflow Details

Load this file only for planning, review, merge, routing, handoff, or multi-agent coordination work. Normal bounded implementation should usually need only `AGENTS.md`, the specific GitHub Issue/task, and the directly relevant code/tests.

## Coordinator-owned Codex routing

When ChatGPT or another coordinator sends work to Codex, the coordinator resolves the route before the task starts.

Show this human-facing block outside the copyable Codex prompt:

```text
WHERE: Terminal / CLI | Desktop | VS Code
SESSION: NEW | CONTINUE — <short session name>
MODEL: Luna | Terra | Sol | Astra
REASONING: Low | Medium | High | Extra-high
PARALLEL: YES | NO — <brief reason>
```

Rules:
- The routing block is metadata for the human/operator, not part of the Codex task prompt.
- Resolve every field to a concrete value; do not leave placeholders such as `cheapest suitable model`.
- Codex should execute the chosen route but should not echo the routing block in normal results unless asked.
- Model and reasoning are selected independently using the cost-aware defaults in `AGENTS.md`.

## ChatGPT -> Codex task handoff

Prefer a narrow task prompt with only information Codex needs:

```text
TASK:
[one concrete task]

CONTEXT:
[only context not already in canonical repo sources]

SOURCE OF TRUTH:
[exact Issue/files/config]

SCOPE:
[what may change]

DO NOT:
[explicit exclusions]

INSTRUCTIONS:
[current checkpoint only]

RETURN:
[required result fields]
```

Do not paste broad project history, old PR discussion, or repository summaries when the canonical sources already contain the needed information.

## Codex result handoff

Default final result:

```text
STATUS:
COMPLETE | PARTIAL | BLOCKED | INVESTIGATION COMPLETE | APPROVAL NEEDED

TASK:
[one sentence]

BRANCH:
[current branch]

BASE STAGING SHA:
[when relevant]

HEAD SHA:
[current/final SHA, or N/A]

FILES INSPECTED/CHANGED:
- materially relevant files only
- or NONE

IMPLEMENTATION / FINDINGS:
- concise findings or changes

VERIFICATION:
- exact check: PASS | FAIL | NOT RUN

BLOCKERS:
- exact blocker or NONE

DECISIONS NEEDED:
- unresolved decision or NONE

SHARED CONTRACTS / AREAS AFFECTED:
- relevant shared area or NONE

RISKS / CONFLICTS:
- relevant risk or NONE

REMAINING:
- unfinished work or NONE

NEXT RECOMMENDED ACTION:
[one concrete next step]

PARALLEL-SAFE NEXT WORK:
YES | NO
Reason: [one sentence]
```

Do not include raw command logs, long diffs, private reasoning, or repeated repository context unless needed to explain a failure.

## Implementation cycle

For bounded non-mechanical work:

1. Investigate/plan first. Inspect the smallest relevant file set and propose the smallest coherent change.
2. Resolve scope/design questions before editing when they are material.
3. Implement only the approved/current plan.
4. Run focused verification during implementation.
5. Let repository CI run the full regression/typecheck/build pass by default.
6. Use one fresh independent review of the final exact HEAD when policy requires it.
7. Send findings back to the implementation session for repair.
8. Reverify. If a material code change moves HEAD after review, the previous review is stale and a fresh review is required.
9. Merge only when required verification/review are current and material findings are resolved.

Simple low-risk mechanical work may combine planning and implementation.

## Review efficiency and freshness

Live GitHub state is authoritative for the current PR HEAD, base, diff, and checks. PR descriptions may contain historical verification/review evidence but must not be treated as live state.

Independent-review rules:
- LOW: normal verification; independent review is optional unless the task or risk warrants it.
- MEDIUM: independent review is required when runtime behavior or an integration boundary changes; otherwise record why it is not needed.
- HIGH: independent review is always required.
- A reviewer must use fresh context and must not inherit the implementer's transcript.
- The reviewed SHA must equal the current live PR HEAD when review is required.
- A material code-modifying commit, rebase, or base sync after review invalidates that review.
- One qualifying fresh review of the final HEAD is sufficient. Do not routinely run both GitHub Codex review and a second manual AI reviewer against the same final tree unless an explicit second opinion is justified.
- Keep implementation PRs draft until the intended implementation and focused verification are stable. Mark ready for review only when a final review is useful.

Reviewer scope:
- acceptance criteria and canonical requirements;
- regressions and realistic edge cases;
- missing tests where they materially affect confidence;
- security/safety proportional to the real threat model;
- risk classification and weakened safeguards.

Once realistic acceptance criteria and material risks are covered, stop. Do not generate speculative edge cases solely to exhaust theoretical possibilities.

## Threat model and proportionality

TRA AI Marketing is currently an internal tool used by a small set of trusted, non-malicious authorized users.

Optimize for:
- accidental misuse and malformed inputs;
- data integrity and hard product invariants;
- auth/authz and secret exposure;
- destructive production actions or production storage damage;
- unintended advertising spend/publishing;
- compliance failures.

Do not add hostile-client-grade, adversarial multi-tenant, immutable-provenance, or similarly heavyweight infrastructure solely to defend against hypothetical malicious behavior by trusted internal users.

## PR size and reviewability

Canonical limits live in `.github/pr-reviewability-policy.json`.

- Prefer <=200 substantive changed lines when practical.
- Normal soft ceiling: <=400 substantive changed lines.
- Split-or-justify when more than 10 substantive files are touched.
- High-risk work should prefer <=200 substantive lines.
- If splitting would damage correctness or leave an invalid intermediate state, keep the coherent change together and provide `Large PR justification` and `Review order` in the PR body.
- Generated files, lockfiles, snapshots, mechanical formatting, and bulk moves/renames are mechanical rather than substantive review work.

## Parallel work

Default to one implementation agent. Load `docs/parallel-coding.md` only when parallel execution is being considered.

Use a second implementation agent only when tasks are bounded, independently verifiable, have low overlap, do not depend on an unresolved shared contract, and concurrency is likely to save more time than coordination costs.

## Durable decisions and reusable learning

Capture only durable conclusions:
- runtime behavior -> code/config;
- active image-workflow direction -> `docs/image-workflow.md`;
- stable boundaries -> `docs/architecture.md`;
- stage ordering/future direction -> `docs/roadmap.md`;
- deployment requirements -> `docs/deployment.md`;
- current/deferred implementation work -> GitHub Issues.

Prefer a regression test, deterministic guard, reusable helper, or code/config change over adding another agent rule. Do not store routine debugging, transient failures, raw conversations, or failure journals in canonical docs.

## Staging-first issue completion

GitHub close keywords do not automatically close an Issue when a PR merges only into `staging` because `main` is the default branch. When a specific implementation Issue is fully completed by a staging merge, close it explicitly as part of merge completion. Do not close umbrella, deferred, or partially completed Issues.