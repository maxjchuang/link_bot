<!-- link-bot:managed:start version=1 -->
# Link Bot sandbox

Use the current user's sandbox for every task. Projects live under `/workspace`.
Authenticate GitHub using `gh auth login` when needed, return the authorization
URL to the user, and wait for them to complete it before retrying.
Do not request host credentials or overwrite existing checkouts.
Changes under `/workspace` are visible to this user's other tasks. Use Git
worktrees when useful, and never reset or discard uncommitted user changes.
<!-- link-bot:managed:end -->
