import { describe,expect,it,vi } from 'vitest';
import type { DiskPolicyConfig } from '../../src/domain/types.js';
import { FeishuOutbox } from '../../src/feishu/FeishuOutbox.js';
import { TaskPlatformDiagnostics } from '../../src/observability/TaskPlatformDiagnostics.js';
import type { DockerManagedTaskResources,DockerTaskRuntime } from '../../src/runtime/DockerRuntime.js';
import { TaskDiskCleanupController } from '../../src/runtime/TaskDiskCleanupController.js';
import { SqliteStateStore } from '../../src/state/SqliteStateStore.js';
import type { TaskRecord } from '../../src/tasks/TaskTypes.js';
import { createTmpDir } from '../helpers/tmp.js';

const config: DiskPolicyConfig = {
  enabled: true, filesystemPath: '/docker', scanIntervalMs: 900_000, inventoryIntervalMs: 21_600_000,
  inventoryTimeoutMs: 300_000,
  warningWatermark: 0.7, highWatermark: 0.8, lowWatermark: 0.65, minimumFreeBytes: 20,
  attributionEnabled: true, cleanupEnabled: true,
  taskSoftLimitBytes: 100, userSoftLimitBytes: 500,
  warmRetentionDays: 30, warmRetentionWarningDays: 3, autoDeleteWarmTasks: true,
  maxCleanupTasksPerPass: 5, orphanGraceHours: 24,
};

