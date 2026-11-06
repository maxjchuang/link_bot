import type { ConversationContextConfig } from '../domain/types.js';

export interface FeishuHistoryMessage {
  messageId: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  messageType: string;
  createdAt: string;
  updated?: boolean;
  deleted?: boolean;
  senderId?: string;
  senderName?: string;
  senderType?: string;
  mentionsOpenIds?: string[];
  content: string;
  forwardedMessages?: FeishuHistoryMessage[];
  forwardedMessagesUnavailableReason?: string;
  images?: ConversationContextImage[];
}

export interface FeishuHistoryClient {
  getBotOpenId?(): Promise<string | undefined>;
  listMessages(input: {
    containerType: 'chat' | 'thread';
    containerId: string;
    order: 'asc' | 'desc';
    pageSize: number;
    pageToken?: string;
    startTime?: string;
    endTime?: string;
  }): Promise<{ messages: FeishuHistoryMessage[]; hasMore: boolean; pageToken?: string }>;
  getMessage(messageId: string): Promise<FeishuHistoryMessage | undefined>;
}

export interface ConversationContextRequest {
  chatId: string;
  threadId?: string;
  rootId?: string;
  triggerMessageId: string;
  triggerCreatedAt?: string;
  requesterUserId: string;
  afterCreatedAt?: string;
  beforeCreatedAt?: string;
  maxMessages?: number;
  maxChars?: number;
  referenceText?: string;
}

export interface ConversationContextMessage {
  messageId: string;
  senderId?: string;
  senderName?: string;
  createdAt: string;
  messageType: string;
  text: string;
  threadId?: string;
  edited?: boolean;
  images?: ConversationContextImage[];
  links?: ConversationContextLink[];
  /** A target reference, not access authorization or the target's history. */
  sharedChat?: { chatId: string };
}

export interface ConversationContextLink { url: string; label?: string; surroundingText?: string }

export interface ConversationContextImage {
  messageId: string;
  imageKey: string;
  /** Set only by the history client when this resource was read through a merge-forward envelope. */
  forwardedEnvelopeMessageId?: string;
  dataUrl?: string;
  unavailableReason?: string;
}

export interface ConversationContext {
  scope: 'group' | 'topic';
  chatId: string;
  threadId?: string;
  messages: ConversationContextMessage[];
  truncated: boolean;
  unavailableReason?: string;
  fetchedAt: string;
  lastMessage?: { messageId: string; createdAt: string };
  images?: ConversationContextImage[];
  recovery?: { compactionEpoch: number; messageCount: number };
}

export interface ConversationContextProvider {
  collect(input: ConversationContextRequest): Promise<ConversationContext>;
}

