import * as lark from '@larksuiteoapi/node-sdk';
import type { FeishuHistoryClient, FeishuHistoryMessage } from './ConversationContextProvider.js';

const MERGE_FORWARD_EXPANSION_CONCURRENCY = 4;
const MAX_MERGE_FORWARD_EXPANSIONS_PER_PAGE = 10;

type RawMessage = {
  message_id?: string; root_id?: string; parent_id?: string; thread_id?: string; msg_type?: string;
  upper_message_id?: string;
  create_time?: string; updated?: boolean; deleted?: boolean;
  sender?: { id?: string; sender_name?: string; sender_type?: string };
  mentions?: Array<{ id?: string | { open_id?: string }; id_type?: string }>;
  body?: { content?: string };
};

interface MessageApi {
  list(payload: { params: Record<string, unknown> }): Promise<{
    code?: number; msg?: string; data?: { items?: RawMessage[]; has_more?: boolean; page_token?: string };
  }>;
  get(payload: { path: { message_id: string } }): Promise<{
    code?: number; msg?: string; data?: { items?: RawMessage[] };
  }>;
}

interface MessageResourceApi {
  get(payload: { params: { type: string }; path: { message_id: string; file_key: string } }): Promise<{
    getReadableStream(): NodeJS.ReadableStream; headers?: Record<string, unknown>;
  }>;
}

export class LarkFeishuHistoryClient implements FeishuHistoryClient {
  private readonly messages: MessageApi;
  private readonly resources: MessageResourceApi;
  private readonly request?: (input: { url: string; method: string }) => Promise<unknown>;

  constructor(appId: string, appSecret: string, client?: { im: { v1: { message: MessageApi; messageResource: MessageResourceApi } }; request?: (input: { url: string; method: string }) => Promise<unknown> }) {
    const sdkClient = client ?? new lark.Client({ appId, appSecret });
    this.messages = sdkClient.im.v1.message as MessageApi;
    this.resources = sdkClient.im.v1.messageResource as MessageResourceApi;
    this.request = sdkClient.request?.bind(sdkClient) as typeof this.request;
  }

  async getBotOpenId(): Promise<string | undefined> {
    const response = await this.request?.({ url: '/open-apis/bot/v3/info', method: 'GET' });
    return typeof response === 'object' && response !== null && 'bot' in response
      ? (response as { bot?: { open_id?: string } }).bot?.open_id
      : undefined;
  }

  async listMessages(input: Parameters<FeishuHistoryClient['listMessages']>[0]) {
    const response = await this.messages.list({ params: {
      container_id_type: input.containerType,
      container_id: input.containerId,
      sort_type: input.order === 'asc' ? 'ByCreateTimeAsc' : 'ByCreateTimeDesc',
      page_size: input.pageSize,
      ...(input.pageToken ? { page_token: input.pageToken } : {}),
      ...(input.startTime ? { start_time: input.startTime } : {}),
      ...(input.endTime ? { end_time: input.endTime } : {}),
    } });
    assertSuccess(response);
    const normalized = (await Promise.all((response.data?.items ?? []).map((message) => this.normalizeMessage(message))))
      .filter((message): message is FeishuHistoryMessage => Boolean(message));
    const messages = await mapWithConcurrency(normalized, MERGE_FORWARD_EXPANSION_CONCURRENCY, async (message, index) => {
      if (message.messageType !== 'merge_forward') return message;
      if (index >= MAX_MERGE_FORWARD_EXPANSIONS_PER_PAGE) {
        return { ...message, forwardedMessagesUnavailableReason: 'expansion_limit_reached' };
      }
      try {
        return await this.getMessage(message.messageId) ?? {
          ...message, forwardedMessagesUnavailableReason: 'message_unavailable',
        };
      } catch {
        return { ...message, forwardedMessagesUnavailableReason: 'fetch_failed' };
      }
    }, (message) => message.messageType === 'merge_forward');
    return {
      messages,
      hasMore: response.data?.has_more === true,
      ...(response.data?.page_token ? { pageToken: response.data.page_token } : {}),
    };
  }

  async getMessage(messageId: string): Promise<FeishuHistoryMessage | undefined> {
    const response = await this.messages.get({ path: { message_id: messageId } });
    assertSuccess(response);
    const items = response.data?.items ?? [];
    const root = await this.normalizeMessage(items[0]);
    if (!root || root.messageType !== 'merge_forward') return root;
    const children = (await Promise.all(items.slice(1).map((message) => this.normalizeMessage(message, messageId))))
      .filter((message): message is FeishuHistoryMessage => Boolean(message));
    return {
      ...root,
      forwardedMessages: children,
      images: children.flatMap((message) => message.images ?? []),
    };
  }

