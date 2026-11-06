import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ProjectCreationService } from '../../src/projects/ProjectCreationService.js';
import { SqliteStateStore } from '../../src/state/SqliteStateStore.js';
import { ConversationTaskService } from '../../src/tasks/ConversationTaskService.js';
import { createTmpDir } from '../helpers/tmp.js';

const owner = { chatType: 'group' as const, chatId: 'oc_group', topicId: 'topic_1', userId: 'ou_owner' };
const createdRepository = { status: 'created' as const, providerRepoId: 'gh_123',
  canonicalPath: 'owner/repo', cloneUrl: 'git@github.com:owner/repo.git', defaultBranch: 'main' };

async function harness() {
  const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'));
  await new ConversationTaskService(store).getOrCreate({ ...owner, mode: 'chat', runtimeMode: 'user-sandbox' });
  const validate = vi.fn(async () => ({ status: 'ready' as const }));
  let now = new Date('2026-10-08T00:00:00.000Z');
  const service = new ProjectCreationService(store, validate, () => now);
  return { store, service, validate, advance: (date: string) => { now = new Date(date); } };
}

describe('ProjectCreationService', () => {
  it('registers GitHub canonical casing without changing the confirmed target', async () => {
    const { store, service } = await harness();
    const prepared = await service.prepare(owner, { provider: 'github', namespace: 'owner', name: 'repo' });
    await service.confirm(owner, '确认创建 owner/repo', 'om_confirm');
    service.setExecutionPorts({ create: async () => ({ ...createdRepository, canonicalPath: 'Owner/repo',
      cloneUrl: 'git@github.com:Owner/repo.git' }), readback: vi.fn(), bind: async (_actor, projectId) => {
      const task = store.listTasks()[0]!;
      store.updateTask(task.id, (current) => ({ ...current, mode: 'project', projectId, baseRef: 'main', branchName: 'branch' }));
      return { taskId: task.id, projectId };
    } });
    const operation = await service.executeConfirmed(prepared.operationId!);
    expect(operation).toMatchObject({ status: 'bound', namespace: 'owner', cloneUrl: 'git@github.com:Owner/repo.git' });
    expect(store.getDynamicProject(operation.projectId!)?.cloneUrl).toBe('git@github.com:Owner/repo.git');
    store.close();
  });
  it('keeps a confirmed remote-created operation recoverable after the confirmation deadline', async () => {
    const { store, service, advance } = await harness();
    const prepared = await service.prepare(owner, { provider: 'github', namespace: 'owner', name: 'repo' });
    await service.confirm(owner, '确认创建 owner/repo', 'om_confirm');
    store.transitionProjectCreationOperation(prepared.operationId!, 'creating', {
      status: 'remote_created', providerRepoId: 'gh_123', cloneUrl: createdRepository.cloneUrl,
      defaultBranch: 'main', updatedAt: '2026-10-08T00:00:01.000Z',
    });
    advance('2026-10-10T00:00:00.000Z');
    await service.prepare(owner, { provider: 'github', namespace: 'owner', name: 'repo' });
    expect(store.getProjectCreationOperation(prepared.operationId!)?.status).toBe('remote_created');
    const create = vi.fn();
    service.setExecutionPorts({ create, readback: vi.fn(), bind: async (_actor, projectId) => {
      const task = store.listTasks()[0]!;
      store.updateTask(task.id, (current) => ({ ...current, mode: 'project', projectId, baseRef: 'main', branchName: 'branch' }));
      return { taskId: task.id, projectId };
    } });
    await service.recoverOpenOperations();
    expect(store.getProjectCreationOperation(prepared.operationId!)?.status).toBe('bound');
    expect(create).not.toHaveBeenCalled();
    store.close();
  });
  it('creates once, registers the remote identity, and binds the original topic task', async () => {
    const { store, service } = await harness();
    const prepared = await service.prepare(owner, { provider: 'github', namespace: 'owner', name: 'repo' });
    await service.confirm(owner, '确认创建 owner/repo', 'om_confirm');
    const create = vi.fn(async () => createdRepository);
    const readback = vi.fn(async () => createdRepository);
    const bind = vi.fn(async (_actor, projectId: string) => {
      const scope = store.getTaskScopeByKey('personal-topic:ou_owner:oc_group:topic_1')!;
      store.updateTask(scope.taskId, (task) => ({ ...task, mode: 'project', projectId, baseRef: 'main',
        branchName: `codex/ou_owner/${task.id}` }));
      return { taskId: scope.taskId, projectId };
    });
    service.setExecutionPorts({ create, readback, bind });

    const operation = await service.executeConfirmed(prepared.operationId!);

    expect(operation).toMatchObject({ status: 'bound', providerRepoId: 'gh_123', cloneUrl: createdRepository.cloneUrl });
    expect(operation.projectId).toMatch(/^dyn_[A-Za-z0-9]+$/);
    expect(store.getDynamicProject(operation.projectId!)).toMatchObject({
      id: operation.projectId, provider: 'github', providerRepoId: 'gh_123', ownerUserId: 'ou_owner',
      chatId: 'oc_group', topicId: 'topic_1', state: 'active', cloneUrl: createdRepository.cloneUrl,
    });
    expect(create).toHaveBeenCalledOnce();
    expect(readback).not.toHaveBeenCalled();
    expect(bind).toHaveBeenCalledWith(owner, operation.projectId, expect.any(Function));
    expect(store.listTasks()).toHaveLength(1);
    expect(store.getTask(store.listTasks()[0]!.id)).toMatchObject({ mode: 'project', projectId: operation.projectId });
    store.close();
  });

  it('reads back an uncertain create after a timeout instead of issuing a second create', async () => {
    const { store, service } = await harness();
    const prepared = await service.prepare(owner, { provider: 'github', namespace: 'owner', name: 'repo' });
    await service.confirm(owner, '确认创建 owner/repo', 'om_confirm');
    const create = vi.fn(async () => { throw new Error('supervisor create timed out'); });
    const readback = vi.fn(async () => createdRepository);
    const bind = vi.fn(async (_actor, projectId: string) => {
      const task = store.listTasks()[0]!;
      store.updateTask(task.id, (current) => ({ ...current, mode: 'project', projectId,
        baseRef: 'main', branchName: `codex/ou_owner/${task.id}` }));
      return { taskId: task.id, projectId };
    });
    service.setExecutionPorts({ create, readback, bind });

    await expect(service.executeConfirmed(prepared.operationId!)).rejects.toThrow('timed out');
    expect(store.getProjectCreationOperation(prepared.operationId!)).toMatchObject({
      status: 'creating', createAttemptedAt: expect.any(String),
    });
    await service.recoverOpenOperations();

    expect(store.getProjectCreationOperation(prepared.operationId!)?.status).toBe('bound');
    expect(create).toHaveBeenCalledOnce();
    expect(readback).toHaveBeenCalledOnce();
    store.close();
  });

  it('retries the same confirmed operation after a definite pre-create login failure', async () => {
    const { store, service } = await harness();
    const prepared = await service.prepare(owner, { provider: 'github', namespace: 'owner', name: 'repo' });
    await service.confirm(owner, '确认创建 owner/repo', 'om_confirm');
    const create = vi.fn().mockResolvedValueOnce({ status: 'auth_required', reason: 'github_login_required' })
      .mockResolvedValueOnce(createdRepository);
    const readback = vi.fn();
    service.setExecutionPorts({ create, readback, bind: async (_actor, projectId) => {
      const task = store.listTasks()[0]!;
      store.updateTask(task.id, (current) => ({ ...current, mode: 'project', projectId,
        baseRef: 'main', branchName: 'branch' }));
      return { taskId: task.id, projectId };
    } });

    const first = await service.executeConfirmed(prepared.operationId!);
    expect(first).toMatchObject({ status: 'creating', failure: 'github_login_required' });
    expect(first.createAttemptedAt).toBeUndefined();
    expect(await service.confirm(owner, '确认创建 owner/repo', 'om_retry'))
      .toMatchObject({ operationId: prepared.operationId, status: 'creating' });
    const resumed = await service.executeConfirmed(prepared.operationId!);
    expect(resumed.status).toBe('bound');
    expect(create).toHaveBeenCalledTimes(2);
    expect(readback).not.toHaveBeenCalled();
    store.close();
  });

  it('re-enters the receipt-backed helper after Git bootstrap auth is restored without a second provider create', async () => {
    const { store, service } = await harness();
    const prepared = await service.prepare(owner, { provider: 'github', namespace: 'owner', name: 'repo' });
    await service.confirm(owner, '确认创建 owner/repo', 'om_confirm');
    const create = vi.fn().mockResolvedValueOnce({ status: 'auth_required', reason: 'git_bootstrap_failed' })
      .mockResolvedValueOnce(createdRepository);
    const readback = vi.fn();
    service.setExecutionPorts({ create, readback, bind: async (_actor, projectId) => {
      const task = store.listTasks()[0]!;
      store.updateTask(task.id, (current) => ({ ...current, mode: 'project', projectId,
        baseRef: 'main', branchName: 'branch' }));
      return { taskId: task.id, projectId };
    } });

    const first = await service.executeConfirmed(prepared.operationId!);
    expect(first.status).toBe('creating');
    expect(first.createAttemptedAt).toBeUndefined();
    expect((await service.executeConfirmed(prepared.operationId!)).status).toBe('bound');
    expect(create).toHaveBeenCalledTimes(2);
    expect(readback).not.toHaveBeenCalled();
    store.close();
  });

  it('does not adopt a same-name repository that the sandbox reports as foreign', async () => {
    const { store, service } = await harness();
    const prepared = await service.prepare(owner, { provider: 'github', namespace: 'owner', name: 'repo' });
    await service.confirm(owner, '确认创建 owner/repo', 'om_confirm');
    const create = vi.fn(async () => ({ status: 'exists_foreign' as const }));
    const bind = vi.fn();
    service.setExecutionPorts({ create, readback: vi.fn(), bind });

    const operation = await service.executeConfirmed(prepared.operationId!);

    expect(operation.status).toBe('failed');
    expect(store.listDynamicProjectsFor('ou_owner', 'oc_group', 'topic_1')).toEqual([]);
    expect(store.listTasks()[0]!.mode).toBe('chat');
    expect(bind).not.toHaveBeenCalled();
    store.close();
  });

  it('reuses a registered remote identity after a crash between registry and operation writes', async () => {
    const { store, service } = await harness();
    const prepared = await service.prepare(owner, { provider: 'github', namespace: 'owner', name: 'repo' });
    await service.confirm(owner, '确认创建 owner/repo', 'om_confirm');
    store.transitionProjectCreationOperation(prepared.operationId!, 'creating', {
      status: 'remote_created', providerRepoId: 'gh_123', cloneUrl: createdRepository.cloneUrl,
      defaultBranch: 'main', updatedAt: '2026-10-08T00:00:01.000Z',
    });
    store.saveDynamicProject({ id: 'dyn_existing', provider: 'github', providerRepoId: 'gh_123',
      namespace: 'owner', name: 'repo', cloneUrl: createdRepository.cloneUrl, defaultBranch: 'main',
      ownerUserId: 'ou_owner', chatId: 'oc_group', topicId: 'topic_1', state: 'registered',
      createdAt: '2026-10-08T00:00:01.000Z', updatedAt: '2026-10-08T00:00:01.000Z' });
    const create = vi.fn(); const readback = vi.fn();
    service.setExecutionPorts({ create, readback, bind: async (_actor, projectId) => {
      const task = store.listTasks()[0]!;
      store.updateTask(task.id, (current) => ({ ...current, mode: 'project', projectId,
        baseRef: 'main', branchName: 'branch' }));
      return { taskId: task.id, projectId };
    } });

    await service.recoverOpenOperations();

    expect(store.getProjectCreationOperation(prepared.operationId!)).toMatchObject({
      status: 'bound', projectId: 'dyn_existing',
    });
    expect(store.listDynamicProjectsFor('ou_owner', 'oc_group', 'topic_1')).toHaveLength(1);
    expect(create).not.toHaveBeenCalled();
    expect(readback).not.toHaveBeenCalled();
    store.close();
  });

  it('registers a separate scoped record without reusing another topic’s project', async () => {
    const { store, service } = await harness();
    const prepared = await service.prepare(owner, { provider: 'github', namespace: 'owner', name: 'repo' });
    await service.confirm(owner, '确认创建 owner/repo', 'om_confirm');
    store.saveDynamicProject({ id: 'dyn_foreign', provider: 'github', providerRepoId: 'gh_123',
      namespace: 'owner', name: 'repo', cloneUrl: createdRepository.cloneUrl, defaultBranch: 'main',
      ownerUserId: 'ou_other', chatId: 'oc_group', topicId: 'topic_other', state: 'active',
      createdAt: '2026-10-08T00:00:01.000Z', updatedAt: '2026-10-08T00:00:01.000Z' });
    const bind = vi.fn();
    service.setExecutionPorts({ create: vi.fn(async () => createdRepository), readback: vi.fn(), bind });

    await service.executeConfirmed(prepared.operationId!);
    const own=store.listDynamicProjectsFor(owner.userId,owner.chatId,owner.topicId!);
    expect(own).toHaveLength(1);
    expect(own[0]?.id).not.toBe('dyn_foreign');
    expect(own[0]?.providerRepoId).toBe('gh_123');
    expect(store.getDynamicProject('dyn_foreign')?.ownerUserId).toBe('ou_other');
    expect(bind).toHaveBeenCalledWith(owner,own[0]?.id,expect.any(Function));
    store.close();
  });

  it('rejects token-shaped provider metadata before it reaches durable host state', async () => {
    const { store, service } = await harness();
    const prepared = await service.prepare(owner, { provider: 'github', namespace: 'owner', name: 'repo' });
    await service.confirm(owner, '确认创建 owner/repo', 'om_confirm');
    const leaked = { ...createdRepository, providerRepoId: 'ghp_abcdefghijklmnopqrstuvwxyz123456' };
    service.setExecutionPorts({ create: vi.fn(async () => leaked), readback: vi.fn(), bind: vi.fn() });

    await expect(service.executeConfirmed(prepared.operationId!)).rejects.toThrow('identity');
    expect(JSON.stringify(store.getProjectCreationOperation(prepared.operationId!))).not.toContain('ghp_');
    expect(store.listDynamicProjectsFor('ou_owner', 'oc_group', 'topic_1')).toEqual([]);
    store.close();
  });

  it('finishes a checkout-ready operation after restart without replaying the bind', async () => {
    const { store, service } = await harness();
    const prepared = await service.prepare(owner, { provider: 'github', namespace: 'owner', name: 'repo' });
    await service.confirm(owner, '确认创建 owner/repo', 'om_confirm');
    store.transitionProjectCreationOperation(prepared.operationId!, 'creating', {
      status: 'checkout_ready', providerRepoId: 'gh_123', projectId: 'dyn_ready',
      cloneUrl: createdRepository.cloneUrl, defaultBranch: 'main', updatedAt: '2026-10-08T00:00:01.000Z',
    });
    store.saveDynamicProject({ id: 'dyn_ready', provider: 'github', providerRepoId: 'gh_123',
      namespace: 'owner', name: 'repo', cloneUrl: createdRepository.cloneUrl, defaultBranch: 'main',
      ownerUserId: 'ou_owner', chatId: 'oc_group', topicId: 'topic_1', state: 'registered',
      createdAt: '2026-10-08T00:00:01.000Z', updatedAt: '2026-10-08T00:00:01.000Z' });
    const task = store.listTasks()[0]!;
    store.updateTask(task.id, (current) => ({ ...current, mode: 'project', projectId: 'dyn_ready',
      baseRef: 'main', branchName: 'branch' }));
    const create = vi.fn(); const readback = vi.fn(); const bind = vi.fn();
    service.setExecutionPorts({ create, readback, bind });

    await service.recoverOpenOperations();

    expect(store.getProjectCreationOperation(prepared.operationId!)?.status).toBe('bound');
    expect(store.getDynamicProject('dyn_ready')?.state).toBe('active');
    expect(create).not.toHaveBeenCalled();
    expect(readback).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
    store.close();
  });

  it('retains the remote URL and chat after checkout auth failure, then binds without creating again', async () => {
    const { store, service } = await harness();
    const prepared = await service.prepare(owner, { provider: 'github', namespace: 'owner', name: 'repo' });
    await service.confirm(owner, '确认创建 owner/repo', 'om_confirm');
    const create = vi.fn(async () => createdRepository);
    const bind = vi.fn().mockRejectedValueOnce(new Error('checkout auth required'))
      .mockImplementationOnce(async (_actor, projectId: string) => {
        const task = store.listTasks()[0]!;
        store.updateTask(task.id, (current) => ({ ...current, mode: 'project', projectId,
          baseRef: 'main', branchName: `codex/ou_owner/${task.id}` }));
        return { taskId: task.id, projectId };
      });
    service.setExecutionPorts({ create, readback: vi.fn(), bind });

    await expect(service.executeConfirmed(prepared.operationId!)).rejects.toThrow('checkout auth required');
    expect(store.getProjectCreationOperation(prepared.operationId!)).toMatchObject({
      status: 'registered', cloneUrl: createdRepository.cloneUrl,
    });
    expect(store.listTasks()[0]!.mode).toBe('chat');
    await service.recoverOpenOperations();
    expect(store.getProjectCreationOperation(prepared.operationId!)?.status).toBe('bound');
    expect(create).toHaveBeenCalledOnce();
    store.close();
  });

  it('accepts only an exact requester confirmation in the original topic and deduplicates its message ID', async () => {
    const { store, service } = await harness();
    const prepared = await service.prepare(owner, { provider: 'github', namespace: 'owner', name: 'repo' });
    const other = { ...owner, userId: 'ou_other' };
    const sibling = { ...owner, topicId: 'topic_2' };

    expect(await service.confirm(owner, '好', 'om_1')).toBeUndefined();
    expect(await service.confirm(owner, '确认创建 owner/other', 'om_2')).toBeUndefined();
    expect(await service.confirm(other, '确认创建 owner/repo', 'om_3')).toBeUndefined();
    expect(await service.confirm(sibling, '确认创建 owner/repo', 'om_4')).toBeUndefined();
    const confirmed = await service.confirm(owner, '确认创建 owner/repo', 'om_5');

    expect(confirmed).toMatchObject({ operationId: prepared.operationId, status: 'creating',
      namespace: 'owner', name: 'repo', confirmedMessageId: 'om_5' });
    expect(await service.confirm(owner, '确认创建 owner/repo', 'om_5')).toEqual(confirmed);
    expect(await service.confirm(owner, '确认创建 owner/repo', 'om_6')).toBeUndefined();
    expect(store.getProjectCreationOperation(prepared.operationId!)?.status).toBe('creating');
    store.close();
  });

  it('expires an unconfirmed request after 24 hours and does not confirm it', async () => {
    const { store, service, advance } = await harness();
    const prepared = await service.prepare(owner, { provider: 'github', namespace: 'owner', name: 'repo' });
    advance('2026-10-09T00:00:01.000Z');
    expect(await service.confirm(owner, '确认创建 owner/repo', 'om_expired')).toBeUndefined();
    expect(store.getProjectCreationOperation(prepared.operationId!)?.status).toBe('failed');
    store.close();
  });

  it('does not allow another group member to claim a topic with a pending requester operation', async () => {
    const { store, service } = await harness();
    await service.prepare(owner, { provider: 'github' });
    await new ConversationTaskService(store).getOrCreate({ ...owner, userId: 'ou_other',
      mode: 'chat', runtimeMode: 'user-sandbox' });
    const attempt = await service.prepare({ ...owner, userId: 'ou_other' }, { provider: 'github' });
    expect(attempt.operationId).toBeUndefined();
    expect(attempt.text).toContain('其他请求者');
    store.close();
  });

  it('does not offer confirmation after a concurrent state change during validation', async () => {
    const { store } = await harness();
    const validate = vi.fn(async (_actor, request) => {
      store.transitionProjectCreationOperation(request.operationId, 'collecting', {
        status: 'failed', failure: 'cancelled', updatedAt: '2026-10-08T00:00:01.000Z',
      });
      return { status: 'ready' as const };
    });
    const service = new ProjectCreationService(store, validate, () => new Date('2026-10-08T00:00:00.000Z'));

    await expect(service.prepare(owner, { provider: 'github', namespace: 'owner', name: 'repo' }))
      .rejects.toThrow('changed');
    expect(store.listOpenProjectCreationOperations()).toEqual([]);
    store.close();
  });

  it('rejects token-shaped draft text before persisting or forwarding it', async () => {
    const { store, service, validate } = await harness();
    await expect(service.prepare(owner, { provider: 'github', namespace: 'owner', name: 'repo',
      description: 'Bearer abcdefghijklmnopqrstuvwxyz123456',
    })).rejects.toThrow('description');
    expect(validate).not.toHaveBeenCalled();
    expect(store.getOpenProjectCreationOperation('ou_owner', 'oc_group', 'topic_1')).toBeUndefined();
    store.close();
  });

  it('does not echo a token-shaped repository name in the confirmation summary', async () => {
    const { store, service, validate } = await harness();
    await expect(service.prepare(owner, { provider: 'github', namespace: 'owner',
      name: 'ghp_abcdefghijklmnopqrstuvwxyz123456',
    })).rejects.toThrow('name');
    expect(validate).not.toHaveBeenCalled();
    expect(store.getOpenProjectCreationOperation('ou_owner', 'oc_group', 'topic_1')).toBeUndefined();
    store.close();
  });
});
