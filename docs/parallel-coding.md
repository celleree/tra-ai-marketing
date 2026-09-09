# TRA AI Marketing — Parallel Coding

## Objective

Minimize total time from a coding task to correctly verified integration in `staging`.

Do not maximize agent count. Parallel coding is useful only when the expected time saved is greater than the coordination, merge, and rework cost it creates.

## Operating model

TRA coding normally starts in ChatGPT. ChatGPT decides whether the next work should remain sequential or use an additional Codex session.

Before making that decision, inspect only what is needed:

- `AGENTS.md`;
- this file;
- the task-specific source of truth or directly relevant code/config;
- current `staging` and relevant active branch/PR state when overlap may matter.

Do not scan the whole repository by default.

If an active Codex session has local/unpushed work that GitHub cannot show, ask for this short status first:

```text
Return only:
TASK:
BRANCH:
FILES/AREAS OWNED:
SHARED CONTRACTS BEING CHANGED:
REMAINING:

Then continue your current work.
```

## Parallel decision

Default to **one implementation agent**.

Recommend a second implementation agent only when all of these are true:

1. There are at least two bounded tasks with clear finish lines.
2. Neither task depends on an unresolved shared contract, schema, API, storage pattern, central type, or architecture decision.
3. File/subsystem overlap is low enough to give each agent a clear ownership boundary.
4. Each task can be developed and verified independently on an isolated branch/worktree.
5. Running them concurrently is likely to save meaningful time after coordination and integration cost.

If any of these conditions is materially false, keep the work sequential.

Respect dependencies defined by the task's real source of truth. Do not parallelize downstream implementation across an unresolved upstream decision.

## Parallel execution

When parallel work is justified:

- begin with at most **two concurrent implementation agents**;
- give each agent a dedicated feature branch and isolated worktree/workspace;
- use the same known `staging` base when practical;
- give each agent an explicit ownership area and nearby `DO NOT MODIFY` boundary;
- never run two implementation agents in the same working directory;
- do not let agents independently redesign the same shared contract;
- define the merge order before starting when order matters;
- if a supposedly independent task discovers a shared-contract dependency, stop that workstream and report the dependency instead of inventing a competing design;
- after one branch merges, the remaining branch should sync with updated `staging` when relevant and re-run verification.

Repository workflow, risk, review, and merge rules remain governed by `AGENTS.md`.

Codex surface selection belongs in the current Codex routing guidance; do not duplicate those rules here.

## ChatGPT output

When another coding session is already active, ChatGPT should make the routing decision explicit:

```text
PARALLEL: YES | NO
WHY: [brief reason]

PRIMARY:
- task
- branch/worktree
- ownership area

SECONDARY: [only if YES]
- task
- Codex surface
- branch/worktree
- ownership area
- DO NOT MODIFY

MERGE ORDER:
[order or either order]

CHECKPOINT:
[what to return to ChatGPT when a workstream finishes or blocks]
```

For parallel work, each workstream checkpoint must also report `SHARED CONTRACTS / AREAS AFFECTED` so the coordinator can detect schema/API/storage/central-type overlap before integration. If `PARALLEL: NO`, omit that field and provide the next single Codex task instead.

## Self-improvement

Current mode: **human-approved improvement**.

After a coding cycle, evaluate the routing decision only when there was meaningful avoidable waiting, merge conflict, rework, unnecessary coordination, or a clearly missed opportunity for safe parallelism.

When an improvement is warranted:

1. question whether the rule or requirement is necessary;
2. delete unnecessary rules first;
3. simplify what remains;
4. add a new rule only when deletion or simplification cannot solve the recurring problem;
5. automate only after the behavior has proven reliable.

Do not turn routine one-off friction into permanent policy unless it reveals a high-impact missing invariant.

For now, AI may propose changes to this file but must obtain human approval before changing its orchestration rules.

Autonomous self-improvement is a future mode and remains disabled until explicitly activated by the user. Even after activation, changes that weaken repository safety, review requirements, branch isolation, or production protections still require human approval.

## Scope

This file controls only the decision to use parallel coding and the boundaries between concurrent workstreams.

It does not define product requirements, runtime behavior, architecture, deployment policy, or Codex's general implementation workflow. Those remain authoritative in their existing sources of truth.