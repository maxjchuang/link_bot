import { execFile } from 'node:child_process';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const MAX_REPOSITORY_EXPORT_BYTES = 1024 * 1024 * 1024;
const RUNTIME_SPEC_VERSION = '5';

export const GIT_REPOSITORY_SNAPSHOT_SCRIPT = String.raw`
repo="$1"
snapshot="$2"
snapshot_id="$3"
git_bin=/usr/bin/git
if [ "$#" -ge 4 ]; then mode="$4"; else mode="snapshot"; fi
tmp_root="$(mktemp -d)"
index="$tmp_root/index"
ref="refs/link-bot/exports/$snapshot_id"
cleanup() {
  "$git_bin" -C "$repo" update-ref -d "$ref" >/dev/null 2>&1 || true
  rm -f "$index"
  rmdir "$tmp_root"
}

trap cleanup EXIT INT TERM
rm -rf "$snapshot"
mkdir -p "$(dirname "$snapshot")"
GIT_INDEX_FILE="$index" "$git_bin" -C "$repo" read-tree HEAD
GIT_INDEX_FILE="$index" "$git_bin" -C "$repo" add -A -- . \
  ':(exclude).linkbot/exports/**'
tree="$(GIT_INDEX_FILE="$index" "$git_bin" -C "$repo" write-tree)"
head="$("$git_bin" -C "$repo" rev-parse HEAD^{commit})"
head_tree="$("$git_bin" -C "$repo" rev-parse HEAD^{tree})"
if [ "$mode" = "require-clean" ] && [ "$tree" != "$head_tree" ]; then
  changes="$("$git_bin" -C "$repo" status --short --untracked-files=all -- . \
    ':(exclude).linkbot/exports/**')"
  printf '%s\n%s\n' 'REPOSITORY_EXPORT_DIRTY: remediation must commit all Git-visible changes before publishing.' "$changes" >&2
  exit 42
fi
if [ "$tree" = "$head_tree" ]; then
  commit="$head"
else
  commit="$(printf '%s\n' 'Link Bot repository export snapshot' | "$git_bin" -C "$repo" \
    -c user.name='Link Bot Export' -c user.email='link-bot-export@localhost' \
    commit-tree "$tree" -p "$head")"
fi
"$git_bin" -C "$repo" update-ref "$ref" "$commit"
GIT_LFS_SKIP_SMUDGE=1 "$git_bin" clone --no-checkout --local "$repo" "$snapshot"
GIT_LFS_SKIP_SMUDGE=1 "$git_bin" -C "$snapshot" checkout --detach --force "$commit"
"$git_bin" -C "$snapshot" config linkbot.export.originalHead "$head"
`;

function assertRuntimeAssetPath(path: string): void {
  if (!/^\/run\/link-bot\/(?:config|secrets)\/[A-Za-z0-9._/-]+$/.test(path) || path.includes('/../')) {
    throw new Error('Unsafe task runtime-asset destination.');
  }
}

export interface DockerCommandRunner {
  run(args: string[], options?: { signal?: AbortSignal; timeoutMs?: number; allowFailure?: boolean }): Promise<{
    stdout: string; stderr: string; exitCode?: number;
  }>;
}

export interface DockerRuntimeConfig {
  image: string;
  socketRoot: string;
  cpuLimit: number;
  memoryLimitBytes: number;
  pidLimit: number;
  tmpfsLimitBytes?: number;
  network: string;
  codexCliVersion?: string;
  environment?: Record<string, string>;
}

export interface DockerTaskRuntime {
  taskId: string;
  containerName: string;
  workspaceVolume: string;
  codexHomeVolume: string;
  socketDirectory: string;
  socketPath: string;
  userCacheVolume?: string;
}

export type RuntimeAssetInspectionState = 'ready' | 'asset_missing' | 'permission_denied' | 'asset_empty' | 'invalid_secret';

export interface DockerManagedTaskResources {
  runtimeId: string;
  workspaceVolume?: string;
  codexHomeVolume?: string;
  createdAt?: string;
}

export interface DockerManagedTaskVolumeBytes {
  workspaceBytes: number;
  codexHomeBytes: number;
  totalBytes: number;
}

export class DockerRuntime {
  constructor(
    private readonly config: DockerRuntimeConfig,
    private readonly runner: DockerCommandRunner = new ExecDockerCommandRunner(),
  ) {}

