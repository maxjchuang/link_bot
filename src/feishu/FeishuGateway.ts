import * as lark from '@larksuiteoapi/node-sdk';
import QRCode from 'qrcode';
import { platformMessageAppLink } from './MessageAppLink.js';
import type { ChatType } from '../domain/types.js';
import type { BotErrorLogEntry, BotEvent } from '../domain/types.js';
import type { RenderedFeishuMessage } from './FeishuMessageRenderer.js';
import type { FeishuIncomingCardAction } from './FeishuCardActions.js';
import { parseCardActionValue } from './FeishuCardActions.js';
import { sanitizeFeishuText } from './FeishuTextSanitizer.js';
import { createAppLogger, type AppLogger, type LogLevel } from '../logging/AppLogger.js';
import {
  CardKitApiError,
  type CardKitGateway,
} from '../livecards/LiveTurnCardTypes.js';
import type { IncomingResourceDescriptor, MediaKind } from '../media/MediaTypes.js';
import { timelineRegionUpdates } from '../livecards/TimelineRegionUpdates.js';

export interface FeishuIncomingMessage {
  chatId: string;
  chatType: ChatType;
  userId: string;
  messageId?: string;
  threadId?: string;
  rootId?: string;
  parentId?: string;
  createdAt?: string;
  text: string;
  resources?: IncomingResourceDescriptor[];
  images?: Array<{ url: string; detail?: 'auto' | 'low' | 'high' }>;
  wasMentioned?: boolean;
  mentionsOpenIds?: string[];
  mentions?: FeishuUserMention[];
  botOpenIdResolved?: boolean;
  source?: 'message' | 'bot_menu';
  eventId?: string;
}

export interface FeishuUserMention {
  key: string;
  name?: string;
  openId: string;
  isBot?: boolean;
}

export type FeishuReactionType = string;

export interface FeishuReplyTarget {
  chatId: string;
  receiveIdType?: 'chat_id' | 'open_id';
  replyToMessageId?: string;
  replyInThread?: boolean;
  mentionUserId?: string;
}

export interface FeishuGateway extends CardKitGateway {
  start(
    onMessage: (message: FeishuIncomingMessage) => Promise<FeishuOutgoingReply>,
    onCardAction?: (action: FeishuIncomingCardAction) => Promise<FeishuOutgoingReply>,
    onTopicClosed?: (topic: { chatId: string; topicId: string; operatorUserId?: string }) => Promise<void>,
  ): Promise<void>;
  sendText(chatId: string, text: string): Promise<void>;
  sendTextToTarget(target: FeishuReplyTarget, text: string): Promise<void>;
  resolveChatMemberOpenId?(chatId: string, exactName: string): Promise<string | undefined>;
  sendRenderedMessage(
    chatId: string,
    message: { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage },
  ): Promise<void>;
  sendRenderedMessageToTarget(
    target: FeishuReplyTarget,
    message: { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage },
  ): Promise<void>;
  sendOperationCardToTarget?(target: FeishuReplyTarget, card: Record<string, unknown>, uuid: string): Promise<{ messageId: string; messageAppLink?: string }>;
  resolveOperationCardLink?(messageId: string): Promise<string | undefined>;
  verifySensitiveReplySource?(messageId: string, chatId: string, userId: string): Promise<boolean>;
  sendSensitiveReplyPrivate?(userId: string, text: string, uuid: string): Promise<{ messageId: string }>;
  sendDetailFileToTarget?(target: FeishuReplyTarget, resourceKey: string, uuid: string): Promise<{ messageId: string }>;
  resolveDetailMessageScope?(messageId: string): Promise<{ chatId: string; chatType: 'private' | 'group'; topicId?: string } | undefined>;
  isDetailReaderMember?(chatId: string, userId: string): Promise<boolean>;
  replaceDetailMessageCard?(messageId: string, card: Record<string, unknown>): Promise<void>;
  updateMessageCard(
    messageId: string,
    message: { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage },
  ): Promise<void>;
  deleteMessage?(messageId: string): Promise<void>;
  addReaction?(messageId: string, emojiType: FeishuReactionType): Promise<void>;
  uploadImage?(image: Buffer): Promise<string>;
  uploadFile?(file: Buffer, fileName: string): Promise<string>;
  downloadMessageResource?(input: {
    messageId: string; resourceKey: string; kind: MediaKind; maxBytes: number;
  }): Promise<{ data: Buffer; declaredMime?: string }>;
  sendMediaToTarget?(target: FeishuReplyTarget, media: {
    kind: MediaKind; resourceKey: string; uuid: string;
  }): Promise<{ messageId?: string }>;
}

export interface FeishuOutgoingReply {
  text: string;
  toast?: { type: 'success' | 'error' | 'info' | 'warning'; content: string };
  rendered?: { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage };
  delivery?: FeishuReplyDelivery;
}

export interface FeishuReplyDelivery {
  kind: 'update_origin_card' | 'delete_origin_message';
  onFailure: 'reply_rendered' | 'reply_text';
}

interface LarkReceiveMessageEvent {
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
    mentions?: Array<{
      key?: string;
      name?: string;
      id?: {
        open_id?: string;
      };
    }>;
  };
  sender?: {
    sender_id?: {
      open_id?: string;
    };
  };
}

interface LarkCardActionPayload {
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
}

interface LarkCardActionEvent extends LarkCardActionPayload {
  event?: LarkCardActionPayload;
}

interface LarkCardActionCallbackResponse {
  toast?: FeishuOutgoingReply['toast'];
  card?: {
    type: 'raw';
    data: Record<string, unknown>;
  };
}

interface LarkBotMenuPayload {
  event_id?: string;
  event_key?: string;
  operator?: {
    operator_id?: {
      open_id?: string;
    };
  };
}

interface LarkBotMenuEvent extends LarkBotMenuPayload {
  event?: LarkBotMenuPayload;
}

interface LarkReactionCreatedEvent {
  event?: {
    message_id?: string;
    reaction_type?: { emoji_type?: string };
    user_id?: { open_id?: string };
  };
}

interface LarkClientLike {
  request?: (payload: {
    url: string;
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    data?: unknown;
    [key: string]: unknown;
  }) => Promise<unknown>;
  im: {
    v1: {
          message: {
        create: (payload: {
          params: { receive_id_type: 'chat_id' | 'open_id' };
          data: { receive_id: string; msg_type: 'text' | 'interactive' | 'image' | 'file'; content: string; uuid?: string };
        }) => Promise<unknown>;
        reply?: (payload: {
          path: { message_id: string };
          data: { msg_type: 'text' | 'interactive' | 'image' | 'file'; content: string; reply_in_thread?: boolean; uuid?: string };
        }) => Promise<unknown>;
        get?: (payload: { path: { message_id: string } }) => Promise<{ data?: { items?: Array<{ chat_id?: string; thread_id?: string }> } }>;
      };
      image?: {
        create: (payload: { data: { image_type: 'message'; image: Buffer } }) => Promise<{ image_key?: string } | null>;
      };
      file?: {
        create: (payload: { data: { file_type: 'stream'; file_name: string; file: Buffer } }) => Promise<{ file_key?: string } | null>;
      };
      messageResource?: {
        get: (payload: { params: { type: 'image' | 'file' }; path: { message_id: string; file_key: string } }) => Promise<{
          getReadableStream(): NodeJS.ReadableStream; headers?: Record<string, unknown>;
        }>;
      };
    };
  };
}

