import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SqliteStateStore } from '../../src/state/SqliteStateStore.js';
import { UserSandboxManager } from '../../src/runtime/UserSandboxManager.js';
import { SandboxSupervisorClient } from '../../src/runtime/SandboxSupervisorClient.js';
import type { DockerUserSandboxRuntime } from '../../src/runtime/UserSandboxDockerRuntime.js';
import type { UserSandboxRecord } from '../../src/tasks/TaskTypes.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('UserSandboxManager', () => {
  it('waits for the old manager lease to expire when recovering without replacing the sandbox', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    try {
      const sandbox = store.getOrCreateUserSandbox('ou_1').sandbox;
      store.saveUserSandbox({ ...sandbox, status: 'running', containerId: 'container-a' });
      store.claimUserSandboxLease({ ownerId: 'ou_1', leaseOwner: 'old-manager',
        leaseExpiresAt: new Date(Date.now() + 1_000).toISOString(), now: NOW });
      const provision = vi.fn(async (record: UserSandboxRecord) => runtime(record, 'container-a'));
      const manager = new UserSandboxManager(store, {
        describe: (record) => runtime(record, record.containerId), provision,
        observe: vi.fn(async () => 'running' as const), stopAndRemove: vi.fn(),
      }, { leaseOwner: 'new-manager' });
      const recovered = manager.ensure('ou_1', { leaseWaitMs: 60_000 });
      await vi.advanceTimersByTimeAsync(750);
      expect(provision).not.toHaveBeenCalled();
      expect(store.getUserSandboxByOwner('ou_1')?.leaseOwner).toBe('old-manager');
      await vi.advanceTimersByTimeAsync(250);
      await expect(recovered).resolves.toMatchObject({ sandbox: {
        generation: sandbox.generation, containerId: 'container-a', leaseOwner: 'new-manager',
      } });
    } finally {
      vi.useRealTimers();
      store.close();
    }
  });

  it('bounds recovery waiting without taking an unexpired lease', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    try {
      store.getOrCreateUserSandbox('ou_1');
      store.claimUserSandboxLease({ ownerId: 'ou_1', leaseOwner: 'other-manager',
        leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), now: NOW });
      const provision = vi.fn();
      const manager = new UserSandboxManager(store, {
        describe: (record) => runtime(record, record.containerId), provision,
        observe: vi.fn(), stopAndRemove: vi.fn(),
      }, { leaseOwner: 'new-manager' });
      const rejected = expect(manager.ensure('ou_1', { leaseWaitMs: 60_000 }))
        .rejects.toThrow('lease is held by another manager');
      await vi.advanceTimersByTimeAsync(60_000);
      await rejected;
      expect(provision).not.toHaveBeenCalled();
      expect(store.getUserSandboxByOwner('ou_1')?.leaseOwner).toBe('other-manager');
    } finally {
      vi.useRealTimers();
      store.close();
    }
  });

  it('keeps the owner image across reclamation after the stable image advances, until explicit upgrade', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'), () => new Date(NOW));
    let stable = 'sha256:old';
    const provision = vi.fn(async (record: UserSandboxRecord) => runtime(record, `container-${record.generation}`));
    const validate = vi.fn(async () => undefined);
    const manager = new UserSandboxManager(store, {
      describe: (record) => runtime(record, record.containerId), provision,
      observe: vi.fn(async () => 'running' as const), stopAndRemove: vi.fn(async () => undefined),
      resolveRuntimeImage: async () => stable, configuredRuntimeImage: async () => stable,
      runtimeVersion: async (image) => image === 'sha256:old' ? '0.161.0' : '0.162.1', validateRuntimeImage: validate,
    }, { leaseOwner: 'manager-a', clock: () => new Date(NOW) });
    await manager.ensure('ou_1');
    stable = 'sha256:new';
    await manager.reclaim('ou_1');
    await manager.ensure('ou_1');
    expect(provision.mock.calls.at(-1)?.[0].runtimeImage).toBe('sha256:old');
    expect(await manager.runtimeStatus('ou_1')).toContain('0.161.0');
    await expect(manager.upgradeRuntime('ou_1')).resolves.toContain('0.162.1');
    expect(validate).toHaveBeenCalledWith('sha256:new');
    expect(store.getUserSandboxByOwner('ou_1')).toMatchObject({ runtimeImage: 'sha256:new', status: 'running' });
    await manager.reclaim('ou_1');
    await manager.ensure('ou_1');
    expect(provision.mock.calls.at(-1)?.[0].runtimeImage).toBe('sha256:new');
    store.close();
  });

  it('restores the old pinned image when an explicit upgrade cannot boot', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'), () => new Date(NOW));
    let stable = 'old';
    const provision = vi.fn(async (record: UserSandboxRecord) => {
      if (record.runtimeImage === 'new') throw new Error('candidate startup failed');
      return runtime(record, `container-${record.generation}`);
    });
    const manager = new UserSandboxManager(store, {
      describe: (record) => runtime(record, record.containerId), provision,
      observe: async () => 'running', stopAndRemove: async () => undefined,
      resolveRuntimeImage: async () => stable, configuredRuntimeImage: async () => stable,
      runtimeVersion: async () => '0.162.1', validateRuntimeImage: async () => undefined,
    }, { leaseOwner: 'manager-a', clock: () => new Date(NOW) });
    await manager.ensure('ou_1');
    stable = 'new';
    await expect(manager.upgradeRuntime('ou_1')).rejects.toThrow('已恢复旧环境');
    expect(store.getUserSandboxByOwner('ou_1')).toMatchObject({ runtimeImage: 'old', status: 'running', generation: 3 });
    store.close();
  });

  it('keeps the existing environment running if candidate validation fails', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'), () => new Date(NOW));
    const stop = vi.fn(async () => undefined);
    const manager = new UserSandboxManager(store, {
      describe: (record) => runtime(record, record.containerId),
      provision: async (record) => runtime(record, 'container-old'), observe: async () => 'running', stopAndRemove: stop,
      resolveRuntimeImage: async () => 'old', configuredRuntimeImage: async () => 'new', runtimeVersion: async () => '0.162.1',
      validateRuntimeImage: async () => { throw new Error('invalid candidate'); },
    }, { leaseOwner: 'manager-a', clock: () => new Date(NOW) });
    await manager.ensure('ou_1');
    await expect(manager.upgradeRuntime('ou_1')).rejects.toThrow('invalid candidate');
    expect(stop).not.toHaveBeenCalled();
    expect(store.getUserSandboxByOwner('ou_1')).toMatchObject({ runtimeImage: 'old', status: 'running', generation: 1 });
    store.close();
  });
  it('refreshes credentials only after ensuring the owning sandbox generation', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'), () => new Date(NOW));
    const refresh = vi.fn(async () => undefined);
    const manager = new UserSandboxManager(store, {
      describe: (record) => runtime(record, record.containerId),
      provision: vi.fn(async (record) => runtime(record, `container-${record.generation}`)),
      observe: vi.fn(async () => 'running' as const), stopAndRemove: vi.fn(async () => undefined),
      refreshCodexAuth: refresh,
    }, { leaseOwner: 'manager-a', clock: () => new Date(NOW) });
    await manager.ensure('ou_1');
    await manager.reclaim('ou_1');
    await manager.refreshCodexAuth('ou_1');
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'ou_1', generation: 2 }));
    store.close();
  });
  it('requires the current owner generation before forwarding repository creation to the supervisor', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'), () => new Date(NOW));
    const manager = new UserSandboxManager(store, {
      describe: (record) => runtime(record, record.containerId),
      provision: vi.fn(async (record) => runtime(record, `container-${record.generation}`)),
      observe: vi.fn(async () => 'running' as const),
      stopAndRemove: vi.fn(async () => undefined),
    }, { leaseOwner: 'manager-a', clock: () => new Date(NOW) });
    const forwarded = vi.spyOn(SandboxSupervisorClient.prototype, 'createRepository').mockResolvedValue({
      status: 'created', providerRepoId: 'gh_123', canonicalPath: 'owner/repo',
      cloneUrl: 'git@github.com:owner/repo.git', defaultBranch: 'main',
    });
    const request = {
      action: 'create' as const, operationId: 'op_1', provider: 'github' as const,
      namespace: 'owner', name: 'repo', private: true as const,
      ownerUserId: 'ou_1', sandboxGeneration: 1,
    };

    await expect(manager.createRepository({ ...request, sandboxGeneration: 2 })).rejects.toThrow('generation');
    expect(forwarded).not.toHaveBeenCalled();
    await expect(manager.createRepository(request)).resolves.toMatchObject({ status: 'created', providerRepoId: 'gh_123' });
    expect(forwarded).toHaveBeenCalledOnce();
    expect(forwarded).toHaveBeenCalledWith(request);
    forwarded.mockRestore();
    store.close();
  });
  it('reuses one running generation and creates a fresh generation after reclaim', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'), () => new Date(NOW));
    const provision = vi.fn(async (record: Pick<UserSandboxRecord, 'id'|'ownerId'|'generation'>) =>
      runtime(record, `container-${record.generation}`));
    const observe = vi.fn(async () => 'running' as const);
    const stopAndRemove = vi.fn(async () => undefined);
    const manager = new UserSandboxManager(store, {
      describe: (record) => runtime(record, record.containerId), provision, observe, stopAndRemove,
    }, { leaseOwner: 'manager-a', clock: () => new Date(NOW) });

    const first = await manager.ensure('ou_1');
    const reused = await manager.ensure('ou_1');
    expect(first.sandbox).toMatchObject({ ownerId: 'ou_1', generation: 1, status: 'running', containerId: 'container-1' });
    expect(reused.sandbox).toMatchObject({ generation: 1, containerId: 'container-1' });
    expect(store.listUserSandboxes()).toHaveLength(1);

    await expect(manager.reclaim('ou_1')).resolves.toMatchObject({ generation: 1, status: 'stopped' });
    expect(stopAndRemove).toHaveBeenCalledWith(expect.objectContaining({ generation: 1, containerId: 'container-1' }));
    const restored = await manager.ensure('ou_1');
    expect(restored.sandbox).toMatchObject({ generation: 2, status: 'running', containerId: 'container-2' });
    expect(provision.mock.calls.map(([record]) => record.generation)).toEqual([1, 1, 2]);
    store.close();
  });

  it('rejects an observed container id change inside one generation', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'), () => new Date(NOW));
    const runtimePort = {
      describe: (record: Pick<UserSandboxRecord, 'id'|'ownerId'|'generation'|'containerId'>) => runtime(record, record.containerId),
      provision: vi.fn(async (record: Pick<UserSandboxRecord, 'id'|'ownerId'|'generation'>) => runtime(record, 'container-a')),
      observe: vi.fn(async () => 'running' as const),
      stopAndRemove: vi.fn(async () => undefined),
    };
    const manager = new UserSandboxManager(store, runtimePort, { leaseOwner: 'manager-a', clock: () => new Date(NOW) });
    await manager.ensure('ou_1');
    runtimePort.provision.mockImplementationOnce(async (record) => runtime(record, 'container-b'));

    await expect(manager.ensure('ou_1')).rejects.toThrow('identity changed');
    expect(store.getUserSandboxByOwner('ou_1')).toMatchObject({ generation: 1, containerId: 'container-a' });
    store.close();
  });

  it('fails closed while another unexpired manager lease owns the user sandbox', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'), () => new Date(NOW));
    store.getOrCreateUserSandbox('ou_1');
    store.claimUserSandboxLease({
      ownerId: 'ou_1', leaseOwner: 'manager-a', leaseExpiresAt: '2026-07-28T07:00:00.000Z', now: NOW,
    });
    const manager = new UserSandboxManager(store, {
      describe: (record) => runtime(record, record.containerId),
      provision: vi.fn(), observe: vi.fn(), stopAndRemove: vi.fn(),
    }, { leaseOwner: 'manager-b', clock: () => new Date(NOW) });

    await expect(manager.ensure('ou_1')).rejects.toThrow('held by another manager');
    store.close();
  });
});

const NOW = '2026-07-28T06:00:00.000Z';

function runtime(
  record: Pick<UserSandboxRecord, 'id'|'ownerId'|'generation'>,
  containerId?: string,
): DockerUserSandboxRuntime {
  return {
    sandboxId: record.id,
    ownerId: record.ownerId,
    ownerKey: 'owner-key',
    generation: record.generation,
    containerName: `sandbox-${record.generation}`,
    workspaceVolume: 'workspace',
    cacheVolume: 'cache',
    homeVolume: `home-${record.generation}`,
    codexVolume: 'codex',
    agentsVolume: 'agents',
    bridgeDirectory: `/bridge/${record.generation}`,
    supervisorSocketPath: `/bridge/${record.generation}/supervisor.sock`,
    ...(containerId ? { containerId } : {}),
  };
}
