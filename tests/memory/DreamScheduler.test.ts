import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DreamScheduler } from '../../src/memory/DreamScheduler.js';
import { SqliteStateStore } from '../../src/state/SqliteStateStore.js';
import type { TaskRecord } from '../../src/tasks/TaskTypes.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('DreamScheduler', () => {
  it('enqueues exactly once at the configured local 02:00 boundary and reconciles a missed schedule', async () => {
    let now = new Date('2026-07-27T17:59:59.999Z');
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'), () => now);
    store.saveTask(task('task_1'));
    store.appendTurnEvent({ eventKey: 'message_1', taskId: 'task_1', eventType: 'user.message', payload: { text: 'remember alpha' } });
    const scheduler = new DreamScheduler(store, { timezone: 'Asia/Shanghai', startAfter: '02:00' }, () => now);

    expect(scheduler.reconcile()).toEqual([]);
    now = new Date('2026-07-27T18:00:00.000Z');
    expect(scheduler.reconcile()).toHaveLength(1);
    expect(store.listDreamJobs()).toHaveLength(1);
    expect(scheduler.reconcile()).toEqual([]);

    now = new Date('2026-07-28T06:00:00.000Z');
    expect(scheduler.reconcile()).toEqual([]);
    store.close();
  });

  it('uses IANA timezone rules across a DST transition and rejects invalid zones', async () => {
    let now = new Date('2026-03-08T06:59:59.000Z');
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'), () => now);
    store.saveTask(task('task_dst'));
    store.appendTurnEvent({ eventKey: 'message_dst', taskId: 'task_dst', eventType: 'user.message', payload: { text: 'dst event' } });
    const scheduler = new DreamScheduler(store, { timezone: 'America/New_York', startAfter: '02:00' }, () => now);
    expect(scheduler.reconcile()).toEqual([]);
    now = new Date('2026-03-08T07:00:00.000Z');
    expect(scheduler.reconcile()).toHaveLength(1);
    expect(() => new DreamScheduler(store, { timezone: 'Mars/Olympus', startAfter: '02:00' })).toThrow('Invalid Dream timezone');
    store.close();
  });

  it('does not enqueue for noisy or oversized ineligible events', async () => {
    const now = new Date('2026-07-28T06:00:00.000Z');
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'), () => now);
    store.saveTask(task('task_1'));
    store.appendTurnEvent({ eventKey: 'delta', taskId: 'task_1', eventType: 'item.delta', payload: { text: 'x'.repeat(20_000) } });
    expect(new DreamScheduler(store, undefined, () => now).reconcile()).toEqual([]);
    store.close();
  });

  it('interrupts a running job on startup without duplicating the deterministic schedule', async () => {
    const now = new Date('2026-07-28T06:00:00.000Z');
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'), () => now);
    store.saveTask(task('task_1'));
    store.appendTurnEvent({ eventKey: 'message_1', taskId: 'task_1', eventType: 'user.message', payload: { text: 'alpha' } });
    const scheduler = new DreamScheduler(store, undefined, () => now);
    expect(scheduler.reconcile()).toHaveLength(1);
    expect(store.claimNextDreamJob()).toMatchObject({ status: 'running' });
    expect(scheduler.reconcileStartup()).toEqual([]);
    expect(store.listDreamJobs()).toMatchObject([{ status: 'interrupted', lastErrorCode: 'manager_restart' }]);
    store.close();
  });
});

const NOW = '2026-07-28T06:00:00.000Z';

function task(id: string): TaskRecord {
  return {
    id, ownerUserId: 'ou_1', projectId: 'repo', baseRef: 'main', branchName: `codex/ou_1/${id}`,
    runtimeState: 'hot', pinned: false, lastUserInteractionAt: NOW, createdAt: NOW, updatedAt: NOW,
  };
}