export class FeishuConversationContextProvider implements ConversationContextProvider {
  constructor(
    private readonly client: FeishuHistoryClient,
    private readonly config: ConversationContextConfig,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async collect(input: ConversationContextRequest): Promise<ConversationContext> {
    const scope = input.threadId ? 'topic' as const : 'group' as const;
    const base = { scope, chatId: input.chatId, ...(input.threadId ? { threadId: input.threadId } : {}) };
    const deadline = Date.now() + this.config.requestTimeoutMs;
    const raw: FeishuHistoryMessage[] = [];
    let truncated = false;
    let unavailableReason: string | undefined;
    try {
      if (input.threadId) {
        const root = await this.resolveRoot(input, deadline);
        if (root) raw.push(root);
        const result = await this.collectPages({
          containerType: 'thread', containerId: input.threadId, order: 'asc', pageSize: 50,
        }, deadline);
        raw.push(...result.messages);
        truncated = result.truncated;
        unavailableReason = result.failure;
      } else {
        const endTime = input.triggerCreatedAt ? apiTime(input.triggerCreatedAt) : undefined;
        const triggerMillis = parseFeishuTime(input.triggerCreatedAt) ?? this.clock().getTime();
        const startTime = String(Math.floor((triggerMillis - this.config.group.lookbackHours * 3_600_000) / 1_000));
        const result = await this.collectPages({
          containerType: 'chat', containerId: input.chatId, order: 'desc', pageSize: 50, startTime, endTime,
        }, deadline);
        raw.push(...result.messages);
        truncated = result.truncated;
        unavailableReason = result.failure;
      }
    } catch (error) {
      unavailableReason = errorReason(error);
    }

    const topicRootId = scope === 'topic' ? (input.rootId ?? raw[0]?.messageId) : undefined;
    const triggerImages = raw.find((message) => message.messageId === input.triggerMessageId)?.images ?? [];
    const focusedMessageId = findFocusedMessageId(raw, input.referenceText, input.triggerCreatedAt);
    let messages = dedupe(raw)
      .filter((message) => !message.deleted && message.messageId !== input.triggerMessageId)
      .filter((message) => !input.triggerCreatedAt || compareTimes(message.createdAt, input.triggerCreatedAt) <= 0)
      .filter((message) => !input.afterCreatedAt || message.messageId === topicRootId
        || compareTimes(message.createdAt, input.afterCreatedAt) > 0)
      .filter((message) => !input.beforeCreatedAt || compareTimes(message.createdAt, input.beforeCreatedAt) <= 0)
      .map((message) => normalizeMessage(message, this.config.includeMediaPlaceholders))
      .filter((message): message is ConversationContextMessage => Boolean(message))
      .sort((left, right) => compareTimes(left.createdAt, right.createdAt));

    const configuredMaxMessages = scope === 'topic' ? this.config.topic.maxMessages : this.config.group.maxMessages;
    const configuredMaxChars = scope === 'topic' ? this.config.topic.maxChars : this.config.group.maxChars;
    const maxMessages = Math.min(configuredMaxMessages, input.maxMessages ?? configuredMaxMessages);
    const maxChars = Math.min(configuredMaxChars, input.maxChars ?? configuredMaxChars);
    if (messages.length > maxMessages) {
      truncated = true;
      if (scope === 'topic') {
        const root = messages[0];
        const focus = focusedMessageId ? messages.find((message) => message.messageId === focusedMessageId) : undefined;
        const retained = messages.slice(-(maxMessages - (root ? 1 : 0) - (focus && focus !== root ? 1 : 0)));
        messages = dedupeContextMessages([...(root ? [root] : []), ...(focus && focus !== root ? [focus] : []), ...retained])
          .sort((left, right) => compareTimes(left.createdAt, right.createdAt));
      } else {
        messages = messages.slice(-maxMessages);
      }
    }
    const bounded = boundChars(messages, maxChars, scope === 'topic', focusedMessageId);
    messages = bounded.messages;
    truncated ||= bounded.truncated;
    const last = messages.at(-1);
    return {
      ...base, messages, truncated, ...(unavailableReason ? { unavailableReason } : {}),
      images: [...messages.flatMap((message) => message.images ?? []), ...triggerImages]
        .filter((image) => Boolean(image.dataUrl)).slice(0, 8),
      fetchedAt: this.clock().toISOString(),
      ...(last ? { lastMessage: { messageId: last.messageId, createdAt: last.createdAt } } : {}),
    };
  }

  private async resolveRoot(input: ConversationContextRequest, deadline: number): Promise<FeishuHistoryMessage | undefined> {
    if (input.rootId) return withDeadline(this.client.getMessage(input.rootId), deadline);
    const trigger = await withDeadline(this.client.getMessage(input.triggerMessageId), deadline);
    const rootId = trigger?.rootId ?? (trigger?.threadId ? trigger.messageId : undefined);
    if (!rootId || rootId === trigger?.messageId) return trigger;
    return withDeadline(this.client.getMessage(rootId), deadline);
  }

  private async collectPages(
    request: Parameters<FeishuHistoryClient['listMessages']>[0],
    deadline: number,
  ): Promise<{ messages: FeishuHistoryMessage[]; truncated: boolean; failure?: string }> {
    const messages: FeishuHistoryMessage[] = [];
    let pageToken: string | undefined;
    let hasMore = true;
    let pages = 0;
    while (hasMore && pages < 20) {
      try {
        const page = await withDeadline(this.client.listMessages({ ...request, ...(pageToken ? { pageToken } : {}) }), deadline);
        messages.push(...page.messages);
        hasMore = page.hasMore;
        pageToken = page.pageToken;
        pages += 1;
        if (hasMore && !pageToken) return { messages, truncated: true, failure: 'missing_page_token' };
      } catch (error) {
        if (messages.length === 0) throw error;
        return { messages, truncated: true, failure: 'partial_fetch_failed' };
      }
    }
    return { messages, truncated: hasMore };
  }
}

function normalizeMessage(message: FeishuHistoryMessage, includeMedia: boolean): ConversationContextMessage | undefined {
  if (message.messageType === 'system') return undefined;
  let text = message.messageType === 'merge_forward'
    ? formatForwardedMessages(message.forwardedMessages ?? [], message.forwardedMessagesUnavailableReason)
    : message.messageType === 'interactive' ? extractCardText(message.content) : extractText(message.messageType, message.content);
  if (!text && includeMedia && ['image', 'file', 'audio', 'video', 'media'].includes(message.messageType)) {
    text = `[${message.messageType} message: ${message.messageId}]`;
  }
  if (!text?.trim()) return undefined;
  return {
    messageId: message.messageId,
    ...(message.senderId ? { senderId: message.senderId } : {}),
    ...(message.senderName ? { senderName: message.senderName } : {}),
    createdAt: message.createdAt,
    messageType: message.messageType,
    text: text.trim(),
    ...(message.threadId ? { threadId: message.threadId } : {}),
    ...(message.updated ? { edited: true } : {}),
    ...(message.images?.length ? { images: message.images } : {}),
    ...(message.messageType === 'interactive' ? cardLinks(message.content) : {}),
    ...(message.messageType === 'share_chat' && sharedChat(message.content)
      ? { sharedChat: sharedChat(message.content)! } : {}),
  };
}

function sharedChat(contentJson: string): { chatId: string } | undefined {
  let content: unknown;
  try { content = JSON.parse(contentJson); } catch { return undefined; }
  return isRecord(content) && typeof content.chat_id === 'string' && /^oc_[A-Za-z0-9_-]{1,120}$/.test(content.chat_id)
    ? { chatId: content.chat_id } : undefined;
}

function cardLinks(contentJson: string): { links?: ConversationContextLink[] } {
  let value: unknown;
  try { value = JSON.parse(contentJson); } catch { return {}; }
  const links: ConversationContextLink[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const match of node.matchAll(/\[([^\]]+)]\((https:\/\/github\.com\/[^\s)]+\/pull\/\d+[^\s)]*)\)/gi)) {
        links.push({ url: match[2]!, label: match[1]!, surroundingText: node });
      }
      return;
    }
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!isRecord(node)) return;
    const url = [node.href, node.url].find((item): item is string => typeof item === 'string' && /github\.com\/.+\/pull\/\d+/i.test(item));
    if (url) {
      const strings: string[] = [];
      const collect = (child: unknown, key?: string): void => {
        if (typeof child === 'string' && key !== 'href' && key !== 'url') strings.push(child);
        else if (Array.isArray(child)) child.forEach((item) => collect(item));
        else if (isRecord(child)) Object.entries(child).forEach(([childKey, item]) => collect(item, childKey));
      };
      collect(node);
      const label = strings.find((item) => item.trim())?.trim();
      links.push({ url, ...(label ? { label, surroundingText: strings.join('\n') } : {}) });
    }
    Object.values(node).forEach(visit);
  };
  visit(value);
  const unique = [...new Map(links.map((link) => [`${link.url}|${link.label ?? ''}`, link])).values()];
  return unique.length ? { links: unique } : {};
}

