import { randomUUID } from 'node:crypto';
import type { DiskPolicyConfig } from '../domain/types.js';
import type { TaskActorContext } from '../feishu/FeishuTaskController.js';
import type { TaskPlatformDiagnostics } from '../observability/TaskPlatformDiagnostics.js';
import type { SqliteStateStore } from '../state/SqliteStateStore.js';
import type { DiskLifecycleController, DiskUsageSample } from './DiskLifecycleController.js';
import type { DockerRuntime } from './DockerRuntime.js';
import type {
  TaskDiskCleanupController,
  TaskDiskInventoryEntry,
  TaskDiskInventoryReport,
  TaskDiskMaintenanceSummary,
} from './TaskDiskCleanupController.js';

type CleanupMode = 'policy' | 'exact';

interface DiskCleanupRequest {
  requestId: string;
  ownerUserId: string;
  chatId: string;
  chatType: TaskActorContext['chatType'];
  topicId?: string;
  mode: CleanupMode;
  taskIds: string[];
  summary: string;
  createdAt: string;
  expiresAt: string;
  status?: string;
  result?: TaskDiskMaintenanceSummary;
  error?: string;
}

export class AdminDiskOperatorService {
  constructor(
    private readonly config: DiskPolicyConfig,
    private readonly administratorIds: readonly string[],
    private readonly store: Pick<SqliteStateStore, 'db' | 'claimExternalOperation'>,
    private readonly lifecycle: Pick<DiskLifecycleController, 'sample' | 'pressureLevel'>,
    private readonly docker: Pick<DockerRuntime, 'dataRoot'>,
    private readonly cleanup: Pick<TaskDiskCleanupController, 'inventory' | 'run'>,
    private readonly diagnostics: Pick<TaskPlatformDiagnostics, 'audit'>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async inventory(input: TaskActorContext): Promise<string> {
    this.assertAdministrator(input.userId);
    const [report, sample, dataRoot] = await Promise.all([
      this.boundedInventory(),
      this.lifecycle.sample().catch(() => undefined),
      this.docker.dataRoot().catch(() => 'unavailable'),
    ]);
    this.diagnostics.audit('runtime.admin_disk_inventory_requested', {
      administratorId: input.userId,
      chatId: input.chatId,
      managedBytes: report.managedBytes,
      reclaimableBytes: report.reclaimableBytes,
    });
    return formatInventory(report, sample, dataRoot, this.config, sample ? this.lifecycle.pressureLevel(sample) : 'unknown');
  }

  async requestCleanup(input: TaskActorContext & { taskIds?: string[] }): Promise<{ requestId: string; summary: string }> {
    this.assertAdministrator(input.userId);
    if (!this.config.enabled || !this.config.cleanupEnabled) {
      throw new Error('Disk cleanup is disabled by policy.');
    }
    const taskIds = [...new Set((input.taskIds ?? []).map((taskId) => taskId.trim()).filter(Boolean))];
    if (taskIds.length > this.config.maxCleanupTasksPerPass) {
      throw new Error(`At most ${this.config.maxCleanupTasksPerPass} task IDs may be cleaned in one pass.`);
    }
    const report = await this.boundedInventory();
    const mode: CleanupMode = taskIds.length > 0 ? 'exact' : 'policy';
    const summary = mode === 'exact'
      ? this.validateExactSelection(report, taskIds)
      : policySelectionSummary(report, this.config.maxCleanupTasksPerPass);
    const now = this.clock();
    const request: DiskCleanupRequest = {
      requestId: `disk_cleanup_${randomUUID()}`,
      ownerUserId: input.userId,
      chatId: input.chatId,
      chatType: input.chatType,
      ...(input.topicId ? { topicId: input.topicId } : {}),
      mode,
      taskIds,
      summary,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 600_000).toISOString(),
    };
    if (!this.store.claimExternalOperation({
      idempotencyKey: request.requestId,
      operationType: 'disk_cleanup',
      payload: request,
    })) throw new Error('Could not persist disk cleanup confirmation.');
    this.diagnostics.audit('runtime.admin_disk_cleanup_requested', {
      requestId: request.requestId,
      administratorId: input.userId,
      chatId: input.chatId,
      mode,
      taskIds,
      expiresAt: request.expiresAt,
    });
    return { requestId: request.requestId, summary };
  }