  private async normalizeMessage(message?: RawMessage, resourceOwnerMessageId?: string): Promise<FeishuHistoryMessage | undefined> {
    const normalized = normalizeRawMessage(message);
    if (!normalized || !message) return normalized;
    const imageKeys = extractImageKeys(normalized.messageType, normalized.content);
    if (imageKeys.length === 0) return normalized;
    const images = await Promise.all(imageKeys.slice(0, 8).map(async (imageKey) => {
      try {
        return {
          messageId: normalized.messageId, imageKey,
          ...(resourceOwnerMessageId ? { forwardedEnvelopeMessageId: resourceOwnerMessageId } : {}),
          dataUrl: await this.downloadImage(resourceOwnerMessageId ?? normalized.messageId, imageKey),
        };
      } catch {
        return {
          messageId: normalized.messageId, imageKey,
          ...(resourceOwnerMessageId ? { forwardedEnvelopeMessageId: resourceOwnerMessageId } : {}),
          unavailableReason: resourceOwnerMessageId ? 'forwarded_message_resource_unavailable' : 'download_failed',
        };
      }
    }));
    return { ...normalized, images };
  }

  private async downloadImage(messageId: string, imageKey: string): Promise<string> {
    const response = await this.resources.get({
      params: { type: 'image' }, path: { message_id: messageId, file_key: imageKey },
    });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.getReadableStream() as AsyncIterable<Buffer | string>) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 10 * 1024 * 1024) throw new Error('Feishu context image exceeds 10 MiB');
      chunks.push(buffer);
    }
    const rawContentType = response.headers?.['content-type'];
    const contentType = typeof rawContentType === 'string' && rawContentType.startsWith('image/')
      ? rawContentType.split(';')[0] : 'image/png';
    return `data:${contentType};base64,${Buffer.concat(chunks).toString('base64')}`;
  }
}

async function mapWithConcurrency<T>(
  values: T[], concurrency: number, mapper: (value: T, selectedIndex: number) => Promise<T>, select: (value: T) => boolean,
): Promise<T[]> {
  const result = [...values];
  const selected = values.map((value, index) => ({ value, index })).filter(({ value }) => select(value));
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
    while (cursor < selected.length) {
      const selectedIndex = cursor++;
      const entry = selected[selectedIndex]!;
      result[entry.index] = await mapper(entry.value, selectedIndex);
    }
  }));
  return result;
}

function extractImageKeys(type: string, contentJson: string): string[] {
  let content: unknown;
  try { content = JSON.parse(contentJson); } catch { return []; }
  const keys: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'image_key' || key === 'imageKey') && typeof child === 'string') keys.push(child);
      else visit(child);
    }
  };
  if (type === 'image' && content && typeof content === 'object' && typeof (content as { image_key?: unknown }).image_key === 'string') {
    keys.push((content as { image_key: string }).image_key);
  } else if (type === 'post' || type === 'interactive') visit(content);
  return [...new Set(keys)];
}

function normalizeRawMessage(message?: RawMessage): FeishuHistoryMessage | undefined {
  if (!message?.message_id || !message.msg_type || !message.create_time || typeof message.body?.content !== 'string') {
    return undefined;
  }
  return {
    messageId: message.message_id,
    ...(message.root_id ? { rootId: message.root_id } : {}),
    ...(message.parent_id ? { parentId: message.parent_id } : {}),
    ...(message.thread_id ? { threadId: message.thread_id } : {}),
    messageType: message.msg_type,
    createdAt: message.create_time,
    ...(message.updated ? { updated: true } : {}),
    ...(message.deleted ? { deleted: true } : {}),
    ...(message.sender?.id ? { senderId: message.sender.id } : {}),
    ...(message.sender?.sender_name ? { senderName: message.sender.sender_name } : {}),
    ...(message.sender?.sender_type ? { senderType: message.sender.sender_type } : {}),
    mentionsOpenIds: message.mentions?.flatMap((mention) => {
      if (typeof mention.id === 'string' && (!mention.id_type || mention.id_type === 'open_id')) return [mention.id];
      return typeof mention.id === 'object' && mention.id?.open_id ? [mention.id.open_id] : [];
    }) ?? [],
    content: message.body.content,
  };
}

function assertSuccess(response: { code?: number; msg?: string }): void {
  if (response.code !== undefined && response.code !== 0) {
    throw new Error(`Feishu message history request failed: ${response.code} ${response.msg ?? ''}`.trim());
  }
}
