import { describe, expect, it, vi } from 'vitest';
import {
  AmbientTopicAuthorizer, isAmbientTopicCandidate, transitionAmbientTopicState,
  type AmbientTopicState, type AmbientTopicStateStore,
} from '../../src/feishu/AmbientChatPolicy.js';

describe('ambient topic routing', () => {
  const config = { conversationRouting: { ambientChats: [{ chatId: 'oc_ambient', name: '开发广场' }] } };

  it('dynamically enables topic replies when no extra chat restriction is configured', () => {
    const unrestricted = { conversationRouting: { ambientChats: [] } };
    expect(isAmbientTopicCandidate(unrestricted, { chatId: 'oc_any', chatType: 'group', threadId: 'omt_1', rootId: 'om_root' })).toBe(true);
    expect(isAmbientTopicCandidate(config, { chatId: 'oc_ambient', chatType: 'group', threadId: 'omt_1', rootId: 'om_root' })).toBe(true);
    expect(isAmbientTopicCandidate(config, { chatId: 'oc_ambient', chatType: 'group', threadId: 'omt_1' })).toBe(true);
    expect(isAmbientTopicCandidate(config, { chatId: 'oc_ambient', chatType: 'group' })).toBe(false);
    expect(isAmbientTopicCandidate(config, { chatId: 'oc_other', chatType: 'group', threadId: 'omt_1', rootId: 'om_root' })).toBe(false);
  });

  it('lets the root author continue in the first reply without mentioning the bot again', async () => {
    const { authorizer } = harness();
    await authorizer.observe({
      ...message('ou_one', 'om_root', '1000', true),
      rootId: undefined,
      parentId: undefined,
    });
    const firstReply = message('ou_one', 'om_reply', '2000', false);
    await authorizer.observe(firstReply);
    expect(authorizer.allows(firstReply)).toBe(true);
  });

  it('lets a user continue without mentions after explicitly mentioning the bot', async () => {
    const { authorizer } = harness();
    await authorizer.observe(message('ou_one', 'om_1', '1000', true));
    await authorizer.observe(message('ou_one', 'om_2', '2000', false));
    expect(authorizer.allows(message('ou_one', 'om_2', '2000', false))).toBe(true);
  });

  it('activates a topic dynamically when no ambient chat list is configured', async () => {
    const { store, audit } = harness();
    const authorizer = createAuthorizer(store, audit, { conversationRouting: { ambientChats: [] } });
    await authorizer.observe({ ...message('ou_one', 'om_1', '1000', true), chatId: 'oc_unlisted' });
    const followUp = { ...message('ou_one', 'om_2', '2000', false), chatId: 'oc_unlisted' };
    await authorizer.observe(followUp);
    expect(authorizer.allows(followUp)).toBe(true);
  });

  it('revokes the conversational floor when another human speaks without mentioning the bot', async () => {
    const { authorizer } = harness();
    await authorizer.observe(message('ou_one', 'om_1', '1000', true));
    await authorizer.observe(message('ou_two', 'om_2', '2000', false));
    expect(authorizer.allows(message('ou_two', 'om_2', '2000', false))).toBe(false);
    await authorizer.observe(message('ou_one', 'om_3', '3000', false));
    expect(authorizer.allows(message('ou_one', 'om_3', '3000', false))).toBe(false);
  });

  it('transfers the conversational floor when another human explicitly mentions the bot', async () => {
    const { authorizer } = harness();
    await authorizer.observe(message('ou_one', 'om_1', '1000', true));
    await authorizer.observe(message('ou_two', 'om_2', '2000', true));
    await authorizer.observe(message('ou_two', 'om_3', '3000', false));
    expect(authorizer.allows(message('ou_two', 'om_3', '3000', false))).toBe(true);
    expect(authorizer.allows(message('ou_one', 'om_3', '3000', false))).toBe(false);
  });

  it('ignores unknown mention-free topics without reading or persisting their history', async () => {
    const { authorizer, store } = harness();
    const trigger = message('ou_one', 'om_1', '1000', false);
    await authorizer.observe(trigger);
    expect(authorizer.allows(trigger)).toBe(false);
    expect(store.getAmbientTopicState('oc_ambient', 'omt_1')).toBeUndefined();
  });

  it('keeps an explicitly activated floor across authorizer reconstruction', async () => {
    const first = harness();
    await first.authorizer.observe(message('ou_one', 'om_1', '1000', true));
    const restarted = createAuthorizer(first.store, first.audit);
    const trigger = message('ou_one', 'om_2', '2000', false);
    await restarted.observe(trigger);
    expect(restarted.allows(trigger)).toBe(true);
  });

  it('ignores delayed older events so they cannot steal the current floor', async () => {
    const { authorizer, store } = harness();
    await authorizer.observe(message('ou_two', 'om_new', '3000', true));
    await authorizer.observe(message('ou_one', 'om_old', '2000', true));
    expect(store.getAmbientTopicState('oc_ambient', 'omt_1')).toMatchObject({
      activeSpeakerUserId: 'ou_two', lastMessageId: 'om_new',
    });
    expect(authorizer.allows(message('ou_one', 'om_old', '2000', false))).toBe(false);
  });

  it('clears durable floor state when the topic closes', async () => {
    const { authorizer, store } = harness();
    await authorizer.observe(message('ou_one', 'om_1', '1000', true));
    authorizer.clear('oc_ambient', 'omt_1');
    expect(store.getAmbientTopicState('oc_ambient', 'omt_1')).toBeUndefined();
  });
});

function harness() {
  const rows = new Map<string, AmbientTopicState>();
  const store = {
    getAmbientTopicState: (chatId: string, topicId: string) => rows.get(`${chatId}:${topicId}`),
    applyAmbientTopicMessage: (input: Parameters<typeof transitionAmbientTopicState>[1] & { seed?: AmbientTopicState }) => {
      const key = `${input.chatId}:${input.topicId}`;
      const next = transitionAmbientTopicState(rows.get(key) ?? input.seed, input, '2026-09-03T00:00:00Z');
      rows.set(key, next);
      return next;
    },
    deleteAmbientTopicState: (chatId: string, topicId: string) => { rows.delete(`${chatId}:${topicId}`); },
  };
  const audit = vi.fn();
  const authorizer = createAuthorizer(store, audit);
  return { authorizer, store, audit };
}

function createAuthorizer(
  store: AmbientTopicStateStore, audit: ReturnType<typeof vi.fn<(...args: any[]) => any>>,
  config: { conversationRouting: { ambientChats: Array<{ chatId: string; name?: string }> } }
    = { conversationRouting: { ambientChats: [{ chatId: 'oc_ambient', name: '开发广场' }] } },
) {
  return new AmbientTopicAuthorizer(
    config,
    store,
    { audit, clock: () => new Date('2026-09-03T00:00:00Z') },
  );
}

function message(userId: string, messageId: string, createdAt: string, wasMentioned: boolean) {
  return {
    chatId: 'oc_ambient', chatType: 'group' as const, threadId: 'omt_1', rootId: 'om_root',
    userId, messageId, createdAt, text: '消息', wasMentioned,
  };
}