  async decideCleanup(
    input: TaskActorContext & { requestId: string; decision: 'confirm' | 'reject' },
  ): Promise<string> {
    this.assertAdministrator(input.userId);
    const row = this.store.db.prepare(`
      SELECT payload, status FROM external_operation_claims
      WHERE idempotency_key=? AND operation_type='disk_cleanup'
    `).get(input.requestId) as { payload: string; status: string } | undefined;
    if (!row) throw new Error('Disk cleanup request not found.');
    const request = JSON.parse(row.payload) as DiskCleanupRequest;
    if (request.ownerUserId !== input.userId) throw new Error('Only the requesting administrator can decide this cleanup.');
    if (request.chatId !== input.chatId || request.chatType !== input.chatType) {
      throw new Error('Disk cleanup must be confirmed in the originating chat.');
    }
    if (row.status !== 'pending') return `Disk cleanup request already ${row.status}.`;
    if (request.expiresAt <= this.clock().toISOString()) {
      return this.claimDecision(request, 'expired')
        ? 'Disk cleanup request expired.'
        : `Disk cleanup request already ${this.status(request.requestId) ?? 'claimed'}.`;
    }
    if (input.decision === 'reject') {
      const rejected = this.claimDecision(request, 'rejected');
      if (rejected) this.auditDecision(request, input.userId, 'rejected');
      return rejected
        ? 'Disk cleanup rejected; no resources were changed.'
        : `Disk cleanup request already ${this.status(request.requestId) ?? 'claimed'}.`;
    }
    if (!this.claimDecision(request, 'executing')) {
      return `Disk cleanup request already ${this.status(request.requestId) ?? 'claimed'}.`;
    }
    this.auditDecision(request, input.userId, 'executing');
    try {
      const result = await this.cleanup.run(request.mode === 'exact'
        ? { mode: 'routine', exactTaskIds: request.taskIds }
        : { mode: 'routine' });
      this.update(request, 'completed', { result });
      this.diagnostics.audit('runtime.admin_disk_cleanup_completed', {
        requestId: request.requestId,
        administratorId: input.userId,
        mode: request.mode,
        taskIds: request.taskIds,
        ...result,
      });
      return formatCleanupResult(result);
    } catch (error) {
      const message = safeError(error);
      this.update(request, 'failed', { error: message });
      this.diagnostics.audit('runtime.admin_disk_cleanup_failed', {
        requestId: request.requestId,
        administratorId: input.userId,
        mode: request.mode,
        taskIds: request.taskIds,
        error: message,
      });
      return `Disk cleanup failed safely: ${message}`;
    }
  }

