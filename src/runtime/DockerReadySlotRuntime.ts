import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectConfig } from '../domain/types.js';
import { readySlotVersionKey, type ReadySlotRuntime } from './ReadyPoolController.js';
import type { ReadySlotRecord } from '../state/SqliteStateStore.js';
import type { ManagerGitRunner } from './DockerTaskProvisioner.js';
import { fetchAndResolveRemoteBase, MANAGER_ONLY_GIT_REMOTE } from './DockerTaskProvisioner.js';
import type { DockerRuntime } from './DockerRuntime.js';
import type { PersistentDiskAdmission } from './DiskLifecycleController.js';

interface ReadyVersionContext {
  project: ProjectConfig;
  baseCommit: string;
  upstreamRemote: string;
}

export class DockerReadySlotRuntime implements ReadySlotRuntime {
  private readonly versions = new Map<string, ReadyVersionContext>();

  constructor(
    private readonly docker: DockerRuntime,
    private readonly stagingRoot: string,
    private readonly git: ManagerGitRunner,
    private readonly runtimeImageVersion: string,
    private readonly codexCliVersion: string,
    private readonly clock: () => Date = () => new Date(),
    private readonly diskAdmission?: PersistentDiskAdmission,
  ) {}

  async registerProject(project: ProjectConfig): Promise<string> {
    const baseRef = project.baseRef ?? 'main';
    const baseCommit = await fetchAndResolveRemoteBase(this.git, project, baseRef);
    if (!baseCommit) throw new Error(`Unable to resolve READY base commit for project ${project.id}.`);
    const upstreamRemote = (await this.git.run(project.path, ['remote', 'get-url', 'origin'])).trim();
    if (!upstreamRemote) throw new Error(`Project ${project.id} has no origin remote.`);
    const versionKey = readySlotVersionKey({
      projectId: project.id, runtimeImageVersion: this.runtimeImageVersion,
      codexCliVersion: this.codexCliVersion, baseCommit,
      dependencyLockHash: await dependencyLockHash(project.path), setupVersion: '1',
    });
    this.versions.set(versionKey, { project, baseCommit, upstreamRemote });
    return versionKey;
  }

  async create(versionKey: string): Promise<ReadySlotRecord> {
    const context = this.versions.get(versionKey);
    if (!context) throw new Error(`READY version is not registered: ${versionKey}`);
    await this.diskAdmission?.assertAllocationAllowed('ready_slot_create');
    const runtimeId = `ready_${randomUUID()}`;
    await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 });
    const staging = join(this.stagingRoot, runtimeId);
    const workspace = join(staging, 'workspace');
    let provisioned = false;
    try {
      await this.git.run(this.stagingRoot, [
        'clone', '--local', '--no-hardlinks', '--no-checkout', '--', context.project.path, workspace,
      ]);
      await this.git.run(workspace, ['fetch', '--no-tags', context.project.path, context.baseCommit]);
      await this.git.run(workspace, ['checkout', '--detach', context.baseCommit]);
      await this.git.run(workspace, ['branch', '--force', context.project.baseRef ?? 'main', context.baseCommit]);
      await this.git.run(workspace, ['remote', 'set-url', 'origin', MANAGER_ONLY_GIT_REMOTE]);
      const runtime = await this.docker.provision(runtimeId);
      provisioned = true;
      await this.docker.copyFileToStoppedTask(runtime, `${workspace}/.`, '/workspace');
      await this.docker.prepareWorkspaceOwnership(runtime);
      const now = this.clock().toISOString();
      return {
        id: runtimeId, versionKey, status: 'ready', createdAt: now, updatedAt: now,
        metadata: { runtimeId, projectId: context.project.id, baseCommit: context.baseCommit },
      };
    } catch (error) {
      if (provisioned) await this.docker.removeTask(this.docker.describe(runtimeId)).catch(() => undefined);
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async destroy(slot: ReadySlotRecord): Promise<void> {
    const runtimeId = typeof slot.metadata?.runtimeId === 'string' ? slot.metadata.runtimeId : slot.id;
    await this.docker.removeTask(this.docker.describe(runtimeId));
  }
}

async function dependencyLockHash(projectPath: string): Promise<string> {
  const hash = createHash('sha256');
  let found = false;
  for (const fileName of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb']) {
    try {
      hash.update(fileName).update(await readFile(join(projectPath, fileName)));
      found = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return found ? hash.digest('hex') : 'none';
}
