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
- Any PR changing `.github/workflows/**`, `.github/pr-reviewability-policy.json`, or safeguard/risk-review rules in `AGENTS.md` is HIGH risk and requires a fresh independent review of the exact current HEAD SHA before merge. Any subsequent commit, rebase, or base sync invalidates that review.

## Current threat model

TRA AI Marketing is currently an internal team tool with a very small set of trusted users. For the current phase, optimize safeguards primarily for accidental misuse, malformed inputs, data integrity, hard product invariants, and preventing costly or irreversible mistakes by trusted operators.

### Trusted-user assumption

For the current phase, treat authorized application users and repository contributors as trusted and non-malicious.

Do **not** design, implement, or review for scenarios where trusted users intentionally exploit loopholes, bypass workflows, craft adversarial inputs, subvert repository/CI rules, or try to break the application or repository.

Assume the private repository is primarily operated through AI coding agents. Do not add architecture, validation, CI complexity, provenance systems, or other defensive infrastructure solely to protect against hypothetical malicious behavior by authorized users.

Still protect against exposed secrets, unauthorized access, authentication/authorization failures, accidental destructive actions, production data loss, unintended publishing or advertising spend, and other realistic failures that could cause meaningful harm.

Optimize safeguards for the actual trusted internal threat model.

Do not automatically expand a bounded feature into hostile-client-grade infrastructure, adversarial multi-tenant controls, immutable provenance systems, or heavyweight security architecture unless the current task genuinely requires it. Prefer the smallest reliable safeguard appropriate to trusted internal use.

This does not remove normal security hygiene or repository risk-review requirements. Auth, secrets, production storage safety, destructive actions, spend/publishing controls, and hard product/compliance invariants still require appropriate safeguards. Reassess and strengthen the threat model before materially broader, external, or untrusted-user access is introduced.

### Review proportionality

For this trusted internal application, review edge cases proportionally to realistic reachability and impact.

- Do not enumerate or block merges on contrived internal states solely because they are theoretically possible.
- Treat internal functions and trusted components as non-adversarial unless the current task explicitly establishes an untrusted or security-sensitive boundary.
- Prioritize edge cases reachable through normal application use, ordinary developer mistakes, expected malformed external input, or realistic tool/infrastructure failures.
- Treat a finding as merge-blocking when it has a plausible path to meaningful correctness failure, data-integrity loss, unauthorized access, secret exposure, destructive production action, production storage damage, unintended publishing/spend, compliance failure, or violation of a hard product invariant.
- If a finding depends on multiple trusted internal components simultaneously violating their contracts in an unrealistic way, classify it as non-blocking or defer it unless there is evidence that the failure is reasonably likely.
- Once acceptance criteria, realistic regressions, and material risks are covered, stop. Do not keep generating speculative edge cases merely to exhaust the theoretical possibility space.

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

## ChatGPT-managed Codex implementation cycle

For bounded implementation work that the user is coordinating between ChatGPT and Codex, default to staged checkpoints instead of one large prompt that plans, implements, tests, reviews, fixes, and merges in one pass.

1. Start a fresh implementation session with investigation/plan only. Do not edit files yet. Inspect the smallest relevant file set, confirm the current contract, propose the smallest coherent implementation, estimate PR size, list tests, and surface unresolved decisions.
2. Return that plan to ChatGPT for review before implementation. Resolve scope, architecture, sequencing, and PR-size concerns while changes are still cheap.
3. Continue the same implementation session to implement only the approved plan, run focused verification first, then complete the required branch/PR verification.
4. Use a fresh independent review session for the exact PR and current HEAD SHA when review is required. The reviewer must not inherit the implementer's transcript and should return findings rather than implement fixes.
5. Send review findings back to the original implementation session for correction. Keep fixes inside the approved scope unless a new design decision is explicitly reviewed.
6. Re-run verification after fixes. If the reviewed HEAD changes materially, perform a fresh-context review of the new exact SHA before merge when required.
7. Merge only after required verification and review are complete and material findings are resolved.

Keep prompts bounded to the current checkpoint. Do not ask one Codex prompt to perform the entire lifecycle when a planning or review checkpoint could catch scope or design errors first.

Simple low-risk mechanical changes may combine planning and implementation when there is no meaningful design decision, review boundary, or benefit from a separate checkpoint.

## Sources of truth

When sources disagree, use this order for the current image-workflow work:

