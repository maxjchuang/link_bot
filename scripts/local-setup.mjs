import { readFile, stat, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export function localEnvironment(env = process.env) {
  const result = { ...env, CODEX_HOME: env.LINK_BOT_CODEX_HOME ?? join(homedir(), '.codex-link-bot') };
  delete result.DOCKER_DEFAULT_PLATFORM;
  if (env.LINK_BOT_DOCKER_CONTEXT) result.DOCKER_CONTEXT = env.LINK_BOT_DOCKER_CONTEXT;
  else if (!env.DOCKER_CONTEXT) {
    const probe = spawnSync('docker', ['context', 'inspect', 'colima-link-bot'], { env: result, stdio: 'ignore', timeout: 2000 });
    if (probe.status === 0) result.DOCKER_CONTEXT = 'colima-link-bot';
  }
  return result;
}

export async function inspectLocalSetup(root = process.cwd(), env = localEnvironment()) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
  add('node', Number(process.versions.node.split('.')[0]) === 22, 'Node 22 is required.');
  let config;
  try {
    const { loadConfig } = await import('../dist/src/config/loadConfig.js');
    config = await loadConfig(root); add('config', true, 'Configuration passes validation.');
  } catch { add('config', false, 'Create and validate .link-bot/config.json. Values are never printed.'); }
  if (config) {
    add('user_sandbox', config.userSandboxes?.enabled && !config.userSandboxes.legacyFallbackEnabled
      && config.userSandboxes.enabledOwners.length === 0 && !config.readyPool.enabled,
      'Enable User Sandbox for authorized owners; disable legacy fallback and the task-container ready pool.');
    add('feishu_credentials', config.feishu.appId && config.feishu.appSecret
      && !/your_|placeholder/i.test(config.feishu.appId + config.feishu.appSecret), 'Local credential fields are present; Feishu message-send permissions still require separate platform configuration.');
    add('allowlists', config.restrictUsers && config.restrictChatIds && config.allowedUsers.length && config.allowedChatIds.length
      && ![...config.allowedUsers, ...config.allowedChatIds].some(v => /allowed_|placeholder|fixture/i.test(v)),
      'Configure your own user and test-chat allowlists before accepting messages.');
  }
  try {
    const auth = JSON.parse(await readFile(join(env.CODEX_HOME, 'auth.json'), 'utf8'));
    const info = await stat(join(env.CODEX_HOME, 'auth.json'));
    add('codex_login', Boolean(auth.tokens?.access_token || auth.OPENAI_API_KEY || auth.access_token)
      && (info.mode & 0o077) === 0, 'A private file-based personal Codex login is required in the dedicated Codex home.');
  } catch { add('codex_login', false, 'Sign in using the dedicated Codex home; do not copy company credentials.'); }
  const docker = spawnSync('docker', ['info', '--format', '{{.OSType}}/{{.Architecture}}'], { env, encoding: 'utf8', timeout: 10_000 });
  add('docker', docker.status === 0, 'Start the local Docker engine (for example, the dedicated Colima profile).');
  if (docker.status === 0 && config?.runtime?.image) {
    const image = spawnSync('docker', ['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', config.runtime.image], { env, encoding: 'utf8', timeout: 5000 });
    const normalize = s => String(s).trim().replace('aarch64', 'arm64').replace('x86_64', 'amd64');
    add('runtime_image', image.status === 0 && normalize(image.stdout) === normalize(docker.stdout), 'Build the runtime image for the Docker daemon architecture.');
  }
  return { ok: checks.every(c => c.ok), checks };
}

export async function ensureLocalState(root) {
  const directory = resolve(root, '.link-bot'); await mkdir(directory, { recursive: true, mode: 0o700 });
}
