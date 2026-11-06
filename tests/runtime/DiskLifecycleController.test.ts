import { describe, expect, it, vi } from 'vitest';
import type { DiskPolicyConfig } from '../../src/domain/types.js';
import {
  DiskCapacityError,
  DiskLifecycleController,
  type DiskUsageSampler,
} from '../../src/runtime/DiskLifecycleController.js';
import { SystemDiskUsageSampler } from '../../src/runtime/SystemDiskUsageSampler.js';
import { createTmpDir } from '../helpers/tmp.js';

const config: DiskPolicyConfig = {
  enabled: true,
  filesystemPath: '/docker',
  scanIntervalMs: 900_000,
  inventoryIntervalMs: 21_600_000,
  inventoryTimeoutMs: 300_000,
  warningWatermark: 0.7,
  highWatermark: 0.8,
  lowWatermark: 0.65,
  minimumFreeBytes: 20,
  attributionEnabled: false,
  cleanupEnabled: false,
  taskSoftLimitBytes: 100,
  userSoftLimitBytes: 500,
  warmRetentionDays: 30,
  warmRetentionWarningDays: 3,
  autoDeleteWarmTasks: false,
  maxCleanupTasksPerPass: 5,
  orphanGraceHours: 24,
};

function sampler(usedBytes: number, availableBytes: number, totalBytes = 100): DiskUsageSampler {
  return {
    sample: vi.fn(async (path) => ({
      path, totalBytes, usedBytes, availableBytes, usedRatio: usedBytes / totalBytes,
    })),
  };
}

describe('DiskLifecycleController', () => {
  it('classifies normal, warning, and high pressure and publishes metrics', async () => {
    const diagnostics = { setMetric: vi.fn(), audit: vi.fn(() => true) };
    const normal = new DiskLifecycleController(config, sampler(60, 40), diagnostics);
    const warning = new DiskLifecycleController(config, sampler(75, 25), diagnostics);
    const high = new DiskLifecycleController(config, sampler(80, 20), diagnostics);

    expect(normal.pressureLevel((await normal.sample())!)).toBe('normal');
    expect(warning.pressureLevel((await warning.sample())!)).toBe('warning');
    expect(high.pressureLevel((await high.sample())!)).toBe('high');
    expect(diagnostics.setMetric).toHaveBeenCalledWith('link_bot_disk_used_ratio', 0.8);
  });

  it('rejects allocation at the high watermark', async () => {
    const diagnostics = { setMetric: vi.fn(), audit: vi.fn(() => true) };
    const controller = new DiskLifecycleController(config, sampler(80, 20), diagnostics);

    await expect(controller.assertAllocationAllowed('task_provision')).rejects.toMatchObject({
      name: 'DiskCapacityError', reason: 'high_watermark', operation: 'task_provision',
    } satisfies Partial<DiskCapacityError>);
    expect(diagnostics.audit).toHaveBeenCalledWith('runtime.disk_admission_rejected', expect.objectContaining({
      operation: 'task_provision', reason: 'high_watermark',
    }));
  });

  it('rejects allocation below the minimum free reserve', async () => {
    const controller = new DiskLifecycleController(config, sampler(60, 19));

    await expect(controller.assertAllocationAllowed('repository_materialize')).rejects.toMatchObject({
      reason: 'minimum_free_bytes',
    });
  });

  it('attempts serialized pressure relief before rejecting a new allocation', async () => {
    let high = true;
    const usage: DiskUsageSampler = {
      sample: vi.fn(async (path) => high
        ? { path, totalBytes: 100, usedBytes: 80, availableBytes: 20, usedRatio: 0.8 }
        : { path, totalBytes: 100, usedBytes: 60, availableBytes: 40, usedRatio: 0.6 }),
    };
    const controller = new DiskLifecycleController(config, usage);
    const relieve = vi.fn(async () => { high = false; });
    controller.setPressureReliefHandler(relieve);

    await expect(controller.assertAllocationAllowed('task_provision')).resolves.toBeUndefined();
    expect(relieve).toHaveBeenCalledOnce();
    expect(usage.sample).toHaveBeenCalledTimes(2);
  });

  it('requires both the low watermark and free-space reserve before pressure cleanup stops', () => {
    const controller = new DiskLifecycleController(config, sampler(80, 20));

    expect(controller.recoverySatisfied(sampleValue(65, 35))).toBe(true);
    expect(controller.recoverySatisfied(sampleValue(66, 34))).toBe(false);
    expect(controller.recoverySatisfied(sampleValue(60, 19))).toBe(false);
  });

  it('does not sample when disabled', async () => {
    const usage = sampler(99, 1);
    const controller = new DiskLifecycleController({ ...config, enabled: false }, usage);

    await expect(controller.assertAllocationAllowed('task_provision')).resolves.toBeUndefined();
    expect(usage.sample).not.toHaveBeenCalled();
  });

  it('shares one in-flight sample across concurrent callers', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const usage: DiskUsageSampler = {
      sample: vi.fn(async (path) => {
        await pending;
        return { path, totalBytes: 100, usedBytes: 50, availableBytes: 50, usedRatio: 0.5 };
      }),
    };
    const controller = new DiskLifecycleController(config, usage);
    const first = controller.sample();
    const second = controller.sample();
    release();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(usage.sample).toHaveBeenCalledTimes(1);
  });

  it('audits and fails closed when sampling fails', async () => {
    const diagnostics = { setMetric: vi.fn(), audit: vi.fn(() => true) };
    const controller = new DiskLifecycleController(config, {
      sample: vi.fn(async () => { throw new Error('statfs failed'); }),
    }, diagnostics);

    await expect(controller.assertAllocationAllowed('task_provision')).rejects.toThrow(
      'Persistent disk capacity could not be verified',
    );
    expect(diagnostics.audit).toHaveBeenCalledWith('runtime.disk_sample_failed', { error: 'statfs failed' });
    expect(diagnostics.audit).toHaveBeenCalledWith('runtime.disk_admission_sample_failed', {
      operation: 'task_provision', error: 'statfs failed',
    });
  });

  it('samples a real filesystem without traversing its contents', async () => {
    const path = await createTmpDir();
    const sample = await new SystemDiskUsageSampler().sample(path);

    expect(sample).toMatchObject({ path });
    expect(sample.totalBytes).toBeGreaterThan(0);
    expect(sample.availableBytes).toBeGreaterThanOrEqual(0);
    expect(sample.usedRatio).toBeGreaterThanOrEqual(0);
    expect(sample.usedRatio).toBeLessThanOrEqual(1);
  });
});

function sampleValue(usedBytes: number, availableBytes: number, totalBytes = 100) {
  return {
    path: '/docker', totalBytes, usedBytes, availableBytes,
    usedRatio: usedBytes / totalBytes, sampledAt: '2026-08-11T00:00:00.000Z',
  };
}