interface LarkWSClientLike {
  start(options: { eventDispatcher: unknown }): Promise<void> | void;
}

interface EventDispatcherLike {
  register: (handlers: {
    'im.message.receive_v1': (data: LarkReceiveMessageEvent) => Promise<void>;
    'card.action.trigger'?: (data: LarkCardActionEvent) => Promise<LarkCardActionCallbackResponse | void>;
    'application.bot.menu_v6'?: (data: LarkBotMenuEvent) => Promise<void>;
    'im.message.reaction.created_v1'?: (data: LarkReactionCreatedEvent) => Promise<void>;
  }) => unknown;
}

interface LoggerLike {
  info?: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface LarkGatewayDeps {
  client?: LarkClientLike;
  wsClient?: LarkWSClientLike;
  createEventDispatcher?: () => EventDispatcherLike;
  logger?: LoggerLike;
  logLevel?: LogLevel;
  recordEvent?: (event: BotEvent) => Promise<void>;
  recordError?: (entry: BotErrorLogEntry) => Promise<void>;
  resolvePrivateChatId?: (userId: string) => Promise<string | undefined>;
}

const FEISHU_TEXT_MESSAGE_MAX_CHARS = 15_000;
const BOT_MENU_COMMANDS: Record<string, string> = {
  current: '/current',
  tail: '/tail',
  status: '/status',
  project: '/projects',
  projects: '/projects',
  new: '/new',
  model: '/model',
  resume: '/resume',
  stop: '/stop',
  restart: '/restart',
  upgrade: '/upgrade',
};

export class LarkLongConnectionGateway implements FeishuGateway {
  private readonly client: LarkClientLike;
  private readonly sensitiveClient: LarkClientLike;
  private readonly wsClient: LarkWSClientLike;
  private readonly createEventDispatcher: () => EventDispatcherLike;
  private readonly logger: AppLogger;
  private readonly recordEvent?: (event: BotEvent) => Promise<void>;
  private readonly recordError?: (entry: BotErrorLogEntry) => Promise<void>;
  private readonly resolvePrivateChatId?: (userId: string) => Promise<string | undefined>;
  private botOpenId?: string;
  private readonly p2pChatIdsByUser = new Map<string, string>();

  constructor(appId: string, appSecret: string, deps?: LarkGatewayDeps) {
    this.client = deps?.client ?? new lark.Client({ appId, appSecret });
    // The SDK logs complete Axios errors (including request bodies) by default.
    // Sensitive delivery must not leak payloads through that lower-level logger.
    const quiet = () => undefined;
    this.sensitiveClient = deps?.client ?? new lark.Client({ appId, appSecret,
      logger: { trace: quiet, debug: quiet, info: quiet, warn: quiet, error: quiet } });
    this.wsClient = deps?.wsClient ?? new lark.WSClient({ appId, appSecret });
    this.createEventDispatcher = deps?.createEventDispatcher ?? (() => new lark.EventDispatcher({}));
    this.logger = createAppLogger({ level: deps?.logLevel, sink: deps?.logger ?? console });
    this.recordEvent = deps?.recordEvent;
    this.recordError = deps?.recordError;
    this.resolvePrivateChatId = deps?.resolvePrivateChatId;
  }