  private async boundedInventory(): Promise<TaskDiskInventoryReport> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error('Disk inventory timed out.')), this.config.inventoryTimeoutMs);
    timer.unref();
    try {
      return await this.cleanup.inventory(abort.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  private validateExactSelection(report: TaskDiskInventoryReport, taskIds: string[]): string {
    if (taskIds.length === 0) throw new Error('At least one exact task ID is required.');
    const byTask = new Map(report.entries.flatMap((entry) => entry.taskId ? [[entry.taskId, entry] as const] : []));
    const invalid = taskIds.filter((taskId) => {
      const entry = byTask.get(taskId);
      return !entry?.candidateKind || entry.blockers.length > 0;
    });
    if (invalid.length > 0) {
      throw new Error(`Tasks are not currently eligible for cleanup: ${invalid.join(', ')}.`);
    }
    const bytes = taskIds.reduce((total, taskId) => total + (byTask.get(taskId)?.measuredBytes ?? 0), 0);
    return `Exact tasks: ${taskIds.join(', ')}\nEstimated reclaimable: ${formatBytes(bytes)}.`;
  }

  private claimDecision(request: DiskCleanupRequest, status: 'expired' | 'rejected' | 'executing'): boolean {
    return this.store.db.prepare(`
      UPDATE external_operation_claims SET status=?, payload=?, updated_at=?
      WHERE idempotency_key=? AND operation_type='disk_cleanup' AND status='pending'
    `).run(
      status,
      JSON.stringify({ ...request, status }),
      this.clock().toISOString(),
      request.requestId,
    ).changes === 1;
  }

  private update(request: DiskCleanupRequest, status: 'completed' | 'failed', extra: Partial<DiskCleanupRequest>): void {
    this.store.db.prepare(`
      UPDATE external_operation_claims SET status=?, payload=?, updated_at=?
      WHERE idempotency_key=? AND operation_type='disk_cleanup'
    `).run(
      status,
      JSON.stringify({ ...request, ...extra, status }),
      this.clock().toISOString(),
      request.requestId,
    );
  }

  private status(requestId: string): string | undefined {
    return (this.store.db.prepare(`
      SELECT status FROM external_operation_claims
      WHERE idempotency_key=? AND operation_type='disk_cleanup'
    `).get(requestId) as { status: string } | undefined)?.status;
  }

  private auditDecision(request: DiskCleanupRequest, administratorId: string, decision: string): void {
    this.diagnostics.audit('runtime.admin_disk_cleanup_decided', {
      requestId: request.requestId,
      administratorId,
      chatId: request.chatId,
      mode: request.mode,
      taskIds: request.taskIds,
      decision,
    });
  }

  private assertAdministrator(userId: string): void {
    if (!this.administratorIds.includes(userId)) throw new Error('Only administrators can use /disk.');
  }
}

function formatInventory(
  report: TaskDiskInventoryReport,
  sample: DiskUsageSample | undefined,
  dataRoot: string,
  config: DiskPolicyConfig,
  pressure: string,
): string {
  const lines = [
    'Disk inventory (read-only; no resources were changed)',
    sample
      ? `Filesystem ${sample.path}: ${(sample.usedRatio * 100).toFixed(1)}% used, ${formatBytes(sample.availableBytes)} available (${pressure})`
      : `Filesystem ${config.filesystemPath}: sample unavailable`,
    `Thresholds: warning ${(config.warningWatermark * 100).toFixed(0)}%, high ${(config.highWatermark * 100).toFixed(0)}%, recover ${(config.lowWatermark * 100).toFixed(0)}%, reserve ${formatBytes(config.minimumFreeBytes)}`,
    `Docker data-root: ${dataRoot}`,
    `Policy: attribution=${config.attributionEnabled ? 'on' : 'off'}, cleanup=${config.cleanupEnabled ? 'on' : 'off'}, warm-retention=${config.autoDeleteWarmTasks ? 'on' : 'off'}, max/pass=${config.maxCleanupTasksPerPass}`,
    `Managed: ${report.entries.length} resource sets, ${formatBytes(report.managedBytes)}; orphan ${formatBytes(report.orphanBytes)}; estimated reclaimable ${formatBytes(report.reclaimableBytes)}`,
    `Candidates: archived=${report.candidateCounts.archived}, failed=${report.candidateCounts.failed_without_thread}, orphan=${report.candidateCounts.orphan}, expired-warm=${report.candidateCounts.expired_warm}`,
  ];
  const entries = [...report.entries]
    .sort((left, right) => Number(Boolean(right.candidateKind)) - Number(Boolean(left.candidateKind))
      || (right.measuredBytes ?? -1) - (left.measuredBytes ?? -1)
      || left.runtimeId.localeCompare(right.runtimeId));
  if (entries.length === 0) lines.push('Resources: none.');
  else {
    lines.push('Resources (candidate-first, largest-first):');
    for (const entry of entries.slice(0, 20)) lines.push(formatEntry(entry));
    if (entries.length > 20) lines.push(`... ${entries.length - 20} more entries omitted.`);
  }
  lines.push(`Generated ${report.generatedAt}; inventory ${(report.durationMs / 1_000).toFixed(1)}s.`);
  return lines.join('\n');
}

function formatEntry(entry: TaskDiskInventoryEntry): string {
  const identity = entry.taskId ?? `orphan:${entry.runtimeId}`;
  const state = entry.state ?? 'orphan';
  const split = entry.measuredBytes === undefined
    ? 'size unknown'
    : `${formatBytes(entry.measuredBytes)} (workspace ${formatBytes(entry.workspaceBytes ?? 0)}, codex ${formatBytes(entry.codexHomeBytes ?? 0)})`;
  const eligibility = entry.candidateKind
    ? `candidate=${entry.candidateKind}`
    : 'not eligible';
  const blockers = entry.blockers.length > 0 ? `; blockers=${entry.blockers.join(',')}` : '';
  const volumes = entry.orphan
    ? `; volumes=${[entry.workspaceVolume, entry.codexHomeVolume].filter(Boolean).join(',') || 'unknown'}`
    : '';
  return `- ${identity} | ${state} | ${split} | ${eligibility}${blockers}${volumes}${entry.lastUserInteractionAt ? ` | last=${entry.lastUserInteractionAt}` : ''}`;
}

function policySelectionSummary(report: TaskDiskInventoryReport, limit: number): string {
  const count = Object.values(report.candidateCounts).reduce((sum, current) => sum + current, 0);
  if (count === 0) throw new Error('No policy-eligible disk cleanup candidates were found.');
  return `Bounded policy pass: up to ${limit} of ${count} current candidates.\nEstimated reclaimable across all candidates: ${formatBytes(report.reclaimableBytes)}.`;
}

function formatCleanupResult(result: TaskDiskMaintenanceSummary): string {
  const selection = result.requested === undefined ? '' : ` Requested ${result.requested}; eligible at execution ${result.eligible ?? 0}.`;
  return `Disk cleanup completed: cleaned ${result.cleaned}, deferred ${result.deferred}, failed ${result.failed}, reclaimed about ${formatBytes(result.reclaimedBytes)}.${selection}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
