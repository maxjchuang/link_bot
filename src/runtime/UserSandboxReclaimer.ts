import type { SqliteStateStore } from '../state/SqliteStateStore.js';
import type { TaskRecord } from '../tasks/TaskTypes.js';

export interface UserSandboxReclaimResult {
  stoppedTaskIds: string[];
  reclaimedOwnerIds: string[];
  failures: Array<{ target: string; error: string }>;
}

export class UserSandboxReclaimer {
  constructor(
    private readonly store: SqliteStateStore,
    private readonly lifecycle: {
      stopTaskProcess(task: TaskRecord): Promise<void>;
      reclaimSandbox(ownerId: string): Promise<unknown>;
    },
    private readonly config: { processIdleMs: number; wrapperIdleMs: number },
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async run(): Promise<UserSandboxReclaimResult> {
    const result: UserSandboxReclaimResult = { stoppedTaskIds: [], reclaimedOwnerIds: [], failures: [] };
    const cutoff = this.clock().getTime() - this.config.processIdleMs;
    for (const candidate of this.store.listTasks()) {
      if (candidate.runtimeMode !== 'user-sandbox' || candidate.runtimeState !== 'hot' || candidate.activeTurnId) continue;
      if (Date.parse(candidate.lastUserInteractionAt) > cutoff) continue;
      try {
        await this.store.withTaskLock(candidate.id, async () => {
          const task = this.store.getTask(candidate.id);
          if (!task || task.runtimeMode !== 'user-sandbox' || task.runtimeState !== 'hot' || task.activeTurnId) return;
          if (Date.parse(task.lastUserInteractionAt) > cutoff) return;
          await this.lifecycle.stopTaskProcess(task);
          this.store.updateTask(task.id, (current) => ({
            ...current, runtimeState: 'warm', activeTurnId: undefined, updatedAt: this.clock().toISOString(),
          }));
          result.stoppedTaskIds.push(task.id);
        });
      } catch (error) {
        result.failures.push({ target: candidate.id, error: safeError(error) });
      }
    }

    const wrapperCutoff = this.clock().getTime() - this.config.wrapperIdleMs;
    for (const sandbox of this.store.listUserSandboxes()) {
      if (sandbox.status !== 'running' || Date.parse(sandbox.lastActiveAt) > wrapperCutoff) continue;
      const ownerBusy = this.store.listTasks().some((task) =>
        task.runtimeMode === 'user-sandbox'
        && task.ownerUserId === sandbox.ownerId
        && (Boolean(task.activeTurnId) || ['hot', 'warming', 'provisioning'].includes(task.runtimeState)),
      );
      if (ownerBusy) continue;
      try {
        await this.lifecycle.reclaimSandbox(sandbox.ownerId);
        result.reclaimedOwnerIds.push(sandbox.ownerId);
      } catch (error) {
        result.failures.push({ target: sandbox.ownerId, error: safeError(error) });
      }
    }
    return result;
  }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}
