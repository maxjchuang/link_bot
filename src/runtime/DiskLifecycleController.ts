import type { DiskPolicyConfig } from '../domain/types.js';

export type DiskPressureLevel = 'normal' | 'warning' | 'high';

export interface DiskUsageSample {
  path: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedRatio: number;
  sampledAt: string;
}

export interface DiskUsageSampler {
  sample(path: string): Promise<Omit<DiskUsageSample, 'sampledAt'>>;
}

export interface PersistentDiskAdmission {
  assertAllocationAllowed(operation: string): Promise<void>;
}

export interface DiskDiagnosticsSink {
  setMetric(name: string, value: number, labels?: Record<string, string>): void;
  audit(eventType: string, payload: Record<string, unknown>, eventKey?: string): boolean;
}

export class DiskCapacityError extends Error {
  constructor(
    readonly operation: string,
    readonly sample: DiskUsageSample,
    readonly reason: 'high_watermark' | 'minimum_free_bytes',
  ) {
    super(
      `Persistent disk capacity is unavailable for ${operation}: ${reason === 'high_watermark'
        ? `usage ${(sample.usedRatio * 100).toFixed(1)}% reached the configured high watermark`
        : `available bytes ${sample.availableBytes} fell below the configured reserve`}.`,
    );
    this.name = 'DiskCapacityError';
  }
}

export class DiskLifecycleController implements PersistentDiskAdmission {
  private activeSample?: Promise<DiskUsageSample>;
  private pressureReliefHandler?: () => Promise<void>;

  constructor(
    private readonly config: DiskPolicyConfig,
    private readonly sampler: DiskUsageSampler,
    private readonly diagnostics?: DiskDiagnosticsSink,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  setPressureReliefHandler(handler: () => Promise<void>): void {
    this.pressureReliefHandler = handler;
  }

  async sample(): Promise<DiskUsageSample | undefined> {
    if (!this.config.enabled) return undefined;
    if (this.activeSample) return this.activeSample;
    const current = this.collectSample();
    this.activeSample = current;
    try {
      return await current;
    } finally {
      if (this.activeSample === current) this.activeSample = undefined;
    }
  }

  async assertAllocationAllowed(operation: string): Promise<void> {
    if (!this.config.enabled) return;
    let sample: DiskUsageSample;
    try {
      sample = (await this.sample())!;
    } catch (error) {
      this.diagnostics?.audit('runtime.disk_admission_sample_failed', {
        operation,
        error: safeError(error),
      });
      throw new Error(`Persistent disk capacity could not be verified for ${operation}: ${safeError(error)}`);
    }
    let reason = this.blockReason(sample);
    if (reason && this.pressureReliefHandler) {
      try {
        await this.pressureReliefHandler();
        sample = (await this.sample())!;
        reason = this.blockReason(sample);
      } catch (error) {
        this.diagnostics?.audit('runtime.disk_admission_cleanup_failed', {
          operation,
          error: safeError(error),
        });
      }
    }
    if (!reason) return;
    this.diagnostics?.setMetric('link_bot_disk_admission_rejections', 1, { operation });
    this.diagnostics?.audit('runtime.disk_admission_rejected', {
      operation,
      reason,
      usedRatio: sample.usedRatio,
      availableBytes: sample.availableBytes,
      highWatermark: this.config.highWatermark,
      minimumFreeBytes: this.config.minimumFreeBytes,
    });
    throw new DiskCapacityError(operation, sample, reason);
  }

  pressureLevel(sample: DiskUsageSample): DiskPressureLevel {
    if (this.blockReason(sample)) return 'high';
    if (sample.usedRatio >= this.config.warningWatermark) return 'warning';
    return 'normal';
  }

  recoverySatisfied(sample: DiskUsageSample): boolean {
    return sample.usedRatio <= this.config.lowWatermark
      && sample.availableBytes >= this.config.minimumFreeBytes;
  }

  private async collectSample(): Promise<DiskUsageSample> {
    try {
      const sampled = await this.sampler.sample(this.config.filesystemPath);
      validateSample(sampled);
      const sample: DiskUsageSample = { ...sampled, sampledAt: this.clock().toISOString() };
      const level = this.pressureLevel(sample);
      this.diagnostics?.setMetric('link_bot_disk_total_bytes', sample.totalBytes);
      this.diagnostics?.setMetric('link_bot_disk_used_bytes', sample.usedBytes);
      this.diagnostics?.setMetric('link_bot_disk_available_bytes', sample.availableBytes);
      this.diagnostics?.setMetric('link_bot_disk_used_ratio', sample.usedRatio);
      for (const candidate of ['normal', 'warning', 'high'] as const) {
        this.diagnostics?.setMetric('link_bot_disk_pressure', candidate === level ? 1 : 0, { level: candidate });
      }
      return sample;
    } catch (error) {
      this.diagnostics?.audit('runtime.disk_sample_failed', { error: safeError(error) });
      throw error;
    }
  }

  private blockReason(sample: DiskUsageSample): DiskCapacityError['reason'] | undefined {
    if (sample.usedRatio >= this.config.highWatermark) return 'high_watermark';
    if (sample.availableBytes < this.config.minimumFreeBytes) return 'minimum_free_bytes';
    return undefined;
  }
}

function validateSample(sample: Omit<DiskUsageSample, 'sampledAt'>): void {
  for (const [field, value] of Object.entries(sample)) {
    if (field === 'path') continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid disk sample field: ${field}`);
    }
  }
  if (!sample.path) throw new Error('Invalid disk sample field: path');
  if (sample.totalBytes <= 0 || sample.usedBytes > sample.totalBytes || sample.usedRatio > 1) {
    throw new Error('Invalid disk sample totals.');
  }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
