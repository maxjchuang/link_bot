import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CodexBackend } from '../../src/backends/CodexBackend.js';
import { TaskContextService } from '../../src/contexts/TaskContextService.js';
import { SqliteStateStore } from '../../src/state/SqliteStateStore.js';
import type { TaskContextRecord, TaskRecord } from '../../src/tasks/TaskTypes.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('TaskContextService', () => {
  it('rolls back both context activation and project binding if the commit callback fails',async()=>{
    const {store,initial}=await createState();const backend=createBackend();
    const service=new TaskContextService(store,backend);
    await expect(service.adoptOpenedContext({taskId:TASK_ID,threadId:'target_thread',createdBy:'ou_owner',commit:()=>{
      store.updateTask(TASK_ID,current=>({...current,projectId:'repo2'}));throw new Error('commit rejected');
    }})).rejects.toThrow('commit rejected');
    expect(store.getTask(TASK_ID)).toMatchObject({projectId:'repo',codexThreadId:'thread_1'});
    expect(store.getActiveTaskContext(TASK_ID)?.id).toBe(initial.id);
    expect(backend.archiveContext).not.toHaveBeenCalled();store.close();
  });
  it('checkpoints and atomically activates a new context before archiving the previous thread', async () => {
    const { store, initial } = await createState();
    const backend = createBackend();
    const checkpoint = { create: vi.fn().mockResolvedValue({ memoryId: 'memory_checkpoint' }) };
    const service = new TaskContextService(store, backend, checkpoint, () => new Date(NEXT));

    const created = await service.createNew({ taskId: TASK_ID, createdBy: 'ou_owner' });

    expect(checkpoint.create).toHaveBeenCalledWith({ taskId: TASK_ID, context: initial, createdBy: 'ou_owner' });
    expect(created).toMatchObject({ taskId: TASK_ID, codexThreadId: 'thread_2', state: 'active', checkpointMemoryId: 'memory_checkpoint' });
    expect(store.getActiveTaskContext(TASK_ID)?.id).toBe(created.id);
    expect(store.getTaskContext(initial.id)).toMatchObject({ state: 'archived', archivedAt: NEXT });
    expect(store.getTask(TASK_ID)?.codexThreadId).toBe('thread_2');
    expect(backend.archiveContext).toHaveBeenCalledWith({ taskId: TASK_ID, threadId: 'thread_1' });
    store.close();
  });

  it('supports a blank reset without writing a checkpoint', async () => {
    const { store } = await createState();
    const backend = createBackend();
    const checkpoint = { create: vi.fn() };
    const service = new TaskContextService(store, backend, checkpoint, () => new Date(NEXT));

    await service.createNew({ taskId: TASK_ID, createdBy: 'ou_owner', blank: true });

    expect(checkpoint.create).not.toHaveBeenCalled();
    store.close();
  });

  it('checkpoints and activates a replacement thread opened by recovery', async () => {
    const { store, initial } = await createState({ runtimeState: 'warm' });
    const backend = createBackend();
    const checkpoint = { create: vi.fn().mockResolvedValue({ memoryId: 'memory_recovery' }) };
    const service = new TaskContextService(store, backend, checkpoint, () => new Date(NEXT));

    const adopted = await service.adoptOpenedContext({
      taskId: TASK_ID, threadId: 'thread_replacement', createdBy: 'system:thread-resume-fallback',
    });

    expect(checkpoint.create).toHaveBeenCalledWith({
      taskId: TASK_ID, context: initial, createdBy: 'system:thread-resume-fallback',
    });
    expect(adopted).toMatchObject({
      codexThreadId: 'thread_replacement', state: 'active', checkpointMemoryId: 'memory_recovery',
    });
    expect(store.getTaskContext(initial.id)).toMatchObject({ state: 'archived', archivedAt: NEXT });
    expect(store.getTask(TASK_ID)?.codexThreadId).toBe('thread_replacement');
    expect(backend.archiveContext).toHaveBeenCalledWith({ taskId: TASK_ID, threadId: 'thread_1' });
    store.close();
  });

  it('preserves the old context when app-server cannot create a thread', async () => {
    const { store, initial } = await createState();
    const backend = createBackend();
    backend.createContext.mockRejectedValueOnce(new Error('app-server unavailable'));
    const service = new TaskContextService(store, backend);

    await expect(service.createNew({ taskId: TASK_ID, createdBy: 'ou_owner' })).rejects.toThrow('app-server unavailable');

    expect(store.getActiveTaskContext(TASK_ID)).toEqual(initial);
    expect(store.listTaskContexts(TASK_ID)).toHaveLength(1);
    expect(store.getTask(TASK_ID)?.codexThreadId).toBe('thread_1');
    store.close();
  });

  it('does not create a thread when checkpoint persistence fails', async () => {
    const { store, initial } = await createState();
    const backend = createBackend();
    const checkpoint = { create: vi.fn().mockRejectedValue(new Error('checkpoint write failed')) };
    const service = new TaskContextService(store, backend, checkpoint);

    await expect(service.createNew({ taskId: TASK_ID, createdBy: 'ou_owner' })).rejects.toThrow('checkpoint write failed');

    expect(backend.createContext).not.toHaveBeenCalled();
    expect(store.getActiveTaskContext(TASK_ID)).toEqual(initial);
    store.close();
  });

  it('resumes the old thread when durable activation fails', async () => {
    const { store, initial } = await createState();
    const backend = createBackend();
    vi.spyOn(store, 'activateTaskContext').mockImplementationOnce(() => { throw new Error('sqlite full'); });
    const service = new TaskContextService(store, backend);

    await expect(service.createNew({ taskId: TASK_ID, createdBy: 'ou_owner' })).rejects.toThrow('sqlite full');

    expect(backend.resumeContext).toHaveBeenCalledWith({ taskId: TASK_ID, threadId: initial.codexThreadId });
    expect(store.getActiveTaskContext(TASK_ID)).toEqual(initial);
    store.close();
  });

  it('switches to an archived context and keeps exactly one context active', async () => {
    const { store, initial } = await createState();
    const backend = createBackend();
    const archived = context({ id: 'context_2', codexThreadId: 'thread_2', state: 'archived', archivedAt: NEXT });
    store.saveTaskContext(archived);
    const service = new TaskContextService(store, backend, undefined, () => new Date(LATER));

    const selected = await service.use({ taskId: TASK_ID, contextId: archived.id });

    expect(backend.resumeContext).toHaveBeenCalledWith({ taskId: TASK_ID, threadId: 'thread_2' });
    expect(selected).toMatchObject({ id: archived.id, state: 'active', archivedAt: undefined });
    expect(store.listTaskContexts(TASK_ID).filter((item) => item.state === 'active')).toHaveLength(1);
    expect(store.getTaskContext(initial.id)).toMatchObject({ state: 'archived', archivedAt: LATER });
    expect(service.list(TASK_ID)).toHaveLength(2);
    store.close();
  });

  it('blocks context mutations while a turn is active and delegates compaction when idle', async () => {
    const { store } = await createState({ activeTurnId: 'turn_running' });
    const backend = createBackend();
    const service = new TaskContextService(store, backend);

    await expect(service.createNew({ taskId: TASK_ID, createdBy: 'ou_owner' })).rejects.toThrow('turn is active');
    await expect(service.compact(TASK_ID)).rejects.toThrow('turn is active');
    expect(backend.createContext).not.toHaveBeenCalled();

    const task = store.getTask(TASK_ID)!;
    store.saveTask({ ...task, activeTurnId: undefined });
    await service.compact(TASK_ID);
    expect(backend.compactContext).toHaveBeenCalledWith({ taskId: TASK_ID });
    store.close();
  });

  it('records lifetime accounting and current context occupancy without rotating', async () => {
    const { store } = await createState();
    const backend = createBackend();
    const service = new TaskContextService(store, backend, undefined, () => new Date(NEXT));

    expect(service.observeUsage({
      taskId: TASK_ID, threadId: 'thread_1', usage: {
        total: { totalTokens: 70_000 }, last: { totalTokens: 7_100 }, modelContextWindow: 10_000,
      },
    })?.usage).toMatchObject({ totalTokens: 70_000, currentTokens: 7_100, modelContextWindow: 10_000 });
    service.observeUsage({
      taskId: TASK_ID, threadId: 'thread_1', usage: {
        total: { totalTokens: 80_000 }, last: { totalTokens: 8_600 }, modelContextWindow: 10_000,
      },
    });
    expect(store.getActiveTaskContext(TASK_ID)).toMatchObject({ codexThreadId: 'thread_1' });
    expect(backend.createContext).not.toHaveBeenCalled();
    expect(backend.compactContext).not.toHaveBeenCalled();
    expect(store.listTaskContexts(TASK_ID).filter((context) => context.state === 'active')).toHaveLength(1);
    store.close();
  });

  it('ignores malformed or stale-thread usage while busy', async () => {
    const { store } = await createState({ activeTurnId: 'turn_running' });
    const backend = createBackend();
    const service = new TaskContextService(store, backend);

    expect(service.observeUsage({ taskId: TASK_ID, threadId: 'stale', usage: {} })).toBeUndefined();
    expect(service.observeUsage({ taskId: TASK_ID, threadId: 'thread_1', usage: { total: {}, modelContextWindow: 10_000 } })).toBeUndefined();
    service.observeUsage({
      taskId: TASK_ID, threadId: 'thread_1', usage: {
        total: { totalTokens: 90_000 }, last: { totalTokens: 9_000 }, modelContextWindow: 10_000,
      },
    });
    expect(backend.createContext).not.toHaveBeenCalled();
    store.close();
  });

  it('reconciles the active context as authoritative and backfills a missing initial context', async () => {
    const { store, initial } = await createState();
    const service = new TaskContextService(store, createBackend(), undefined, () => new Date(NEXT));
    store.updateTask(TASK_ID, (task) => ({ ...task, codexThreadId: 'orphan_thread' }));

    expect(service.reconcile(TASK_ID)).toEqual(initial);
    expect(store.getTask(TASK_ID)?.codexThreadId).toBe('thread_1');

    store.db.prepare('DELETE FROM task_contexts WHERE task_id=?').run(TASK_ID);
    const recovered = service.reconcile(TASK_ID);
    expect(recovered).toMatchObject({ codexThreadId: 'thread_1', state: 'active', createdBy: 'system:reconciliation' });
    expect(store.getActiveTaskContext(TASK_ID)?.id).toBe(recovered?.id);
    store.close();
  });
});

