import { randomUUID } from 'node:crypto';
import type { CodexBackend } from '../backends/CodexBackend.js';
import type { SqliteStateStore } from '../state/SqliteStateStore.js';
import type { TaskContextRecord } from '../tasks/TaskTypes.js';

export interface ContextCheckpointWriter {
  create(input: { taskId: string; context: TaskContextRecord; createdBy: string }): Promise<{ memoryId: string } | undefined>;
}

export class TaskContextService {
  constructor(
    private readonly store: SqliteStateStore,
    private readonly backend: Pick<CodexBackend, 'createContext' | 'resumeContext' | 'archiveContext' | 'compactContext'>,
    private readonly checkpoints?: ContextCheckpointWriter,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async createNew(input: { taskId: string; createdBy: string; blank?: boolean; mediaToolRevision?: number; projectBindingToolRevision?: number }): Promise<TaskContextRecord> {
    return this.store.withTaskLock(input.taskId, async () => this.createNewLocked(input));
  }

  /**
   * Persist a replacement thread that was opened by task recovery while the
   * caller already holds the task lock. This keeps thread fallback and normal
   * context rotation on the same durable checkpoint/activation path.
   */
  async adoptOpenedContext(input: { taskId: string; threadId: string; createdBy: string; mediaToolRevision?: number; projectBindingToolRevision?: number;
    commit?: (context: TaskContextRecord) => void }): Promise<TaskContextRecord> {
    const previous = this.store.getActiveTaskContext(input.taskId);
    const checkpoint = previous
      ? await this.checkpoints?.create({ taskId: input.taskId, context: previous, createdBy: input.createdBy })
      : undefined;
    const now = this.clock().toISOString();
    const context: TaskContextRecord = {
      id: `context_${randomUUID()}`,
      taskId: input.taskId,
      codexThreadId: input.threadId,
      state: 'active',
      ...(checkpoint ? { checkpointMemoryId: checkpoint.memoryId } : {}),
      ...(input.mediaToolRevision ? { mediaToolRevision: input.mediaToolRevision } : {}),
      ...(input.projectBindingToolRevision ? { projectBindingToolRevision: input.projectBindingToolRevision } : {}),
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    this.store.db.transaction(()=>{
      this.store.activateTaskContext(context);
      input.commit?.(context);
    })();
    if (previous) {
      await this.backend.archiveContext?.({ taskId: input.taskId, threadId: previous.codexThreadId }).catch(() => undefined);
    }
    return context;
  }

  async use(input: { taskId: string; contextId: string }): Promise<TaskContextRecord> {
    return this.store.withTaskLock(input.taskId, async () => {
      this.requireIdleTask(input.taskId);
      const selected = this.store.getTaskContext(input.contextId);
      if (!selected || selected.taskId !== input.taskId) throw new Error('Task context not found.');
      const previous = this.store.getActiveTaskContext(input.taskId);
      if (previous?.id === selected.id) return previous;
      const resumeContext = requireOperation(this.backend.resumeContext, 'resumeContext');
      const opened = await resumeContext.call(this.backend, { taskId: input.taskId, threadId: selected.codexThreadId });
      const now = this.clock().toISOString();
      const active = { ...selected, codexThreadId: opened.threadId, state: 'active' as const, archivedAt: undefined, updatedAt: now };
      try {
        this.store.activateTaskContext(active);
      } catch (error) {
        if (previous) await resumeContext.call(this.backend, { taskId: input.taskId, threadId: previous.codexThreadId }).catch(() => undefined);
        throw error;
      }
      if (previous) {
        await this.backend.archiveContext?.({ taskId: input.taskId, threadId: previous.codexThreadId }).catch(() => undefined);
      }
      return active;
    });
  }

  async compact(taskId: string): Promise<void> {
    return this.store.withTaskLock(taskId, async () => {
      this.requireIdleTask(taskId);
      const compactContext = requireOperation(this.backend.compactContext, 'compactContext');
      await compactContext.call(this.backend, { taskId });
    });
  }

  observeUsage(input: { taskId: string; threadId: string; usage: unknown }): TaskContextRecord | undefined {
    const active = this.store.getActiveTaskContext(input.taskId);
    if (!active || active.codexThreadId !== input.threadId) return undefined;
    const usage = parseUsage(input.usage);
    if (!usage) return undefined;
    const updated: TaskContextRecord = {
      ...active,
      usage: { ...usage, observedAt: this.clock().toISOString() },
      updatedAt: this.clock().toISOString(),
    };
    this.store.saveTaskContext(updated);
    return updated;
  }

  list(taskId: string): TaskContextRecord[] {
    return this.store.listTaskContexts(taskId);
  }

  reconcile(taskId: string, createdBy = 'system:reconciliation'): TaskContextRecord | undefined {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const active = this.store.getActiveTaskContext(taskId);
    if (active) {
      if (task.codexThreadId !== active.codexThreadId) {
        this.store.updateTask(taskId, (current) => ({
          ...current, codexThreadId: active.codexThreadId, updatedAt: this.clock().toISOString(),
        }));
      }
      return active;
    }
    if (!task.codexThreadId) return undefined;
    const now = this.clock().toISOString();
    const recovered: TaskContextRecord = {
      id: `context_${randomUUID()}`, taskId, codexThreadId: task.codexThreadId, state: 'active', createdBy,
      createdAt: now, updatedAt: now,
    };
    this.store.activateTaskContext(recovered);
    return recovered;
  }

  private requireIdleTask(taskId: string): void {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.activeTurnId || this.store.listTurnsByTask(taskId).some((turn) => !isTerminal(turn.state))) {
      throw new Error('Cannot change context while a turn is active.');
    }
    if (task.runtimeState !== 'hot') throw new Error('Task must be hot to change context.');
  }

  private async createNewLocked(input: { taskId: string; createdBy: string; blank?: boolean; mediaToolRevision?: number; projectBindingToolRevision?: number }): Promise<TaskContextRecord> {
    this.requireIdleTask(input.taskId);
    const previous = this.store.getActiveTaskContext(input.taskId);
    const checkpoint = !input.blank && previous
      ? await this.checkpoints?.create({ taskId: input.taskId, context: previous, createdBy: input.createdBy })
      : undefined;
    const createContext = requireOperation(this.backend.createContext, 'createContext');
    const opened = await createContext.call(this.backend, { taskId: input.taskId });
    const now = this.clock().toISOString();
    const context: TaskContextRecord = {
      id: `context_${randomUUID()}`,
      taskId: input.taskId,
      codexThreadId: opened.threadId,
      state: 'active',
      ...(checkpoint ? { checkpointMemoryId: checkpoint.memoryId } : {}),
      ...(input.mediaToolRevision ? { mediaToolRevision: input.mediaToolRevision } : {}),
      ...(input.projectBindingToolRevision ? { projectBindingToolRevision: input.projectBindingToolRevision } : {}),
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    try {
      this.store.activateTaskContext(context);
    } catch (error) {
      if (previous) await this.backend.resumeContext?.({ taskId: input.taskId, threadId: previous.codexThreadId }).catch(() => undefined);
      throw error;
    }
    if (previous) {
      await this.backend.archiveContext?.({ taskId: input.taskId, threadId: previous.codexThreadId }).catch(() => undefined);
    }
    return context;
  }
}

function requireOperation<T extends (...args: never[]) => unknown>(operation: T | undefined, name: string): T {
  if (!operation) throw new Error(`Codex backend does not support ${name}.`);
  return operation;
}

function isTerminal(state: string): boolean {
  return state === 'completed' || state === 'interrupted' || state === 'failed';
}

function parseUsage(value: unknown): { totalTokens: number; currentTokens: number; modelContextWindow: number } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const total = record.total;
  const totalTokens = total && typeof total === 'object' && !Array.isArray(total)
    ? (total as Record<string, unknown>).totalTokens
    : undefined;
  const last = record.last;
  const currentTokens = last && typeof last === 'object' && !Array.isArray(last)
    ? (last as Record<string, unknown>).totalTokens
    : undefined;
  if (typeof totalTokens !== 'number' || !Number.isFinite(totalTokens) || totalTokens < 0) return undefined;
  if (typeof currentTokens !== 'number' || !Number.isFinite(currentTokens) || currentTokens < 0) return undefined;
  const window = record.modelContextWindow;
  if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) return undefined;
  return { totalTokens, currentTokens, modelContextWindow: window };
}
