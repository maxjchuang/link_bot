import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MemoryCheckpointWriter } from '../../src/memory/MemoryCheckpointWriter.js';
import { MemoryProjectionService } from '../../src/memory/MemoryProjectionService.js';
import { MemoryService } from '../../src/memory/MemoryService.js';
import { SqliteStateStore } from '../../src/state/SqliteStateStore.js';
import type { TaskContextRecord, TaskRecord } from '../../src/tasks/TaskTypes.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('MemoryProjectionService', () => {
  it('builds one deterministic atomic batch from task memory only and redacts possible secrets', async () => {
    const { store, memory, actor } = await harness();
    memory.remember({ actor, scope: 'task', kind: 'decision', title: 'Use SQLite', content: 'SQLite is authoritative.' });
    memory.remember({ actor, scope: 'task', kind: 'todo', title: 'Rotate keys', content: 'API_KEY="abcdefghijklmnop"' });
    memory.remember({ actor, scope: 'user', kind: 'fact', title: 'Private profile', content: 'must never enter task projection' });
    const replace = vi.fn(async () => undefined);
    const projection = new MemoryProjectionService(store, { replace });

    const first = await projection.rebuild('task_1');
    const second = await projection.rebuild('task_1');

    expect([...second]).toEqual([...first]);
    expect(replace).toHaveBeenCalledTimes(2);
    expect(first.get('INDEX.md')).toContain('Use SQLite');
    expect(first.get('DECISIONS.md')).toContain('SQLite is authoritative.');
    expect(first.get('TODO.md')).toContain('[redacted: possible secret]');
    expect([...first.values()].join('\n')).not.toContain('must never enter task projection');
    expect([...first.keys()]).toEqual(expect.arrayContaining([
      'INDEX.md', 'CURRENT.md', 'MEMORY.md', 'DECISIONS.md', 'TODO.md', 'PROJECTS.md', 'LAST_DREAM.md',
    ]));
    store.close();
  });
});

describe('MemoryCheckpointWriter', () => {
  it('does not mistake a completed binding turn for a completed business objective',async()=>{
    const {store}=await harness();
    store.saveTurn({id:'source',taskId:'task_1',state:'completed',prompt:'查清权限身份问题',createdBy:'ou_1',createdAt:NOW,updatedAt:NOW});
    store.updateTask('task_1',task=>({...task,pendingProjectBind:{projectId:'repo',requestedBy:'ou_1',status:'requested',requestedAt:NOW,updatedAt:NOW,
      resumeAfterBind:{turnId:'source',text:'查清权限身份问题'}}}));
    const writer=new MemoryCheckpointWriter(store,()=>new Date(NOW));
    const checkpoint=await writer.create({taskId:'task_1',context:store.getActiveTaskContext('task_1')!,createdBy:'ou_1'});
    expect(JSON.parse(store.getMemoryEntry(checkpoint.memoryId)!.content)).toMatchObject({objective:'查清权限身份问题',completedWork:[],outstandingWork:['查清权限身份问题'],nextActions:['查清权限身份问题']});
    store.close();
  });
  it('idempotently checkpoints objective, repositories, completed work, failures, and next actions', async () => {
    const { store } = await harness();
    store.saveTaskRepository({
      id: 'repository_1', taskId: 'task_1', projectId: 'repo', checkoutPath: '/workspace', baseRef: 'main',
      baseCommit: 'base_sha', branchName: 'codex/ou_1/task_1', isPrimary: true, addedBy: 'ou_1', status: 'ready',
      createdAt: NOW, updatedAt: NOW,
    });
    store.saveTurn({
      id: 'turn_1', taskId: 'task_1', state: 'completed', prompt: 'finish schema', createdBy: 'ou_1',
      createdAt: NOW, updatedAt: NOW, completedAt: NOW,
    });
    store.saveTurn({
      id: 'turn_2', taskId: 'task_1', state: 'failed', prompt: 'deploy service', createdBy: 'ou_1',
      failure: 'deployment failed', createdAt: NOW, updatedAt: NOW, completedAt: NOW,
    });
    const writer = new MemoryCheckpointWriter(store, () => new Date(NOW));
    const context = store.getActiveTaskContext('task_1')!;

    const first = await writer.create({ taskId: 'task_1', context, createdBy: 'ou_1' });
    const second = await writer.create({ taskId: 'task_1', context, createdBy: 'ou_1' });

    expect(second).toEqual(first);
    expect(store.listMemoryEntries('task', 'task_1')).toHaveLength(1);
    const checkpoint = store.getMemoryEntry(first.memoryId)!;
    expect(checkpoint.content).toContain('deploy service');
    expect(checkpoint.content).toContain('base_sha');
    expect(checkpoint.content).toContain('deployment failed');
    store.close();
  });
});

const NOW = '2026-07-28T06:00:00.000Z';

async function harness() {
  const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'), () => new Date(NOW));
  const task: TaskRecord = {
    id: 'task_1', ownerUserId: 'ou_1', projectId: 'repo', baseRef: 'main', branchName: 'codex/ou_1/task_1',
    runtimeState: 'hot', pinned: false, lastUserInteractionAt: NOW, createdAt: NOW, updatedAt: NOW,
  };
  const context: TaskContextRecord = {
    id: 'context_1', taskId: task.id, codexThreadId: 'thread_1', state: 'active', createdBy: 'ou_1',
    createdAt: NOW, updatedAt: NOW,
  };
  store.saveTask(task);
  store.saveTaskMembership({
    id: 'membership_1', taskId: task.id, userId: 'ou_1', role: 'owner', status: 'active', createdAt: NOW, updatedAt: NOW,
  });
  store.saveTaskContext(context);
  const actor = { taskId: task.id, contextId: context.id, userId: 'ou_1' };
  return { store, actor, memory: new MemoryService(store, () => new Date(NOW)) };
}
