import { describe, expect, it, vi } from 'vitest';
import type { DiskPolicyConfig } from '../../src/domain/types.js';
import { AdminDiskOperatorService } from '../../src/runtime/AdminDiskOperatorService.js';
import type { TaskDiskInventoryReport } from '../../src/runtime/TaskDiskCleanupController.js';
import { SqliteStateStore } from '../../src/state/SqliteStateStore.js';
import { createTmpDir } from '../helpers/tmp.js';

const config: DiskPolicyConfig = {
  enabled: true, filesystemPath: '/data00/docker', scanIntervalMs: 900_000,
  inventoryIntervalMs: 21_600_000, inventoryTimeoutMs: 300_000,
  warningWatermark: 0.7, highWatermark: 0.8, lowWatermark: 0.65,
  minimumFreeBytes: 20 * 1024 ** 3, attributionEnabled: true, cleanupEnabled: true,
  taskSoftLimitBytes: 20 * 1024 ** 3, userSoftLimitBytes: 100 * 1024 ** 3,
  warmRetentionDays: 30, warmRetentionWarningDays: 3, autoDeleteWarmTasks: false,
  maxCleanupTasksPerPass: 5, orphanGraceHours: 24,
};

describe('AdminDiskOperatorService', () => {
  it('returns an administrator-only, read-only inventory with filesystem and volume attribution', async () => {
    const fixture = await createFixture();

    const text = await fixture.service.inventory(actor());

    expect(text).toContain('read-only; no resources were changed');
    expect(text).toContain('Filesystem /data00/docker: 40.0% used');
    expect(text).toContain('Docker data-root: /data00/docker');
    expect(text).toContain('workspace 60 B, codex 40 B');
    expect(text).toContain('candidate=archived');
    expect(fixture.cleanup.run).not.toHaveBeenCalled();
    await expect(fixture.service.inventory(actor('ou_user'))).rejects.toThrow('Only administrators');
    fixture.store.close();
  });

  it('persists exact cleanup confirmation, binds it to requester and chat, and executes once', async () => {
    const fixture = await createFixture();
    const request = await fixture.service.requestCleanup({ ...actor(), taskIds: ['task_archived'] });

    expect(request.summary).toContain('Exact tasks: task_archived');
    expect(fixture.cleanup.run).not.toHaveBeenCalled();
    await expect(fixture.service.decideCleanup({
      ...actor('ou_other_admin'), requestId: request.requestId, decision: 'confirm',
    })).rejects.toThrow('requesting administrator');
    await expect(fixture.service.decideCleanup({
      ...actor(), chatId: 'oc_other', requestId: request.requestId, decision: 'confirm',
    })).rejects.toThrow('originating chat');

    await expect(fixture.service.decideCleanup({
      ...actor(), requestId: request.requestId, decision: 'confirm',
    })).resolves.toContain('cleaned 1');
    expect(fixture.cleanup.run).toHaveBeenCalledWith({ mode: 'routine', exactTaskIds: ['task_archived'] });
    await expect(fixture.service.decideCleanup({
      ...actor(), requestId: request.requestId, decision: 'confirm',
    })).resolves.toBe('Disk cleanup request already completed.');
    expect(fixture.cleanup.run).toHaveBeenCalledTimes(1);
    fixture.store.close();
  });

  it('rejects unsafe exact targets and supports a bounded policy confirmation', async () => {
    const fixture = await createFixture();
    await expect(fixture.service.requestCleanup({ ...actor(), taskIds: ['task_hot'] }))
      .rejects.toThrow('not currently eligible');

    const request = await fixture.service.requestCleanup(actor());
    expect(request.summary).toContain('Bounded policy pass: up to 5');
    await fixture.service.decideCleanup({ ...actor(), requestId: request.requestId, decision: 'reject' });
    expect(fixture.cleanup.run).not.toHaveBeenCalled();
    expect(fixture.store.db.prepare('SELECT status FROM external_operation_claims WHERE idempotency_key=?')
      .get(request.requestId)).toEqual({ status: 'rejected' });
    fixture.store.close();
  });
});

async function createFixture() {
  const now = new Date('2026-08-11T00:00:00.000Z');
  const store = new SqliteStateStore(`${await createTmpDir()}/state.sqlite`, () => now);
  const cleanup = {
    inventory: vi.fn(async () => inventory()),
    run: vi.fn(async () => ({
      inventoried: 1, measured: 1, warningsEnqueued: 0, cleaned: 1, deferred: 0,
      failed: 0, reclaimedBytes: 100, requested: 1, eligible: 1,
    })),
  };
  const lifecycle = {
    sample: vi.fn(async () => ({
      path: '/data00/docker', totalBytes: 1_000, usedBytes: 400,
      availableBytes: 600, usedRatio: 0.4, sampledAt: now.toISOString(),
    })),
    pressureLevel: vi.fn(() => 'normal' as const),
  };
  const docker = { dataRoot: vi.fn(async () => '/data00/docker') };
  const diagnostics = { audit: vi.fn(() => true) };
  const service = new AdminDiskOperatorService(
    config, ['ou_admin', 'ou_other_admin'], store, lifecycle, docker, cleanup, diagnostics, () => now,
  );
  return { store, cleanup, lifecycle, docker, diagnostics, service };
}

function actor(userId = 'ou_admin') {
  return { chatId: 'oc_admin', chatType: 'private' as const, userId };
}

function inventory(): TaskDiskInventoryReport {
  return {
    generatedAt: '2026-08-11T00:00:00.000Z', durationMs: 25,
    managedBytes: 100, orphanBytes: 0, reclaimableBytes: 100,
    candidateCounts: { archived: 1, failed_without_thread: 0, orphan: 0, expired_warm: 0 },
    entries: [
      {
        runtimeId: 'task_archived', taskId: 'task_archived', ownerUserId: 'ou_owner',
        state: 'archived', lastUserInteractionAt: '2026-07-01T00:00:00.000Z',
        workspaceVolume: 'link-bot-task_archived-workspace',
        codexHomeVolume: 'link-bot-task_archived-codex-home',
        workspaceBytes: 60, codexHomeBytes: 40, measuredBytes: 100,
        orphan: false, candidateKind: 'archived', blockers: [],
      },
      {
        runtimeId: 'task_hot', taskId: 'task_hot', ownerUserId: 'ou_owner', state: 'hot',
        measuredBytes: 50, orphan: false, blockers: [],
      },
    ],
  };
}
