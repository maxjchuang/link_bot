import { randomUUID } from 'node:crypto';
import type { DiskPolicyConfig } from '../domain/types.js';
import type { TaskPlatformDiagnostics } from '../observability/TaskPlatformDiagnostics.js';
import type { SqliteStateStore } from '../state/SqliteStateStore.js';
import type { TaskRecord, TaskRuntimeState } from '../tasks/TaskTypes.js';
import type {
  DockerManagedTaskResources,
  DockerManagedTaskVolumeBytes,
  DockerRuntime,
} from './DockerRuntime.js';

export type CleanupKind = 'archived' | 'failed_without_thread' | 'orphan' | 'expired_warm';

export interface TaskDiskMaintenanceSummary {
  inventoried: number;
  measured: number;
  warningsEnqueued: number;
  cleaned: number;
  deferred: number;
  failed: number;
  reclaimedBytes: number;
  requested?: number;
  eligible?: number;
  pressureRelieved?: boolean;
  scanned?: number;
}

export interface TaskDiskInventoryEntry {
  runtimeId: string;
  taskId?: string;
  ownerUserId?: string;
  state?: TaskRuntimeState;
  createdAt?: string;
  lastUserInteractionAt?: string;
  workspaceVolume?: string;
  codexHomeVolume?: string;
  workspaceBytes?: number;
  codexHomeBytes?: number;
  measuredBytes?: number;
  orphan: boolean;
  candidateKind?: CleanupKind;
  blockers: string[];
}

export interface TaskDiskInventoryReport {
  generatedAt: string;
  durationMs: number;
  managedBytes: number;
  orphanBytes: number;
  reclaimableBytes: number;
  candidateCounts: Record<CleanupKind, number>;
  entries: TaskDiskInventoryEntry[];
}

export interface TaskDiskMaintenanceOptions {
  mode?: 'routine' | 'pressure';
  signal?: AbortSignal;
  /** Return true while pressure cleanup should continue after a successful deletion. */
  continueCleanup?: () => Promise<boolean>;
  /** Restrict a manually-confirmed pass to these exact task IDs. Orphans are never selected by this mode. */
  exactTaskIds?: string[];
}

type TaskCandidate = { kind: Exclude<CleanupKind, 'orphan'>; taskId: string; runtimeId: string };
type OrphanCandidate = { kind: 'orphan'; runtimeId: string; createdAt?: string };

