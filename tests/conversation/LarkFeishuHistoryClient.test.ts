import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { LarkFeishuHistoryClient } from '../../src/conversation/LarkFeishuHistoryClient.js';

describe('LarkFeishuHistoryClient', () => {
  it('expands merge-forward children returned by message.get', async () => {
    const get = vi.fn(async () => ({ code: 0, data: { items: [
      message('om_root', 'merge_forward', '{}'),
      message('om_child', 'text', '{"text":"具体问题"}', { upper_message_id: 'om_root' }),
    ] } }));
    const client = historyClient({ get });

    const result = await client.getMessage('om_root');

    expect(result?.forwardedMessages?.map((item) => item.content)).toEqual(['{"text":"具体问题"}']);
  });

  it('downloads forwarded child images through the outer merge-forward message and exposes multimodal data', async () => {
    const stream = new PassThrough();
    stream.end(Buffer.from([4, 5, 6]));
    const resourceGet = vi.fn(async () => ({
      getReadableStream: () => stream, headers: { 'content-type': 'image/png' },
    }));
    const get = vi.fn(async () => ({ code: 0, data: { items: [
      message('om_forward', 'merge_forward', '{}'),
      message('om_child_image', 'image', '{"image_key":"img_forwarded"}', { upper_message_id: 'om_forward' }),
    ] } }));
    const client = historyClient({ get, resourceGet });

    const result = await client.getMessage('om_forward');

    expect(resourceGet).toHaveBeenCalledWith({
      params: { type: 'image' }, path: { message_id: 'om_forward', file_key: 'img_forwarded' },
    });
    expect(result?.images).toEqual([{
      messageId: 'om_child_image', imageKey: 'img_forwarded', forwardedEnvelopeMessageId: 'om_forward', dataUrl: 'data:image/png;base64,BAUG',
    }]);
    expect(result?.forwardedMessages?.[0]?.images).toEqual(result?.images);
  });

  it('expands merge-forward messages found among thread replies', async () => {
    const list = vi.fn(async () => ({ code: 0, data: { items: [
      message('om_reply', 'merge_forward', '{}', { thread_id: 'omt_1' }),
      message('om_plain', 'text', '{"text":"继续分析"}', { thread_id: 'omt_1' }),
    ], has_more: false } }));
    const get = vi.fn(async ({ path }: { path: { message_id: string } }) => ({ code: 0, data: { items: [
      message(path.message_id, 'merge_forward', '{}', { thread_id: 'omt_1' }),
      message('om_child', 'text', '{"text":"模型名和价格"}', { upper_message_id: path.message_id }),
    ] } }));
    const client = historyClient({ get, list });

    const page = await client.listMessages({
      containerType: 'thread', containerId: 'omt_1', order: 'asc', pageSize: 50,
    });

    expect(page.messages[0]).toMatchObject({
      messageId: 'om_reply',
      forwardedMessages: [expect.objectContaining({ messageId: 'om_child', content: '{"text":"模型名和价格"}' })],
    });
    expect(get).toHaveBeenCalledWith({ path: { message_id: 'om_reply' } });
  });

  it('marks a listed merge-forward unavailable without failing the surrounding page', async () => {
    const list = vi.fn(async () => ({ code: 0, data: { items: [
      message('om_forward', 'merge_forward', '{}'), message('om_plain', 'text', '{"text":"保留我"}'),
    ], has_more: false } }));
    const client = historyClient({ get: vi.fn(async () => { throw new Error('upstream failed'); }), list });

    const page = await client.listMessages({
      containerType: 'thread', containerId: 'omt_1', order: 'asc', pageSize: 50,
    });

    expect(page.messages).toEqual([
      expect.objectContaining({ messageId: 'om_forward', forwardedMessagesUnavailableReason: 'fetch_failed' }),
      expect.objectContaining({ messageId: 'om_plain' }),
    ]);
  });

  it('downloads a regular image as a bounded data URL', async () => {
    const stream = new PassThrough();
    stream.end(Buffer.from([1, 2, 3]));
    const resourceGet = vi.fn(async () => ({
      getReadableStream: () => stream, headers: { 'content-type': 'image/jpeg' },
    }));
    const client = historyClient({
      get: vi.fn(async () => ({ code: 0, data: { items: [message('om_image', 'image', '{"image_key":"img_1"}')] } })),
      resourceGet,
    });

    const result = await client.getMessage('om_image');

    expect(result?.images).toEqual([{ messageId: 'om_image', imageKey: 'img_1', dataUrl: 'data:image/jpeg;base64,AQID' }]);
    expect(resourceGet).toHaveBeenCalledWith({
      params: { type: 'image' }, path: { message_id: 'om_image', file_key: 'img_1' },
    });
  });

  it('preserves structured mention targets and resolves the current bot identity', async () => {
    const list = vi.fn(async () => ({ code: 0, data: { items: [
      message('om_mention', 'text', '{"text":"@bot 开始"}', {
        mentions: [{ id: 'ou_bot', id_type: 'open_id' }, { id: { open_id: 'ou_legacy' } }],
      }),
    ], has_more: false } }));
    const request = vi.fn(async () => ({ bot: { open_id: 'ou_bot' } }));
    const client = historyClient({ get: vi.fn(), list, request });

    const page = await client.listMessages({
      containerType: 'thread', containerId: 'omt_1', order: 'asc', pageSize: 50,
    });

    expect(page.messages[0]?.mentionsOpenIds).toEqual(['ou_bot', 'ou_legacy']);
    await expect(client.getBotOpenId()).resolves.toBe('ou_bot');
  });
});

function message(id: string, type: string, content: string, extra: Record<string, unknown> = {}) {
  return { message_id: id, msg_type: type, create_time: '1000', body: { content }, ...extra };
}

function historyClient(input: {
  get: ReturnType<typeof vi.fn>;
  list?: ReturnType<typeof vi.fn>;
  resourceGet?: ReturnType<typeof vi.fn>;
  request?: ReturnType<typeof vi.fn>;
}) {
  return new LarkFeishuHistoryClient('app', 'secret', { im: { v1: {
    message: { get: input.get, list: input.list ?? vi.fn() },
    messageResource: { get: input.resourceGet ?? vi.fn() },
  } }, ...(input.request ? { request: input.request } : {}) } as never);
}
