import { createHash } from 'node:crypto';
import type { ProjectConfig } from '../domain/types.js';
import type { SqliteStateStore } from '../state/SqliteStateStore.js';
import { projectTask, type TaskRecord, type TaskRepositoryRecord } from '../tasks/TaskTypes.js';
import { normalizeRepositoryBaseRef } from '../projects/WorkspacePlanParser.js';

export interface TaskRepositoryRuntime {
  resolveDefaultBaseRef?(project: ProjectConfig): Promise<string>;
  addRepository(task: TaskRecord, project: ProjectConfig, repository: TaskRepositoryRecord): Promise<{ baseCommit: string }>;
}

export interface AddTaskRepositoryInput {
  taskId: string;
  project: ProjectConfig;
  baseRef?: string;
  addedBy: string;
  allowActiveTurn?: boolean;
  projectsLayout?: boolean;
}

export class TaskRepositoryService {
  constructor(
    private readonly store: SqliteStateStore,
    private readonly runtime: TaskRepositoryRuntime,
    private readonly validateAccess: (input: { task: TaskRecord; project: ProjectConfig; userId: string }) => void,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  ensurePrimary(task: TaskRecord, project: ProjectConfig, addedBy: string): TaskRepositoryRecord {
    const selected = projectTask(task);
    const existing = this.store.listTaskRepositories(task.id).find((repository) => repository.isPrimary);
    if (existing) return existing;
    const now = this.clock().toISOString();
    const repository: TaskRepositoryRecord = {
      id: `repository:${task.id}:primary`, taskId: task.id, projectId: project.id, checkoutPath: '/workspace',
      baseRef: selected.baseRef, branchName: selected.branchName, isPrimary: true, addedBy, status: 'ready',
      createdAt: now, updatedAt: now,
    };
    this.store.saveTaskRepository(repository);
    return repository;
  }

  async add(input: AddTaskRepositoryInput): Promise<TaskRepositoryRecord> {
    // Reopening an already materialized repository is a read-only lookup. Keep
    // it off the task mutation queue so a slow, unrelated task operation cannot
    // make project_open appear to have silently died.
    const currentTask = this.requireLoadableTask(input.taskId);
    const requestedBaseRef = input.baseRef
      ? normalizeRepositoryBaseRef(input.project.id, input.baseRef)
      : undefined;
    const loaded = this.store.listTaskRepositories(input.taskId)
      .find((repository) => repository.projectId === input.project.id);
    if (loaded && (loaded.status === 'ready' || loaded.status === undefined)) {
      this.validateAccess({ task: currentTask, project: input.project, userId: input.addedBy });
      if (requestedBaseRef && requestedBaseRef !== loaded.baseRef) {
        throw alreadyLoadedFromDifferentBase(input.project.id, loaded.baseRef, requestedBaseRef);
      }
      return loaded;
    }
    return this.store.withTaskLock(input.taskId, async () => this.addUnderTaskLock(input));
  }

  /** Caller must already hold the task mutation lock. */
  async addUnderTaskLock(input: AddTaskRepositoryInput): Promise<TaskRepositoryRecord> {
    const task = input.allowActiveTurn ? this.requireLoadableTask(input.taskId) : this.requireIdleTask(input.taskId);
    this.validateAccess({ task, project: input.project, userId: input.addedBy });
    const normalizedInputBaseRef = input.baseRef
      ? normalizeRepositoryBaseRef(input.project.id, input.baseRef)
      : undefined;
    const existing = this.store.listTaskRepositories(task.id).find((repository) => repository.projectId === input.project.id);
    if (existing && (existing.status === 'ready' || existing.status === undefined)) {
      if (normalizedInputBaseRef && normalizedInputBaseRef !== existing.baseRef) {
        throw alreadyLoadedFromDifferentBase(input.project.id, existing.baseRef, normalizedInputBaseRef);
      }
      return existing;
    }
    const now = this.clock().toISOString();
    const baseRef = normalizedInputBaseRef
      ?? await this.runtime.resolveDefaultBaseRef?.(input.project)
      ?? input.project.baseRef
      ?? 'main';
    const repository = existing
      ? { ...existing, baseRef, baseCommit: undefined, failure: undefined }
      : repositoryRecord(task, input.project, baseRef, input.addedBy, now, input.projectsLayout);
    const provisioning: TaskRepositoryRecord = {
      ...repository, status: 'provisioning', failure: undefined, updatedAt: now,
    };
    this.store.saveTaskRepository(provisioning);
    try {
      const result = await this.runtime.addRepository(task, input.project, provisioning);
      const currentTask = this.store.getTask(task.id);
      if (!currentTask || currentTask.runtimeId !== task.runtimeId || currentTask.runtimeState !== task.runtimeState) {
        throw new Error('Task runtime changed while adding repository.');
      }
      this.validateAccess({ task: currentTask, project: input.project, userId: input.addedBy });
      const ready: TaskRepositoryRecord = {
        ...provisioning, baseCommit: result.baseCommit, status: 'ready', updatedAt: this.clock().toISOString(),
      };
      this.store.saveTaskRepository(ready);
      return ready;
    } catch (error) {
      this.store.saveTaskRepository({
        ...provisioning, status: 'failed', failure: safeError(error), updatedAt: this.clock().toISOString(),
      });
      throw error;
    }
  }

  list(taskId: string): TaskRepositoryRecord[] {
    return this.store.listTaskRepositories(taskId);
  }

  resolve(taskId: string, selector?: string): TaskRepositoryRecord {
    const repositories = this.list(taskId).filter((repository) => repository.status !== 'failed');
    const selected = selector
      ? repositories.find((repository) => repository.id === selector || repository.projectId === selector)
      : repositories.find((repository) => repository.isPrimary);
    if (!selected) throw new Error(selector ? `Task repository not found: ${selector}` : 'Task has no primary repository.');
    return selected;
  }

  private requireIdleTask(taskId: string): TaskRecord {
    const task = this.requireLoadableTask(taskId);
    if (task.activeTurnId || this.store.listTurnsByTask(taskId).some((turn) => !isTerminal(turn.state))) {
      throw new Error('Cannot add a repository while a turn is active.');
    }
    return task;
  }

  private requireLoadableTask(taskId: string): TaskRecord {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.runtimeState !== 'hot' && task.runtimeState !== 'warm') {
      throw new Error(`Task cannot add a repository from ${task.runtimeState}.`);
    }
    return task;
  }
}

