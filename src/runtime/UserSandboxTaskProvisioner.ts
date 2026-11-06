import type { ProjectConfig } from '../domain/types.js';
import type { SqliteStateStore } from '../state/SqliteStateStore.js';
import type { ProvisionedTaskRuntime,TaskRuntimeProvisioner } from '../tasks/TaskPlatformService.js';
import { projectTask,taskMode,type TaskRecord,type TaskRuntimeState } from '../tasks/TaskTypes.js';
import type { UserSandboxManager } from './UserSandboxManager.js';

export class UserSandboxTaskProvisioner implements Pick<
  TaskRuntimeProvisioner,
  'provision'|'resume'|'stop'|'delete'|'observeTaskState'|'stageInboundAttachment'|'exportArtifact'|'removeInboundAttachments'|'refreshCodexAuth'
> {
  constructor(
    private readonly store: SqliteStateStore,
    private readonly sandboxes: UserSandboxManager,
  ) {}

  async provision(input: {
    taskId: string; ownerUserId: string; project?: ProjectConfig; genericWorkspace?: boolean;
    workspaceFiles?: { agents: string; projects: string };
  }): Promise<ProvisionedTaskRuntime> {
    const task = this.requireSandboxTask(input.taskId);
    if (task.ownerUserId !== input.ownerUserId) throw new Error('User sandbox task owner mismatch.');
    if (taskMode(task) === 'chat' && input.project) throw new Error('Chat task cannot load a project.');
    if (taskMode(task) === 'project' && !input.project) throw new Error('Project task required');
    const ensured = await this.sandboxes.ensure(input.ownerUserId);
    return this.result(task, ensured.sandbox.id, input.project);
  }

  async resume(task: TaskRecord, project?: ProjectConfig): Promise<ProvisionedTaskRuntime> {
    this.requireSandboxTask(task.id);
    if (taskMode(task) === 'chat' && project) throw new Error('Chat task cannot load a project.');
    if (taskMode(task) === 'project' && !project) throw new Error('Project task required');
    const ensured = await this.sandboxes.ensure(task.ownerUserId, { leaseWaitMs: 60_000 });
    return this.result(task, ensured.sandbox.id, project);
  }

  async prepareProjectBinding(task: TaskRecord, project: ProjectConfig): Promise<ProvisionedTaskRuntime> {
    const current = this.requireSandboxTask(task.id);
    if (current.ownerUserId !== task.ownerUserId) {
      throw new Error('Only the owning task can prepare a project bind.');
    }
    const cloneUrl = project.sandboxCloneUrl ?? (project.repositoryPath
      ? `git@github.com:${project.repositoryPath}.git` : undefined);
    if (!cloneUrl) throw new SandboxProjectBootstrapError(`Project ${project.id} has no sandbox clone URL.`);
    const baseRef = project.baseRef ?? 'main';
    if (project.sandboxLocalPath) {
      const existing = await this.sandboxes.inspectLocalProject(task.ownerUserId,project.sandboxLocalPath,cloneUrl);
      const ensured = await this.sandboxes.ensure(task.ownerUserId);
      return {cwd:existing.localPath!,branchName:existing.branchName,runtimeId:ensured.sandbox.id,startupType:'warm'};
    }
    const initialized = await this.sandboxes.ensureProjectWorkspace(task.ownerUserId, {
      projectId: project.id, cloneUrl, baseRef,
    });
    if (initialized.status !== 'ready') {
      throw new SandboxProjectBootstrapError(`Project ${project.id} requires sandbox Git authentication before binding.`);
    }
    const ensured = await this.sandboxes.ensure(task.ownerUserId);
    return { cwd: initialized.cwd, branchName: initialized.branchName ?? `codex/${task.ownerUserId}/${task.id}`,
      runtimeId: ensured.sandbox.id, startupType: 'warm' };
  }

  async stop(task: TaskRecord): Promise<void> {
    this.requireSandboxTask(task.id);
    // The App Server backend stops the task process. The owner sandbox remains
    // available for sibling tasks and later resumptions.
  }

  async refreshCodexAuth(task: TaskRecord): Promise<void> {
    const current = this.requireSandboxTask(task.id);
    await this.sandboxes.refreshCodexAuth(current.ownerUserId);
  }

  async delete(task: TaskRecord): Promise<void> {
    await this.stop(task);
  }

  async observeTaskState(task: TaskRecord): Promise<TaskRuntimeState> {
    const current = this.requireSandboxTask(task.id);
    const sandbox = this.store.getUserSandboxByOwner(current.ownerUserId);
    return sandbox?.status === 'running' ? 'hot' : sandbox?.status === 'failed' ? 'failed' : 'warm';
  }

  async stageInboundAttachment(task: TaskRecord, turnId: string, source: string, fileName: string): Promise<string> {
    const current = this.requireSandboxTask(task.id);
    return this.sandboxes.stageTaskAttachment(current.ownerUserId, task.id, turnId, source, fileName, current.sandboxWorkspaceLayout);
  }

  async exportArtifact(task: TaskRecord, sourcePath: string, destination: string): Promise<void> {
    const current = this.requireSandboxTask(task.id);
    await this.sandboxes.exportTaskArtifact(current.ownerUserId, task.id, sourcePath, destination, current.sandboxWorkspaceLayout);
  }

  async removeInboundAttachments(task: TaskRecord, turnId: string): Promise<void> {
    const current = this.requireSandboxTask(task.id);
    await this.sandboxes.removeTaskAttachments(current.ownerUserId, task.id, turnId, current.sandboxWorkspaceLayout);
  }

  async fallbackToLegacy(taskId: string, ownerUserId: string): Promise<TaskRecord> {
    await this.sandboxes.reclaim(ownerUserId);
    const task = this.store.fallbackUnstartedUserSandboxTaskToLegacy(taskId);
    if (!task) throw new Error(`User sandbox task cannot fall back to legacy mode: ${taskId}`);
    return task;
  }

  private requireSandboxTask(taskId: string): TaskRecord {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.runtimeMode !== 'user-sandbox') throw new Error(`Task is not assigned to a user sandbox: ${taskId}`);
    return task;
  }

  private async result(task: TaskRecord, sandboxId: string, project?: ProjectConfig): Promise<ProvisionedTaskRuntime> {
    let cwd = `/workspace/tasks/${safeTaskDirectory(task.id)}`;
    if (task.sandboxWorkspaceLayout === 'project') {
      if (!project || project.id !== task.projectId) throw new Error(`Project is unavailable for sandbox task: ${task.projectId}`);
      const cloneUrl = project.sandboxCloneUrl ?? (project.repositoryPath
        ? `git@github.com:${project.repositoryPath}.git` : undefined);
      if (!cloneUrl) throw new SandboxProjectBootstrapError(`Project ${project.id} has no sandbox clone URL.`);
      if (project.sandboxLocalPath) return this.prepareProjectBinding(task,project);
      try {
        const initialized = await this.sandboxes.ensureProjectWorkspace(task.ownerUserId, {
          projectId: project.id, cloneUrl, baseRef: projectTask(task).baseRef,
        });
        cwd = initialized.cwd;
      } catch (error) {
        throw new SandboxProjectBootstrapError(`Unable to prepare sandbox project ${project.id}: ${String(error)}`);
      }
    }
    return {
      cwd,
      branchName: task.branchName,
      runtimeId: sandboxId,
      startupType: 'warm',
    };
  }
}

