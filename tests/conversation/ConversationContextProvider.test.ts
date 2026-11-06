import { describe, expect, it, vi } from 'vitest';
import { FeishuConversationContextProvider, type FeishuHistoryClient } from '../../src/conversation/ConversationContextProvider.js';
import type { ConversationContextConfig } from '../../src/domain/types.js';

const config: ConversationContextConfig = {
  enabled: true,
  group: { maxMessages: 3, lookbackHours: 24, maxChars: 1_000 },
  topic: { maxMessages: 4, maxChars: 1_000 },
  requestTimeoutMs: 1_000,
  incremental: true,
  includeMediaPlaceholders: true,
};

describe('FeishuConversationContextProvider', () => {
  it.each([true,false])('retains a shared-chat topic root as a reference without fetching the target chat (media placeholders=%s)',async(includeMediaPlaceholders)=>{
    const client=fakeClient({root:raw('om_card','1000','',{messageType:'share_chat',content:'{"chat_id":"oc_fixture_shared_chat"}',threadId:'omt_1'}),thread:[[]]});
    const provider=new FeishuConversationContextProvider(client,{...config,includeMediaPlaceholders});
    const context=await provider.collect({chatId:'oc_current',threadId:'omt_1',rootId:'om_card',triggerMessageId:'om_trigger',triggerCreatedAt:'3000',requesterUserId:'ou_owner'});
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0]).toMatchObject({messageType:'share_chat',sharedChat:{chatId:'oc_fixture_shared_chat'}});
    expect(context.messages[0]?.text).toContain('chat_id=oc_fixture_shared_chat');
    expect(client.listMessages).toHaveBeenCalledTimes(1);
    expect(client.listMessages).toHaveBeenCalledWith(expect.objectContaining({containerType:'thread',containerId:'omt_1'}));
  });
  it.each(['{}','[]','not-json','{"chat_id":"javascript:invalid"}'])('retains an explicit unavailable marker for malformed shared-chat content: %s',async(content)=>{
    const client=fakeClient({root:raw('om_card','1000','',{messageType:'share_chat',content,threadId:'omt_1'}),thread:[[]]});
    const result=await new FeishuConversationContextProvider(client,config).collect({chatId:'oc_current',threadId:'omt_1',rootId:'om_card',triggerMessageId:'om_trigger',triggerCreatedAt:'3000',requesterUserId:'ou_owner'});
    expect(result.messages[0]?.text).toBe('[Shared chat card: target chat ID unavailable]');
    expect(result.messages[0]?.sharedChat).toBeUndefined();
  });
  it('collects only pre-trigger group messages in chronological order', async () => {
    const client = fakeClient({
      chat: [[
        raw('om_trigger', '3000', '@bot fix it'), raw('om_2', '2000', 'second'), raw('om_1', '1000', 'first'),
      ]],
    });
    const provider = new FeishuConversationContextProvider(client, config, () => new Date('1970-01-01T00:00:04Z'));

    const result = await provider.collect({
      chatId: 'oc_1', triggerMessageId: 'om_trigger', triggerCreatedAt: '3000', requesterUserId: 'ou_owner',
    });

    expect(result.messages.map((message) => message.text)).toEqual(['first', 'second']);
    expect(client.listMessages).toHaveBeenCalledWith(expect.objectContaining({ containerType: 'chat', containerId: 'oc_1' }));
    expect(result.lastMessage).toEqual({ messageId: 'om_2', createdAt: '2000' });
  });

  it('collects a topic root and replies without reading the parent chat', async () => {
    const client = fakeClient({
      root: raw('om_root', '1000', 'topic problem', { threadId: 'omt_1' }),
      thread: [[raw('om_reply', '2000', 'analysis', { threadId: 'omt_1', rootId: 'om_root' }), raw('om_trigger', '3000', '@bot', { threadId: 'omt_1', rootId: 'om_root' })]],
    });
    const provider = new FeishuConversationContextProvider(client, config);

    const result = await provider.collect({
      chatId: 'oc_1', threadId: 'omt_1', rootId: 'om_root', triggerMessageId: 'om_trigger',
      triggerCreatedAt: '3000', requesterUserId: 'ou_owner',
    });

    expect(result.scope).toBe('topic');
    expect(result.messages.map((message) => message.text)).toEqual(['topic problem', 'analysis']);
    expect(client.getMessage).toHaveBeenCalledWith('om_root');
    expect(client.listMessages).toHaveBeenCalledWith(expect.objectContaining({ containerType: 'thread', containerId: 'omt_1' }));
    expect(client.listMessages).not.toHaveBeenCalledWith(expect.objectContaining({ containerType: 'chat' }));
  });

  it('expands a merge-forward topic root and exposes its downloadable images', async () => {
    const image = { messageId: 'om_child_2', imageKey: 'img_1', dataUrl: 'data:image/png;base64,AQ==' };
    const client = fakeClient({
      root: raw('om_root', '1000', '', {
        messageType: 'merge_forward', content: '{}', threadId: 'omt_1', images: [image],
        forwardedMessages: [
          raw('om_child_1', '900', '埋点参数取值错误', { senderName: 'Reporter' }),
          raw('om_child_2', '950', '', { messageType: 'image', content: '{"image_key":"img_1"}', images: [image] }),
        ],
      }),
      thread: [[raw('om_root', '1000', '', {
        messageType: 'merge_forward', content: 'Merged and Forwarded Message', threadId: 'omt_1',
      })]],
    });
    const provider = new FeishuConversationContextProvider(client, config);

    const result = await provider.collect({
      chatId: 'oc_1', threadId: 'omt_1', rootId: 'om_root', triggerMessageId: 'om_trigger',
      triggerCreatedAt: '3000', requesterUserId: 'ou_owner',
    });

    expect(result.messages[0]?.text).toContain('Reporter:\n埋点参数取值错误');
    expect(result.messages[0]?.text).toContain('[1 image(s) attached]');
    expect(result.images).toEqual([image]);
    expect(result.messages[0]?.text).not.toBe('<forwarded_messages/>');
  });

  it('does not describe a failed merge-forward expansion as an empty forward', async () => {
    const client = fakeClient({
      root: raw('om_root', '1000', 'topic problem', { threadId: 'omt_1' }),
      thread: [[raw('om_forward', '2000', '', {
        messageType: 'merge_forward', content: '{}', threadId: 'omt_1', rootId: 'om_root',
        forwardedMessagesUnavailableReason: 'fetch_failed',
      })]],
    });
    const provider = new FeishuConversationContextProvider(client, config);

    const result = await provider.collect({
      chatId: 'oc_1', threadId: 'omt_1', rootId: 'om_root', triggerMessageId: 'om_trigger',
      triggerCreatedAt: '3000', requesterUserId: 'ou_owner',
    });

    expect(result.messages[1]?.text).toBe('<forwarded_messages unavailable="fetch_failed"/>');
    expect(result.messages[1]?.text).not.toBe('<forwarded_messages/>');
  });

  it('retains a time-referenced forwarded reply and its image when newer context exceeds the character budget', async () => {
    const image = { messageId: 'om_child', imageKey: 'img_1', dataUrl: 'data:image/png;base64,AQ==' };
    const client = fakeClient({
      root: raw('om_root', '2026-08-13T18:00:00+08:00', 'topic root', { threadId: 'omt_1' }),
      thread: [[
        raw('om_forward', '2026-08-13T19:38:00+08:00', '', {
          messageType: 'merge_forward', content: '{}', threadId: 'omt_1', rootId: 'om_root', images: [image],
          forwardedMessages: [raw('om_child', '2026-08-13T18:03:00+08:00', `pricing ${'x'.repeat(500)}`)],
        }),
        raw('om_later', '2026-08-13T20:20:00+08:00', `later ${'y'.repeat(900)}`, { threadId: 'omt_1', rootId: 'om_root' }),
      ]],
    });
    const provider = new FeishuConversationContextProvider(client, config);

    const result = await provider.collect({
      chatId: 'oc_1', threadId: 'omt_1', rootId: 'om_root', triggerMessageId: 'om_trigger',
      triggerCreatedAt: '2026-08-13T20:25:00+08:00', requesterUserId: 'ou_owner',
      referenceText: '上面 19:38 的转发消息和图片',
    });

    expect(result.messages.map((message) => message.messageId)).toContain('om_forward');
    expect(result.messages.find((message) => message.messageId === 'om_forward')?.text).toContain('pricing');
    expect(result.images).toEqual([image]);
  });

  it('keeps the topic root when an incremental cursor filters older replies', async () => {
    const client = fakeClient({
      root: raw('om_root', '1000', 'topic problem', { threadId: 'omt_1' }),
      thread: [[
        raw('om_old', '2000', 'already seen', { threadId: 'omt_1', rootId: 'om_root' }),
        raw('om_new', '4000', 'new evidence', { threadId: 'omt_1', rootId: 'om_root' }),
      ]],
    });
    const provider = new FeishuConversationContextProvider(client, config);

    const result = await provider.collect({
      chatId: 'oc_1', threadId: 'omt_1', rootId: 'om_root', triggerMessageId: 'om_trigger',
      triggerCreatedAt: '5000', requesterUserId: 'ou_owner', afterCreatedAt: '3000',
    });

    expect(result.messages.map((message) => message.text)).toEqual(['topic problem', 'new evidence']);
  });

  it('can bound a topic-history recovery read to an earlier time window', async () => {
    const client = fakeClient({
      root: raw('om_root', '1000', 'topic problem', { threadId: 'omt_1' }),
      thread: [[
        raw('om_2246', '2000', '22:46 instruction', { threadId: 'omt_1', rootId: 'om_root' }),
        raw('om_2301', '3000', '23:01 decision', { threadId: 'omt_1', rootId: 'om_root' }),
        raw('om_later', '4000', 'later message', { threadId: 'omt_1', rootId: 'om_root' }),
      ]],
    });
    const provider = new FeishuConversationContextProvider(client, config);

    const result = await provider.collect({
      chatId: 'oc_1', threadId: 'omt_1', rootId: 'om_root', triggerMessageId: 'om_later',
      triggerCreatedAt: '4000', beforeCreatedAt: '3000', requesterUserId: 'ou_owner', maxMessages: 50,
    });

    expect(result.messages.map((message) => message.text)).toEqual(['topic problem', '22:46 instruction', '23:01 decision']);
  });

  it('uses an incremental cursor, filters transient content, and retains media placeholders', async () => {
    const client = fakeClient({
      chat: [[
        raw('om_trigger', '5000', '@bot continue'),
        raw('om_image', '4000', '', { messageType: 'image', content: JSON.stringify({ image_key: 'img_1' }) }),
        raw('om_card', '3500', '', { messageType: 'interactive', content: JSON.stringify({
          header: { title: { content: '回流冲突' } },
          elements: [{ tag: 'markdown', content: '请处理 MR' }, { tag: 'a', href: 'https://github.com/example/example-api/pull/2261' }],
        }) }),
        raw('om_old', '2000', 'already seen'),
      ]],
    });
    const provider = new FeishuConversationContextProvider(client, config);

    const result = await provider.collect({
      chatId: 'oc_1', triggerMessageId: 'om_trigger', triggerCreatedAt: '5000', requesterUserId: 'ou_owner',
      afterCreatedAt: '3000',
    });

    expect(result.messages.map((message) => message.text)).toEqual([
      '回流冲突\n请处理 MR\nhttps://github.com/example/example-api/pull/2261',
      '[image message: om_image]',
    ]);
    expect(result.messages[0]?.links).toEqual([expect.objectContaining({
      url: 'https://github.com/example/example-api/pull/2261',
    })]);
  });

  it('returns partial context when a later page fails', async () => {
    const listMessages = vi.fn()
      .mockResolvedValueOnce({ messages: [raw('om_2', '2000', 'available')], hasMore: true, pageToken: 'next' })
      .mockRejectedValueOnce(new Error('rate limited'));
    const provider = new FeishuConversationContextProvider({ listMessages, getMessage: vi.fn() }, config);

    const result = await provider.collect({
      chatId: 'oc_1', triggerMessageId: 'om_trigger', triggerCreatedAt: '3000', requesterUserId: 'ou_owner',
    });

    expect(result.messages.map((message) => message.text)).toEqual(['available']);
    expect(result.truncated).toBe(true);
    expect(result.unavailableReason).toBe('partial_fetch_failed');
  });
});

function raw(
  messageId: string,
  createdAt: string,
  text: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    messageId, createdAt, messageType: 'text', content: JSON.stringify({ text }),
    senderId: 'ou_sender', senderName: 'Sender', ...overrides,
  };
}

function fakeClient(input: { chat?: unknown[][]; thread?: unknown[][]; root?: unknown } = {}): FeishuHistoryClient & {
  listMessages: ReturnType<typeof vi.fn>; getMessage: ReturnType<typeof vi.fn>;
} {
  const pages = { chat: [...(input.chat ?? [])], thread: [...(input.thread ?? [])] };
  return {
    getBotOpenId: vi.fn(async () => 'ou_bot'),
    listMessages: vi.fn(async ({ containerType }: { containerType: 'chat' | 'thread' }) => {
      const messages = pages[containerType].shift() ?? [];
      return { messages, hasMore: pages[containerType].length > 0, pageToken: pages[containerType].length > 0 ? 'next' : undefined };
    }),
    getMessage: vi.fn(async () => input.root),
  } as never;
}
