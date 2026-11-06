import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostControlClient, startHostControlServer } from '../../src/host/HostControlRpc.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((fn) => fn())); });

describe('host control RPC', () => {
  it('forwards a private message over an owner-only Unix socket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'link-bot-host-rpc-'));
    const socketPath = join(root, 'host.sock');
    const handler = vi.fn(async () => ({ reply: 'host reply' }));
    const server = await startHostControlServer(socketPath, { handleMessage: handler });
    cleanup.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    });

    const result = await new HostControlClient(socketPath).handleMessage({
      chatId: 'oc_admin', chatType: 'private', userId: 'ou_admin', messageId: 'om_1', text: '修复问题',
    });

    expect(result).toEqual({ reply: 'host reply' });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ userId: 'ou_admin', text: '修复问题' }));
  });
});
