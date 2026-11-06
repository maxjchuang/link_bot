import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteStateStore } from '../../src/state/SqliteStateStore.js';
import { formatCompactTokens, TokenUsageLedger } from '../../src/usage/TokenUsageLedger.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('TokenUsageLedger', () => {
  it('records monotonic deltas once and aggregates across contexts in one task', async () => {
    const root = await createTmpDir();
    const store = new SqliteStateStore(join(root, 'state.sqlite'), () => new Date('2026-08-21T01:00:00Z'));
    const task = {
      id: 'task_1', ownerUserId: 'ou_1', projectId: 'repo', baseRef: 'main', branchName: 'codex/task_1',
      runtimeState: 'hot' as const, model: 'gpt-5.6-sol', pinned: false,
      lastUserInteractionAt: '2026-08-21T00:00:00Z', createdAt: '2026-08-21T00:00:00Z', updatedAt: '2026-08-21T00:00:00Z',
    };
    store.saveTask(task);
    const ledger = new TokenUsageLedger(store, () => new Date('2026-08-21T01:00:00Z'));
    const usage = (totalTokens: number, inputTokens: number, outputTokens: number) => ({ total: {
      totalTokens, inputTokens, cachedInputTokens: Math.floor(inputTokens / 2), outputTokens, reasoningOutputTokens: 10,
    } });

    ledger.record({ task, threadId: 'thread_1', turnId: 'turn_1', usage: usage(1_100, 1_000, 100) });
    ledger.record({ task, threadId: 'thread_1', turnId: 'turn_1', usage: usage(1_100, 1_000, 100) });
    ledger.record({ task, threadId: 'thread_1', turnId: 'turn_2', usage: usage(1_650, 1_500, 150) });
    ledger.record({ task, threadId: 'thread_2', turnId: 'turn_3', usage: usage(220, 200, 20) });

    expect(ledger.totalForTask('task_1')).toEqual({
      inputTokens: 1_700, cachedInputTokens: 850, outputTokens: 170, reasoningTokens: 20, totalTokens: 1_870,
    });
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM token_usage_ledger').get()).toEqual({ count: 3 });
    store.close();
  });

  it('formats compact token values without losing stored precision', () => {
    expect(formatCompactTokens(896)).toBe('896');
    expect(formatCompactTokens(142_673)).toBe('142.7K');
    expect(formatCompactTokens(12_350_000)).toBe('12.35M');
    expect(formatCompactTokens(1_200_000_000)).toBe('1.2B');
  });
});
