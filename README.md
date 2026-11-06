# Link Bot

Connect chat platforms with general-purpose AI agents.

Link Bot currently connects **Feishu** to **Codex App Server**. It supports ongoing conversations, isolated user workspaces, task status cards, approval requests, media attachments, and GitHub repository operations. Additional chat platforms and agent backends are future work.

## Requirements

- Node.js 22 (see `.nvmrc`)
- Docker Engine on a Linux host for task sandboxes
- A Feishu custom app with a bot and long-connection event subscriptions
- Codex CLI and an authenticated Codex account
- GitHub CLI authentication for sandbox repository operations

## Setup

```sh
nvm use
npm ci
npm run build
mkdir -p .link-bot
cp config.example.json .link-bot/config.json
```

Edit `.link-bot/config.json` before starting:

1. Set `feishu.appId` and `feishu.appSecret` for your own Feishu app.
2. Enable user and chat restrictions, and replace the example user/chat IDs with your own allowlists.
3. Configure your project paths, GitHub clone URLs, and public Git identities. Projects may also be selected or created from conversations.
4. Choose Codex models available to your account in `codex.executionProfiles`.
5. Keep `runtime.backend` set to `app-server` and `taskPlatformRollout.enabled` set to `true`.

On the deployment host, authenticate Codex with `codex login`, build the sandbox image, and start the bot:

```sh
npm run runtime:build
npm start
```

In the Feishu app settings, enable long-connection subscriptions for bot messages and card callbacks. Grant the message, membership, and resource permissions required by the features you enable. Configure optional conversation history access only if you need contextual recall.

Each user authenticates GitHub inside their own persistent sandbox using `gh auth login`. Link Bot does not bundle developer credentials or runtime skills from a workstation.

## Development

```sh
npm run build
npm test
npm run runtime:verify
```

`npm test` uses fake backends and temporary Git repositories; it does not require a live Feishu bot. Docker image verification and an actual Feishu/Codex conversation are separate deployment checks. Linux-specific process-namespace checks are skipped on other operating systems.

## Data and access

Local configuration, credentials, task databases, attachments, logs, and session files belong under `.link-bot/`, which is ignored by Git. Never commit these files or copy an existing runtime directory into a release.

A group message requires a bot mention unless a specifically authorized ambient conversation is configured. Task ownership, project access rules, and approval checks apply to message and card actions. Treat the deployed bot as a system that can execute commands: explicitly allow the users, projects, and chats you intend to support.

The initial release includes the Feishu/Codex integration and GitHub provider. Deployment app credentials stay on the manager. Sandbox tools do not receive the bot app secret; users configure their own tool credentials inside their own sandbox when needed.