  async runTaskCommand(
    runtime: DockerTaskRuntime, command: string[], options: { workdir?: string; timeoutMs?: number } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (!command.length || command.some((part) => part.includes('\0'))) throw new Error('Unsafe empty task command.');
    const workdir = options.workdir ?? '/workspace';
    if (!workdir.startsWith('/') || workdir.includes('\0')) throw new Error('Unsafe task command workdir.');
    const result = await this.runner.run([
      'exec', '--user', '10001:10001', '--workdir', workdir,
      runtime.containerName, ...command,
    ], { timeoutMs: options.timeoutMs ?? 30 * 60_000, allowFailure: true });
    return { ...result, exitCode: result.exitCode ?? 0 };
  }

  async healthCheck(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await this.runner.run(['version', '--format', '{{.Server.Version}}']);
      await this.runner.run(['image', 'inspect', this.config.image]);
      if (this.config.codexCliVersion) {
        const version = await this.runner.run(['run', '--rm', '--entrypoint', 'codex', this.config.image, '--version']);
        if (!version.stdout.includes(this.config.codexCliVersion)) {
          return { ok: false, reason: `Runtime image Codex CLI does not match ${this.config.codexCliVersion}.` };
        }
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async provision(taskId: string, userId?: string): Promise<DockerTaskRuntime> {
    const names = runtimeNames(taskId, this.config.socketRoot, userId);
    let workspaceVolumeCreated = false;
    let codexHomeVolumeCreated = false;
    await mkdir(this.config.socketRoot, { recursive: true, mode: 0o700 });
    await chmod(this.config.socketRoot, 0o700);
    try {
      try {
        await mkdir(names.socketDirectory, { recursive: false, mode: 0o711 });
        await chmod(names.socketDirectory, 0o711);
      } catch (error) {
        if (!isAlreadyExists(error) || await this.observe(names) !== 'missing') throw error;
        await rm(names.socketDirectory, { recursive: true, force: true });
        await mkdir(names.socketDirectory, { recursive: false, mode: 0o711 });
        await chmod(names.socketDirectory, 0o711);
      }
      await this.createTaskVolume(names.workspaceVolume, taskId, 'workspace', userId);
      workspaceVolumeCreated = true;
      await this.createTaskVolume(names.codexHomeVolume, taskId, 'codex-home', userId);
      codexHomeVolumeCreated = true;
      if (names.userCacheVolume) await this.runner.run(['volume', 'create', names.userCacheVolume]);
      if (names.userCacheVolume) await this.prepareUserVolume(names.userCacheVolume);
      await this.createContainer(names, taskId);
      return names;
    } catch (error) {
      // Docker may create a named container and still return an error. Removing
      // unconditionally makes provisioning retry-safe in both cases.
      await this.runner.run(['rm', '--force', names.containerName]).catch(() => undefined);
      const volumes = [
        ...(workspaceVolumeCreated ? [names.workspaceVolume] : []),
        ...(codexHomeVolumeCreated ? [names.codexHomeVolume] : []),
      ];
      if (volumes.length > 0) await this.runner.run(['volume', 'rm', ...volumes]).catch(() => undefined);
      await rm(names.socketDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  private async createContainer(names: DockerTaskRuntime, taskId: string): Promise<void> {
    await this.runner.run([
        'create', '--interactive', '--name', names.containerName,
        '--label', `link-bot.task-id=${taskId}`,
        '--label', `link-bot.runtime-spec=${RUNTIME_SPEC_VERSION}`,
        '--user', '10001:10001',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges=true',
        '--security-opt', 'seccomp=unconfined',
        '--security-opt', 'systempaths=unconfined',
        '--cpus', String(this.config.cpuLimit),
        '--memory', String(this.config.memoryLimitBytes),
        '--pids-limit', String(this.config.pidLimit),
        '--env', `LINK_BOT_TASK_ID=${taskId}`,
        '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${this.config.tmpfsLimitBytes ?? 2_147_483_648}`,
        '--network', this.config.network,
        '--mount', `type=volume,src=${names.workspaceVolume},dst=/workspace`,
        '--mount', `type=volume,src=${names.codexHomeVolume},dst=/home/codex/.codex`,
        '--mount', `type=bind,src=${names.socketDirectory},dst=/run/link-bot/task-bridge`,
        ...(names.userCacheVolume ? ['--mount', `type=volume,src=${names.userCacheVolume},dst=/home/codex/.cache`] : []),
        ...Object.entries(this.config.environment ?? {}).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
        this.config.image,
    ]);
  }

  /** Recreates only the container wrapper for an existing task, preserving its workspace and Codex home volumes. */
  async recreateMissingContainer(taskId: string, userId?: string): Promise<DockerTaskRuntime> {
    const names = runtimeNames(taskId, this.config.socketRoot, userId);
    if (await this.observe(names) !== 'missing') return names;
    await mkdir(this.config.socketRoot, { recursive: true, mode: 0o700 });
    await chmod(this.config.socketRoot, 0o700);
    await rm(names.socketDirectory, { recursive: true, force: true });
    await mkdir(names.socketDirectory, { recursive: false, mode: 0o711 });
    await chmod(names.socketDirectory, 0o711);
    // `docker volume create` is idempotent. It restores a missing ancillary
    // volume without replacing an existing task workspace or Codex home.
    await this.createTaskVolume(names.workspaceVolume, taskId, 'workspace', userId);
    await this.createTaskVolume(names.codexHomeVolume, taskId, 'codex-home', userId);
    if (names.userCacheVolume) await this.runner.run(['volume', 'create', names.userCacheVolume]);
    if (names.userCacheVolume) await this.prepareUserVolume(names.userCacheVolume);
    try {
      await this.createContainer(names, taskId);
      return names;
    } catch (error) {
      await this.runner.run(['rm', '--force', names.containerName]).catch(() => undefined);
      await rm(names.socketDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  /** Replaces an outdated container wrapper while preserving task-owned volumes. */
  async ensureCurrentImage(taskId: string, userId?: string): Promise<DockerTaskRuntime> {
    const names = runtimeNames(taskId, this.config.socketRoot, userId);
    if (await this.observe(names) === 'missing') return this.recreateMissingContainer(taskId, userId);
    const [container, configuredImage] = await Promise.all([
      this.runner.run(['inspect', '--format', '{{.Image}} {{index .Config.Labels "link-bot.runtime-spec"}}', names.containerName]),
      this.runner.run(['image', 'inspect', '--format', '{{.Id}}', this.config.image]),
    ]);
    const [containerImage, runtimeSpec = ''] = container.stdout.trim().split(/\s+/, 2);
    if (containerImage === configuredImage.stdout.trim() && runtimeSpec === RUNTIME_SPEC_VERSION) return names;
    await this.stop(names).catch(() => undefined);
    await this.runner.run(['rm', '--force', names.containerName]);
    await mkdir(names.socketDirectory, { recursive: true, mode: 0o711 });
    await chmod(names.socketDirectory, 0o711);
    await this.createContainer(names, taskId);
    return names;
  }

  async start(runtime: DockerTaskRuntime): Promise<void> {
    await this.runner.run(['start', runtime.containerName]);
  }

  async stop(runtime: DockerTaskRuntime, timeoutSeconds = 20): Promise<void> {
    await this.runner.run(['stop', '--time', String(timeoutSeconds), runtime.containerName]);
    await rm(runtime.socketPath, { force: true });
  }

  async copyFileToStoppedTask(runtime: DockerTaskRuntime, source: string, destination: string): Promise<void> {
    await this.runner.run(['cp', source, `${runtime.containerName}:${destination}`]);
  }

  async copyWorkspaceControlFile(runtime: DockerTaskRuntime, source: string, destination: string): Promise<void> {
    if (destination !== '/workspace/AGENTS.md' && destination !== '/workspace/.linkbot/projects.md') {
      throw new Error('Unsafe task workspace control-file destination.');
    }
    await this.runner.run(['cp', source, `${runtime.containerName}:${destination}`]);
    await this.runVolumeHelper(runtime.workspaceVolume, '/workspace', 'chown', ['10001:10001', destination]);
    await this.runVolumeHelper(runtime.workspaceVolume, '/workspace', 'chmod', ['0600', destination]);
  }

  async prepareWorkspaceOwnership(runtime: DockerTaskRuntime): Promise<void> {
    await this.runVolumeHelper(runtime.workspaceVolume, '/workspace', 'chown', ['-R', '10001:10001', '/workspace']);
  }

  async prepareCodexHomeOwnership(runtime: DockerTaskRuntime): Promise<void> {
    await this.runVolumeHelper(runtime.codexHomeVolume, '/home/codex/.codex', 'chown', ['-R', '10001:10001', '/home/codex/.codex']);
  }

  async copyAuthToStoppedTask(runtime: DockerTaskRuntime, source: string, fileName: string): Promise<void> {
    if (!/^[A-Za-z0-9._-]+$/.test(fileName)) throw new Error('Unsafe task authentication file name.');
    const destination = `/home/codex/.codex/${fileName}`;
    await this.copyFileToStoppedTask(runtime, source, destination);
    await this.runVolumeHelper(runtime.codexHomeVolume, '/home/codex/.codex', 'chown', ['10001:10001', destination]);
    await this.runVolumeHelper(runtime.codexHomeVolume, '/home/codex/.codex', 'chmod', ['0600', destination]);
  }

  async copyPathFromTask(runtime: DockerTaskRuntime, source: string, destination: string): Promise<void> {
    await this.runner.run(['cp', `${runtime.containerName}:${source}`, destination]);
  }

  async stageWorkspaceAttachment(runtime: DockerTaskRuntime, source: string, destination: string): Promise<void> {
    assertLegacyAttachmentPath(destination);
    const parent = dirname(destination);
    const staged = `${destination}.part`;
    await this.runVolumeHelper(runtime.workspaceVolume, '/workspace', 'mkdir', ['-p', parent]);
    await this.runner.run(['cp', source, `${runtime.containerName}:${staged}`]);
    await this.runVolumeHelper(runtime.workspaceVolume, '/workspace', 'chown', ['10001:10001', staged]);
    await this.runVolumeHelper(runtime.workspaceVolume, '/workspace', 'chmod', ['0400', staged]);
    await this.runVolumeHelper(runtime.workspaceVolume, '/workspace', 'mv', ['-f', staged, destination]);
  }

  async exportWorkspaceArtifact(runtime: DockerTaskRuntime, source: string, destination: string): Promise<void> {
    assertLegacyArtifactPath(source);
    const inspected = await this.runner.run([
      'exec', '--user', '10001:10001', runtime.containerName,
      'sh', '-ceu', [
        'path="$1"',
        'resolved="$(realpath "$path")"',
        'case "$resolved" in /workspace/.linkbot/outbox/*|/workspace/.linkbot/artifacts/*) ;; *) exit 41 ;; esac',
        '[ -f "$path" ] && [ ! -L "$path" ] && [ "$(stat -c %h "$path")" = 1 ]',
      ].join('\n'), 'link-bot-artifact-check', source,
    ], { allowFailure: true });
    if ((inspected.exitCode ?? 0) !== 0) throw new Error('Artifact path is not a safe regular workspace file.');
    await this.runner.run(['cp', `${runtime.containerName}:${source}`, destination]);
  }

  async removeWorkspaceAttachments(runtime: DockerTaskRuntime, turnId: string): Promise<void> {
    const safe = safeRuntimeId(turnId);
    if (safe !== turnId || !safe.startsWith('turn_')) throw new Error('Unsafe attachment turn id.');
    await this.runVolumeHelper(runtime.workspaceVolume, '/workspace', 'rm', [
      '-rf', `/workspace/.linkbot/inbox/${safe}`,
    ]);
  }

  /**
   * Exports Git-visible repository state without copying ignored build caches.
   * The temporary commit includes tracked changes and non-ignored untracked files,
   * while leaving the task repository's index, branch, and working tree untouched.
   */
  async copyGitRepositorySnapshotFromTask(
    runtime: DockerTaskRuntime,
    repositoryPath: string,
    destination: string,
    options?: { requireClean?: boolean },
  ): Promise<void> {
    if (repositoryPath !== '/workspace'
      && !/^\/workspace\/(?:repositories|projects)\/[A-Za-z0-9._-]+$/.test(repositoryPath)) {
      throw new Error('Unsafe task repository path.');
    }
    const snapshotId = randomUUID().replaceAll('-', '');
    const snapshotPath = `/workspace/.linkbot/exports/${snapshotId}`;
    const helperArgs = [
      'run', '--rm', '--network', 'none', '--user', '10001:10001',
      '--mount', `type=volume,src=${runtime.workspaceVolume},dst=/workspace`,
      '--entrypoint', 'sh', this.config.image,
    ];
    try {
      await this.runner.run([
        ...helperArgs, '-ceu', GIT_REPOSITORY_SNAPSHOT_SCRIPT, '--', repositoryPath, snapshotPath, snapshotId,
        options?.requireClean ? 'require-clean' : 'snapshot',
      ]);
      const measured = await this.runner.run([
        ...helperArgs, '-ceu', 'du -sb "$1" | cut -f1', '--', snapshotPath,
      ]);
      const bytes = Number.parseInt(measured.stdout.trim(), 10);
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        throw new Error(`REPOSITORY_EXPORT_SIZE_UNKNOWN: invalid snapshot size ${JSON.stringify(measured.stdout.trim())}.`);
      }
      if (bytes > MAX_REPOSITORY_EXPORT_BYTES) {
        throw new Error(
          `REPOSITORY_EXPORT_TOO_LARGE: Git snapshot is ${bytes} bytes; limit is ${MAX_REPOSITORY_EXPORT_BYTES} bytes. `
          + 'Remove large non-ignored generated files or add them to .gitignore before publishing.',
        );
      }
      try {
        await this.runner.run(['cp', `${runtime.containerName}:${snapshotPath}/.`, destination]);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`REPOSITORY_EXPORT_COPY_FAILED: Git snapshot (${bytes} bytes) could not be copied: ${reason}`);
      }
    } finally {
      await this.runner.run([...helperArgs, '-ceu', 'rm -rf "$1"', '--', snapshotPath]).catch(() => undefined);
    }
  }

  async copyRepositoryToTask(runtime: DockerTaskRuntime, source: string, destination: string): Promise<void> {
    if (!/^\/workspace\/(?:repositories|projects)\/[A-Za-z0-9._-]+$/.test(destination)) {
      throw new Error('Unsafe task repository destination.');
    }
    await this.runVolumeHelper(runtime.workspaceVolume, '/workspace', 'mkdir', ['-p', destination]);
    await this.runner.run(['cp', `${source}/.`, `${runtime.containerName}:${destination}`]);
    await this.runVolumeHelper(runtime.workspaceVolume, '/workspace', 'chown', ['-R', '10001:10001', destination]);
  }

  async removeInspectionSnapshots(runtime: DockerTaskRuntime): Promise<void> {
    await this.runVolumeHelper(runtime.workspaceVolume, '/workspace', 'sh', [
      '-ceu',
      'for path in /workspace/projects/inspect-*; do [ -e "$path" ] || continue; rm -rf -- "$path"; done',
    ]);
  }

  async replaceRepositoryInTask(runtime: DockerTaskRuntime, source: string, destination: string): Promise<void> {
    if (!/^\/workspace\/(?:repositories|projects)\/[A-Za-z0-9._-]+$/.test(destination)) throw new Error('Unsafe task repository destination.');
    const next = `${destination}.migration-next`;
    const previous = `${destination}.migration-previous`;
    await this.runVolumeHelper(runtime.workspaceVolume, '/workspace', 'rm', ['-rf', next]);
    await this.runVolumeHelper(runtime.workspaceVolume, '/workspace', 'rm', ['-rf', previous]);
    await this.runVolumeHelper(runtime.workspaceVolume, '/workspace', 'mkdir', ['-p', next]);
    await this.runner.run(['cp', `${source}/.`, `${runtime.containerName}:${next}`]);
    await this.runVolumeHelper(runtime.workspaceVolume, '/workspace', 'chown', ['-R', '10001:10001', next]);
    await this.runVolumeHelper(runtime.workspaceVolume, '/workspace', 'mv', [destination, previous]);
    try {
      await this.runVolumeHelper(runtime.workspaceVolume, '/workspace', 'mv', [next, destination]);
      await this.runVolumeHelper(runtime.workspaceVolume, '/workspace', 'rm', ['-rf', previous]);
    } catch (error) {
      await this.runVolumeHelper(runtime.workspaceVolume, '/workspace', 'rm', ['-rf', destination]).catch(() => undefined);
      await this.runVolumeHelper(runtime.workspaceVolume, '/workspace', 'mv', [previous, destination]).catch(() => undefined);
      throw error;
    }
  }

  async adoptRepositoryMigrationInTask(
    runtime: DockerTaskRuntime, source: string, destination: string,
  ): Promise<void> {
    if (!/^\/workspace\/(?:repositories|projects)\/[A-Za-z0-9._-]+$/.test(destination)
      || !/^\/workspace\/(?:repositories|projects)\/[A-Za-z0-9._-]+\.migration-[A-Za-z0-9_-]{1,80}$/.test(source)
      || !source.startsWith(`${destination}.migration-`)) {
      throw new Error('Unsafe task repository migration path.');
    }
    const previous = `${destination}.migration-previous`;
    await this.runVolumeHelper(runtime.workspaceVolume, '/workspace', 'sh', [
      '-ceu',
      'source=$1; destination=$2; previous=$3; test -d "$source"; test ! -L "$source"; test -d "$destination"; test ! -L "$destination"; rm -rf -- "$previous"; mv -- "$destination" "$previous"; if mv -- "$source" "$destination"; then rm -rf -- "$previous"; else mv -- "$previous" "$destination"; exit 1; fi',
      'repository-migration-adopt', source, destination, previous,
    ]);
  }

  async discardRepositoryMigrationInTask(runtime: DockerTaskRuntime, path: string): Promise<void> {
    if (!/^\/workspace\/(?:repositories|projects)\/[A-Za-z0-9._-]+\.migration-[A-Za-z0-9_-]{1,80}$/.test(path)) {
      throw new Error('Unsafe task repository migration path.');
    }
    await this.runVolumeHelper(runtime.workspaceVolume, '/workspace', 'rm', ['-rf', '--', path]);
  }

  async installMemoryProjection(runtime: DockerTaskRuntime, source: string, projectionId: string): Promise<void> {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(projectionId)) throw new Error('Unsafe memory projection id.');
    const root = '/workspace/.linkbot';
    const name = `memory-${projectionId}`;
    const destination = `${root}/${name}`;
    await this.runVolumeHelper(runtime.workspaceVolume, '/workspace', 'mkdir', ['-p', destination]);
    await this.runner.run(['cp', `${source}/.`, `${runtime.containerName}:${destination}`]);
    await this.runVolumeHelper(runtime.workspaceVolume, '/workspace', 'chown', ['-R', '10001:10001', destination]);
    await this.runVolumeHelper(runtime.workspaceVolume, '/workspace', 'ln', ['-sfn', name, `${root}/memory.next`]);
    await this.runVolumeHelper(runtime.workspaceVolume, '/workspace', 'mv', ['-Tf', `${root}/memory.next`, `${root}/memory`]);
  }

  async runWorkspaceGit(runtime: DockerTaskRuntime, args: string[]): Promise<void> {
    await this.runner.run([
      'run', '--rm', '--network', 'none', '--user', '10001:10001',
      '--mount', `type=volume,src=${runtime.workspaceVolume},dst=/workspace`,
      '--entrypoint', 'git', this.config.image, '-C', '/workspace', ...args,
    ]);
  }

  async runRepositoryGit(runtime: DockerTaskRuntime, repositoryPath: string, args: string[]): Promise<void> {
    if (repositoryPath !== '/workspace'
      && !/^\/workspace\/(?:repositories|projects)\/[A-Za-z0-9._-]+$/.test(repositoryPath)) {
      throw new Error('Unsafe task repository path.');
    }
    await this.runner.run([
      'run', '--rm', '--network', 'none', '--user', '10001:10001',
      '--mount', `type=volume,src=${runtime.workspaceVolume},dst=/workspace`,
      '--entrypoint', 'git', this.config.image, '-C', repositoryPath, ...args,
    ]);
  }

  async runRepositoryMigrationGit(
    runtime: DockerTaskRuntime, repositoryPath: string, args: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (!/^\/workspace\/(?:repositories|projects)\/[A-Za-z0-9._-]+\.migration-[A-Za-z0-9_-]{1,80}$/.test(repositoryPath)) {
      throw new Error('Unsafe task repository migration path.');
    }
    const result = await this.runner.run([
      'run', '--rm', '--network', 'none', '--user', '10001:10001',
      '--mount', `type=volume,src=${runtime.workspaceVolume},dst=/workspace`,
      '--entrypoint', 'git', this.config.image, '-C', repositoryPath, ...args,
    ], { allowFailure: true });
    return { ...result, exitCode: result.exitCode ?? 0 };
  }

  async revokeNativeGitCredential(runtime: DockerTaskRuntime): Promise<void> {
    const mounts = [
      '--mount', `type=volume,src=${runtime.codexHomeVolume},dst=/home/codex/.codex`,
      ...(runtime.userCacheVolume ? ['--mount', `type=volume,src=${runtime.userCacheVolume},dst=/home/codex/.cache`] : []),
    ];
    await this.runner.run([
      'run', '--rm', '--network', this.config.network, '--user', '10001:10001',
      ...mounts, '--entrypoint', 'sh', this.config.image, '-ceu', String.raw`
rm -rf "$CODEX_HOME/native-git"
`,
    ]);
  }

  describe(taskId: string): DockerTaskRuntime {
    return runtimeNames(taskId, this.config.socketRoot);
  }

  async listManagedTaskResources(signal?: AbortSignal): Promise<DockerManagedTaskResources[]> {
    const listed = await this.runner.run(['volume', 'ls', '--format', '{{.Name}}'], { signal });
    const names = listed.stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
    const candidates = names.filter((name) => MANAGED_TASK_VOLUME.test(name));
    const inspected: Array<{ Name?: string; CreatedAt?: string }> = [];
    for (let offset = 0; offset < candidates.length; offset += 100) {
      const batch = candidates.slice(offset, offset + 100);
      const result = await this.runner.run(['volume', 'inspect', '--format', '{{json .}}', ...batch], { signal });
      for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
        try {
          inspected.push(JSON.parse(line) as { Name?: string; CreatedAt?: string });
        } catch (error) {
          throw new Error(`Docker returned invalid managed-volume metadata: ${safeError(error)}`);
        }
      }
    }
    const grouped = new Map<string, DockerManagedTaskResources>();
    for (const volume of inspected) {
      const match = volume.Name?.match(MANAGED_TASK_VOLUME);
      if (!match) continue;
      const [, runtimeId, kind] = match;
      const current = grouped.get(runtimeId!) ?? { runtimeId: runtimeId! };
      if (kind === 'workspace') current.workspaceVolume = volume.Name;
      if (kind === 'codex-home') current.codexHomeVolume = volume.Name;
      if (volume.CreatedAt && (!current.createdAt || Date.parse(volume.CreatedAt) < Date.parse(current.createdAt))) {
        current.createdAt = volume.CreatedAt;
      }
      grouped.set(runtimeId!, current);
    }
    return [...grouped.values()].sort((left, right) => left.runtimeId.localeCompare(right.runtimeId));
  }

  async measureManagedTaskBytes(resources: DockerManagedTaskResources, signal?: AbortSignal): Promise<number> {
    return (await this.measureManagedTaskVolumeBytes(resources, signal)).totalBytes;
  }

  async measureManagedTaskVolumeBytes(
    resources: DockerManagedTaskResources,
    signal?: AbortSignal,
  ): Promise<DockerManagedTaskVolumeBytes> {
    const volumeBytes = { workspaceBytes: 0, codexHomeBytes: 0 };
    for (const [kind, volume] of [
      ['workspaceBytes', resources.workspaceVolume],
      ['codexHomeBytes', resources.codexHomeVolume],
    ] as const) {
      if (!volume) continue;
      const result = await this.runner.run([
        'run', '--rm', '--network', 'none', '--user', '0:0',
        '--mount', `type=volume,src=${volume},dst=/data,readonly`,
        '--entrypoint', 'du', this.config.image, '-sb', '/data',
      ], { signal });
      const bytes = Number.parseInt(result.stdout.trim().split(/\s+/)[0] ?? '', 10);
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        throw new Error(`Docker did not report a valid byte size for ${volume}.`);
      }
      volumeBytes[kind] += bytes;
    }
    return { ...volumeBytes, totalBytes: volumeBytes.workspaceBytes + volumeBytes.codexHomeBytes };
  }

  async dataRoot(): Promise<string> {
    const result = await this.runner.run(['info', '--format', '{{.DockerRootDir}}']);
    const dataRoot = result.stdout.trim();
    if (!dataRoot) throw new Error('Docker did not report its data-root.');
    return dataRoot;
  }

  async observe(runtime: DockerTaskRuntime): Promise<'running' | 'stopped' | 'missing'> {
    try {
      const result = await this.runner.run(['inspect', '--format', '{{.State.Running}}', runtime.containerName]);
      return result.stdout.trim() === 'true' ? 'running' : 'stopped';
    } catch {
      return 'missing';
    }
  }

  /** Cleanup must fail closed when Docker inspection itself is unhealthy. */
  async observeForCleanup(runtime: DockerTaskRuntime): Promise<'running' | 'stopped' | 'missing'> {
    try {
      const result = await this.runner.run(['inspect', '--format', '{{.State.Running}}', runtime.containerName]);
      return result.stdout.trim() === 'true' ? 'running' : 'stopped';
    } catch (error) {
      if (isDockerNotFound(error)) return 'missing';
      throw new Error(`Failed to verify task container before cleanup: ${safeError(error)}`);
    }
  }

  async memoryUsageBytes(runtime: DockerTaskRuntime): Promise<number> {
    const result = await this.runner.run(['stats', '--no-stream', '--format', '{{.MemUsage}}', runtime.containerName]);
    const usage = result.stdout.split('/')[0]?.trim();
    if (!usage) throw new Error(`Docker did not report memory usage for ${runtime.containerName}.`);
    return parseDockerBytes(usage);
  }

  async removeContainer(runtime: DockerTaskRuntime): Promise<void> {
    await this.runner.run(['rm', runtime.containerName]);
  }

  async removeTask(runtime: DockerTaskRuntime): Promise<void> {
    const failures: Error[] = [];
    await this.removeExactResource(['rm', '--force', runtime.containerName], 'container', failures);
    await this.removeExactResource(['volume', 'rm', runtime.workspaceVolume], 'workspace volume', failures);
    await this.removeExactResource(['volume', 'rm', runtime.codexHomeVolume], 'Codex-home volume', failures);
    try {
      await rm(runtime.socketDirectory, { recursive: true, force: true });
    } catch (error) {
      failures.push(new Error(`Failed to remove task socket directory: ${safeError(error)}`));
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `Failed to remove all resources for task ${runtime.taskId}.`);
  }

  private async removeExactResource(args: string[], label: string, failures: Error[]): Promise<void> {
    try {
      await this.runner.run(args);
    } catch (error) {
      if (isDockerNotFound(error)) return;
      failures.push(new Error(`Failed to remove task ${label}: ${safeError(error)}`));
    }
  }

  private async createTaskVolume(
    volume: string,
    taskId: string,
    kind: 'workspace' | 'codex-home',
    ownerUserId?: string,
  ): Promise<void> {
    await this.runner.run([
      'volume', 'create',
      '--label', 'link-bot.managed=true',
      '--label', `link-bot.task-id=${taskId}`,
      '--label', `link-bot.runtime-id=${taskId}`,
      ...(ownerUserId ? ['--label', `link-bot.owner-user-id=${ownerUserId}`] : []),
      '--label', `link-bot.kind=${kind}`,
      volume,
    ]);
  }

  private async runVolumeHelper(volume: string, mountPath: string, entrypoint: string, args: string[]): Promise<void> {
    await this.runner.run([
      'run', '--rm', '--network', 'none', '--user', '0:0',
      '--mount', `type=volume,src=${volume},dst=${mountPath}`,
      '--entrypoint', entrypoint, this.config.image, ...args,
    ]);
  }

  private async prepareUserVolume(volume: string): Promise<void> {
    await this.runVolumeHelper(volume, '/tool-state', 'chown', ['10001:10001', '/tool-state']);
  }

}

export class ExecDockerCommandRunner implements DockerCommandRunner {
  run(args: string[], options: { signal?: AbortSignal; timeoutMs?: number; allowFailure?: boolean } = {}): Promise<{
    stdout: string; stderr: string; exitCode: number;
  }> {
    return new Promise((resolve, reject) => {
      execFile('docker', args, {
        maxBuffer: 1_048_576, signal: options.signal, timeout: options.timeoutMs ?? 120_000, killSignal: 'SIGKILL',
      }, (error, stdout, stderr) => {
        if (error && options.allowFailure && typeof error.code === 'number') {
          return resolve({ stdout, stderr, exitCode: error.code });
        }
        if (error) {
          const diagnostic = stderr.trim() || stdout.trim() || error.message;
          return reject(new Error(
            `Docker command ${error.killed ? 'timed out' : 'failed'}: ${args[0]}: ${diagnostic.slice(-4_000)}`,
          ));
        }
        resolve({ stdout, stderr, exitCode: 0 });
      });
    });
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function isDockerNotFound(error: unknown): boolean {
  return /(?:no such|not found).*(?:container|volume|object)|(?:container|volume|object).*(?:no such|not found)/i.test(safeError(error));
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function runtimeNames(taskId: string, socketRoot: string, userId?: string): DockerTaskRuntime {
  const safeId = safeRuntimeId(taskId);
  const containerName = `link-bot-${safeId}`;
  const socketDirectory = join(socketRoot, safeId);
  const userKey = userId ? createHash('sha256').update(userId).digest('hex').slice(0, 24) : undefined;
  return {
    taskId,
    containerName,
    workspaceVolume: `${containerName}-workspace`,
    codexHomeVolume: `${containerName}-codex-home`,
    socketDirectory,
    socketPath: join(socketDirectory, 'app.sock'),
    ...(userKey ? {
      userCacheVolume: `link-bot-user-${userKey}-cache`,
    } : {}),
  };
}

function safeRuntimeId(taskId: string): string {
  const safeId = taskId.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 80);
  if (!safeId) throw new Error('Task id has no Docker-safe characters.');
  return safeId;
}

function assertLegacyAttachmentPath(path: string): void {
  if (!/^\/workspace\/\.linkbot\/inbox\/turn_[A-Za-z0-9_.-]{1,120}\/[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(path)) {
    throw new Error('Unsafe legacy task attachment path.');
  }
}

function assertLegacyArtifactPath(path: string): void {
  if (!/^\/workspace\/\.linkbot\/(?:outbox|artifacts)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,1000}$/.test(path) || path.includes('/../')) {
    throw new Error('Unsafe legacy task artifact path.');
  }
}

const MANAGED_TASK_VOLUME = /^link-bot-(task_[A-Za-z0-9_.-]+)-(workspace|codex-home)$/;

function parseDockerBytes(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(B|KiB|MiB|GiB|TiB|kB|MB|GB|TB)$/i.exec(value);
  if (!match) throw new Error(`Unsupported Docker memory value: ${value}`);
  const units: Record<string, number> = {
    b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
    kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4,
  };
  return Math.round(Number(match[1]) * units[match[2]!.toLowerCase()]!);
}
