import { rename,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe,expect,it,vi } from 'vitest';
import type { DockerCommandRunner } from '../../src/runtime/DockerRuntime.js';
import { SandboxSupervisorClient } from '../../src/runtime/SandboxSupervisorClient.js';
import {
UserSandboxDockerRuntime,userSandboxOwnerKey,
} from '../../src/runtime/UserSandboxDockerRuntime.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('UserSandboxDockerRuntime', () => {
  it('verifies project origin and reads the current branch without checkout, clean, reset, or fetch',async()=>{
    const root=await createTmpDir();
    const runner: DockerCommandRunner={run:vi.fn(async(args)=>({stdout:args.includes('get-url')?'git@github.com:example/tools.git\n':'my-uncommitted-work\n',stderr:'',exitCode:0}))};
    const docker=new UserSandboxDockerRuntime(config(root),runner);
    const runtime=docker.describe({id:'sandbox_1',ownerId:'ou_owner',generation:1});
    const workspace={projectId:'tools',cwd:'/workspace/tools',status:'ready' as const};
    expect(await docker.inspectProjectBranch(runtime,workspace,'https://github.com/example/tools.git')).toBe('my-uncommitted-work');
    const commands=vi.mocked(runner.run).mock.calls.map(([args])=>args);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain('10001:10001');
    expect(commands.flat()).not.toEqual(expect.arrayContaining(['checkout','reset','clean','fetch']));
    await expect(docker.inspectProjectBranch(runtime,workspace,'git@github.com:other/repo.git')).rejects.toThrow('origin');
    await expect(docker.inspectProjectBranch(runtime,{...workspace,cwd:'/workspace/another'})).rejects.toThrow('Unsafe');
  });
  it('migrates an existing owner from the actual image ID and launches that pinned image', async () => {
    const root = await createTmpDir();
    const old = `sha256:${'a'.repeat(64)}`;
    const available = `sha256:${'b'.repeat(64)}`;
    const runner: DockerCommandRunner = { run: vi.fn(async (args) => {
      const format = args[3];
      if (format === '{{.Image}}') return { stdout: old, stderr: '', exitCode: 0 };
      if (args[0] === 'image') return { stdout: available, stderr: '', exitCode: 0 };
      if (format === '{{.State.Status}}') return { stdout: '', stderr: 'missing', exitCode: 1 };
      if (format === '{{.Id}}') return { stdout: 'c'.repeat(64), stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    }) };
    const docker = new UserSandboxDockerRuntime(config(root), runner, async () => undefined);
    const record = { id: 'sandbox_1', ownerId: 'ou_owner', generation: 3, status: 'running' as const,
      createdAt: '', updatedAt: '', lastActiveAt: '' };
    expect(await docker.resolveRuntimeImage(record)).toBe(old);
    expect(await docker.configuredRuntimeImage()).toBe(available);
    await docker.provision({ ...record, runtimeImage: old });
    const create = vi.mocked(runner.run).mock.calls.find(([args]) => args[0] === 'create')![0];
    expect(create).toContain(old);
    expect(create).not.toContain('link-bot-runtime:test');
  });
  it('refreshes from the current host file after an atomic credential rotation', async () => {
    const root = await createTmpDir();
    const authFile = join(root, 'auth.json');
    await writeFile(authFile, 'old credential');
    await writeFile(`${authFile}.new`, 'current credential');
    await rename(`${authFile}.new`, authFile);
    const forwarded = vi.spyOn(SandboxSupervisorClient.prototype, 'refreshCodexAuth').mockResolvedValue({ updated: true });
    try {
      const runner = { run: vi.fn() } as unknown as DockerCommandRunner;
      const docker = new UserSandboxDockerRuntime({ ...config(root), authFile }, runner);
      await docker.refreshCodexAuth(docker.describe({ id: 'sandbox_1', ownerId: 'ou_owner', generation: 3 }));
      expect(forwarded).toHaveBeenCalledWith({ ownerId: 'ou_owner', sandboxGeneration: 3, contents: 'current credential' });
      expect(runner.run).not.toHaveBeenCalled();
      forwarded.mockResolvedValueOnce({ updated: false });
      await expect(docker.refreshCodexAuth(docker.describe({ id: 'sandbox_1', ownerId: 'ou_owner', generation: 3 })))
        .rejects.toThrow('Please sign in again');
    } finally {
      forwarded.mockRestore();
    }
  });
  it('creates one owner sandbox with a persistent tool home and generation-local native Git state', async () => {
    const bridgeRoot = join(await createTmpDir(), 'bridges');
    const commands: string[][] = [];
    const runner: DockerCommandRunner = {
      run: vi.fn(async (args) => {
        commands.push(args);
        if (args.slice(0, 4).join(' ') === 'container inspect --format {{.State.Status}}') {
          return { stdout: '', stderr: 'not found', exitCode: 1 };
        }
        if (args.slice(0, 4).join(' ') === 'container inspect --format {{.Id}}') {
          return { stdout: `${'a'.repeat(64)}\n`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    };
    const runtime = new UserSandboxDockerRuntime(config(bridgeRoot), runner, async () => undefined);

    const provisioned = await runtime.provision({ id: 'sandbox_1', ownerId: 'ou_sensitive', generation: 3 });

    const ownerKey = userSandboxOwnerKey('ou_sensitive');
    expect(provisioned).toMatchObject({
      ownerKey, generation: 3, containerName: `link-bot-user-${ownerKey}-g3`, containerId: 'a'.repeat(64),
      workspaceVolume: `link-bot-user-${ownerKey}-workspace`,
      cacheVolume: `link-bot-user-${ownerKey}-cache`,
      homeVolume: `link-bot-user-${ownerKey}-g3-home`,
      codexVolume: `link-bot-user-${ownerKey}-codex`,
      agentsVolume: `link-bot-user-${ownerKey}-agents`,
    });
    const create = commands.find((args) => args[0] === 'create')!;
    expect(create).toEqual(expect.arrayContaining([
      '--label', 'link-bot.runtime-mode=user-sandbox',
      '--cap-add', 'SETUID',
      '--cap-add', 'KILL',
      '--env', 'LINK_BOT_OWNER_ID=ou_sensitive',
      '--env', 'LINK_BOT_MAX_APP_SERVERS=8',
      '--env', 'LINK_BOT_CODEX_ARGS=["-c","features.context_management.experimental_mode=true","-c","model_context_window=1000000","app-server","--stdio"]',
      '--env', 'LINK_BOT_TOOL_HOME=/home/codex/.codex/tool-home',
      '--env', 'GH_CONFIG_DIR=/home/codex/.codex/tool-home/gh',
      '--env', 'LINK_BOT_NATIVE_GIT_HOME=/home/codex/.link-bot/native-git',
      '--workdir', '/workspace',
      '--entrypoint', '/usr/bin/tini',
      '-s', '--', '/usr/local/bin/link-bot-sandbox-supervisor',
    ]));
    expect(create).toContain(`type=volume,src=link-bot-user-${ownerKey}-workspace,dst=/workspace`);
    expect(create).toContain(`type=volume,src=link-bot-user-${ownerKey}-cache,dst=/cache`);
    expect(create).toContain(`type=volume,src=link-bot-user-${ownerKey}-g3-home,dst=/home/codex`);
    expect(create).toContain(`type=volume,src=link-bot-user-${ownerKey}-codex,dst=/home/codex/.codex`);
    expect(create).toContain(`type=volume,src=link-bot-user-${ownerKey}-agents,dst=/home/codex/.agents`);
    expect(create).toEqual(expect.arrayContaining(['--label', 'link-bot.runtime-spec=7']));
    expect(create).toContain(`type=bind,src=${provisioned.bridgeDirectory},dst=/run/link-bot/bridge`);
    expect(create).toContain('LINK_BOT_AUTH_FILE=/run/link-bot-auth.json');
    expect(create).toContain('type=bind,src=/protected/codex-auth.json,dst=/run/link-bot-auth.json,readonly');
  });

  it('applies owner resources and falls back to defaults for other users', async () => {
    const commands: string[][] = [];
    const runner: DockerCommandRunner = {
      run: vi.fn(async (args) => {
        commands.push(args);
        if (args.slice(0, 4).join(' ') === 'container inspect --format {{.State.Status}}') {
          return { stdout: '', stderr: 'not found', exitCode: 1 };
        }
        if (args.slice(0, 4).join(' ') === 'container inspect --format {{.Id}}') {
          return { stdout: `${'a'.repeat(64)}\n`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    };
    const runtime = new UserSandboxDockerRuntime({
      ...config(join(await createTmpDir(), 'bridges')),
      pidLimit: -1,
      resourceOverrides: { ou_owner: { cpuLimit: 8, memoryLimitBytes: 17_179_869_184 } },
    }, runner, async () => undefined);

    await runtime.provision({ id: 'sandbox_owner', ownerId: 'ou_owner', generation: 1 });
    await runtime.provision({ id: 'sandbox_other', ownerId: 'ou_other', generation: 1 });

    const creates = commands.filter((args) => args[0] === 'create');
    expect(creates).toHaveLength(2);
    expect(creates[0]).toEqual(expect.arrayContaining([
      '--cpus', '8', '--memory', '17179869184', '--pids-limit', '-1',
    ]));
    expect(creates[1]).toEqual(expect.arrayContaining([
      '--cpus', '4', '--memory', '8589934592', '--pids-limit', '-1',
    ]));
  });

  it('stages task attachments and exports task outbox or shared artifacts only', async () => {
    const commands: string[][] = [];
    const runner: DockerCommandRunner = {
      run: vi.fn(async (args) => {
        commands.push(args);
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    };
    const runtime = new UserSandboxDockerRuntime(config(join(await createTmpDir(), 'bridges')), runner);
    const described = runtime.describe({ id: 'sandbox_1', ownerId: 'ou_1', generation: 2 });

    await expect(runtime.stageTaskAttachment(
      described, 'task_1', 'turn_1', '/manager/report.txt', '../report.txt',
    )).resolves.toBe('/workspace/tasks/task_1/.linkbot/inbox/turn_1/report.txt');
    await runtime.exportTaskArtifact(
      described, 'task_1', '/workspace/tasks/task_1/.linkbot/outbox/result.txt', '/manager/result.txt',
    );
    await runtime.exportTaskArtifact(
      described, 'task_1', '/workspace/.linkbot/artifacts/screenshots/failure.png', '/manager/failure.png',
    );
    await expect(runtime.stageTaskAttachment(
      described, 'task_1', 'turn_2', '/manager/another.txt', 'another.txt', 'project',
    )).resolves.toBe('/workspace/.linkbot/tasks/task_1/inbox/turn_2/another.txt');
    await runtime.exportTaskArtifact(
      described, 'task_1', '/workspace/.linkbot/tasks/task_1/outbox/new.txt', '/manager/new.txt', 'project',
    );

    expect(commands).toContainEqual(['cp', '/manager/report.txt',
      `${described.containerName}:/workspace/tasks/task_1/.linkbot/inbox/turn_1/report.txt.part`]);
    const staged = '/workspace/tasks/task_1/.linkbot/inbox/turn_1/report.txt.part';
    const chownIndex = commands.findIndex((args) => args[0] === 'exec' && args.includes('chown') && args.includes(staged));
    const chmodIndex = commands.findIndex((args) => args[0] === 'exec' && args.includes('chmod') && args.includes(staged));
    expect(chmodIndex).toBeGreaterThan(chownIndex);
    expect(commands[chmodIndex]).toEqual([
      'exec', '--user', '10001:10001', described.containerName, 'chmod', '0400', staged,
    ]);
    expect(commands).toContainEqual(['cp',
      `${described.containerName}:/workspace/tasks/task_1/.linkbot/outbox/result.txt`, '/manager/result.txt']);
    expect(commands).toContainEqual(['cp',
      `${described.containerName}:/workspace/.linkbot/artifacts/screenshots/failure.png`, '/manager/failure.png']);
    expect(commands).toContainEqual(['cp',
      `${described.containerName}:/workspace/.linkbot/tasks/task_1/outbox/new.txt`, '/manager/new.txt']);
    await expect(runtime.exportTaskArtifact(
      described, 'task_1', '/workspace/tasks/task_2/.linkbot/outbox/result.txt', '/manager/result.txt',
    )).rejects.toThrow('Unsafe user-sandbox artifact path');
  });

  it('migrates the legacy generation-local tool home before recycling only generation-local resources', async () => {
    const bridgeRoot = join(await createTmpDir(), 'bridges');
    const commands: string[][] = [];
    const runner: DockerCommandRunner = {
      run: vi.fn(async (args) => {
        commands.push(args);
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    };
    const runtime = new UserSandboxDockerRuntime(config(bridgeRoot), runner, async () => undefined);
    const record = { id: 'sandbox_1', ownerId: 'ou_1', generation: 4 };
    const described = runtime.describe(record);

    await runtime.stopAndRemove(record);

    expect(commands).toContainEqual(['rm', '--force', described.containerName]);
    expect(commands).toContainEqual(['volume', 'inspect', described.homeVolume]);
    expect(commands).toContainEqual(expect.arrayContaining([
      'run', '--rm', '--network', 'none', '--user', '0:0',
      '--mount', `type=volume,src=${described.homeVolume},dst=/legacy-home,readonly`,
      '--mount', `type=volume,src=${described.codexVolume},dst=/codex-home`,
      '--entrypoint', '/bin/sh', 'link-bot-runtime:test', '-c',
    ]));
    const migration = commands.find((args) =>
      args.some((arg) => arg.includes('/legacy-home/.link-bot/tool-home')))!;
    expect(migration.at(-1)).toContain('target=/codex-home/tool-home');
    expect(commands.indexOf(migration)).toBeLessThan(commands.findIndex((args) =>
      args[0] === 'volume' && args[1] === 'rm' && args[2] === described.homeVolume));
    expect(commands).toContainEqual(['volume', 'rm', described.homeVolume]);
    expect(commands).not.toContainEqual(['volume', 'rm', described.workspaceVolume]);
    expect(commands).not.toContainEqual(['volume', 'rm', described.cacheVolume]);
    expect(commands).not.toContainEqual(['volume', 'rm', described.codexVolume]);
    expect(commands).not.toContainEqual(['volume', 'rm', described.agentsVolume]);
  });

  it('does not create a missing generation-local home merely to migrate tool state', async () => {
    const bridgeRoot = join(await createTmpDir(), 'bridges');
    const commands: string[][] = [];
    const runner: DockerCommandRunner = {
      run: vi.fn(async (args) => {
        commands.push(args);
        if (args[0] === 'volume' && args[1] === 'inspect') {
          return { stdout: '', stderr: 'not found', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    };
    const runtime = new UserSandboxDockerRuntime(config(bridgeRoot), runner, async () => undefined);
    const record = { id: 'sandbox_1', ownerId: 'ou_1', generation: 4 };
    const described = runtime.describe(record);

    await runtime.stopAndRemove(record);

    expect(commands).toContainEqual(['volume', 'inspect', described.homeVolume]);
    expect(commands.filter((args) => args[0] === 'run')).toHaveLength(0);
    expect(commands).toContainEqual(['volume', 'rm', described.homeVolume]);
  });

  it('cleans a failed generation without deleting owner-persistent volumes', async () => {
    const bridgeRoot = join(await createTmpDir(), 'bridges');
    const commands: string[][] = [];
    const runner: DockerCommandRunner = {
      run: vi.fn(async (args) => {
        commands.push(args);
        if (args.slice(0, 4).join(' ') === 'container inspect --format {{.State.Status}}') {
          return { stdout: '', stderr: 'not found', exitCode: 1 };
        }
        if (args[0] === 'start') throw new Error('start failed');
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    };
    const runtime = new UserSandboxDockerRuntime(config(bridgeRoot), runner, async () => undefined);
    const described = runtime.describe({ id: 'sandbox_1', ownerId: 'ou_1', generation: 2 });

    await expect(runtime.provision({ id: 'sandbox_1', ownerId: 'ou_1', generation: 2 })).rejects.toThrow('start failed');

    expect(commands).toContainEqual(['volume', 'rm', described.homeVolume]);
    expect(commands).not.toContainEqual(['volume', 'rm', described.workspaceVolume]);
    expect(commands).not.toContainEqual(['volume', 'rm', described.cacheVolume]);
    expect(commands).not.toContainEqual(['volume', 'rm', described.codexVolume]);
    expect(commands).not.toContainEqual(['volume', 'rm', described.agentsVolume]);
  });
});

function config(bridgeRoot: string) {
  return {
    image: 'link-bot-runtime:test', transport: 'unix-socket' as const, bridgeRoot, cpuLimit: 4, memoryLimitBytes: 8_589_934_592,
    pidLimit: 512, tmpfsLimitBytes: 268_435_456, network: 'bridge', maxAppServersPerUser: 8,
    hostUid: 1001, hostGid: 1001,
    authFile: '/protected/codex-auth.json',
  };
}