export class SandboxProjectBootstrapError extends Error {}

export function modeAwareTaskProvisioner(
  store: SqliteStateStore,
  legacy: TaskRuntimeProvisioner,
  sandbox: UserSandboxTaskProvisioner,
  legacyFallbackEnabled = false,
): TaskRuntimeProvisioner {
  const core = {
    provision: async (input: Parameters<TaskRuntimeProvisioner['provision']>[0]) => {
      const task = store.getTask(input.taskId);
      if (task?.runtimeMode !== 'user-sandbox') {
        if (!input.project) throw new Error('Project task required');
        return legacy.provision(input);
      }
      try {
        return await sandbox.provision(input);
      } catch (error) {
        if (taskMode(task) === 'chat' || !legacyFallbackEnabled || error instanceof SandboxProjectBootstrapError) throw error;
        await sandbox.fallbackToLegacy(input.taskId, input.ownerUserId);
        return legacy.provision(input);
      }
    },
    resume: async (...args: Parameters<TaskRuntimeProvisioner['resume']>) => {
      if (args[0].runtimeMode === 'user-sandbox') return sandbox.resume(args[0], args[1]);
      if (!args[1]) throw new Error('Project task required');
      return legacy.resume(...args);
    },
    prepareProjectBinding: async (task: TaskRecord, project: ProjectConfig) => {
      if (task.runtimeMode !== 'user-sandbox') throw new Error('Project binding requires a user sandbox.');
      return sandbox.prepareProjectBinding(task, project);
    },
    stop: async (task: TaskRecord) => task.runtimeMode === 'user-sandbox' ? sandbox.stop(task) : legacy.stop(task),
    refreshCodexAuth: async (task: TaskRecord) => {
      if (task.runtimeMode === 'user-sandbox') return sandbox.refreshCodexAuth(task);
      if (!legacy.refreshCodexAuth) throw new Error('Runtime does not support Codex credential refresh.');
      return legacy.refreshCodexAuth(task);
    },
    delete: async (task: TaskRecord) => task.runtimeMode === 'user-sandbox' ? sandbox.delete(task) : legacy.delete(task),
    observeTaskState: async (task: TaskRecord) => task.runtimeMode === 'user-sandbox'
      ? sandbox.observeTaskState(task)
      : legacy.observeTaskState?.(task) ?? task.runtimeState,
    stageInboundAttachment: async (task: TaskRecord, turnId: string, source: string, fileName: string) =>
      task.runtimeMode === 'user-sandbox'
        ? sandbox.stageInboundAttachment(task, turnId, source, fileName)
        : legacy.stageInboundAttachment
          ? legacy.stageInboundAttachment(task, turnId, source, fileName)
          : Promise.reject(new Error('Runtime operation is unavailable: stageInboundAttachment')),
    exportArtifact: async (task: TaskRecord, sourcePath: string, destination: string) =>
      task.runtimeMode === 'user-sandbox'
        ? sandbox.exportArtifact(task, sourcePath, destination)
        : legacy.exportArtifact
          ? legacy.exportArtifact(task, sourcePath, destination)
          : Promise.reject(new Error('Runtime operation is unavailable: exportArtifact')),
    removeInboundAttachments: async (task: TaskRecord, turnId: string) =>
      task.runtimeMode === 'user-sandbox'
        ? sandbox.removeInboundAttachments(task, turnId)
        : legacy.removeInboundAttachments
          ? legacy.removeInboundAttachments(task, turnId)
          : Promise.reject(new Error('Runtime operation is unavailable: removeInboundAttachments')),
  };
  return new Proxy(core as TaskRuntimeProvisioner, {
    get(target, property, receiver) {
      if (property in target) return Reflect.get(target, property, receiver);
      const value = Reflect.get(legacy as object, property);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const task = args[0];
        if (isUserSandboxTask(task)) {
          throw new Error(`Operation ${String(property)} is not available on transparent user-sandbox tasks.`);
        }
        return Reflect.apply(value, legacy, args);
      };
    },
  });
}

function isUserSandboxTask(value: unknown): value is TaskRecord {
  return Boolean(value && typeof value === 'object' && (value as { runtimeMode?: unknown }).runtimeMode === 'user-sandbox');
}

function safeTaskDirectory(taskId: string): string {
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(taskId)) throw new Error('Unsafe user sandbox task id.');
  return taskId.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 120);
}
