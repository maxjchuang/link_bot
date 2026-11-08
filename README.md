# Link Bot

Connect chat platforms with general-purpose AI agents.

Link Bot currently connects **Feishu** to **Codex App Server**. It supports ongoing conversations, isolated user workspaces, task status cards, approval requests, media attachments, and GitHub repository operations. Additional chat platforms and agent backends are future work.

## Requirements

- Node.js 22 (see `.nvmrc`)
- Docker Engine on Linux, or a Linux Docker engine on macOS (for example Colima) for persistent user sandboxes
- A Feishu custom app with a bot and long-connection event subscriptions
- Codex CLI and an authenticated Codex account
- GitHub CLI authentication for sandbox repository operations

## Setup

```sh
nvm use
npm ci
npm run build
umask 077
mkdir -p .link-bot
cp config.example.json .link-bot/config.json
```

Edit `.link-bot/config.json` before starting:

1. Set `feishu.appId` and `feishu.appSecret` for your own Feishu app.
2. Enable user and chat restrictions, and replace the example user/chat IDs with your own allowlists.
3. Configure your project paths, GitHub clone URLs, and public Git identities. Projects may also be selected or created from conversations.
4. Choose Codex models available to your account in `codex.executionProfiles`.
5. Keep `runtime.backend` set to `app-server`, enable `userSandboxes`, and leave `enabledOwners` empty so every authorized owner uses their own persistent sandbox. Set `legacyFallbackEnabled` and `readyPool.enabled` to `false`.
6. On macOS, disable `diskPolicy.enabled` and `diskPolicy.cleanupEnabled` in the private local config: the host filesystem is not the Docker VM data filesystem.
7. Enable `taskPlatformRollout.projectFreeChat` for new group topics to start as chat tasks without cloning a repository.
8. `projectlessWorkspaces` requires both `conversationScopedTasks` and `multiRepositoryTasks`. The example enables all three.

The local launcher uses `~/.codex-link-bot` (or `LINK_BOT_CODEX_HOME`) so it does not import the global Codex configuration. To reuse your existing login file without copying credentials:

```sh
npm run auth:reuse
```

Alternatively, create that dedicated directory and sign in there with file-based credential storage. Authentication files remain private and must never be committed.

Build the sandbox image and run startup checks:

```sh
npm run runtime:build
npm run doctor
npm start
```

On macOS, `userSandboxes.transport: "auto"` uses a `docker exec` stdio bridge to Unix sockets **inside the existing user container**. Linux uses native Unix sockets. There is one persistent container per owner; task App Server processes share it. No per-session container fallback is enabled, and the bridge opens no TCP listener.

For a dedicated local Colima engine:

```sh
brew install colima docker docker-buildx
colima start --profile link-bot --arch aarch64 --vm-type vz --cpu 4 --memory 6 --disk 40
```

Ensure Docker can find its buildx plugin using the installation caveats. If Docker Hub is unavailable, an explicit public Docker Official Images mirror can be selected without changing the default source:

```sh
LINK_BOT_NODE_BASE_IMAGE=public.ecr.aws/docker/library/node:22.21.1-bookworm-slim npm run runtime:build
```

The builder selects the Docker daemon's native architecture and verifies the matching GitHub CLI checksum. The local launcher selects the dedicated Colima context when present and ignores an obsolete `DOCKER_DEFAULT_PLATFORM` override.

Optional background service commands:

```sh
npm run start:background
npm run status:local
npm run stop:local
```

The service log and process receipt are private files under `.link-bot/`. To discover your allowlist IDs, `npm run setup:feishu` starts a receive-only challenge listener; it sends no messages and starts no agent. Only challenge-matched IDs are stored locally. Stop the listener after selecting your user and test chat, and keep the restrictive allowlists enabled.

In the Feishu app settings, import [docs/feishu-permissions.json](docs/feishu-permissions.json) to request the scopes used by the implemented bot features, then publish the updated app version after approval. The manifest includes the sensitive `im:message.group_msg` scope required for group/topic history. Enable long-connection subscriptions for `im.message.receive_v1` and the `card.action.trigger` callback separately. See the [permission mapping and setup checklist](docs/feishu-permissions.md). Successful login or receipt of messages does not prove permission to send replies.

Each user authenticates GitHub inside their own persistent sandbox using `gh auth login`. Link Bot does not bundle developer credentials or runtime skills from a workstation.

## Development

```sh
npm run build
npm test
npm run runtime:verify
npm run test:user-sandbox-smoke
```

`npm test` uses fake backends and temporary Git repositories; it does not require a live Feishu bot. The user-sandbox smoke check uses real Docker, verifies two App Server processes in one reused user container, and cleans only its own fixture resources. It makes no model inference calls and sends no Feishu messages. An actual Feishu/Codex conversation remains a separate deployment check. Linux-specific process-namespace checks are skipped on other operating systems.

## Data and access

Local configuration, credentials, task databases, attachments, logs, and session files belong under `.link-bot/`, which is ignored by Git. Never commit these files or copy an existing runtime directory into a release.

A group message requires a bot mention unless a specifically authorized ambient conversation is configured. Task ownership, project access rules, and approval checks apply to message and card actions. Treat the deployed bot as a system that can execute commands: explicitly allow the users, projects, and chats you intend to support.

The initial release includes the Feishu/Codex integration and GitHub provider. Deployment app credentials stay on the manager. Sandbox tools do not receive the bot app secret; users configure their own tool credentials inside their own sandbox when needed.

On macOS the sandbox capacity gate uses the Docker daemon memory budget and container working sets. macOS free-memory counts include reclaimable cache and must not be treated as Docker VM capacity.