1. Runtime code and tests define what is actually implemented now.
2. `docs/image-workflow.md` defines the active Stage 1 image-product direction and intended architecture.
3. GitHub Issues define task-specific implementation work and acceptance criteria underneath that direction. An Issue overrides `docs/image-workflow.md` only when it explicitly records a newer product decision and states what it supersedes.
4. `docs/architecture.md` defines stable system boundaries and future-stage architecture; it does not override the active Stage 1 image workflow.
5. `docs/roadmap.md` defines long-term/future product direction and ordering; it does not override the active Stage 1 image workflow.

Additional source roles:

- Environment-variable names and examples: `.env.example`.
- External deployment/setup requirements: `docs/deployment.md`.
- Customer research summary: `knowledge/customer-insights.md`.

Do not restore older Stage 1 architecture merely because it appears in stale Issues, PR descriptions, roadmap text, architecture text, or historical planning. If documentation conflicts with executable code/config about implemented behavior, code/config is authoritative.

## Current project direction

Follow `docs/image-workflow.md` for active Stage 1 image-workflow product direction and implementation order. Runtime code and tests remain authoritative for what is actually implemented; do not assume a target architecture is already wired until code/tests show it.

The active Stage 1 target creative path is:

`User/Kinetiq inputs -> GPT-6 Astra (medium reasoning) creative planning/prompting -> GPT Image 2 generation -> user review/select -> save to TRA Creatives`

Claude is deferred from the active image-generation path. Do not validate, implement, or restore the historical `Claude -> GPT-5.6 Sol -> GPT Image 2` chain as current Stage 1 behavior unless `docs/image-workflow.md` or an explicit newer product-decision Issue reactivates it and states what it supersedes.

Keep implementation focused on the Stage 1 creative system. Do not expand into autonomous media buying, winner prediction, custom ML training, budget optimization, automatic pause/scale logic, performance dashboards, or autonomous publishing unless explicitly reactivated.

Current-phase goal: turn references plus approved TRA knowledge into high-quality, compliant, meaningfully different static creatives that are saved with persistent identity and structured metadata. The active workflow should preserve approved source roles and human provenance, complete company/brand grounding, meaningful dimensional variation, placement-aware generation, deterministic compliance safeguards, and enough metadata to support later performance/revenue attribution.

Once the required access exists, add the performance system in this order: verified Meta + TRA revenue attribution -> Claude read-only analysis/recommendations -> supervised execution -> bounded automation. The long-term agent objective is an ongoing acquisition system that maximizes verified attributable revenue within hard spending, compliance, and experimentation constraints; intermediate metrics are diagnostic signals, not the objective.

Preserve these future-stage rules even while Stage 1 remains the only active implementation focus:

- no artificial campaign end date; optimize as an ongoing acquisition system;
- require `SO WHAT?` reasoning so creative messages connect to meaningful customer outcomes;
- maximize verified attributable revenue over the long term, with spend/efficiency/compliance rules as constraints;
- keep intermediate metrics diagnostic rather than letting them silently replace the revenue objective;
- balance exploitation of winners with continued exploration of substantially different concepts;
- for future performance/autonomy stages only, preserve the documented Claude strategist/orchestrator and GPT-5.6 Sol creative-director/visual-QA roles unless future architecture explicitly changes them; these are not the active Stage 1 image-generation path;
- keep financial, attribution, compliance, and execution safety rules in deterministic code outside the LLM;
- verify/normalize metrics before Claude reasons from them;
- preserve persistent creative IDs, structured metadata, and reusable learnings so future revenue can be tied back to exact hypotheses and creatives;
- ground taste in references, brand context, and accumulated heuristics rather than assuming the base model has the right aesthetic by default.

Detailed active Stage 1 image-workflow direction belongs in `docs/image-workflow.md`; long-term/future stage ordering belongs in `docs/roadmap.md`; stable system boundaries and future-stage architecture belong in `docs/architecture.md`.

## Decision capture

When a chat or AI session establishes a durable project decision, constraint, architecture choice, external requirement, or important rationale that is not already represented in the canonical source of truth, update the appropriate canonical source.

