import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SandboxSupervisorClient } from '../../src/runtime/SandboxSupervisorClient.js';
import { createSandboxConnection, dockerSandboxEndpoint, resolveSandboxTransport } from '../../src/runtime/SandboxSocketTransport.js';
import { createTmpDir } from '../helpers/tmp.js';

async function listen(server: Server, path: string) {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
}
const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));

function bridgeInTestNamespace(root: string, calls: string[][], children: ChildProcessWithoutNullStreams[]) {
  return (command: string, args: string[]) => {
    expect(command).toBe('docker'); calls.push(args);
    const relative = args.at(-1)!.slice('/run/link-bot/bridge/'.length);
    const child = spawn(process.execPath, ['runtime/bin/link-bot-sandbox-bridge.mjs', join(root, relative)], {
      env: { ...process.env, LINK_BOT_BRIDGE_ROOT: root }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child); return child;
  };
}

it('uses Docker exec on macOS and native UDS on Linux without changing the user-container model', () => {
  expect(resolveSandboxTransport('auto', 'darwin')).toBe('docker-exec');
  expect(resolveSandboxTransport('auto', 'linux')).toBe('unix-socket');
  expect(resolveSandboxTransport('unix-socket', 'darwin')).toBe('unix-socket');
});

it.each([
  ['--privileged', '/run/link-bot/bridge/supervisor.sock'],
  ['sandbox', '/home/codex/.codex/auth.json'],
  ['sandbox', '/run/link-bot/bridge/tasks/../supervisor.sock'],
])('rejects an unsafe transport target %s %s', (container, path) => {
  expect(() => dockerSandboxEndpoint(container, path)).toThrow();
});

it('round-trips raw App Server bytes through a child bridge with no TCP listener', async () => {
  const root = await createTmpDir(), path = join(root, 'supervisor.sock');
  const server = createServer(socket => socket.pipe(socket)); await listen(server, path);
  const calls: string[][] = [], children: ChildProcessWithoutNullStreams[] = [];
  const socket = createSandboxConnection(dockerSandboxEndpoint('link-bot-user-fixture-g1', '/run/link-bot/bridge/supervisor.sock'),
    { spawnProcess: bridgeInTestNamespace(root, calls, children) });
  try {
    await once(socket, 'connect');
    const expected = Buffer.from('fixture frame\n'.repeat(8000));
    const received = new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []; let bytes = 0;
      socket.on('data', chunk => { chunks.push(chunk); bytes += chunk.length; if (bytes === expected.length) resolve(Buffer.concat(chunks)); });
      socket.once('error', reject);
    });
    socket.write(expected); expect(await received).toEqual(expected);
    expect(calls[0]?.slice(0, 5)).toEqual(['exec', '-i', '--user', '0:0', 'link-bot-user-fixture-g1']);
    expect(calls.flat()).not.toEqual(expect.arrayContaining(['create', 'run', '-p', '--publish']));
  } finally { socket.destroy(); await Promise.all(children.map(child => child.exitCode === null ? once(child, 'close') : undefined)); await close(server); }
});

it('runs generation-fenced Supervisor RPCs through the existing user container', async () => {
  const root = await createTmpDir(), path = join(root, 'supervisor.sock');
  const server = createServer(socket => {
    let input = ''; socket.setEncoding('utf8'); socket.on('data', chunk => {
      input += chunk; if (!input.includes('\n')) return;
      const request = JSON.parse(input);
      socket.end(JSON.stringify({ id: request.id, ok: true, result: request.method === 'Health'
        ? { status: 'ready', taskCount: 1, maxAppServers: 8 }
        : { taskId: request.params.taskId, sandboxGeneration: 3, processGeneration: 7,
          socketPath: '/run/link-bot/bridge/tasks/task_1-7.sock', status: 'running' } })+'\n');
    });
  });
  await listen(server, path); const calls: string[][] = [], children: ChildProcessWithoutNullStreams[] = [];
  const client = new SandboxSupervisorClient(dockerSandboxEndpoint('link-bot-user-fixture-g3', '/run/link-bot/bridge/supervisor.sock'), 3000,
    endpoint => createSandboxConnection(endpoint, { spawnProcess: bridgeInTestNamespace(root, calls, children) }));
  try {
    expect(await client.health()).toMatchObject({ status: 'ready' });
    expect(await client.startTask({ taskId: 'task_1', cwd: '/workspace', sandboxGeneration: 3, processGeneration: 7 }))
      .toMatchObject({ hostSocketPath: 'docker-exec://link-bot-user-fixture-g3/run/link-bot/bridge/tasks/task_1-7.sock' });
    expect(calls.every(args => args[0] === 'exec' && args[4] === 'link-bot-user-fixture-g3')).toBe(true);
  } finally { for (const child of children) child.kill(); await close(server); }
});

it('preserves a safe startup error code without disclosing request data', async () => {
  const root = await createTmpDir(), calls: string[][] = [], children: ChildProcessWithoutNullStreams[] = [];
  const socket = createSandboxConnection(dockerSandboxEndpoint('sandbox', '/run/link-bot/bridge/supervisor.sock'),
    { spawnProcess: bridgeInTestNamespace(root, calls, children) });
  await expect(once(socket, 'connect')).rejects.toMatchObject({ code: 'ENOENT' });
});
