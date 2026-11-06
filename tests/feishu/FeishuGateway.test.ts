import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { LarkLongConnectionGateway } from '../../src/feishu/FeishuGateway.js';

type ReceiveHandler = (data: {
  message?: {
    message_id?: string;
    thread_id?: string;
    root_id?: string;
    parent_id?: string;
    create_time?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: Array<{ key?: string; name?: string; id?: { open_id?: string } }>;
  };
  sender?: { sender_id?: { open_id?: string } };
}) => Promise<void>;

type CardActionHandler = (data: {
  context?: {
    open_chat_id?: string;
    open_message_id?: string;
    open_thread_id?: string;
  };
  open_chat_id?: string;
  open_message_id?: string;
  operator?: {
    open_id?: string;
  };
  action?: {
    value?: unknown;
    form_value?: unknown;
  };
  event?: {
    context?: {
      open_chat_id?: string;
      open_message_id?: string;
      open_thread_id?: string;
    };
    open_chat_id?: string;
    open_message_id?: string;
    operator?: {
      open_id?: string;
    };
    action?: {
      value?: unknown;
      form_value?: unknown;
    };
  };
}) => Promise<{ card?: Record<string, unknown>; toast?: { type: string; content: string } } | void>;

type BotMenuHandler = (data: {
  event_id?: string;
  event_key?: string;
  operator?: {
    operator_id?: {
      open_id?: string;
    };
  };
  event?: {
    event_id?: string;
    event_key?: string;
    operator?: {
      operator_id?: {
        open_id?: string;
      };
    };
  };
}) => Promise<void>;

type ReactionCreatedHandler = (data: {
  event?: {
    message_id?: string;
    reaction_type?: { emoji_type?: string };
    user_id?: { open_id?: string };
  };
}) => Promise<void>;

function createGatewayHarness(options: {
  resolvePrivateChatId?: (userId: string) => Promise<string | undefined>;
} = {}) {
  let messageHandler: ReceiveHandler | undefined;
  let cardActionHandler: CardActionHandler | undefined;
  let botMenuHandler: BotMenuHandler | undefined;
  let reactionCreatedHandler: ReactionCreatedHandler | undefined;
  const sent: Array<{ receive_id: string; content: string }> = [];
  const replies: Array<{ message_id: string; msg_type: string; content: string; reply_in_thread?: boolean }> = [];
  const requests: Array<{ url: string; method: string; data?: unknown }> = [];
  const errors: unknown[][] = [];
  const infos: unknown[][] = [];
  const events: Array<{ type: string; at: string; data: Record<string, unknown> }> = [];
  const errorLogs: Array<{ at: string; source: string; message: string; data: Record<string, unknown> }> = [];
  const request = vi.fn(async (payload: { url: string; method: string; data?: unknown }): Promise<unknown> => {
    if (payload.url === '/open-apis/bot/v3/info') {
      return { bot: { open_id: 'ou_bot' } };
    }
    requests.push({ url: payload.url, method: payload.method, data: payload.data });
    return { code: 0, msg: 'success' };
  });

  const gateway = new LarkLongConnectionGateway('app', 'secret', {
    client: {
      request,
      im: {
        v1: {
          message: {
            get: async () => ({ data: { items: [{ chat_id: 'oc_group', thread_id: 'omt_topic' }] } }),
            create: async ({ data }) => {
              sent.push({ receive_id: data.receive_id, content: data.content });
            },
            reply: async ({ path, data }) => {
              replies.push({
                message_id: path.message_id,
                msg_type: data.msg_type,
                content: data.content,
                reply_in_thread: data.reply_in_thread,
              });
            },
          },
          image: {
            create: async ({ data }) => {
              expect(data.image_type).toBe('message');
              expect(Buffer.isBuffer(data.image)).toBe(true);
              return { image_key: 'img_uploaded_key' };
            },
          },
          file: {
            create: async ({ data }) => {
              expect(data.file_type).toBe('stream');
              expect(Buffer.isBuffer(data.file)).toBe(true);
              return { file_key: 'file_uploaded_key' };
            },
          },
          messageResource: {
            get: async ({ params }) => ({
              getReadableStream: () => Readable.from(params.type === 'image'
                ? [Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])]
                : [Buffer.from('file')]),
              headers: { 'content-type': params.type === 'image' ? 'image/png' : 'text/plain' },
            }),
          },
        },
      },
    },
    wsClient: {
      start: async () => undefined,
    },
    createEventDispatcher: () => ({
      register: (handlers) => {
        messageHandler = handlers['im.message.receive_v1'];
        cardActionHandler = handlers['card.action.trigger'];
        botMenuHandler = handlers['application.bot.menu_v6'];
        reactionCreatedHandler = handlers['im.message.reaction.created_v1'];
        return handlers;
      },
    }),
    logger: {
      info: (...args: unknown[]) => {
        infos.push(args);
      },
      error: (...args: unknown[]) => {
        errors.push(args);
      },
    },
    recordEvent: async (event) => {
      events.push(event);
    },
    recordError: async (entry) => {
      errorLogs.push(entry);
    },
    resolvePrivateChatId: options.resolvePrivateChatId,
  });

  return {
    gateway,
    request,
    sent,
    replies,
    requests,
    errors,
    infos,
    events,
    errorLogs,
    getHandler: () => {
      if (!messageHandler) {
        throw new Error('handler not registered');
      }
      return messageHandler;
    },
    getCardActionHandler: () => {
      if (!cardActionHandler) {
        throw new Error('card action handler not registered');
      }
      return cardActionHandler;
    },
    getBotMenuHandler: () => {
      if (!botMenuHandler) {
        throw new Error('bot menu handler not registered');
      }
      return botMenuHandler;
    },
    getReactionCreatedHandler: () => {
      if (!reactionCreatedHandler) {
        throw new Error('reaction created handler not registered');
      }
      return reactionCreatedHandler;
    },
  };
}

