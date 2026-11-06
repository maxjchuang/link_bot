import type { TaskPoolConfig } from '../domain/types.js';
import type { SqliteStateStore } from '../state/SqliteStateStore.js';
import type { TaskRecord } from '../tasks/TaskTypes.js';
import type { ReadyPoolController } from './ReadyPoolController.js';

export interface HostResourceSample {
  totalBytes: number;
  usedBytes: number;
  managerAndInfrastructureBytes: number;
  activeTurnPeakReserveBytes: number;
  readySlotReserveBytes: number;
}

export interface HostResourceSampler {
  sample(): Promise<HostResourceSample>;
}

export interface EvictionRuntime {
  gracefulStop(task: TaskRecord): Promise<void>;
}

export interface CapacityResult {
  effectiveHotLimit: number;
  discardedReadySlotIds: string[];
  warmedTaskIds: string[];
  reserved: boolean;
}

export class ResourceController {
  private capacityQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: SqliteStateStore,
    private readonly sampler: HostResourceSampler,
    private readonly runtime: EvictionRuntime,
    private readonly readyPool: ReadyPoolController,
    private readonly config: TaskPoolConfig,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  ensureCapacityForStart(taskId: string): Promise<CapacityResult> {
    const current = this.capacityQueue.then(() => this.ensureCapacity(taskId));
    this.capacityQueue = current.then(() => undefined, () => undefined);
    return current;
  }

  claimActiveTurn(taskId: string, turnId: string, ownerLimit?: { ownerId: string; maxActiveTurns: number }): boolean {
    return this.store.claimActiveTurn(taskId, turnId, this.config.maxActiveTurns, ownerLimit);
  }

  releaseActiveTurn(turnId: string): boolean {
    return this.store.releaseActiveTurn(turnId);
  }

  completeHotStart(taskId: string, succeeded: boolean): TaskRecord | undefined {
    return this.store.completeHotStart(taskId, succeeded);
  }

  touchUserInteraction(taskId: string): TaskRecord | undefined {
    const task = this.store.getTask(taskId);
    if (!task) return undefined;
    const now = this.clock().toISOString();
    const touched = { ...task, lastUserInteractionAt: now, updatedAt: now };
    this.store.saveTask(touched);
    return touched;
  }

  async underMemoryPressure(): Promise<boolean> {
    const sample = await this.sampleHost();
    return sample.usedBytes / sample.totalBytes >= this.config.memoryHighWatermark
      || sample.totalBytes - sample.usedBytes < this.config.safetyReserveBytes;
  }

  effectiveHotLimit(sample: HostResourceSample): number {
    const since = new Date(this.clock().getTime() - this.config.idleMemorySampleWindowDays * 86_400_000).toISOString();
    const idleP95 = this.store.resourceSampleP95('idle_task_rss', since);
    if (!idleP95) return this.config.maxHotTasks;
    const available = sample.totalBytes
      - sample.managerAndInfrastructureBytes
      - sample.activeTurnPeakReserveBytes
      - sample.readySlotReserveBytes
      - this.config.safetyReserveBytes;
    return Math.max(0, Math.min(this.config.maxHotTasks, Math.floor(available / idleP95)));
  }

  private async ensureCapacity(taskId: string): Promise<CapacityResult> {
    const currentTask = this.store.getTask(taskId);
    if (currentTask?.runtimeState === 'hot') {
      const sample = await this.sampler.sample();
      return { effectiveHotLimit: this.effectiveHotLimit(sample), discardedReadySlotIds: [], warmedTaskIds: [], reserved: false };
    }
    let sample = await this.sampleHost();
    const effectiveHotLimit = this.effectiveHotLimit(sample);
    if (effectiveHotLimit < 1) throw new Error('No memory capacity is available for a hot task.');
    const discardedReadySlotIds: string[] = [];
    const warmedTaskIds: string[] = [];
    let pressure = this.pressure(sample, effectiveHotLimit, false, taskId);
    const memoryEvictionCycle = pressure.memory;

    while (pressure.any) {
      const slot = await this.readyPool.reclaimOneSurplus();
      if (!slot) break;
      discardedReadySlotIds.push(slot.id);
      sample = await this.sampleHost();
      pressure = this.pressure(sample, effectiveHotLimit, memoryEvictionCycle, taskId);
    }

    while (pressure.any) {
      const victim = this.store.listEvictableHotTasks().find((task) => task.id !== taskId);
      if (!victim) throw new Error('Capacity pressure has no evictable hot task.');
      const now = this.clock().toISOString();
      const intentId = `evict:${victim.id}:${Date.parse(now)}`;
      this.store.beginLifecycleIntent({
        id: intentId, taskId: victim.id, fromState: 'hot', toState: 'warming', status: 'pending',
        createdAt: now, updatedAt: now,
      });
      await this.runtime.gracefulStop(victim);
      this.store.completeLifecycleIntent(intentId, 'warm');
      warmedTaskIds.push(victim.id);
      sample = await this.sampleHost();
      pressure = this.pressure(sample, effectiveHotLimit, memoryEvictionCycle, taskId);
    }
    if (!this.store.claimHotStart(taskId, effectiveHotLimit)) {
      throw new Error('Hot-task capacity changed before the start reservation was claimed.');
    }
    return { effectiveHotLimit, discardedReadySlotIds, warmedTaskIds, reserved: true };
  }

  private pressure(
    sample: HostResourceSample,
    effectiveHotLimit: number,
    evictionCycle: boolean,
    taskId: string,
  ): { any: boolean; memory: boolean; count: boolean } {
    const ratio = sample.usedBytes / sample.totalBytes;
    const memory = evictionCycle
      ? ratio > this.config.memoryLowWatermark
      : ratio >= this.config.memoryHighWatermark;
    const count = this.store.hotCapacityCount() >= effectiveHotLimit
      && !this.store.isHotCapacityUnitActive(taskId);
    return { any: memory || count, memory, count };
  }

  private async sampleHost(): Promise<HostResourceSample> {
    const sample = await this.sampler.sample();
    this.store.recordResourceSample({ sampleType: 'host_used', bytes: sample.usedBytes });
    return sample;
  }
}
