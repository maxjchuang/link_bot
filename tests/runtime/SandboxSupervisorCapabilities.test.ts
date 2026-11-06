import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SandboxRuntimeUpgradeRequiredError, SandboxSupervisorClient } from '../../src/runtime/SandboxSupervisorClient.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('supervisor credential refresh compatibility', () => {
  it.each([
    { capabilities: [], error: undefined, upgrade: true, refreshCalls: 0 },
    { capabilities: undefined, error: 'unsupported supervisor method: RefreshCodexAuth', upgrade: true, refreshCalls: 1 },
    { capabilities: undefined, error: undefined, upgrade: false, refreshCalls: 1 },
    { capabilities: ['RefreshCodexAuth'], error: undefined, upgrade: false, refreshCalls: 1 },
    { capabilities: ['RefreshCodexAuth'], error: 'stale sandbox generation', upgrade: false, refreshCalls: 1 },
    { capabilities: undefined, error: 'No newer valid Codex credentials are available.', upgrade: false, refreshCalls: 1 },
  ])('handles advertised and legacy capabilities: %j', async ({ capabilities, error, upgrade, refreshCalls }) => {
    const socketPath = join(await createTmpDir(), 'supervisor.sock');
    const methods: string[] = [];
    const server = createServer((socket) => {
      let input = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        input += chunk;
        if (!input.includes('\n')) return;
        const request = JSON.parse(input.trim());
        methods.push(request.method);
        const result = request.method === 'Health'
          ? { status: 'ready', taskCount: 0, maxAppServers: 8, ...(capabilities ? { capabilities } : {}) }
          : { updated: true };
        socket.end(`${JSON.stringify({ id: request.id, ok: request.method === 'Health' || !error, result, error })}\n`);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    try {
      const client = new SandboxSupervisorClient(socketPath, 2_000);
      const refreshed = client.refreshCodexAuth({ ownerId: 'ou_owner', sandboxGeneration: 3, contents: 'test credential' });
      if (upgrade) await expect(refreshed).rejects.toBeInstanceOf(SandboxRuntimeUpgradeRequiredError);
      else if (error) await expect(refreshed).rejects.toThrow(error);
      else await expect(refreshed).resolves.toEqual({ updated: true });
      expect(methods.filter((method) => method === 'RefreshCodexAuth')).toHaveLength(refreshCalls);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
