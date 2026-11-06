import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { UserSandboxReclaimer } from '../../src/runtime/UserSandboxReclaimer.js';
import { SqliteStateStore } from '../../src/state/SqliteStateStore.js';
import type { TaskRecord } from '../../src/tasks/TaskTypes.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('UserSandboxReclaimer', () => {
  it('stops idle task processes before reclaiming an unused owner wrapper', async () => {
    const now = new Date('2026-09-20T12:00:00.000Z');
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'), () => now);
    store.saveTask(task({ runtimeState: 'hot', lastUserInteractionAt: '2026-09-20T08:00:00.000Z' }));
    const created = store.getOrCreateUserSandbox('ou_1').sandbox;
    store.saveUserSandbox({
      ...created, status: 'running', containerId: 'a'.repeat(64),
      lastActiveAt: '2026-09-19T08:00:00.000Z', updatedAt: '2026-09-19T08:00:00.000Z',
    });
    const stopTaskProcess = vi.fn(async () => undefined);
    const reclaimSandbox = vi.fn(async () => undefined);
    const reclaimer = new UserSandboxReclaimer(store, { stopTaskProcess, reclaimSandbox }, {
      processIdleMs: 2 * 60 * 60_000, wrapperIdleMs: 24 * 60 * 60_000,
    }, () => now);

    const result = await reclaimer.run();

    expect(stopTaskProcess).toHaveBeenCalledWith(expect.objectContaining({ id: 'task_1' }));
    expect(store.getTask('task_1')?.runtimeState).toBe('warm');
    expect(reclaimSandbox).toHaveBeenCalledWith('ou_1');
    expect(result).toMatchObject({ stoppedTaskIds: ['task_1'], reclaimedOwnerIds: ['ou_1'], failures: [] });
    store.close();
  });

  it('never reclaims an active turn or its sandbox', async () => {
    const now = new Date('2026-09-20T12:00:00.000Z');
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'), () => now);
    store.saveTask(task({ activeTurnId: 'turn_1', lastUserInteractionAt: '2026-09-19T00:00:00.000Z' }));
    const created = store.getOrCreateUserSandbox('ou_1').sandbox;
    store.saveUserSandbox({
      ...created, status: 'running', containerId: 'a'.repeat(64),
      lastActiveAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:00.000Z',
    });
    const stopTaskProcess = vi.fn(async () => undefined);
    const reclaimSandbox = vi.fn(async () => undefined);
    const reclaimer = new UserSandboxReclaimer(store, { stopTaskProcess, reclaimSandbox }, {
      processIdleMs: 1, wrapperIdleMs: 1,
    }, () => now);

    await expect(reclaimer.run()).resolves.toMatchObject({ stoppedTaskIds: [], reclaimedOwnerIds: [] });
    expect(stopTaskProcess).not.toHaveBeenCalled();
    expect(reclaimSandbox).not.toHaveBeenCalled();
    store.close();
  });
});

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task_1', ownerUserId: 'ou_1', runtimeMode: 'user-sandbox', sandboxId: 'sandbox_1',
    projectId: 'repo', baseRef: 'main', branchName: 'codex/ou_1/task_1', runtimeState: 'hot',
    pinned: false, lastUserInteractionAt: '2026-09-20T11:00:00.000Z',
    createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
    ...overrides,
  };
}
