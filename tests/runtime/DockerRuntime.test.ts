import { execFile } from 'node:child_process';
import { mkdir,readFile,rm,stat,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe,expect,it,vi } from 'vitest';
import { GitIdentityResolver } from '../../src/git/GitIdentityResolver.js';
import { DockerReadySlotRuntime } from '../../src/runtime/DockerReadySlotRuntime.js';
import {
DockerRuntime,GIT_REPOSITORY_SNAPSHOT_SCRIPT,MAX_REPOSITORY_EXPORT_BYTES,type DockerCommandRunner,
} from '../../src/runtime/DockerRuntime.js';
import { DockerTaskProvisioner,ExecManagerGitRunner } from '../../src/runtime/DockerTaskProvisioner.js';
import { ReadyPoolController } from '../../src/runtime/ReadyPoolController.js';
import { TaskCredentialManager } from '../../src/runtime/TaskCredentialManager.js';
import { SqliteStateStore } from '../../src/state/SqliteStateStore.js';
import { createTmpDir } from '../helpers/tmp.js';

const testGitIdentities = new GitIdentityResolver({
  ou_owner: { name: 'Owner Name', email: 'owner@example.com' },
});

describe('DockerRuntime', () => {
  it('adopts only a matching same-volume repository migration path', async () => {
    const runner: DockerCommandRunner = { run: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })) };
    const docker = new DockerRuntime(config('/tmp/link-bot-test-sockets'), runner);
    const runtime = docker.describe('task_migration');

    await docker.adoptRepositoryMigrationInTask(
      runtime, '/workspace/projects/repo.migration-abc123', '/workspace/projects/repo',
    );
    expect(runner.run).toHaveBeenCalledWith(expect.arrayContaining([
      '--entrypoint', 'sh', expect.any(String), 'repository-migration-adopt',
      '/workspace/projects/repo.migration-abc123', '/workspace/projects/repo',
    ]));
    await expect(docker.adoptRepositoryMigrationInTask(
      runtime, '/workspace/projects/other.migration-abc123', '/workspace/projects/repo',
    )).rejects.toThrow('Unsafe task repository migration path');
  });

  it('preserves the exact HEAD commit when a Git snapshot has no changes', async () => {
    const root = await createTmpDir();
    const repository = join(root, 'repository');
    const snapshot = join(repository, '.linkbot', 'exports', 'snapshot');
    await mkdir(repository);
    const run = promisify(execFile);
    await run('git', ['init', repository]);
    await run('git', ['-C', repository, 'config', 'user.name', 'Test']);
    await run('git', ['-C', repository, 'config', 'user.email', 'test@example.com']);
    await writeFile(join(repository, 'tracked.txt'), 'original\n');
    await run('git', ['-C', repository, 'add', '.']);
    await run('git', ['-C', repository, 'commit', '-m', 'initial']);
    const head = (await run('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();

    await run('sh', ['-ceu', GIT_REPOSITORY_SNAPSHOT_SCRIPT, '--', repository, snapshot, 'clean_snapshot']);

    await expect(run('git', ['-C', snapshot, 'rev-parse', 'HEAD']))
      .resolves.toMatchObject({ stdout: `${head}\n` });
  });

  it('uses the internal Git binary instead of an authentication policy wrapper for local exports', async () => {
    const root = await createTmpDir();
    const repository = join(root, 'repository');
    const snapshot = join(repository, '.linkbot', 'exports', 'snapshot');
    const wrapperDirectory = join(root, 'bin');
    await mkdir(repository);
    await mkdir(wrapperDirectory);
    const run = promisify(execFile);
    await run('/usr/bin/git', ['init', repository]);
    await run('/usr/bin/git', ['-C', repository, 'config', 'user.name', 'Test']);
    await run('/usr/bin/git', ['-C', repository, 'config', 'user.email', 'test@example.com']);
    await writeFile(join(repository, 'tracked.txt'), 'original\n');
    await run('/usr/bin/git', ['-C', repository, 'add', '.']);
    await run('/usr/bin/git', ['-C', repository, 'commit', '-m', 'initial']);
    await writeFile(join(wrapperDirectory, 'git'), '#!/bin/sh\necho AUTH_REQUIRED >&2\nexit 86\n', { mode: 0o755 });

    await run('sh', ['-ceu', GIT_REPOSITORY_SNAPSHOT_SCRIPT, '--', repository, snapshot, 'wrapper_snapshot'], {
      env: { ...process.env, PATH: `${wrapperDirectory}:${process.env.PATH ?? ''}` },
    });

    await expect(readFile(join(snapshot, 'tracked.txt'), 'utf8')).resolves.toBe('original\n');
  });

  it('builds a Git snapshot with dirty and non-ignored files but without ignored caches', async () => {
    const root = await createTmpDir();
    const repository = join(root, 'repository');
    // Primary projectless repositories can live at /workspace, so the export
    // staging directory is intentionally nested under the source repository.
    const snapshot = join(repository, '.linkbot', 'exports', 'snapshot');
    await mkdir(repository);
    const run = promisify(execFile);
    await run('git', ['init', repository]);
    await run('git', ['-C', repository, 'config', 'user.name', 'Test']);
    await run('git', ['-C', repository, 'config', 'user.email', 'test@example.com']);
    await writeFile(join(repository, '.gitignore'), '.eden-mono/\n');
    await writeFile(join(repository, 'tracked.txt'), 'original\n');
    await run('git', ['-C', repository, 'add', '.']);
    await run('git', ['-C', repository, 'commit', '-m', 'initial']);
    const originalHead = (await run('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(join(repository, 'tracked.txt'), 'changed\n');
    await writeFile(join(repository, 'untracked.txt'), 'new\n');
    await mkdir(join(repository, '.eden-mono'));
    await writeFile(join(repository, '.eden-mono', 'cache.bin'), 'cache\n');
    const statusBefore = (await run('git', ['-C', repository, 'status', '--short'])).stdout;

    await run('sh', ['-ceu', GIT_REPOSITORY_SNAPSHOT_SCRIPT, '--', repository, snapshot, 'test_snapshot']);

    await expect(readFile(join(snapshot, 'tracked.txt'), 'utf8')).resolves.toBe('changed\n');
    await expect(readFile(join(snapshot, 'untracked.txt'), 'utf8')).resolves.toBe('new\n');
    await expect(run('git', ['-C', snapshot, 'config', '--get', 'linkbot.export.originalHead']))
      .resolves.toMatchObject({ stdout: `${originalHead}\n` });
    await expect(stat(join(snapshot, '.eden-mono'))).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(join(repository, '.linkbot'), { recursive: true, force: true });
    await expect(run('git', ['-C', repository, 'status', '--short'])).resolves.toMatchObject({ stdout: statusBefore });
    await expect(run('git', ['-C', repository, 'show-ref', 'refs/link-bot/exports/test_snapshot']))
      .rejects.toBeDefined();
  });

  it('ignores Manager review metadata without changing the exported HEAD', async () => {
    const root = await createTmpDir();
    const repository = join(root, 'repository');
    const snapshot = join(repository, '.linkbot', 'exports', 'snapshot');
    await mkdir(repository);
    const run = promisify(execFile);
    await run('git', ['init', repository]);
    await run('git', ['-C', repository, 'config', 'user.name', 'Test']);
    await run('git', ['-C', repository, 'config', 'user.email', 'test@example.com']);
    await writeFile(join(repository, 'tracked.txt'), 'original\n');
    await run('git', ['-C', repository, 'add', '.']);
    await run('git', ['-C', repository, 'commit', '-m', 'initial']);
    const head = (await run('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(join(repository, '.linkbot-review.json'), '{}\n');
    await writeFile(join(repository, '.git', 'info', 'exclude'), '.linkbot-review.json\n', { flag: 'a' });

    await run('sh', ['-ceu', GIT_REPOSITORY_SNAPSHOT_SCRIPT, '--', repository, snapshot, 'review_snapshot', 'require-clean']);

    await expect(run('git', ['-C', snapshot, 'rev-parse', 'HEAD']))
      .resolves.toMatchObject({ stdout: `${head}\n` });
    await expect(stat(join(snapshot, '.linkbot-review.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects uncommitted business changes in strict snapshots', async () => {
    const root = await createTmpDir();
    const repository = join(root, 'repository');
    const snapshot = join(repository, '.linkbot', 'exports', 'snapshot');
    await mkdir(repository);
    const run = promisify(execFile);
    await run('git', ['init', repository]);
    await run('git', ['-C', repository, 'config', 'user.name', 'Test']);
    await run('git', ['-C', repository, 'config', 'user.email', 'test@example.com']);
    await writeFile(join(repository, 'tracked.txt'), 'original\n');
    await run('git', ['-C', repository, 'add', '.']);
    await run('git', ['-C', repository, 'commit', '-m', 'initial']);
    await writeFile(join(repository, 'tracked.txt'), 'changed\n');

    await expect(run('sh', [
      '-ceu', GIT_REPOSITORY_SNAPSHOT_SCRIPT, '--', repository, snapshot, 'dirty_snapshot', 'require-clean',
    ])).rejects.toMatchObject({ stderr: expect.stringContaining('REPOSITORY_EXPORT_DIRTY') });
  });

  it('preflights Git snapshot size and always cleans temporary export data', async () => {
    const runner = new RecordingDockerRunner();
    runner.duOutputs = [`${MAX_REPOSITORY_EXPORT_BYTES + 1}\n`];
    const docker = new DockerRuntime(config(await createTmpDir()), runner);

    await expect(docker.copyGitRepositorySnapshotFromTask(
      docker.describe('task_export'), '/workspace/projects/repo', '/manager/export',
    )).rejects.toThrow('REPOSITORY_EXPORT_TOO_LARGE');

    expect(runner.calls.some((args) => args[0] === 'cp')).toBe(false);
    expect(runner.calls.at(-1)).toEqual(expect.arrayContaining(['-ceu', 'rm -rf "$1"']));
  });

  it('provisions isolated volumes and a hardened container without sensitive host mounts', async () => {
    const root = await createTmpDir();
    const runner = new RecordingDockerRunner();
    const runtime = new DockerRuntime(config(root), runner);
    const first = await runtime.provision('task_1');
    const second = await runtime.provision('task_2');
    const creates = runner.calls.filter((args) => args[0] === 'create');

    expect(first.workspaceVolume).not.toBe(second.workspaceVolume);
    expect(first.codexHomeVolume).not.toBe(second.codexHomeVolume);
    expect(first.socketDirectory).not.toBe(second.socketDirectory);
    expect(creates).toHaveLength(2);
    for (const args of creates) {
      expect(args).toEqual(expect.arrayContaining([
        '--user', '10001:10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
        '--security-opt', 'seccomp=unconfined', '--security-opt', 'systempaths=unconfined',
        '--pids-limit', '128', '--network', 'link-bot-egress',
      ]));
      const command = args.join(' ');
      expect(args).not.toContain('--read-only');
      expect(command).not.toMatch(/docker\.sock|\.ssh|SSH_AUTH_SOCK|state\.sqlite|\/Users\//);
    }
    expect(runner.calls).toContainEqual([
      'volume', 'create', '--label', 'link-bot.managed=true', '--label', 'link-bot.task-id=task_1',
      '--label', 'link-bot.runtime-id=task_1',
      '--label', 'link-bot.kind=workspace', 'link-bot-task_1-workspace',
    ]);
  });

  it('passes explicitly configured runtime proxy variables to the task container', async () => {
    const runner = new RecordingDockerRunner();
    const docker = new DockerRuntime({
      ...config(await createTmpDir()),
      environment: { HTTPS_PROXY: 'http://proxy.internal:8080', NO_PROXY: 'localhost' },
    }, runner);
    await docker.provision('task_proxy');
    const create = runner.calls.find((args) => args[0] === 'create')!;
    expect(create).toEqual(expect.arrayContaining([
      '--env', 'HTTPS_PROXY=http://proxy.internal:8080', '--env', 'NO_PROXY=localhost',
    ]));
  });

  it('stops and resumes without deleting task volumes', async () => {
    const root = await createTmpDir();
    const runner = new RecordingDockerRunner();
    const docker = new DockerRuntime(config(root), runner);
    const runtime = await docker.provision('task_1');

    await docker.start(runtime);
    await docker.stop(runtime);
    await docker.start(runtime);

    expect(runner.calls.filter((args) => args[0] === 'start')).toHaveLength(2);
    expect(runner.calls.some((args) => args[0] === 'volume' && args[1] === 'rm')).toBe(false);
    expect(runner.calls.some((args) => args[0] === 'rm')).toBe(false);
  });

  it('removes only the named task container, volumes, and socket directory on explicit deletion', async () => {
    const root = await createTmpDir();
    const runner = new RecordingDockerRunner();
    const docker = new DockerRuntime(config(root), runner);
    const runtime = await docker.provision('task_1');

    await docker.removeTask(runtime);

    expect(runner.calls).toContainEqual(['rm', '--force', 'link-bot-task_1']);
    expect(runner.calls).toContainEqual(['volume', 'rm', 'link-bot-task_1-workspace']);
    expect(runner.calls).toContainEqual(['volume', 'rm', 'link-bot-task_1-codex-home']);
    await expect(stat(runtime.socketDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes remaining exact resources when the container or one volume is already missing', async () => {
    const root = await createTmpDir();
    const runner = new RecordingDockerRunner();
    const docker = new DockerRuntime(config(root), runner);
    const runtime = await docker.provision('task_missing_parts');
    runner.failures.set(`rm --force ${runtime.containerName}`, 'No such container');
    runner.failures.set(`volume rm ${runtime.codexHomeVolume}`, 'No such volume');

    await expect(docker.removeTask(runtime)).resolves.toBeUndefined();
    expect(runner.calls).toContainEqual(['volume', 'rm', runtime.workspaceVolume]);
    expect(runner.calls).toContainEqual(['volume', 'rm', runtime.codexHomeVolume]);
    await expect(stat(runtime.socketDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('distinguishes a missing cleanup container from an unhealthy Docker inspection', async () => {
    const root = await createTmpDir();
    const runner = new RecordingDockerRunner();
    const docker = new DockerRuntime(config(root), runner);
    const runtime = docker.describe('task_cleanup_observe');
    const inspect = `inspect --format {{.State.Running}} ${runtime.containerName}`;
    runner.failures.set(inspect, 'No such container');

    await expect(docker.observeForCleanup(runtime)).resolves.toBe('missing');

    runner.failures.set(inspect, 'Docker daemon unavailable');
    await expect(docker.observeForCleanup(runtime)).rejects.toThrow(
      'Failed to verify task container before cleanup',
    );
  });

  it('accepts the Docker daemon no-such-object wording during cleanup inspection', async () => {
    const root = await createTmpDir();
    const runner = new RecordingDockerRunner();
    const docker = new DockerRuntime(config(root), runner);
    const runtime = docker.describe('task_cleanup_missing_object');
    runner.failures.set(
      `inspect --format {{.State.Running}} ${runtime.containerName}`,
      `Error: No such object: ${runtime.containerName}`,
    );

    await expect(docker.observeForCleanup(runtime)).resolves.toBe('missing');
  });

  it('attempts every exact resource and surfaces non-not-found deletion failures', async () => {
    const root = await createTmpDir();
    const runner = new RecordingDockerRunner();
    const docker = new DockerRuntime(config(root), runner);
    const runtime = await docker.provision('task_busy');
    runner.failures.set(`rm --force ${runtime.containerName}`, 'daemon unavailable');
    runner.failures.set(`volume rm ${runtime.workspaceVolume}`, 'volume is in use');

    await expect(docker.removeTask(runtime)).rejects.toThrow('Failed to remove all resources');
    expect(runner.calls).toContainEqual(['volume', 'rm', runtime.workspaceVolume]);
    expect(runner.calls).toContainEqual(['volume', 'rm', runtime.codexHomeVolume]);
    await expect(stat(runtime.socketDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('inventories legacy deterministic task volumes and measures both exact volumes read-only', async () => {
    const runner = new RecordingDockerRunner();
    runner.volumeListOutput = [
      'link-bot-task_2-workspace', 'unrelated-volume', 'link-bot-task_1-codex-home', 'link-bot-task_1-workspace',
    ].join('\n');
    runner.volumeInspectOutput = [
      JSON.stringify({ Name: 'link-bot-task_2-workspace', CreatedAt: '2026-08-02T00:00:00+08:00' }),
      JSON.stringify({ Name: 'link-bot-task_1-codex-home', CreatedAt: '2026-08-01T01:00:00+08:00' }),
      JSON.stringify({ Name: 'link-bot-task_1-workspace', CreatedAt: '2026-08-01T00:00:00+08:00' }),
    ].join('\n');
    runner.duOutputs = ['11\t/data', '29\t/data'];
    const docker = new DockerRuntime(config(await createTmpDir()), runner);

    const resources = await docker.listManagedTaskResources();
    expect(resources).toEqual([
      {
        runtimeId: 'task_1', workspaceVolume: 'link-bot-task_1-workspace',
        codexHomeVolume: 'link-bot-task_1-codex-home', createdAt: '2026-08-01T00:00:00+08:00',
      },
      { runtimeId: 'task_2', workspaceVolume: 'link-bot-task_2-workspace', createdAt: '2026-08-02T00:00:00+08:00' },
    ]);
    await expect(docker.measureManagedTaskVolumeBytes(resources[0]!)).resolves.toEqual({
      workspaceBytes: 11, codexHomeBytes: 29, totalBytes: 40,
    });
    expect(runner.calls.filter((args) => args[0] === 'run')).toEqual([
      expect.arrayContaining(['--network', 'none', '--mount', 'type=volume,src=link-bot-task_1-workspace,dst=/data,readonly']),
      expect.arrayContaining(['--network', 'none', '--mount', 'type=volume,src=link-bot-task_1-codex-home,dst=/data,readonly']),
    ]);
  });

  it('reports the configured Docker daemon data-root', async () => {
    const runner = new RecordingDockerRunner();
    runner.dataRootOutput = '/data00/docker\n';
    const docker = new DockerRuntime(config(await createTmpDir()), runner);

    await expect(docker.dataRoot()).resolves.toBe('/data00/docker');
    expect(runner.calls).toContainEqual(['info', '--format', '{{.DockerRootDir}}']);
  });

  it('reclaims a stale socket directory when the deterministic task container is missing', async () => {
    const root = await createTmpDir();
    await import('node:fs/promises').then(({ mkdir }) => mkdir(join(root, 'task_retry'), { recursive: true }));
    const runner = new RecordingDockerRunner();
    runner.failInspect = true;
    const docker = new DockerRuntime(config(root), runner);

    await expect(docker.provision('task_retry')).resolves.toMatchObject({ taskId: 'task_retry' });
    expect(runner.calls).toContainEqual(['inspect', '--format', '{{.State.Running}}', 'link-bot-task_retry']);
    await expect(stat(join(root, 'task_retry'))).resolves.toBeDefined();
  });

  it('recreates a missing task container without deleting its persistent volumes', async () => {
    const root = await createTmpDir();
    const runner = new RecordingDockerRunner();
    runner.failInspect = true;
    const docker = new DockerRuntime(config(root), runner);

    const runtime = await docker.recreateMissingContainer('task_restore', 'ou_owner');

    expect(runner.calls.filter((args) => args[0] === 'create')).toHaveLength(1);
    expect(runner.calls.some((args) => args[0] === 'volume' && args[1] === 'rm')).toBe(false);
    expect(runner.calls.find((args) => args[0] === 'create')).toEqual(expect.arrayContaining([
      '--mount', `type=volume,src=${runtime.workspaceVolume},dst=/workspace`,
      '--mount', `type=volume,src=${runtime.codexHomeVolume},dst=/home/codex/.codex`,
    ]));
  });

  it('checks Docker, the configured image, and its pinned Codex CLI version', async () => {
    const runner = new RecordingDockerRunner();
    runner.versionOutput = 'codex-cli 0.145.0';
    const docker = new DockerRuntime({ ...config(await createTmpDir()), codexCliVersion: '0.145.0' }, runner);
    await expect(docker.healthCheck()).resolves.toEqual({ ok: true });
    expect(runner.calls).toContainEqual(['run', '--rm', '--entrypoint', 'codex', 'link-bot-runtime:0.1', '--version']);

    runner.versionOutput = 'codex-cli 0.146.0';
    await expect(docker.healthCheck()).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('does not match') });
  });

  it('samples container memory in bytes for idle RSS accounting', async () => {
    const runner = new RecordingDockerRunner();
    runner.memoryOutput = '12.5MiB / 2GiB';
    const docker = new DockerRuntime(config(await createTmpDir()), runner);

    await expect(docker.memoryUsageBytes(docker.describe('task_1'))).resolves.toBe(13_107_200);
    expect(runner.calls).toContainEqual([
      'stats', '--no-stream', '--format', '{{.MemUsage}}', 'link-bot-task_1',
    ]);
  });

  it('installs a versioned memory projection through an atomic symlink swap', async () => {
    const runner = new RecordingDockerRunner();
    const docker = new DockerRuntime(config(await createTmpDir()), runner);
    const runtime = docker.describe('task_1');

    await docker.installMemoryProjection(runtime, '/manager/projection', 'version_1');

    expect(runner.calls).toContainEqual(['cp', '/manager/projection/.', 'link-bot-task_1:/workspace/.linkbot/memory-version_1']);
    expect(runner.calls).toContainEqual(expect.arrayContaining([
      '--entrypoint', 'ln', 'link-bot-runtime:0.1', '-sfn', 'memory-version_1', '/workspace/.linkbot/memory.next',
    ]));
    expect(runner.calls).toContainEqual(expect.arrayContaining([
      '--entrypoint', 'mv', 'link-bot-runtime:0.1', '-Tf', '/workspace/.linkbot/memory.next', '/workspace/.linkbot/memory',
    ]));
    expect(runner.calls.filter((args) => args[0] === 'run').every((args) => args.includes('none'))).toBe(true);
    await expect(docker.installMemoryProjection(runtime, '/manager/projection', '../escape')).rejects.toThrow('Unsafe');
  });
});

describe('DockerTaskProvisioner', () => {
  it('stops a task before replacing its stale Codex authentication', async () => {
    const root = await createTmpDir();
    const authRoot = join(root, 'protected-auth');
    await mkdir(authRoot, { recursive: true });
    await writeFile(join(authRoot, 'auth.json'), '{"tokens":"fresh"}');
    const runner = new RecordingDockerRunner();
    const provisioner = new DockerTaskProvisioner(
      new DockerRuntime(config(join(root, 'sockets')), runner),
      new TaskCredentialManager(authRoot), join(root, 'staging'),
    );

    await provisioner.refreshCodexAuth(task('task_auth'));

    const stopIndex = runner.calls.findIndex((args) => args[0] === 'stop' && args.at(-1) === 'link-bot-task_auth');
    const copyIndex = runner.calls.findIndex((args) => args[0] === 'cp' && args.at(-1) === 'link-bot-task_auth:/home/codex/.codex/auth.json');
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(copyIndex).toBeGreaterThan(stopIndex);
    expect(runner.calls).toContainEqual(expect.arrayContaining(['chmod', '0600', '/home/codex/.codex/auth.json']));
  });

  it('exports repositories through a bounded Git snapshot instead of copying the whole workspace', async () => {
    const root = await createTmpDir();
    const runner = new RecordingDockerRunner();
    runner.duOutputs = ['4096\n'];
    const git = { run: vi.fn(async () => '') };
    const provisioner = new DockerTaskProvisioner(
      new DockerRuntime(config(join(root, 'sockets')), runner),
      new TaskCredentialManager(root), join(root, 'staging'), git,
    );
    const current = task('task_export');
    const repository = {
      id: 'repository_1', taskId: current.id, projectId: 'repo', checkoutPath: '/workspace/projects/repo',
      baseRef: 'develop', branchName: 'codex/task', isPrimary: false, addedBy: 'ou_owner', status: 'ready' as const,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };

    await expect(provisioner.exportRepository(current, repository))
      .resolves.toBe(join(root, 'staging', 'exports', current.id, repository.id));

    const commands = runner.calls.map((args) => args.join(' '));
    expect(commands.some((command) => command.includes('GIT_INDEX_FILE=') && command.includes('clone --no-checkout')
      && command.includes('git_bin=/usr/bin/git')))
      .toBe(true);
    expect(runner.calls).toContainEqual(expect.arrayContaining([
      'cp', expect.stringMatching(/:\/workspace\/\.linkbot\/exports\/[a-f0-9]+\/\.$/),
      join(root, 'staging', 'exports', current.id, repository.id),
    ]));
    expect(git.run).toHaveBeenCalledWith(
      join(root, 'staging', 'exports', current.id, repository.id),
      ['checkout', '-B', repository.branchName, 'HEAD'],
    );
    expect(commands.some((command) => command.includes(':/workspace/projects/repo/.'))).toBe(false);
  });

  it('copies an add-on repository into the existing task volume without copying Git credentials', async () => {
    const root = await createTmpDir();
    const authRoot = join(root, 'protected-auth');
    await mkdir(authRoot, { recursive: true });
    const runner = new RecordingDockerRunner();
    const docker = new DockerRuntime(config(join(root, 'sockets')), runner);
    const gitCalls: string[][] = [];
    const provisioner = new DockerTaskProvisioner(
      docker, new TaskCredentialManager(authRoot), join(root, 'staging'),
      { run: async (_cwd, args) => {
        gitCalls.push(args);
        if (args[0] === 'remote') return 'git@github.com:acme/repo2.git';
        if (args[0] === 'rev-parse') return 'base_sha';
        return '';
      } },
      async () => undefined,
      undefined, undefined, undefined, testGitIdentities,
    );
    const record = {
      id: 'repository_2', taskId: 'task_1', projectId: 'repo2', checkoutPath: '/workspace/repositories/repo2-abcd',
      baseRef: 'main', branchName: 'codex/ou_owner/task_1/abcd', isPrimary: false, addedBy: 'ou_owner',
      createdAt: '2026-07-28T00:00:00.000Z', updatedAt: '2026-07-28T00:00:00.000Z',
    };

    await expect(provisioner.addRepository(
      task('task_1'), { id: 'repo2', name: 'Repo 2', path: '/manager/repo2', codexArgs: [] }, record,
    )).resolves.toEqual({ baseCommit: 'base_sha' });

    expect(gitCalls).toEqual(expect.arrayContaining([
      expect.arrayContaining(['clone', '--local', '/manager/repo2']),
      ['fetch', '--no-tags', '/manager/repo2', 'base_sha'],
      ['checkout', '-b', record.branchName],
      ['remote', 'set-url', 'origin', 'link-bot-manager-only://origin'],
    ]));
    expect(runner.calls).toContainEqual(expect.arrayContaining([
      'cp', expect.stringMatching(/checkout\/\.$/), `link-bot-task_1:${record.checkoutPath}`,
    ]));
    expect(runner.calls.flat().join(' ')).not.toMatch(/auth\.json|\.ssh|SSH_AUTH_SOCK/);
  });

  it('recovers a missing add-on repository base ref with an explicit refspec fetch', async () => {
    const root = await createTmpDir();
    const runner = new RecordingDockerRunner();
    const docker = new DockerRuntime(config(join(root, 'sockets')), runner);
    let revParseAttempts = 0;
    const git = { run: vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === 'remote') return 'git@github.com:acme/repo2.git';
      if (args[0] === 'rev-parse' && ++revParseAttempts === 1) throw new Error('missing ref');
      if (args[0] === 'rev-parse') return 'develop_sha';
      return '';
    }) };
    const provisioner = new DockerTaskProvisioner(
      docker, new TaskCredentialManager(root), join(root, 'staging'), git, async () => undefined,
      undefined, undefined, undefined, testGitIdentities,
    );
    const record = {
      id: 'repository_2', taskId: 'task_1', projectId: 'repo2', checkoutPath: '/workspace/repositories/repo2-abcd',
      baseRef: 'develop', branchName: 'codex/ou_owner/task_1/abcd', isPrimary: false, addedBy: 'ou_owner',
      createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z',
    };

    await expect(provisioner.addRepository(
      task('task_1'), { id: 'repo2', name: 'Repo 2', path: '/manager/repo2', codexArgs: [] }, record,
    )).resolves.toEqual({ baseCommit: 'develop_sha' });
    expect(git.run).toHaveBeenCalledWith('/manager/repo2', [
      'fetch', '--no-tags', 'origin', '+refs/heads/develop:refs/remotes/origin/develop',
    ]);
  });

  it('selects develop by default and falls back to master when develop is absent', async () => {
    const root = await createTmpDir();
    const runner = new RecordingDockerRunner();
    const docker = new DockerRuntime(config(join(root, 'sockets')), runner);
    const git = { run: vi.fn(async () => 'abc123\trefs/heads/master\n') };
    const provisioner = new DockerTaskProvisioner(
      docker, new TaskCredentialManager(root), join(root, 'staging'), git, async () => undefined,
    );

    await expect(provisioner.resolveDefaultBaseRef({
      id: 'repo2', name: 'Repo 2', path: '/manager/repo2', codexArgs: [],
    })).resolves.toBe('master');
    expect(git.run).toHaveBeenCalledWith('/manager/repo2', ['ls-remote', '--heads', 'origin']);
  });

  it('recovers a missing remote-tracking base ref with an explicit refspec fetch', async () => {
    const root = await createTmpDir();
    const runner = new RecordingDockerRunner();
    const docker = new DockerRuntime(config(join(root, 'sockets')), runner);
    let revParseAttempts = 0;
    const git = { run: vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === 'rev-parse' && ++revParseAttempts === 1) throw new Error('missing ref');
      if (args[0] === 'rev-parse') return 'abc123';
      return '';
    }) };
    const provisioner = new DockerTaskProvisioner(
      docker, new TaskCredentialManager(root), join(root, 'staging'), git, async () => undefined,
    );

    await expect(provisioner.resolveRepositoryBaseCommit(
      { id: 'repo2', name: 'Repo 2', path: '/manager/repo2', codexArgs: [] }, 'master',
    )).resolves.toBe('abc123');
    expect(git.run).toHaveBeenCalledWith('/manager/repo2', [
      'fetch', '--no-tags', 'origin', '+refs/heads/master:refs/remotes/origin/master',
    ]);
  });

  it('preserves sanitized Git stderr so checkout failures are diagnosable', async () => {
    const root = await createTmpDir();
    const git = new ExecManagerGitRunner();

    await expect(git.run(root, ['rev-parse', 'missing-ref']))
      .rejects.toThrow(/Manager Git rev-parse failed: fatal:/);
  });

  it('reports a missing project checkout instead of misdiagnosing it as a missing Git executable', async () => {
    const root = await createTmpDir();
    const git = new ExecManagerGitRunner();

    await expect(git.run(join(root, 'missing-project'), ['fetch', '--prune', 'origin']))
      .rejects.toThrow(`Manager Git working directory is unavailable: ${join(root, 'missing-project')}`);
  });

  it('preserves raw Git stdout bytes for patch transport', async () => {
    const root = await createTmpDir();
    const git = new ExecManagerGitRunner();
    await git.run(root, ['init']);

    await expect(git.runRaw(root, ['diff', '--binary'])).resolves.toEqual(Buffer.alloc(0));
  });

  it('rejects an origin with embedded credentials before copying an add-on repository', async () => {
    const root = await createTmpDir();
    const runner = new RecordingDockerRunner();
    const docker = new DockerRuntime(config(join(root, 'sockets')), runner);
    const provisioner = new DockerTaskProvisioner(
      docker, new TaskCredentialManager(root), join(root, 'staging'),
      { run: async () => 'https://token@github.com/acme/repo.git' }, async () => undefined,
    );
    const record = {
      id: 'repository_2', taskId: 'task_1', projectId: 'repo2', checkoutPath: '/workspace/repositories/repo2-abcd',
      baseRef: 'main', branchName: 'codex/ou_owner/task_1/abcd', isPrimary: false, addedBy: 'ou_owner',
      createdAt: '2026-07-28T00:00:00.000Z', updatedAt: '2026-07-28T00:00:00.000Z',
    };

    await expect(provisioner.addRepository(
      task('task_1'), { id: 'repo2', name: 'Repo 2', path: '/manager/repo2', codexArgs: [] }, record,
    )).rejects.toThrow('embedded credentials');
    expect(runner.calls.some((args) => args[0] === 'cp')).toBe(false);
  });

  it('creates a manager-owned clone, controlled identity, isolated runtime, and resumable deterministic mapping', async () => {
    const root = await createTmpDir();
    const authRoot = join(root, 'protected-auth');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(authRoot, { recursive: true }));
    await writeFile(join(authRoot, 'auth.json'), '{"auth":"private"}');
    const runner = new RecordingDockerRunner();
    const docker = new DockerRuntime(config(join(root, 'sockets')), runner);
    const gitCalls: Array<{ cwd: string; args: string[] }> = [];
    const provisioner = new DockerTaskProvisioner(
      docker,
      new TaskCredentialManager(authRoot),
      join(root, 'staging'),
      { run: async (cwd, args) => {
        gitCalls.push({ cwd, args });
        if (args[0] === 'remote') return 'git@github.com:acme/repo.git';
        if (args[0] === 'rev-parse') return 'base_sha';
        return '';
      } },
      async () => undefined,
      undefined, undefined, undefined, testGitIdentities,
    );

    const provisioned = await provisioner.provision({
      taskId: 'task_1', ownerUserId: 'ou_owner',
      project: { id: 'repo', name: 'Repo', path: '/manager/repo', codexArgs: [] },
    });
    expect(provisioned).toEqual({
      cwd: '/workspace', branchName: 'codex/ou_owner/task_1', codexHome: '/home/codex/.codex',
      runtimeId: 'task_1', startupType: 'cold',
    });
    expect(gitCalls.map((call) => call.args)).toEqual(expect.arrayContaining([
      expect.arrayContaining(['clone', '--local', '/manager/repo']),
      ['checkout', '-b', 'codex/ou_owner/task_1'],
      ['remote', 'set-url', 'origin', 'link-bot-manager-only://origin'],
      ['config', 'user.name', 'Owner Name'],
      ['config', 'user.email', 'owner@example.com'],
    ]));
    expect(runner.calls.filter((args) => args[0] === 'cp')).toHaveLength(2);
    expect(runner.calls).toContainEqual(['start', 'link-bot-task_1']);
    const helpers = runner.calls.filter((args) => args[0] === 'run');
    expect(helpers).toHaveLength(4);
    expect(helpers.every((args) => args.includes('none') && args.includes('0:0'))).toBe(true);
    expect(helpers.join(' ')).not.toContain('not-logged');

    await provisioner.stop(task('task_1'));
    await provisioner.resume(task('task_1'), { id: 'repo', name: 'Repo', path: '/manager/repo', codexArgs: [] });
    expect(runner.calls.filter((args) => args[0] === 'start')).toHaveLength(2);
  });

  it('refreshes Git identity in materialized repositories when resuming a projectless workspace', async () => {
    const root = await createTmpDir();
    const authRoot = join(root, 'protected-auth');
    await mkdir(authRoot, { recursive: true });
    await writeFile(join(authRoot, 'auth.json'), '{"auth":"fresh"}');
    await mkdir(join(root, 'staging'), { recursive: true });
    const runner = new RecordingDockerRunner();
    const provisioner = new DockerTaskProvisioner(
      new DockerRuntime(config(join(root, 'sockets')), runner),
      new TaskCredentialManager(authRoot), join(root, 'staging'),
      undefined, undefined, undefined, undefined, undefined, testGitIdentities,
    );
    const current = task('task_projectless');
    const repository = {
      id: 'repository_1', taskId: current.id, projectId: 'example-api',
      checkoutPath: '/workspace/projects/example-api', baseRef: 'develop', branchName: 'codex/task',
      isPrimary: false, addedBy: 'ou_owner', status: 'ready' as const,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };

    await provisioner.resume(current, { id: 'repo', name: 'Repo', path: '/manager/repo', codexArgs: [] }, [repository]);

    const gitRuns = runner.calls.filter((args) => args[0] === 'run' && args.includes('git'));
    expect(gitRuns).toEqual(expect.arrayContaining([
      expect.arrayContaining(['-C', '/workspace/projects/example-api', 'config', 'user.name', 'Owner Name']),
      expect.arrayContaining(['-C', '/workspace/projects/example-api', 'config', 'user.email', 'owner@example.com']),
    ]));
    expect(gitRuns.some((args) => args.includes('/workspace') && !args.includes('/workspace/projects/example-api'))).toBe(false);
  });

  it('claims a pre-cloned READY runtime, creates the controlled branch offline, and persists its runtime id', async () => {
    const root = await createTmpDir();
    const authRoot = join(root, 'protected-auth');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(authRoot, { recursive: true }));
    await writeFile(join(authRoot, 'auth.json'), '{"auth":"private"}');
    const runner = new RecordingDockerRunner();
    const docker = new DockerRuntime(config(join(root, 'sockets')), runner);
    const git = { run: async (_cwd: string, args: string[]) => args[0] === 'rev-parse' ? 'base_sha' : args[0] === 'remote' ? 'git@github.com:acme/repo.git' : '' };
    const readyRuntime = new DockerReadySlotRuntime(docker, join(root, 'ready-staging'), git, 'image:v1', '0.145.0');
    const versionKey = await readyRuntime.registerProject({ id: 'repo', name: 'Repo', path: root, codexArgs: [] });
    const store = new SqliteStateStore(join(root, 'state.sqlite'));
    store.saveReadySlot({
      id: 'ready_1', versionKey, status: 'ready', metadata: { runtimeId: 'ready_1', projectId: 'repo' },
      createdAt: '2026-07-28T00:00:00.000Z', updatedAt: '2026-07-28T00:00:00.000Z',
    });
    const readyPool = new ReadyPoolController(store, readyRuntime, { enabled: true, defaultMinReady: 0, defaultMaxReady: 1 });
    const provisioner = new DockerTaskProvisioner(
      docker, new TaskCredentialManager(authRoot), join(root, 'staging'), git, async () => undefined, readyPool, readyRuntime,
      undefined, testGitIdentities,
    );

    await expect(provisioner.provision({
      taskId: 'task_1', ownerUserId: 'ou_owner', project: { id: 'repo', name: 'Repo', path: root, codexArgs: [] },
    })).resolves.toMatchObject({ runtimeId: 'ready_1', startupType: 'ready', branchName: 'codex/ou_owner/task_1' });
    expect(runner.calls.filter((args) => args[0] === 'run')).toHaveLength(6);
    expect(runner.calls.find((args) => args[0] === 'run')).toEqual(expect.arrayContaining(['--network', 'none']));
    expect(store.listReadySlots(versionKey)).toHaveLength(0);
    store.close();
  });

  it('recovers a missing READY remote-tracking ref before calculating the pool version', async () => {
    const root = await createTmpDir();
    const runner = new RecordingDockerRunner();
    const docker = new DockerRuntime(config(join(root, 'sockets')), runner);
    let revParseAttempts = 0;
    const git = { run: vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === 'rev-parse' && ++revParseAttempts === 1) throw new Error('missing ref');
      if (args[0] === 'rev-parse') return 'base_sha';
      if (args[0] === 'remote') return 'git@github.com:acme/repo.git';
      return '';
    }) };
    const readyRuntime = new DockerReadySlotRuntime(docker, join(root, 'ready-staging'), git, 'image:v1', '0.145.0');

    await expect(readyRuntime.registerProject({
      id: 'repo', name: 'Repo', path: root, baseRef: 'master', codexArgs: [],
    })).resolves.toEqual(expect.any(String));
    expect(git.run).toHaveBeenCalledWith(root, [
      'fetch', '--no-tags', 'origin', '+refs/heads/master:refs/remotes/origin/master',
    ]);
  });

  it('falls back to cold provisioning when a persisted READY container is missing', async () => {
    const root = await createTmpDir();
    const authRoot = join(root, 'protected-auth');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(authRoot, { recursive: true }));
    await writeFile(join(authRoot, 'auth.json'), '{}');
    const runner = new RecordingDockerRunner();
    runner.failInspect = true;
    const docker = new DockerRuntime(config(join(root, 'sockets')), runner);
    const git = { run: async (_cwd: string, args: string[]) => args[0] === 'rev-parse' ? 'base_sha' : args[0] === 'remote' ? 'git@github.com:acme/repo.git' : '' };
    const readyRuntime = new DockerReadySlotRuntime(docker, join(root, 'ready-staging'), git, 'image:v1', '0.145.0');
    const project = { id: 'repo', name: 'Repo', path: root, codexArgs: [] };
    const versionKey = await readyRuntime.registerProject(project);
    const store = new SqliteStateStore(join(root, 'state.sqlite'));
    store.saveReadySlot({
      id: 'ready_missing', versionKey, status: 'ready', metadata: { runtimeId: 'ready_missing' },
      createdAt: '2026-07-28T00:00:00.000Z', updatedAt: '2026-07-28T00:00:00.000Z',
    });
    const readyPool = new ReadyPoolController(store, readyRuntime, { enabled: true, defaultMinReady: 0, defaultMaxReady: 1 });
    const provisioner = new DockerTaskProvisioner(
      docker, new TaskCredentialManager(authRoot), join(root, 'staging'), git, async () => undefined, readyPool, readyRuntime,
      undefined, testGitIdentities,
    );

    await expect(provisioner.provision({ taskId: 'task_1', ownerUserId: 'ou_owner', project }))
      .resolves.toMatchObject({ runtimeId: 'task_1', startupType: 'cold' });
    expect(runner.calls).toContainEqual(['rm', '--force', 'link-bot-ready_missing']);
    expect(runner.calls.filter((args) => args[0] === 'create')).toHaveLength(1);
    store.close();
  });

  it('checks persistent disk admission before cold task provisioning', async () => {
    const root = await createTmpDir();
    const authRoot = join(root, 'protected-auth');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(authRoot, { recursive: true }));
    const runner = new RecordingDockerRunner();
    const docker = new DockerRuntime(config(join(root, 'sockets')), runner);
    const admission = { assertAllocationAllowed: vi.fn(async () => { throw new Error('disk pressure'); }) };
    const provisioner = new DockerTaskProvisioner(
      docker,
      new TaskCredentialManager(authRoot),
      join(root, 'staging'),
      new ExecManagerGitRunner(),
      async () => undefined,
      undefined,
      undefined,
      admission,
    );

    await expect(provisioner.provision({
      taskId: 'task_disk', ownerUserId: 'ou_owner', genericWorkspace: true,
      project: { id: 'repo', name: 'Repo', path: root, codexArgs: [] },
    })).rejects.toThrow('disk pressure');
    expect(admission.assertAllocationAllowed).toHaveBeenCalledWith('task_provision');
    expect(runner.calls).toHaveLength(0);
  });
});

describe('TaskCredentialManager', () => {
  it('copies only minimum authentication with owner-only permissions and stops before replacement', async () => {
    const root = await createTmpDir();
    const source = join(root, 'protected');
    const target = join(root, 'task-home');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(source, { recursive: true }));
    await writeFile(join(source, 'auth.json'), '{"token":"not-logged"}');
    await writeFile(join(source, 'config.toml'), 'should-not-copy');
    const manager = new TaskCredentialManager(source);

    await expect(manager.stageMinimumAuth(target)).resolves.toEqual(['auth.json']);
    expect((await stat(join(target, 'auth.json'))).mode & 0o777).toBe(0o600);
    await expect(stat(join(target, 'config.toml'))).rejects.toMatchObject({ code: 'ENOENT' });

    const stop = vi.fn(async () => undefined);
    const copyFile = vi.fn(async () => undefined);
    await manager.replaceFailedTaskAuth({ stop, copyFile }, [join(target, 'auth.json')]);
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(copyFile.mock.invocationCallOrder[0]!);
  });
});

class RecordingDockerRunner implements DockerCommandRunner {
  readonly calls: string[][] = [];
  readonly options: Array<{ signal?: AbortSignal; timeoutMs?: number } | undefined> = [];
  versionOutput = '';
  memoryOutput = '';
  volumeListOutput = '';
  volumeInspectOutput = '';
  dataRootOutput = '';
  duOutputs: string[] = [];
  failInspect = false;
  failCommand?: string;
  readonly failures = new Map<string, string>();
  async run(args: string[], options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<{ stdout: string; stderr: string }> {
    this.calls.push(args);
    this.options.push(options);
    const failure = this.failures.get(args.join(' '));
    if (failure) throw new Error(failure);
    if (this.failCommand === args[0]) {
      this.failCommand = undefined;
      throw new Error(`injected ${args[0]} failure`);
    }
    if (this.failInspect && args[0] === 'inspect') throw new Error('missing');
    return {
      stdout: args[0] === 'stats' ? this.memoryOutput
        : args[0] === 'info' ? this.dataRootOutput
        : args[0] === 'volume' && args[1] === 'ls' ? this.volumeListOutput
        : args[0] === 'volume' && args[1] === 'inspect' ? this.volumeInspectOutput
        : args[0] === 'run' && (args.includes('-sb') || args.some((arg) => arg.includes('du -sb')))
          ? this.duOutputs.shift() ?? ''
        : args.includes('--version') ? this.versionOutput : '',
      stderr: '',
    };
  }
}

function config(socketRoot: string) {
  return {
    image: 'link-bot-runtime:0.1', socketRoot, cpuLimit: 2, memoryLimitBytes: 2_147_483_648,
    pidLimit: 128, network: 'link-bot-egress',
  };
}

function task(id: string) {
  return {
    id, ownerUserId: 'ou_owner', projectId: 'repo', baseRef: 'main', branchName: `codex/ou_owner/${id}`,
    runtimeState: 'hot' as const, pinned: false, lastUserInteractionAt: '2026-07-28T00:00:00.000Z',
    createdAt: '2026-07-28T00:00:00.000Z', updatedAt: '2026-07-28T00:00:00.000Z',
  };
}