const TASK_ID = 'task_1';
const NOW = '2026-07-28T01:00:00.000Z';
const NEXT = '2026-07-28T02:00:00.000Z';
const LATER = '2026-07-28T03:00:00.000Z';

async function createState(overrides: Partial<TaskRecord> = {}): Promise<{ store: SqliteStateStore; initial: TaskContextRecord }> {
  const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'), () => new Date(NOW));
  store.saveTask(task(overrides));
  const initial = context();
  store.saveTaskContext(initial);
  return { store, initial };
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: TASK_ID,
    ownerUserId: 'ou_owner',
    projectId: 'repo',
    baseRef: 'main',
    branchName: 'codex/ou_owner/task_1',
    runtimeState: 'hot',
    codexThreadId: 'thread_1',
    pinned: false,
    lastUserInteractionAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function context(overrides: Partial<TaskContextRecord> = {}): TaskContextRecord {
  return {
    id: 'context_1',
    taskId: TASK_ID,
    codexThreadId: 'thread_1',
    state: 'active',
    createdBy: 'ou_owner',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function createBackend() {
  return {
    createContext: vi.fn<NonNullable<CodexBackend['createContext']>>().mockResolvedValue({ taskId: TASK_ID, threadId: 'thread_2' }),
    resumeContext: vi.fn<NonNullable<CodexBackend['resumeContext']>>().mockImplementation(async ({ taskId, threadId }) => ({ taskId, threadId })),
    archiveContext: vi.fn<NonNullable<CodexBackend['archiveContext']>>().mockResolvedValue(undefined),
    compactContext: vi.fn<NonNullable<CodexBackend['compactContext']>>().mockResolvedValue(undefined),
  };
}
