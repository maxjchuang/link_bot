import type { BotConfig } from '../domain/types.js';
import type { TaskActorContext } from '../feishu/FeishuTaskController.js';
import type { DockerTaskProvisioner } from '../runtime/DockerTaskProvisioner.js';
import type { TaskPublishBroker } from '../tasks/TaskPlatformService.js';
import { projectTask, type TaskRecord, type TaskRepositoryRecord } from '../tasks/TaskTypes.js';
import { ExecGitCommandRunner, GitPublishService, type GitCommandRunner } from './GitPublishService.js';
import { GitIdentityResolver } from './GitIdentityResolver.js';

export class DockerTaskPublishBroker implements TaskPublishBroker {
  private readonly repositoryOperations = new Map<string, Promise<unknown>>();
  constructor(
    private readonly config: BotConfig,
    private readonly provisioner: Pick<DockerTaskProvisioner, 'exportWorkspace' | 'exportRepository'>
      & Partial<Pick<DockerTaskProvisioner, 'removeExportedPath'>>,
    private readonly publisher: GitPublishService,
    private readonly git: GitCommandRunner = new ExecGitCommandRunner(),
    private readonly gitIdentities = new GitIdentityResolver(config.gitIdentities),
  ) {}

  async request(task: TaskRecord, actor: TaskActorContext, repository?: TaskRepositoryRecord): Promise<{ requestId: string }> {
    const selected = projectTask(task);
    if (repository && repository.taskId !== task.id) throw new Error('Repository does not belong to task.');
    const projectId = repository?.projectId ?? selected.projectId;
    const project = this.config.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const repositoryPath = repository
      ? await this.provisioner.exportRepository(task, repository)
      : await this.provisioner.exportWorkspace(task);
    try {
    const upstreamRemote = (await this.git.run(project.path, ['remote', 'get-url', 'origin'])).trim();
    if (!upstreamRemote) throw new Error(`Project ${project.id} has no origin remote.`);
    if (/^https?:\/\/[^/@\s]+@/i.test(upstreamRemote)) {
      throw new Error('Project origin must not contain embedded credentials.');
    }
    await this.git.run(repositoryPath, ['remote', 'set-url', 'origin', upstreamRemote]);
    await fetchRemoteBranch(this.git, repositoryPath, selected.baseRef);
    const identity = this.gitIdentities.resolve(actor.userId);
    await configureIdentity(this.git, repositoryPath, identity);
    const dirty = await this.git.run(repositoryPath, ['status', '--porcelain=v1']);
    if (dirty) {
      await this.git.run(repositoryPath, ['add', '--all']);
      await this.git.run(repositoryPath, ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', `link_bot task ${task.id}`]);
    }
      const request = await this.publisher.request({
        taskId: task.id, ownerUserId: actor.userId, repositoryPath, remote: 'origin', baseRef: selected.baseRef,
        ...(repository ? { repositoryId: repository.id, baseRef: repository.baseRef, branchName: repository.branchName } : {}),
        authorName: identity.name, authorEmail: identity.email,
      });
      return { requestId: request.id };
    } catch (error) {
      await this.removeExport(repositoryPath);
      throw error;
    }
  }

  async requestExistingBranch(task: TaskRecord, actor: TaskActorContext, repository: TaskRepositoryRecord, targetBranch: string, expectedHeadSha: string): Promise<{ requestId: string; expiresAt: string; forceUpdate?: boolean; previousHeadSha?: string; newHeadSha?: string; branchName?: string }> {
    return this.exclusive(repository, () => this.requestExistingBranchExclusive(task, actor, repository, targetBranch, expectedHeadSha));
  }

  private async requestExistingBranchExclusive(task: TaskRecord, actor: TaskActorContext, repository: TaskRepositoryRecord, targetBranch: string, expectedHeadSha: string): Promise<{ requestId: string; expiresAt: string; forceUpdate?: boolean; previousHeadSha?: string; newHeadSha?: string; branchName?: string }> {
    if (repository.taskId !== task.id) throw new Error('Repository does not belong to task.');
    if (!targetBranch || targetBranch.startsWith('-') || /[\s~^:?*[\\]/.test(targetBranch)) throw new Error('Unsafe target branch.');
    const project = this.config.projects.find((candidate) => candidate.id === repository.projectId);
    if (!project) throw new Error(`Project not found: ${repository.projectId}`);
    if (targetBranch === project.baseRef || /^(?:main|master|develop|release(?:[/-]|$))/i.test(targetBranch)) throw new Error(`Refusing to update protected branch: ${targetBranch}`);
    const repositoryPath = await this.provisioner.exportRepository(task, repository);
    try {
    const dirty = await this.git.run(repositoryPath, ['status', '--porcelain=v1']);
    if (dirty) throw new Error(`Repository must be clean before Manager publish: ${dirty.split('\n').slice(0, 5).join(', ')}`);
    await this.git.run(repositoryPath, ['checkout', '-B', targetBranch, 'HEAD']);
    const upstreamRemote = (await this.git.run(project.path, ['remote', 'get-url', 'origin'])).trim();
    if (!upstreamRemote) throw new Error(`Project ${project.id} has no origin remote.`);
    if (/^https?:\/\/[^/@\s]+@/i.test(upstreamRemote)) throw new Error('Project origin must not contain embedded credentials.');
    await this.git.run(repositoryPath, ['remote', 'set-url', 'origin', upstreamRemote]);
    await fetchRemoteBranch(this.git, repositoryPath, targetBranch);
    const identity = this.gitIdentities.resolve(actor.userId);
    await configureIdentity(this.git, repositoryPath, identity);
      const request = await this.publisher.requestExistingBranch({
        taskId: task.id, ownerUserId: actor.userId, repositoryPath, remote: 'origin', repositoryId: repository.id,
        branchName: targetBranch, expectedHeadSha, authorName: identity.name, authorEmail: identity.email,
      });
      return { requestId: request.id, expiresAt: request.expiresAt, forceUpdate: request.forceUpdate, previousHeadSha: request.baseSha,
        newHeadSha: request.headSha, branchName: request.branchName };
    } catch (error) {
      await this.removeExport(repositoryPath);
      throw error;
    }
  }

  async requestMergeRequest(task: TaskRecord, actor: TaskActorContext, repository: TaskRepositoryRecord, targetBranch: string, baseRef: string, expectedHeadSha: string): Promise<{ requestId: string; expiresAt: string }> {
    return this.exclusive(repository, () => this.requestMergeRequestExclusive(task, actor, repository, targetBranch, baseRef, expectedHeadSha));
  }

  private async requestMergeRequestExclusive(task: TaskRecord, actor: TaskActorContext, repository: TaskRepositoryRecord, targetBranch: string, baseRef: string, expectedHeadSha: string): Promise<{ requestId: string; expiresAt: string }> {
    if (repository.taskId !== task.id) throw new Error('Repository does not belong to task.');
    assertSafeBranch(targetBranch, 'target branch');
    assertSafeBranch(baseRef, 'base ref');
    const project = this.config.projects.find((candidate) => candidate.id === repository.projectId);
    if (!project) throw new Error(`Project not found: ${repository.projectId}`);
    if (/^(?:main|master|develop|release(?:[/-]|$))$/i.test(targetBranch)) throw new Error(`Refusing to publish a protected target branch: ${targetBranch}`);
    const repositoryPath = await this.provisioner.exportRepository(task, repository);
    try {
    const dirty = await this.git.run(repositoryPath, ['status', '--porcelain=v1']);
    if (dirty) throw new Error(`Repository must be clean before Manager publish: ${dirty.split('\n').slice(0, 5).join(', ')}`);
    await this.git.run(repositoryPath, ['checkout', '-B', targetBranch, 'HEAD']);
    const upstreamRemote = (await this.git.run(project.path, ['remote', 'get-url', 'origin'])).trim();
    if (!upstreamRemote) throw new Error(`Project ${project.id} has no origin remote.`);
    if (/^https?:\/\/[^/@\s]+@/i.test(upstreamRemote)) throw new Error('Project origin must not contain embedded credentials.');
    await this.git.run(repositoryPath, ['remote', 'set-url', 'origin', upstreamRemote]);
    await fetchRemoteBranch(this.git, repositoryPath, baseRef);
    const identity = this.gitIdentities.resolve(actor.userId);
    await configureIdentity(this.git, repositoryPath, identity);
      const request = await this.publisher.request({
        taskId: task.id, ownerUserId: actor.userId, repositoryPath, remote: 'origin', repositoryId: repository.id,
        baseRef, baseRevision: `origin/${baseRef}`, branchName: targetBranch, expectedHeadSha,
        authorName: identity.name, authorEmail: identity.email,
      });
      return { requestId: request.id, expiresAt: request.expiresAt };
    } catch (error) {
      await this.removeExport(repositoryPath);
      throw error;
    }
  }

  async decide(requestId: string, userId: string, decision: 'confirm' | 'reject'): Promise<string> {
    const result = await this.publisher.decide(requestId, userId, decision);
    if (['published', 'rejected', 'expired', 'failed'].includes(result.status)) {
      await this.removeExport(result.repositoryPath);
    }
    if (result.status === 'published') return `Published ${result.branchName}${result.forceUpdate ? ' with the approved force update' : ''}; pull request ${result.mergeRequestId}.`;
    if (result.status === 'rejected') return 'Publish rejected.';
    if (result.status === 'expired') return 'Publish request expired.';
    if (result.status === 'unknown') return 'Publish outcome is unknown and requires reconciliation.';
    if (result.status === 'failed') throw new Error(result.failure ?? 'Publish failed.');
    return `Publish request is ${result.status}.`;
  }

  private async removeExport(repositoryPath: string): Promise<void> {
    await this.provisioner.removeExportedPath?.(repositoryPath).catch(() => undefined);
  }

  private async exclusive<T>(repository: TaskRepositoryRecord, operation: () => Promise<T>): Promise<T> {
    if (this.repositoryOperations.has(repository.id)) {
      throw new Error(`MANAGER_OPERATION_BUSY: A publish operation is already running for ${repository.projectId}. Wait for its result before retrying.`);
    }
    const running = operation();
    this.repositoryOperations.set(repository.id, running);
    try {
      return await running;
    } finally {
      if (this.repositoryOperations.get(repository.id) === running) this.repositoryOperations.delete(repository.id);
    }
  }
}

function assertSafeBranch(value: string, label: string): void {
  if (!value || value.startsWith('-') || /[\s~^:?*[\\]/.test(value) || value.includes('..') || value.endsWith('.')) {
    throw new Error(`Unsafe ${label}.`);
  }
}

async function fetchRemoteBranch(git: GitCommandRunner, repositoryPath: string, branch: string): Promise<void> {
  assertSafeBranch(branch, 'fetch branch');
  await git.run(repositoryPath, [
    'fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ]);
}

async function configureIdentity(git: GitCommandRunner, repositoryPath: string, identity: { name: string; email: string }): Promise<void> {
  await git.run(repositoryPath, ['config', '--local', 'user.name', identity.name]);
  await git.run(repositoryPath, ['config', '--local', 'user.email', identity.email]);
}
