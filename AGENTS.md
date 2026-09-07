# TRA AI Marketing Agent Rules

Keep normal AI/Codex context small. Read only what the current task requires.

## Core workflow

- `main` = current production.
- `staging` = combined future version and normal development base.
- Normal app/code work starts from latest `staging` on a dedicated feature branch.
- Do not build multi-file app changes directly on `staging` or `main`.
- Merge completed feature work into `staging`; promote `staging` to `main` only with explicit production approval.
- Preserve intended work from parallel branches when resolving conflicts; do not silently overwrite another agent's work.

## Current product scope

The active build is the Stage 1 static-image creative system. For current implementation behavior and ordering, use `docs/image-workflow.md` before the long-term roadmap.

Do not expand into autonomous media buying, winner prediction, budget optimization, automatic pause/scale logic, performance dashboards, or unrestricted Meta execution unless explicitly reactivated.

## Source-of-truth precedence

Use the narrowest current source that actually governs the task:

1. Current GitHub Issue/task acceptance criteria.
2. Runtime source code/config for actual behavior.
3. `docs/image-workflow.md` for the active image-generation workflow and current implementation order.
4. `docs/architecture.md` for stable system boundaries.
5. `docs/roadmap.md` for stage ordering and future direction.
6. `docs/deployment.md` for external deployment/setup requirements.
7. `.env.example` for environment-variable names/examples.

If documentation conflicts with executable code/config, code/config is authoritative for current runtime behavior. Correct stale documentation when the conflict represents a durable project-state change.

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

## Risk and review

- LOW: docs/copy/simple styling/additive tests or similarly contained reversible work.
- MEDIUM: runtime/business logic, APIs, data mappings, storage/creative behavior, external integrations, meaningful dependencies/infrastructure.
- HIGH: ad spend/publishing, Meta mutation, auth/authz, secrets/security boundaries, destructive production operations, production data/assets/storage, billing, or weakened safeguards.

LOW needs normal verification. MEDIUM requires independent review when runtime behavior or an integration boundary changes. HIGH always requires independent review.

When review is required:
- reviewer context must be fresh and independent of the implementer;
- one qualifying review of the final exact HEAD is sufficient unless a second opinion is explicitly justified;
- any subsequent commit, rebase, or base sync that changes HEAD invalidates the prior review;
- live GitHub state, not stale PR-body metadata, is authoritative for current HEAD/base/diff/checks.

Each PR must keep the fields in `.github/pull_request_template.md` current, including acceptance criteria, verification, risk, required independent-review status, and reusable-learning outcome.

Detailed planning/implementation-cycle/review/handoff rules live in `docs/agent-workflow.md` and should be loaded only for work that needs those rules.

## Model and reasoning routing

Optimize for the lowest expected total cost of a correct, verified result, including retries and rework. Choose model and reasoning effort independently.

Starting points:
- Luna: mechanical/repetitive work, extraction/classification, targeted inspection, very easy tasks.
- Terra: normal bounded coding, micro-PRs, straightforward fixes/tests/routine implementation.
- Sol: difficult but bounded planning, debugging, unfamiliar subsystems, complex implementation, substantial review.
- Astra: architecture, cross-phase decisions, difficult root-cause debugging, high-risk review, large-context orchestration, repeated failures, expensive mistakes.

Reasoning: Low for straightforward/local work, Medium for normal implementation/investigation, High for difficult ambiguity/integration/consequential review, Extra-high only when clearly justified.

Before using very high reasoning on a lower-tier model, compare the next model tier at Low/Medium and choose the route with lower expected total cost. If a preferred route is unavailable, use the next-cheapest configuration likely to succeed. Repeated repository-specific evidence may override these defaults.

Do not retry a failed model/reasoning configuration unchanged without new evidence. Escalate only when difficulty, ambiguity, context, risk, or failed verification warrants it.

The coordinating agent owns the concrete Codex route; detailed launch/handoff format lives in `docs/agent-workflow.md`.

## Approvals and durable decisions

Within approved development scope, proceed without repeated approval for reversible branch-local work. Require explicit approval before destructive/irreversible/production-impacting actions, advertising spend/publishing, credentials/secrets changes, production data/assets mutation, or promotion of `staging` to `main`.

Keep canonical docs concise. Prefer regression tests, deterministic guards, reusable helpers, and code/config over adding more agent rules. Record final durable decisions, not raw conversations or routine debugging history.
