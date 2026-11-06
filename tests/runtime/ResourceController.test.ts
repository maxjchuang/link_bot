import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReadyPoolController, readySlotVersionKey, type ReadySlotRuntime } from '../../src/runtime/ReadyPoolController.js';
import { ResourceController, type HostResourceSample } from '../../src/runtime/ResourceController.js';
import { SqliteStateStore, type ReadySlotRecord } from '../../src/state/SqliteStateStore.js';
import type { TaskPoolConfig } from '../../src/domain/types.js';
import type { TaskRecord, TurnRecord } from '../../src/tasks/TaskTypes.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('ResourceController', () => {
  it('reclaims surplus READY first, then the LRU eligible task, and stops below the low watermark', async () => {
    const store = await createStore();
    store.saveTask(task('pinned_oldest', 'hot', '2026-07-28T00:00:00.000Z', { pinned: true }));
    store.saveTask(task('running_old', 'hot', '2026-07-28T00:01:00.000Z'));
    store.saveTask(task('eligible_lru', 'hot', '2026-07-28T00:02:00.000Z'));
    store.saveTask(task('target', 'warm', '2026-07-28T00:03:00.000Z'));
    store.saveTurn(turn('running_turn', 'running_old', 'running'));
    const readyRuntime = new FakeReadyRuntime();
    const readyPool = new ReadyPoolController(store, readyRuntime, { enabled: true, defaultMinReady: 1, defaultMaxReady: 2 });
    store.saveReadySlot(slot('slot_old', 'v1', '2026-07-28T00:00:00.000Z'));
    store.saveReadySlot(slot('slot_keep', 'v1', '2026-07-28T00:01:00.000Z'));
    const samples = new SequenceSampler([sample(0.85), sample(0.75), sample(0.64)]);
    const stopped: string[] = [];
    const controller = new ResourceController(store, samples, {
      gracefulStop: async (victim) => { stopped.push(victim.id); },
    }, readyPool, poolConfig());

    await expect(controller.ensureCapacityForStart('target')).resolves.toEqual({
      effectiveHotLimit: 6, discardedReadySlotIds: ['slot_old'], warmedTaskIds: ['eligible_lru'], reserved: true,
    });
    expect(readyRuntime.destroyed).toEqual(['slot_old']);
    expect(stopped).toEqual(['eligible_lru']);
    expect(store.getTask('eligible_lru')?.runtimeState).toBe('warm');
    expect(store.getTask('pinned_oldest')?.runtimeState).toBe('hot');
    expect(store.getTask('running_old')?.runtimeState).toBe('hot');
    expect(samples.calls).toBe(3);
    controller.completeHotStart('target', true);
    expect(store.getTask('target')?.runtimeState).toBe('hot');
    store.close();
  });

  it('enforces six hot reservations and four active turns under concurrent starts', async () => {
    const store = await createStore();
    for (let index = 0; index < 10; index += 1) store.saveTask(task(`task_${index}`, 'warm', `2026-07-28T00:0${index}:00.000Z`));
    const controller = new ResourceController(
      store, new SequenceSampler(Array.from({ length: 20 }, () => sample(0.5))),
      { gracefulStop: async () => undefined },
      new ReadyPoolController(store, new FakeReadyRuntime(), { enabled: false, defaultMinReady: 0, defaultMaxReady: 0 }),
      poolConfig(),
    );

    const starts = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => controller.ensureCapacityForStart(`task_${index}`)));
    expect(starts.filter((result) => result.status === 'fulfilled')).toHaveLength(6);
    expect(store.hotCapacityCount()).toBe(6);
    for (let index = 0; index < 6; index += 1) expect(controller.claimActiveTurn(`task_${index}`, `turn_${index}`)).toBe(index < 4);
    store.close();
  });

  it('counts a hot-start lifecycle intent and its lease as one capacity slot', async () => {
    const store = await createStore();
    store.saveTask(task('task_1', 'warm', NOW));
    expect(store.claimHotStart('task_1', 2)).toBe(true);
    store.beginLifecycleIntent({
      id: 'start_1', taskId: 'task_1', fromState: 'warm', toState: 'hot', status: 'pending',
      createdAt: NOW, updatedAt: NOW,
    });

    expect(store.hotCapacityCount()).toBe(1);
    store.saveTask(task('task_2', 'warm', NOW));
    expect(store.claimHotStart('task_2', 2)).toBe(true);
    expect(store.hotCapacityCount()).toBe(2);
    store.close();
  });

  it('reuses a released hot-start lease when a warm task resumes', async () => {
    const store = await createStore();
    store.saveTask(task('task_1', 'warm', NOW));

    expect(store.claimHotStart('task_1', 2)).toBe(true);
    expect(store.releaseHotStart('task_1')).toBe(true);
    expect(store.hotCapacityCount()).toBe(0);

    expect(store.claimHotStart('task_1', 2)).toBe(true);
    expect(store.hotCapacityCount()).toBe(1);
    expect(store.db.prepare("SELECT status FROM runtime_leases WHERE id='hot-start:task_1'").get())
      .toEqual({ status: 'active' });
    store.close();
  });

  it('changes LRU only on authenticated user interaction and derives a capped memory target from idle RSS P95', async () => {
    const store = await createStore();
    store.saveTask(task('task_1', 'hot', '2026-07-27T00:00:00.000Z'));
    for (let index = 0; index < 20; index += 1) store.recordResourceSample({ sampleType: 'idle_task_rss', bytes: 1_000, createdAt: '2026-07-28T01:00:00.000Z' });
    const controller = new ResourceController(
      store, new SequenceSampler([sample(0.5)]), { gracefulStop: async () => undefined },
      new ReadyPoolController(store, new FakeReadyRuntime(), { enabled: false, defaultMinReady: 0, defaultMaxReady: 0 }),
      { ...poolConfig(), safetyReserveBytes: 2_000 }, () => new Date('2026-07-28T06:00:00.000Z'),
    );
    const before = store.getTask('task_1')!.lastUserInteractionAt;
    store.recordResourceSample({ taskId: 'task_1', sampleType: 'idle_task_rss', bytes: 900 });
    expect(store.getTask('task_1')!.lastUserInteractionAt).toBe(before);
    expect(controller.touchUserInteraction('task_1')?.lastUserInteractionAt).toBe('2026-07-28T06:00:00.000Z');
    expect(controller.effectiveHotLimit({
      totalBytes: 12_000, usedBytes: 6_000, managerAndInfrastructureBytes: 1_000,
      activeTurnPeakReserveBytes: 1_000, readySlotReserveBytes: 1_000,
    })).toBe(6);
    store.close();
  });

  it('excludes every pinned or busy task class from LRU eviction', async () => {
    const store = await createStore();
    for (const id of ['pinned', 'running', 'approval', 'publishing', 'exporting', 'transitioning', 'eligible']) {
      store.saveTask(task(id, 'hot', `2026-07-28T00:0${id.length}:00.000Z`, id === 'pinned' ? { pinned: true } : {}));
    }
    store.saveTurn(turn('turn_running', 'running', 'running'));
    store.saveAppServerRequest({
      id: 'approval_1', kind: 'approval', ownerUserId: 'ou_1', taskId: 'approval', threadId: 'thread_1', turnId: 'turn_approval',
      generation: 1, serverRequestId: 'request_1', method: 'item/commandExecution/requestApproval', riskSummary: 'run', payload: {},
      status: 'pending', createdAt: NOW, expiresAt: '2026-07-28T07:00:00.000Z',
    });
    store.db.prepare(`
      INSERT INTO publish_requests(id, task_id, owner_user_id, status, idempotency_key, payload, created_at, updated_at)
      VALUES ('pub_1', 'publishing', 'ou_1', 'publishing', 'key_1', '{}', ?, ?)
    `).run(NOW, NOW);
    store.db.prepare(`
      INSERT INTO runtime_leases(id, task_id, lease_type, status, payload, created_at, updated_at)
      VALUES ('export_1', 'exporting', 'export', 'active', '{}', ?, ?)
    `).run(NOW, NOW);
    store.beginLifecycleIntent({
      id: 'transition_1', taskId: 'transitioning', fromState: 'hot', toState: 'warming', status: 'pending', createdAt: NOW, updatedAt: NOW,
    });

    expect(store.listEvictableHotTasks().map((candidate) => candidate.id)).toEqual(['eligible']);
    store.close();
  });

  it('records target latency percentiles and ten durable hot/warm tasks', async () => {
    const store = await createStore();
    for (let index = 0; index < 10; index += 1) store.saveTask(task(`durable_${index}`, index < 6 ? 'hot' : 'warm', `2026-07-28T00:0${index}:00.000Z`));
    for (const durationMs of [400, 500, 600, 700, 800]) store.recordStartupMetric({ startupType: 'ready', durationMs });
    for (const durationMs of [1_000, 1_500, 2_000, 2_500]) store.recordStartupMetric({ startupType: 'warm', durationMs });
    for (const durationMs of [5_000, 8_000, 10_000, 12_000]) store.recordStartupMetric({ startupType: 'cold', durationMs });

    expect(store.listTasks()).toHaveLength(10);
    expect(store.startupLatency('ready')).toMatchObject({ p50: 600, p95: 800 });
    expect(store.startupLatency('warm')?.p95).toBeLessThan(3_000);
    expect(store.startupLatency('cold')?.p95).toBeLessThan(15_000);
    store.close();
  });
});