  async start(
    onMessage: (message: FeishuIncomingMessage) => Promise<FeishuOutgoingReply>,
    onCardAction?: (action: FeishuIncomingCardAction) => Promise<FeishuOutgoingReply>,
    onTopicClosed?: (topic: { chatId: string; topicId: string; operatorUserId?: string }) => Promise<void>,
  ): Promise<void> {
    this.botOpenId = await this.resolveBotOpenId();
    const dispatcher = this.createEventDispatcher();
    dispatcher.register({
        'im.message.reaction.created_v1': async (data) => {
          const event = data.event;
          if (!onTopicClosed || event?.reaction_type?.emoji_type?.toUpperCase() !== 'DONE' || !event.message_id) return;
          try {
            const response = await this.client.im.v1.message.get?.({ path: { message_id: event.message_id } });
            const message = response?.data?.items?.[0];
            if (!message?.chat_id || !message.thread_id) return;
            await onTopicClosed({
              chatId: message.chat_id,
              topicId: message.thread_id,
              ...(event.user_id?.open_id ? { operatorUserId: event.user_id.open_id } : {}),
            });
          } catch (error) {
            this.logger.error('feishu.topic_close_failed', { reason: error instanceof Error ? error.message : String(error) });
          }
        },
        'im.message.receive_v1': async (data: LarkReceiveMessageEvent) => {
          const message = data.message;
          const sender = data.sender?.sender_id;
          if (!message?.chat_id || !message.content || !sender?.open_id) {
            return;
          }
          const normalized = normalizeIncomingMessage(message.message_type, message.content, message.message_id);
          if (!normalized) {
            return;
          }
          if (message.chat_type === 'p2p') {
            this.p2pChatIdsByUser.set(sender.open_id, message.chat_id);
          }
          const wasMentioned = message.chat_type === 'group' && this.isMentioningBot(message);
          const userMentions = message.mentions?.flatMap((mention) =>
            mention.key && mention.id?.open_id
              ? [{
                key: mention.key,
                ...(mention.name ? { name: mention.name } : {}),
                openId: mention.id.open_id,
                ...(mention.id.open_id === this.botOpenId ? { isBot: true } : {}),
              }]
              : []) ?? [];
          const incomingMessage: FeishuIncomingMessage = {
            chatId: message.chat_id,
            chatType: message.chat_type === 'group' ? 'group' : 'private',
            userId: sender.open_id,
            messageId: message.message_id,
            ...(message.thread_id ? { threadId: message.thread_id } : {}),
            ...(message.root_id ? { rootId: message.root_id } : {}),
            ...(message.parent_id ? { parentId: message.parent_id } : {}),
            ...(message.create_time ? { createdAt: message.create_time } : {}),
            text: normalized.text,
            ...(normalized.resources.length > 0 ? { resources: normalized.resources } : {}),
            wasMentioned,
            mentionsOpenIds: message.mentions?.flatMap((mention) => (mention.id?.open_id ? [mention.id.open_id] : [])) ?? [],
            ...(userMentions.length > 0 ? { mentions: userMentions } : {}),
            botOpenIdResolved: Boolean(this.botOpenId),
            source: 'message',
          };

          let reply: FeishuOutgoingReply;
          try {
            reply = await onMessage(incomingMessage);
          } catch (error) {
            await this.recordProcessingFailure('handle_message', incomingMessage, undefined, error);
            this.logger.error('feishu.handle_message_failed', {
              chat: incomingMessage.chatId,
              user: incomingMessage.userId,
              reason: error instanceof Error ? error.message : String(error),
            });
            await this.sendTextToTarget(
              this.replyTargetForMessage(message.chat_id, incomingMessage),
              '任务处理失败，请稍后重试；也可以发送 /status 查看当前状态。',
            ).catch(() => undefined);
            return;
          }

          await this.sendReply(message.chat_id, incomingMessage, reply);
        },
        'card.action.trigger': async (data: LarkCardActionEvent) => {
          if (!onCardAction) {
            return;
          }

          const event = data.event ?? data;
          const userId = event?.operator?.open_id;
          if (!userId) {
            return;
          }

          const parsedAction = parseCardActionValue(event?.action?.value, event?.action?.form_value);
          if (!parsedAction) {
            return;
          }

          const originChatId = event?.context?.open_chat_id ?? event?.open_chat_id;
          if (!originChatId) {
            return;
          }
          const directUserCard = parsedAction.chatType === 'private'
            && parsedAction.chatId.startsWith('ou_')
            && parsedAction.chatId === userId;
          const detailAction = parsedAction.action.kind === 'turn_detail';
          if (!detailAction && parsedAction.chatId !== originChatId && !directUserCard) {
            return;
          }

          const contextThreadId = event?.context?.open_thread_id;
          const cardThreadId = !detailAction && parsedAction.chatType === 'group'
            && isRecord(event?.action?.value)
            && typeof event.action.value.topicId === 'string'
            && event.action.value.topicId.length > 0
            ? event.action.value.topicId
            : undefined;
          // Topic callbacks do not consistently include open_thread_id. The card value is
          // signed at render time, so it is a safe fallback; when both are present they must agree.
          if (contextThreadId && cardThreadId && contextThreadId !== cardThreadId) {
            return;
          }
          const threadId = contextThreadId ?? cardThreadId;

          const incomingAction: FeishuIncomingCardAction = {
            chatId: originChatId,
            chatType: detailAction && contextThreadId ? 'group' : parsedAction.chatType,
            userId,
            messageId: event?.context?.open_message_id ?? event?.open_message_id,
            ...(threadId ? { threadId } : {}),
            action: parsedAction.action,
          };

          const execute = async (): Promise<LarkCardActionCallbackResponse | void> => {
            let reply: FeishuOutgoingReply;
            try {
              reply = await onCardAction(incomingAction);
            } catch (error) {
              await this.recordProcessingFailure('handle_card_action', incomingAction, undefined, error);
              this.logger.error('feishu.handle_card_action_failed', {
                chat: incomingAction.chatId,
                user: incomingAction.userId,
                reason: error instanceof Error ? error.message : String(error),
              });
              await this.sendTextToTarget(
                this.replyTargetForMessage(originChatId, incomingAction),
                '操作处理失败，请稍后重试；系统未将本次操作视为成功。',
              ).catch(() => undefined);
              return;
            }

            const preferred = reply.rendered?.preferred;
            if (reply.delivery?.kind === 'delete_origin_message') {
              if (incomingAction.messageId) {
                void this.deleteMessage(incomingAction.messageId).catch(async (error) => {
                  this.logger.debug('feishu.message_delete_fallback', {
                    chat: incomingAction.chatId, messageId: incomingAction.messageId,
                    reason: error instanceof Error ? error.message : String(error),
                  });
                  if (preferred?.kind === 'card') {
                    await this.updateMessageCard(incomingAction.messageId!, reply.rendered!).catch(() => undefined);
                  }
                });
              }
              return;
            }
            if (reply.delivery?.kind === 'update_origin_card' && preferred?.kind === 'card') {
              return {
                card: {
                  type: 'raw',
                  data: preferred.payload,
                },
              };
            }

            await this.sendReply(originChatId, incomingAction, reply);
            if (reply.toast) return { toast: reply.toast };
          };
          if (!detailAction) return execute();
          // A slow read must not exceed the platform callback deadline. This acknowledges
          // receipt only: authorization/publication still run to completion, and failures
          // are delivered by execute() as a normal safe reply, never as a success toast.
          const done = execute().catch(() => ({ toast: { type: 'error' as const, content: '详情暂不可用，请重试。' } }));
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([done, new Promise<LarkCardActionCallbackResponse>((resolve) => {
              timer = setTimeout(() => resolve({ toast: { type: 'info', content: '正在读取详情，请查看当前会话中的详情卡片。' } }), 1200);
            })]);
          } finally { if (timer) clearTimeout(timer); }
        },
        'application.bot.menu_v6': async (data: LarkBotMenuEvent) => {
          const event = data.event ?? data;
          const userId = event.operator?.operator_id?.open_id;
          const command = commandForBotMenuKey(event.event_key);
          if (!userId || !command) {
            return;
          }

          let chatId = this.p2pChatIdsByUser.get(userId);
          if (!chatId && this.resolvePrivateChatId) {
            try {
              chatId = await this.resolvePrivateChatId(userId);
              if (chatId) {
                this.p2pChatIdsByUser.set(userId, chatId);
              }
            } catch (error) {
              const at = new Date().toISOString();
              const details = serializeError(error);
              const eventData: Record<string, unknown> = {
                userId,
                eventKey: event.event_key,
                ...details,
              };
              await this.recordEvent?.({
                type: 'feishu.bot_menu_route_resolution_failed',
                at,
                data: eventData,
              });
              await this.recordError?.({
                at,
                source: 'feishu.gateway',
                message: typeof details.errorMessage === 'string' ? details.errorMessage : 'Unknown error',
                data: { stage: 'resolve_bot_menu_chat', ...eventData },
              });
              this.logger.error('feishu.bot_menu_route_resolution_failed', {
                user: userId,
                eventKey: event.event_key,
                reason: details.errorMessage,
              });
              return;
            }
          }
          if (!chatId) {
            const eventData = {
              userId,
              eventKey: event.event_key,
              reason: 'missing_private_chat_id',
            };
            await this.recordEvent?.({
              type: 'feishu.bot_menu_ignored',
              at: new Date().toISOString(),
              data: eventData,
            });
            this.logger.info('feishu.bot_menu_ignored', {
              user: userId,
              eventKey: event.event_key,
              reason: eventData.reason,
            });
            return;
          }

          const incomingMessage: FeishuIncomingMessage = {
            chatId,
            chatType: 'private',
            userId,
            text: command,
            wasMentioned: true,
            mentionsOpenIds: [],
            botOpenIdResolved: Boolean(this.botOpenId),
            source: 'bot_menu',
            ...((data.event_id ?? event.event_id) ? { eventId: data.event_id ?? event.event_id } : {}),
          };

          let reply: FeishuOutgoingReply;
          try {
            reply = await onMessage(incomingMessage);
          } catch (error) {
            await this.recordProcessingFailure('handle_message', incomingMessage, undefined, error);
            this.logger.error('feishu.handle_message_failed', {
              chat: incomingMessage.chatId,
              user: incomingMessage.userId,
              reason: error instanceof Error ? error.message : String(error),
            });
            return;
          }

          await this.sendReply(chatId, incomingMessage, reply);
        },
      });
    await this.wsClient.start({
      eventDispatcher: dispatcher,
    });
    this.logger.info('gateway.started', {});
  }

