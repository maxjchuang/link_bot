import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteStateStore } from '../../src/state/SqliteStateStore.js';
import {
  ConversationTaskService, conversationTaskIdentity, taskIdForScope,
} from '../../src/tasks/ConversationTaskService.js';
import { createTmpDir } from '../helpers/tmp.js';
import { taskMode } from '../../src/tasks/TaskTypes.js';

describe('ConversationTaskService', () => {
  it('reuses one project-free task for repeated messages in the same topic', async () => {
    const store = await createStore();
    const service = new ConversationTaskService(store, () => new Date(NOW));
    const actor = { chatType: 'group' as const, chatId: 'oc_group', topicId: 'omt_chat', userId: 'ou_owner' };

    const first = await service.getOrCreate({ ...actor, mode: 'chat', runtimeMode: 'user-sandbox' });
    const second = await service.getOrCreate({ ...actor, mode: 'chat', runtimeMode: 'user-sandbox' });

    expect(second.task.id).toBe(first.task.id);
    expect(first.task).not.toHaveProperty('projectId');
    expect(first.task.baseRef).toBe('');
    expect(first.task.branchName).toBe('');
    expect(taskMode(first.task)).toBe('chat');
    const legacy = await service.getOrCreate({ ...actor, topicId: 'omt_project', projectId: 'repo' });
    expect(taskMode(legacy.task)).toBe('project');
    store.close();
  });

  it('atomically creates one deterministic task for repeated and concurrent private messages', async () => {
    const store = await createStore();
    const service = new ConversationTaskService(store, () => new Date(NOW));
    const actor = { chatType: 'private' as const, chatId: 'oc_private', userId: 'ou_1' };

    const results = await Promise.all(Array.from({ length: 12 }, () => service.getOrCreate({ ...actor, projectId: 'repo' })));

    expect(new Set(results.map((result) => result.task.id))).toEqual(new Set([taskIdForScope('private:ou_1')]));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(store.listTasks()).toHaveLength(1);
    expect(store.getTaskMembership(results[0]!.task.id, 'ou_1')).toMatchObject({ role: 'owner', status: 'active' });
    store.close();
  });

  it('creates personal group and topic tasks per authenticated user', async () => {
    const store = await createStore();
    const service = new ConversationTaskService(store, () => new Date(NOW));
    const groupOwner = { chatType: 'group' as const, chatId: 'oc_group', userId: 'ou_owner' };
    const groupMember = { ...groupOwner, userId: 'ou_member' };
    const topicA = { ...groupOwner, topicId: 'topic_a' };
    const topicAOther = { ...topicA, userId: 'ou_member' };
    const topicB = { ...groupOwner, topicId: 'topic_b' };

    const parent = await service.getOrCreate({ ...groupOwner, projectId: 'repo' });
    const sameParent = await service.getOrCreate({ ...groupMember, projectId: 'repo' });
    const firstTopic = await service.getOrCreate({ ...topicA, projectId: 'repo' });
    const sameTopic = await service.getOrCreate({ ...topicAOther, projectId: 'repo' });
    const sibling = await service.getOrCreate({ ...topicB, projectId: 'repo' });

    expect(sameParent.task.id).not.toBe(parent.task.id);
    expect(sameTopic.task.id).not.toBe(firstTopic.task.id);
    expect(new Set([parent.task.id, sameParent.task.id, firstTopic.task.id, sameTopic.task.id, sibling.task.id]).size).toBe(5);
    expect(conversationTaskIdentity(topicA).scopeKey).toBe('personal-topic:ou_owner:oc_group:topic_a');
    expect(store.getTaskMembership(parent.task.id, 'ou_owner')).toMatchObject({ role: 'owner', status: 'active' });
    expect(store.getTaskMembership(parent.task.id, 'ou_member')).toBeUndefined();
    store.close();
  });

  it('keeps all actions and membership scoped to the personal task owner', async () => {
    const store = await createStore();
    const service = new ConversationTaskService(store, () => new Date(NOW));
    const owner = { chatType: 'group' as const, chatId: 'oc_group', userId: 'ou_owner' };
    const member = { ...owner, userId: 'ou_member' };
    const task = (await service.getOrCreate({ ...owner, projectId: 'repo' })).task;
    const memberTask = (await service.getOrCreate({ ...member, projectId: 'repo' })).task;
    const recency = task.lastUserInteractionAt;

    expect(memberTask.id).not.toBe(task.id);
    expect(() => service.authorize(task.id, 'ou_member', 'message')).toThrow('not active');
    expect(service.authorize(memberTask.id, 'ou_member', 'publish').role).toBe('owner');
    expect(service.authorize(task.id, 'ou_owner', 'delete').role).toBe('owner');
    expect(store.getTask(task.id)?.lastUserInteractionAt).toBe(recency);
    store.close();
  });

  it('continues an existing shared legacy task without migrating it in place', async () => {
    const store = await createStore();
    const service = new ConversationTaskService(store, () => new Date(NOW));
    const task = {
      id: 'task_legacy', ownerUserId: 'ou_owner', projectId: 'repo', baseRef: 'main', branchName: 'legacy',
      runtimeMode: 'legacy-task-container' as const, runtimeState: 'warm' as const, pinned: false,
      lastUserInteractionAt: NOW, createdAt: NOW, updatedAt: NOW,
    };
    store.saveTask(task);
    store.saveTaskScope({
      taskId: task.id, scope: 'group', scopeKey: 'group:oc_group', chatId: 'oc_group', status: 'canonical',
      createdAt: NOW, updatedAt: NOW,
    });
    store.saveTaskMembership({
      id: 'membership:task_legacy:ou_owner', taskId: task.id, userId: 'ou_owner', role: 'owner', status: 'active',
      createdAt: NOW, updatedAt: NOW,
    });

    const continued = await service.getOrCreate({
      chatType: 'group', chatId: 'oc_group', userId: 'ou_member', projectId: 'repo',
    });

    expect(continued).toMatchObject({ created: false, task: { id: 'task_legacy' } });
    expect(store.getTaskMembership('task_legacy', 'ou_member')).toMatchObject({ role: 'member', status: 'active' });
    expect(store.getTaskScopeByKey('personal-group:ou_member:oc_group')).toBeUndefined();
    store.close();
  });

  it.each([
    ['topic', false], ['topic', true], ['group', false], ['group', true],
  ] as const)('starts one personal successor after a legacy %s expires (explicit reason: %s)', async (scope, explicitReason) => {
    const store = await createStore();
    const service = new ConversationTaskService(store, () => new Date(NOW));
    const topic = { chatType: 'group' as const, chatId: 'oc_group',
      ...(scope === 'topic' ? { topicId: 'topic_old' } : {}), userId: 'ou_owner' };
    const legacyScopeKey = scope === 'topic' ? 'topic:oc_group:topic_old' : 'group:oc_group';
    const personalScopeKey = conversationTaskIdentity(topic).scopeKey;
    store.saveTask({
      id: 'task_legacy', ownerUserId: topic.userId, projectId: 'repo', baseRef: 'main',
      branchName: 'legacy', runtimeState: 'warm', codexThreadId: 'old_thread', pinned: false,
      lastUserInteractionAt: NOW, createdAt: NOW, updatedAt: NOW,
    });
    store.saveTaskScope({
      taskId: 'task_legacy', scope, scopeKey: legacyScopeKey,
      chatId: topic.chatId, topicId: topic.topicId, status: 'canonical', createdAt: NOW, updatedAt: NOW,
    });
    const intent = { id: 'disk_cleanup_expired', taskId: 'task_legacy', fromState: 'warm' as const,
      toState: 'archived' as const, status: 'pending' as const, createdAt: NOW, updatedAt: NOW };
    store.beginLifecycleIntent(intent);
    store.completeLifecycleIntent(intent.id, 'archived');
    if (explicitReason) store.updateTask('task_legacy', (task) => ({ ...task, archiveReason: 'warm_retention_expired' }));

    expect(service.shouldStartSuccessor(topic)).toBe(true);
    const [first, second] = await Promise.all([service.getOrCreate({ ...topic, projectId: 'repo', runtimeMode: 'user-sandbox' }),
      service.getOrCreate({ ...topic, projectId: 'repo', runtimeMode: 'user-sandbox' })]);

    expect(first.task.id).toBe(taskIdForScope(personalScopeKey));
    expect(second.task.id).toBe(first.task.id);
    expect(store.getTask('task_legacy')?.runtimeState).toBe('archived');
    expect(store.getTaskScopeByKey(legacyScopeKey)?.taskId).toBe('task_legacy');
    expect(service.resolve(topic)?.task.id).toBe(first.task.id);
    store.close();
  });

  it.each(['topic', 'group'] as const)('keeps an explicitly archived legacy %s closed', async (scope) => {
    const store = await createStore();
    const service = new ConversationTaskService(store, () => new Date(NOW));
    const actor = { chatType: 'group' as const, chatId: 'oc_group', userId: 'ou_owner',
      ...(scope === 'topic' ? { topicId: 'topic_old' } : {}) };
    store.saveTask({
      id: 'task_legacy', ownerUserId: actor.userId, projectId: 'repo', baseRef: 'main',
      branchName: 'legacy', runtimeState: 'warm', codexThreadId: 'old_thread', pinned: false,
      lastUserInteractionAt: NOW, createdAt: NOW, updatedAt: NOW,
    });
    store.saveTaskScope({
      taskId: 'task_legacy', scope, scopeKey: scope === 'topic' ? 'topic:oc_group:topic_old' : 'group:oc_group',
      chatId: actor.chatId, topicId: actor.topicId, status: 'canonical', createdAt: NOW, updatedAt: NOW,
    });
    store.beginLifecycleIntent({ id: 'disk_cleanup_expired', taskId: 'task_legacy',
      fromState: 'warm', toState: 'archived', status: 'pending', createdAt: NOW, updatedAt: NOW });
    store.completeLifecycleIntent('disk_cleanup_expired', 'archived');
    store.updateTask('task_legacy', (task) => ({ ...task, archiveReason: 'explicit' }));

    expect(service.shouldStartSuccessor(actor)).toBe(false);
    const result = await service.getOrCreate({ ...actor, projectId: 'repo', runtimeMode: 'user-sandbox' });
    expect(result.created).toBe(false);
    expect(result.task.id).toBe('task_legacy');
    expect(result.task.runtimeState).toBe('archived');
    store.close();
  });

  it('does not let a different private user resolve or join another private task', async () => {
    const store = await createStore();
    const service = new ConversationTaskService(store, () => new Date(NOW));
    const first = await service.getOrCreate({ chatType: 'private', chatId: 'oc_1', userId: 'ou_1', projectId: 'repo' });
    const second = await service.getOrCreate({ chatType: 'private', chatId: 'oc_2', userId: 'ou_2', projectId: 'repo' });

    expect(first.task.id).not.toBe(second.task.id);
    expect(service.resolve({ chatType: 'private', chatId: 'oc_1', userId: 'ou_2' })?.task.id).toBe(second.task.id);
    expect(() => service.authorize(first.task.id, 'ou_2', 'message')).toThrow('not active');
    store.close();
  });
});

const NOW = '2026-07-28T06:00:00.000Z';

async function createStore(): Promise<SqliteStateStore> {
  return new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'), () => new Date(NOW));
}