export class TaskDiskCleanupController {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: DiskPolicyConfig,
    private readonly store: SqliteStateStore,
    private readonly docker: Pick<DockerRuntime, 'describe' | 'listManagedTaskResources' | 'measureManagedTaskVolumeBytes' | 'observeForCleanup' | 'removeTask'>,
    private readonly diagnostics: Pick<TaskPlatformDiagnostics, 'setMetric' | 'clearMetrics' | 'audit'>,
    private readonly clock: () => Date = () => new Date(),
    private readonly monotonicClock: () => number = () => performance.now(),
  ) {}

  inventory(signal?: AbortSignal): Promise<TaskDiskInventoryReport> {
    if (!this.config.enabled) return Promise.resolve(emptyInventory(this.clock().toISOString()));
    return this.enqueue(async () => (await this.collectInventory(signal, true)).report);
  }

  run(options: TaskDiskMaintenanceOptions = {}): Promise<TaskDiskMaintenanceSummary> {
    if (!this.config.enabled || (!this.config.attributionEnabled && !this.config.cleanupEnabled)) {
      return Promise.resolve(emptySummary());
    }
    return this.enqueue(() => this.maintain(options));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async maintain(options: TaskDiskMaintenanceOptions): Promise<TaskDiskMaintenanceSummary> {
    const summary = emptySummary();
    // Routine and pressure cleanup must not wait for an expensive per-volume
    // attribution pass. A separate inventory tick collects those details.
    const collected = await this.collectInventory(options.signal, false);
    const { resources, tasks, taskByRuntime, bytesByRuntime } = collected;
    summary.inventoried = resources.length;
    summary.measured = bytesByRuntime.size;
    if (!this.config.cleanupEnabled) return summary;

    for (const request of this.store.expirePendingPublishRequests(this.clock().toISOString())) {
      this.diagnostics.audit('runtime.publish_blocker_reconciled', { ...request }, `publish-expired:${request.id}`);
    }

    const allCandidates = this.candidates(tasks, resources, taskByRuntime, bytesByRuntime);
    const exactTaskIds = options.exactTaskIds
      ? [...new Set(options.exactTaskIds)]
      : undefined;
    const candidates = exactTaskIds
      ? allCandidates.filter((candidate): candidate is TaskCandidate => candidate.kind !== 'orphan'
        && exactTaskIds.includes(candidate.taskId))
      : allCandidates;
    if (exactTaskIds) {
      summary.requested = exactTaskIds.length;
      summary.eligible = candidates.length;
    }
    let pressureRemaining = options.mode === 'pressure';
    const scanLimit = exactTaskIds
      ? candidates.length
      : Math.max(
        this.config.maxCleanupTasksPerPass,
        this.config.maxCleanupCandidatesScannedPerPass ?? 100,
      );
    for (const candidate of candidates) {
      if (options.mode === 'pressure' && !pressureRemaining) break;
      if ((summary.scanned ?? 0) >= scanLimit || summary.cleaned >= this.config.maxCleanupTasksPerPass) break;
      summary.scanned = (summary.scanned ?? 0) + 1;
      if (candidate.kind === 'expired_warm') {
        const task = this.store.getTask(candidate.taskId);
        if (task) {
          this.diagnostics.audit('runtime.warm_retention_expired', {
            taskId: task.id,
            runtimeId: candidate.runtimeId,
            ownerUserId: task.ownerUserId,
            lastUserInteractionAt: task.lastUserInteractionAt,
            expiresAt: new Date(retentionExpiry(task, this.config.warmRetentionDays)).toISOString(),
          }, `warm-retention-expired:${task.id}:${task.lastUserInteractionAt}`);
        }
      }
      try {
        const outcome = candidate.kind === 'orphan'
          ? await this.cleanupOrphan(candidate)
          : await this.cleanupTask(candidate);
        summary[outcome] += 1;
        if (outcome === 'cleaned') {
          summary.reclaimedBytes += bytesByRuntime.get(candidate.runtimeId) ?? 0;
          if (options.mode === 'pressure') {
            pressureRemaining = options.continueCleanup ? await options.continueCleanup() : true;
          }
        }
      } catch (error) {
        summary.failed += 1;
        this.diagnostics.audit('runtime.disk_cleanup_failed', {
          kind: candidate.kind,
          taskId: candidate.kind === 'orphan' ? undefined : candidate.taskId,
          runtimeId: candidate.runtimeId,
          error: safeError(error),
        });
      }
    }
    this.diagnostics.setMetric('link_bot_disk_cleanup_last_cleaned', summary.cleaned);
    this.diagnostics.setMetric('link_bot_disk_cleanup_last_deferred', summary.deferred);
    this.diagnostics.setMetric('link_bot_disk_cleanup_last_failed', summary.failed);
    this.diagnostics.setMetric('link_bot_disk_cleanup_reclaimed_bytes', summary.reclaimedBytes);
    this.diagnostics.setMetric('link_bot_disk_cleanup_failures', summary.failed, { phase: 'candidate' });
    if (options.mode === 'pressure') {
      summary.pressureRelieved = !pressureRemaining;
      if (pressureRemaining) {
        this.diagnostics.audit('runtime.disk_pressure_cleanup_exhausted', {
          candidateCount: candidates.length,
          scanned: summary.scanned ?? 0,
          cleaned: summary.cleaned,
          deferred: summary.deferred,
          failed: summary.failed,
          maxCleanupTasksPerPass: this.config.maxCleanupTasksPerPass,
        });
      }
    }
    return summary;
  }

  private async collectInventory(signal?: AbortSignal, includeAttribution = true): Promise<{
    report: TaskDiskInventoryReport;
    resources: DockerManagedTaskResources[];
    tasks: TaskRecord[];
    taskByRuntime: Map<string, TaskRecord>;
    bytesByRuntime: Map<string, number>;
  }> {
    const startedAt = this.monotonicClock();
    try {
      signal?.throwIfAborted();
      const resources = await this.docker.listManagedTaskResources(signal);
      const tasks = this.store.listTasks();
      const taskByRuntime = new Map(tasks.map((task) => [task.runtimeId ?? task.id, task]));
      const summary = emptySummary();
      this.diagnostics.setMetric('link_bot_managed_task_resource_sets', resources.length);
      this.diagnostics.setMetric('link_bot_orphan_task_resource_sets', resources.filter((item) => !taskByRuntime.has(item.runtimeId)).length);
      const volumeBytesByRuntime = this.config.attributionEnabled && includeAttribution
        ? await this.measure(resources, taskByRuntime, summary, signal)
        : new Map<string, DockerManagedTaskVolumeBytes>();
      const bytesByRuntime = new Map([...volumeBytesByRuntime].map(([runtimeId, measured]) => [runtimeId, measured.totalBytes]));
      const candidates = this.candidates(tasks, resources, taskByRuntime, bytesByRuntime);
      const candidateCounts = emptyCandidateCounts();
      for (const candidate of candidates) candidateCounts[candidate.kind] += 1;
      for (const kind of cleanupKinds) {
        this.diagnostics.setMetric('link_bot_disk_cleanup_candidates', candidateCounts[kind], { kind });
      }
      const candidateByRuntime = new Map(candidates.map((candidate) => [candidate.runtimeId, candidate.kind]));
      const durationMs = Math.max(0, this.monotonicClock() - startedAt);
      this.diagnostics.setMetric('link_bot_disk_inventory_duration_ms', durationMs);
      this.diagnostics.setMetric('link_bot_disk_cleanup_failures', 0, { phase: 'inventory' });
      const managedBytes = [...bytesByRuntime.values()].reduce((sum, bytes) => sum + bytes, 0);
      const orphanBytes = resources.reduce((sum, item) => taskByRuntime.has(item.runtimeId)
        ? sum : sum + (bytesByRuntime.get(item.runtimeId) ?? 0), 0);
      const entries = resources.map((item): TaskDiskInventoryEntry => {
        const task = taskByRuntime.get(item.runtimeId);
        return {
          runtimeId: item.runtimeId,
          ...(task ? { taskId: task.id, ownerUserId: task.ownerUserId, state: task.runtimeState } : {}),
          ...(item.createdAt ? { createdAt: item.createdAt } : {}),
          ...(task ? { lastUserInteractionAt: task.lastUserInteractionAt } : {}),
          ...(item.workspaceVolume ? { workspaceVolume: item.workspaceVolume } : {}),
          ...(item.codexHomeVolume ? { codexHomeVolume: item.codexHomeVolume } : {}),
          ...(volumeBytesByRuntime.has(item.runtimeId) ? {
            workspaceBytes: volumeBytesByRuntime.get(item.runtimeId)!.workspaceBytes,
            codexHomeBytes: volumeBytesByRuntime.get(item.runtimeId)!.codexHomeBytes,
            measuredBytes: volumeBytesByRuntime.get(item.runtimeId)!.totalBytes,
          } : {}),
          orphan: !task,
          ...(candidateByRuntime.has(item.runtimeId) ? { candidateKind: candidateByRuntime.get(item.runtimeId)! } : {}),
          blockers: task ? this.store.taskCleanupBlockers(task.id) : [],
        };
      });
      return {
        resources, tasks, taskByRuntime, bytesByRuntime,
        report: {
          generatedAt: this.clock().toISOString(), durationMs, managedBytes, orphanBytes,
          reclaimableBytes: candidates.reduce((sum, item) => sum + (bytesByRuntime.get(item.runtimeId) ?? 0), 0),
          candidateCounts, entries,
        },
      };
    } catch (error) {
      const durationMs = Math.max(0, this.monotonicClock() - startedAt);
      this.diagnostics.setMetric('link_bot_disk_inventory_duration_ms', durationMs);
      this.diagnostics.setMetric('link_bot_disk_cleanup_failures', 1, { phase: 'inventory' });
      this.diagnostics.audit('runtime.disk_inventory_failed', { error: safeError(error), durationMs });
      throw error;
    }
  }

  private async measure(
    resources: DockerManagedTaskResources[],
    taskByRuntime: Map<string, TaskRecord>,
    summary: TaskDiskMaintenanceSummary,
    signal?: AbortSignal,
  ): Promise<Map<string, DockerManagedTaskVolumeBytes>> {
    let managedBytes = 0;
    let orphanBytes = 0;
    const userBytes = new Map<string, number>();
    const bytesByRuntime = new Map<string, DockerManagedTaskVolumeBytes>();
    // Task-level attribution belongs in the administrator inventory report, not
    // in the global metrics table. Remove legacy high-cardinality rows and reset
    // owner aggregates so disappeared owners do not retain stale gauges.
    this.diagnostics.clearMetrics('link_bot_task_disk_bytes');
    this.diagnostics.clearMetrics('link_bot_user_task_disk_bytes');
    let partial = false;
    for (const item of resources) {
      try {
        signal?.throwIfAborted();
        const measured = await this.docker.measureManagedTaskVolumeBytes(item, signal);
        const bytes = measured.totalBytes;
        summary.measured += 1;
        bytesByRuntime.set(item.runtimeId, measured);
        managedBytes += bytes;
        const task = taskByRuntime.get(item.runtimeId);
        if (!task) {
          orphanBytes += bytes;
          continue;
        }
        userBytes.set(task.ownerUserId, (userBytes.get(task.ownerUserId) ?? 0) + bytes);
        if (bytes >= this.config.taskSoftLimitBytes) {
          this.diagnostics.audit('runtime.task_disk_soft_limit_exceeded', {
            taskId: task.id, ownerUserId: task.ownerUserId, bytes, limitBytes: this.config.taskSoftLimitBytes,
          }, dailyEventKey('task', task.id, this.clock()));
        }
      } catch (error) {
        if (signal?.aborted) {
          partial = true;
          break;
        }
        this.diagnostics.audit('runtime.task_disk_measure_failed', {
          runtimeId: item.runtimeId, error: safeError(error),
        });
      }
    }
    if (partial) {
      this.diagnostics.audit('runtime.disk_inventory_partial', {
        measured: bytesByRuntime.size,
        total: resources.length,
        reason: safeError(signal?.reason ?? 'inventory budget exhausted'),
      });
    }
    for (const [ownerUserId, bytes] of userBytes) {
      this.diagnostics.setMetric('link_bot_user_task_disk_bytes', bytes, { ownerUserId });
      if (bytes >= this.config.userSoftLimitBytes) {
        this.diagnostics.audit('runtime.user_disk_soft_limit_exceeded', {
          ownerUserId, bytes, limitBytes: this.config.userSoftLimitBytes,
        }, dailyEventKey('user', ownerUserId, this.clock()));
      }
    }
    this.diagnostics.setMetric('link_bot_managed_task_disk_bytes', managedBytes);
    this.diagnostics.setMetric('link_bot_orphan_task_disk_bytes', orphanBytes);
    return bytesByRuntime;
  }

  private candidates(
    tasks: TaskRecord[],
    resources: DockerManagedTaskResources[],
    taskByRuntime: Map<string, TaskRecord>,
    bytesByRuntime: Map<string, number>,
  ): Array<TaskCandidate | OrphanCandidate> {
    const now = this.clock().getTime();
    const withOrder = (state: TaskRuntimeState) => tasks
      .filter((task) => task.runtimeState === state)
      .sort((left, right) => oldestInteractionFirst(left, right)
        || (bytesByRuntime.get(right.runtimeId ?? right.id) ?? -1) - (bytesByRuntime.get(left.runtimeId ?? left.id) ?? -1)
        || left.id.localeCompare(right.id));
    const archived: TaskCandidate[] = withOrder('archived')
      .filter((task) => resources.some((item) => item.runtimeId === (task.runtimeId ?? task.id)))
      .map((task) => ({ kind: 'archived', taskId: task.id, runtimeId: task.runtimeId ?? task.id }));
    const failed: TaskCandidate[] = withOrder('failed')
      .filter((task) => !task.codexThreadId)
      .map((task) => ({ kind: 'failed_without_thread', taskId: task.id, runtimeId: task.runtimeId ?? task.id }));
    const orphanCutoff = now - this.config.orphanGraceHours * 60 * 60 * 1_000;
    const orphans: OrphanCandidate[] = resources
      .filter((item) => !taskByRuntime.has(item.runtimeId))
      .filter((item) => item.createdAt && Number.isFinite(Date.parse(item.createdAt)) && Date.parse(item.createdAt) <= orphanCutoff)
      .sort((left, right) => Date.parse(left.createdAt!) - Date.parse(right.createdAt!)
        || (bytesByRuntime.get(right.runtimeId) ?? -1) - (bytesByRuntime.get(left.runtimeId) ?? -1))
      .map((item) => ({ kind: 'orphan', runtimeId: item.runtimeId, createdAt: item.createdAt }));
    const expiredWarm: TaskCandidate[] = this.config.autoDeleteWarmTasks
      ? withOrder('warm').filter((task) => this.warmDeletionEligible(task, now))
        .map((task) => ({ kind: 'expired_warm', taskId: task.id, runtimeId: task.runtimeId ?? task.id }))
      : [];
    return [...archived, ...failed, ...orphans, ...expiredWarm];
  }

  private warmDeletionEligible(task: TaskRecord, now: number): boolean {
    return !task.pinned && !task.activeTurnId
      && now >= retentionExpiry(task, this.config.warmRetentionDays);
  }

  private cleanupTask(candidate: TaskCandidate): Promise<'cleaned' | 'deferred'> {
    return this.store.withTaskLock(candidate.taskId, async () => {
      const task = this.store.getTask(candidate.taskId);
      if (!task || (task.runtimeId ?? task.id) !== candidate.runtimeId) return 'deferred';
      if (candidate.kind === 'archived' && task.runtimeState !== 'archived') return 'deferred';
      if (candidate.kind === 'failed_without_thread' && (task.runtimeState !== 'failed' || task.codexThreadId)) return 'deferred';
      if (candidate.kind === 'expired_warm'
        && (task.runtimeState !== 'warm' || !this.warmDeletionEligible(task, this.clock().getTime()))) return 'deferred';
      const blockers = this.store.taskCleanupBlockers(task.id);
      if (blockers.length > 0) {
        this.diagnostics.audit('runtime.disk_cleanup_deferred', { kind: candidate.kind, taskId: task.id, blockers });
        return 'deferred';
      }
      const runtime = this.docker.describe(candidate.runtimeId);
      if (await this.docker.observeForCleanup(runtime) === 'running') {
        this.diagnostics.audit('runtime.disk_cleanup_deferred', {
          kind: candidate.kind, taskId: task.id, blockers: ['running_container'],
        });
        return 'deferred';
      }
      if (candidate.kind === 'archived') {
        await this.docker.removeTask(runtime);
      } else {
        const originalState = task.runtimeState;
        const intentId = `disk_cleanup_${randomUUID()}`;
        const timestamp = this.clock().toISOString();
        this.store.beginLifecycleIntent({
          id: intentId, taskId: task.id, fromState: originalState, toState: 'archived', status: 'pending',
          createdAt: timestamp, updatedAt: timestamp,
        });
        try {
          await this.docker.removeTask(runtime);
        } catch (error) {
          this.store.reconcileLifecycleIntent(intentId, originalState);
          throw error;
        }
        // If this write fails after Docker deletion, intentionally retain the
        // pending intent. Startup reconciliation can positively observe the
        // now-absent deterministic resources and finish the state transition.
        this.store.completeLifecycleIntent(intentId, 'archived');
        if (candidate.kind === 'expired_warm') {
          this.store.updateTask(task.id, (current) => ({ ...current, archiveReason: 'warm_retention_expired' }));
        }
      }
      this.diagnostics.audit('runtime.disk_cleanup_completed', {
        kind: candidate.kind, taskId: task.id, runtimeId: candidate.runtimeId,
        ownerUserId: task.ownerUserId,
        ...(candidate.kind === 'expired_warm' ? {
          lastUserInteractionAt: task.lastUserInteractionAt,
          expiresAt: new Date(retentionExpiry(task, this.config.warmRetentionDays)).toISOString(),
        } : {}),
      });
      return 'cleaned';
    });
  }

  private cleanupOrphan(candidate: OrphanCandidate): Promise<'cleaned' | 'deferred'> {
    return this.store.withTaskLock(`orphan:${candidate.runtimeId}`, async () => {
      const tasks = this.store.listTasks();
      if (tasks.some((task) => (task.runtimeId ?? task.id) === candidate.runtimeId)) return 'deferred';
      const current = (await this.docker.listManagedTaskResources())
        .find((item) => item.runtimeId === candidate.runtimeId);
      const cutoff = this.clock().getTime() - this.config.orphanGraceHours * 60 * 60 * 1_000;
      if (!current?.createdAt || Date.parse(current.createdAt) > cutoff) return 'deferred';
      const runtime = this.docker.describe(candidate.runtimeId);
      if (await this.docker.observeForCleanup(runtime) === 'running') {
        this.diagnostics.audit('runtime.disk_cleanup_deferred', {
          kind: candidate.kind, runtimeId: candidate.runtimeId, blockers: ['running_container'],
        });
        return 'deferred';
      }
      await this.docker.removeTask(runtime);
      this.diagnostics.audit('runtime.disk_cleanup_completed', {
        kind: candidate.kind, runtimeId: candidate.runtimeId, createdAt: current.createdAt,
      });
      return 'cleaned';
    });
  }
}