function formatForwardedMessages(messages: FeishuHistoryMessage[], unavailableReason?: string): string {
  if (messages.length === 0) return unavailableReason
    ? `<forwarded_messages unavailable="${escapeXml(unavailableReason)}"/>`
    : '<forwarded_messages/>';
  const lines = messages.slice(0, 50).flatMap((message) => {
    const text = message.messageType === 'interactive'
      ? extractCardText(message.content)
      : extractText(message.messageType, message.content);
    if (!text.trim() && !message.images?.length) return [];
    const sender = message.senderName ?? message.senderId ?? 'unknown';
    const media = message.images?.length ? `\n[${message.images.length} image(s) attached]` : '';
    return [`[${message.createdAt}] ${sender}:\n${text.trim()}${media}`];
  });
  return lines.length ? `<forwarded_messages>\n${lines.join('\n')}\n</forwarded_messages>` : '<forwarded_messages/>';
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function extractCardText(contentJson: string): string {
  let value: unknown;
  try { value = JSON.parse(contentJson); } catch { return ''; }
  const lines: string[] = [];
  const visit = (node: unknown, key?: string): void => {
    if (typeof node === 'string') {
      if (['content', 'text', 'title', 'href', 'url'].includes(key ?? '') && node.trim()) lines.push(node.trim());
      return;
    }
    if (Array.isArray(node)) { for (const item of node) visit(item); return; }
    if (!isRecord(node)) return;
    for (const [childKey, child] of Object.entries(node)) visit(child, childKey);
  };
  visit(value);
  return [...new Set(lines)].join('\n');
}

function extractText(type: string, contentJson: string): string {
  if (type === 'share_chat') {
    const reference = sharedChat(contentJson);
    return reference ? `[Shared chat card: chat_id=${reference.chatId}]` : '[Shared chat card: target chat ID unavailable]';
  }
  let content: unknown;
  try { content = JSON.parse(contentJson); } catch { return ''; }
  if (type === 'text') return isRecord(content) && typeof content.text === 'string' ? content.text : '';
  if (type !== 'post') return '';
  const post = isRecord(content) && isRecord(content.post)
    ? content.post.zh_cn ?? content.post.en_us ?? Object.values(content.post).find(isRecord)
    : content;
  if (!isRecord(post)) return '';
  const lines = typeof post.title === 'string' ? [post.title] : [];
  if (Array.isArray(post.content)) {
    for (const row of post.content) {
      if (!Array.isArray(row)) continue;
      const line = row.map((item) => isRecord(item)
        ? `${typeof item.text === 'string' ? item.text : ''}${item.tag === 'a' && typeof item.href === 'string' ? ` (${item.href})` : ''}`
        : '').join('').trim();
      if (line) lines.push(line);
    }
  }
  return lines.join('\n');
}

function boundChars(messages: ConversationContextMessage[], maxChars: number, preserveFirst: boolean, focusedMessageId?: string) {
  const first = preserveFirst ? messages[0] : undefined;
  const focused = focusedMessageId ? messages.find((message) => message.messageId === focusedMessageId && message !== first) : undefined;
  if (first && first.text.length >= maxChars) {
    if (!focused) return { messages: [{ ...first, text: first.text.slice(0, maxChars) }], truncated: true };
    const focusBudget = Math.min(focused.text.length, Math.max(1, Math.floor(maxChars * 0.75)));
    const rootBudget = Math.max(0, maxChars - focusBudget);
    return { messages: [
      ...(rootBudget ? [{ ...first, text: first.text.slice(0, rootBudget) }] : []),
      { ...focused, text: focused.text.slice(0, focusBudget) },
    ], truncated: true };
  }
  const remainingForFocus = Math.max(0, maxChars - (first?.text.length ?? 0));
  const boundedFocus = focused && remainingForFocus > 0
    ? { ...focused, text: focused.text.slice(0, remainingForFocus) }
    : undefined;
  const selected: ConversationContextMessage[] = boundedFocus ? [boundedFocus] : [];
  let chars = (first?.text.length ?? 0) + (boundedFocus?.text.length ?? 0);
  for (let index = messages.length - 1; index >= (first ? 1 : 0); index -= 1) {
    const message = messages[index]!;
    if (message === focused) continue;
    if (chars + message.text.length > maxChars) continue;
    selected.unshift(message);
    chars += message.text.length;
  }
  if (first) selected.unshift(first);
  selected.sort((left, right) => compareTimes(left.createdAt, right.createdAt));
  return { messages: selected, truncated: selected.length !== messages.length };
}

function findFocusedMessageId(messages: FeishuHistoryMessage[], referenceText?: string, triggerCreatedAt?: string): string | undefined {
  if (!referenceText || !/(?:上面|之前|此前|历史|转发|消息|那条|这条|\d{1,2}:\d{2})/i.test(referenceText)) return undefined;
  const time = /(?:^|\D)([01]?\d|2[0-3]):([0-5]\d)(?:\D|$)/.exec(referenceText);
  const beforeTrigger = messages.filter((message) => !triggerCreatedAt || compareTimes(message.createdAt, triggerCreatedAt) < 0);
  const matchingType = /转发/.test(referenceText) ? beforeTrigger.filter((message) => message.messageType === 'merge_forward') : beforeTrigger;
  const matchingTime = time ? matchingType.filter((message) => {
    const millis = parseFeishuTime(message.createdAt);
    if (millis === undefined) return false;
    const date = new Date(millis);
    return date.getHours() === Number(time[1]) && date.getMinutes() === Number(time[2]);
  }) : matchingType;
  return matchingTime.sort((left, right) => compareTimes(right.createdAt, left.createdAt))[0]?.messageId;
}

function dedupeContextMessages(messages: ConversationContextMessage[]): ConversationContextMessage[] {
  return [...new Map(messages.map((message) => [message.messageId, message])).values()];
}

function dedupe(messages: FeishuHistoryMessage[]): FeishuHistoryMessage[] {
  const unique = new Map<string, FeishuHistoryMessage>();
  for (const message of messages) {
    const existing = unique.get(message.messageId);
    if (!existing || isRicherMessage(message, existing)) unique.set(message.messageId, message);
  }
  return [...unique.values()];
}

function isRicherMessage(candidate: FeishuHistoryMessage, current: FeishuHistoryMessage): boolean {
  const candidateForwarded = candidate.forwardedMessages?.length ?? 0;
  const currentForwarded = current.forwardedMessages?.length ?? 0;
  if (candidateForwarded !== currentForwarded) return candidateForwarded > currentForwarded;
  const candidateImages = candidate.images?.filter((image) => image.dataUrl).length ?? 0;
  const currentImages = current.images?.filter((image) => image.dataUrl).length ?? 0;
  if (candidateImages !== currentImages) return candidateImages > currentImages;
  return true;
}

function compareTimes(left: string, right: string): number {
  return (parseFeishuTime(left) ?? 0) - (parseFeishuTime(right) ?? 0);
}

function parseFeishuTime(value?: string): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) {
    const number = Number(value);
    return value.length <= 10 ? number * 1_000 : number;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function apiTime(value: string): string {
  const millis = parseFeishuTime(value);
  return millis === undefined ? value : String(Math.floor(millis / 1_000));
}

async function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('conversation_context_timeout');
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('conversation_context_timeout')), remaining); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorReason(error: unknown): string {
  return error instanceof Error && error.message === 'conversation_context_timeout' ? 'timeout' : 'fetch_failed';
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}
