import { randomUUID } from 'node:crypto';
import type { SqliteStateStore } from '../state/SqliteStateStore.js';
import type { UserSandboxRecord } from '../tasks/TaskTypes.js';
import type { DockerUserSandboxRuntime, UserSandboxDockerRuntime } from './UserSandboxDockerRuntime.js';
import type { SupervisorProjectWorkspace } from './SandboxSupervisorClient.js';
import { SandboxSupervisorClient } from './SandboxSupervisorClient.js';
import type { SandboxRepoRequest, SandboxRepoResult } from '../projects/SandboxRepositoryCreationTypes.js';

type RepositoryCreationRequest = SandboxRepoRequest & { ownerUserId: string; sandboxGeneration: number };

export class UserSandboxManager {
  private readonly leaseOwner: string;

  constructor(
    private readonly store: SqliteStateStore,
    private readonly runtime: Pick<UserSandboxDockerRuntime, 'describe'|'provision'|'observe'|'stopAndRemove'>
      & Partial<Pick<UserSandboxDockerRuntime, 'inspectLocalProject'|'inspectExistingProject'|'stageTaskAttachment'|'exportTaskArtifact'|'removeTaskAttachments'|'ensureProjectWorkspace'|'inspectProjectBranch'|'refreshCodexAuth'|'resolveRuntimeImage'|'configuredRuntimeImage'|'runtimeVersion'|'validateRuntimeImage'>>,
    options: { leaseOwner?: string; leaseDurationMs?: number; clock?: () => Date } = {},
  ) {
    this.leaseOwner = options.leaseOwner ?? `manager_${randomUUID()}`;
    this.leaseDurationMs = options.leaseDurationMs ?? 60_000;
    this.clock = options.clock ?? (() => new Date());
  }

  private readonly leaseDurationMs: number;
  private readonly clock: () => Date;

  async ensure(ownerId: string, options: { leaseWaitMs?: number } = {}): Promise<{ sandbox: UserSandboxRecord; runtime: DockerUserSandboxRuntime }> {
    let sandbox = this.store.getOrCreateUserSandbox(ownerId).sandbox;
    // During recovery, let the previous manager's lease expire without
    // bypassing fencing or taking ownership from a live manager.
    const deadline = this.clock().getTime() + (options.leaseWaitMs ?? 0);
    while (sandbox.leaseOwner && sandbox.leaseOwner !== this.leaseOwner
      && sandbox.leaseExpiresAt && Date.parse(sandbox.leaseExpiresAt) > this.clock().getTime()) {
      const remaining = deadline - this.clock().getTime();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
      sandbox = this.store.getUserSandboxByOwner(ownerId)!;
    }
    sandbox = this.requireLease(ownerId);
    sandbox = await this.pinRuntimeImage(sandbox);
    if (sandbox.status === 'stopped') {
      sandbox = this.store.advanceUserSandboxGeneration({
        ownerId,
        expectedGeneration: sandbox.generation,
        leaseOwner: this.leaseOwner,
        status: 'provisioning',
        now: this.clock().toISOString(),
      }) ?? this.staleLease(ownerId);
    }
    const described = this.runtime.describe(sandbox);
    if (sandbox.status === 'running') {
      const observed = await this.runtime.observe(described);
      if (observed === 'running') {
        const running = await this.runtime.provision(sandbox);
        if (sandbox.containerId && running.containerId !== sandbox.containerId) {
          throw new Error('User sandbox container identity changed without a generation change.');
        }
        return { sandbox: this.touchRunning(sandbox, running.containerId), runtime: running };
      }
      sandbox = this.store.advanceUserSandboxGeneration({
        ownerId,
        expectedGeneration: sandbox.generation,
        leaseOwner: this.leaseOwner,
        status: 'provisioning',
        now: this.clock().toISOString(),
      }) ?? this.staleLease(ownerId);
    }
    try {
      const provisioned = await this.runtime.provision(sandbox);
      return { sandbox: this.touchRunning(sandbox, provisioned.containerId), runtime: provisioned };
    } catch (error) {
      const now = this.clock().toISOString();
      this.store.updateUserSandboxFenced({
        ownerId,
        expectedGeneration: sandbox.generation,
        leaseOwner: this.leaseOwner,
        update: (current) => ({ ...current, status: 'failed', updatedAt: now }),
      });
      throw error;
    }
  }

  async stageTaskAttachment(
    ownerId: string, taskId: string, turnId: string, source: string, fileName: string, layout?: 'project',
  ): Promise<string> {
    const ensured = await this.ensure(ownerId);
    if (!this.runtime.stageTaskAttachment) throw new Error('User sandbox attachment staging is unavailable.');
    return this.runtime.stageTaskAttachment(ensured.runtime, taskId, turnId, source, fileName, layout);
  }

