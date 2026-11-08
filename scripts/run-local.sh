#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" != 22 ]; then
  if [ -r "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    nvm use --silent "$(cat .nvmrc)"
  fi
fi
umask 077
exec node scripts/start-local.mjs "$@"
