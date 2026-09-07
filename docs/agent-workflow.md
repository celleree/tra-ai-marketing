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

## Task handoff

Send only the current checkpoint: `TASK`, minimal `CONTEXT`, exact `SOURCE OF TRUTH`, `SCOPE`, `DO NOT`, `INSTRUCTIONS`, and required `RETURN`. Do not paste broad project history when canonical repo sources already contain it.

## Implementation cycle

1. Inspect the smallest relevant file set and plan the smallest coherent change.
2. For meaningful non-mechanical work, return the plan to the coordinator and resolve material scope/design questions before editing. Trivial mechanical work may combine planning and implementation when no meaningful decision or review boundary exists.
3. Implement only the approved plan.
4. Run focused verification while iterating.
5. Let CI perform the full regression/typecheck/build pass by default.
6. Use one fresh independent review of the final exact HEAD when policy requires it.
7. Repair findings in the implementation session and reverify. Any subsequent commit, rebase, or base sync that changes HEAD invalidates an exact-HEAD review and requires a fresh review when policy requires review.
8. Merge only with current required verification/review.

Keep implementation PRs draft until implementation and focused checks are stable, then mark ready for final review. Keep the fields in `.github/pull_request_template.md` current throughout the PR lifecycle.

## Review freshness and proportionality

Live GitHub state is authoritative for current PR HEAD/base/diff/checks. Historical PR-body metadata is not.

- Reviewer context must be fresh and independent of the implementer.
- Start the reviewer with acceptance criteria, relevant canonical requirements, the final diff or exact reviewed commit, and verification results. The reviewer may inspect additional directly relevant code/config/tests as needed, but should not inherit the implementer's transcript.
- Review requirement alignment, realistic regressions/edge cases, tests, security, data integrity, spend/publishing, compliance, risk classification, and weakened safeguards; return findings/conclusion rather than implementing fixes.
- One qualifying review of final exact HEAD is sufficient unless a second opinion is explicitly justified.
- Any subsequent commit, rebase, or base sync that changes HEAD invalidates the prior exact-HEAD review.
- TRA is currently an internal trusted-user tool. Do not expand bounded work into hostile-client-grade infrastructure solely for hypothetical malicious authorized users, while still protecting realistic auth, secret, destructive-action, production-data, spend/publishing, compliance, and hard-invariant risks.
- Stop once acceptance criteria and material realistic risks are covered; do not generate speculative edge cases merely to exhaust theoretical possibilities.

## Result handoff

Return these concise fields by default:

- `STATUS`
- `TASK`
- `BRANCH`
- `BASE STAGING SHA` when branch ancestry matters
- `HEAD SHA`
- relevant `FILES INSPECTED/CHANGED`
- `IMPLEMENTATION / FINDINGS`
- `VERIFICATION`
- `BLOCKERS`
- `DECISIONS NEEDED`
- `SHARED CONTRACTS / AREAS AFFECTED`
- `RISKS / CONFLICTS`
- `REMAINING`
- `NEXT RECOMMENDED ACTION`
- `PARALLEL-SAFE NEXT WORK`

Use `N/A` where a SHA is not applicable and `NONE` for empty sections. Preserve `BASE STAGING SHA` and `SHARED CONTRACTS / AREAS AFFECTED` because they are important for stale-branch detection, parallel-work coordination, and identifying shared schema/API/storage boundaries.

Do not include raw logs, long diffs, private reasoning, or repeated repository context unless needed to explain a failure.

## Parallel work

Default to one implementation agent. Load `docs/parallel-coding.md` only when parallel execution is being considered. Add another implementation agent only when tasks are bounded, independently verifiable, low-overlap, free of unresolved shared-contract dependencies, and likely to save net time.

For subagents, the root agent retains architecture, sequencing, integration, and final acceptance. Route each delegated task independently instead of automatically inheriting the root model/reasoning. Use the minimum number of subagents that materially improves speed, independence, or quality, and avoid overlapping edits unless explicitly coordinated.

## Long-running root/orchestrator sessions

A long-running root/orchestrator session may own multiple roadmap phases or an end-to-end flow when explicitly asked to do so, but it must still execute through bounded checkpoints and the smallest coherent PRs. Persistent ownership is not permission to collapse planning, implementation, testing, review, fixes, and merge into one giant change.

The root agent should maintain a concise durable checkpoint between phases/PRs containing completed scope, important decisions, verification state, unresolved risks, and the next bounded task. Prefer canonical repo sources and these checkpoints over repeatedly reloading broad chat or repository history.

Each PR must still satisfy the repository's normal verification, risk classification, and fresh independent-review requirements. Use fresh reviewer context where required rather than reusing the root implementer's transcript.

## Durable decisions, learning, and cleanup

Capture final durable conclusions in the narrow canonical source: runtime behavior in code/config; active image direction in `docs/image-workflow.md`; stable boundaries in `docs/architecture.md`; future stage ordering in `docs/roadmap.md`; deployment requirements in `docs/deployment.md`; deferred/current work in GitHub Issues.

Only make a failure/correction/experiment permanent when future reuse justifies it: it escaped merge/deployment, exposed a durable bad assumption, repeated, caused substantial rework because a guard was missing, affected a high-risk invariant, or established a durable implementation choice. Do not memorialize routine syntax/type/build fixes, expected failed experiments, transient service failures, abandoned ideas, or one-off debugging.

Prefer the first feasible durable home: regression test/eval -> deterministic guard/validation -> reusable helper/tool -> code/config -> existing canonical doc -> GitHub Issue only for genuinely deferred/out-of-scope work -> agent instruction only when stronger enforcement is impractical. If the current change fully handles the learning, do not also create an Issue.

Keep canonical docs concise and delete obsolete code/docs rather than leaving tombstones, deprecated copies, changelog-style remnants, or `REMOVED.md` files. Git history is the archive.

Because merges target `staging` rather than default-branch `main`, GitHub close keywords may not auto-close completed Issues. Explicitly close a specific implementation Issue after its work is fully merged to `staging`; do not close umbrella, deferred, or partial Issues.
