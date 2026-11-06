import { execFile } from 'node:child_process';
import { mkdir,mkdtemp,readdir,rm,stat,writeFile } from 'node:fs/promises';
import { basename,dirname,isAbsolute,join,relative as relativePath,resolve } from 'node:path';
import type { ProjectConfig } from '../domain/types.js';
import { GitIdentityResolver } from '../git/GitIdentityResolver.js';
import { controlledBranch } from '../git/GitPublishService.js';
import type { ProvisionedTaskRuntime,ReviewDiffManifest,TaskRuntimeProvisioner } from '../tasks/TaskPlatformService.js';
import { projectTask,type RepositoryMigrationRecord,type TaskRecord,type TaskRepositoryRecord,type TaskRuntimeState } from '../tasks/TaskTypes.js';
import type { PersistentDiskAdmission } from './DiskLifecycleController.js';
import type { DockerReadySlotRuntime } from './DockerReadySlotRuntime.js';
import { DockerRuntime,type DockerTaskRuntime } from './DockerRuntime.js';
import type { ReadyPoolController } from './ReadyPoolController.js';
import { TaskCredentialManager } from './TaskCredentialManager.js';

export interface ManagerGitRunner {
  run(cwd: string, args: string[]): Promise<string>;
  /** Preserve stdout byte-for-byte for Git payloads such as binary patches. */
  runRaw?(cwd: string, args: string[]): Promise<Buffer>;
}

export const MANAGER_ONLY_GIT_REMOTE = 'link-bot-manager-only://origin';

export async function fetchAndResolveRemoteBase(
  git: ManagerGitRunner, project: ProjectConfig, baseRef: string,
): Promise<string> {
  if (!/^[A-Za-z0-9._/-]{1,300}$/.test(baseRef) || baseRef.startsWith('-') || baseRef.includes('..')) {
    throw new Error('Unsafe repository base ref.');
  }
  await git.run(project.path, ['fetch', '--prune', 'origin']);
  if (/^[a-fA-F0-9]{40}$/.test(baseRef)) {
    const commit = (await git.run(project.path, ['rev-parse', `${baseRef}^{commit}`])).trim();
    if (commit.toLowerCase() !== baseRef.toLowerCase()) {
      throw new Error(`Project ${project.id} did not resolve immutable commit ${baseRef}.`);
    }
    return commit;
  }
  let commit: string;
  try {
    commit = (await git.run(project.path, ['rev-parse', `origin/${baseRef}^{commit}`])).trim();
  } catch {
    await git.run(project.path, [
      'fetch', '--no-tags', 'origin',
      `+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`,
    ]);
    commit = (await git.run(project.path, ['rev-parse', `origin/${baseRef}^{commit}`])).trim();
  }
  if (!commit) throw new Error(`Project ${project.id} did not resolve origin/${baseRef}.`);
  return commit;
}

export function nativeTaskRemote(upstreamRemote: string, enabled: boolean): string {
  if (!enabled) return MANAGER_ONLY_GIT_REMOTE;
  if (/^git@github\.com:[A-Za-z0-9._/-]+$/.test(upstreamRemote)
    || /^https:\/\/github\.com\/[A-Za-z0-9._/-]+$/.test(upstreamRemote)) return upstreamRemote;
  return MANAGER_ONLY_GIT_REMOTE;
}

export class DockerTaskProvisioner implements TaskRuntimeProvisioner {
  constructor(private readonly docker: DockerRuntime,
    private readonly credentials: TaskCredentialManager,
    private readonly stagingRoot: string,
    private readonly git: ManagerGitRunner = new ExecManagerGitRunner(),
    _waitForSocket: (path: string) => Promise<void> = defaultWaitForSocket,
    private readonly readyPool?: ReadyPoolController,
    private readonly readyRuntime?: DockerReadySlotRuntime,
    private readonly diskAdmission?: PersistentDiskAdmission,
    private readonly gitIdentities = new GitIdentityResolver(),
    private readonly nativeGitExecution = false,
    private readonly projects: ProjectConfig[] = []
  ) {}

