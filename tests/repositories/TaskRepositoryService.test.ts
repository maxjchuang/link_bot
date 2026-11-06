import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TaskRepositoryService } from '../../src/repositories/TaskRepositoryService.js';
import { SqliteStateStore } from '../../src/state/SqliteStateStore.js';
import type { TaskRecord } from '../../src/tasks/TaskTypes.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('TaskRepositoryService', () => {
  it('serializes repeated repository adds and exposes one ready checkout', async () => {
    const store = await createStore();
    store.saveTask(task('task_1'));
    const runtime = { addRepository: vi.fn(async () => ({ baseCommit: 'base_sha' })) };
    const validate = vi.fn();
    const service = new TaskRepositoryService(store, runtime, validate, () => new Date(NOW));

    const [first, second] = await Promise.all([
      service.add({ taskId: 'task_1', project: PROJECT, addedBy: 'ou_owner' }),
      service.add({ taskId: 'task_1', project: PROJECT, addedBy: 'ou_owner' }),
    ]);

    expect(first).toEqual(second);
    expect(first).toMatchObject({ projectId: 'repo_2', status: 'ready', baseCommit: 'base_sha', isPrimary: false });
    expect(first.checkoutPath).toMatch(/^\/workspace\/repositories\/repo_2-/);
    expect(runtime.addRepository).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledTimes(3);
    expect(service.resolve('task_1', 'repo_2')).toEqual(first);
    store.close();
  });

  it('resolves an unspecified base branch through the runtime and preserves an explicit branch', async () => {
    const store = await createStore();
    store.saveTask(task('task_1'));
    store.saveTask(task('task_2'));
    const runtime = {
      resolveDefaultBaseRef: vi.fn(async () => 'develop'),
      addRepository: vi.fn(async () => ({ baseCommit: 'base_sha' })),
    };
    const service = new TaskRepositoryService(store, runtime, () => undefined);

    const automatic = await service.add({ taskId: 'task_1', project: PROJECT, addedBy: 'ou_owner' });
    const explicit = await service.add({ taskId: 'task_2', project: PROJECT, baseRef: 'release/1.0', addedBy: 'ou_owner' });

    expect(automatic.baseRef).toBe('develop');
    expect(explicit.baseRef).toBe('release/1.0');
    expect(runtime.resolveDefaultBaseRef).toHaveBeenCalledTimes(1);
    store.close();
  });

  it('does not silently reuse a ready checkout when an explicit base branch differs', async () => {
    const store = await createStore();
    store.saveTask(task('task_1'));
    const runtime = { addRepository: vi.fn(async () => ({ baseCommit: 'base_sha' })) };
    const service = new TaskRepositoryService(store, runtime, () => undefined);
    await service.add({ taskId: 'task_1', project: PROJECT, baseRef: 'master', addedBy: 'ou_owner' });

    await expect(service.add({
      taskId: 'task_1', project: PROJECT, baseRef: 'develop', addedBy: 'ou_owner',
    })).rejects.toThrow('already loaded from master');
    expect(runtime.addRepository).toHaveBeenCalledTimes(1);
    expect(service.resolve('task_1', 'repo_2').baseRef).toBe('master');
    store.close();
  });

  it('reopens a ready repository without waiting behind the task mutation queue', async () => {
    const store = await createStore();
    store.saveTask(task('task_1'));
    const runtime = { addRepository: vi.fn(async () => ({ baseCommit: 'base_sha' })) };
    const service = new TaskRepositoryService(store, runtime, () => undefined);
    const ready = await service.add({ taskId: 'task_1', project: PROJECT, addedBy: 'ou_owner' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const blockedMutation = store.withTaskLock('task_1', async () => gate);

    await expect(service.add({ taskId: 'task_1', project: PROJECT, addedBy: 'ou_owner' })).resolves.toEqual(ready);
    release();
    await blockedMutation;
    expect(runtime.addRepository).toHaveBeenCalledOnce();
    store.close();
  });

  it('can materialize a repository atomically while the caller holds the task lock', async () => {
    const store = await createStore();
    store.saveTask(task('task_1'));
    const runtime = { addRepository: vi.fn(async () => ({ baseCommit: 'base_sha' })) };
    const service = new TaskRepositoryService(store, runtime, () => undefined);

    const repository = await store.withTaskLock('task_1', async () => service.addUnderTaskLock({
      taskId: 'task_1', project: PROJECT, baseRef: 'release/1.0', addedBy: 'ou_owner', projectsLayout: true,
    }));

    expect(repository).toMatchObject({
      projectId: 'repo_2', baseRef: 'release/1.0', baseCommit: 'base_sha', status: 'ready',
      checkoutPath: '/workspace/projects/repo_2',
    });
    expect(runtime.addRepository).toHaveBeenCalledOnce();
    store.close();
  });

  it('records failure without making it selectable and safely retries the same repository identity', async () => {
    const store = await createStore();
    store.saveTask(task('task_1'));
    const runtime = { addRepository: vi.fn()
      .mockRejectedValueOnce(new Error('clone https://secret@example.test failed'))
      .mockResolvedValueOnce({ baseCommit: 'base_sha' }) };
    const service = new TaskRepositoryService(store, runtime, () => undefined, () => new Date(NOW));

    await expect(service.add({ taskId: 'task_1', project: PROJECT, addedBy: 'ou_owner' })).rejects.toThrow('clone');
    const failed = store.listTaskRepositories('task_1')[0]!;
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed.failure).not.toContain('secret@');
    expect(() => service.resolve('task_1', 'repo_2')).toThrow('not found');

    const retried = await service.add({ taskId: 'task_1', project: PROJECT, addedBy: 'ou_owner' });
    expect(retried).toMatchObject({ id: failed.id, status: 'ready' });
    expect(store.listTaskRepositories('task_1')).toHaveLength(1);
    store.close();
  });

  it('preserves an explicit ref and replaces a failed checkout base on retry', async () => {
    const store = await createStore();
    store.saveTask(task('task_1'));
    const frontend = { ...PROJECT, id: 'example-web' };
    const runtime = { addRepository: vi.fn()
      .mockRejectedValueOnce(new Error('missing origin/8.3'))
      .mockResolvedValueOnce({ baseCommit: 'release_sha' }) };
    const service = new TaskRepositoryService(store, runtime, () => undefined, () => new Date(NOW));

    await expect(service.add({ taskId: 'task_1', project: frontend, baseRef: 'missing', addedBy: 'ou_owner' }))
      .rejects.toThrow('missing');
    const failed = store.listTaskRepositories('task_1')[0]!;
    expect(failed.baseRef).toBe('missing');

    const retried = await service.add({ taskId: 'task_1', project: frontend, baseRef: '8.3', addedBy: 'ou_owner' });

    expect(retried).toMatchObject({
      id: failed.id, baseRef: '8.3', baseCommit: 'release_sha', status: 'ready',
    });
    expect(runtime.addRepository).toHaveBeenLastCalledWith(expect.anything(), frontend, expect.objectContaining({
      baseRef: '8.3', baseCommit: undefined, status: 'provisioning',
    }));
    store.close();
  });

  it('fails closed before runtime access while busy or unauthorized', async () => {
    const store = await createStore();
    store.saveTask(task('task_1', { activeTurnId: 'turn_1' }));
    const runtime = { addRepository: vi.fn(async () => ({ baseCommit: 'base_sha' })) };
    const service = new TaskRepositoryService(store, runtime, () => { throw new Error('unauthorized'); });

    await expect(service.add({ taskId: 'task_1', project: PROJECT, addedBy: 'ou_member' })).rejects.toThrow('turn is active');
    expect(runtime.addRepository).not.toHaveBeenCalled();
    store.saveTask(task('task_1'));
    await expect(service.add({ taskId: 'task_1', project: PROJECT, addedBy: 'ou_member' })).rejects.toThrow('unauthorized');
    expect(runtime.addRepository).not.toHaveBeenCalled();
    store.close();
  });

  it('uses the same in-container path only within distinct task runtimes', async () => {
    const store = await createStore();
    store.saveTask(task('task_1'));
    store.saveTask(task('task_2'));
    const calls: string[] = [];
    const runtime = { addRepository: vi.fn(async (taskRecord: TaskRecord) => {
      calls.push(taskRecord.id);
      return { baseCommit: `base_${taskRecord.id}` };
    }) };
    const service = new TaskRepositoryService(store, runtime, () => undefined);

    const first = await service.add({ taskId: 'task_1', project: PROJECT, addedBy: 'ou_owner' });
    const second = await service.add({ taskId: 'task_2', project: PROJECT, addedBy: 'ou_owner' });

    expect(first.checkoutPath).toBe(second.checkoutPath);
    expect(first.id).not.toBe(second.id);
    expect(calls).toEqual(['task_1', 'task_2']);
    store.close();
  });

  it('creates one compatibility primary repository without external Git work', async () => {
    const store = await createStore();
    const record = task('task_1');
    store.saveTask(record);
    const runtime = { addRepository: vi.fn() };
    const service = new TaskRepositoryService(store, runtime, () => undefined, () => new Date(NOW));

    const first = service.ensurePrimary(record, { ...PROJECT, id: 'repo' }, 'ou_owner');
    const second = service.ensurePrimary(record, { ...PROJECT, id: 'repo' }, 'ou_owner');

    expect(second).toEqual(first);
    expect(first).toMatchObject({ checkoutPath: '/workspace', isPrimary: true, status: 'ready' });
    expect(runtime.addRepository).not.toHaveBeenCalled();
    store.close();
  });
});

const NOW = '2026-07-28T04:00:00.000Z';
const PROJECT = { id: 'repo_2', name: 'Repository 2', path: '/manager/repo_2', baseRef: 'main', codexArgs: [] };

async function createStore(): Promise<SqliteStateStore> {
  return new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'));
}

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id, ownerUserId: 'ou_owner', projectId: 'repo', baseRef: 'main', branchName: `codex/ou_owner/${id}`,
    runtimeId: `runtime_${id}`, runtimeState: 'hot', pinned: false, lastUserInteractionAt: NOW,
    createdAt: NOW, updatedAt: NOW, ...overrides,
  };
}
