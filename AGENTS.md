# TRA AI Marketing Agent Rules

Keep normal AI/Codex context small. Read only the files needed for the task.

## Workflow

- `main` is production. `staging` is the combined future version.
- Start normal app work from the latest `staging` on a dedicated feature branch.
- Verify the completed branch before merging it into `staging`; do not build multi-file app changes directly on `staging` or `main`.
- Preserve intended work from parallel branches when resolving conflicts.
- Promote `staging` to `main` only when explicitly approved for production.

## PR reviewability — REQUIRED

PRs must be the smallest coherent, self-contained change.

Canonical thresholds live in `.github/pr-reviewability-policy.json`.

- Preferred target: <=200 substantive changed lines when practical.
- Normal soft ceiling: <=400 substantive changed lines.
- Also split-or-justify when more than 10 substantive files are touched.
- High-risk changes should prefer <=200 substantive changed lines.
- If a planned PR is likely to exceed a threshold, attempt to split it before implementation. Use stacked PRs when dependencies require ordered changes.
- If splitting would reduce correctness, coherence, or leave an invalid intermediate state, keep the PR together and provide `LARGE PR JUSTIFICATION` plus `REVIEW ORDER`.
- Do not treat generated files, lockfiles, snapshots, mechanical formatting, bulk renames/moves, or similar mechanical changes as substantive review work. Handwritten tests that require reasoning are substantive.
- AI generation speed is never justification for a larger PR.
- Parallel agents should preferably own separate coherent PRs or non-overlapping portions of a planned stack.

## Current threat model

TRA AI Marketing is currently an internal team tool with a very small set of trusted users. For the current phase, optimize safeguards primarily for accidental misuse, malformed inputs, data integrity, hard product invariants, and preventing costly or irreversible mistakes by trusted operators.

Do not automatically expand a bounded feature into hostile-client-grade infrastructure, adversarial multi-tenant controls, immutable provenance systems, or heavyweight security architecture unless the current task genuinely requires it. Prefer the smallest reliable safeguard appropriate to trusted internal use.

This does not remove normal security hygiene or repository risk-review requirements. Auth, secrets, production storage safety, destructive actions, spend/publishing controls, and hard product/compliance invariants still require appropriate safeguards. Reassess and strengthen the threat model before materially broader, external, or untrusted-user access is introduced.

## Codex execution routing

Before substantial Codex implementation, debugging, review, or repository work, determine and state the execution route using this compact block:

```text
WHERE: <VS Code sidebar | Terminal / CLI | Desktop app>
SESSION: <CONTINUE | NEW — short name>
MODEL: <current suitable Codex model>
REASONING: <lowest sufficient level>
PARALLEL: <YES | NO — short reason/ownership>
```

These fields are task-specific decisions, not fixed defaults. Example values from previous tasks must never be copied mechanically.

- Prefer the cheapest suitable Codex model. Use lower-cost models such as Terra or Luna when capable; escalate only when task complexity, uncertainty, or repeated failure justifies it.
- Use the lowest sufficient reasoning level and increase it only when needed.
- Prefer parallel work when tasks can be isolated safely. Assign non-overlapping files/contracts/worktrees/agents and define merge/review ownership before starting.
- Use `CONTINUE` only when the current session has relevant, clean context and continuity is useful.
- Use `NEW` for a distinct phase/workstream, when the current session is long/noisy or anchored to failed approaches, or when fresh context is likely to improve implementation quality.
- Independent review always uses a fresh chat/session that did not implement the change. Do not pass the implementer's transcript; pass acceptance criteria, canonical requirements, branch/HEAD SHA or final diff, and verification results.
- For material remediation after review, prefer a fresh implementation/remediation chat when the original implementation thread is already long or biased by prior attempts.
- New chats recover state from repo truth: `AGENTS.md`, the task-relevant Issue/PR, exact branch/SHA/checkpoint, and directly relevant code/docs — not conversation transcripts.
- Do not create fresh chats or parallel agents for trivial work when coordination cost exceeds the benefit.

## ChatGPT <-> Codex handoff protocol

When the user is manually relaying work between ChatGPT and Codex, optimize for direct structured handoff rather than explanatory prose.

Incoming ChatGPT instructions may use this structure:

- `TASK`: the concrete next task.
- `CONTEXT`: only context not already available in canonical repo sources.
- `SOURCE OF TRUTH`: exact files, Issue, code, or config to trust.
- `SCOPE`: what may change.
- `DO NOT`: explicit exclusions.
- `INSTRUCTIONS`: the requested next actions.
- `RETURN`: the required response fields.

