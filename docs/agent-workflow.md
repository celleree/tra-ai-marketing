# Agent Workflow Details

Load this file only for planning, review, merge, routing, handoff, or multi-agent coordination work.

## Coordinator-owned Codex routing

ChatGPT/the coordinator resolves and displays this outside the copyable Codex prompt:

```text
WHERE: Terminal / CLI | Desktop | VS Code
SESSION: NEW | CONTINUE — <name>
MODEL: Luna | Terra | Sol | Astra
REASONING: Low | Medium | High | Extra-high
PARALLEL: YES | NO — <reason>
```

Every value must be concrete. Codex should execute the selected route but not echo this launch block unless asked.

## Coordinator-first execution boundary

Before launching Codex, ask whether the task actually requires a local checkout, local source edits, local tests/builds, or runtime interaction.

Prefer ChatGPT/the coordinator with connected tools for work those tools can complete safely, including:
- live GitHub state, SHA, PR, check, CI/log, diff, and file inspection;
- PR metadata/workflow-state updates and merge execution;
- planning, routing, diagnosis, handoff preparation, and read-only review support;
- supported narrow repository/documentation changes that do not require local execution.

For any coordinator repository write, explicitly target the intended dedicated feature branch and keep the normal PR/review workflow. Never rely on the repository default branch for a write, and never write directly to `staging` or `main` unless an existing rule explicitly authorizes it.

Use Codex/local agents when the work requires repository edits or execution that connected coordinator tools cannot safely perform, or when local tests/builds/runtime behavior are part of completion. Do not spend Codex credits merely to repeat repository administration or read-only inspection the coordinator can already do.

## Task handoff

Keep copyable handoffs compact and task-local. The coordinator-owned routing block stays outside the prompt.

Default handoff shape:

```text
PROJECT / REPO: <only when needed>
ACTIVE: <task, PR/branch, and exact relevant SHA(s)>
STATUS: <current state>
NEXT: <one bounded next action>
VERIFY FIRST: <live-state checks required before acting>
CONSTRAINTS: <only task-critical do/do-not rules>
```

Add acceptance criteria or source references only when the next chat cannot reliably derive them from the repo. Prefer a file, Issue, PR, or exact commit reference over copying its contents.

Do not repeat permanent workflow rules, model-routing guidance, roadmap history, completed phases, broad architecture, or repository conventions already stored in `AGENTS.md` or canonical docs. Do not carry long implementation summaries when the live PR/diff is the source of truth. If a fact can be safely re-derived from live repository state, omit it unless carrying it forward prevents stale or unsafe work.

Default target: about 200-400 words or less. Use one short source-of-truth reminder when useful: `Follow AGENTS.md and task-relevant canonical docs. Live GitHub state is authoritative.`

## Implementation cycle

1. Inspect the smallest relevant file set and choose the smallest coherent change.
2. If the task is already bounded and the implementation direction is clear, plan and implement in the same session. Use a separate mapping/plan-only pass only when architecture, scope, sequencing, or a consequential decision is materially uncertain.
3. Implement the bounded change and run focused verification while iterating.
4. Before handoff, perform a proportional implementer completion audit: reread the acceptance criteria, inspect the complete diff, check realistic edge cases/state transitions, and run the targeted tests needed to catch ordinary implementation mistakes. Repair findings before handoff. This audit is not independent review and should be lightweight for mechanical changes.
5. Keep the PR draft while implementation/audit is unstable. Once stable, move it into its intended final review state before the final check/review cycle so a later draft-to-ready transition does not create avoidable duplicate CI after review.
6. Let CI perform the full regression/typecheck/build pass by default. Do not request required independent review while exact-HEAD CI is failing or still pending.
7. After exact-HEAD CI is green, use one fresh independent review of the final exact HEAD when policy requires it.
8. If review returns findings, collect all material findings first and repair them in one coherent pass where practical. Then rerun the implementer completion audit and CI before requesting one fresh exact-HEAD review. Any commit, rebase, or base sync that changes HEAD invalidates the prior exact-HEAD review.
9. Merge only with current required verification/review.

Keep the fields in `.github/pull_request_template.md` current throughout the PR lifecycle.

## Review freshness and proportionality

Live GitHub state is authoritative for current PR HEAD/base/diff/checks. Historical PR-body metadata is not.