  async provision(input: {
    taskId: string; ownerUserId: string; project?: ProjectConfig; genericWorkspace?: boolean;
    workspaceFiles?: { agents: string; projects: string };
  }): Promise<ProvisionedTaskRuntime> {
    if (!input.project) throw new Error('Project task required');
    await this.diskAdmission?.assertAllocationAllowed('task_provision');
    const branchName = controlledBranch(input.ownerUserId, input.taskId);
    await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(this.stagingRoot, 'provision-'));
    let runtime: DockerTaskRuntime | undefined;
    try {
      const workspace = join(staging, 'workspace');
      const auth = join(staging, 'auth');
      const toolHome = join(staging, 'tool-home');
      if (input.genericWorkspace) {
        await mkdir(join(workspace, '.linkbot'), { recursive: true, mode: 0o700 });
        await mkdir(join(workspace, 'projects'), { recursive: true, mode: 0o700 });
        await writeFile(join(workspace, 'AGENTS.md'), input.workspaceFiles?.agents ?? '# Multi-project workspace\n', { mode: 0o600 });
        await writeFile(join(workspace, '.linkbot', 'projects.md'), input.workspaceFiles?.projects ?? '# Authorized projects\n', { mode: 0o600 });
        const stagedAuth = await this.credentials.stageMinimumAuth(auth);
        const hasToolHome = await this.credentials.stageUserToolHome(input.ownerUserId, toolHome);
        runtime = await this.docker.provision(input.taskId, input.ownerUserId);
        await this.docker.copyFileToStoppedTask(runtime, `${workspace}/.`, '/workspace');
        await this.docker.prepareWorkspaceOwnership(runtime);
        for (const fileName of stagedAuth) await this.docker.copyAuthToStoppedTask(runtime, join(auth, fileName), fileName);
        if (hasToolHome) {
          await this.docker.copyFileToStoppedTask(runtime, `${toolHome}/.`, '/home/codex/.codex/tool-home');
          await this.docker.prepareCodexHomeOwnership(runtime);
        }
        await this.docker.start(runtime);
        return { cwd: '/workspace', branchName, codexHome: '/home/codex/.codex', runtimeId: input.taskId, startupType: 'cold' };
      }
      const upstreamRemote = (await this.git.run(input.project.path, ['remote', 'get-url', 'origin'])).trim();
      if (!upstreamRemote) throw new Error(`Project ${input.project.id} has no origin remote.`);
      assertCredentialFreeRemote(upstreamRemote);
      const versionKey = this.readyRuntime ? await this.readyRuntime.registerProject(input.project) : undefined;
      const readySlot = versionKey ? this.readyPool?.claim(versionKey, input.taskId) : undefined;
      if (readySlot) {
        try {
          const runtimeId = typeof readySlot.metadata?.runtimeId === 'string' ? readySlot.metadata.runtimeId : readySlot.id;
          runtime = this.docker.describe(runtimeId);
          const observed = await this.docker.observe(runtime);
          if (observed === 'missing') throw new Error(`Claimed READY runtime is missing: ${runtimeId}`);
          const stagedAuth = await this.credentials.stageMinimumAuth(auth);
          const hasToolHome = await this.credentials.stageUserToolHome(input.ownerUserId, toolHome);
          await this.docker.runWorkspaceGit(runtime, ['checkout', '-b', branchName]);
          await this.configureDockerGit(runtime, input.ownerUserId);
          if (this.nativeGitExecution) await this.configureDockerNativeGit(runtime, '/workspace', input.project);
          for (const fileName of stagedAuth) {
            await this.docker.copyAuthToStoppedTask(runtime, join(auth, fileName), fileName);
          }
          if (hasToolHome) {
            await this.docker.copyFileToStoppedTask(runtime, `${toolHome}/.`, '/home/codex/.codex/tool-home');
            await this.docker.prepareCodexHomeOwnership(runtime);
          }
          await this.docker.start(runtime);
          return { cwd: '/workspace', branchName, codexHome: '/home/codex/.codex', runtimeId, startupType: 'ready' };
        } catch {
          if (runtime) await this.docker.removeTask(runtime).catch(() => undefined);
          runtime = undefined;
        }
      }
      const baseRef = input.project.baseRef ?? 'main';
      const baseCommit = await fetchAndResolveRemoteBase(this.git, input.project, baseRef);
      if (!baseCommit) throw new Error(`Project ${input.project.id} did not resolve a fetched base commit.`);
      await this.git.run(staging, [
        'clone', '--local', '--no-hardlinks', '--no-checkout', '--', input.project.path, workspace,
      ]);
      await this.git.run(workspace, ['fetch', '--no-tags', input.project.path, baseCommit]);
      await this.git.run(workspace, ['checkout', '--detach', baseCommit]);
      await this.git.run(workspace, ['branch', '--force', baseRef, baseCommit]);
      await this.git.run(workspace, ['checkout', '-b', branchName]);
      await this.git.run(workspace, ['remote', 'set-url', 'origin', nativeTaskRemote(upstreamRemote, this.nativeGitExecution)]);
      await this.configureGit(workspace, input.ownerUserId);
      if (this.nativeGitExecution) await this.configureNativeGit(workspace);
      const stagedAuth = await this.credentials.stageMinimumAuth(auth);
      const hasToolHome = await this.credentials.stageUserToolHome(input.ownerUserId, toolHome);
      runtime = await this.docker.provision(input.taskId, input.ownerUserId);
      await this.docker.copyFileToStoppedTask(runtime, `${workspace}/.`, '/workspace');
      await this.docker.prepareWorkspaceOwnership(runtime);
      for (const fileName of stagedAuth) {
        await this.docker.copyAuthToStoppedTask(runtime, join(auth, fileName), fileName);
      }
      if (hasToolHome) {
        await this.docker.copyFileToStoppedTask(runtime, `${toolHome}/.`, '/home/codex/.codex/tool-home');
        await this.docker.prepareCodexHomeOwnership(runtime);
      }
      await this.docker.start(runtime);
      if (versionKey) void this.readyPool?.replenish(versionKey).catch(() => undefined);
      return { cwd: '/workspace', branchName, codexHome: '/home/codex/.codex', runtimeId: input.taskId, startupType: 'cold' };
    } catch (error) {
      if (runtime) await this.docker.removeTask(runtime).catch(() => undefined);
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async resume(task: TaskRecord, project?: ProjectConfig, repositories?: TaskRepositoryRecord[]): Promise<ProvisionedTaskRuntime> {
    if (!project) throw new Error('Project task required');
    let runtime = this.docker.describe(task.runtimeId ?? task.id);
    if (await this.docker.observe(runtime) === 'missing') {
      await this.diskAdmission?.assertAllocationAllowed('task_runtime_recreate');
      runtime = await this.docker.recreateMissingContainer(task.runtimeId ?? task.id, task.ownerUserId);
    } else if (this.nativeGitExecution) {
      runtime = await this.docker.ensureCurrentImage(task.runtimeId ?? task.id, task.ownerUserId);
    }
    const staging = await mkdtemp(join(this.stagingRoot, 'resume-auth-'));
    try {
      const auth = join(staging, 'auth');
      const stagedAuth = await this.credentials.stageMinimumAuth(auth);
      await this.docker.stop(runtime);
      for (const fileName of stagedAuth) {
        await this.docker.copyAuthToStoppedTask(runtime, join(auth, fileName), fileName);
      }
      const toolHome = join(staging, 'tool-home');
      if (await this.credentials.stageUserToolHome(task.ownerUserId, toolHome)) {
        await this.docker.copyFileToStoppedTask(runtime, `${toolHome}/.`, '/home/codex/.codex/tool-home');
        await this.docker.prepareCodexHomeOwnership(runtime);
      }
    } finally { await rm(staging, { recursive: true, force: true }); }
    await this.docker.start(runtime);
    if (repositories === undefined) await this.configureDockerGit(runtime, task.ownerUserId);
    else await this.refreshGitIdentity(task, repositories);
    if (this.nativeGitExecution) {
      if (repositories === undefined) await this.configureDockerNativeGit(runtime, '/workspace', project);
      else for (const repository of repositories.filter((candidate) => candidate.status !== 'failed')) {
        const repositoryProject = this.projects.find((candidate) => candidate.id === repository.projectId);
        if (repositoryProject) await this.configureDockerNativeGit(runtime, repository.checkoutPath, repositoryProject);
      }
    }
    return { cwd: '/workspace', branchName: projectTask(task).branchName, codexHome: '/home/codex/.codex', runtimeId: task.runtimeId ?? task.id, startupType: 'warm' };
  }

  async stop(task: TaskRecord): Promise<void> {
    await this.docker.stop(this.docker.describe(task.runtimeId ?? task.id));
  }

  async refreshCodexAuth(task: TaskRecord): Promise<void> {
    await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(this.stagingRoot, 'refresh-codex-auth-'));
    const runtime = this.docker.describe(task.runtimeId ?? task.id);
    try {
      const auth = join(staging, 'auth');
      const stagedAuth = await this.credentials.stageMinimumAuth(auth);
      await this.docker.stop(runtime);
      for (const fileName of stagedAuth) {
        await this.docker.copyAuthToStoppedTask(runtime, join(auth, fileName), fileName);
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async refreshGitIdentity(task: TaskRecord, repositories?: TaskRepositoryRecord[]): Promise<void> {
    const runtime = this.docker.describe(task.runtimeId ?? task.id);
    if (repositories === undefined) {
      await this.configureDockerGit(runtime, task.ownerUserId);
      return;
    }
    const identity = this.gitIdentities.resolve(task.ownerUserId);
    for (const repository of repositories.filter((candidate) => candidate.status !== 'failed')) {
      await this.docker.runRepositoryGit(runtime, repository.checkoutPath, ['config', 'user.name', identity.name]);
      await this.docker.runRepositoryGit(runtime, repository.checkoutPath, ['config', 'user.email', identity.email]);
      await this.docker.runRepositoryGit(runtime, repository.checkoutPath, ['config', 'user.useConfigOnly', 'true']);
    }
  }

  async refreshWorkspaceFiles(task: TaskRecord, files: { agents: string; projects: string }): Promise<void> {
    const runtime = this.docker.describe(task.runtimeId ?? task.id);
    const staging = await mkdtemp(join(this.stagingRoot, 'workspace-policy-'));
    try {
      const agents = join(staging, 'AGENTS.md');
      const projects = join(staging, 'projects.md');
      await writeFile(agents, files.agents, { mode: 0o600 });
      await writeFile(projects, files.projects, { mode: 0o600 });
      await this.docker.copyWorkspaceControlFile(runtime, agents, '/workspace/AGENTS.md');
      await this.docker.copyWorkspaceControlFile(runtime, projects, '/workspace/.linkbot/projects.md');
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async delete(task: TaskRecord): Promise<void> {
    const runtime = this.docker.describe(task.runtimeId ?? task.id);
    if (this.nativeGitExecution) await this.docker.revokeNativeGitCredential(runtime).catch(() => undefined);
    await this.docker.removeTask(runtime);
  }

  async exportWorkspace(task: TaskRecord): Promise<string> {
    const exportRoot = join(this.stagingRoot, 'exports');
    const destination = join(exportRoot, safeTaskId(task.id));
    await mkdir(exportRoot, { recursive: true, mode: 0o700 });
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true, mode: 0o700 });
    await this.docker.copyPathFromTask(this.docker.describe(task.runtimeId ?? task.id), '/workspace/.', destination);
    return destination;
  }

  async removeExportedPath(exportedPath: string): Promise<void> {
    const exportRoot = resolve(this.stagingRoot, 'exports');
    const target = resolve(exportedPath);
    const relative = relativePath(exportRoot, target);
    if (!relative || relative.startsWith('..') || isAbsolute(relative)) {
      throw new Error('Refusing to remove a path outside the task export root.');
    }
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    const taskExportRoot = dirname(target);
    if (dirname(taskExportRoot) === exportRoot) {
      const remaining = await readdir(taskExportRoot).catch(() => []);
      if (remaining.length === 0) await rm(taskExportRoot, { recursive: true, force: true });
    }
  }

  async addRepository(task: TaskRecord, project: ProjectConfig, repository: TaskRepositoryRecord): Promise<{ baseCommit: string }> {
    if (!/^\/workspace\/(?:repositories|projects)\/[A-Za-z0-9._-]+$/.test(repository.checkoutPath)) {
      throw new Error('Unsafe task repository checkout path.');
    }
    await this.diskAdmission?.assertAllocationAllowed('repository_materialize');
    await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(this.stagingRoot, 'repository-'));
    let operationError: unknown;
    try {
      const checkout = join(staging, 'checkout');
      const upstreamRemote = (await this.git.run(project.path, ['remote', 'get-url', 'origin'])).trim();
      if (!upstreamRemote) throw new Error(`Project ${project.id} has no origin remote.`);
      assertCredentialFreeRemote(upstreamRemote);
      const baseCommit = await fetchAndResolveRemoteBase(this.git, project, repository.baseRef);
      if (!baseCommit) throw new Error(`Project ${project.id} did not resolve a fetched base commit.`);
      await this.git.run(staging, [
        'clone', '--local', '--no-hardlinks', '--no-checkout', '--', project.path, checkout,
      ]);
      await this.git.run(checkout, ['fetch', '--no-tags', project.path, baseCommit]);
      await this.git.run(checkout, ['checkout', '--detach', baseCommit]);
      await this.git.run(checkout, ['branch', '--force', repository.baseRef, baseCommit]);
      await this.git.run(checkout, ['checkout', '-b', repository.branchName]);
      await this.git.run(checkout, ['remote', 'set-url', 'origin', nativeTaskRemote(upstreamRemote, this.nativeGitExecution)]);
      await this.configureGit(checkout, repository.addedBy);
      if (this.nativeGitExecution) await this.configureNativeGit(checkout);
      await this.docker.copyRepositoryToTask(
        this.docker.describe(task.runtimeId ?? task.id), checkout, repository.checkoutPath,
      );
      return { baseCommit };
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      await cleanupRepositoryStaging(staging, operationError);
    }
  }

  async migrateRepository(
    task: TaskRecord, project: ProjectConfig, repository: TaskRepositoryRecord, targetBaseRef: string, migrationId: string,
  ): Promise<
    | { status: 'completed'; baseCommit: string; commitMappings?: Array<{ sourceSha: string; targetSha: string }> }
    | { status: 'conflict'; baseCommit: string; conflictPath: string; commitMappings?: Array<{ sourceSha: string; targetSha: string }> }
  > {
    if (!/^[A-Za-z0-9._/-]{1,300}$/.test(targetBaseRef) || targetBaseRef.startsWith('-')) throw new Error('Unsafe target base ref.');
    const staging = await mkdtemp(join(this.stagingRoot, 'repository-migration-'));
    try {
      const current = join(staging, 'current');
      const target = join(staging, 'target');
      await mkdir(current, { recursive: true, mode: 0o700 });
      await this.docker.copyGitRepositorySnapshotFromTask(
        this.docker.describe(task.runtimeId ?? task.id), repository.checkoutPath, current,
      );
      const exportedHead = (await this.git.run(current, ['config', '--get', 'linkbot.export.originalHead'])).trim();
      if (!exportedHead) throw new Error('Repository migration snapshot did not record its original HEAD.');
      // The lightweight export represents Git-visible dirty files in a
      // temporary commit. Restore the original HEAD before staging so the
      // migration preserves those files as uncommitted changes.
      await this.git.run(current, ['reset', '--mixed', exportedHead]);
      await this.git.run(current, ['add', '-A']);
      const sourceHead = (await this.git.run(current, ['rev-parse', 'HEAD^{commit}'])).trim();
      const commits = repository.baseCommit
        ? (await this.git.run(current, ['rev-list', '--reverse', `${repository.baseCommit}..${sourceHead}`])).split('\n').filter(Boolean)
        : [];
      const patch = this.git.runRaw
        ? await this.git.runRaw(current, [
          'diff', '--cached', '--binary', '--full-index', sourceHead, '--',
        ])
        : Buffer.from(await this.git.run(current, [
        'diff', '--cached', '--binary', '--full-index', sourceHead, '--',
        ]));
      const upstreamRemote = (await this.git.run(project.path, ['remote', 'get-url', 'origin'])).trim();
      assertCredentialFreeRemote(upstreamRemote);
      const baseCommit = await fetchAndResolveRemoteBase(this.git, project, targetBaseRef);
      await this.git.run(staging, ['clone', '--local', '--no-hardlinks', '--no-checkout', '--', project.path, target]);
      await this.git.run(target, ['fetch', '--no-tags', project.path, baseCommit]);
      await this.git.run(target, ['checkout', '--detach', baseCommit]);
      await this.git.run(target, ['checkout', '-b', repository.branchName]);
      await this.git.run(target, ['remote', 'set-url', 'origin', nativeTaskRemote(upstreamRemote, this.nativeGitExecution)]);
      await this.configureGit(target, repository.addedBy);
      if (this.nativeGitExecution) await this.configureNativeGit(target);
      const commitMappings: Array<{ sourceSha: string; targetSha: string }> = [];
      if (commits.length > 0) {
        // Fetch an advertised ref rather than requesting task commits by raw
        // SHA. upload-pack commonly rejects direct wants for unadvertised
        // objects even when those commits are reachable from the source HEAD.
        await this.git.run(target, [
          'fetch', '--no-tags', current, 'HEAD:refs/link-bot/migration-source',
        ]);
        const commitsToReplay = commits.length > 0
          ? (await this.git.run(target, ['cherry', baseCommit, 'refs/link-bot/migration-source']))
            .split('\n').map((line) => line.trim()).filter((line) => line.startsWith('+ ')).map((line) => line.slice(2).trim())
          : [];
        for (const commit of commitsToReplay) {
          try {
            await this.git.run(target, ['cherry-pick', commit]);
            commitMappings.push({ sourceSha: commit, targetSha: (await this.git.run(target, ['rev-parse', 'HEAD^{commit}'])).trim() });
          } catch (error) {
            const status = await this.git.run(target, ['status', '--porcelain=v1']).catch(() => '');
            if (!isContentConflict(error, status)) throw error;
            const conflictPath = `${repository.checkoutPath}.migration-${safeTaskId(migrationId).slice(-20)}`;
            await this.docker.copyRepositoryToTask(this.docker.describe(task.runtimeId ?? task.id), target, conflictPath);
            return { status: 'conflict', baseCommit, conflictPath, commitMappings };
          }
        }
      }
      if (patch.length > 0) {
        const patchPath = join(staging, 'changes.patch');
        await writeFile(patchPath, patch, { mode: 0o600 });
        try {
          await this.git.run(target, ['apply', '--3way', '--whitespace=nowarn', patchPath]);
        } catch (error) {
          const status = await this.git.run(target, ['status', '--porcelain=v1']).catch(() => '');
          if (!isContentConflict(error, status)) throw error;
          const conflictPath = `${repository.checkoutPath}.migration-${safeTaskId(migrationId).slice(-20)}`;
          await this.docker.copyRepositoryToTask(this.docker.describe(task.runtimeId ?? task.id), target, conflictPath);
          return { status: 'conflict', baseCommit, conflictPath };
        }
      }
      await this.git.run(target, ['diff', '--check']);
      await this.docker.replaceRepositoryInTask(this.docker.describe(task.runtimeId ?? task.id), target, repository.checkoutPath);
      return { status: 'completed', baseCommit, commitMappings };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async finalizeRepositoryMigration(
    task: TaskRecord, repository: TaskRepositoryRecord, migration: RepositoryMigrationRecord,
  ): Promise<{ baseCommit: string }> {
    const conflictPath = requireRepositoryMigrationPath(repository, migration);
    const baseCommit = migration.targetBaseCommit;
    if (!baseCommit || !/^[a-fA-F0-9]{40}$/.test(baseCommit)) {
      throw new Error('Repository migration does not have an immutable target base commit.');
    }
    const runtime = this.docker.describe(task.runtimeId ?? task.id);
    const unmerged = await this.docker.runRepositoryMigrationGit(
      runtime, conflictPath, ['diff', '--name-only', '--diff-filter=U', '--'],
    );
    if (unmerged.exitCode !== 0) throw new Error(`Could not inspect repository migration conflicts: ${unmerged.stderr.trim()}`);
    if (unmerged.stdout.trim()) throw new Error(`Repository migration still has unresolved conflicts: ${unmerged.stdout.trim()}`);
    for (const args of [['diff', '--check'], ['diff', '--cached', '--check']] as const) {
      const checked = await this.docker.runRepositoryMigrationGit(runtime, conflictPath, [...args]);
      if (checked.exitCode !== 0) throw new Error(`Repository migration validation failed: ${(checked.stderr || checked.stdout).trim()}`);
    }
    const ancestry = await this.docker.runRepositoryMigrationGit(
      runtime, conflictPath, ['merge-base', '--is-ancestor', baseCommit, 'HEAD'],
    );
    if (ancestry.exitCode !== 0) throw new Error('Repository migration no longer contains the expected target base commit.');
    await this.docker.adoptRepositoryMigrationInTask(runtime, conflictPath, repository.checkoutPath);
    return { baseCommit };
  }

  async discardRepositoryMigration(
    task: TaskRecord, repository: TaskRepositoryRecord, migration: RepositoryMigrationRecord,
  ): Promise<void> {
    const conflictPath = requireRepositoryMigrationPath(repository, migration);
    await this.docker.discardRepositoryMigrationInTask(
      this.docker.describe(task.runtimeId ?? task.id), conflictPath,
    );
  }

  private async configureGit(repositoryPath: string, userId: string): Promise<void> {
    const identity = this.gitIdentities.resolve(userId);
    await this.git.run(repositoryPath, ['config', 'user.name', identity.name]);
    await this.git.run(repositoryPath, ['config', 'user.email', identity.email]);
    await this.git.run(repositoryPath, ['config', 'user.useConfigOnly', 'true']);
  }

  private async configureDockerGit(runtime: DockerTaskRuntime, userId: string): Promise<void> {
    const identity = this.gitIdentities.resolve(userId);
    await this.docker.runWorkspaceGit(runtime, ['config', 'user.name', identity.name]);
    await this.docker.runWorkspaceGit(runtime, ['config', 'user.email', identity.email]);
    await this.docker.runWorkspaceGit(runtime, ['config', 'user.useConfigOnly', 'true']);
  }

  private async configureNativeGit(repositoryPath: string): Promise<void> {
    await this.git.run(repositoryPath, ['config', '--local', 'core.sshCommand',
      'ssh -i /home/codex/.codex/native-git/id_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new']);
  }

  private async configureDockerNativeGit(runtime: DockerTaskRuntime, repositoryPath: string, project: ProjectConfig): Promise<void> {
    const upstreamRemote = (await this.git.run(project.path, ['remote', 'get-url', 'origin'])).trim();
    assertCredentialFreeRemote(upstreamRemote);
    await this.docker.runRepositoryGit(runtime, repositoryPath, ['remote', 'set-url', 'origin', nativeTaskRemote(upstreamRemote, this.nativeGitExecution)]);
    await this.docker.runRepositoryGit(runtime, repositoryPath, ['config', '--local', 'core.sshCommand',
      'ssh -i /home/codex/.codex/native-git/id_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new']);
  }

  async resolveDefaultBaseRef(project: ProjectConfig): Promise<string> {
    const refs = await this.git.run(project.path, ['ls-remote', '--heads', 'origin']);
    for (const branch of ['develop', 'master']) {
      if (refs.split('\n').some((line) => line.trim().endsWith(`refs/heads/${branch}`))) return branch;
    }
    throw new Error(`Project ${project.id} has neither an origin/develop nor an origin/master branch.`);
  }

  async resolveRepositoryBaseCommit(project: ProjectConfig, baseRef: string): Promise<string> {
    if (!/^[A-Za-z0-9._/-]{1,300}$/.test(baseRef) || baseRef.startsWith('-')) throw new Error('Unsafe repository base ref.');
    return fetchAndResolveRemoteBase(this.git, project, baseRef);
  }

  async materializeInspection(task: TaskRecord, project: ProjectConfig, targetRef: string, inspectionId: string): Promise<{ path: string; resolvedSha: string }> {
    if (!/^[A-Za-z0-9._/-]{1,300}$/.test(targetRef) || targetRef.startsWith('-') || targetRef.includes('..')) {
      throw new Error('Unsafe repository inspection ref.');
    }
    await this.diskAdmission?.assertAllocationAllowed('repository_materialize');
    const safeInspectionId = inspectionId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60);
    const safeProjectId = project.id.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60);
    const destination = `/workspace/projects/inspect-${safeProjectId}-${safeInspectionId}`;
    const staging = await mkdtemp(join(this.stagingRoot, 'inspection-'));
    try {
      const checkout = join(staging, 'checkout');
      const resolvedSha = await fetchAndResolveRemoteBase(this.git, project, targetRef);
      if (!/^[a-fA-F0-9]{7,64}$/.test(resolvedSha)) throw new Error(`Project ${project.id} did not resolve origin/${targetRef}.`);
      await this.git.run(staging, ['clone', '--local', '--no-hardlinks', '--no-checkout', '--', project.path, checkout]);
      await this.git.run(checkout, ['checkout', '--detach', resolvedSha]);
      const upstreamRemote = (await this.git.run(project.path, ['remote', 'get-url', 'origin'])).trim();
      assertCredentialFreeRemote(upstreamRemote);
      await this.git.run(checkout, ['remote', 'set-url', 'origin', nativeTaskRemote(upstreamRemote, this.nativeGitExecution)]);
      if (this.nativeGitExecution) await this.configureNativeGit(checkout);
      await writeFile(join(checkout, '.linkbot-inspection.json'), JSON.stringify({
        projectId: project.id, targetRef, resolvedSha, readOnly: true,
      }), { mode: 0o600 });
      await this.docker.copyRepositoryToTask(this.docker.describe(task.runtimeId ?? task.id), checkout, destination);
      return { path: destination, resolvedSha };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async removeInspectionSnapshots(task: TaskRecord): Promise<void> {
    await this.docker.removeInspectionSnapshots(this.docker.describe(task.runtimeId ?? task.id));
  }

  async exportRepository(task: TaskRecord, repository: TaskRepositoryRecord): Promise<string> {
    if (repository.taskId !== task.id) throw new Error('Repository does not belong to task.');
    const exportRoot = join(this.stagingRoot, 'exports', safeTaskId(task.id));
    const destination = join(exportRoot, safeTaskId(repository.id));
    await mkdir(exportRoot, { recursive: true, mode: 0o700 });
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const source = repository.checkoutPath === '.' ? '/workspace' : repository.checkoutPath;
    await this.docker.copyGitRepositorySnapshotFromTask(
      this.docker.describe(task.runtimeId ?? task.id), source, destination,
    );
    await this.git.run(destination, ['checkout', '-B', repository.branchName, 'HEAD']);
    return destination;
  }

  async observeTaskState(task: TaskRecord): Promise<TaskRuntimeState> {
    const state = await this.docker.observe(this.docker.describe(task.runtimeId ?? task.id));
    if (state === 'running') return 'hot';
    if (state === 'stopped') return 'warm';
    return 'failed';
  }

  async stageInboundAttachment(task: TaskRecord, turnId: string, source: string, fileName: string): Promise<string> {
    const destination = `/workspace/.linkbot/inbox/${safeTaskId(turnId)}/${safeAttachmentName(fileName)}`;
    await this.docker.stageWorkspaceAttachment(this.docker.describe(task.runtimeId ?? task.id), source, destination);
    return destination;
  }

  async exportArtifact(task: TaskRecord, sourcePath: string, destination: string): Promise<void> {
    await this.docker.exportWorkspaceArtifact(this.docker.describe(task.runtimeId ?? task.id), sourcePath, destination);
  }

  async removeInboundAttachments(task: TaskRecord, turnId: string): Promise<void> {
    await this.docker.removeWorkspaceAttachments(this.docker.describe(task.runtimeId ?? task.id), safeTaskId(turnId));
  }
}

function requireRepositoryMigrationPath(
  repository: TaskRepositoryRecord, migration: RepositoryMigrationRecord,
): string {
  const expected = `${repository.checkoutPath}.migration-${safeTaskId(migration.id).slice(-20)}`;
  if (!migration.conflictPath || migration.conflictPath !== expected) {
    throw new Error('Repository migration conflict path does not match its repository and migration id.');
  }
  return migration.conflictPath;
}

export function parseReviewDiff(diff: string): ReviewDiffManifest {
  const files = new Map<string, { path: string; oldLines: Set<number>; newLines: Set<number> }>();
  let current: { path: string; oldLines: Set<number>; newLines: Set<number> } | undefined;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      const path = line.slice(6);
      current = files.get(path) ?? { path, oldLines: new Set(), newLines: new Set() };
      files.set(path, current);
      continue;
    }
    if (line === '+++ /dev/null') { current = undefined; continue; }
    const hunk = current && /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !current) continue;
    addLineRange(current.oldLines, Number(hunk[1]), hunk[2] === undefined ? 1 : Number(hunk[2]));
    addLineRange(current.newLines, Number(hunk[3]), hunk[4] === undefined ? 1 : Number(hunk[4]));
  }
  return { files: [...files.values()].map((file) => ({ path: file.path, oldLines: [...file.oldLines], newLines: [...file.newLines] })) };
}

export function serializeReviewDiffManifest(manifest: ReviewDiffManifest): Record<string, { old: string[]; new: string[] }> {
  return Object.fromEntries(manifest.files.map((file) => [file.path, {
    old: compressLineRanges(file.oldLines),
    new: compressLineRanges(file.newLines),
  }]));
}

function compressLineRanges(lines: number[]): string[] {
  const sorted = [...new Set(lines)].filter((line) => Number.isInteger(line) && line > 0).sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let index = 0; index < sorted.length;) {
    const start = sorted[index]!;
    let end = start;
    index += 1;
    while (index < sorted.length && sorted[index] === end + 1) {
      end = sorted[index]!;
      index += 1;
    }
    ranges.push(start === end ? String(start) : `${start}-${end}`);
  }
  return ranges;
}

