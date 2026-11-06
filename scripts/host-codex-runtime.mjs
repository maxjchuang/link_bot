import { join } from 'node:path';

// Keep the configured global executable. Compatibility depends on the protocol,
// not on a list of version numbers or an isolated service installation.
export async function ensureHostCodexRuntime(projectRoot, { commandRunner, command = 'codex', env = process.env } = {}) {
  const { EXPECTED_CODEX_VERSION: _expected, ...environment } = env;
  await commandRunner(process.execPath, [join(projectRoot, 'scripts/check-app-server-schema.mjs')], {
    cwd: projectRoot, env: { ...environment, CODEX_COMMAND: command },
  });
  return command;
}