function emptySummary(): TaskDiskMaintenanceSummary {
  return { inventoried: 0, measured: 0, warningsEnqueued: 0, cleaned: 0, deferred: 0, failed: 0, reclaimedBytes: 0 };
}

const cleanupKinds: CleanupKind[] = ['archived', 'failed_without_thread', 'orphan', 'expired_warm'];

function emptyCandidateCounts(): Record<CleanupKind, number> {
  return { archived: 0, failed_without_thread: 0, orphan: 0, expired_warm: 0 };
}

function emptyInventory(generatedAt: string): TaskDiskInventoryReport {
  return {
    generatedAt, durationMs: 0, managedBytes: 0, orphanBytes: 0, reclaimableBytes: 0,
    candidateCounts: emptyCandidateCounts(), entries: [],
  };
}

function retentionExpiry(task: TaskRecord, retentionDays: number): number {
  return Date.parse(task.lastUserInteractionAt) + days(retentionDays);
}

function days(count: number): number {
  return count * 24 * 60 * 60 * 1_000;
}

function oldestInteractionFirst(left: TaskRecord, right: TaskRecord): number {
  return Date.parse(left.lastUserInteractionAt) - Date.parse(right.lastUserInteractionAt);
}

function dailyEventKey(kind: string, id: string, now: Date): string {
  return `disk-soft-limit:${kind}:${id}:${now.toISOString().slice(0, 10)}`;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