export async function cleanupRepositoryStaging(
  staging: string,
  operationError?: unknown,
  remove: typeof rm = rm,
): Promise<void> {
  try {
    await remove(staging, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 250,
    });
  } catch (cleanupError) {
    if (!operationError) throw cleanupError;
    if (operationError instanceof Error) {
      const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      operationError.message += `; staging cleanup also failed: ${sanitizeGitDiagnostic(detail)}`;
    }
  }
}

function addLineRange(target: Set<number>, start: number, count: number): void {
  for (let offset = 0; offset < count; offset += 1) target.add(start + offset);
}

function assertCredentialFreeRemote(remote: string): void {
  if (/^https?:\/\/[^/@\s]+@/i.test(remote)) throw new Error('Project origin must not contain embedded credentials.');
}

function safeTaskId(taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 80);
  if (!safe) throw new Error('Task id has no export-safe characters.');
  return safe;
}

function safeAttachmentName(name: string): string {
  const base = basename(name.normalize('NFKC')).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 255);
  return base || 'attachment.bin';
}

export class ExecManagerGitRunner implements ManagerGitRunner {
  async run(cwd: string, args: string[]): Promise<string> {
    await assertManagerGitWorkingDirectory(cwd);
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd, maxBuffer: 2_000_000 }, (error, stdout, stderr) => {
        if (error) {
          const detail = managerGitFailureDetail(error, stderr);
          return reject(new Error(`Manager Git ${args[0]} failed${detail ? `: ${detail}` : '.'}`));
        }
        resolve(stdout.trim());
      });
    });
  }

  async runRaw(cwd: string, args: string[]): Promise<Buffer> {
    await assertManagerGitWorkingDirectory(cwd);
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd, maxBuffer: 20_000_000, encoding: 'buffer' }, (error, stdout, stderr) => {
        if (error) {
          const detail = managerGitFailureDetail(error, Buffer.from(stderr).toString('utf8'));
          return reject(new Error(`Manager Git ${args[0]} failed${detail ? `: ${detail}` : '.'}`));
        }
        resolve(Buffer.from(stdout));
      });
    });
  }
}

