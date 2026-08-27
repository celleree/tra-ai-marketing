# TRA AI Marketing — Parallel Coding Orchestration

## Purpose

This file is the shared guide for deciding when TRA AI Marketing work should stay in one Codex session and when a second or additional isolated coding session is worth using.

It is designed to be used in two places:

- as a source file in the TRA AI Marketing ChatGPT Project; and
- as `docs/parallel-coding.md` in the GitHub repository.

The normal workflow starts in ChatGPT. ChatGPT acts as the coding-session orchestrator: it reads the relevant project source, checks the repository state when needed, identifies the next bounded work unit, and tells the user whether to continue sequentially or launch parallel Codex work.

Parallelism is optional. Do not recommend it merely because Codex supports multiple agents.

---

# Default Behavior

Default to **one active implementation agent**.

Recommend parallel coding only when it creates a real time advantage without introducing significant coordination, merge, or architecture risk.

For TRA AI Marketing, begin with at most **two concurrent implementation agents** unless the work has already proven to be cleanly separable and the user explicitly wants more.

---

# ChatGPT Preflight for Coding Work

When the user starts a coding task in ChatGPT, ChatGPT should perform the smallest useful preflight before producing a Codex prompt.

Read or inspect, as relevant:

1. `AGENTS.md` on the current `staging` branch.
2. This file: `docs/parallel-coding.md`.
3. The task-specific source of truth, such as `docs/image-workflow.md`, `docs/roadmap.md`, `docs/architecture.md`, a GitHub Issue, or the directly relevant code/config.
4. Current `staging` state and relevant active branches/PRs when overlap, dependencies, or recent work could matter.
5. The current Codex session's status when the active work is local/unpushed and cannot be determined from GitHub.

Do not scan the whole repository by default.

If ChatGPT already has enough current context to make the routing decision safely, do not ask the user to repeat it.

---

# Active Codex Session Status

When another Codex session is already running and its scope is not visible from GitHub, ChatGPT should ask the user to get a short status report before starting overlapping work.

Use this prompt:

```text
Status report only. Do not stop or change direction.

Return:
- BRANCH: current branch
- TASK: exact task being implemented
- FILES CHANGED/EXPECTED: files already changed or expected to change
- SHARED CONTRACTS: types, schemas, APIs, storage models, prompts, or shared helpers being changed
- REMAINING: what is left to finish
- BLOCKERS: blockers or none

Then continue your current work.
```

The purpose is coordination, not review.

---

# Parallelization Gate

Recommend a parallel coding session only when all material conditions below are satisfied.

## 1. There are at least two bounded work units

Each agent must have a concrete deliverable and a clear finish line.

Bad split:

- Agent A: improve frontend
- Agent B: improve backend

Good split:

- Agent A: implement placement-specific 1:1/4:5/9:16 composition support in the format-generation path
- Agent B: implement version-history display and restore behavior in the TRA Creatives library

## 2. Shared architecture is already settled

Do not parallelize work that depends on an unresolved shared decision involving:

- data model or schema;
- API/request contract;
- storage pattern;
- source/provenance contract;
- central shared types;
- model-role or prompt contract;
- authentication/security boundary;
- merge/deployment strategy.

Resolve the shared contract first, then split execution.

## 3. One task does not depend on the unfinished output of the other

If Agent B needs Agent A's code, schema, or decision before it can implement correctly, keep the work sequential unless Agent B can perform a truly independent investigation or test task.

## 4. File and subsystem overlap is low

Prefer parallel tasks that modify different areas of the codebase.

Do not intentionally run two implementation agents against the same central file or shared type unless the overlap is explicitly coordinated and there is a strong reason.

## 5. Each agent can work on an isolated branch/worktree

Parallel implementation agents should normally use:

- a dedicated feature branch for each workstream;
- a separate worktree or Codex Desktop isolated workspace for each concurrent implementation;
- the same known `staging` base commit when practical.

Do not run two implementation agents in the same working directory.

## 6. Merge order is known

Before launching parallel work, identify whether:

- the branches are independent and can merge in either order; or
- one branch should merge first and the other should sync/rebase/merge the new `staging` state before its final verification.

If the merge order is unclear because the architecture is still moving, do not parallelize yet.

## 7. Each workstream can be verified independently

Each agent should have a narrow verification path for its own scope.

Parallel work is much safer when each branch can demonstrate that its own acceptance criteria pass before integration.

---

# When to Stay Sequential

Use one Codex implementation session when any of the following is true:

- the next task is small or medium and focused;
- the second task would save little time;
- both tasks touch the same core files;
- the first task is defining a schema, API, source contract, or architecture needed by the second;
- the current agent is already close to finishing;
- `staging` is changing rapidly in the same subsystem;
- the user would spend more time coordinating agents than waiting for one agent;
- the correct split is not obvious.

When uncertain, stay sequential.

---

# Codex Surface Routing

Use the smallest surface that fits the next work unit.

## VS Code Codex Sidebar

Use for normal focused implementation, especially one active workstream tied closely to the current files.

## Codex Terminal / CLI

Use when the task is mainly Git, builds, tests, environment variables, dependency problems, logs, deployment commands, or command-driven debugging.

## Codex Desktop App / isolated worktree

Prefer this for a second concurrent implementation workstream because it keeps the parallel task isolated from the active VS Code working directory.