  private async resolveBotOpenId(): Promise<string | undefined> {
    try {
      const response = await this.client.request?.({
        url: '/open-apis/bot/v3/info',
        method: 'GET',
      });
      const botOpenId =
        typeof response === 'object' && response !== null && 'bot' in response
          ? ((response as { bot?: { open_id?: string } }).bot?.open_id ?? undefined)
          : undefined;
      if (!botOpenId) {
        await this.recordEvent?.({
          type: 'feishu.bot_identity_failed',
          at: new Date().toISOString(),
          data: {
            stage: 'resolve_bot_open_id',
            reason: 'empty_open_id',
          },
        });
        return undefined;
      }
      await this.recordEvent?.({
        type: 'feishu.bot_identity_resolved',
        at: new Date().toISOString(),
        data: {
          botOpenId,
        },
      });
      return botOpenId;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.recordEvent?.({
        type: 'feishu.bot_identity_failed',
        at: new Date().toISOString(),
        data: {
          stage: 'resolve_bot_open_id',
          reason,
        },
      });
      this.logger.error('feishu.bot_identity_failed', {
        reason,
      });
      return undefined;
    }
  }

  private isMentioningBot(message: NonNullable<LarkReceiveMessageEvent['message']>): boolean {
    if (!this.botOpenId) {
      return false;
    }
    return message.mentions?.some((mention) => mention.id?.open_id === this.botOpenId) ?? false;
  }

