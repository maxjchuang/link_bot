import {describe, expect, it} from 'vitest';
import {SqliteStateStore} from '../../src/state/SqliteStateStore.js';
import {ConversationTaskService} from '../../src/tasks/ConversationTaskService.js';

const identity = {agentId: 'agent_test', ownerUserId: 'ou_owner'};
const a = {chatId: 'oc_group', chatType: 'group' as const, topicId: 'topic', userId: 'ou_a', groupServiceVersion: 1};
const create = {...a, mode: 'chat' as const, runtimeMode: 'user-sandbox' as const};
function fixture() {
  const store = new SqliteStateStore(':memory:');
  for (const chatId of ['oc_group','oc_other']) store.applyGroupServiceTransition({
    ...identity, chatId, ownerUserId: identity.ownerUserId, status: 'enabled', eventId: chatId,
    source: 'owner', expectedVersion: 0, occurredAt: 1000, updatedAt: 'now',
  });
  return {store, service: new ConversationTaskService(store, undefined, identity)};
}

describe('personal-agent conversation identity', () => {
  it('creates one shared task for concurrent A/B inputs without making either the owner', async () => {
    const h = fixture(); try {
      const results = await Promise.all(Array.from({length: 12}, (_, i) => h.service.getOrCreate({...create, userId: i % 2 ? 'ou_b' : 'ou_a'})));
      expect(new Set(results.map(r => r.task.id)).size).toBe(1);
      expect(results.filter(r => r.created)).toHaveLength(1);
      const {task, scope} = results[0];
      expect(task).toMatchObject({ownerUserId: 'ou_owner', agentOwnerUserId: 'ou_owner', identityMode: 'personal-agent'});
      expect(scope.scopeKey).toBe('agent-topic:agent_test:oc_group:topic:service:1');
      for (const user of ['ou_a','ou_b']) {
        expect(h.store.getTaskMembership(task.id, user)?.role).toBe('member');
        expect(h.service.authorize(task.id, user, 'message', 1).userId).toBe(user);
        for (const action of ['delete','membership','memory_admin','global_memory'] as const)
          expect(() => h.service.authorize(task.id, user, action, 1)).toThrow('owner');
      }
      expect(h.service.authorize(task.id, 'ou_owner', 'delete', 1).role).toBe('owner');
      expect(h.service.resolve({...a, userId: 'ou_b'})?.task.id).toBe(task.id);
    } finally {h.store.close();}
  });

  it('isolates group, topic, purpose and agent; never falls back to personal or legacy scopes', async () => {
    const h = fixture(); try {
      const legacy = new ConversationTaskService(h.store);
      const old = await legacy.getOrCreate(create);
      const shared = await h.service.getOrCreate(create);
      const siblings = await Promise.all([
        h.service.getOrCreate({...create, topicId: 'other'}),
        h.service.getOrCreate({...create, chatId: 'oc_other'}),
        h.service.getOrCreate({...create, taskPurpose: 'workflow'}),
        h.service.getOrCreate({...create, topicId: undefined}),
      ]);
      expect(new Set([old.task.id, shared.task.id, ...siblings.map(s => s.task.id)]).size).toBe(6);
      expect(h.store.getTask(old.task.id)?.identityMode).toBeUndefined();
      expect(legacy.resolve(a)?.task.id).toBe(old.task.id);
      expect(siblings[3].scope.scopeKey).toBe('agent-group:agent_test:oc_group:service:1');
    } finally {h.store.close();}
  });

  it('rejects missing/stale group epochs and non-owner private chat', async () => {
    const h = fixture(); try {
      await expect(h.service.getOrCreate({...create, groupServiceVersion: undefined})).rejects.toThrow('service');
      await expect(h.service.getOrCreate({...create, groupServiceVersion: 2})).rejects.toThrow('service');
      await expect(h.service.getOrCreate({...create, chatType: 'private', topicId: undefined})).rejects.toThrow('owner');
      const own = await h.service.getOrCreate({...create, chatType: 'private', userId: 'ou_owner', topicId: undefined});
      expect(own.scope.scopeKey).toContain('agent-private:agent_test:');
      const shared = await h.service.getOrCreate(create);
      h.store.applyGroupServiceTransition({...identity, chatId: 'oc_group', status: 'revoked', eventId: 'stop',
        expectedVersion: 1, occurredAt: 2000, source: 'owner', updatedAt: 'now'});
      expect(() => h.service.resolve(a)).toThrow('service');
      expect(() => h.service.authorize(shared.task.id, 'ou_a', 'message', 1)).toThrow('service');
      await expect(h.service.getOrCreate(create)).rejects.toThrow('service');
      expect(h.store.getTask(shared.task.id)?.identityMode).toBe('personal-agent');
    } finally {h.store.close();}
  });

  it('does not trust a persisted administrator membership to grant owner actions', async () => {
    const h = fixture(); try {
      const {task} = await h.service.getOrCreate(create);
      const member = h.store.getTaskMembership(task.id, 'ou_a')!;
      h.store.saveTaskMembership({...member, role: 'administrator'});
      expect(() => h.service.authorize(task.id, 'ou_a', 'membership', 1)).toThrow('owner');
    } finally {h.store.close();}
  });

  it('uses a new shared task after re-enable instead of reviving old work or private history', async () => {
    const h = fixture(); try {
      const previous = await h.service.getOrCreate(create);
      h.store.applyGroupServiceTransition({...identity, chatId: 'oc_group', status: 'revoked', eventId: 'remove',
        expectedVersion: 1, occurredAt: 2000, source: 'owner', updatedAt: 'now'});
      h.store.applyGroupServiceTransition({...identity, chatId: 'oc_group', status: 'enabled', eventId: 'enable-again',
        expectedVersion: 2, occurredAt: 3000, source: 'owner', updatedAt: 'now'});
      const next = await h.service.getOrCreate({...create, groupServiceVersion: 3});
      expect(next.task.id).not.toBe(previous.task.id);
      expect(next.task.groupServiceVersion).toBe(3);
      expect(h.store.getTask(previous.task.id)?.groupServiceVersion).toBe(1);
      expect(() => h.store.updateTask(previous.task.id, current => ({...current, groupServiceVersion: 3}))).toThrow('immutable');
    } finally {h.store.close();}
  });

  it('refuses insertion if service is revoked after resolution but before the creation transaction', async () => {
    const h = fixture(); try {
      const original = h.store.createConversationTask.bind(h.store);
      h.store.createConversationTask = input => {
        h.store.applyGroupServiceTransition({...identity, chatId: 'oc_group', status: 'revoked', eventId: 'race-stop',
          expectedVersion: 1, occurredAt: 2000, source: 'owner', updatedAt: 'now'});
        return original(input);
      };
      await expect(h.service.getOrCreate(create)).rejects.toThrow('service');
      expect(h.store.listTasks()).toHaveLength(0);
    } finally {h.store.close();}
  });
});
