# TRA AI Marketing Agent Rules

Keep normal AI/Codex context small. Read only what the current task requires.

## Core workflow

- `main` = current production.
- `staging` = combined future version and normal development base.
- Normal app/code work starts from latest `staging` on a dedicated feature branch.
- Do not build multi-file app changes directly on `staging` or `main`.
- Merge completed feature work into `staging`; promote `staging` to `main` only with explicit production approval.
- Preserve intended work from parallel branches when resolving conflicts; do not silently overwrite another agent's work.
- Prefer ChatGPT/the coordinator for work that connected tools can complete safely without a local checkout, including GitHub state/check/log inspection, PR metadata, merge execution, and supported repository administration. Spend Codex/local-agent credits primarily on work that actually requires local repository edits, local tests/builds, or runtime interaction.
- Any coordinator repository write must explicitly target the intended dedicated feature branch and follow the normal PR/review path. Never let a repository write fall through to the default branch, and never write directly to `staging` or `main` unless an existing rule explicitly authorizes that action.

## Current product scope

The active build is the Stage 1 static-image creative system. For current implementation behavior and ordering, use `docs/image-workflow.md` before the long-term roadmap.

For image-generation continuation work, read `docs/image-gen-improvement.md` first, then follow the linked canonical docs and code. Treat it as the active checkpoint for this workstream, not a replacement for code or canonical architecture docs.

For the current remaining Stage 1 implementation order, use the `Current remaining roadmap for Astra` section in `docs/image-workflow.md`.

Do not expand into autonomous media buying, winner prediction, budget optimization, automatic pause/scale logic, performance dashboards, or unrestricted Meta execution unless explicitly reactivated.

## Source-of-truth precedence

Use the narrowest current source that actually governs the task:

1. Runtime source code/tests for what is actually implemented.
2. `docs/image-workflow.md` for the active Stage 1 image-product direction and intended architecture.
3. Current GitHub Issue/task acceptance criteria underneath that direction; an Issue overrides `docs/image-workflow.md` only when it explicitly records a newer product decision and states what it supersedes.
4. `docs/architecture.md` for stable system boundaries and future-stage architecture; it does not override the active Stage 1 image workflow.
5. `docs/roadmap.md` for long-term/future direction; it does not override the active Stage 1 image workflow.
6. `docs/deployment.md` for external deployment/setup requirements.
7. `.env.example` for environment-variable names/examples.

Do not restore old architecture from stale Issues, PR descriptions, roadmap text, architecture text, or historical planning. If documentation conflicts with executable code/config about current runtime behavior, code/config is authoritative. Correct stale documentation when the conflict represents a durable project-state change.

## Context limits

- Do not recursively load the repository, `/docs`, Git history, old PRs, or external sources by default.
- Start with this file, the task/Issue, and the directly relevant code/tests.
- Load only the specific supporting document needed.
- Prefer summaries and current canonical sources over replaying old chat/PR history.
- Stop exploring once the smallest sufficient file set is known.

## Repository routing map

Use this as the default first scope; expand only when evidence requires it.

- Video/frame work -> `lib/video/`, `app/api/video/`, `tests/video/`.
- Creative records/library/generation persistence -> `lib/creatives/`, `app/api/creatives/`, `tests/creatives/`.
- Company profile/brand context -> `lib/company/`, `app/api/company/`, `tests/company/`.
- AI planning/generation integration -> `lib/ai/`, relevant API route, `tests/ai/`.
- Layout/reference processing -> `lib/layouts/`, `lib/references/`, relevant API routes, `tests/layouts/` / reference tests.
- Media/storage -> `lib/media/`, `app/api/media/`, `tests/media/`.
- Meta integration -> `lib/meta/`, `app/api/meta/`, `tests/meta/`.
- Planning/meaningful implementation-cycle/coordination/review/parallel-work rules -> load `docs/agent-workflow.md`; load `docs/parallel-coding.md` only when parallelism is actually being considered.

## PR size and branch safety

PRs should be the smallest coherent, self-contained change. Canonical thresholds live in `.github/pr-reviewability-policy.json`.

- Prefer <=200 substantive changed lines when practical.
- Normal soft ceiling: <=400 substantive changed lines.
- Split-or-justify when more than 10 substantive files are touched.
- High-risk work should prefer <=200 substantive lines.
- If splitting would reduce correctness or leave an invalid intermediate state, keep the coherent change together and provide the required justification/review order.
- Keep unrelated work out of the branch.

Any PR changing `.github/workflows/**`, `.github/pr-reviewability-policy.json`, or any safeguard/risk-review rule in `AGENTS.md` or `docs/agent-workflow.md` is HIGH risk and requires a fresh independent review of the exact current HEAD before merge.

## Verification