For plans, implementation results, reviews, investigations, or blockers, Codex should always return this compact, copy/paste-ready handoff by default, without requiring the user to request the format. Use `N/A` for a SHA when no changes were made and `NONE` where indicated:

STATUS:
COMPLETE | PARTIAL | BLOCKED | INVESTIGATION COMPLETE | APPROVAL NEEDED

TASK:
[one sentence]

BRANCH:
[current branch]

BASE STAGING SHA:
[staging SHA this work started from, when relevant]

HEAD SHA:
[current/final SHA, or N/A if no changes]

FILES INSPECTED/CHANGED:

- only materially relevant files
- or NONE

IMPLEMENTATION / FINDINGS:

- concise findings or changes
- no play-by-play reasoning

VERIFICATION:

- exact check: PASS | FAIL | NOT RUN

BLOCKERS:

- exact blocker
- or NONE

DECISIONS NEEDED:

- exact unresolved decision
- or NONE

SHARED CONTRACTS / AREAS AFFECTED:

- shared schema/API/storage/central files
- or NONE

RISKS / CONFLICTS:

- relevant merge or regression risk
- or NONE

REMAINING:

- unfinished work
- or NONE

NEXT RECOMMENDED ACTION:
[one concrete next step]

PARALLEL-SAFE NEXT WORK:
YES | NO
Reason: [one sentence]

Final handoffs should be concise and directly pasteable into ChatGPT. Do not include raw command logs unless needed to explain a failure, long diffs unless specifically requested, chain-of-thought, or play-by-play reasoning. Do not repeat repository context already available in canonical sources. If approval is required for a command or write, ask concisely and include the exact command/action being requested.

## Sources of truth

- Runtime behavior, prompts, categories, formats, validation, defaults, and integration logic: source code.
- Environment-variable names and examples: `.env.example`.
- Staged product roadmap and ordering: `docs/roadmap.md`.
- Stable system boundaries: `docs/architecture.md`.
- External deployment/setup requirements: `docs/deployment.md`.
- Customer research summary: `knowledge/customer-insights.md`.
- Current implementation work and acceptance criteria: GitHub Issues.

If documentation conflicts with executable code/config, treat code/config as authoritative and correct or delete the stale documentation.

## Current project direction

Follow `docs/roadmap.md` for stage ordering. Until TRA provides the required performance/revenue data, advertising-account access, and Claude/API access, keep implementation focused on the Stage 1 creative system. Do not expand into autonomous media buying, winner prediction, custom ML training, budget optimization, automatic pause/scale logic, or performance dashboards unless explicitly requested.

Current-phase goal: turn references plus approved TRA knowledge into high-quality, compliant, meaningfully different static creatives that are saved with persistent identity and structured metadata. The creative pipeline should support reference/brand context, creative strategy including a `SO WHAT?` outcome chain, dimensional variation, placement-aware image generation, quality/compliance checks, and storage of enough metadata to join future performance and revenue back to the exact creative.

Before paying for or wiring the final multi-model API chain, validate the intended Claude -> GPT-5.6 Sol -> GPT Image 2 workflow manually in the Claude and ChatGPT web apps where practical. Treat these web-app tests as prototype/behavior discovery for the future API architecture, capture durable conclusions only, and revalidate the behavior when it is later implemented through APIs. Do not spend personal API money merely to prove behavior that can be tested manually in the web apps.

Once the required access exists, add the performance system in this order: verified Meta + TRA revenue attribution -> Claude read-only analysis/recommendations -> supervised execution -> bounded automation. The long-term agent objective is an ongoing acquisition system that maximizes verified attributable revenue within hard spending, compliance, and experimentation constraints; intermediate metrics are diagnostic signals, not the objective.

Preserve these future-stage rules even while Stage 1 remains the only active implementation focus:

- no artificial campaign end date; optimize as an ongoing acquisition system;
- require `SO WHAT?` reasoning so creative messages connect to meaningful customer outcomes;
- maximize verified attributable revenue over the long term, with spend/efficiency/compliance rules as constraints;
- keep intermediate metrics diagnostic rather than letting them silently replace the revenue objective;
- balance exploitation of winners with continued exploration of substantially different concepts;
- use Claude as advertising strategist/orchestrator, GPT-5.6 Sol as creative director/visual QA, and GPT Image 2 as the image-generation engine;
- keep financial, attribution, compliance, and execution safety rules in deterministic code outside the LLM;
- verify/normalize metrics before Claude reasons from them;
- preserve persistent creative IDs, structured metadata, and reusable learnings so future revenue can be tied back to exact hypotheses and creatives;
- ground taste in references, brand context, and accumulated heuristics rather than assuming the base model has the right aesthetic by default.