describe('TaskDiskCleanupController', () => {
  it('attributes managed bytes and deletes archived resources by exact runtime id', async () => {
    const fixture = await createFixture('2026-08-11T00:00:00.000Z');
    fixture.store.saveTask(task('task_archived', 'archived'));
    fixture.docker.resources = [resources('task_archived', '2026-08-01T00:00:00.000Z')];
    fixture.docker.bytes.set('task_archived', 120);
    fixture.diagnostics.setMetric('link_bot_task_disk_bytes', 999, { taskId: 'legacy' });
    fixture.diagnostics.setMetric('link_bot_user_task_disk_bytes', 999, { ownerUserId: 'stale_owner' });

    const inventory = await fixture.controller.inventory();
    const result = await fixture.controller.run();

    expect(result).toMatchObject({ inventoried: 1, measured: 0, cleaned: 1, failed: 0 });
    expect(inventory.managedBytes).toBe(120);
    expect(fixture.docker.removed).toEqual(['task_archived']);
    expect(metric(fixture.store, 'link_bot_user_task_disk_bytes', { ownerUserId: 'ou_owner' })).toBe(120);
    expect(auditTypes(fixture.store)).toContain('runtime.task_disk_soft_limit_exceeded');
    fixture.store.close();
  });

  it('defers failed cleanup while a nonterminal turn is present', async () => {
    const fixture = await createFixture('2026-08-11T00:00:00.000Z');
    fixture.store.saveTask(task('task_failed', 'failed'));
    fixture.store.saveTurn({
      id: 'turn_running', taskId: 'task_failed', state: 'running', prompt: 'work', createdBy: 'ou_owner',
      createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z',
    });

    const result = await fixture.controller.run();

    expect(result.deferred).toBe(1);
    expect(fixture.docker.removed).toEqual([]);
    expect(fixture.store.getTask('task_failed')?.runtimeState).toBe('failed');
    fixture.store.close();
  });

  it('removes only confirmed orphans older than the grace period', async () => {
    const fixture = await createFixture('2026-08-11T00:00:00.000Z');
    fixture.docker.resources = [
      resources('task_old_orphan', '2026-08-09T00:00:00.000Z'),
      resources('task_new_orphan', '2026-08-10T12:00:00.000Z'),
    ];

    const result = await fixture.controller.run();

    expect(result.cleaned).toBe(1);
    expect(fixture.docker.removed).toEqual(['task_old_orphan']);
    fixture.store.close();
  });

  it('silently deletes an expired warm task and leaves traceable audit events', async () => {
    let now = new Date('2026-08-01T00:00:00.000Z');
    const fixture = await createFixture(now.toISOString(), () => now);
    fixture.store.saveTask(task('task_warm', 'warm', '2026-07-04T00:00:00.000Z'));
    fixture.docker.resources = [resources('task_warm', '2026-07-04T00:00:00.000Z')];

    const first = await fixture.controller.run();
    expect(first).toMatchObject({ warningsEnqueued: 0, cleaned: 0 });
    expect(fixture.outbox.pending()).toEqual([]);

    now = new Date('2026-08-04T00:00:00.000Z');
    const second = await fixture.controller.run();

    expect(second.cleaned).toBe(1);
    expect(second.warningsEnqueued).toBe(0);
    expect(fixture.outbox.pending()).toEqual([]);
    expect(fixture.docker.removed).toEqual(['task_warm']);
    expect(fixture.store.getTask('task_warm')?.runtimeState).toBe('archived');
    expect(fixture.store.getTask('task_warm')?.archiveReason).toBe('warm_retention_expired');
    expect(fixture.store.listPendingLifecycleIntents()).toEqual([]);
    expect(auditPayloads(fixture.store, 'runtime.warm_retention_expired')).toContainEqual(expect.objectContaining({
      taskId: 'task_warm', ownerUserId: 'ou_owner', expiresAt: '2026-08-03T00:00:00.000Z',
    }));
    expect(auditPayloads(fixture.store, 'runtime.disk_cleanup_completed')).toContainEqual(expect.objectContaining({
      kind: 'expired_warm', taskId: 'task_warm', ownerUserId: 'ou_owner',
      lastUserInteractionAt: '2026-07-04T00:00:00.000Z', expiresAt: '2026-08-03T00:00:00.000Z',
    }));
    fixture.store.close();
  });

  it('reconciles the original state when Docker deletion fails', async () => {
    const fixture = await createFixture('2026-08-11T00:00:00.000Z');
    fixture.store.saveTask(task('task_failed', 'failed'));
    fixture.docker.removeError = new Error('volume is busy');

    const result = await fixture.controller.run();

    expect(result.failed).toBe(1);
    expect(fixture.store.getTask('task_failed')?.runtimeState).toBe('failed');
    expect(fixture.store.listPendingLifecycleIntents()).toEqual([]);
    expect(auditTypes(fixture.store)).toContain('runtime.disk_cleanup_failed');
    fixture.store.close();
  });

  it('retains a pending lifecycle intent when SQLite completion fails after Docker deletion', async () => {
    const fixture = await createFixture('2026-08-11T00:00:00.000Z');
    fixture.store.saveTask(task('task_failed', 'failed'));
    vi.spyOn(fixture.store, 'completeLifecycleIntent').mockImplementation(() => {
      throw new Error('database write failed');
    });

    const result = await fixture.controller.run();

    expect(result.failed).toBe(1);
    expect(fixture.docker.removed).toEqual(['task_failed']);
    expect(fixture.store.getTask('task_failed')?.runtimeState).toBe('archived');
    expect(fixture.store.listPendingLifecycleIntents()).toHaveLength(1);
    fixture.store.close();
  });

  it('returns a dry-run inventory with candidate metrics without deleting resources', async () => {
    let monotonic = 10;
    const fixture = await createFixture('2026-08-11T00:00:00.000Z', undefined, undefined, () => {
      monotonic += 5;
      return monotonic;
    });
    fixture.store.saveTask(task('task_archived', 'archived'));
    fixture.docker.resources = [resources('task_archived', '2026-08-01T00:00:00.000Z')];
    fixture.docker.bytes.set('task_archived', 120);

    const report = await fixture.controller.inventory();

    expect(report).toMatchObject({
      durationMs: 5, managedBytes: 120, reclaimableBytes: 120,
      candidateCounts: { archived: 1, failed_without_thread: 0, orphan: 0, expired_warm: 0 },
      entries: [expect.objectContaining({ taskId: 'task_archived', measuredBytes: 120, candidateKind: 'archived' })],
    });
    expect(fixture.docker.removed).toEqual([]);
    expect(metric(fixture.store, 'link_bot_disk_cleanup_candidates', { kind: 'archived' })).toBe(1);
    expect(metric(fixture.store, 'link_bot_disk_inventory_duration_ms', {})).toBe(5);
    expect(fixture.store.db.prepare("SELECT COUNT(*) AS count FROM metrics WHERE name='link_bot_task_disk_bytes'").get())
      .toEqual({ count: 0 });
    expect(fixture.store.db.prepare("SELECT COUNT(*) AS count FROM metrics WHERE name='link_bot_user_task_disk_bytes'").get())
      .toEqual({ count: 1 });
    fixture.store.close();
  });

  it('resamples after every pressure deletion and stops when the low-watermark callback reports recovery', async () => {
    const fixture = await createFixture('2026-08-11T00:00:00.000Z');
    for (const id of ['task_archived_1', 'task_archived_2', 'task_archived_3']) {
      fixture.store.saveTask(task(id, 'archived'));
      fixture.docker.resources.push(resources(id, '2026-08-01T00:00:00.000Z'));
      fixture.docker.bytes.set(id, 100);
    }
    const continueCleanup = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const result = await fixture.controller.run({ mode: 'pressure', continueCleanup });

    expect(result).toMatchObject({ cleaned: 2, reclaimedBytes: 0, pressureRelieved: true });
    expect(fixture.docker.removed).toHaveLength(2);
    expect(continueCleanup).toHaveBeenCalledTimes(2);
    fixture.store.close();
  });

  it('bounds a pressure pass even while pressure remains high', async () => {
    const fixture = await createFixture('2026-08-11T00:00:00.000Z', undefined, { maxCleanupTasksPerPass: 1 });
    for (const id of ['task_archived_1', 'task_archived_2']) {
      fixture.store.saveTask(task(id, 'archived'));
      fixture.docker.resources.push(resources(id, '2026-08-01T00:00:00.000Z'));
    }

    const result = await fixture.controller.run({ mode: 'pressure', continueCleanup: async () => true });

    expect(result).toMatchObject({ cleaned: 1, pressureRelieved: false });
    expect(fixture.docker.removed).toHaveLength(1);
    expect(auditTypes(fixture.store)).toContain('runtime.disk_pressure_cleanup_exhausted');
    fixture.store.close();
  });

  it('keeps scanning after blocked candidates and only counts successful deletions against the pass limit', async () => {
    const fixture = await createFixture('2026-08-11T00:00:00.000Z', undefined, {
      maxCleanupTasksPerPass: 1,
      maxCleanupCandidatesScannedPerPass: 10,
    });
    for (const id of ['task_archived_blocked_1', 'task_archived_blocked_2', 'task_archived_cleanable']) {
      fixture.store.saveTask(task(id, 'archived'));
      fixture.docker.resources.push(resources(id, '2026-08-01T00:00:00.000Z'));
    }
    vi.spyOn(fixture.store, 'taskCleanupBlockers').mockImplementation((taskId) =>
      taskId.includes('blocked') ? ['publish'] : []);

    const result = await fixture.controller.run({ mode: 'pressure', continueCleanup: async () => true });

    expect(result).toMatchObject({ cleaned: 1, deferred: 2, scanned: 3, pressureRelieved: false });
    expect(fixture.docker.removed).toEqual(['task_archived_cleanable']);
    fixture.store.close();
  });

  it('bounds the number of inspected candidates separately from the deletion budget', async () => {
    const fixture = await createFixture('2026-08-11T00:00:00.000Z', undefined, {
      maxCleanupTasksPerPass: 1,
      maxCleanupCandidatesScannedPerPass: 2,
    });
    for (const id of ['task_archived_blocked_1', 'task_archived_blocked_2', 'task_archived_cleanable']) {
      fixture.store.saveTask(task(id, 'archived'));
      fixture.docker.resources.push(resources(id, '2026-08-01T00:00:00.000Z'));
    }
    vi.spyOn(fixture.store, 'taskCleanupBlockers').mockImplementation((taskId) =>
      taskId.includes('blocked') ? ['publish'] : []);

    const result = await fixture.controller.run({ mode: 'pressure', continueCleanup: async () => true });

    expect(result).toMatchObject({ cleaned: 0, deferred: 2, scanned: 2, pressureRelieved: false });
    expect(fixture.docker.removed).toEqual([]);
    fixture.store.close();
  });

  it('prefers the larger measured candidate when last interaction timestamps tie', async () => {
    const fixture = await createFixture('2026-08-11T00:00:00.000Z', undefined, { maxCleanupTasksPerPass: 1 });
    for (const [id, bytes] of [['task_archived_small', 10], ['task_archived_large', 100]] as const) {
      fixture.store.saveTask(task(id, 'archived'));
      fixture.docker.resources.push(resources(id, '2026-08-01T00:00:00.000Z'));
      fixture.docker.bytes.set(id, bytes);
    }

    await fixture.controller.run();

    expect(fixture.docker.removed).toEqual(['task_archived_large']);
    fixture.store.close();
  });

  it('restricts a confirmed exact pass to named eligible task IDs', async () => {
    const fixture = await createFixture('2026-08-11T00:00:00.000Z');
    for (const id of ['task_archived_1', 'task_archived_2']) {
      fixture.store.saveTask(task(id, 'archived'));
      fixture.docker.resources.push(resources(id, '2026-08-01T00:00:00.000Z'));
      fixture.docker.bytes.set(id, 100);
    }

    const result = await fixture.controller.run({ exactTaskIds: ['task_archived_2'] });

    expect(result).toMatchObject({ requested: 1, eligible: 1, cleaned: 1, reclaimedBytes: 0 });
    expect(fixture.docker.removed).toEqual(['task_archived_2']);
    fixture.store.close();
  });

  it('refuses cleanup when the deterministic task container is running', async () => {
    const fixture = await createFixture('2026-08-11T00:00:00.000Z');
    fixture.store.saveTask(task('task_archived', 'archived'));
    fixture.docker.resources = [resources('task_archived', '2026-08-01T00:00:00.000Z')];
    fixture.docker.observed = 'running';

    const result = await fixture.controller.run();

    expect(result.deferred).toBe(1);
    expect(fixture.docker.removed).toEqual([]);
    expect(auditPayloads(fixture.store, 'runtime.disk_cleanup_deferred'))
      .toContainEqual(expect.objectContaining({ blockers: ['running_container'] }));
    fixture.store.close();
  });

  it('aborts a stuck detailed inventory and records an inventory-phase failure', async () => {
    const fixture = await createFixture('2026-08-11T00:00:00.000Z');
    fixture.docker.blockInventory = true;
    const abort = new AbortController();

    const pending = fixture.controller.inventory(abort.signal);
    abort.abort(new Error('inventory timeout'));

    await expect(pending).rejects.toThrow('inventory timeout');
    expect(metric(fixture.store, 'link_bot_disk_cleanup_failures', { phase: 'inventory' })).toBe(1);
    expect(auditTypes(fixture.store)).toContain('runtime.disk_inventory_failed');
    fixture.store.close();
  });

  it('does not run detailed volume attribution before routine cleanup', async () => {
    const fixture = await createFixture('2026-08-11T00:00:00.000Z');
    fixture.store.saveTask(task('task_archived', 'archived'));
    fixture.docker.resources = [resources('task_archived', '2026-08-01T00:00:00.000Z')];
    fixture.docker.blockMeasurement = true;

    const result = await fixture.controller.run();

    expect(result).toMatchObject({ inventoried: 1, measured: 0, cleaned: 1 });
    expect(fixture.docker.removed).toEqual(['task_archived']);
    fixture.store.close();
  });

  it('returns a partial detailed inventory when its measurement budget expires', async () => {
    const fixture = await createFixture('2026-08-11T00:00:00.000Z');
    fixture.docker.resources = [
      resources('task_measured', '2026-08-01T00:00:00.000Z'),
      resources('task_blocked', '2026-08-01T00:00:00.000Z'),
    ];
    fixture.docker.bytes.set('task_measured', 120);
    fixture.docker.blockMeasurementFor = 'task_blocked';
    const abort = new AbortController();
    const pending = fixture.controller.inventory(abort.signal);
    await vi.waitFor(() => expect(fixture.docker.measurementStarted).toContain('task_blocked'));
    abort.abort(new Error('inventory budget exhausted'));

    const report = await pending;

    expect(report.entries).toContainEqual(expect.objectContaining({ runtimeId: 'task_measured', measuredBytes: 120 }));
    expect(report.entries).toContainEqual(expect.objectContaining({ runtimeId: 'task_blocked' }));
    expect(auditTypes(fixture.store)).toContain('runtime.disk_inventory_partial');
    expect(auditTypes(fixture.store)).not.toContain('runtime.disk_inventory_failed');
    fixture.store.close();
  });
});

