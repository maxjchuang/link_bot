# Security boundaries

The Feishu SDK and CLI are public dependencies. Their published documentation, API names, copyright notices and license text are retained. Deployment credentials, tenant data and private project metadata do not belong in this repository.

The manager owns the Feishu app configuration. Task authentication projection is limited to the Codex authentication file; the manager app secret is not copied into task workspaces or automatically installed into sandbox tools. Users configure any additional tool identities inside their own sandbox.

Access to an agent task grants command execution inside that task's runtime. Explicit user/chat allowlists, project access rules, sandbox isolation and approval checks remain necessary. Administrator host sessions have a separate trusted role. A clean source scan does not replace deployment security review.

Configuration, sessions, databases, logs, credentials and generated files are excluded from Git. Publish from a reviewed Git snapshot rather than archiving an entire local working directory. Tests use explicit fictional identities and data.
