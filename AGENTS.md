# TRA AI Marketing Agent Rules

These rules apply to any AI coding agent, chat session, or developer working in this repository.

## Branch and Deployment Rule — Mandatory

**Feature branches = temporary work / preview deployments.**

**`main` = the complete, combined version of the TRA app.**

Follow these rules:

- Work on a dedicated feature branch for each separate feature or task unless explicitly instructed otherwise.
- Treat feature-branch deployments as temporary previews only. A preview may contain only that branch's work and is not the complete TRA app.
- Do not manually promote a feature-branch preview deployment to production.
- Production should deploy from `main` only.
- Finished feature work should be merged into `main` so the final app contains the combined work from all completed branches.
- Before finishing a long-running feature branch, check whether `main` has advanced. Sync the branch with the latest `main` before the final merge when needed.
- If another branch changed the same files, preserve both intended features when resolving conflicts. Never silently discard another agent's completed work.
- Do not assume changes made by another AI session are present on your branch. Check `main` and the relevant branches before making overlapping changes.
- Keep unrelated work out of the current feature branch so parallel AI sessions can merge cleanly.

When in doubt, use `main` as the source of truth for the current combined application state and use feature branches only for isolated work in progress.