  private async sendReply(
    chatId: string,
    message: FeishuIncomingMessage | FeishuIncomingCardAction,
    reply: FeishuOutgoingReply,
  ): Promise<void> {
    try {
      if (reply.delivery?.kind === 'update_origin_card' && 'action' in message) {
        await this.updateOriginCardOrFallback(message, reply);
        return;
      }
      const target = this.replyTargetForMessage(chatId, message);
      if (reply.rendered) {
        await this.sendRenderedMessageToTarget(target, reply.rendered);
      } else if (reply.text !== '') {
        await this.sendTextToTarget(target, reply.text);
      }
    } catch (error) {
      await this.recordProcessingFailure('send_reply', message, reply.text, error);
      this.logger.error('feishu.send_reply_failed', {
        chat: message.chatId,
        user: message.userId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async updateOriginCardOrFallback(
    message: FeishuIncomingCardAction,
    reply: FeishuOutgoingReply,
  ): Promise<void> {
    const target = this.replyTargetForMessage(message.chatId, message);
    const preferred = reply.rendered?.preferred;
    if (!message.messageId || !preferred || preferred.kind !== 'card') {
      await this.sendUpdateFallback(target, reply);
      return;
    }
    try {
      await this.updateMessageCard(message.messageId, reply.rendered!);
    } catch (error) {
      this.logger.debug('feishu.card_update_fallback', {
        chat: message.chatId,
        messageId: message.messageId,
        reason: error instanceof Error ? error.message : String(error),
      });
      await this.sendUpdateFallback(target, reply);
    }
  }

  private async sendUpdateFallback(target: FeishuReplyTarget, reply: FeishuOutgoingReply): Promise<void> {
    if (reply.delivery?.onFailure === 'reply_rendered' && reply.rendered) {
      await this.sendRenderedMessageToTarget(target, reply.rendered);
      return;
    }
    if (reply.text !== '') {
      await this.sendTextToTarget(target, reply.text);
    }
  }

  private replyTargetForMessage(
    chatId: string,
    message: FeishuIncomingMessage | FeishuIncomingCardAction,
  ): FeishuReplyTarget {
    return {
      chatId,
      replyToMessageId: message.messageId,
      replyInThread: message.chatType === 'group' && message.threadId ? true : undefined,
      mentionUserId: message.chatType === 'group' ? message.userId : undefined,
    };
  }

  async sendText(chatId: string, text: string): Promise<void> {
    await this.sendTextToTarget({ chatId }, text);
  }

  async resolveChatMemberOpenId(chatId: string, exactName: string): Promise<string | undefined> {
    if (!this.client.request || !chatId || !exactName.trim()) return undefined;
    const matches = new Set<string>();
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({ member_id_type: 'open_id', page_size: '100' });
      if (pageToken) query.set('page_token', pageToken);
      const response = await this.client.request({
        url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members?${query.toString()}`,
        method: 'GET',
      });
      const envelope = isRecord(response) ? response : {};
      const data = isRecord(envelope.data) ? envelope.data : {};
      const items = Array.isArray(data.items) ? data.items : [];
      for (const item of items) {
        const member = isRecord(item) ? item : {};
        if (typeof member.name === 'string' && member.name.trim() === exactName.trim()
          && typeof member.member_id === 'string' && /^ou_[A-Za-z0-9]+$/.test(member.member_id)) {
          matches.add(member.member_id);
        }
      }
      pageToken = data.has_more === true && typeof data.page_token === 'string' && data.page_token ? data.page_token : undefined;
    } while (pageToken);
    return matches.size === 1 ? [...matches][0] : undefined;
  }

  async resolveDetailMessageScope(messageId: string): Promise<{ chatId: string; chatType: 'private' | 'group'; topicId?: string } | undefined> {
    const data = await this.cardKitRequest({ url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, method: 'GET', data: undefined });
    const item = Array.isArray(data.items) && isRecord(data.items[0]) ? data.items[0] : undefined;
    if (!item || item.deleted === true || typeof item.chat_id !== 'string') return undefined;
    const chat = await this.cardKitRequest({ url: `/open-apis/im/v1/chats/${encodeURIComponent(item.chat_id)}`, method: 'GET', data: undefined });
    // chat_type is group visibility (private/public), not the conversation mode.
    if (chat.chat_mode === 'p2p') return { chatId: item.chat_id, chatType: 'private' };
    if (chat.chat_mode !== 'group' && chat.chat_mode !== 'topic') throw new Error('access_unavailable');
    return { chatId: item.chat_id, chatType: 'group', ...(typeof item.thread_id === 'string' ? { topicId: item.thread_id } : {}) };
  }

  async isDetailReaderMember(chatId: string, userId: string): Promise<boolean> {
    let token: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 200; page++) {
      const query = new URLSearchParams({ member_id_type: 'open_id', page_size: '100' });
      if (token) query.set('page_token', token);
      const data = await this.cardKitRequest({ url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members?${query.toString()}`, method: 'GET', data: undefined });
      if (Array.isArray(data.items) && data.items.some((item) => isRecord(item) && item.member_id === userId)) return true;
      if (data.has_more !== true || typeof data.page_token !== 'string' || seen.has(data.page_token)) return false;
      token = data.page_token; seen.add(token);
    }
    return false;
  }

  async replaceDetailMessageCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    await this.cardKitRequest({ url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, method: 'PATCH', data: { content: JSON.stringify(card) } });
  }

  async sendTextToTarget(target: FeishuReplyTarget, text: string): Promise<void> {
    const sanitizedText = sanitizeFeishuText(textWithMention(target, text));
    for (const chunk of splitFeishuMessages(sanitizedText)) {
      await this.sendPayloadToTarget(target, {
        msg_type: 'text',
        content: JSON.stringify({ text: chunk }),
      });
    }
  }

  async sendRenderedMessage(
    chatId: string,
    message: { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage },
  ): Promise<void> {
    await this.sendRenderedMessageToTarget({ chatId }, message);
  }

  async sendRenderedMessageToTarget(
    target: FeishuReplyTarget,
    message: { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage },
  ): Promise<void> {
    const rendered = renderedWithMention(target, message);
    try {
      await this.sendOneToTarget(rendered.target, rendered.message.preferred);
    } catch (error) {
      this.logger.debug('feishu.render_fallback', {
        chat: target.chatId,
        reason: error instanceof Error ? error.message : String(error),
      });
      await this.sendOneToTarget(rendered.target, rendered.message.fallback);
    }
  }

  async verifySensitiveReplySource(messageId: string, chatId: string, userId: string): Promise<boolean> {
    const data = await this.cardKitRequest({ url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, method: 'GET', data: undefined, timeout: 10_000 }, this.sensitiveClient);
    const item = Array.isArray(data.items) && isRecord(data.items[0]) ? data.items[0] : undefined;
    const sender = item && isRecord(item.sender) ? item.sender : undefined;
    return Boolean(item && item.deleted !== true && item.chat_id === chatId && sender?.sender_type === 'user'
      && sender.id_type === 'open_id' && sender.id === userId);
  }

  async sendSensitiveReplyPrivate(userId: string, text: string, uuid: string): Promise<{ messageId: string }> {
    if (!/^ou_[\w-]+$/.test(userId)) throw new Error('Invalid private recipient');
    const elements: Array<Array<Record<string, unknown>>> = [[{ tag: 'text', text }]];
    const urls = [...new Set([...text.matchAll(/https?:\/\/[^\s<>"`]+/g)].map((match) => {
      const url = match[0];
      return text[match.index! - 1] === '(' && url.endsWith(')') ? url.slice(0, -1) : url;
    }).filter((url) => /\/authorize(?:[?/#]|$)|[?&](?:code|token|access_token|auth_code|ticket|user_code|device_code|state|client_id)=/i.test(url)))];
    for (const url of urls.slice(0, 3)) {
      elements.push([{ tag: 'a', text: '打开原始链接', href: url }]);
      try {
        const image = await QRCode.toBuffer(url, { type: 'png', width: 320, margin: 2 });
        const uploaded: unknown = await this.sensitiveClient.im.v1.image?.create({ data: { image_type: 'message', image } });
        const key = isRecord(uploaded) ? uploaded.image_key ?? (isRecord(uploaded.data) ? uploaded.data.image_key : undefined) : undefined;
        if (typeof key !== 'string' || !key) throw new Error('Private QR upload unavailable');
        elements.push([{ tag: 'img', image_key: key }]);
      } catch { elements.push([{ tag: 'text', text: '二维码暂不可用，请使用上方原始链接。' }]); }
    }
    // Deliberately no generic logging, group fallback, email stripping, or redaction on this lane.
    const data = await this.cardKitRequest({ url: '/open-apis/im/v1/messages?receive_id_type=open_id', method: 'POST',
      data: { receive_id: userId, msg_type: 'post', content: JSON.stringify({ zh_cn: { title: 'Link Bot 私密交付', content: elements } }), uuid }, timeout: 10_000 }, this.sensitiveClient);
    if (typeof data.message_id !== 'string' || !data.message_id) throw new Error('Private receipt missing');
    return { messageId: data.message_id };
  }

  async sendOperationCardToTarget(target: FeishuReplyTarget, card: Record<string, unknown>, uuid: string): Promise<{ messageId: string; messageAppLink?: string }> {
    const payload = { msg_type: 'interactive', content: JSON.stringify(card), uuid };
    const response = target.replyToMessageId
      ? await this.cardKitRequest({ url: `/open-apis/im/v1/messages/${encodeURIComponent(target.replyToMessageId)}/reply`,
          method: 'POST', data: { ...payload, reply_in_thread: target.replyInThread } })
      : await this.cardKitRequest({ url: `/open-apis/im/v1/messages?receive_id_type=${target.receiveIdType ?? 'chat_id'}`,
          method: 'POST', data: { ...payload, receive_id: target.chatId } });
    if (typeof response.message_id !== 'string' || !response.message_id) throw new Error('Operation card receipt missing');
    const messageAppLink = platformMessageAppLink(response);
    return { messageId: response.message_id, ...(messageAppLink ? { messageAppLink } : {}) };
  }

  async resolveOperationCardLink(messageId: string): Promise<string | undefined> {
    const data = await this.cardKitRequest({ url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, method: 'GET', data: undefined, timeout: 5000 });
    const item = Array.isArray(data.items) && isRecord(data.items[0]) ? data.items[0] : undefined;
    return item && item.deleted !== true ? platformMessageAppLink(item) : undefined;
  }

  async sendDetailFileToTarget(target: FeishuReplyTarget, resourceKey: string, uuid: string): Promise<{ messageId: string }> {
    if (!target.replyToMessageId) throw new Error('Detail file source required');
    const response = await this.cardKitRequest({ url: `/open-apis/im/v1/messages/${encodeURIComponent(target.replyToMessageId)}/reply`,
      method: 'POST', data: { msg_type: 'file', content: JSON.stringify({ file_key: resourceKey }), uuid, reply_in_thread: target.replyInThread } });
    if (typeof response.message_id !== 'string' || !response.message_id) throw new Error('Detail file receipt missing');
    return { messageId: response.message_id };
  }

  async updateMessageCard(
    messageId: string,
    message: { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage },
  ): Promise<void> {
    if (message.preferred.kind !== 'card') {
      throw new Error('Feishu card update preferred rendering must be a card.');
    }
    if (!this.client.request) {
      throw new Error('Feishu card update API is unavailable');
    }
    await this.client.request({
      url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      method: 'PATCH',
      data: { content: JSON.stringify(message.preferred.payload) },
    });
  }

  async deleteMessage(messageId: string): Promise<void> {
    if (!this.client.request) throw new Error('Feishu message delete API is unavailable');
    await this.client.request({
      url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      method: 'DELETE',
    });
  }

  async uploadImage(image: Buffer): Promise<string> {
    const response = await this.client.im.v1.image?.create({ data: { image_type: 'message', image } });
    const imageKey = response?.image_key;
    if (!imageKey) throw new Error('Feishu image upload did not return image_key.');
    return imageKey;
  }

  async uploadFile(file: Buffer, fileName: string): Promise<string> {
    const response = await this.client.im.v1.file?.create({
      data: { file_type: 'stream', file_name: fileName, file },
    });
    const fileKey = response?.file_key;
    if (!fileKey) throw new Error('Feishu file upload did not return file_key.');
    return fileKey;
  }

  async downloadMessageResource(input: {
    messageId: string; resourceKey: string; kind: MediaKind; maxBytes: number;
  }): Promise<{ data: Buffer; declaredMime?: string }> {
    const resource = this.client.im.v1.messageResource;
    if (!resource) throw new Error('Feishu message resource API is unavailable.');
    const response = await resource.get({
      params: { type: input.kind },
      path: { message_id: input.messageId, file_key: input.resourceKey },
    });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.getReadableStream() as AsyncIterable<Buffer | string>) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > input.maxBytes) throw new Error(`Feishu ${input.kind} exceeds the configured size limit.`);
      chunks.push(buffer);
    }
    const contentType = response.headers?.['content-type'];
    return {
      data: Buffer.concat(chunks),
      ...(typeof contentType === 'string' ? { declaredMime: contentType.split(';')[0] } : {}),
    };
  }

  async sendMediaToTarget(
    target: FeishuReplyTarget,
    media: { kind: MediaKind; resourceKey: string; uuid: string },
  ): Promise<{ messageId?: string }> {
    const data = {
      msg_type: media.kind,
      content: JSON.stringify(media.kind === 'image'
        ? { image_key: media.resourceKey }
        : { file_key: media.resourceKey }),
      uuid: media.uuid,
    } as const;
    if (target.replyToMessageId && this.client.request) {
      const response = await this.client.request({
        url: `/open-apis/im/v1/messages/${encodeURIComponent(target.replyToMessageId)}/reply`,
        method: 'POST',
        data: { ...data, reply_in_thread: target.replyInThread },
      });
      return messageIdFromResponse(response);
    }
    if (this.client.request) {
      const receiveIdType = target.receiveIdType ?? 'chat_id';
      const response = await this.client.request({
        url: `/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
        method: 'POST', data: { receive_id: target.chatId, ...data },
      });
      return messageIdFromResponse(response);
    }
    await this.sendPayloadToTarget(target, data);
    return {};
  }

  async createCardKitEntity(card: Record<string, unknown>): Promise<{ cardId: string }> {
    const data = await this.cardKitRequest({
      url: '/open-apis/cardkit/v1/cards',
      method: 'POST',
      data: { type: 'card_json', data: JSON.stringify(card) },
    });
    const cardId = data.card_id;
    if (typeof cardId !== 'string' || cardId.length === 0) {
      throw new CardKitApiError('CardKit create response did not include card_id.', 'retryable');
    }
    return { cardId };
  }

  async sendCardKitEntityToTarget(
    target: FeishuReplyTarget,
    cardId: string,
    uuid: string,
  ): Promise<{ messageId: string }> {
    const payload = {
      msg_type: 'interactive' as const,
      content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
      uuid,
    };
    const response = target.replyToMessageId
      ? await this.cardKitRequest({
          url: `/open-apis/im/v1/messages/${encodeURIComponent(target.replyToMessageId)}/reply`,
          method: 'POST',
          data: { ...payload, reply_in_thread: target.replyInThread },
        })
      : await this.cardKitRequest({
          url: `/open-apis/im/v1/messages?receive_id_type=${target.receiveIdType ?? 'chat_id'}`,
          method: 'POST',
          data: { ...payload, receive_id: target.chatId },
        });
    const messageId = response.message_id;
    if (typeof messageId !== 'string' || messageId.length === 0) {
      throw new CardKitApiError('CardKit send response did not include message_id.', 'retryable');
    }
    return { messageId };
  }

  async updateCardKitElement(input: {
    cardId: string;
    elementId: string;
    element: Record<string, unknown>;
    sequence: number;
    uuid: string;
  }): Promise<void> {
    await this.cardKitRequest({
      url: `/open-apis/cardkit/v1/cards/${encodeURIComponent(input.cardId)}/elements/${encodeURIComponent(input.elementId)}`,
      method: 'PUT',
      data: {
        element: JSON.stringify(input.element),
        sequence: input.sequence,
        uuid: input.uuid,
      },
    });
  }

  async updateCardKitRegions(input: {
    cardId: string; regions: Array<{ elementId: string; element: Record<string, unknown>; previousElement?: Record<string, unknown> }>;
    sequence: number; uuid: string;
  }): Promise<void> {
    if (!input.regions.length || input.regions.length > 7
      || new Set(input.regions.map((region) => region.elementId)).size !== input.regions.length
      || input.regions.some((region) => !/^[A-Za-z][A-Za-z0-9_]{0,19}$/.test(region.elementId)
        || region.element.element_id !== region.elementId || region.element.tag !== 'column_set'
          && !(region.elementId === 'turn_timeline' && region.element.tag === 'collapsible_panel'))) throw new Error('Invalid card regions');
    await this.cardKitRequest({ url: `/open-apis/cardkit/v1/cards/${encodeURIComponent(input.cardId)}/batch_update`, method: 'POST',
      data: { sequence: input.sequence, uuid: input.uuid, actions: JSON.stringify(input.regions.flatMap((region) =>
        region.elementId==='timeline_content' && region.previousElement ? timelineRegionUpdates(region.previousElement,region.element) : [{
        action: 'update_element' as const, params: { element_id: region.elementId, element: region.element },
      }])) } });
  }

  async replaceCardKitEntity(input: {
    cardId: string;
    card: Record<string, unknown>;
    sequence: number;
    uuid: string;
  }): Promise<void> {
    await this.cardKitRequest({
      url: `/open-apis/cardkit/v1/cards/${encodeURIComponent(input.cardId)}`,
      method: 'PUT',
      data: {
        card: { type: 'card_json', data: JSON.stringify(input.card) },
        sequence: input.sequence,
        uuid: input.uuid,
      },
    });
  }

  private async cardKitRequest(input: {
    url: string;
    method: 'POST' | 'PUT' | 'GET' | 'PATCH';
    data: unknown;
    timeout?: number;
  }, client = this.client): Promise<Record<string, unknown>> {
    if (!client.request) {
      throw new CardKitApiError('Feishu CardKit API is unavailable.', 'permanent');
    }
    try {
      return cardKitResponseData(await client.request(input));
    } catch (error) {
      throw classifyCardKitThrownError(error);
    }
  }

  async addReaction(messageId: string, emojiType: FeishuReactionType): Promise<void> {
    if (!this.client.request) {
      throw new Error('Feishu reaction API is unavailable');
    }

    await this.client.request({
      url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
      method: 'POST',
      data: {
        reaction_type: {
          emoji_type: emojiType,
        },
      },
    });
  }

  private async sendOneToTarget(target: FeishuReplyTarget, message: RenderedFeishuMessage): Promise<void> {
    if (message.kind === 'text') {
      await this.sendTextToTarget(target, message.text);
      return;
    }

    await this.sendPayloadToTarget(target, {
      msg_type: 'interactive',
      content: JSON.stringify(message.payload),
    });
  }

  private async sendPayloadToTarget(
    target: FeishuReplyTarget,
    data: { msg_type: 'text' | 'interactive' | 'image' | 'file'; content: string; uuid?: string },
  ): Promise<void> {
    if (!target.replyToMessageId) {
      await this.sendPayloadToChat(target.chatId, data, target.receiveIdType);
      return;
    }

    try {
      await this.replyToMessage(target, {
        ...data,
        reply_in_thread: target.replyInThread,
      });
    } catch (error) {
      this.logger.error('feishu.reply_message_failed', {
        chat: target.chatId,
        messageId: target.replyToMessageId,
        reason: error instanceof Error ? error.message : String(error),
      });
      await this.sendPayloadToChat(target.chatId, data, target.receiveIdType);
    }
  }

  private async sendPayloadToChat(
    chatId: string,
    data: { msg_type: 'text' | 'interactive' | 'image' | 'file'; content: string; uuid?: string },
    receiveIdType: 'chat_id' | 'open_id' = 'chat_id',
  ): Promise<void> {
    await this.client.im.v1.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: chatId,
        ...data,
      },
    });
  }

  private async replyToMessage(
    target: FeishuReplyTarget,
    data: { msg_type: 'text' | 'interactive' | 'image' | 'file'; content: string; reply_in_thread?: boolean; uuid?: string },
  ): Promise<void> {
    if (!target.replyToMessageId) {
      throw new Error('Feishu reply target message id is required');
    }

    const reply = this.client.im.v1.message.reply;
    if (reply) {
      await reply({
        path: { message_id: target.replyToMessageId },
        data,
      });
      return;
    }

    if (this.client.request) {
      await this.client.request({
        url: `/open-apis/im/v1/messages/${encodeURIComponent(target.replyToMessageId)}/reply`,
        method: 'POST',
        data,
      });
      return;
    }

    throw new Error('Feishu reply API is unavailable');
  }

  private async recordProcessingFailure(
    stage: 'handle_message' | 'handle_card_action' | 'send_reply',
    message: FeishuIncomingMessage | FeishuIncomingCardAction,
    reply: string | undefined,
    error: unknown,
  ): Promise<void> {
    const at = new Date().toISOString();
    const details = serializeError(error);
    const data: Record<string, unknown> = {
      stage,
      chatId: message.chatId,
      chatType: message.chatType,
      userId: message.userId,
      messageId: message.messageId,
      ...details,
    };
    if ('text' in message) {
      data.text = message.text;
    } else {
      data.action = normalizeUnknown(message.action);
    }
    if (reply !== undefined) {
      data.replyPreview = reply.length <= 200 ? reply : `${reply.slice(0, 197)}...`;
    }

    if (this.recordEvent) {
      await this.recordEvent({
        type: 'feishu.message_processing_failed',
        at,
        data,
      });
    }
    if (this.recordError) {
      const errorMessage = typeof details.errorMessage === 'string' ? details.errorMessage : 'Unknown error';
      await this.recordError({
        at,
        source: 'feishu.gateway',
        message: errorMessage,
        data,
      });
    }
  }
}

function splitFeishuMessages(text: string): string[] {
  if (text.length <= FEISHU_TEXT_MESSAGE_MAX_CHARS) {
    return [text];
  }

  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += FEISHU_TEXT_MESSAGE_MAX_CHARS) {
    chunks.push(text.slice(index, index + FEISHU_TEXT_MESSAGE_MAX_CHARS));
  }
  return chunks;
}

function normalizeIncomingMessage(
  messageType: string | undefined,
  contentJson: string,
  messageId?: string,
): { text: string; resources: IncomingResourceDescriptor[] } | undefined {
  let content: unknown;
  try {
    content = JSON.parse(contentJson);
  } catch {
    return undefined;
  }

  if (messageType === 'text') {
    return { text: isRecord(content) && typeof content.text === 'string' ? content.text : '', resources: [] };
  }

  if (messageType === 'post') {
    return { text: extractPostText(content), resources: messageId ? extractIncomingResources(content, messageId) : [] };
  }

  if (messageType === 'image' && messageId && isRecord(content) && typeof content.image_key === 'string') {
    return { text: '', resources: [{ kind: 'image', resourceKey: content.image_key, resourceOwnerMessageId: messageId }] };
  }

  if (messageType === 'file' && messageId && isRecord(content) && typeof content.file_key === 'string') {
    return {
      text: '',
      resources: [{
        kind: 'file', resourceKey: content.file_key, resourceOwnerMessageId: messageId,
        ...(typeof content.file_name === 'string' ? { fileName: content.file_name } : {}),
      }],
    };
  }

  return undefined;
}

function extractIncomingResources(content: unknown, messageId: string): IncomingResourceDescriptor[] {
  const resources: IncomingResourceDescriptor[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!isRecord(value)) return;
    if (typeof value.image_key === 'string') {
      resources.push({ kind: 'image', resourceKey: value.image_key, resourceOwnerMessageId: messageId });
    }
    if (typeof value.file_key === 'string') {
      resources.push({
        kind: 'file', resourceKey: value.file_key, resourceOwnerMessageId: messageId,
        ...(typeof value.file_name === 'string' ? { fileName: value.file_name } : {}),
      });
    }
    Object.values(value).forEach(visit);
  };
  visit(content);
  return [...new Map(resources.map((resource) => [`${resource.kind}:${resource.resourceKey}`, resource])).values()];
}

function messageIdFromResponse(value: unknown): { messageId?: string } {
  if (!isRecord(value)) return {};
  const data = isRecord(value.data) ? value.data : value;
  return typeof data.message_id === 'string' ? { messageId: data.message_id } : {};
}

function extractPostText(content: unknown): string {
  const post = isRecord(content) && isRecord(content.post) ? selectLocalizedPost(content.post) : content;
  if (!isRecord(post)) {
    return '';
  }

  const lines: string[] = [];
  if (typeof post.title === 'string' && post.title.trim().length > 0) {
    lines.push(post.title.trim());
  }
  if (Array.isArray(post.content)) {
    for (const line of post.content) {
      if (!Array.isArray(line)) {
        continue;
      }
      const text = line.map(extractPostElementText).join('').trim();
      if (text.length > 0) {
        lines.push(text);
      }
    }
  }
  return lines.join('\n');
}

function selectLocalizedPost(post: Record<string, unknown>): unknown {
  return post.zh_cn ?? post.en_us ?? Object.values(post).find(isRecord) ?? post;
}

function extractPostElementText(element: unknown): string {
  if (!isRecord(element)) {
    return '';
  }

  const text = typeof element.text === 'string' ? element.text : '';
  if (element.tag === 'a' && typeof element.href === 'string' && element.href.length > 0) {
    return text.length > 0 ? `${text} ${element.href}` : element.href;
  }
  if (element.tag === 'at' && typeof element.user_name === 'string') {
    return element.user_name;
  }
  if (text.length > 0) {
    return text;
  }
  if (typeof element.name === 'string') {
    return element.name;
  }
  return '';
}

function commandForBotMenuKey(eventKey: string | undefined): string | undefined {
  if (!eventKey) {
    return undefined;
  }
  return BOT_MENU_COMMANDS[eventKey.trim().toLowerCase()];
}

function textWithMention(target: FeishuReplyTarget, text: string): string {
  if (!target.mentionUserId) {
    return text;
  }
  return `<at user_id="${escapeFeishuAttribute(target.mentionUserId)}"></at> ${text}`;
}

function renderedWithMention(
  target: FeishuReplyTarget,
  message: { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage },
): { target: FeishuReplyTarget; message: { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage } } {
  if (!target.mentionUserId) {
    return { target, message };
  }

  return {
    target: { ...target, mentionUserId: undefined },
    message: {
      preferred: renderedMessageWithMention(message.preferred, target.mentionUserId),
      fallback: renderedMessageWithMention(message.fallback, target.mentionUserId),
    },
  };
}

function renderedMessageWithMention(message: RenderedFeishuMessage, userId: string): RenderedFeishuMessage {
  if (message.kind === 'text') {
    return { kind: 'text', text: textWithMention({ chatId: '', mentionUserId: userId }, message.text) };
  }
  return { kind: 'card', payload: mentionCardMarkdown(message.payload, userId) };
}

function mentionCardMarkdown(payload: Record<string, unknown>, userId: string): Record<string, unknown> {
  const clone = cloneJsonObject(payload);
  const mention = `<at id="${escapeFeishuAttribute(userId)}"></at>\n`;
  prefixFirstMarkdownElement(clone, mention);
  return clone;
}

function prefixFirstMarkdownElement(value: unknown, prefix: string): boolean {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (prefixFirstMarkdownElement(item, prefix)) {
        return true;
      }
    }
    return false;
  }

  if (!isRecord(value)) {
    return false;
  }

  if (value.tag === 'markdown' && typeof value.content === 'string') {
    value.content = `${prefix}${value.content}`;
    return true;
  }

  for (const child of Object.values(value)) {
    if (prefixFirstMarkdownElement(child, prefix)) {
      return true;
    }
  }
  return false;
}

function cloneJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return cloneJsonValue(value) as Record<string, unknown>;
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item));
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = cloneJsonValue(entry);
    }
    return result;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeFeishuAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function cardKitResponseData(response: unknown): Record<string, unknown> {
  if (!isRecord(response)) {
    throw new CardKitApiError('Invalid CardKit response.', 'retryable');
  }
  const code = typeof response.code === 'number' ? response.code : undefined;
  if (code !== undefined && code !== 0) {
    throw classifyCardKitCode(code, typeof response.msg === 'string' ? response.msg : undefined);
  }
  return isRecord(response.data) ? response.data : {};
}

function classifyCardKitThrownError(error: unknown): CardKitApiError {
  if (error instanceof CardKitApiError) {
    return error;
  }
  const response = isRecord(error) && isRecord(error.response) ? error.response : undefined;
  const responseData = response && isRecord(response.data) ? response.data : undefined;
  const status = response && typeof response.status === 'number' ? response.status : undefined;
  const code = responseData && typeof responseData.code === 'number'
    ? responseData.code
    : isRecord(error) && typeof error.code === 'number'
      ? error.code
      : undefined;
  const message = responseData && typeof responseData.msg === 'string'
    ? responseData.msg
    : error instanceof Error
      ? error.message
      : 'CardKit request failed.';
  if (code !== undefined || status !== undefined) {
    const classified = classifyCardKitCode(code ?? status!, message, status);
    const headers = response && isRecord(response.headers) ? response.headers : undefined;
    const rawDelay = headers?.['retry-after'];
    const delay = typeof rawDelay === 'string' || typeof rawDelay === 'number'
      ? (Number.isFinite(Number(rawDelay)) ? Number(rawDelay) * 1000 : Date.parse(String(rawDelay)) - Date.now()) : undefined;
    return new CardKitApiError(classified.message, classified.category, classified.code,
      delay !== undefined && Number.isFinite(delay) && delay > 0 ? delay : undefined);
  }
  return new CardKitApiError(message, 'retryable');
}

function classifyCardKitCode(code: number, message?: string, status?: number): CardKitApiError {
  const payloadCodes = new Set([200860, 230025]);
  const permanentCodes = new Set([200740, 200750, 300311, 230027]);
  const category = payloadCodes.has(code)
    ? 'payload'
    : permanentCodes.has(code) || (status !== undefined && [401, 403, 404, 410].includes(status))
      ? 'permanent'
      : status === 429 || (status !== undefined && status >= 500) || code === 99991400 || code === 230020
        ? 'retryable'
        : status === 400 || status === 422 ? 'payload' : 'retryable';
  return new CardKitApiError(message ?? `CardKit request failed with code ${code}.`, category, code);
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const result: Record<string, unknown> = {
      errorMessage: error.message,
    };
    const maybeCode = Reflect.get(error, 'code');
    if (typeof maybeCode === 'string' && maybeCode.length > 0) {
      result.errorCode = maybeCode;
    }
    const maybeStack = Reflect.get(error, 'stack');
    if (typeof maybeStack === 'string' && maybeStack.length > 0) {
      result.errorStack = maybeStack;
    }
    const maybeResponse = Reflect.get(error, 'response');
    if (typeof maybeResponse === 'object' && maybeResponse !== null) {
      const status = Reflect.get(maybeResponse, 'status');
      if (typeof status === 'number') {
        result.responseStatus = status;
      }
      const data = Reflect.get(maybeResponse, 'data');
      if (data !== undefined) {
        result.responseData = normalizeUnknown(data);
      }
    }
    return result;
  }

  return {
    errorMessage: typeof error === 'string' ? error : String(error),
    errorValue: normalizeUnknown(error),
  };
}

function normalizeUnknown(value: unknown): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeUnknown(item));
  }
  if (typeof value === 'object') {
    const normalized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      normalized[key] = normalizeUnknown(entry);
    }
    return normalized;
  }
  return String(value);
}
