# TRA AI Marketing Agent Rules

These rules apply to any AI coding agent, chat session, or developer working in this repository.

## Branch and Deployment Rule — Mandatory

**Feature branches = temporary isolated work / preview deployments.**

**`staging` = the complete, combined future version of the TRA app.**

**`main` = the current live production version of the TRA app.**

Follow these rules:

- Before starting normal app work, use the latest `staging` branch as the base and create a dedicated feature branch from it unless explicitly instructed otherwise.
- Do not use `main` as the base for normal feature work while `staging` exists. `main` may intentionally be behind the future version.
- Treat feature-branch deployments as temporary isolated previews. They may contain only that feature's work.
- Merge completed feature work into `staging`, not directly into `main`, so `staging` remains the single combined future version.
- Treat the `staging` preview as the canonical preview for reviewing how completed future work fits together.
- Only merge or promote `staging` into `main` when the user explicitly decides the combined future version is ready for production.
- Production should deploy from `main` only. Do not manually promote a feature-branch preview to production.
- Before finishing a long-running feature branch, check whether `staging` has advanced. Sync the feature branch with the latest `staging` before its final merge when needed.
- If another branch changed the same files, preserve both intended features when resolving conflicts. Never silently discard another agent's completed work.
- Do not assume changes made by another AI session are present on the current feature branch. Check `staging` and relevant active branches before making overlapping changes.
- Keep unrelated work out of the current feature branch so parallel AI sessions can merge cleanly.

When in doubt: use `staging` as the source of truth for the combined future app, and use `main` as the source of truth for what is currently live in production.
