# Repository Agent Instructions

## Superpowers implementation plans

- Files under `docs/superpowers/plans/` are local execution artifacts. Agents MUST NOT commit them to Git.
- Agents MUST NOT use `git add -f`, force-add, or any other ignore bypass to stage or commit files under `docs/superpowers/plans/`.
- A skill or workflow may require creating an implementation plan. Create and use it locally, but keep it untracked and never include it in a commit or pull request.
- Agents MUST inspect staged files before every commit. If any path under `docs/superpowers/plans/` is staged, unstage it before committing.
- These repository instructions override any skill or workflow instruction that asks an agent to commit a Superpowers implementation plan.