During implementation, run the narrowest relevant tests/checks first.

By default:
- Codex runs focused verification while iterating.
- Repository CI provides the full typecheck + test suite + production build regression pass.
- Run the full local suite/build before CI only when the change is cross-cutting/high-risk, changes build/dependencies, CI is unavailable, or focused evidence indicates it is necessary.
- Stop after the first correct verified fix; do not refactor or improve unrelated code.
- Before implementation handoff, perform a proportional completion audit: reread the acceptance criteria, inspect the complete diff, exercise realistic edge cases/state transitions, and fix issues found. Keep this lightweight for mechanical changes; it is not an independent review.
- Do not request a required independent review until implementation is stable, the PR is in its intended final review state, and exact-HEAD CI is green.

## Risk and review

**Review realism:** TRA is an internal trusted-user tool. Review defects that are realistically reachable through normal use, ordinary operator mistakes, expected application/API/model flows, retries, partial failures, or plausible persisted state. Do not fail work solely for contrived adversarial cases that require intentional human bypass, manual data corruption, abnormal internal requests, or deliberate exploitation. This does not relax strict review of auth/authz, secrets/security, compliance and Proof/provenance, publishing/spend, destructive actions, production-data integrity, realistic data-loss risks, or other hard safety invariants. A material finding should identify a realistic path by which the failure can occur.

Detailed review rules live in `docs/agent-workflow.md`.
- LOW: docs/copy/simple styling/additive tests or similarly contained reversible work.
- MEDIUM: runtime/business logic, APIs, data mappings, storage/creative behavior, external integrations, meaningful dependencies/infrastructure.
- HIGH: ad spend/publishing, Meta mutation, auth/authz, secrets/security boundaries, destructive production operations, production data/assets/storage, billing, or weakened safeguards.

LOW needs normal verification. MEDIUM requires independent review when runtime behavior or an integration boundary changes. HIGH always requires independent review.

When review is required:
- reviewer context must be fresh and independent of the implementer;
- one qualifying review of the final exact HEAD is sufficient unless a second opinion is explicitly justified;
- any subsequent commit, rebase, or base sync that changes HEAD invalidates the prior review;
- live GitHub state, not stale PR-body metadata, is authoritative for current HEAD/base/diff/checks.
- use independent review as a final gate, not as the normal debugging loop; when a review returns multiple material findings, collect them and repair them together where practical before requesting the next fresh exact-HEAD review.

Each PR must keep the fields in `.github/pull_request_template.md` current, including acceptance criteria, verification, risk, required independent-review status, and reusable-learning outcome.

Detailed planning/implementation-cycle/review/handoff rules live in `docs/agent-workflow.md` and should be loaded only for work that needs those rules.

## Model and reasoning routing

Optimize for the lowest expected total cost of a correct, verified result, including retries and rework. Choose model and reasoning effort independently.

Starting points:
- Luna: mechanical/repetitive work, extraction/classification, targeted inspection, very easy tasks, and obvious narrow repairs.
- Terra: normal bounded coding, micro-PRs, straightforward fixes/tests/routine implementation, and known bounded UI/runtime repairs.
- Sol: difficult but bounded planning, debugging, unfamiliar subsystems, complex implementation, substantial review.
- Astra: architecture, cross-phase decisions, difficult root-cause debugging, high-risk review, large-context orchestration, repeated failures, expensive mistakes.

Reasoning: Low for straightforward/local work, Medium for normal implementation/investigation, High for difficult ambiguity/integration/consequential review, Extra-high only when clearly justified.

Before using very high reasoning on a lower-tier model, compare the next model tier at Low/Medium and choose the route with lower expected total cost. If a preferred route is unavailable, use the next-cheapest configuration likely to succeed. Repeated repository-specific evidence may override these defaults.

Do not retry a failed model/reasoning configuration unchanged without new evidence. Escalate only when difficulty, ambiguity, context, risk, or failed verification warrants it.
Do not escalate model tier merely because a reviewer found a defect. Route the repair by the remaining diagnosis/implementation difficulty: known mechanical fixes stay Luna/Terra; Sol/Astra are reserved for genuinely harder reasoning, integration, architecture, or risk.

The coordinating agent owns the concrete Codex route; detailed launch/handoff format lives in `docs/agent-workflow.md`.

## Approvals and durable decisions

Within approved development scope, proceed without repeated approval for reversible branch-local work. Require explicit approval before destructive/irreversible/production-impacting actions, advertising spend/publishing, credentials/secrets changes, production data/assets mutation, or promotion of `staging` to `main`.

Keep canonical docs concise. Prefer regression tests, deterministic guards, reusable helpers, and code/config over adding more agent rules. Record final durable decisions, not raw conversations or routine debugging history.