  async ensureProjectWorkspace(
    ownerId: string,
    input: { projectId: string; cloneUrl: string; baseRef: string },
  ): Promise<SupervisorProjectWorkspace> {
    const ensured = await this.ensure(ownerId);
    if (!this.runtime.ensureProjectWorkspace) throw new Error('User sandbox project initialization is unavailable.');
    const workspace=await this.runtime.ensureProjectWorkspace(ensured.runtime, input);
    return workspace.status==='ready' && this.runtime.inspectProjectBranch
      ? {...workspace,branchName:await this.runtime.inspectProjectBranch(ensured.runtime,workspace,input.cloneUrl)} : workspace;
  }

  async inspectExistingProject(ownerId:string, localPath:string, repositoryUrl:string) {
    const ensured = await this.ensure(ownerId);
    if (!this.runtime.inspectExistingProject) throw new Error('Existing project import is unavailable.');
    return this.runtime.inspectExistingProject(ensured.runtime,localPath,repositoryUrl);
  }

  async inspectLocalProject(ownerId:string, localPath:string, repositoryUrl:string) {
    const ensured=await this.ensure(ownerId);
    if(!this.runtime.inspectLocalProject)throw new Error('Existing project inspection is unavailable.');
    return this.runtime.inspectLocalProject(ensured.runtime,localPath,repositoryUrl);
  }

  async validateRepositoryCreation(input: RepositoryCreationRequest): Promise<SandboxRepoResult> {
    const supervisor = await this.repositoryCreationSupervisor(input);
    return supervisor.validateRepositoryCreation(input);
  }

  async createRepository(input: RepositoryCreationRequest): Promise<SandboxRepoResult> {
    const supervisor = await this.repositoryCreationSupervisor(input);
    return supervisor.createRepository(input);
  }

  async readRepositoryCreation(input: RepositoryCreationRequest): Promise<SandboxRepoResult> {
    const supervisor = await this.repositoryCreationSupervisor(input);
    return supervisor.readRepositoryCreation(input);
  }

  private async repositoryCreationSupervisor(input: RepositoryCreationRequest): Promise<SandboxSupervisorClient> {
    const ensured = await this.ensure(input.ownerUserId);
    if (ensured.sandbox.generation !== input.sandboxGeneration) throw new Error('Stale repository creation sandbox generation.');
    return new SandboxSupervisorClient(ensured.runtime.supervisorSocketPath, 300_000);
  }


  async exportTaskArtifact(ownerId: string, taskId: string, sourcePath: string, destination: string, layout?: 'project'): Promise<void> {
    const ensured = await this.ensure(ownerId);
    if (!this.runtime.exportTaskArtifact) throw new Error('User sandbox artifact export is unavailable.');
    await this.runtime.exportTaskArtifact(ensured.runtime, taskId, sourcePath, destination, layout);
  }

  async removeTaskAttachments(ownerId: string, taskId: string, turnId: string, layout?: 'project'): Promise<void> {
    const ensured = await this.ensure(ownerId);
    if (!this.runtime.removeTaskAttachments) throw new Error('User sandbox attachment cleanup is unavailable.');
    await this.runtime.removeTaskAttachments(ensured.runtime, taskId, turnId, layout);
  }

  async reclaim(ownerId: string): Promise<UserSandboxRecord | undefined> {
    const existing = this.store.getUserSandboxByOwner(ownerId);
    if (!existing || existing.status === 'stopped') return existing;
    const sandbox = await this.pinRuntimeImage(this.requireLease(ownerId));
    await this.runtime.stopAndRemove(sandbox);
    const now = this.clock().toISOString();
    return this.store.updateUserSandboxFenced({
      ownerId,
      expectedGeneration: sandbox.generation,
      leaseOwner: this.leaseOwner,
      update: (current) => ({
        ...current,
        status: 'stopped',
        containerId: undefined,
        stoppedAt: now,
        updatedAt: now,
      }),
    }) ?? this.staleLease(ownerId);
  }

  async refreshCodexAuth(ownerId: string): Promise<void> {
    const ensured = await this.ensure(ownerId);
    if (!this.runtime.refreshCodexAuth) throw new Error('User sandbox credential refresh is unavailable.');
    await this.runtime.refreshCodexAuth(ensured.runtime);
  }

  async runtimeStatus(ownerId: string): Promise<string> {
    if (!this.runtime.configuredRuntimeImage || !this.runtime.runtimeVersion) throw new Error('Sandbox runtime management is unavailable.');
    const sandbox = this.store.getUserSandboxByOwner(ownerId);
    const availableImage = await this.runtime.configuredRuntimeImage();
    const available = await this.runtime.runtimeVersion(availableImage);
    const currentImage = sandbox ? sandbox.runtimeImage ?? await this.runtime.resolveRuntimeImage?.(sandbox) : undefined;
    const current = currentImage ? await this.runtime.runtimeVersion(currentImage) : undefined;
    return `当前沙箱 Codex：${current ?? '尚未创建'}\n平台稳定版：${available}\n${currentImage === availableImage
      ? '已使用最新稳定运行环境。' : '发送 /runtime upgrade 升级自己的沙箱；工作区和会话会保留。'}`;
  }

