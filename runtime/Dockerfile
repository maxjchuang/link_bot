FROM node:22.21.1-bookworm-slim

ARG CODEX_CLI_VERSION=0.161.0
ARG LARK_CLI_VERSION=1.0.94
ARG PNPM_VERSION=10.25.0
RUN apt-get update \
    && apt-get install --yes --no-install-recommends bubblewrap ca-certificates curl git openssh-client python3 tini \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --registry=https://registry.npmjs.org \
      "@openai/codex@${CODEX_CLI_VERSION}" "@larksuite/cli@${LARK_CLI_VERSION}" "pnpm@${PNPM_VERSION}" \
    && npm cache clean --force

ARG GH_CLI_VERSION=2.102.0
ARG GH_CLI_SHA256=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386
RUN curl --fail --silent --show-error --location --output /tmp/gh.tar.gz \
      "https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/gh_${GH_CLI_VERSION}_linux_amd64.tar.gz" \
    && echo "${GH_CLI_SHA256}  /tmp/gh.tar.gz" | sha256sum --check \
    && tar -xzf /tmp/gh.tar.gz --strip-components=2 -C /usr/local/bin \
      "gh_${GH_CLI_VERSION}_linux_amd64/bin/gh" \
    && chmod 0755 /usr/local/bin/gh \
    && gh --version | grep -F "gh version ${GH_CLI_VERSION}" \
    && rm -f /tmp/gh.tar.gz


COPY defaults/npmrc /usr/local/etc/npmrc
ENV NPM_CONFIG_GLOBALCONFIG=/usr/local/etc/npmrc
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin codex \
    && mkdir -p /workspace /cache /run/link-bot /home/codex/.codex/tool-home/gh \
    && chmod 0700 /home/codex/.codex/tool-home /home/codex/.codex/tool-home/gh \
    && chown -R codex:codex /workspace /cache /run/link-bot
COPY defaults/AGENTS.md /opt/link-bot/defaults/AGENTS.md
RUN mkdir -p /usr/local/libexec \
    && mv /usr/local/bin/lark-cli /usr/local/libexec/lark-cli
COPY bin/lark-cli-wrapper /usr/local/bin/lark-cli
COPY bin/link-bot-native-git-init /usr/local/bin/link-bot-native-git-init
COPY bin/link-bot-sandbox-supervisor.mjs /usr/local/bin/link-bot-sandbox-supervisor
COPY bin/link-bot-codex-auth.mjs /usr/local/bin/link-bot-codex-auth.mjs
COPY bin/link-bot-sandbox-repo-create.mjs /usr/local/bin/link-bot-sandbox-repo-create
COPY bin/git-wrapper /usr/local/bin/git
RUN chmod 0755 /usr/local/bin/lark-cli /usr/local/bin/link-bot-* /usr/local/bin/git \
    && chmod 0444 /opt/link-bot/defaults/AGENTS.md
USER 10001:10001
WORKDIR /workspace
ENV HOME=/home/codex CODEX_HOME=/home/codex/.codex GH_CONFIG_DIR=/home/codex/.codex/tool-home/gh
ENTRYPOINT ["codex", "app-server", "--stdio"]
