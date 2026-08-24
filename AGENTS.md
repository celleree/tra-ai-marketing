# TRA AI Marketing Agent Rules

Keep normal AI/Codex context small. Read only the files needed for the task.

## Workflow

- `main` is production. `staging` is the combined future version.
- Start normal app work from the latest `staging` on a dedicated feature branch.
- Verify the completed branch before merging it into `staging`; do not build multi-file app changes directly on `staging` or `main`.
- Preserve intended work from parallel branches when resolving conflicts.
- Promote `staging` to `main` only when explicitly approved for production.

## Sources of truth

- Runtime behavior, prompts, categories, formats, validation, defaults, and integration logic: source code.
- Environment-variable names and examples: `.env.example`.
- Stable system boundaries: `docs/architecture.md`.
- External deployment/setup requirements: `docs/deployment.md`.
- Customer research summary: `knowledge/customer-insights.md`.
- Current work and future tasks: GitHub Issues.

If documentation conflicts with executable code/config, treat code/config as authoritative and correct or delete the stale documentation.

## Decision capture

When a chat or AI session establishes a durable project decision, constraint, architecture choice, external requirement, or important rationale that is not already represented in the canonical source of truth, update the appropriate canonical source.

- Record the final decision and only the rationale needed to understand it later; do not preserve raw conversation transcripts or step-by-step reasoning.
- Runtime behavior or implementation decisions -> code/config.
- Architecture changes or stable system boundaries -> `docs/architecture.md`.
- Deployment or external platform requirements -> `docs/deployment.md`.
- Future work discovered in chat -> GitHub Issue.
- Temporary brainstorming, abandoned ideas, and routine debugging stay in chat/Git history unless they produce a durable decision.
- When experiments establish a durable choice, document what was chosen and why, not the full sequence of failed approaches.

## Context limits

- Do not recursively load the repository, `/docs`, Git history, old PRs, or external source material by default.
- Start with `AGENTS.md`, the task-relevant code/config, and only the specific supporting document needed.
- Prefer summaries over raw source data. Retrieve raw evidence only when exact verification is required.

## Documentation and deletion

- Document only stable architecture, required external setup, or rules that materially help future work.
- Do not duplicate implementation details that are already clear in code/config.
- Delete obsolete code and docs instead of leaving tombstones, deprecated copies, changelogs, or `REMOVED.md` files.
- Use descriptive commits/PRs for meaningful removal history; Git history is the archive.
- Small documentation-only changes may be made directly when safe; app/code changes follow the feature-branch workflow above.