  async upgradeRuntime(ownerId: string): Promise<string> {
    if (!this.runtime.configuredRuntimeImage || !this.runtime.validateRuntimeImage || !this.runtime.runtimeVersion) {
      throw new Error('Sandbox runtime management is unavailable.');
    }
    const existing = this.store.getUserSandboxByOwner(ownerId);
    if (!existing) return '尚未创建沙箱，请先创建一个任务。';
    const current = await this.pinRuntimeImage(this.requireLease(ownerId));
    const target = await this.runtime.configuredRuntimeImage();
    if (current.runtimeImage === target) return '你的沙箱已使用平台最新稳定运行环境。';
    // Validate the candidate before taking down the existing user environment.
    await this.runtime.validateRuntimeImage(target);
    const targetVersion = await this.runtime.runtimeVersion(target);
    this.store.updateUserSandboxFenced({ ownerId, expectedGeneration: current.generation, leaseOwner: this.leaseOwner,
      update: (record) => ({ ...record, runtimeImage: target, updatedAt: this.clock().toISOString() }),
    }) ?? this.staleLease(ownerId);
    try {
      await this.recycle(ownerId);
    } catch (error) {
      const failed = this.requireLease(ownerId);
      this.store.updateUserSandboxFenced({ ownerId, expectedGeneration: failed.generation, leaseOwner: this.leaseOwner,
        update: (record) => ({ ...record, runtimeImage: current.runtimeImage, updatedAt: this.clock().toISOString() }),
      }) ?? this.staleLease(ownerId);
      try { await this.recycle(ownerId); } catch (rollback) {
        throw new Error(`沙箱升级失败，恢复旧环境也失败：${String(rollback)}`);
      }
      throw new Error(`沙箱升级失败，已恢复旧环境：${String(error)}`);
    }
    return `沙箱已升级到平台稳定版 Codex ${targetVersion}。工作区和会话已保留，继续发送消息即可恢复任务。`;
  }

  private async pinRuntimeImage(sandbox: UserSandboxRecord): Promise<UserSandboxRecord> {
    if (sandbox.runtimeImage || !this.runtime.resolveRuntimeImage) return sandbox;
    const runtimeImage = await this.runtime.resolveRuntimeImage(sandbox);
    return this.store.updateUserSandboxFenced({ ownerId: sandbox.ownerId, expectedGeneration: sandbox.generation,
      leaseOwner: this.leaseOwner, update: (record) => ({ ...record, runtimeImage, updatedAt: this.clock().toISOString() }),
    }) ?? this.staleLease(sandbox.ownerId);
  }

  async recycle(ownerId: string): Promise<{ sandbox: UserSandboxRecord; runtime: DockerUserSandboxRuntime }> {
    const current = this.store.getUserSandboxByOwner(ownerId);
    if (!current) return this.ensure(ownerId);
    const sandbox = await this.pinRuntimeImage(this.requireLease(ownerId));
    await this.runtime.stopAndRemove(sandbox);
    const next = this.store.advanceUserSandboxGeneration({
      ownerId,
      expectedGeneration: sandbox.generation,
      leaseOwner: this.leaseOwner,
      status: 'provisioning',
      now: this.clock().toISOString(),
    }) ?? this.staleLease(ownerId);
    try {
      const provisioned = await this.runtime.provision(next);
      return { sandbox: this.touchRunning(next, provisioned.containerId), runtime: provisioned };
    } catch (error) {
      const now = this.clock().toISOString();
      this.store.updateUserSandboxFenced({
        ownerId,
        expectedGeneration: next.generation,
        leaseOwner: this.leaseOwner,
        update: (value) => ({ ...value, status: 'failed', updatedAt: now }),
      });
      throw error;
    }
  }

  private requireLease(ownerId: string): UserSandboxRecord {
    const now = this.clock();
    const leased = this.store.claimUserSandboxLease({
      ownerId,
      leaseOwner: this.leaseOwner,
      leaseExpiresAt: new Date(now.getTime() + this.leaseDurationMs).toISOString(),
      now: now.toISOString(),
    });
    if (!leased) throw new Error(`User sandbox lease is held by another manager: ${ownerId}`);
    return leased;
  }

  private touchRunning(sandbox: UserSandboxRecord, containerId: string | undefined): UserSandboxRecord {
    if (!containerId) throw new Error('Provisioned user sandbox is missing its immutable container id.');
    const now = this.clock().toISOString();
    return this.store.updateUserSandboxFenced({
      ownerId: sandbox.ownerId,
      expectedGeneration: sandbox.generation,
      leaseOwner: this.leaseOwner,
      update: (current) => ({
        ...current,
        status: 'running',
        containerId,
        stoppedAt: undefined,
        lastActiveAt: now,
        updatedAt: now,
      }),
    }) ?? this.staleLease(sandbox.ownerId);
  }

  private staleLease(ownerId: string): never {
    throw new Error(`Lost user sandbox lease or generation fence: ${ownerId}`);
  }
}