- Record the final decision and only the rationale needed to understand it later; do not preserve raw conversation transcripts or step-by-step reasoning.
- Runtime behavior or implementation decisions -> code/config.
- Active Stage 1 image-product direction or implementation order -> `docs/image-workflow.md`.
- Long-term/future product stage or ordering changes -> `docs/roadmap.md`.
- Stable system-boundary or future-stage architecture changes -> `docs/architecture.md`.
- Deployment or external platform requirements -> `docs/deployment.md`.
- Current/deferred implementation work -> GitHub Issue, subordinate to the active workflow unless the Issue explicitly records a newer product decision and states what it supersedes.
- Temporary brainstorming, abandoned ideas, and routine debugging stay in chat/Git history unless they produce a durable decision.
- When experiments establish a durable choice, document what was chosen and why, not the full sequence of failed approaches.

## Context limits

- Do not recursively load the repository, `/docs`, Git history, old PRs, or external source material by default.
- Start with `AGENTS.md`, the task-relevant code/config, and only the specific supporting document needed. For active Stage 1 image work, load `docs/image-workflow.md` before older roadmap/architecture planning.
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

## Model, reasoning, and subagent routing

Optimize for the lowest expected total cost of reaching a correct, verified result, including retries, escalation, rework, and the cost of mistakes.

Choose **model capability and reasoning effort independently**:

1. Use the cheapest model with sufficient capability for the task.
2. Use the lowest reasoning effort likely to complete it correctly.
3. Escalate model tier or reasoning only when task difficulty, ambiguity, context, risk, or failed verification justifies it.

Do not assume more reasoning on a weaker model is better than a stronger model at lower reasoning. Before using very high reasoning on a lower-tier model, consider whether the next model tier at low or medium reasoning is more likely to succeed at lower total cost.

Model starting points:
- **Luna:** mechanical, repetitive, extraction/classification, targeted inspection, very easy work.
- **Terra:** normal bounded coding, micro-PRs, tests, straightforward fixes, routine implementation.
- **Sol:** difficult but bounded reasoning, unfamiliar subsystems, debugging, complex implementation, planning, substantial review.
- **Astra:** architecture, cross-phase decisions, difficult root-cause debugging, high-risk review, large-context or long-running orchestration, repeated failures, expensive mistakes.

Reasoning starting points:
- **Low:** straightforward, local, well-specified, easily verified.
- **Medium:** normal implementation, testing, investigation, bounded decisions.
- **High:** difficult debugging, ambiguity, complex integration, consequential review.
- **Extra-high / maximum:** exceptional cases where high is insufficient or failure is unusually costly.

Do not repeatedly retry a failed configuration unchanged. Escalate when verification fails, complexity materially exceeds expectations, required capability/context exceeds the current route, or the same approach has already failed.

For subagents, the root agent retains architecture, sequencing, integration, and final acceptance. Route each delegated task independently instead of automatically inheriting the root model/reasoning. Use the minimum number of subagents that materially improves speed, independence, or quality, and avoid overlapping edits unless explicitly coordinated.

If a preferred model is unavailable, use the next-cheapest available configuration likely to succeed.

Treat these routes as defaults. When repeated repository-specific evidence shows another model/reasoning combination reaches verified completion more cheaply or reliably for a task class, prefer the observed route. Do not add routing infrastructure or logging solely for hypothetical optimization.

## Autonomous execution and approvals

Within an explicitly approved development scope, proceed without requesting approval for reversible development actions such as reading files, editing the feature branch, running focused tests/checks, creating commits/checkpoints, updating the PR, and repairing findings inside the approved scope.

Require explicit approval before actions that are destructive, irreversible, production-impacting, externally consequential, affect advertising spend/publishing, expose/change credentials or secrets, mutate production data/assets, or otherwise cross a HIGH-risk execution boundary.

Autonomous execution does not waive repository safeguards: required verification and independent review still apply, and `staging` must never be promoted to `main` without explicit production approval.

## Long-running root/orchestrator sessions

A long-running root/orchestrator session may own multiple roadmap phases or an end-to-end flow when explicitly asked to do so, but it must still execute through bounded checkpoints and the smallest coherent PRs. Persistent ownership is not permission to collapse planning, implementation, testing, review, fixes, and merge into one giant change.

The root agent should maintain a concise durable checkpoint between phases/PRs containing completed scope, important decisions, verification state, unresolved risks, and the next bounded task. Prefer canonical repo sources and these checkpoints over repeatedly reloading broad chat or repository history.

Each PR must still satisfy the repository's normal verification, risk classification, and fresh independent-review requirements. Use fresh reviewer context where required rather than reusing the root implementer's transcript.