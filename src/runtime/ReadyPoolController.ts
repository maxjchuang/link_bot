import { createHash } from 'node:crypto';
import type { ReadyPoolConfig } from '../domain/types.js';
import type { ReadySlotRecord, SqliteStateStore } from '../state/SqliteStateStore.js';

export interface ReadySlotRuntime {
  create(versionKey: string): Promise<ReadySlotRecord>;
  destroy(slot: ReadySlotRecord): Promise<void>;
}

export class ReadyPoolController {
  private readonly replenishments = new Map<string, Promise<void>>();

  constructor(
    private readonly store: SqliteStateStore,
    private readonly runtime: ReadySlotRuntime,
    private readonly config: ReadyPoolConfig,
  ) {}

  claim(versionKey: string, taskId: string): ReadySlotRecord | undefined {
    if (!this.config.enabled) return undefined;
    const claimed = this.store.claimReadySlot(versionKey, taskId);
    if (claimed) this.replenishInBackground(versionKey);
    return claimed;
  }

  async replenish(versionKey: string): Promise<void> {
    if (!this.config.enabled) return;
    const existing = this.replenishments.get(versionKey);
    if (existing) return existing;
    const replenishment = (async () => {
      while (this.store.listReadySlots(versionKey).length < this.config.defaultMinReady) {
        if (this.store.listReadySlots(versionKey).length >= this.config.defaultMaxReady) return;
        const slot = await this.runtime.create(versionKey);
        this.store.saveReadySlot(slot);
      }
    })();
    this.replenishments.set(versionKey, replenishment);
    try {
      await replenishment;
    } finally {
      if (this.replenishments.get(versionKey) === replenishment) this.replenishments.delete(versionKey);
    }
  }

  async reclaimOneSurplus(): Promise<ReadySlotRecord | undefined> {
    const slots = this.store.listReadySlots();
    const counts = new Map<string, number>();
    for (const slot of slots) counts.set(slot.versionKey, (counts.get(slot.versionKey) ?? 0) + 1);
    const slot = slots.find((candidate) => (counts.get(candidate.versionKey) ?? 0) > this.config.defaultMinReady);
    if (!slot) return undefined;
    const discarded = this.store.discardReadySlot(slot.id);
    if (!discarded) return undefined;
    await this.runtime.destroy(discarded);
    return discarded;
  }

  waitForReplenishment(): Promise<void> | undefined {
    const active = [...this.replenishments.values()];
    return active.length > 0 ? Promise.all(active).then(() => undefined) : undefined;
  }

  private replenishInBackground(versionKey: string): void {
    void this.replenish(versionKey).catch(() => undefined);
  }
}

export function readySlotVersionKey(input: {
  projectId: string;
  runtimeImageVersion: string;
  codexCliVersion: string;
  baseCommit: string;
  dependencyLockHash: string;
  setupVersion: string;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