describe('ReadyPoolController', () => {
  it('claims a slot once, never returns it to READY, and replenishes asynchronously', async () => {
    const store = await createStore();
    store.saveTask(task('task_1', 'warm', NOW));
    store.saveTask(task('task_2', 'warm', NOW));
    const runtime = new FakeReadyRuntime();
    const pool = new ReadyPoolController(store, runtime, { enabled: true, defaultMinReady: 1, defaultMaxReady: 2 });
    store.saveReadySlot(slot('slot_1', 'v1', NOW));

    expect(pool.claim('v1', 'task_1')).toMatchObject({ id: 'slot_1', status: 'claimed', claimedByTaskId: 'task_1' });
    expect(pool.claim('v1', 'task_2')).toBeUndefined();
    await pool.waitForReplenishment();
    expect(store.listReadySlots('v1')).toHaveLength(1);
    expect(store.db.prepare("SELECT status FROM ready_slots WHERE id='slot_1'").get()).toEqual({ status: 'claimed' });
    store.close();
  });

  it('builds stable version keys from every compatibility dimension', () => {
    const input = {
      projectId: 'repo', runtimeImageVersion: '0.1', codexCliVersion: '0.145.0',
      baseCommit: 'abc', dependencyLockHash: 'lock', setupVersion: '1',
    };
    expect(readySlotVersionKey(input)).toBe(readySlotVersionKey(input));
    expect(readySlotVersionKey({ ...input, baseCommit: 'def' })).not.toBe(readySlotVersionKey(input));
  });

  it('serializes concurrent replenishment for one version without exceeding the target', async () => {
    const store = await createStore();
    const runtime = new FakeReadyRuntime();
    const pool = new ReadyPoolController(store, runtime, { enabled: true, defaultMinReady: 1, defaultMaxReady: 2 });

    await Promise.all(Array.from({ length: 12 }, () => pool.replenish('v1')));

    expect(runtime.created).toBe(1);
    expect(store.listReadySlots('v1')).toHaveLength(1);
    store.close();
  });

  it('reclaims only a version group with slots above its minimum', async () => {
    const store = await createStore();
    const runtime = new FakeReadyRuntime();
    const pool = new ReadyPoolController(store, runtime, { enabled: true, defaultMinReady: 1, defaultMaxReady: 2 });
    store.saveReadySlot(slot('v1_only', 'v1', '2026-07-28T00:00:00.000Z'));
    store.saveReadySlot(slot('v2_old', 'v2', '2026-07-28T00:01:00.000Z'));
    store.saveReadySlot(slot('v2_new', 'v2', '2026-07-28T00:02:00.000Z'));

    await expect(pool.reclaimOneSurplus()).resolves.toMatchObject({ id: 'v2_old', status: 'discarded' });
    expect(store.listReadySlots('v1').map((ready) => ready.id)).toEqual(['v1_only']);
    store.close();
  });
});

