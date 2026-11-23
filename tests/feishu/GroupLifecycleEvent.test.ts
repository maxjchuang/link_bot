import {describe, expect, it} from 'vitest';
import {normalizeGroupLifecycleEvent} from '../../src/feishu/GroupLifecycleEvent.js';

const event = {app_id: 'app_test', event_type: 'im.chat.member.bot.added_v1', event_id: 'evt_test',
  chat_id: 'oc_group', create_time: '1000', operator_id: {open_id: 'ou_owner'}};

describe('trusted SDK lifecycle normalization', () => {
  it('retains identity, time and operator from flattened SDK fields', () => {
    expect(normalizeGroupLifecycleEvent(event, 'app_test', 'added')).toEqual({kind: 'added', eventId: 'evt_test',
      chatId: 'oc_group', occurredAt: 1000, operatorUserId: 'ou_owner'});
  });
  it('does not invent an inviter when the platform omits it', () => {
    expect(normalizeGroupLifecycleEvent({...event, operator_id: undefined}, 'app_test', 'added'))
      .not.toHaveProperty('operatorUserId');
  });
  it.each([
    {app_id: 'wrong'}, {app_id: undefined}, {event_type: 'im.chat.member.user.added_v1'},
    {event_id: ''}, {chat_id: ''}, {create_time: 'NaN'}, {create_time: '0'},
    {create_time: '1000.5'}, {create_time: '9007199254740992'},
  ])('rejects malformed or wrong-app envelopes: %j', patch => {
    expect(normalizeGroupLifecycleEvent({...event, ...patch}, 'app_test', 'added')).toBeUndefined();
  });
  it('normalizes removal without requiring an operator', () => {
    expect(normalizeGroupLifecycleEvent({...event, event_type: 'im.chat.member.bot.deleted_v1', operator_id: undefined},
      'app_test', 'removed')).toMatchObject({kind: 'removed'});
  });
});
