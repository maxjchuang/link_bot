import {describe, expect, it, vi} from 'vitest';
import {PersonalAgentAdmission} from '../../src/security/PersonalAgentAdmission.js';
import {agentIdForApp} from '../../src/security/AgentExecutionIdentity.js';
import {SqliteStateStore} from '../../src/state/SqliteStateStore.js';
import type {BotConfig} from '../../src/domain/types.js';

function fixture() {
  const store = new SqliteStateStore(':memory:');
  const config: Pick<BotConfig, 'personalAgent'|'feishu'|'restrictChatIds'|'allowedChatIds'> = {
    personalAgent: {enabled: true, ownerUserId: 'ou_owner'},
    feishu: {appId: 'app_test', appSecret: 'not-real'}, restrictChatIds: false, allowedChatIds: []};
  const member = vi.fn(async () => true);
  const grant = {agentId: agentIdForApp('app_test'), chatId: 'oc_test', ownerUserId: 'ou_owner',
    status: 'enabled' as const, eventId: 'enable', source: 'owner' as const,
    expectedVersion: 0, occurredAt: 1000, updatedAt: 'now'};
  store.applyGroupServiceTransition(grant);
  return {store, config, member, grant, admission: new PersonalAgentAdmission(config, store, member)};
}
const actor = {chatId: 'oc_test', chatType: 'group' as const, userId: 'ou_a', messageId: 'message'};

describe('personal-agent ordinary task admission', () => {
  it('admits current A/B members only in the enabled group without changing admin/user lists', async () => {
    const h = fixture(); try {
      const before = JSON.stringify(h.config);
      for (const userId of ['ou_a','ou_b']) expect(await h.admission.admit({...actor, userId, groupServiceVersion: 999}))
        .toEqual({...actor, userId, groupServiceVersion: 1});
      expect(JSON.stringify(h.config)).toBe(before);
      expect(await h.admission.admit({...actor, chatId: 'oc_other'})).toBeUndefined();
    } finally {h.store.close();}
  });
  it('does not open nonowner private chats or trust a user-supplied version', async () => {
    const h = fixture(); try {
      expect(await h.admission.admit({...actor, chatType: 'private'})).toBeUndefined();
      expect(await h.admission.admit({...actor, chatType: 'private', userId: 'ou_owner', groupServiceVersion: 999}))
        .toEqual({...actor, chatType: 'private', userId: 'ou_owner'});
    } finally {h.store.close();}
  });
  it.each(['off','wrong_owner','chat_restricted','not_member','query_failed','revoked','revoked_during_query','reenabled_during_query'])(
    'fails closed on %s', async scenario => {
      const h = fixture(); try {
        const revoke = () => h.store.applyGroupServiceTransition({...h.grant, status: 'revoked',
          eventId: 'disable', expectedVersion: 1, occurredAt: 2000});
        if (scenario === 'off') h.config.personalAgent = {enabled: false};
        if (scenario === 'wrong_owner') h.config.personalAgent = {enabled: true, ownerUserId: 'ou_other'};
        if (scenario === 'chat_restricted') h.config.restrictChatIds = true;
        if (scenario === 'not_member') h.member.mockResolvedValue(false);
        if (scenario === 'query_failed') h.member.mockRejectedValue(new Error('unavailable'));
        if (scenario === 'revoked') revoke();
        if (scenario.endsWith('during_query')) h.member.mockImplementation(async () => {
          revoke();
          if (scenario.startsWith('reenabled')) h.store.applyGroupServiceTransition({...h.grant,
            eventId: 'new-enable', expectedVersion: 2, occurredAt: 3000});
          return true;
        });
        expect(await h.admission.admit(actor)).toBeUndefined();
      } finally {h.store.close();}
    });
  it('does not cache member success across subsequent inputs', async () => {
    const h = fixture(); try {
      expect(await h.admission.admit(actor)).toBeDefined();
      h.member.mockResolvedValueOnce(false);
      expect(await h.admission.admit(actor)).toBeUndefined();
      expect(h.member).toHaveBeenCalledTimes(2);
    } finally {h.store.close();}
  });
});
