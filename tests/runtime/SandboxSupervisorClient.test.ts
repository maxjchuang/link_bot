import { chmod, mkdir, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { SandboxSupervisorClient } from '../../src/runtime/SandboxSupervisorClient.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('SandboxSupervisorClient', () => {
  let supervisor: ChildProcess | undefined;

  afterEach(async () => {
    if (!supervisor || supervisor.exitCode !== null) return;
    supervisor.kill('SIGTERM');
    await new Promise<void>((resolve) => supervisor!.once('exit', () => resolve()));
  });

  it('updates persisted credentials after sandbox recreation and fences explicit host refreshes', async () => {
    const root = await createTmpDir();
    const home = join(root, 'home');
    const codexHome = join(root, 'codex');
    const source = join(root, 'host-auth.json');
    const destination = join(codexHome, 'auth.json');
    const credentials = (ageDays: number, expiresDays: number, account = 'account_1') => JSON.stringify({
      last_refresh: new Date(Date.now() - ageDays * 86_400_000).toISOString(),
      tokens: { account_id: account, access_token: `header.${Buffer.from(JSON.stringify({
        sub: 'user_1', exp: Math.floor(Date.now() / 1_000 + expiresDays * 86_400),
      })).toString('base64url')}.signature` },
    });
    const stale = credentials(25, -15);
    const fresh = credentials(6, 4);
    await mkdir(codexHome, { recursive: true });
    await writeFile(destination, stale);
    await writeFile(source, fresh);
    const env = supervisorEnvironment(root, home, codexHome);
    Object.assign(env, { LINK_BOT_AUTH_FILE: source, LINK_BOT_OWNER_ID: 'ou_owner', LINK_BOT_SANDBOX_GENERATION: '3' });
    supervisor = spawn(process.execPath, ['runtime/bin/link-bot-sandbox-supervisor.mjs'], {
      env, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    supervisor.stderr?.on('data', (chunk) => { stderr += chunk; });
    const socket = join(root, 'bridge', 'supervisor.sock');
    await waitFor(() => pathExists(socket), () => stderr);
    const client = new SandboxSupervisorClient(socket, 2_000);
    expect(await readFile(destination, 'utf8')).toBe(fresh);
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
    expect((await stat(destination)).uid).toBe(process.getuid?.());

    const newer = credentials(1, 9);
    const refresh = { ownerId: 'ou_owner', sandboxGeneration: 3, contents: newer };
    await expect(client.refreshCodexAuth({ ...refresh, sandboxGeneration: 2 })).rejects.toThrow('stale sandbox generation');
    await expect(client.refreshCodexAuth({ ...refresh, ownerId: 'ou_other' })).rejects.toThrow('owner mismatch');
    await expect(client.refreshCodexAuth({ ...refresh, contents: credentials(1, 9, 'another_account') }))
      .rejects.toThrow('No newer valid');
    await expect(client.refreshCodexAuth(refresh)).resolves.toEqual({ updated: true });
    expect(await readFile(destination, 'utf8')).toBe(newer);
    await expect(client.refreshCodexAuth({ ...refresh, contents: fresh })).rejects.toThrow('No newer valid');
    expect(await readFile(destination, 'utf8')).toBe(newer);
    expect(stderr).not.toContain('signature');
  });

  it('fails StartTask immediately and removes its socket when the App Server executable cannot spawn', async () => {
    const root = await createTmpDir();
    const bridgeRoot = join(root, 'bridge');
    const sandboxHome = join(root, 'home');
    supervisor = spawn(process.execPath, ['runtime/bin/link-bot-sandbox-supervisor.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LINK_BOT_CODEX_COMMAND: join(root, 'missing-codex'),
        LINK_BOT_WORKSPACE_ROOT: root,
        LINK_BOT_BRIDGE_ROOT: bridgeRoot,
        HOME: sandboxHome,
        CODEX_HOME: join(root, 'shared-codex'),
        LINK_BOT_TOOL_HOME: join(sandboxHome, '.link-bot', 'tool-home'),
        LINK_BOT_NATIVE_GIT_HOME: join(sandboxHome, '.link-bot', 'native-git'),
        LINK_BOT_TASK_TMP_ROOT: join(root, 'tmp', 'tasks'),
        LINK_BOT_DEFAULT_AGENTS_FILE: resolve('runtime/defaults/AGENTS.md'),
        LINK_BOT_SANDBOX_GENERATION: '1',
        LINK_BOT_HOST_UID: String(process.getuid?.() ?? 0),
        LINK_BOT_HOST_GID: String(process.getgid?.() ?? 0),
        LINK_BOT_TASK_UID: String(process.getuid?.() ?? 1),
        LINK_BOT_TASK_GID: String(process.getgid?.() ?? 1),
        LINK_BOT_ALLOW_UNPRIVILEGED_TEST: '1',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    supervisor.stderr?.setEncoding('utf8');
    supervisor.stderr?.on('data', (chunk) => { stderr += chunk; });
    const controlSocket = join(bridgeRoot, 'supervisor.sock');
    await waitFor(async () => await pathExists(controlSocket), () => stderr);
    const client = new SandboxSupervisorClient(controlSocket, 2_000);
    await expect(readFile(join(root, 'shared-codex', 'AGENTS.md'), 'utf8'))
      .resolves.toContain('gh auth login');

    const startedAt = Date.now();
    await expect(client.startTask({
      taskId: 'task_bad', cwd: join(root, 'tasks', 'task_bad'),
      sandboxGeneration: 1, processGeneration: 1,
    })).rejects.toThrow(/Supervisor StartTask failed: spawn .*missing-codex ENOENT/);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    await expect(client.inspectTask('task_bad')).resolves.toEqual({ taskId: 'task_bad', status: 'not_found' });
    expect(await pathExists(join(bridgeRoot, 'tasks', 'task_bad-1.sock'))).toBe(false);
    expect(await pathExists(join(root, 'tmp', 'tasks', 'task_bad-g1'))).toBe(false);
  });

  it('generation- and owner-fences repository creation and coalesces duplicate operation IDs', async () => {
    const { client, callsPath, child } = await startRepositorySupervisor('normal');
    supervisor = child;
    const request = repositoryRequest();
    await expect(client.createRepository({ ...request, ownerUserId: 'ou_other' })).rejects.toThrow('owner');
    await expect(client.createRepository({ ...request, sandboxGeneration: 2 })).rejects.toThrow('generation');
    await expect(client.createRepository({ ...request, operationId: '../escape' })).rejects.toThrow('operationId');
    expect(await pathExists(callsPath)).toBe(false);

    await expect(client.createRepository(request)).resolves.toMatchObject({
      status: 'created', providerRepoId: 'gh_123', canonicalPath: 'owner/repo',
    });
    await expect(client.createRepository(request)).resolves.toMatchObject({ status: 'created' });
    expect((await readFile(callsPath, 'utf8')).trim().split('\n')).toEqual(['create']);
  });

  it('accepts provider canonical GitHub casing while preserving remote identity', async () => {
    const { client, child } = await startRepositorySupervisor('canonical_case'); supervisor = child;
    await expect(client.createRepository(repositoryRequest())).resolves.toMatchObject({ status: 'created',
      providerRepoId: 'gh_123', canonicalPath: 'Owner/repo', cloneUrl: 'git@github.com:Owner/repo.git' });
  });

  it('requires readback after an uncertain helper timeout and never retries create implicitly', async () => {
    const { client, callsPath, child } = await startRepositorySupervisor('timeout');
    supervisor = child;
    const request = repositoryRequest();

    await expect(client.createRepository(request)).rejects.toThrow('timed out');
    await expect(client.createRepository(request)).rejects.toThrow('readback');
    await expect(client.readRepositoryCreation({ ...request, action: 'readback' }))
      .resolves.toMatchObject({ status: 'created', providerRepoId: 'gh_123' });
    expect((await readFile(callsPath, 'utf8')).trim().split('\n')).toEqual(['create', 'readback']);
  });

  it('does not forward malformed or token-bearing helper output to the host', async () => {
    const { client, child } = await startRepositorySupervisor('malformed');
    supervisor = child;
    const result = await client.validateRepositoryCreation({ ...repositoryRequest(), action: 'validate' });
    expect(result).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(result)).not.toContain('ghp_');
  });

  it('permits the same operation to retry after a definite pre-create login failure', async () => {
    const { client, callsPath, child } = await startRepositorySupervisor('auth_then_created');
    supervisor = child;
    const request = repositoryRequest();

    await expect(client.createRepository(request)).resolves.toMatchObject({
      status: 'auth_required', reason: 'github_login_required',
    });
    await expect(client.createRepository(request)).resolves.toMatchObject({ status: 'created', providerRepoId: 'gh_123' });
    expect((await readFile(callsPath, 'utf8')).trim().split('\n')).toEqual(['create', 'create']);
  });

  it('rejects token-shaped provider metadata before returning a supervisor result', async () => {
    const { client, child } = await startRepositorySupervisor('metadata_token');
    supervisor = child;
    const result = await client.readRepositoryCreation({ ...repositoryRequest(), action: 'readback' });
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('ghp_');
  });

  it.each([
    {
      name: 'a partial managed block',
      prepare: async (codexHome: string) => {
        await writeFile(join(codexHome, 'AGENTS.md'), '<!-- link-bot:managed:start version=0 -->\nbroken\n');
      },
      error: 'malformed or duplicate link-bot managed markers',
    },
    {
      name: 'duplicate managed blocks',
      prepare: async (codexHome: string) => {
        const block = '<!-- link-bot:managed:start version=0 -->\nold\n<!-- link-bot:managed:end -->\n';
        await writeFile(join(codexHome, 'AGENTS.md'), `${block}${block}`);
      },
      error: 'malformed or duplicate link-bot managed markers',
    },
    {
      name: 'a symlinked AGENTS.md',
      prepare: async (codexHome: string, root: string) => {
        const target = join(root, 'outside-agents.md');
        await writeFile(target, 'must not be replaced\n');
        await symlink(target, join(codexHome, 'AGENTS.md'));
      },
      error: 'ELOOP',
    },
  ])('refuses to become ready with $name', async ({ prepare, error }) => {
    const root = await createTmpDir();
    const sandboxHome = join(root, 'home');
    const codexHome = join(root, 'shared-codex');
    await mkdir(codexHome, { recursive: true });
    await prepare(codexHome, root);
    supervisor = spawn(process.execPath, ['runtime/bin/link-bot-sandbox-supervisor.mjs'], {
      cwd: process.cwd(),
      env: supervisorEnvironment(root, sandboxHome, codexHome),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    supervisor.stderr?.setEncoding('utf8');
    supervisor.stderr?.on('data', (chunk) => { stderr += chunk; });
    const exitCode = await new Promise<number | null>((resolveExit) => supervisor!.once('exit', resolveExit));
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(error);
    expect(await pathExists(join(root, 'bridge', 'supervisor.sock'))).toBe(false);
  });
});

function supervisorEnvironment(root: string, sandboxHome: string, codexHome: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LINK_BOT_CODEX_COMMAND: process.execPath,
    LINK_BOT_CODEX_ARGS: JSON.stringify(['--version']),
    LINK_BOT_WORKSPACE_ROOT: root,
    LINK_BOT_BRIDGE_ROOT: join(root, 'bridge'),
    HOME: sandboxHome,
    CODEX_HOME: codexHome,
    LINK_BOT_TOOL_HOME: join(sandboxHome, '.link-bot', 'tool-home'),
    LINK_BOT_NATIVE_GIT_HOME: join(sandboxHome, '.link-bot', 'native-git'),
    LINK_BOT_TASK_TMP_ROOT: join(root, 'tmp', 'tasks'),
    LINK_BOT_DEFAULT_AGENTS_FILE: resolve('runtime/defaults/AGENTS.md'),
    LINK_BOT_SANDBOX_GENERATION: '1',
    LINK_BOT_HOST_UID: String(process.getuid?.() ?? 0),
    LINK_BOT_HOST_GID: String(process.getgid?.() ?? 0),
    LINK_BOT_TASK_UID: String(process.getuid?.() ?? 1),
    LINK_BOT_TASK_GID: String(process.getgid?.() ?? 1),
    LINK_BOT_ALLOW_UNPRIVILEGED_TEST: '1',
  };
}

function repositoryRequest() {
  return {
    action: 'create' as const, operationId: 'op_1', provider: 'github' as const,
    namespace: 'owner', name: 'repo', private: true as const,
    ownerUserId: 'ou_owner', sandboxGeneration: 3,
  };
}

async function startRepositorySupervisor(scenario: 'normal' | 'timeout' | 'malformed' | 'auth_then_created' | 'metadata_token' | 'canonical_case') {
  const root = await createTmpDir();
  const sandboxHome = join(root, 'home');
  const codexHome = join(root, 'shared-codex');
  const helper = join(root, 'fake-repo-helper.mjs');
  const callsPath = join(root, 'helper-calls.txt');
  const createdPath = join(root, 'helper-created.txt');
  await writeFile(helper, [
    '#!/usr/bin/env node',
    "import { appendFile, readFile, writeFile } from 'node:fs/promises';",
    "let input = ''; for await (const chunk of process.stdin) input += chunk;",
    'const request = JSON.parse(input);',
    "if (process.env.LINK_BOT_REPO_HELPER_SCENARIO === 'canonical_case') { process.stdout.write(JSON.stringify({",
    "  status: 'created', providerRepoId: 'gh_123', canonicalPath: 'Owner/repo', cloneUrl: 'git@github.com:Owner/repo.git', defaultBranch: 'main' }) + '\\n'); process.exit(0); }",
    "await appendFile(process.env.LINK_BOT_REPO_HELPER_LOG, `${request.action}\\n`);",
    "if (process.env.LINK_BOT_REPO_HELPER_SCENARIO === 'malformed') {",
    "  process.stdout.write('{\"status\":\"failed\",\"reason\":\"access_token=ghp_abcdefghijklmnopqrstuvwxyz123456\"}\\n');",
    '  process.exit(0);',
    '}',
    "if (process.env.LINK_BOT_REPO_HELPER_SCENARIO === 'metadata_token') {",
    "  process.stdout.write(JSON.stringify({ status: 'created', providerRepoId: 'ghp_abcdefghijklmnopqrstuvwxyz123456',",
    "    canonicalPath: 'owner/repo', cloneUrl: 'git@github.com:owner/repo.git', defaultBranch: 'main' }) + '\\n');",
    '  process.exit(0);',
    '}',
    "if (process.env.LINK_BOT_REPO_HELPER_SCENARIO === 'auth_then_created' && request.action === 'create') {",
    "  const earlier = await readFile(process.env.LINK_BOT_REPO_HELPER_CREATED, 'utf8').catch(() => undefined);",
    "  if (!earlier) { await writeFile(process.env.LINK_BOT_REPO_HELPER_CREATED, 'yes');",
    "    process.stdout.write('{\"status\":\"auth_required\",\"reason\":\"github_login_required\"}\\n'); process.exit(0); }",
    '}',
    "if (request.action === 'create') await writeFile(process.env.LINK_BOT_REPO_HELPER_CREATED, 'yes');",
    "if (process.env.LINK_BOT_REPO_HELPER_SCENARIO === 'timeout' && request.action === 'create') {",
    '  await new Promise((resolve) => setTimeout(resolve, 2_000));',
    '}',
    "const created = await readFile(process.env.LINK_BOT_REPO_HELPER_CREATED, 'utf8').catch(() => undefined);",
    "process.stdout.write(JSON.stringify(created ? { status: 'created', providerRepoId: 'gh_123',",
    "  canonicalPath: 'owner/repo', cloneUrl: 'git@github.com:owner/repo.git', defaultBranch: 'main' }",
    "  : { status: 'ready' }) + '\\n');",
  ].join('\n'));
  await chmod(helper, 0o755);
  const env = supervisorEnvironment(root, sandboxHome, codexHome);
  Object.assign(env, {
    LINK_BOT_OWNER_ID: 'ou_owner',
    LINK_BOT_SANDBOX_GENERATION: '3',
    LINK_BOT_REPO_CREATE_COMMAND: helper,
    LINK_BOT_REPO_CREATE_TIMEOUT_MS: '700',
    LINK_BOT_REPO_HELPER_SCENARIO: scenario,
    LINK_BOT_REPO_HELPER_LOG: callsPath,
    LINK_BOT_REPO_HELPER_CREATED: createdPath,
  });
  const child = spawn(globalThis.process.execPath, ['runtime/bin/link-bot-sandbox-supervisor.mjs'], {
    cwd: globalThis.process.cwd(), env, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  const socketPath = join(root, 'bridge', 'supervisor.sock');
  await waitFor(async () => pathExists(socketPath), () => stderr);
  return { client: new SandboxSupervisorClient(socketPath, 2_000), callsPath, child };
}

async function roundTrip(socketPath: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let output = '';
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('round trip timed out')); }, 2_000);
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(input));
    socket.on('data', (chunk) => {
      output += chunk;
      if (output.length >= input.length) {
        clearTimeout(timeout);
        socket.destroy();
        resolve(output);
      }
    });
    socket.once('error', (error) => { clearTimeout(timeout); reject(error); });
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await import('node:fs/promises').then(({ stat }) => stat(path));
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => Promise<boolean>, diagnostic: () => string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`condition not met: ${diagnostic()}`);
}