const NOW = '2026-07-28T06:00:00.000Z';

async function createStore(): Promise<SqliteStateStore> {
  return new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'), () => new Date(NOW));
}

function task(id: string, runtimeState: TaskRecord['runtimeState'], lastUserInteractionAt: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id, ownerUserId: 'ou_1', projectId: 'repo', baseRef: 'main', branchName: `codex/ou_1/${id}`,
    runtimeState, pinned: false, lastUserInteractionAt, createdAt: lastUserInteractionAt, updatedAt: lastUserInteractionAt, ...overrides,
  };
}

function turn(id: string, taskId: string, state: TurnRecord['state']): TurnRecord {
  return { id, taskId, state, prompt: 'work', createdBy: 'ou_1', createdAt: NOW, updatedAt: NOW };
}

function slot(id: string, versionKey: string, createdAt: string): ReadySlotRecord {
  return { id, versionKey, status: 'ready', createdAt, updatedAt: createdAt };
}

function sample(ratio: number): HostResourceSample {
  return {
    totalBytes: 10_000, usedBytes: 10_000 * ratio, managerAndInfrastructureBytes: 1_000,
    activeTurnPeakReserveBytes: 1_000, readySlotReserveBytes: 1_000,
  };
}

function poolConfig(): TaskPoolConfig {
  return {
    maxHotTasks: 6, maxActiveTurns: 4, memoryHighWatermark: 0.8, memoryLowWatermark: 0.65,
    safetyReserveBytes: 2_000, idleMemorySampleWindowDays: 7,
  };
}

class SequenceSampler {
  calls = 0;
  constructor(private readonly samples: HostResourceSample[]) {}
  async sample(): Promise<HostResourceSample> {
    return this.samples[Math.min(this.calls++, this.samples.length - 1)]!;
  }
}

class FakeReadyRuntime implements ReadySlotRuntime {
  readonly destroyed: string[] = [];
  created = 0;
  async create(versionKey: string): Promise<ReadySlotRecord> {
    this.created += 1;
    return slot(`created_${this.created}`, versionKey, NOW);
  }
  async destroy(slotRecord: ReadySlotRecord): Promise<void> { this.destroyed.push(slotRecord.id); }
}
