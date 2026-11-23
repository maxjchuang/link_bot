import {describe, expect, it} from 'vitest';
import {assertPersonalAgentWorkCurrent} from '../../src/security/PersonalAgentWorkFence.js';
import {agentIdForApp} from '../../src/security/AgentExecutionIdentity.js';
import {SqliteStateStore} from '../../src/state/SqliteStateStore.js';
import {ConversationTaskService} from '../../src/tasks/ConversationTaskService.js';

describe('persisted personal-agent work fence', () => {
  it('rejects old work after revocation and re-enable, and blocks rollback/config owner changes', async () => {
    const store = new SqliteStateStore(':memory:');
    try {
      const config = {feishu: {appId: 'test-app', appSecret: 'test-secret'}, personalAgent: {enabled: true as const, ownerUserId: 'owner'}};
      const identity = {agentId: agentIdForApp(config.feishu.appId), ownerUserId: 'owner'};
      const change = (status: 'enabled'|'revoked', expectedVersion: number) => store.applyGroupServiceTransition({
        ...identity, chatId: 'oc_test', status, expectedVersion, source: 'owner',
        eventId: `change-${expectedVersion}`, occurredAt: 1000 + expectedVersion, updatedAt: 'now'});
      change('enabled', 0);
      const service = new ConversationTaskService(store, undefined, identity);
      const {task} = await service.getOrCreate({chatId: 'oc_test', chatType: 'group', userId: 'a',
        mode: 'chat', runtimeMode: 'user-sandbox', groupServiceVersion: 1});
      const work = {createdBy: 'a', groupServiceVersion: 1};
      expect(() => assertPersonalAgentWorkCurrent(config, store, task, work)).not.toThrow();
      expect(() => assertPersonalAgentWorkCurrent(config, store, task, {...work, groupServiceVersion: undefined})).toThrow();
      change('revoked', 1);
      expect(() => assertPersonalAgentWorkCurrent(config, store, task, work)).toThrow('revoked');
      change('enabled', 2);
      expect(() => assertPersonalAgentWorkCurrent(config, store, task, work)).toThrow('revoked');
      expect(() => assertPersonalAgentWorkCurrent(config, store, task, {...work, groupServiceVersion: 3})).toThrow('epoch');
      expect(() => assertPersonalAgentWorkCurrent({...config, personalAgent: {enabled: false}}, store, task, work)).toThrow();
      expect(() => assertPersonalAgentWorkCurrent({...config, personalAgent: {enabled: true, ownerUserId: 'other'}}, store, task, work)).toThrow();
      expect(() => assertPersonalAgentWorkCurrent(config, store, {...task, identityMode: undefined, agentOwnerUserId: undefined}, work)).not.toThrow();
    } finally {store.close();}
  });
});
