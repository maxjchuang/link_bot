import type { BotConfig } from '../domain/types.js';
import type { FeishuIncomingMessage } from './FeishuGateway.js';

export interface AmbientTopicState {
  id: string;
  chatId: string;
  topicId: string;
  activeSpeakerUserId?: string;
  lastHumanUserId: string;
  lastMessageId: string;
  lastMessageCreatedAt: string;
  updatedAt: string;
}

export interface AmbientTopicStateStore {
  getAmbientTopicState(chatId: string, topicId: string): AmbientTopicState | undefined;
  applyAmbientTopicMessage(input: {
    chatId: string; topicId: string; userId: string; messageId: string;
    createdAt: string; wasMentioned: boolean; seed?: AmbientTopicState;
  }): AmbientTopicState;
  deleteAmbientTopicState(chatId: string, topicId: string): void;
}

export function isAmbientTopicCandidate(
  config: Pick<BotConfig, 'conversationRouting'>,
  message: Pick<FeishuIncomingMessage, 'chatId' | 'chatType' | 'threadId' | 'rootId' | 'parentId'>,
): boolean {
  const restrictedChats = config.conversationRouting.ambientChats;
  // Feishu topic-root events already carry thread_id, but do not carry
  // root_id/parent_id. Accept the root so its explicit mention can grant the
  // conversational floor before the first reply arrives.
  return message.chatType === 'group' && Boolean(message.threadId)
    && (restrictedChats.length === 0 || restrictedChats.some((entry) => entry.chatId === message.chatId));
}

/**
 * Maintains a topic's conversational floor. An explicit bot mention grants the
 * floor to its sender; the same sender can continue without mentioning the bot.
 * Any different human message revokes the floor unless that message explicitly
 * mentions the bot, in which case the floor transfers to the new sender.
 */
export class AmbientTopicAuthorizer {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly config: Pick<BotConfig, 'conversationRouting'>,
    private readonly store: AmbientTopicStateStore,
    private readonly options: {
      audit?: (type: string, data: Record<string, unknown>) => void;
      clock?: () => Date;
    } = {},
  ) {}

  async observe(message: FeishuIncomingMessage): Promise<void> {
    if (!isAmbientTopicCandidate(this.config, message) || !message.messageId || !message.threadId) return;
    const key = topicKey(message.chatId, message.threadId);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.observeSerial(message));
    const settled = current.then(() => undefined, () => undefined);
    this.queues.set(key, settled);
    try { await current; }
    finally { if (this.queues.get(key) === settled) this.queues.delete(key); }
  }

  allows(message: FeishuIncomingMessage): boolean {
    if (!isAmbientTopicCandidate(this.config, message) || !message.messageId || !message.threadId) return false;
    const state = this.store.getAmbientTopicState(message.chatId, message.threadId);
    return state?.lastMessageId === message.messageId && state.activeSpeakerUserId === message.userId;
  }

  clear(chatId: string, topicId: string): void {
    this.store.deleteAmbientTopicState(chatId, topicId);
  }

  private async observeSerial(message: FeishuIncomingMessage): Promise<void> {
    const topicId = message.threadId!;
    const current = this.store.getAmbientTopicState(message.chatId, topicId);
    // Unknown topics are activated only by an explicit mention. This keeps
    // mention-free traffic from causing history reads or broad topic capture.
    if (!current && message.wasMentioned !== true) return;
    const state = this.store.applyAmbientTopicMessage({
      chatId: message.chatId, topicId, userId: message.userId, messageId: message.messageId!,
      createdAt: message.createdAt ?? (this.options.clock ?? (() => new Date()))().toISOString(),
      wasMentioned: message.wasMentioned === true,
    });
    this.options.audit?.('ambient_topic.floor_observed', {
      chatId: message.chatId, topicId, messageId: message.messageId,
      activeSpeakerUserId: state.activeSpeakerUserId, lastHumanUserId: state.lastHumanUserId,
    });
  }

}

export function transitionAmbientTopicState(
  current: AmbientTopicState | undefined,
  input: { chatId: string; topicId: string; userId: string; messageId: string; createdAt: string; wasMentioned: boolean },
  updatedAt: string,
): AmbientTopicState {
  return transition(current, { ...input, updatedAt });
}

function transition(
  current: AmbientTopicState | undefined,
  input: { chatId: string; topicId: string; userId: string; messageId: string; createdAt: string; wasMentioned: boolean; updatedAt: string },
): AmbientTopicState {
  if (current && compareOrder(input.createdAt, input.messageId, current.lastMessageCreatedAt, current.lastMessageId) <= 0) return current;
  const activeSpeakerUserId = input.wasMentioned
    ? input.userId
    : current?.activeSpeakerUserId && current.activeSpeakerUserId === input.userId
      ? current.activeSpeakerUserId
      : undefined;
  return {
    id: topicKey(input.chatId, input.topicId), chatId: input.chatId, topicId: input.topicId,
    ...(activeSpeakerUserId ? { activeSpeakerUserId } : {}),
    lastHumanUserId: input.userId, lastMessageId: input.messageId,
    lastMessageCreatedAt: input.createdAt, updatedAt: input.updatedAt,
  };
}

function compareOrder(leftTime: string, leftId: string, rightTime: string, rightId: string): number {
  const left = Number(leftTime); const right = Number(rightTime);
  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
  if (leftTime !== rightTime) return leftTime.localeCompare(rightTime);
  return leftId.localeCompare(rightId);
}

function topicKey(chatId: string, topicId: string): string { return `${chatId}:${topicId}`; }