Detailed stage ordering belongs in `docs/roadmap.md`; stable future-stage boundaries belong in `docs/architecture.md`.

## Decision capture

When a chat or AI session establishes a durable project decision, constraint, architecture choice, external requirement, or important rationale that is not already represented in the canonical source of truth, update the appropriate canonical source.

- Record the final decision and only the rationale needed to understand it later; do not preserve raw conversation transcripts or step-by-step reasoning.
- Runtime behavior or implementation decisions -> code/config.
- Product stage/order changes -> `docs/roadmap.md`.
- Architecture changes or stable system boundaries -> `docs/architecture.md`.
- Deployment or external platform requirements -> `docs/deployment.md`.
- Current/deferred implementation work -> GitHub Issue.
- Temporary brainstorming, abandoned ideas, and routine debugging stay in chat/Git history unless they produce a durable decision.
- When experiments establish a durable choice, document what was chosen and why, not the full sequence of failed approaches.

## Context limits

- Do not recursively load the repository, `/docs`, Git history, old PRs, or external source material by default.
- Start with `AGENTS.md`, the task-relevant code/config, and only the specific supporting document needed.
- Prefer summaries over raw source data. Retrieve raw evidence only when exact verification is required.

## Documentation and deletion

- Document only stable architecture, staged product direction, required external setup, or rules that materially help future work.
- Do not duplicate implementation details that are already clear in code/config.
- Delete obsolete code and docs instead of leaving tombstones, deprecated copies, changelogs, or `REMOVED.md` files.
- Use descriptive commits/PRs for meaningful removal history; Git history is the archive.
- Small documentation-only changes may be made directly when safe; app/code changes follow the feature-branch workflow above.

## Learning and risk review

Evaluate a meaningful failure, correction, or experiment for permanent capture only when future reuse justifies it: it escaped merge/deployment, exposed a durable incorrect assumption, repeated, caused substantial rework because a guard was missing, affected a high-risk invariant, or established a durable implementation choice. Do not capture routine syntax/type/build fixes, expected failed experiments, transient service failures, abandoned ideas, one-off debugging, or failures already covered by an adequate invariant unless they expose a deeper missing guard.

Prefer the first feasible learning destination: regression test/eval; programmatic validation/guard; reusable helper/tool; code/config; existing canonical roadmap/architecture/deployment documentation when the learning is genuinely a stable requirement or system boundary; GitHub Issue only when resulting work is deferred, out of scope, or future work; or a concise agent instruction only when mechanical or canonical enforcement is impractical. If the current change fully handles the learning, do not also create an Issue. Follow Decision capture above and preserve only the final conclusion and essential rationale, never chats, chain-of-thought, raw reviewer reasoning, or a failure journal. Reusable reviewer findings use the same triage.

Classify each PR at its highest applicable risk:

- LOW: documentation/copy, simple styling, additive tests that do not change runtime behavior or weaken safeguards, or similarly contained/reversible work.
- MEDIUM: runtime/business logic, API behavior, data mappings or attribution, storage or creative behavior, non-severe external integration behavior, or meaningful dependency/infrastructure changes.
- HIGH: advertising spend or publishing state; Meta campaign/ad-set/ad creation or mutation; auth/authz; secret or security-boundary handling; destructive production operations; deletion or mutation of persistent customer/company data or production assets; production storage safety; billing/payment; weakening or removing CI, tests, security controls, or repository workflow/risk-review safeguards; or similarly consequential behavior.

Ordinary deletion of obsolete docs, tests, or unused source is classified by its actual effect. Editing `AGENTS.md` is not inherently HIGH; weakening or removing a repository workflow or risk-review safeguard is. If uncertain, choose the higher risk.

LOW needs normal verification. MEDIUM requires independent review before merge when runtime behavior or an integration boundary changes; otherwise state briefly why it is not required. HIGH always requires independent review before merge and is incomplete while review is pending or material findings remain.

Each PR records acceptance criteria, verification results, risk level and reason, independent-review status when applicable, and the reusable-learning outcome; `.github/pull_request_template.md` is the default mechanism.

A reviewer may be human or AI, but must use a fresh context that did not implement the change. Start the reviewer with the acceptance criteria, relevant canonical requirements, final diff or reviewed commit, and verification results. The reviewer may inspect additional directly relevant code, config, or tests when necessary to verify the change, but should not inherit the implementer's transcript or unrelated context. The reviewer checks requirement alignment, regressions, missing edge cases or tests, safety/security, risk classification, and weakened safeguards, then returns findings/conclusion rather than implementation or private reasoning. Resolve findings, reverify, and re-review materially changed fixes.