Do not use the Desktop App merely because a task is large. First decompose the work.

---

# Required ChatGPT Parallel-Coding Decision

Before giving the user a second concurrent Codex implementation prompt, ChatGPT should provide a concise decision in this format:

```text
PARALLEL DECISION: YES | NO

WHY:
[one short explanation]

PRIMARY SESSION:
- task
- branch/worktree
- files/area owned

PARALLEL SESSION:
- task
- recommended Codex surface
- branch/worktree
- files/area owned
- DO NOT MODIFY

MERGE ORDER:
[order, or either order]

CHECKPOINT:
[what the user should bring back to ChatGPT when either agent finishes]
```

If `PARALLEL DECISION: NO`, ChatGPT should give the next single Codex task instead of forcing parallelism.

---

# Parallel Codex Prompt Template

When a parallel workstream is approved, use a bounded prompt like this:

```text
TASK:
[one isolated deliverable]

SOURCE OF TRUTH:
- AGENTS.md
- docs/parallel-coding.md
- [task-specific source/code]

BASE:
Start from the latest approved staging base for this workstream.
Use a dedicated feature branch and isolated worktree/workspace.

SCOPE:
[exact area this agent owns]

DO NOT:
- modify areas owned by the other active workstream
- redesign shared contracts outside this task
- make unrelated refactors
- merge directly to main

BEFORE EDITING:
- inspect only the directly relevant files
- confirm that the stated scope does not require a shared-contract change
- if it does, stop and report the dependency instead of inventing a competing contract

IMPLEMENT:
[bounded instructions]

VERIFY:
- run the narrowest relevant checks
- report exact results

RETURN:
- STATUS
- BRANCH
- FILES CHANGED
- IMPLEMENTATION
- VERIFICATION
- BLOCKERS
- SHARED-CONTRACT CHANGES, or none
- NEXT RECOMMENDED ACTION
```

---

# Conflict Prevention Rules

For concurrent implementation work:

- every agent gets an explicit ownership area;
- every agent gets a `DO NOT MODIFY` area when another session owns nearby code;
- use separate feature branches and isolated worktrees/workspaces;
- do not let agents independently redesign the same shared contract;
- do not silently resolve conflicts by discarding another branch's intended behavior;
- when the first parallel branch merges, the remaining branch should check whether `staging` advanced in relevant files before final merge;
- re-run verification after meaningful integration/conflict resolution;
- MEDIUM/HIGH-risk changes still follow the independent-review rules in `AGENTS.md`.

---

# TRA Image-Workflow Dependency Guidance

The current image workflow has an intentional dependency order:

1. multi-source media/input foundation and source-role contract;
2. company-profile / Sol context contract;
3. variation planner and small-batch selection;
4. placement-aware format generation;
5. save-to-library provenance and metadata;
6. editing and version history;
7. production hardening for the image workflow.

Do not parallelize a downstream implementation against an unresolved upstream contract it depends on.

Examples of unsafe parallelism:

- changing the source/provenance request contract while another agent builds generation logic against the old contract;
- changing the CreativeRecord schema while another agent independently builds persistence against a different shape;
- changing shared generation types while another agent implements format behavior in those same types.

Examples that may become safe once contracts are stable:

- placement rendering work and an isolated library UI feature touching separate code paths;
- editing/version-history UI and unrelated deterministic validation work;
- an implementation workstream and a fresh-context review/test workstream;
- two independent GitHub issues with little or no file overlap.

ChatGPT should verify the actual current repository state before assuming these examples are safe.

---

# Review Can Run in Parallel

Independent review is a particularly useful parallel activity because it should use fresh context and should not implement the same change.

When a MEDIUM or HIGH-risk implementation is complete enough to review, a separate reviewer may inspect the acceptance criteria, canonical requirements, final diff/commit, and verification results while the primary implementation agent moves to a genuinely independent task.

Do not let the reviewer modify the implementation branch unless the user explicitly changes the role from reviewer to implementer.

---

# Source Priority

This file controls coding-session orchestration only.

It does not override product requirements, runtime behavior, security rules, or active project scope.

When sources conflict, use the more authoritative task-specific source:

1. executable code/config for current runtime behavior;
2. explicit active product/workflow requirements and GitHub acceptance criteria;
3. `AGENTS.md` for repository/agent workflow and review rules;
4. this file for parallel-session orchestration;
5. broader roadmap/architecture documentation for stage and stable-boundary context.

If a conflict is material, surface it instead of guessing.

---

# Expected ChatGPT Behavior

Because TRA coding work normally starts in ChatGPT, ChatGPT should proactively evaluate parallelism whenever a coding task contains multiple meaningful work units or another Codex agent is already active.

ChatGPT should:

1. identify the next bounded work unit;
2. check whether another active workstream overlaps;
3. apply the Parallelization Gate;
4. say clearly whether parallel work is worth using;
5. select Sidebar, Terminal, or Desktop/isolated worktree for each workstream;
6. provide the exact branch/worktree ownership and `DO NOT MODIFY` boundaries when parallelism is recommended;
7. provide the Codex prompt(s);
8. define the merge order and checkpoint;
9. re-evaluate after either workstream completes.

The goal is not maximum agent count. The goal is the fastest reliable path to a clean `staging` branch.