describe('LarkLongConnectionGateway', () => {
  it('uses one ordered batch for inner-region replacements and refuses panel replacement shapes', async () => {
    const h = createGatewayHarness();
    h.request.mockResolvedValueOnce({ code: 0 });
    const element = { tag: 'column_set', element_id: 'inline_p_content', columns: [{ tag: 'column', elements: [{ tag: 'markdown', content: 'public preview' }] }] };
    await h.gateway.updateCardKitRegions({ cardId: 'card', regions: [{ elementId: 'inline_p_content', element }], sequence: 4, uuid: 'one-operation' });
    expect(h.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', url: '/open-apis/cardkit/v1/cards/card/batch_update',
      data: expect.objectContaining({ sequence: 4, uuid: 'one-operation' }) }));
    const payload = h.request.mock.calls.at(-1)![0] as { data: { actions: string } };
    expect(JSON.parse(payload.data.actions)).toEqual([{ action: 'update_element', params: { element_id: 'inline_p_content', element } }]);
    await expect(h.gateway.updateCardKitRegions({ cardId: 'card', regions: [{ elementId: 'inline_process', element: { tag: 'collapsible_panel', element_id: 'inline_process', expanded: false } }], sequence: 5, uuid: 'invalid' })).rejects.toThrow('Invalid card regions');
  });
  it('uses structural edits instead of replacing existing timeline folds',async()=>{
    const h=createGatewayHarness();h.request.mockResolvedValue({code:0});
    const leaf=(content:string)=>({tag:'markdown',element_id:'output',content});
    const command=(content:string)=>({tag:'collapsible_panel',element_id:'run_one',expanded:false,
      header:{title:{tag:'plain_text',content}},elements:[leaf(content)]});
    const region=(content:string)=>({tag:'column_set',element_id:'timeline_content',columns:[{
      tag:'column',element_id:'timeline_items',elements:[{tag:'collapsible_panel',element_id:'cmd_one',expanded:false,
        header:{title:{tag:'plain_text',content:'commands'}},elements:[command(content)]}]}]});
    await h.gateway.updateCardKitRegions({cardId:'card',regions:[{elementId:'timeline_content',element:region('new'),previousElement:region('old')}],sequence:2,uuid:'structural'});
    const payload=h.request.mock.calls.at(-1)![0] as {data:{actions:string}};
    const actions=JSON.parse(payload.data.actions);
    expect(actions.map((action:any)=>action.action)).toEqual(['partial_update_element','update_element']);
    expect(payload.data.actions).not.toContain('expanded');
    expect(actions[0].params).toMatchObject({element_id:'run_one',partial_element:{header:{title:{content:'new'}}}});
    expect(actions[1].params.element_id).toBe('output');
  });
  it('takes detail callback identity and conversation from platform context, not button values', async () => {
    const h = createGatewayHarness();
    const handler = vi.fn(async () => ({ text: '' }));
    await h.gateway.start(async () => ({ text: '' }), handler);
    await h.getCardActionHandler()({ context: { open_chat_id: 'group', open_message_id: 'source', open_thread_id: 'topic' },
      operator: { open_id: 'ou_actor' }, action: { value: { kind: 'turn_detail', cardRef: 'a'.repeat(32), category: 'process' } } });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'group', chatType: 'group', userId: 'ou_actor', messageId: 'source', threadId: 'topic' }));
  });
  it('returns detail feedback as a native toast without sending an extra chat message', async () => {
    const h = createGatewayHarness();
    const toast = { type: 'info' as const, content: '内容没有变化，请查看已打开的详情卡片。' };
    await h.gateway.start(async () => ({ text: '' }), async () => ({ text: '', toast }));
    const reply = await h.getCardActionHandler()({ context: { open_chat_id: 'group', open_message_id: 'source' },
      operator: { open_id: 'ou_actor' }, action: { value: { kind: 'turn_detail', cardRef: 'a'.repeat(32), category: 'commands' } } });
    expect(reply).toEqual({ toast });
  });
  it('acknowledges slow detail reads before the callback deadline without granting access or cancelling the read', async () => {
    vi.useFakeTimers();
    try {
      const h = createGatewayHarness();
      let finish!: (reply: { text: string }) => void;
      const read = new Promise<{ text: string }>((resolve) => { finish = resolve; });
      const handler = vi.fn(() => read);
      await h.gateway.start(async () => ({ text: '' }), handler);
      const response = h.getCardActionHandler()({ context: { open_chat_id: 'group', open_message_id: 'source' },
        operator: { open_id: 'ou_actor' }, action: { value: { kind: 'turn_detail', cardRef: 'a'.repeat(32), category: 'process' } } });
      await vi.advanceTimersByTimeAsync(1200);
      expect((await response)?.toast).toMatchObject({ type: 'info', content: expect.stringContaining('正在读取') });
      expect(handler).toHaveBeenCalledOnce();
      finish({ text: '你没有此详情的访问权限。' });
      await vi.advanceTimersByTimeAsync(0);
    } finally { vi.useRealTimers(); }
  });
  it('resolves detail scope from message/chat APIs and checks a current member across pages', async () => {
    const h = createGatewayHarness();
    h.request.mockResolvedValueOnce({ code: 0, data: { items: [{ message_id: 'source', chat_id: 'group', thread_id: 'topic' }] } });
    h.request.mockResolvedValueOnce({ code: 0, data: { chat_mode: 'group', chat_type: 'private' } });
    await expect(h.gateway.resolveDetailMessageScope('source')).resolves.toEqual({ chatId: 'group', chatType: 'group', topicId: 'topic' });
    h.request.mockResolvedValueOnce({ code: 0, data: { items: [], has_more: true, page_token: 'next' } });
    h.request.mockResolvedValueOnce({ code: 0, data: { items: [{ member_id: 'ou_actor' }], has_more: false } });
    await expect(h.gateway.isDetailReaderMember('group', 'ou_actor')).resolves.toBe(true);
    h.request.mockResolvedValueOnce({ code: 99991672, msg: 'missing scope' });
    await expect(h.gateway.resolveDetailMessageScope('source')).rejects.toThrow();
  });
  it.each([
    [{ chat_mode: 'p2p' }, 'private'],
    [{ chat_mode: 'group', chat_type: 'private' }, 'group'],
    [{ chat_mode: 'group', chat_type: 'public' }, 'group'],
    [{ chat_mode: 'topic', chat_type: 'private' }, 'group'],
    [{ chat_type: 'private' }, undefined],
    [{ chat_mode: 'unknown', chat_type: 'public' }, undefined],
  ])('uses authoritative conversation mode, not group visibility: %j', async (chat, expected) => {
    const h = createGatewayHarness();
    h.request.mockResolvedValueOnce({ code: 0, data: { items: [{ message_id: 'source', chat_id: 'chat' }] } });
    h.request.mockResolvedValueOnce({ code: 0, data: chat });
    if (expected) expect(await h.gateway.resolveDetailMessageScope('source')).toEqual({ chatId: 'chat', chatType: expected });
    else await expect(h.gateway.resolveDetailMessageScope('source')).rejects.toThrow('access_unavailable');
  });
  it('does not resolve deleted source messages', async () => {
    const h = createGatewayHarness();
    h.request.mockResolvedValueOnce({ code: 0, data: { items: [{ chat_id: 'chat', deleted: true }] } });
    expect(await h.gateway.resolveDetailMessageScope('source')).toBeUndefined();
  });
  it('locates operation cards from actual platform message positions without inventing an ID-only jump', async () => {
    const h = createGatewayHarness();
    h.request.mockResolvedValueOnce({ code: 0, data: { items: [{ chat_id: 'oc_chat', thread_id: 'omt_thread', thread_message_position: '12' }] } });
    expect(await h.gateway.resolveOperationCardLink('om_delivered')).toContain('thread_position=12');
    h.request.mockResolvedValueOnce({ code: 0, data: { items: [{ chat_id: 'oc_chat', message_id: 'om_delivered' }] } });
    expect(await h.gateway.resolveOperationCardLink('om_delivered')).toBeUndefined();
  });
  it('verifies sensitive-reply ownership against the exact platform message sender and chat', async () => {
    const h = createGatewayHarness();
    for (const [sender, chat_id, deleted, allowed] of [
      [{ id: 'ou_owner', id_type: 'open_id', sender_type: 'user' }, 'group', false, true],
      [{ id: 'ou_other', id_type: 'open_id', sender_type: 'user' }, 'group', false, false],
      [{ id: 'ou_owner', id_type: 'open_id', sender_type: 'app' }, 'group', false, false],
      [{ id: 'ou_owner', id_type: 'user_id', sender_type: 'user' }, 'group', false, false],
      [{ id: 'ou_owner', id_type: 'open_id', sender_type: 'user' }, 'other-group', false, false],
      [{ id: 'ou_owner', id_type: 'open_id', sender_type: 'user' }, 'group', true, false],
    ] as const) {
      h.request.mockResolvedValueOnce({ code: 0, data: { items: [{ chat_id, sender, deleted }] } });
      expect(await h.gateway.verifySensitiveReplySource('original', 'group', 'ou_owner')).toBe(allowed);
    }
  });
  it('delivers unmodified sensitive URLs exclusively to an open-id recipient with a receipt and no group fallback', async () => {
    const h = createGatewayHarness();
    h.request.mockResolvedValueOnce({ code: 0, data: { message_id: 'private-receipt' } });
    const text = 'https://example.test/authorize?client_id=example&state=fake-test-private-value';
    expect(await h.gateway.sendSensitiveReplyPrivate('ou_owner', text, 'stable-uuid')).toEqual({ messageId: 'private-receipt' });
    const request = h.request.mock.calls.at(-1)![0]!;
    expect(request.url).toBe('/open-apis/im/v1/messages?receive_id_type=open_id');
    expect(request.data).toMatchObject({ receive_id: 'ou_owner', uuid: 'stable-uuid', msg_type: 'post' });
    expect(JSON.stringify(request.data)).toContain(text);
    expect(JSON.stringify(request.data)).toContain('img_uploaded_key');
    h.request.mockRejectedValueOnce(new Error('unavailable'));
    await expect(h.gateway.sendSensitiveReplyPrivate('ou_owner', text, 'stable-uuid')).rejects.toThrow();
    expect(h.sent).toHaveLength(0);
    expect(JSON.stringify(h.events)).not.toContain('fake-test-private-value');
    await expect(h.gateway.sendSensitiveReplyPrivate('group', text, 'stable-uuid')).rejects.toThrow('Invalid private recipient');
  });
  it('classifies HTTP-only permanent failures and preserves rate-limit retry-after', async () => {
    const h = createGatewayHarness();
    for (const [status, category] of [[400, 'payload'], [403, 'permanent'], [429, 'retryable'], [503, 'retryable']] as const) {
      h.request.mockRejectedValueOnce({ response: { status, headers: { 'retry-after': '60' } } });
      await expect(h.gateway.resolveDetailMessageScope('source')).rejects.toMatchObject({ category, retryAfterMs: 60_000 });
    }
  });
  it('sends detail files only as verified source replies, without a cross-topic fallback', async () => {
    const h = createGatewayHarness();
    h.request.mockResolvedValueOnce({ code: 0, data: { message_id: 'file-message' } });
    await expect(h.gateway.sendDetailFileToTarget({ chatId: 'chat', replyToMessageId: 'topic', replyInThread: true }, 'file-key', 'uuid'))
      .resolves.toEqual({ messageId: 'file-message' });
    expect(h.request).toHaveBeenCalledWith(expect.objectContaining({ url: '/open-apis/im/v1/messages/topic/reply',
      data: expect.objectContaining({ msg_type: 'file', uuid: 'uuid', reply_in_thread: true }) }));
    h.request.mockRejectedValueOnce(new Error('reply failed'));
    await expect(h.gateway.sendDetailFileToTarget({ chatId: 'chat', replyToMessageId: 'topic' }, 'file-key', 'uuid')).rejects.toThrow();
    await expect(h.gateway.sendDetailFileToTarget({ chatId: 'chat' }, 'file-key', 'uuid')).rejects.toThrow('source required');
    expect(h.sent).toEqual([]); expect(h.replies).toEqual([]);
  });
  it('sends operation cards with a durable uuid and no text or cross-topic fallback', async () => {
    const h = createGatewayHarness();
    h.request.mockResolvedValueOnce({ code: 0, data: { message_id: 'approval-message' } });
    await expect(h.gateway.sendOperationCardToTarget({ chatId: 'chat', replyToMessageId: 'topic', replyInThread: true },
      { schema: '2.0' }, 'dedupe')).resolves.toEqual({ messageId: 'approval-message' });
    expect(h.request).toHaveBeenCalledWith(expect.objectContaining({ url: '/open-apis/im/v1/messages/topic/reply',
      data: expect.objectContaining({ uuid: 'dedupe', msg_type: 'interactive', reply_in_thread: true }) }));
    h.request.mockRejectedValueOnce(new Error('send failed'));
    await expect(h.gateway.sendOperationCardToTarget({ chatId: 'chat', replyToMessageId: 'topic' }, {}, 'retry')).rejects.toThrow();
    expect(h.sent).toEqual([]);
    expect(h.replies).toEqual([]);
    h.request.mockResolvedValueOnce({ code: 0, data: {} });
    await expect(h.gateway.sendOperationCardToTarget({ chatId: 'chat' }, {}, 'retry')).rejects.toThrow('receipt missing');
  });
  it('resolves an MR author to a unique exact-name chat member open id', async () => {
    const harness = createGatewayHarness();
    harness.request.mockResolvedValueOnce({ data: { items: [
      { member_id: 'ou_author', name: '何灏' }, { member_id: 'ou_other', name: '其他人' },
    ], has_more: false } });

    await expect(harness.gateway.resolveChatMemberOpenId('oc_group', '何灏')).resolves.toBe('ou_author');
    expect(harness.request).toHaveBeenCalledWith(expect.objectContaining({
      url: expect.stringContaining('/open-apis/im/v1/chats/oc_group/members?'), method: 'GET',
    }));
  });

  it('refuses an ambiguous author name instead of mentioning the wrong member', async () => {
    const harness = createGatewayHarness();
    harness.request.mockResolvedValueOnce({ data: { items: [
      { member_id: 'ou_one', name: '同名用户' }, { member_id: 'ou_two', name: '同名用户' },
    ], has_more: false } });

    await expect(harness.gateway.resolveChatMemberOpenId('oc_group', '同名用户')).resolves.toBeUndefined();
  });
  it('treats a DONE reaction as topic closure and resolves its conversation identity', async () => {
    const harness = createGatewayHarness();
    const onTopicClosed = vi.fn(async () => undefined);
    await harness.gateway.start(async () => ({ text: '' }), undefined, onTopicClosed);

    await harness.getReactionCreatedHandler()({
      event: {
        message_id: 'om_root', reaction_type: { emoji_type: 'DONE' }, user_id: { open_id: 'ou_operator' },
      },
    });

    expect(onTopicClosed).toHaveBeenCalledWith({
      chatId: 'oc_group', topicId: 'omt_topic', operatorUserId: 'ou_operator',
    });
  });

  it('ignores reactions that do not close a topic', async () => {
    const harness = createGatewayHarness();
    const onTopicClosed = vi.fn(async () => undefined);
    await harness.gateway.start(async () => ({ text: '' }), undefined, onTopicClosed);

    await harness.getReactionCreatedHandler()({
      event: { message_id: 'om_root', reaction_type: { emoji_type: 'THUMBSUP' } },
    });

    expect(onTopicClosed).not.toHaveBeenCalled();
  });

  it('uploads card images and returns the Feishu image key', async () => {
    const harness = createGatewayHarness();
    await expect(harness.gateway.uploadImage(Buffer.from('png'))).resolves.toBe('img_uploaded_key');
  });

  it('uploads files and downloads bounded message resources', async () => {
    const harness = createGatewayHarness();
    await expect(harness.gateway.uploadFile(Buffer.from('report'), 'report.txt')).resolves.toBe('file_uploaded_key');
    await expect(harness.gateway.downloadMessageResource({
      messageId: 'om_1', resourceKey: 'file_1', kind: 'file', maxBytes: 10,
    })).resolves.toMatchObject({ data: Buffer.from('file'), declaredMime: 'text/plain' });
    await expect(harness.gateway.downloadMessageResource({
      messageId: 'om_1', resourceKey: 'file_1', kind: 'file', maxBytes: 2,
    })).rejects.toThrow('size limit');
  });

  it('sends media to the bound reply target with a stable UUID', async () => {
    const harness = createGatewayHarness();
    harness.request.mockResolvedValueOnce({ data: { message_id: 'om_media_1' } });

    await expect(harness.gateway.sendMediaToTarget(
      { chatId: 'oc_1', replyToMessageId: 'om_user_1', replyInThread: true },
      { kind: 'file', resourceKey: 'file_1', uuid: 'out_1' },
    )).resolves.toEqual({ messageId: 'om_media_1' });

    expect(harness.request).toHaveBeenCalledWith({
      url: '/open-apis/im/v1/messages/om_user_1/reply', method: 'POST',
      data: {
        msg_type: 'file', content: JSON.stringify({ file_key: 'file_1' }),
        uuid: 'out_1', reply_in_thread: true,
      },
    });
  });

  it('creates and sends a CardKit entity as a threaded reply', async () => {
    const harness = createGatewayHarness();
    const runningCard = { schema: '2.0', body: { elements: [] } };
    harness.request
      .mockResolvedValueOnce({ code: 0, data: { card_id: 'card_1' } })
      .mockResolvedValueOnce({ code: 0, data: { message_id: 'om_live_1' } });

    await expect(harness.gateway.createCardKitEntity(runningCard)).resolves.toEqual({ cardId: 'card_1' });
    await expect(harness.gateway.sendCardKitEntityToTarget(
      { chatId: 'oc_1', replyToMessageId: 'om_user_1', replyInThread: true },
      'card_1',
      'uuid-send',
    )).resolves.toEqual({ messageId: 'om_live_1' });

    expect(harness.request).toHaveBeenNthCalledWith(1, {
      url: '/open-apis/cardkit/v1/cards',
      method: 'POST',
      data: { type: 'card_json', data: JSON.stringify(runningCard) },
    });
    expect(harness.request).toHaveBeenNthCalledWith(2, {
      url: '/open-apis/im/v1/messages/om_user_1/reply',
      method: 'POST',
      data: {
        msg_type: 'interactive',
        content: JSON.stringify({ type: 'card', data: { card_id: 'card_1' } }),
        reply_in_thread: true,
        uuid: 'uuid-send',
      },
    });
  });

  it('sends sequence and UUID for CardKit element and full-card updates', async () => {
    const harness = createGatewayHarness();
    const element = { tag: 'markdown', element_id: 'tui_content', content: 'screen' };
    const finalCard = { schema: '2.0', body: { elements: [] } };
    harness.request.mockResolvedValue({ code: 0, data: {} });

    await harness.gateway.updateCardKitElement({
      cardId: 'card_1', elementId: 'tui_content', element, sequence: 7, uuid: 'uuid-7',
    });
    await harness.gateway.replaceCardKitEntity({
      cardId: 'card_1', card: finalCard, sequence: 8, uuid: 'uuid-8',
    });

    expect(harness.request).toHaveBeenNthCalledWith(1, {
      url: '/open-apis/cardkit/v1/cards/card_1/elements/tui_content',
      method: 'PUT',
      data: { element: JSON.stringify(element), sequence: 7, uuid: 'uuid-7' },
    });
    expect(harness.request).toHaveBeenNthCalledWith(2, {
      url: '/open-apis/cardkit/v1/cards/card_1',
      method: 'PUT',
      data: {
        card: { type: 'card_json', data: JSON.stringify(finalCard) },
        sequence: 8,
        uuid: 'uuid-8',
      },
    });
  });

  it.each([
    [{ response: { status: 429, data: { code: 99991400 } } }, 'retryable'],
    [{ response: { status: 503, data: { code: 1 } } }, 'retryable'],
    [{ response: { status: 400, data: { code: 200860 } } }, 'payload'],
    [{ response: { status: 400, data: { code: 200740 } } }, 'permanent'],
    [{ response: { status: 400, data: { code: 200750 } } }, 'permanent'],
    [{ response: { status: 403, data: { code: 300311 } } }, 'permanent'],
  ])('classifies CardKit API failure %#', async (error, category) => {
    const harness = createGatewayHarness();
    harness.request.mockRejectedValueOnce(error);

    await expect(harness.gateway.createCardKitEntity({ schema: '2.0' }))
      .rejects.toMatchObject({ category });
  });

  it('rejects successful CardKit envelopes without required identifiers', async () => {
    const harness = createGatewayHarness();
    harness.request.mockResolvedValueOnce({ code: 0, data: {} });

    await expect(harness.gateway.createCardKitEntity({ schema: '2.0' }))
      .rejects.toMatchObject({ category: 'retryable' });
  });

  it('updates an existing card with the preferred interactive payload', async () => {
    const harness = createGatewayHarness();
    const rendered = {
      preferred: { kind: 'card' as const, payload: { schema: '2.0', body: { elements: [] } } },
      fallback: { kind: 'text' as const, text: 'fallback' },
    };

    await harness.gateway.updateMessageCard('om_card_1', rendered);

    expect(harness.requests).toContainEqual({
      url: '/open-apis/im/v1/messages/om_card_1',
      method: 'PATCH',
      data: { content: JSON.stringify(rendered.preferred.payload) },
    });
  });

  it('rejects a card update whose preferred rendering is text', async () => {
    const harness = createGatewayHarness();
    await expect(harness.gateway.updateMessageCard('om_card_1', {
      preferred: { kind: 'text', text: 'not a card' },
      fallback: { kind: 'text', text: 'fallback' },
    })).rejects.toThrow('preferred rendering must be a card');
  });

  it('deletes a bot message by message id', async () => {
    const harness = createGatewayHarness();
    await harness.gateway.deleteMessage('om_auth_card');
    expect(harness.requests).toContainEqual({
      url: '/open-apis/im/v1/messages/om_auth_card', method: 'DELETE', data: undefined,
    });
  });

  it('adds a Feishu reaction to a message', async () => {
    const harness = createGatewayHarness();

    await harness.gateway.addReaction('om_123', 'Get');

    expect(harness.requests).toEqual([
      {
        url: '/open-apis/im/v1/messages/om_123/reactions',
        method: 'POST',
        data: {
          reaction_type: {
            emoji_type: 'Get',
          },
        },
      },
    ]);
  });

  it('handles text event and sends onMessage reply to original chat', async () => {
    const harness = createGatewayHarness();
    const onMessage = vi.fn(async () => ({ text: 'bot reply' }));
    await harness.gateway.start(onMessage);
    expect(harness.infos).toContainEqual([expect.stringContaining('gateway.started')]);

    await harness.getHandler()({
      message: {
        message_id: 'om_123',
        root_id: 'om_root',
        parent_id: 'om_parent',
        create_time: '1722679200000',
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello bot' }),
      },
      sender: { sender_id: { open_id: 'ou_1' } },
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({
      botOpenIdResolved: true,
      chatId: 'oc_1',
      chatType: 'private',
      messageId: 'om_123',
      rootId: 'om_root',
      parentId: 'om_parent',
      createdAt: '1722679200000',
      mentionsOpenIds: [],
      userId: 'ou_1',
      text: 'hello bot',
      wasMentioned: false,
      source: 'message',
    });
    expect(harness.sent).toEqual([]);
    expect(harness.replies).toEqual([
      {
        message_id: 'om_123',
        msg_type: 'text',
        content: JSON.stringify({ text: 'bot reply' }),
        reply_in_thread: undefined,
      },
    ]);
  });

  it('recovers and memoizes a private chat id for bot menu events after cold start', async () => {
    const resolvePrivateChatId = vi.fn(async () => 'oc_private_persisted');
    const harness = createGatewayHarness({ resolvePrivateChatId });
    const onMessage = vi.fn(async () => ({ text: 'status reply' }));
    await harness.gateway.start(onMessage);

    const menuEvent = {
      event_key: 'status',
      operator: { operator_id: { open_id: 'ou_1' } },
    };
    await harness.getBotMenuHandler()(menuEvent);
    await harness.getBotMenuHandler()(menuEvent);

    expect(resolvePrivateChatId).toHaveBeenCalledTimes(1);
    expect(resolvePrivateChatId).toHaveBeenCalledWith('ou_1');
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenLastCalledWith({
      botOpenIdResolved: true,
      chatId: 'oc_private_persisted',
      chatType: 'private',
      mentionsOpenIds: [],
      userId: 'ou_1',
      text: '/status',
      wasMentioned: true,
      source: 'bot_menu',
    });
    expect(harness.sent).toHaveLength(2);
    expect(harness.sent[0]?.receive_id).toBe('oc_private_persisted');
  });

  it('preserves the flattened event ID and identifies bot-menu messages', async () => {
    const harness = createGatewayHarness({ resolvePrivateChatId: async () => 'oc_private_1' });
    const onMessage = vi.fn(async () => ({ text: '' }));
    await harness.gateway.start(onMessage);

    await harness.getBotMenuHandler()({
      event_id: 'evt_menu_1',
      event_key: 'restart',
      operator: { operator_id: { open_id: 'ou_1' } },
    });

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      source: 'bot_menu',
      eventId: 'evt_menu_1',
      text: '/restart',
    }));
  });

  it('records an observable event when a bot menu route is unavailable', async () => {
    const harness = createGatewayHarness({ resolvePrivateChatId: async () => undefined });
    const onMessage = vi.fn(async () => ({ text: 'unexpected' }));
    await harness.gateway.start(onMessage);

    await harness.getBotMenuHandler()({
      event_key: 'status',
      operator: { operator_id: { open_id: 'ou_missing' } },
    });

    expect(onMessage).not.toHaveBeenCalled();
    expect(harness.sent).toEqual([]);
    expect(harness.events).toContainEqual({
      type: 'feishu.bot_menu_ignored',
      at: expect.any(String),
      data: {
        userId: 'ou_missing',
        eventKey: 'status',
        reason: 'missing_private_chat_id',
      },
    });
    expect(harness.infos).toContainEqual([expect.stringContaining('feishu.bot_menu_ignored')]);
  });

  it('records diagnostics and skips dispatch when bot menu route resolution fails', async () => {
    const harness = createGatewayHarness({
      resolvePrivateChatId: async () => {
        throw new Error('receipt read failed');
      },
    });
    const onMessage = vi.fn(async () => ({ text: 'unexpected' }));
    await harness.gateway.start(onMessage);

    await harness.getBotMenuHandler()({
      event_key: 'current',
      operator: { operator_id: { open_id: 'ou_1' } },
    });

    expect(onMessage).not.toHaveBeenCalled();
    expect(harness.events).toContainEqual({
      type: 'feishu.bot_menu_route_resolution_failed',
      at: expect.any(String),
      data: expect.objectContaining({
        userId: 'ou_1',
        eventKey: 'current',
        errorMessage: 'receipt read failed',
      }),
    });
    expect(harness.errorLogs).toContainEqual(expect.objectContaining({
      source: 'feishu.gateway',
      message: 'receipt read failed',
      data: expect.objectContaining({ stage: 'resolve_bot_menu_chat' }),
    }));
    expect(harness.errors).toContainEqual([
      expect.stringContaining('feishu.bot_menu_route_resolution_failed'),
    ]);
  });

  it('dispatches bot menu events as slash commands using the cached private chat id', async () => {
    const resolvePrivateChatId = vi.fn(async () => 'oc_wrong');
    const harness = createGatewayHarness({ resolvePrivateChatId });
    const onMessage = vi
      .fn()
      .mockResolvedValueOnce({ text: '' })
      .mockResolvedValueOnce({ text: 'current reply' });
    await harness.gateway.start(onMessage);

    await harness.getHandler()({
      message: {
        message_id: 'om_seed',
        chat_id: 'oc_private_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
      },
      sender: { sender_id: { open_id: 'ou_1' } },
    });

    await harness.getBotMenuHandler()({
      event_key: 'current',
      operator: {
        operator_id: {
          open_id: 'ou_1',
        },
      },
    });

    expect(resolvePrivateChatId).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenLastCalledWith({
      botOpenIdResolved: true,
      chatId: 'oc_private_1',
      chatType: 'private',
      mentionsOpenIds: [],
      userId: 'ou_1',
      text: '/current',
      wasMentioned: true,
      source: 'bot_menu',
    });
    expect(harness.sent).toEqual([
      {
        receive_id: 'oc_private_1',
        content: JSON.stringify({ text: 'current reply' }),
      },
    ]);
  });

  it.each([
    ['current', '/current'],
    ['tail', '/tail'],
    ['status', '/status'],
    ['project', '/projects'],
    ['projects', '/projects'],
    ['new', '/new'],
    ['model', '/model'],
    ['resume', '/resume'],
    ['stop', '/stop'],
    ['restart', '/restart'],
    ['upgrade', '/upgrade'],
  ])('maps bot menu key %s to %s', async (eventKey, command) => {
    const harness = createGatewayHarness();
    const onMessage = vi.fn(async () => ({ text: '' }));
    await harness.gateway.start(onMessage);

    await harness.getHandler()({
      message: {
        message_id: 'om_seed',
        chat_id: 'oc_private_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
      },
      sender: { sender_id: { open_id: 'ou_1' } },
    });
    onMessage.mockClear();

    await harness.getBotMenuHandler()({
      event: {
        event_key: eventKey,
        operator: {
          operator_id: {
            open_id: 'ou_1',
          },
        },
      },
    });

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ text: command }));
  });

  it('does not use topic replies for ordinary group messages outside a topic', async () => {
    const harness = createGatewayHarness();
    await harness.gateway.start(async () => ({ text: 'bot reply' }));

    await harness.getHandler()({
      message: {
        message_id: 'om_group_plain_1',
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@bot hello' }),
        mentions: [{ id: { open_id: 'ou_bot' } }],
      },
      sender: { sender_id: { open_id: 'ou_trigger' } },
    });

    expect(harness.replies).toEqual([
      {
        message_id: 'om_group_plain_1',
        msg_type: 'text',
        content: JSON.stringify({ text: '<at user_id="ou_trigger"></at> bot reply' }),
        reply_in_thread: undefined,
      },
    ]);
  });

  it('uses topic replies for group messages that mention the bot inside a topic', async () => {
    const harness = createGatewayHarness();
    const onMessage = vi.fn(async () => ({ text: 'bot reply' }));
    await harness.gateway.start(onMessage);

    await harness.getHandler()({
      message: {
        message_id: 'om_group_topic_1',
        thread_id: 'omt_topic_1',
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@bot hello' }),
        mentions: [{ id: { open_id: 'ou_bot' } }],
      },
      sender: { sender_id: { open_id: 'ou_trigger' } },
    });

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'omt_topic_1' }));
    expect(harness.replies).toEqual([
      {
        message_id: 'om_group_topic_1',
        msg_type: 'text',
        content: JSON.stringify({ text: '<at user_id="ou_trigger"></at> bot reply' }),
        reply_in_thread: true,
      },
    ]);
  });

  it('falls back to chat send when an incoming reply target has no message id', async () => {
    const harness = createGatewayHarness();
    const onMessage = vi.fn(async () => ({ text: 'bot reply' }));
    await harness.gateway.start(onMessage);

    await harness.getHandler()({
      message: {
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello bot' }),
      },
      sender: { sender_id: { open_id: 'ou_1' } },
    });

    expect(harness.replies).toEqual([]);
    expect(harness.sent).toEqual([
      {
        receive_id: 'oc_1',
        content: JSON.stringify({ text: 'bot reply' }),
      },
    ]);
  });

  it('prefixes group text replies with a mention for the triggering user', async () => {
    const harness = createGatewayHarness();
    await harness.gateway.start(async () => ({ text: 'bot reply' }));

    await harness.getHandler()({
      message: {
        message_id: 'om_group_1',
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@bot hello' }),
        mentions: [{ id: { open_id: 'ou_bot' } }],
      },
      sender: { sender_id: { open_id: 'ou_trigger' } },
    });

    expect(harness.sent).toEqual([]);
    expect(harness.replies).toEqual([
      {
        message_id: 'om_group_1',
        msg_type: 'text',
        content: JSON.stringify({ text: '<at user_id="ou_trigger"></at> bot reply' }),
        reply_in_thread: undefined,
      },
    ]);
  });

  it('does not prefix private text replies with a mention', async () => {
    const harness = createGatewayHarness();
    await harness.gateway.start(async () => ({ text: 'bot reply' }));

    await harness.getHandler()({
      message: {
        message_id: 'om_private_1',
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
      },
      sender: { sender_id: { open_id: 'ou_trigger' } },
    });

    expect(harness.replies).toEqual([
      {
        message_id: 'om_private_1',
        msg_type: 'text',
        content: JSON.stringify({ text: 'bot reply' }),
        reply_in_thread: undefined,
      },
    ]);
  });

  it('accepts image message events as attachment-only prompts', async () => {
    const harness = createGatewayHarness();
    const onMessage = vi.fn(async () => ({ text: 'reply' }));
    await harness.gateway.start(onMessage);

    await harness.getHandler()({
      message: {
        message_id: 'om_image_1',
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_1' }),
      },
      sender: { sender_id: { open_id: 'ou_1' } },
    });

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'om_image_1', text: '', resources: [{
        kind: 'image', resourceKey: 'img_1', resourceOwnerMessageId: 'om_image_1',
      }],
    }));
    expect(harness.sent).toEqual([]);
  });

  it('handles rich text post events by extracting readable text', async () => {
    const harness = createGatewayHarness();
    const onMessage = vi.fn(async () => ({ text: '' }));
    await harness.gateway.start(onMessage);

    await harness.getHandler()({
      message: {
        message_id: 'om_post_1',
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'post',
        content: JSON.stringify({
          title: 'Request',
          content: [
            [
              { tag: 'text', text: 'please inspect ' },
              { tag: 'a', text: 'this MR', href: 'https://example.test/mr/1' },
            ],
            [{ tag: 'text', text: 'thanks' }],
          ],
        }),
      },
      sender: { sender_id: { open_id: 'ou_1' } },
    });

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'oc_1',
        chatType: 'private',
        messageId: 'om_post_1',
        text: 'Request\nplease inspect this MR https://example.test/mr/1\nthanks',
      }),
    );
  });

  it('marks group messages as mentioned only when they mention the bot identity', async () => {
    const harness = createGatewayHarness();
    const onMessage = vi.fn(async () => ({ text: '' }));
    await harness.gateway.start(onMessage);

    await harness.getHandler()({
      message: {
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 hello' }),
        mentions: [{ key: '@_user_1', name: 'Other User', id: { open_id: 'ou_other' } }],
      },
      sender: { sender_id: { open_id: 'ou_1' } },
    });

    await harness.getHandler()({
      message: {
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 hello' }),
        mentions: [{ key: '@_user_1', name: 'Link Bot', id: { open_id: 'ou_bot' } }],
      },
      sender: { sender_id: { open_id: 'ou_1' } },
    });

    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      mentionsOpenIds: ['ou_other'],
      wasMentioned: false,
    }));
    expect(onMessage).toHaveBeenNthCalledWith(2, {
      botOpenIdResolved: true,
      chatId: 'oc_1',
      chatType: 'group',
      mentionsOpenIds: ['ou_bot'],
      mentions: [{ key: '@_user_1', name: 'Link Bot', openId: 'ou_bot', isBot: true }],
      userId: 'ou_1',
      text: '@_user_1 hello',
      wasMentioned: true,
      source: 'message',
    });
  });

  it('passes @all group messages downstream as unmentioned for routing policy', async () => {
    const harness = createGatewayHarness();
    const onMessage = vi.fn(async () => ({ text: '' }));
    await harness.gateway.start(onMessage);
    await harness.getHandler()({
      message: {
        chat_id: 'oc_1', chat_type: 'group', message_type: 'text',
        content: JSON.stringify({ text: '@all hello' }),
        mentions: [{ key: '@all', name: '所有人', id: {} }],
      },
      sender: { sender_id: { open_id: 'ou_1' } },
    });
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatType: 'group', text: '@all hello', wasMentioned: false,
    }));
    expect(harness.sent).toEqual([]);
  });

  it('records bot identity resolution success on startup', async () => {
    const harness = createGatewayHarness();

    await harness.gateway.start(async () => ({ text: '' }));

    expect(harness.events).toContainEqual(
      expect.objectContaining({
        type: 'feishu.bot_identity_resolved',
        data: {
          botOpenId: 'ou_bot',
        },
      }),
    );
  });

  it('records bot identity lookup failures on startup', async () => {
    const events: Array<{ type: string; at: string; data: Record<string, unknown> }> = [];
    const errors: unknown[][] = [];
    const gateway = new LarkLongConnectionGateway('app', 'secret', {
      client: {
        request: async () => {
          throw new Error('identity lookup failed');
        },
        im: { v1: { message: { create: async () => undefined } } },
      },
      wsClient: { start: async () => undefined },
      createEventDispatcher: () => ({
        register: (handlers) => handlers,
      }),
      logger: { error: (...args: unknown[]) => errors.push(args) },
      recordEvent: async (event) => {
        events.push(event);
      },
    });

    await gateway.start(async () => ({ text: '' }));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'feishu.bot_identity_failed',
        data: expect.objectContaining({
          reason: 'identity lookup failed',
          stage: 'resolve_bot_open_id',
        }),
      }),
    );
    expect(errors).toContainEqual([expect.stringContaining('feishu.bot_identity_failed')]);
  });

  it('records missing bot open id as an identity failure on startup', async () => {
    const events: Array<{ type: string; at: string; data: Record<string, unknown> }> = [];
    const gateway = new LarkLongConnectionGateway('app', 'secret', {
      client: {
        request: async () => ({
          bot: {},
        }),
        im: { v1: { message: { create: async () => undefined } } },
      },
      wsClient: { start: async () => undefined },
      createEventDispatcher: () => ({
        register: (handlers) => handlers,
      }),
      recordEvent: async (event) => {
        events.push(event);
      },
    });

    await gateway.start(async () => ({ text: '' }));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'feishu.bot_identity_failed',
        data: expect.objectContaining({
          reason: 'empty_open_id',
          stage: 'resolve_bot_open_id',
        }),
      }),
    );
  });

  it('awaits ws startup failures and rejects start', async () => {
    const startupError = new Error('startup failed');
    const gateway = new LarkLongConnectionGateway('app', 'secret', {
      client: {
        im: { v1: { message: { create: async () => undefined } } },
      },
      wsClient: {
        start: async () => {
          throw startupError;
        },
      },
      createEventDispatcher: () => ({
        register: (handlers) => handlers,
      }),
    });

    await expect(gateway.start(async () => ({ text: 'ok' }))).rejects.toThrow('startup failed');
  });

  it('isolates handler errors, records them, and sends a safe failure reply', async () => {
    const harness = createGatewayHarness();
    await harness.gateway.start(async () => {
      throw new Error('handler failed');
    });

    await expect(
      harness.getHandler()({
        message: {
          chat_id: 'oc_1',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'hello' }),
        },
        sender: { sender_id: { open_id: 'ou_1' } },
      }),
    ).resolves.toBeUndefined();

    expect(harness.errors.length).toBe(1);
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]).toMatchObject({ receive_id: 'oc_1' });
    expect(JSON.parse(harness.sent[0]!.content as string)).toMatchObject({
      text: expect.stringContaining('任务处理失败'),
    });
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        type: 'feishu.message_processing_failed',
        data: expect.objectContaining({
          stage: 'handle_message',
          chatId: 'oc_1',
          userId: 'ou_1',
          errorMessage: 'handler failed',
        }),
      }),
    );
  });

  it('isolates sendText errors and logs without throwing', async () => {
    let handler: ReceiveHandler | undefined;
    const errors: unknown[][] = [];
    const gateway = new LarkLongConnectionGateway('app', 'secret', {
      client: {
        im: {
          v1: {
            message: {
              create: async () => {
                throw new Error('send failed');
              },
            },
          },
        },
      },
      wsClient: { start: async () => undefined },
      createEventDispatcher: () => ({
        register: (handlers: { 'im.message.receive_v1': ReceiveHandler }) => {
          handler = handlers['im.message.receive_v1'];
          return handlers;
        },
      }),
      logger: { error: (...args: unknown[]) => errors.push(args) },
    });
    await gateway.start(async () => ({ text: 'reply' }));
    if (!handler) {
      throw new Error('handler not registered');
    }

    await expect(
      handler({
        message: {
          chat_id: 'oc_1',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'hello' }),
        },
        sender: { sender_id: { open_id: 'ou_1' } },
      }),
    ).resolves.toBeUndefined();
    expect(errors.length).toBe(1);
  });

  it('records outbound reply send failures as events', async () => {
    let handler: ReceiveHandler | undefined;
    const errors: unknown[][] = [];
    const events: Array<{ type: string; at: string; data: Record<string, unknown> }> = [];
    const errorLogs: Array<{ at: string; source: string; message: string; data: Record<string, unknown> }> = [];
    const gateway = new LarkLongConnectionGateway('app', 'secret', {
      client: {
        im: {
          v1: {
            message: {
              create: async () => {
                const error = new Error('Request failed with status code 400') as Error & {
                  code?: string;
                  response?: { status: number; data: unknown };
                };
                error.code = 'ERR_BAD_REQUEST';
                error.response = {
                  status: 400,
                  data: {
                    code: 230028,
                    msg: 'The messages do NOT pass the audit, ext=contain sensitive data: EMAIL_ADDRESS',
                    log_id: 'log_123',
                  },
                };
                throw error;
              },
            },
          },
        },
      },
      wsClient: { start: async () => undefined },
      createEventDispatcher: () => ({
        register: (handlers: { 'im.message.receive_v1': ReceiveHandler }) => {
          handler = handlers['im.message.receive_v1'];
          return handlers;
        },
      }),
      logger: { error: (...args: unknown[]) => errors.push(args) },
      recordEvent: async (event) => {
        events.push(event);
      },
      recordError: async (entry) => {
        errorLogs.push(entry);
      },
    });
    await gateway.start(async () => ({ text: 'reply' }));
    if (!handler) {
      throw new Error('handler not registered');
    }

    await expect(
      handler({
        message: {
          chat_id: 'oc_1',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: '/tail 20' }),
        },
        sender: { sender_id: { open_id: 'ou_1' } },
      }),
    ).resolves.toBeUndefined();

    expect(errors.length).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'feishu.message_processing_failed',
        data: expect.objectContaining({
          stage: 'send_reply',
          chatId: 'oc_1',
          userId: 'ou_1',
          text: '/tail 20',
          replyPreview: 'reply',
          errorMessage: 'Request failed with status code 400',
          errorCode: 'ERR_BAD_REQUEST',
          responseStatus: 400,
          responseData: expect.objectContaining({
            code: 230028,
            msg: expect.stringContaining('EMAIL_ADDRESS'),
            log_id: 'log_123',
          }),
        }),
      }),
    );
    expect(errorLogs).toContainEqual(
      expect.objectContaining({
        source: 'feishu.gateway',
        message: 'Request failed with status code 400',
        data: expect.objectContaining({
          stage: 'send_reply',
          responseStatus: 400,
        }),
      }),
    );
  });

  it('redacts email addresses before sending text', async () => {
    const harness = createGatewayHarness();

    await harness.gateway.sendText('oc_1', 'tail output: user@example.com');

    expect(harness.sent).toEqual([
      {
        receive_id: 'oc_1',
        content: JSON.stringify({ text: 'tail output: [EMAIL_REDACTED]' }),
      },
    ]);
  });

  it('splits oversized text replies into multiple Feishu messages', async () => {
    const harness = createGatewayHarness();
    const oversized = 'x'.repeat(16_500);

    await harness.gateway.sendText('oc_1', oversized);

    expect(harness.sent).toHaveLength(2);
    expect(harness.sent[0]?.receive_id).toBe('oc_1');
    expect(harness.sent[1]?.receive_id).toBe('oc_1');

    const firstText = JSON.parse(harness.sent[0]!.content) as { text: string };
    const secondText = JSON.parse(harness.sent[1]!.content) as { text: string };
    expect(firstText.text.length).toBeLessThan(16_500);
    expect(secondText.text.length).toBeGreaterThan(0);
    expect(`${firstText.text}${secondText.text}`).toBe(oversized);
  });

  it('redacts email addresses in replies from incoming messages', async () => {
    const harness = createGatewayHarness();
    await harness.gateway.start(async () => ({ text: 'contact: dev-team@example.com' }));

    await harness.getHandler()({
      message: {
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '/tail 20' }),
      },
      sender: { sender_id: { open_id: 'ou_1' } },
    });

    expect(harness.sent).toEqual([
      {
        receive_id: 'oc_1',
        content: JSON.stringify({ text: 'contact: [EMAIL_REDACTED]' }),
      },
    ]);
  });

  it('sends a card payload when the reply is rendered as a card', async () => {
    const sent: Array<{ msg_type: string; content: string }> = [];
    const gateway = new LarkLongConnectionGateway('app', 'secret', {
      client: {
        im: {
          v1: {
            message: {
              create: async (payload: { data: { msg_type: string; content: string } }) => {
                const { data } = payload;
                sent.push({ msg_type: data.msg_type, content: data.content });
              },
            },
          },
        },
      },
    } as any);

    await gateway.sendRenderedMessage('oc_1', {
      preferred: { kind: 'card', payload: { schema: '2.0', body: { elements: [] } } },
      fallback: { kind: 'text', text: 'fallback' },
    });

    expect(sent[0]).toMatchObject({ msg_type: 'interactive' });
  });

  it('falls back to text when card sending fails', async () => {
    const sent: Array<{ msg_type: string; content: string }> = [];
    const infos: unknown[][] = [];
    let calls = 0;
    const originalLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'debug';
    const gateway = new LarkLongConnectionGateway('app', 'secret', {
      client: {
        im: {
          v1: {
            message: {
              create: async (payload: { data: { msg_type: string; content: string } }) => {
                const { data } = payload;
                calls += 1;
                if (calls === 1) {
                  throw new Error('card failed');
                }
                sent.push({ msg_type: data.msg_type, content: data.content });
              },
            },
          },
        },
      },
      logger: {
        info: (...args: unknown[]) => {
          infos.push(args);
        },
        error: () => undefined,
      },
    } as any);

    try {
      await gateway.sendRenderedMessage('oc_1', {
        preferred: { kind: 'card', payload: { schema: '2.0', body: { elements: [] } } },
        fallback: { kind: 'text', text: 'fallback text' },
      });
    } finally {
      if (originalLevel === undefined) {
        delete process.env.LOG_LEVEL;
      } else {
        process.env.LOG_LEVEL = originalLevel;
      }
    }

    expect(sent).toEqual([{ msg_type: 'text', content: JSON.stringify({ text: 'fallback text' }) }]);
    expect(infos).toContainEqual([expect.stringContaining('DEBUG feishu.render_fallback')]);
  });

  it('sends rendered replies from the incoming message handler as cards', async () => {
    const sent: Array<{ msg_type?: string; content: string }> = [];
    let handler: ReceiveHandler | undefined;
    const gateway = new LarkLongConnectionGateway('app', 'secret', {
      client: {
        im: {
          v1: {
            message: {
              create: async (payload: { data: { msg_type?: string; content: string } }) => {
                sent.push({ msg_type: payload.data.msg_type, content: payload.data.content });
              },
            },
          },
        },
      },
      wsClient: { start: async () => undefined },
      createEventDispatcher: () => ({
        register: (handlers: { 'im.message.receive_v1': ReceiveHandler }) => {
          handler = handlers['im.message.receive_v1'];
          return handlers;
        },
      }),
    } as any);

    await gateway.start(async () => ({
      text: 'fallback',
      rendered: {
        preferred: { kind: 'card', payload: { schema: '2.0', body: { elements: [{ tag: 'markdown', content: '**done**' }] } } },
        fallback: { kind: 'text', text: 'fallback' },
      },
    }));

    if (!handler) {
      throw new Error('handler not registered');
    }

    await handler({
      message: {
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello bot' }),
      },
      sender: { sender_id: { open_id: 'ou_1' } },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.msg_type).toBe('interactive');
  });

  it('sends rendered replies with source message id through the reply API', async () => {
    const harness = createGatewayHarness();

    await harness.gateway.start(async () => ({
      text: 'fallback',
      rendered: {
        preferred: { kind: 'card', payload: { schema: '2.0', body: { elements: [{ tag: 'markdown', content: '**done**' }] } } },
        fallback: { kind: 'text', text: 'fallback' },
      },
    }));

    await harness.getHandler()({
      message: {
        message_id: 'om_rendered_1',
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello bot' }),
      },
      sender: { sender_id: { open_id: 'ou_1' } },
    });

    expect(harness.sent).toEqual([]);
    expect(harness.replies).toEqual([
      {
        message_id: 'om_rendered_1',
        msg_type: 'interactive',
        content: JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: '**done**' }] } }),
        reply_in_thread: undefined,
      },
    ]);
  });

  it('sends rendered card messages to reply targets through the reply API', async () => {
    const harness = createGatewayHarness();

    await harness.gateway.sendRenderedMessageToTarget(
      { chatId: 'oc_1', replyToMessageId: 'om_123', replyInThread: true },
      {
        preferred: { kind: 'card', payload: { schema: '2.0', body: { elements: [{ tag: 'markdown', content: '**done**' }] } } },
        fallback: { kind: 'text', text: 'fallback' },
      },
    );

    expect(harness.sent).toEqual([]);
    expect(harness.replies).toEqual([
      {
        message_id: 'om_123',
        msg_type: 'interactive',
        content: JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: '**done**' }] } }),
        reply_in_thread: true,
      },
    ]);
  });

  it('creates direct user messages with open_id receive semantics', async () => {
    const creates: Array<{ params: unknown; data: unknown }> = [];
    const gateway = new LarkLongConnectionGateway('app', 'secret', {
      client: { im: { v1: { message: { create: async (payload: { params: unknown; data: unknown }) => { creates.push(payload); } } } } },
    } as any);

    await gateway.sendRenderedMessageToTarget(
      { chatId: 'ou_approver', receiveIdType: 'open_id' },
      {
        preferred: { kind: 'card', payload: { schema: '2.0', body: { elements: [] } } },
        fallback: { kind: 'text', text: 'fallback' },
      },
    );

    expect(creates).toEqual([{
      params: { receive_id_type: 'open_id' },
      data: expect.objectContaining({ receive_id: 'ou_approver', msg_type: 'interactive' }),
    }]);
  });

  it('prefixes rendered card markdown replies with a card mention', async () => {
    const harness = createGatewayHarness();
    const preferred = { kind: 'card' as const, payload: { schema: '2.0', body: { elements: [{ tag: 'markdown', content: '**done**' }] } } };

    await harness.gateway.sendRenderedMessageToTarget(
      { chatId: 'oc_1', replyToMessageId: 'om_123', replyInThread: true, mentionUserId: 'ou_trigger' },
      {
        preferred,
        fallback: { kind: 'text', text: 'fallback' },
      },
    );

    expect(preferred.payload.body.elements[0]?.content).toBe('**done**');
    expect(harness.replies).toEqual([
      {
        message_id: 'om_123',
        msg_type: 'interactive',
        content: JSON.stringify({
          schema: '2.0',
          body: { elements: [{ tag: 'markdown', content: '<at id="ou_trigger"></at>\n**done**' }] },
        }),
        reply_in_thread: true,
      },
    ]);
  });

  it('mentions rendered text fallback exactly once after preferred card reply failure', async () => {
    const sent: Array<{ receive_id: string; msg_type: string; content: string }> = [];
    let replyCalls = 0;
    const gateway = new LarkLongConnectionGateway('app', 'secret', {
      client: {
        im: {
          v1: {
            message: {
              create: async (payload: { data: { receive_id: string; msg_type: string; content: string } }) => {
                if (payload.data.msg_type === 'interactive') {
                  throw new Error('card fallback create failed');
                }
                sent.push({
                  receive_id: payload.data.receive_id,
                  msg_type: payload.data.msg_type,
                  content: payload.data.content,
                });
              },
              reply: async () => {
                replyCalls += 1;
                throw new Error('reply failed');
              },
            },
          },
        },
      },
      logger: { error: () => undefined },
    } as any);

    await gateway.sendRenderedMessageToTarget(
      { chatId: 'oc_1', replyToMessageId: 'om_123', replyInThread: true, mentionUserId: 'ou_trigger' },
      {
        preferred: { kind: 'card', payload: { schema: '2.0', body: { elements: [{ tag: 'markdown', content: '**done**' }] } } },
        fallback: { kind: 'text', text: 'fallback text' },
      },
    );

    expect(replyCalls).toBe(2);
    expect(sent).toEqual([
      {
        receive_id: 'oc_1',
        msg_type: 'text',
        content: JSON.stringify({ text: '<at user_id="ou_trigger"></at> fallback text' }),
      },
    ]);
  });

  it('logs reply failures and falls back to one chat create payload for text reply targets', async () => {
    const sent: Array<{ receive_id: string; msg_type: string; content: string }> = [];
    const errors: unknown[][] = [];
    const gateway = new LarkLongConnectionGateway('app', 'secret', {
      client: {
        im: {
          v1: {
            message: {
              create: async (payload: { data: { receive_id: string; msg_type: string; content: string } }) => {
                sent.push({
                  receive_id: payload.data.receive_id,
                  msg_type: payload.data.msg_type,
                  content: payload.data.content,
                });
              },
              reply: async () => {
                throw new Error('reply rejected');
              },
            },
          },
        },
      },
      logger: {
        error: (...args: unknown[]) => {
          errors.push(args);
        },
      },
    } as any);

    await gateway.sendTextToTarget(
      { chatId: 'oc_1', replyToMessageId: 'om_123', replyInThread: true },
      'fallback text',
    );

    expect(errors).toContainEqual([
      expect.stringContaining('feishu.reply_message_failed chat=oc_1 messageId=om_123 reason="reply rejected"'),
    ]);
    expect(sent).toEqual([
      {
        receive_id: 'oc_1',
        msg_type: 'text',
        content: JSON.stringify({ text: 'fallback text' }),
      },
    ]);
  });

  it('does not send an empty reply payload back to Feishu', async () => {
    const harness = createGatewayHarness();
    await harness.gateway.start(async () => ({ text: '' }));

    await harness.getHandler()({
      message: {
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
      },
      sender: { sender_id: { open_id: 'ou_1' } },
    });

    expect(harness.sent).toEqual([]);
  });

  it('returns an origin card update in the callback response', async () => {
    const harness = createGatewayHarness();
    const card = { schema: '2.0', config: { update_multi: true }, body: { elements: [] } };
    await harness.gateway.start(async () => ({ text: 'unused' }), async () => ({
      text: 'page fallback',
      rendered: {
        preferred: { kind: 'card', payload: card },
        fallback: { kind: 'text', text: 'page fallback' },
      },
      delivery: { kind: 'update_origin_card', onFailure: 'reply_rendered' },
    }));

    const response = await harness.getCardActionHandler()({
      event: {
        context: { open_chat_id: 'oc_1', open_message_id: 'om_resume' },
        operator: { open_id: 'ou_1' },
        action: {
          value: {
            kind: 'resume_page',
            chatId: 'oc_1',
            chatType: 'group',
            projectId: 'repo',
            page: 2,
          },
        },
      },
    });

    expect(response).toEqual({
      card: {
        type: 'raw',
        data: card,
      },
    });
    expect(harness.requests).not.toContainEqual(
      expect.objectContaining({ url: '/open-apis/im/v1/messages/om_resume', method: 'PATCH' }),
    );
    expect(harness.replies).toEqual([]);
  });

  it('restores a topic-bound card callback from its signed value when Feishu omits open_thread_id', async () => {
    const harness = createGatewayHarness();
    const onCardAction = vi.fn(async () => ({ text: '' }));
    await harness.gateway.start(async () => ({ text: '' }), onCardAction);

    await harness.getCardActionHandler()({ event: {
      context: { open_chat_id: 'oc_1', open_message_id: 'om_publish' },
      operator: { open_id: 'ou_1' },
      action: { value: {
        kind: 'task_publish_decision', requestId: 'pub_1', decision: 'confirm',
        chatId: 'oc_1', chatType: 'group', topicId: 'omt_topic_1',
      } },
    } });

    expect(onCardAction).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'oc_1', chatType: 'group', threadId: 'omt_topic_1', messageId: 'om_publish',
    }));
  });

  it('rejects a topic card callback when Feishu context conflicts with the signed topic', async () => {
    const harness = createGatewayHarness();
    const onCardAction = vi.fn(async () => ({ text: '' }));
    await harness.gateway.start(async () => ({ text: '' }), onCardAction);

    await harness.getCardActionHandler()({ event: {
      context: { open_chat_id: 'oc_1', open_message_id: 'om_publish', open_thread_id: 'omt_other' },
      operator: { open_id: 'ou_1' },
      action: { value: {
        kind: 'task_publish_decision', requestId: 'pub_1', decision: 'confirm',
        chatId: 'oc_1', chatType: 'group', topicId: 'omt_topic_1',
      } },
    } });

    expect(onCardAction).not.toHaveBeenCalled();
  });

  it('acknowledges an authorization callback while deleting its origin card asynchronously', async () => {
    const harness = createGatewayHarness();
    await harness.gateway.start(async () => ({ text: '' }), async () => ({
      text: '',
      rendered: {
        preferred: { kind: 'card', payload: { schema: '2.0', body: { elements: [] } } },
        fallback: { kind: 'text', text: 'authorized' },
      },
      delivery: { kind: 'delete_origin_message', onFailure: 'reply_rendered' },
    }));
    const response = await harness.getCardActionHandler()({ event: {
      context: { open_chat_id: 'oc_1', open_message_id: 'om_auth_card' },
      operator: { open_id: 'ou_1' },
      action: { value: { kind: 'tool_auth_check', pendingId: 'auth_1', chatId: 'oc_1', chatType: 'private' } },
    } });
    expect(response).toBeUndefined();
    await vi.waitFor(() => expect(harness.requests).toContainEqual({
      url: '/open-apis/im/v1/messages/om_auth_card', method: 'DELETE', data: undefined,
    }));
  });

  it('replies with fallback text when an origin update has no preferred card', async () => {
    const harness = createGatewayHarness();
    await harness.gateway.start(async () => ({ text: 'unused' }), async () => ({
      text: 'Could not render replacement card.',
      delivery: { kind: 'update_origin_card', onFailure: 'reply_text' },
    }));

    const response = await harness.getCardActionHandler()({
      event: {
        context: { open_chat_id: 'oc_1', open_message_id: 'om_resume' },
        operator: { open_id: 'ou_1' },
        action: {
          value: {
            kind: 'resume_page',
            chatId: 'oc_1',
            chatType: 'private',
            projectId: 'repo',
            page: 2,
          },
        },
      },
    });

    expect(response).toBeUndefined();
    expect(harness.requests).not.toContainEqual(
      expect.objectContaining({ url: '/open-apis/im/v1/messages/om_resume', method: 'PATCH' }),
    );
    expect(harness.replies[0]).toMatchObject({
      message_id: 'om_resume',
      msg_type: 'text',
      content: JSON.stringify({ text: 'Could not render replacement card.' }),
    });
  });

  it('returns a resume success card in the callback response', async () => {
    const harness = createGatewayHarness();
    const card = { schema: '2.0', config: { update_multi: true }, body: { elements: [] } };
    await harness.gateway.start(async () => ({ text: 'unused' }), async () => ({
      text: 'Resumed session sess_new for project repo.',
      rendered: {
        preferred: { kind: 'card', payload: card },
        fallback: { kind: 'text', text: 'Resumed session sess_new for project repo.' },
      },
      delivery: { kind: 'update_origin_card', onFailure: 'reply_text' },
    }));

    const response = await harness.getCardActionHandler()({
      event: {
        context: { open_chat_id: 'oc_1', open_message_id: 'om_resume' },
        operator: { open_id: 'ou_1' },
        action: {
          value: {
            kind: 'resume_select',
            chatId: 'oc_1',
            chatType: 'group',
            projectId: 'repo',
            codexSessionId: 'codex_old',
          },
        },
      },
    });

    expect(response).toEqual({
      card: {
        type: 'raw',
        data: card,
      },
    });
    expect(harness.requests).not.toContainEqual(
      expect.objectContaining({ url: '/open-apis/im/v1/messages/om_resume', method: 'PATCH' }),
    );
    expect(harness.replies).toEqual([]);
  });

  it('routes model selector card actions to onCardAction using origin chat id', async () => {
    const harness = createGatewayHarness();
    const onMessage = vi.fn(async () => ({ text: 'should not be used' }));
    const onCardAction = vi.fn(async () => ({ text: 'model updated' }));

    await harness.gateway.start(onMessage, onCardAction);

    await harness.getCardActionHandler()({
      event: {
        context: {
          open_chat_id: 'oc_1',
          open_message_id: 'om_card_1',
        },
        operator: {
          open_id: 'ou_1',
        },
        action: {
          value: {
            kind: 'model_select',
            chatId: 'oc_1',
            chatType: 'private',
          },
          form_value: {
            model: 'gpt-5.5',
            reasoning: 'high',
          },
        },
      },
    });

    expect(onMessage).not.toHaveBeenCalled();
    expect(onCardAction).toHaveBeenCalledTimes(1);
    expect(onCardAction).toHaveBeenCalledWith({
      chatId: 'oc_1',
      chatType: 'private',
      userId: 'ou_1',
      messageId: 'om_card_1',
      action: {
        kind: 'model_select',
        model: 'gpt-5.5',
        reasoning: 'high',
      },
    });
    expect(harness.sent).toEqual([]);
    expect(harness.replies).toEqual([
      {
        message_id: 'om_card_1',
        msg_type: 'text',
        content: JSON.stringify({ text: 'model updated' }),
        reply_in_thread: undefined,
      },
    ]);
  });

  it('restores a model selector topic from its signed card value when Feishu omits open_thread_id', async () => {
    const harness = createGatewayHarness();
    const onCardAction = vi.fn(async () => ({ text: 'model updated' }));
    await harness.gateway.start(vi.fn(async () => ({ text: '' })), onCardAction);

    await harness.getCardActionHandler()({ event: {
      context: { open_chat_id: 'oc_group', open_message_id: 'om_model_card' },
      operator: { open_id: 'ou_1' },
      action: {
        value: { kind: 'model_select', chatId: 'oc_group', chatType: 'group', topicId: 'omt_topic' },
        form_value: { model: 'gpt-5.6-terra', reasoning: 'medium', serviceTier: 'default' },
      },
    } });

    expect(onCardAction).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic',
      action: expect.objectContaining({ kind: 'model_select', model: 'gpt-5.6-terra' }),
    }));
  });

  it('routes project selector card actions from form_value to onCardAction using origin chat id', async () => {
    const harness = createGatewayHarness();
    const onCardAction = vi.fn(async () => ({ text: 'project updated' }));

    await harness.gateway.start(async () => ({ text: 'unused' }), onCardAction);

    await harness.getCardActionHandler()({
      event: {
        context: {
          open_chat_id: 'oc_1',
          open_message_id: 'om_card_1',
        },
        operator: {
          open_id: 'ou_1',
        },
        action: {
          value: {
            kind: 'project_select',
            chatId: 'oc_1',
            chatType: 'group',
          },
          form_value: {
            projectId: 'repo2',
          },
        },
      },
    });

    expect(onCardAction).toHaveBeenCalledTimes(1);
    expect(onCardAction).toHaveBeenCalledWith({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      messageId: 'om_card_1',
      action: {
        kind: 'project_select',
        projectId: 'repo2',
      },
    });
    expect(harness.sent).toEqual([]);
    expect(harness.replies).toEqual([
      {
        message_id: 'om_card_1',
        msg_type: 'text',
        content: JSON.stringify({ text: '<at user_id="ou_1"></at> project updated' }),
        reply_in_thread: undefined,
      },
    ]);
  });

  it('parses approval_decision card action values', async () => {
    const harness = createGatewayHarness();
    const onCardAction = vi.fn(async () => ({ text: 'approval handled' }));

    await harness.gateway.start(async () => ({ text: 'unused' }), onCardAction);

    await harness.getCardActionHandler()({
      event: {
        context: {
          open_chat_id: 'oc_1',
          open_message_id: 'om_card_1',
        },
        operator: {
          open_id: 'ou_1',
        },
        action: {
          value: {
            kind: 'approval_decision',
            chatId: 'oc_1',
            chatType: 'group',
            approvalId: 'appr_permission_1',
            decision: 'approve',
          },
        },
      },
    });

    expect(onCardAction).toHaveBeenCalledTimes(1);
    expect(onCardAction).toHaveBeenCalledWith({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      messageId: 'om_card_1',
      action: {
        kind: 'approval_decision',
        approvalId: 'appr_permission_1',
        decision: 'approve',
      },
    });
  });

  it('accepts a direct-user project knowledge action in its resolved private chat', async () => {
    const harness = createGatewayHarness();
    const onCardAction = vi.fn(async () => ({ text: 'knowledge approved' }));
    await harness.gateway.start(async () => ({ text: 'unused' }), onCardAction);

    await harness.getCardActionHandler()({ event: {
      context: { open_chat_id: 'oc_private', open_message_id: 'om_knowledge' },
      operator: { open_id: 'ou_approver' },
      action: { value: {
        kind: 'project_knowledge_decision', chatId: 'ou_approver', chatType: 'private',
        knowledgeId: 'project_knowledge_1', decision: 'approve',
      } },
    } });

    expect(onCardAction).toHaveBeenCalledWith({
      chatId: 'oc_private', chatType: 'private', userId: 'ou_approver', messageId: 'om_knowledge',
      action: { kind: 'project_knowledge_decision', knowledgeId: 'project_knowledge_1', decision: 'approve' },
    });
  });

  it('rejects a direct-user card clicked by a different user', async () => {
    const harness = createGatewayHarness();
    const onCardAction = vi.fn(async () => ({ text: 'must not run' }));
    await harness.gateway.start(async () => ({ text: 'unused' }), onCardAction);

    await harness.getCardActionHandler()({ event: {
      context: { open_chat_id: 'oc_private', open_message_id: 'om_knowledge' },
      operator: { open_id: 'ou_other' },
      action: { value: {
        kind: 'project_knowledge_decision', chatId: 'ou_approver', chatType: 'private',
        knowledgeId: 'project_knowledge_1', decision: 'approve',
      } },
    } });

    expect(onCardAction).not.toHaveBeenCalled();
  });

  it('parses destructive command confirmation actions', async () => {
    const harness = createGatewayHarness();
    const onCardAction = vi.fn(async () => ({ text: '' }));
    await harness.gateway.start(async () => ({ text: '' }), onCardAction);

    await harness.getCardActionHandler()({
      event: {
        context: {
          open_chat_id: 'oc_1',
          open_message_id: 'om_card_1',
        },
        operator: {
          open_id: 'ou_1',
        },
        action: {
          value: {
            kind: 'destructive_command_decision',
            chatId: 'oc_1',
            chatType: 'private',
            requestId: 'dcr_1',
            decision: 'confirm',
          },
        },
      },
    });

    expect(onCardAction).toHaveBeenCalledWith({
      chatId: 'oc_1',
      chatType: 'private',
      userId: 'ou_1',
      messageId: 'om_card_1',
      action: {
        kind: 'destructive_command_decision',
        requestId: 'dcr_1',
        decision: 'confirm',
      },
    });
  });

  it('routes top-level SDK card action payloads to onCardAction', async () => {
    const harness = createGatewayHarness();
    const onCardAction = vi.fn(async () => ({ text: 'project updated' }));

    await harness.gateway.start(async () => ({ text: 'unused' }), onCardAction);

    await harness.getCardActionHandler()({
      context: {
        open_chat_id: 'oc_1',
        open_message_id: 'om_card_1',
      },
      operator: {
        open_id: 'ou_1',
      },
      action: {
        value: {
          kind: 'project_select',
          chatId: 'oc_1',
          chatType: 'group',
        },
        form_value: {
          projectId: 'repo2',
        },
      },
    });

    expect(onCardAction).toHaveBeenCalledTimes(1);
    expect(onCardAction).toHaveBeenCalledWith({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      messageId: 'om_card_1',
      action: {
        kind: 'project_select',
        projectId: 'repo2',
      },
    });
  });

  it('ignores card actions when origin chat differs from embedded payload chat', async () => {
    const harness = createGatewayHarness();
    const onCardAction = vi.fn(async () => ({ text: 'unused' }));

    await harness.gateway.start(async () => ({ text: 'unused' }), onCardAction);

    await expect(
      harness.getCardActionHandler()({
        event: {
          context: {
            open_chat_id: 'oc_real',
            open_message_id: 'om_card_1',
          },
          operator: {
            open_id: 'ou_1',
          },
          action: {
            value: {
              kind: 'model_select',
              chatId: 'oc_embedded',
              chatType: 'group',
            },
            form_value: {
              model: 'gpt-5.5',
            },
          },
        },
      }),
    ).resolves.toBeUndefined();

    expect(onCardAction).not.toHaveBeenCalled();
    expect(harness.sent).toEqual([]);
    expect(harness.errors).toEqual([]);
  });

  it('uses top-level origin chat and message id fallback for card actions', async () => {
    const harness = createGatewayHarness();
    const onCardAction = vi.fn(async () => ({ text: 'model updated' }));

    await harness.gateway.start(async () => ({ text: 'unused' }), onCardAction);

    await harness.getCardActionHandler()({
      event: {
        open_chat_id: 'oc_1',
        open_message_id: 'om_card_top_level',
        operator: {
          open_id: 'ou_1',
        },
        action: {
          value: {
            kind: 'model_select',
            chatId: 'oc_1',
            chatType: 'private',
          },
          form_value: {
            model: 'gpt-5.5',
          },
        },
      },
    });

    expect(onCardAction).toHaveBeenCalledWith({
      chatId: 'oc_1',
      chatType: 'private',
      userId: 'ou_1',
      messageId: 'om_card_top_level',
      action: {
        kind: 'model_select',
        model: 'gpt-5.5',
      },
    });
  });

  it('ignores card actions when origin chat id is missing', async () => {
    const harness = createGatewayHarness();
    const onCardAction = vi.fn(async () => ({ text: 'unused' }));

    await harness.gateway.start(async () => ({ text: 'unused' }), onCardAction);

    await expect(
      harness.getCardActionHandler()({
        event: {
          context: {
            open_message_id: 'om_card_1',
          },
          operator: {
            open_id: 'ou_1',
          },
          action: {
            value: {
              kind: 'model_select',
              chatId: 'oc_1',
              chatType: 'group',
            },
            form_value: {
              model: 'gpt-5.5',
            },
          },
        },
      }),
    ).resolves.toBeUndefined();

    expect(onCardAction).not.toHaveBeenCalled();
    expect(harness.sent).toEqual([]);
    expect(harness.errors).toEqual([]);
  });

  it('ignores malformed card actions without throwing', async () => {
    const harness = createGatewayHarness();
    const onCardAction = vi.fn(async () => ({ text: 'unused' }));

    await harness.gateway.start(async () => ({ text: 'unused' }), onCardAction);

    await expect(
      harness.getCardActionHandler()({
        event: {
          operator: {
            open_id: 'ou_1',
          },
          action: {
            value: {
              kind: 'model_select',
              chatId: 'oc_1',
            },
            form_value: {
              reasoning: 'high',
            },
          },
        },
      }),
    ).resolves.toBeUndefined();

    expect(onCardAction).not.toHaveBeenCalled();
    expect(harness.sent).toEqual([]);
    expect(harness.errors).toEqual([]);
  });
});