function alreadyLoadedFromDifferentBase(projectId: string, currentBase: string, requestedBase: string): Error {
  return new Error(
    `Project ${projectId} is already loaded from ${currentBase}; it cannot be silently reopened from ${requestedBase}. `
    + `Start a new task from ${requestedBase}, or rebase the existing task commit before publishing.`,
  );
}

function repositoryRecord(
  task: TaskRecord,
  project: ProjectConfig,
  baseRef: string | undefined,
  addedBy: string,
  now: string,
  projectsLayout = false,
): TaskRepositoryRecord {
  const digest = createHash('sha256').update(project.id).digest('hex').slice(0, 10);
  const slug = project.id.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'repository';
  return {
    id: `repository:${task.id}:${digest}`,
    taskId: task.id,
    projectId: project.id,
    checkoutPath: projectsLayout ? `/workspace/projects/${project.id}` : `/workspace/repositories/${slug}-${digest}`,
    baseRef: baseRef ?? project.baseRef ?? 'main',
    branchName: `codex/${safeBranchPart(addedBy)}/${safeBranchPart(task.id)}/${digest}`,
    isPrimary: false,
    addedBy,
    createdAt: now,
    updatedAt: now,
  };
}

function safeBranchPart(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
  if (!safe) throw new Error('Identifier has no Git-safe characters.');
  return safe;
}

function isTerminal(state: string): boolean {
  return state === 'completed' || state === 'interrupted' || state === 'failed';
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/(?:https?:\/\/)[^\s@]+@/g, 'https://[redacted]@').slice(0, 500);
}