- Independent review is a final quality gate, not the normal implementation/debugging loop. Request it only after the implementer completion audit and green exact-HEAD CI.
- Independence is about fresh reviewer context, not a specific execution product. A fresh ChatGPT/coordinator review session with live GitHub access can satisfy the independent-review gate when it can inspect the exact HEAD/base/diff, relevant source/tests, and required verification; do not spend Codex credits solely to create reviewer independence.
- Reviewer context must be fresh and independent of the implementer.
- Give the reviewer acceptance criteria, relevant canonical requirements, final diff or exact reviewed commit, and verification results.
- Review requirement alignment, realistic regressions/edge cases, tests, security, data integrity, spend/publishing, compliance, risk classification, and weakened safeguards; return findings/conclusion rather than implementing fixes.
- One qualifying review of final exact HEAD is sufficient unless a second opinion is explicitly justified.
- Any subsequent commit, rebase, or base sync that changes HEAD invalidates the prior exact-HEAD review.
- TRA is currently an internal trusted-user tool. Do not expand bounded work into hostile-client-grade infrastructure solely for hypothetical malicious authorized users; still protect realistic auth, secret, destructive-action, production-data, spend/publishing, compliance, and hard-invariant risks.

## Result handoff

Return only what the next chat needs to continue safely:

- `STATUS`
- `ACTIVE` — task plus PR/branch and exact relevant SHA(s)
- `COMPLETED / FINDINGS` — brief
- `VERIFICATION`
- `BLOCKERS` — only when present
- `NEXT`

Add changed files, decisions, risks/conflicts, remaining work, or parallel-safe work only when materially relevant. Do not emit empty sections just to satisfy a template.

Do not include raw logs, long diffs, private reasoning, repeated repository context, old completed work, or routing metadata that belongs outside the handoff.

## Parallel work

Default to one implementation agent. Load `docs/parallel-coding.md` only when parallel execution is being considered. Add another implementation agent only when tasks are bounded, independently verifiable, low-overlap, free of unresolved shared-contract dependencies, and likely to save net time.

For subagents, the root agent retains architecture, sequencing, integration, and final acceptance. Route each delegated task independently instead of automatically inheriting the root model/reasoning. Use the minimum number of subagents that materially improves speed, independence, or quality, and avoid overlapping edits unless explicitly coordinated.

## Long-running root/orchestrator sessions

A long-running root/orchestrator session may own multiple roadmap phases or an end-to-end flow when explicitly asked to do so, but it must still execute through bounded checkpoints and the smallest coherent PRs. Persistent ownership is not permission to collapse planning, implementation, testing, review, fixes, and merge into one giant change.

The root agent should maintain a concise durable checkpoint between phases/PRs containing completed scope, important decisions, verification state, unresolved risks, and the next bounded task. Prefer canonical repo sources and these checkpoints over repeatedly reloading broad chat or repository history.

### Roadmap orchestration

When Astra is coordinating the Stage 1 image roadmap:

1. Inspect current `staging` and the relevant code/tests.
2. Classify each roadmap item as COMPLETE, PARTIAL, NOT STARTED, or BLOCKED.
3. Convert only confirmed remaining work into the smallest coherent PRs.
4. Keep architecture, sequencing, and integration ownership at the root-agent level.
5. Delegate bounded implementation, review, or testing work only where responsibilities are independently verifiable.
6. Parallelize only tasks with low overlap and no unresolved shared-contract dependency.
7. Reassess roadmap status after each merged PR before delegating the next work.

Each PR must still satisfy the repository's normal verification, risk classification, and fresh independent-review requirements. Use fresh reviewer context where required rather than reusing the root implementer's transcript.

## Durable decisions and learning

Capture final durable conclusions in the narrow canonical source: runtime behavior in code/config; active image direction in `docs/image-workflow.md`; stable boundaries in `docs/architecture.md`; future stage ordering in `docs/roadmap.md`; deployment requirements in `docs/deployment.md`; deferred/current work in GitHub Issues.

Persist a failure/correction/experiment only when it is recurring, high-impact, establishes a durable invariant/decision, or reveals a missing guard that caused meaningful rework. Do not persist routine debugging or one-off failures.

Because merges target `staging` rather than default-branch `main`, GitHub close keywords may not auto-close completed Issues. Explicitly close a specific implementation Issue after its work is fully merged to `staging`; do not close umbrella, deferred, or partial Issues.