async function createFixture(
  initialNow: string,
  suppliedClock?: () => Date,
  configOverrides?: Partial<DiskPolicyConfig>,
  monotonicClock?: () => number,
) {
  let fixed = new Date(initialNow);
  const clock = suppliedClock ?? (() => fixed);
  const root = await createTmpDir();
  const store = new SqliteStateStore(`${root}/state.sqlite`, clock);
  const docker = new FakeTaskDiskDocker();
  const outbox = new FeishuOutbox(store, { deliver: vi.fn(async () => undefined) }, clock);
  const diagnostics = new TaskPlatformDiagnostics(store, clock);
  const controller = new TaskDiskCleanupController(
    { ...config, ...configOverrides }, store, docker, diagnostics, clock, monotonicClock,
  );
  return { store, docker, outbox, diagnostics, controller, setNow: (value: Date) => { fixed = value; } };
}

class FakeTaskDiskDocker {
  resources: DockerManagedTaskResources[] = [];
  bytes = new Map<string, number>();
  removed: string[] = [];
  removeError?: Error;
  observed: 'running' | 'stopped' | 'missing' = 'missing';
  blockInventory = false;
  blockMeasurement = false;
  blockMeasurementFor?: string;
  measurementStarted: string[] = [];

  async listManagedTaskResources(signal?: AbortSignal): Promise<DockerManagedTaskResources[]> {
    if (this.blockInventory) {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    return this.resources.filter((item) => !this.removed.includes(item.runtimeId));
  }

  async measureManagedTaskBytes(item: DockerManagedTaskResources): Promise<number> {
    return this.bytes.get(item.runtimeId) ?? 0;
  }

  async measureManagedTaskVolumeBytes(item: DockerManagedTaskResources, signal?: AbortSignal) {
    this.measurementStarted.push(item.runtimeId);
    if (this.blockMeasurement || this.blockMeasurementFor === item.runtimeId) {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    const workspaceBytes = this.bytes.get(item.runtimeId) ?? 0;
    return { workspaceBytes, codexHomeBytes: 0, totalBytes: workspaceBytes };
  }

  describe(runtimeId: string): DockerTaskRuntime {
    return {
      taskId: runtimeId, containerName: `link-bot-${runtimeId}`,
      workspaceVolume: `link-bot-${runtimeId}-workspace`, codexHomeVolume: `link-bot-${runtimeId}-codex-home`,
      socketDirectory: `/sockets/${runtimeId}`, socketPath: `/sockets/${runtimeId}/app.sock`,
    };
  }

  async observeForCleanup(): Promise<'running' | 'stopped' | 'missing'> {
    return this.observed;
  }

  async removeTask(runtime: DockerTaskRuntime): Promise<void> {
    if (this.removeError) throw this.removeError;
    this.removed.push(runtime.taskId);
  }
}

function task(id: string, runtimeState: TaskRecord['runtimeState'], lastUserInteractionAt = '2026-07-01T00:00:00.000Z'): TaskRecord {
  return {
    id, ownerUserId: 'ou_owner', projectId: 'repo', baseRef: 'main', branchName: `codex/${id}`,
    runtimeId: id, runtimeState, pinned: false, lastUserInteractionAt,
    createdAt: lastUserInteractionAt, updatedAt: lastUserInteractionAt,
  };
}

function resources(runtimeId: string, createdAt: string): DockerManagedTaskResources {
  return {
    runtimeId, createdAt,
    workspaceVolume: `link-bot-${runtimeId}-workspace`,
    codexHomeVolume: `link-bot-${runtimeId}-codex-home`,
  };
}

function metric(store: SqliteStateStore, name: string, labels: Record<string, string>): number | undefined {
  const key = JSON.stringify(Object.fromEntries(Object.entries(labels).sort()));
  return (store.db.prepare('SELECT value FROM metrics WHERE name=? AND labels=?').get(name, key) as { value: number } | undefined)?.value;
}

function auditTypes(store: SqliteStateStore): string[] {
  return (store.db.prepare('SELECT event_type AS eventType FROM audit_events ORDER BY sequence').all() as Array<{ eventType: string }>)
    .map((row) => row.eventType);
}

function auditPayloads(store: SqliteStateStore, eventType: string): Array<Record<string, unknown>> {
  return (store.db.prepare('SELECT payload FROM audit_events WHERE event_type=? ORDER BY sequence').all(eventType) as Array<{ payload: string }>)
    .map((row) => JSON.parse(row.payload) as Record<string, unknown>);
}
