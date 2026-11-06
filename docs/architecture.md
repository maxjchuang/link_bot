# Architecture

The Feishu gateway turns messages and card actions into task-platform operations. The task service owns task state, requester authorization, project selection, and turn lifecycle. It sends structured requests to Codex App Server and projects the responses into Feishu cards and notifications.

Task state and delivery receipts use SQLite. A user's sandbox provides persistent project workspaces and isolated authentication. Docker-based task containers remain available for deployments that do not enable persistent user sandboxes; both modes use App Server.

GitHub repository creation and publishing use native Git and GitHub CLI. Repository creation requires an explicit requester confirmation. Credential-bearing data is kept out of tool results and public cards.

The host manager is a separate App Server maintenance session for explicitly configured administrators. Optional memory, attachments, conversation history, and detail recording share the same task authorization boundaries.
