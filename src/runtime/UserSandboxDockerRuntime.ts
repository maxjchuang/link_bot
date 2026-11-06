import { createHash } from 'node:crypto';
import { chmod,mkdir,open,rm,stat } from 'node:fs/promises';
import { basename,join } from 'node:path';
import type { DynamicProjectRecord } from '../projects/DynamicProjectTypes.js';
import type { UserSandboxRecord } from '../tasks/TaskTypes.js';
import type { DockerCommandRunner } from './DockerRuntime.js';
import { SandboxSupervisorClient,type SupervisorProjectWorkspace } from './SandboxSupervisorClient.js';

const USER_SANDBOX_RUNTIME_SPEC = '7';

export interface UserSandboxDockerConfig {
  image: string;
  bridgeRoot: string;
  cpuLimit: number;
  memoryLimitBytes: number;
  resourceOverrides?: Record<string, { cpuLimit?: number; memoryLimitBytes?: number }>;
  pidLimit: number;
  tmpfsLimitBytes: number;
  network: string;
  maxAppServersPerUser: number;
  hostUid: number;
  hostGid: number;
  authFile?: string;
  environment?: Record<string, string>;
}

export interface DockerUserSandboxRuntime {
  sandboxId: string;
  ownerId: string;
  ownerKey: string;
  generation: number;
  containerName: string;
  workspaceVolume: string;
  cacheVolume: string;
  homeVolume: string;
  codexVolume: string;
  agentsVolume: string;
  bridgeDirectory: string;
  supervisorSocketPath: string;
  containerId?: string;
  image?: string;
}

export class UserSandboxDockerRuntime {
  constructor(
    private readonly config: UserSandboxDockerConfig,
    private readonly runner: DockerCommandRunner,
    private readonly waitForSupervisor: (path: string) => Promise<void> = waitForSocket,
  ) {}

