import { describe, expect, it, vi } from 'vitest';
import { createTmpDir } from '../helpers/tmp.js';

const fsMockState = vi.hoisted(() => ({
  blockSessionLogAppend: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    appendFile: vi.fn((filePath: Parameters<typeof actual.appendFile>[0], data: Parameters<typeof actual.appendFile>[1], options?: Parameters<typeof actual.appendFile>[2]) => {
      if (fsMockState.blockSessionLogAppend && String(filePath).includes('/logs/sessions/')) {
        return new Promise<void>(() => undefined);
      }
      return actual.appendFile(filePath, data, options);
    }),
  };
});

const { FileStateStore } = await import('../../src/state/FileStateStore.js');

describe('FileStateStore write isolation', () => {
  it('does not let a stuck session log append block event writes', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root, () => new Date('2026-06-25T00:00:00.000Z'));
    fsMockState.blockSessionLogAppend = true;

    void store.appendSessionLog('sess_blocked_log', 'streaming output\n');
    await Promise.resolve();

    await expect(withTimeout(
      store.appendEvent({ type: 'command.received', at: '2026-06-25T00:00:01.000Z', data: { text: '/current' } }),
      1000,
    )).resolves.toBe('completed');
  });

  it('does not let a stuck session log append block inbound dedupe state writes', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root, () => new Date('2026-06-25T00:00:00.000Z'));
    fsMockState.blockSessionLogAppend = true;

    void store.appendSessionLog('sess_blocked_log', 'streaming output\n');
    await Promise.resolve();

    await expect(withTimeout(
      store.claimInboundMessage({
        chatId: 'oc_1',
        chatType: 'private',
        userId: 'ou_1',
        messageId: 'om_1',
        text: '/current',
      }),
      1000,
    )).resolves.toBe('completed');
  });
});

async function withTimeout(action: Promise<unknown>, timeoutMs: number): Promise<'completed' | 'timed-out'> {
  return Promise.race([
    action.then(() => 'completed' as const),
    new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), timeoutMs)),
  ]);
}