async function assertManagerGitWorkingDirectory(cwd: string): Promise<void> {
  try {
    const value = await stat(cwd);
    if (!value.isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`Manager Git working directory is unavailable: ${cwd}. Materialize or clone the configured project repository first.`);
  }
}

function managerGitFailureDetail(error: { code?: string | number | null; message: string }, stderr: string): string {
  if (error.code === 'ENOENT') {
    return 'Git executable was not found in the Manager PATH.';
  }
  return sanitizeGitDiagnostic(stderr || error.message);
}

function isContentConflict(error: unknown, porcelainStatus: string): boolean {
  if (porcelainStatus.split('\n').some((line) => /^(?:DD|AU|UD|UA|DU|AA|UU) /.test(line))) return true;
  const message = error instanceof Error ? error.message : String(error);
  if (/corrupt patch|unrecognized input|not a git repository|no such file/i.test(message)) return false;
  return /with conflicts|patch failed|does not apply/i.test(message);
}

function sanitizeGitDiagnostic(value: string): string {
  return value
    .replace(/(?:https?:\/\/)[^\s/@]+@/gi, (match) => `${match.slice(0, match.indexOf('//') + 2)}[redacted]@`)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, 1_000);
}

async function defaultWaitForSocket(path: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await stat(path)).isSocket()) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for task app-server socket: ${path}`);
}