  async refreshCodexAuth(runtime: DockerUserSandboxRuntime): Promise<void> {
    if (!this.config.authFile) throw new Error('Host Codex authentication is not configured. Please sign in on the host.');
    // Read the current host path rather than a file bind mount, which can retain
    // the old inode after the host atomically replaces its credentials.
    const handle = await open(this.config.authFile, 'r');
    let contents: string;
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > 65_536) throw new Error('Invalid host Codex authentication file.');
      contents = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
    const result = await new SandboxSupervisorClient(runtime.supervisorSocketPath).refreshCodexAuth({
      ownerId: runtime.ownerId, sandboxGeneration: runtime.generation, contents,
    });
    if (!result.updated) throw new Error('No newer valid Codex credentials are available. Please sign in again on the host.');
  }

  describe(record: Pick<UserSandboxRecord, 'id'|'ownerId'|'generation'|'containerId'|'runtimeImage'>): DockerUserSandboxRuntime {
    const ownerKey = userSandboxOwnerKey(record.ownerId);
    const prefix = `link-bot-user-${ownerKey}`;
    const bridgeDirectory = join(this.config.bridgeRoot, ownerKey, `generation-${record.generation}`);
    return {
      sandboxId: record.id,
      ownerId: record.ownerId,
      ownerKey,
      generation: record.generation,
      containerName: `${prefix}-g${record.generation}`,
      workspaceVolume: `${prefix}-workspace`,
      cacheVolume: `${prefix}-cache`,
      homeVolume: `${prefix}-g${record.generation}-home`,
      codexVolume: `${prefix}-codex`,
      agentsVolume: `${prefix}-agents`,
      bridgeDirectory,
      supervisorSocketPath: join(bridgeDirectory, 'supervisor.sock'),
      ...(record.containerId ? { containerId: record.containerId } : {}),
      image: record.runtimeImage ?? this.config.image,
    };
  }

  async configuredRuntimeImage(): Promise<string> {
    const result = await this.runner.run(['image', 'inspect', '--format', '{{.Id}}', this.config.image]);
    return requireImageId(result.stdout);
  }

  async resolveRuntimeImage(record: UserSandboxRecord): Promise<string> {
    if (record.runtimeImage) return record.runtimeImage;
    // Migrate existing owners from their actual image, even if the platform's
    // stable image has advanced since their container was created.
    const runtime = this.describe(record);
    const current = await this.runner.run(['container', 'inspect', '--format', '{{.Image}}', runtime.containerName], { allowFailure: true });
    return current.exitCode === 0 ? requireImageId(current.stdout) : this.configuredRuntimeImage();
  }

  async runtimeVersion(image: string): Promise<string> {
    const result = await this.runner.run(['run', '--rm', '--entrypoint', 'codex', image, '--version']);
    const version = result.stdout.match(/codex-cli\s+(\d+\.\d+\.\d+)/)?.[1];
    if (!version) throw new Error('Unable to read container Codex version.');
    return version;
  }

  async validateRuntimeImage(image: string): Promise<void> {
    await this.runtimeVersion(image);
    await this.runner.run(['run', '--rm', '--entrypoint', 'codex', image,
      'app-server', 'generate-json-schema', '--experimental', '--out', '/tmp/link-bot-schema'], { timeoutMs: 30_000 });
  }

  async provision(record: Pick<UserSandboxRecord, 'id'|'ownerId'|'generation'|'containerId'|'runtimeImage'>): Promise<DockerUserSandboxRuntime> {
    if (!Number.isSafeInteger(record.generation) || record.generation < 1) throw new Error('Invalid user sandbox generation.');
    const runtime = this.describe(record);
    const observed = await this.observe(runtime);
    if (observed === 'running') {
      await this.waitForSupervisor(runtime.supervisorSocketPath);
      return { ...runtime, containerId: await this.inspectContainerId(runtime.containerName) };
    }
    if (observed !== 'missing') await this.runner.run(['rm', '--force', runtime.containerName]);

    await mkdir(this.config.bridgeRoot, { recursive: true, mode: 0o700 });
    await chmod(this.config.bridgeRoot, 0o700);
    await rm(runtime.bridgeDirectory, { recursive: true, force: true });
    // The host control plane and the fixed unprivileged container UID both
    // need to traverse this generation-local bridge. Its parent remains 0700,
    // so other host users cannot reach the permissive inner mount point.
    await mkdir(runtime.bridgeDirectory, { recursive: true, mode: 0o711 });
    await chmod(runtime.bridgeDirectory, 0o711);

    await this.createVolume(runtime.workspaceVolume, runtime.ownerKey, 'workspace', 'persistent');
    await this.createVolume(runtime.cacheVolume, runtime.ownerKey, 'cache', 'reclaimable');
    await this.createVolume(runtime.homeVolume, runtime.ownerKey, 'home', 'generation-local', runtime.generation);
    await this.createVolume(runtime.codexVolume, runtime.ownerKey, 'codex', 'persistent');
    await this.createVolume(runtime.agentsVolume, runtime.ownerKey, 'agents', 'persistent');
    await this.prepareVolumeRoot(runtime.workspaceVolume, '/workspace');
    await this.prepareVolumeRoot(runtime.cacheVolume, '/cache');
    await this.prepareVolumeRoot(runtime.homeVolume, '/home/codex');
    await this.prepareVolumeRoot(runtime.codexVolume, '/home/codex/.codex');
    await this.prepareVolumeRoot(runtime.agentsVolume, '/home/codex/.agents');
    try {
      await this.runner.run(this.createContainerArgs(runtime));
      await this.runner.run(['start', runtime.containerName]);
      await this.waitForSupervisor(runtime.supervisorSocketPath);
      return { ...runtime, containerId: await this.inspectContainerId(runtime.containerName) };
    } catch (error) {
      await this.runner.run(['rm', '--force', runtime.containerName], { allowFailure: true }).catch(() => undefined);
      await this.runner.run(['volume', 'rm', runtime.homeVolume], { allowFailure: true }).catch(() => undefined);
      await rm(runtime.bridgeDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  async observe(runtime: DockerUserSandboxRuntime): Promise<'missing'|'created'|'running'|'stopped'|'failed'> {
    const result = await this.runner.run([
      'container', 'inspect', '--format', '{{.State.Status}}', runtime.containerName,
    ], { allowFailure: true });
    if ((result.exitCode ?? 0) !== 0) return 'missing';
    switch (result.stdout.trim()) {
      case 'created': return 'created';
      case 'running': return 'running';
      case 'exited':
      case 'dead': return 'stopped';
      default: return 'failed';
    }
  }

  async ensureProjectWorkspace(
    runtime: DockerUserSandboxRuntime,
    input: { projectId: string; cloneUrl: string; baseRef: string },
  ): Promise<SupervisorProjectWorkspace> {
    return new SandboxSupervisorClient(runtime.supervisorSocketPath, 300_000).ensureProject(input);
  }

  async inspectProjectBranch(runtime: DockerUserSandboxRuntime, workspace: SupervisorProjectWorkspace, expectedCloneUrl?: string): Promise<string> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(workspace.projectId)
      || ![`/workspace/${workspace.projectId}`,`/workspace/projects/${workspace.projectId}`].includes(workspace.cwd)) throw new Error('Unsafe project workspace.');
    const prefix=['exec','--user','10001:10001',runtime.containerName,'git','-C',workspace.cwd];
    if(expectedCloneUrl){
      const remote=await this.runner.run([...prefix,'remote','get-url','origin']);
      const identity=(value:string)=>value.trim().replace(/^git@([^:]+):/,'https://$1/').replace(/\.git\/?$/,'').replace(/\/$/,'');
      if(identity(remote.stdout)!==identity(expectedCloneUrl))throw new Error('Project origin does not match the configured repository.');
    }
    const named=await this.runner.run([...prefix,'symbolic-ref','--quiet','--short','HEAD'],{allowFailure:true});
    if(named.exitCode===0 && named.stdout.trim())return named.stdout.trim();
    const detached=await this.runner.run([...prefix,'rev-parse','--short','HEAD']);
    if(!detached.stdout.trim())throw new Error('Project HEAD could not be verified.');
    return `detached@${detached.stdout.trim()}`;
  }

  /** Local-only validation also used for binding/recovery when the provider is offline. */
  async inspectLocalProject(runtime: DockerUserSandboxRuntime, localPath:string, repositoryUrl:string):Promise<{localPath:string;branchName:string}> {
    if (!/^\/workspace\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(localPath)) throw new Error('Existing clone must be /workspace/<directory>.');
    const identity = (value:string) => value.trim().replace(/^git@([^:]+):/,'https://$1/').replace(/\.git\/?$/,'').replace(/\/$/,'');
    const matched = /^https:\/\/(github\.com)\/([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)$/.exec(identity(repositoryUrl));
    if (!matched) throw new Error('Unsupported repository URL.');
    const provider = 'github' as const;
    const exec=async(args:string[])=>{
      const result=await this.runner.run(['exec','--user','10001:10001',runtime.containerName,...args],{allowFailure:true});
      if(result.exitCode!==0)throw new Error('Unable to inspect existing repository; verify the directory and Git state.');
      return result.stdout.trim();
    };
    if (await exec(['realpath','-e',localPath]) !== localPath
      || await exec(['git','-C',localPath,'rev-parse','--show-toplevel']) !== localPath) throw new Error('Existing clone path is not the repository root.');
    const origin = await exec(['git','-C',localPath,'remote','get-url','origin']);
    const sameIdentity=provider==='github'?identity(origin).toLowerCase()===identity(repositoryUrl).toLowerCase():identity(origin)===identity(repositoryUrl);
    if (!sameIdentity) throw new Error('Project origin does not match the requested repository.');
    await exec(['git','-C',localPath,'rev-parse','--verify','HEAD^{commit}']);
    const branchName = await this.inspectProjectBranch(runtime,{projectId:localPath.slice('/workspace/'.length),cwd:localPath,status:'ready'});
    return {localPath,branchName};
  }

  /** Read-only import: never clone, checkout, fetch, or alter the existing worktree. */
  async inspectExistingProject(runtime: DockerUserSandboxRuntime, localPath: string, repositoryUrl: string): Promise<
    Pick<DynamicProjectRecord,'provider'|'providerRepoId'|'namespace'|'name'|'cloneUrl'|'defaultBranch'> & {localPath:string;branchName:string}
  > {
    const {branchName}=await this.inspectLocalProject(runtime,localPath,repositoryUrl);
    const canonicalUrl=repositoryUrl.trim().replace(/^git@([^:]+):/,'https://$1/').replace(/\.git\/?$/,'').replace(/\/$/,'');
    const parsed=new URL(canonicalUrl);
    if (parsed.hostname !== 'github.com') throw new Error('Only GitHub repositories are supported.');
    const provider = 'github' as const;
    const path=provider==='github'?parsed.pathname.slice(1).toLowerCase():parsed.pathname.slice(1);
    // Topic-local identity, NOT a remote provider ID. Initial import must be
    // usable offline, just like subsequent binding/recovery of this checkout.
    const providerRepoId=`local:${createHash('sha256').update(`${provider}:${path}`).digest('hex')}`;
    const parts = path.split('/');
    return {provider,providerRepoId,namespace:parts.slice(0,-1).join('/'),name:parts.at(-1)!,
      cloneUrl:`https://${parsed.hostname}/${path}.git`,localPath,defaultBranch:branchName,branchName};
  }

  async stopAndRemove(
    record: Pick<UserSandboxRecord, 'id'|'ownerId'|'generation'|'containerId'>,
  ): Promise<void> {
    const runtime = this.describe(record);
    await this.runner.run(['rm', '--force', runtime.containerName], { allowFailure: true });
    await this.migrateGenerationToolHome(runtime);
    await this.runner.run(['volume', 'rm', runtime.homeVolume], { allowFailure: true });
    await rm(runtime.bridgeDirectory, { recursive: true, force: true });
  }

  async stageTaskAttachment(
    runtime: DockerUserSandboxRuntime, taskId: string, turnId: string, source: string, fileName: string,
    layout?: 'project',
  ): Promise<string> {
    const task = safeSandboxSegment(taskId, 'task id');
    const turn = safeSandboxSegment(turnId, 'turn id');
    const file = safeSandboxFileName(fileName);
    const directory = `${sandboxTaskDataRoot(task, layout)}/inbox/${turn}`;
    const destination = `${directory}/${file}`;
    const staged = `${destination}.part`;
    await this.runner.run(['exec', '--user', '10001:10001', runtime.containerName, 'mkdir', '-p', directory]);
    await this.runner.run(['cp', source, `${runtime.containerName}:${staged}`]);
    await this.runner.run(['exec', '--user', '0:0', runtime.containerName, 'chown', '10001:10001', staged]);
    await this.runner.run(['exec', '--user', '10001:10001', runtime.containerName, 'chmod', '0400', staged]);
    await this.runner.run(['exec', '--user', '0:0', runtime.containerName, 'mv', '-f', staged, destination]);
    return destination;
  }

  async exportTaskArtifact(
    runtime: DockerUserSandboxRuntime, taskId: string, sourcePath: string, destination: string,
    layout?: 'project',
  ): Promise<void> {
    const task = safeSandboxSegment(taskId, 'task id');
    const prefix = `${sandboxTaskDataRoot(task, layout)}/outbox/`;
    const sharedArtifacts = '/workspace/.linkbot/artifacts/';
    if ((!sourcePath.startsWith(prefix) && !sourcePath.startsWith(sharedArtifacts)) || sourcePath.includes('/../')) {
      throw new Error('Unsafe user-sandbox artifact path.');
    }
    const inspected = await this.runner.run([
      'exec', '--user', '10001:10001', runtime.containerName,
      'sh', '-ceu', [
        'path="$1"', 'prefix="$2"', 'resolved="$(realpath "$path")"',
        'case "$resolved" in "$prefix"*|/workspace/.linkbot/artifacts/*) ;; *) exit 41 ;; esac',
        '[ -f "$path" ] && [ ! -L "$path" ] && [ "$(stat -c %h "$path")" = 1 ]',
      ].join('\n'), 'link-bot-artifact-check', sourcePath, prefix,
    ], { allowFailure: true });
    if ((inspected.exitCode ?? 0) !== 0) throw new Error('Artifact path is not a safe regular workspace file.');
    await this.runner.run(['cp', `${runtime.containerName}:${sourcePath}`, destination]);
  }

  async removeTaskAttachments(runtime: DockerUserSandboxRuntime, taskId: string, turnId: string, layout?: 'project'): Promise<void> {
    const task = safeSandboxSegment(taskId, 'task id');
    const turn = safeSandboxSegment(turnId, 'turn id');
    await this.runner.run([
      'exec', '--user', '0:0', runtime.containerName,
      'rm', '-rf', `${sandboxTaskDataRoot(task, layout)}/inbox/${turn}`,
    ]);
  }

  private createContainerArgs(runtime: DockerUserSandboxRuntime): string[] {
    const resources = this.config.resourceOverrides?.[runtime.ownerId];
    return [
      'create', '--name', runtime.containerName,
      '--label', 'link-bot.runtime-mode=user-sandbox',
      '--label', `link-bot.owner-key=${runtime.ownerKey}`,
      '--label', `link-bot.sandbox-id=${runtime.sandboxId}`,
      '--label', `link-bot.sandbox-generation=${runtime.generation}`,
      '--label', `link-bot.runtime-spec=${USER_SANDBOX_RUNTIME_SPEC}`,
      '--user', '0:0',
      '--cap-drop', 'ALL',
      '--cap-add', 'CHOWN',
      '--cap-add', 'DAC_OVERRIDE',
      '--cap-add', 'SETUID',
      '--cap-add', 'SETGID',
      '--cap-add', 'KILL',
      '--security-opt', 'no-new-privileges=true',
      '--security-opt', 'seccomp=unconfined',
      '--security-opt', 'systempaths=unconfined',
      '--cpus', String(resources?.cpuLimit ?? this.config.cpuLimit),
      '--memory', String(resources?.memoryLimitBytes ?? this.config.memoryLimitBytes),
      '--pids-limit', String(this.config.pidLimit),
      '--stop-timeout', '15',
      '--network', this.config.network,
      '--workdir', '/workspace',
      '--env', `LINK_BOT_SANDBOX_ID=${runtime.sandboxId}`,
      '--env', `LINK_BOT_OWNER_ID=${runtime.ownerId}`,
      '--env', `LINK_BOT_SANDBOX_GENERATION=${runtime.generation}`,
      '--env', `LINK_BOT_MAX_APP_SERVERS=${this.config.maxAppServersPerUser}`,
      '--env', `LINK_BOT_CODEX_ARGS=${JSON.stringify([
        '-c', 'features.context_management.experimental_mode=true',
        '-c', 'model_context_window=1000000',
        'app-server', '--stdio',
      ])}`,
      '--env', `LINK_BOT_HOST_UID=${this.config.hostUid}`,
      '--env', `LINK_BOT_HOST_GID=${this.config.hostGid}`,
      '--env', 'XDG_CACHE_HOME=/cache',
      '--env', 'NPM_CONFIG_CACHE=/cache/npm',
      '--env', 'LINK_BOT_TOOL_HOME=/home/codex/.codex/tool-home',
      '--env', 'GH_CONFIG_DIR=/home/codex/.codex/tool-home/gh',
      '--env', 'LINK_BOT_NATIVE_GIT_HOME=/home/codex/.link-bot/native-git',
      '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${this.config.tmpfsLimitBytes}`,
      '--mount', `type=volume,src=${runtime.workspaceVolume},dst=/workspace`,
      '--mount', `type=volume,src=${runtime.cacheVolume},dst=/cache`,
      '--mount', `type=volume,src=${runtime.homeVolume},dst=/home/codex`,
      '--mount', `type=volume,src=${runtime.codexVolume},dst=/home/codex/.codex`,
      '--mount', `type=volume,src=${runtime.agentsVolume},dst=/home/codex/.agents`,
      '--mount', `type=bind,src=${runtime.bridgeDirectory},dst=/run/link-bot/bridge`,
      ...(this.config.authFile ? [
        '--env', 'LINK_BOT_AUTH_FILE=/run/link-bot-auth.json',
        '--mount', `type=bind,src=${this.config.authFile},dst=/run/link-bot-auth.json,readonly`,
      ] : []),
      ...Object.entries(this.config.environment ?? {}).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
      '--entrypoint', '/usr/bin/tini',
      runtime.image ?? this.config.image,
      '-s', '--', '/usr/local/bin/link-bot-sandbox-supervisor',
    ];
  }

  private async createVolume(
    name: string,
    ownerKey: string,
    kind: 'workspace'|'cache'|'home'|'codex'|'agents',
    durability: 'persistent'|'reclaimable'|'generation-local',
    generation?: number,
  ): Promise<void> {
    await this.runner.run([
      'volume', 'create',
      '--label', 'link-bot.runtime-mode=user-sandbox',
      '--label', `link-bot.owner-key=${ownerKey}`,
      '--label', `link-bot.volume-kind=${kind}`,
      '--label', `link-bot.durability=${durability}`,
      ...(generation === undefined ? [] : ['--label', `link-bot.sandbox-generation=${generation}`]),
      name,
    ]);
  }

  private async inspectContainerId(containerName: string): Promise<string> {
    const result = await this.runner.run(['container', 'inspect', '--format', '{{.Id}}', containerName]);
    const id = result.stdout.trim();
    if (!/^[a-f0-9]{12,64}$/i.test(id)) throw new Error('Docker returned an invalid user sandbox container id.');
    return id;
  }

  private async prepareVolumeRoot(volume: string, destination: string): Promise<void> {
    await this.runner.run([
      'run', '--rm', '--user', '0:0', '--entrypoint', 'chown',
      '--mount', `type=volume,src=${volume},dst=${destination}`,
      this.config.image, '10001:10001', destination,
    ]);
  }

  /**
   * Runtime spec 4 kept the whole tool HOME in the generation-local user HOME.
   * Preserve that state before deleting an old wrapper so the first spec 5
   * generation retains native CLI configuration and login state. Native Git
   * keys remain under the generation-local `.link-bot/native-git` directory
   * and are intentionally not copied.
   */
  private async migrateGenerationToolHome(runtime: DockerUserSandboxRuntime): Promise<void> {
    const exists = await this.runner.run(['volume', 'inspect', runtime.homeVolume], { allowFailure: true });
    if ((exists.exitCode ?? 0) !== 0) return;
    await this.runner.run([
      'run', '--rm', '--network', 'none', '--user', '0:0',
      '--mount', `type=volume,src=${runtime.homeVolume},dst=/legacy-home,readonly`,
      '--mount', `type=volume,src=${runtime.codexVolume},dst=/codex-home`,
      '--entrypoint', '/bin/sh', this.config.image, '-c', [
        'set -eu',
        'source=/legacy-home/.link-bot/tool-home',
        'target=/codex-home/tool-home',
        'if [ -d "$source" ]; then',
        '  mkdir -p "$target"',
        '  cp -a "$source"/. "$target"/',
        '  chown -R 10001:10001 "$target"',
        '  chmod 0700 "$target"',
        'fi',
      ].join('\n'),
    ]);
  }
}

export function userSandboxOwnerKey(ownerId: string): string {
  if (!ownerId || ownerId.includes('\0')) throw new Error('Invalid user sandbox owner id.');
  return createHash('sha256').update(ownerId).digest('hex').slice(0, 24);
}

function safeSandboxSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) throw new Error(`Invalid sandbox ${label}.`);
  return value.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 120);
}

function sandboxTaskDataRoot(task: string, layout?: 'project'): string {
  return layout === 'project'
    ? `/workspace/.linkbot/tasks/${task}`
    : `/workspace/tasks/${task}/.linkbot`;
}

function safeSandboxFileName(value: string): string {
  const safe = basename(value.normalize('NFKC')).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 255);
  return safe || 'attachment.bin';
}

function requireImageId(value: string): string {
  const id = value.trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error('Docker returned an invalid immutable image ID.');
  return id;
}

async function waitForSocket(path: string): Promise<void> {
  // First boot may import a large task-local Codex history into the owner's
  // persistent shared home before the Supervisor exposes its control socket.
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const info = await stat(path);
      if (info.isSocket()) return;
    } catch {}
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for user sandbox Supervisor socket: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
