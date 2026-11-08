import { resolve } from 'node:path';
import { cwd } from 'node:process';
import { pathToFileURL } from 'node:url';
import { createTaskPlatform,type CreateTaskPlatformInput,type TaskPlatformApplication } from './app/createTaskPlatform.js';
import { taskPlatformEnabledFor } from './app/TaskPlatformRollout.js';
import { initializeProjectCodexHome,resolveCodexHomePaths } from './codex/CodexHome.js';
import { parseIncomingText } from './commands/CommandRouter.js';
import { loadConfig } from './config/loadConfig.js';
import { SensitiveReplyDelivery } from './details/SensitiveReplyDelivery.js';
import type { BotConfig,ClaimInboundMessageResult } from './domain/types.js';
import type { FeishuIncomingCardAction } from './feishu/FeishuCardActions.js';
import { LarkLongConnectionGateway,type FeishuGateway,type FeishuIncomingMessage } from './feishu/FeishuGateway.js';
import type { FeishuTaskController } from './feishu/FeishuTaskController.js';
import { HostControlClient,type HostControlMessageHandler } from './host/HostControlRpc.js';
import { createAppLogger } from './logging/AppLogger.js';
import { isAuthorizedChat,isAuthorizedMessage } from './security/guards.js';
import { classifyPublicFixedFlow } from './security/PublicFixedFlowPolicy.js';
import { resolveMentionedOpenIds,UserWhitelistManager } from './security/UserWhitelistManager.js';
import type { FileStateStore as FileStateStoreType } from './state/FileStateStore.js';
import { FileStateStore } from './state/FileStateStore.js';
import { DestructiveCommandCoordinator } from './upgrade/DestructiveCommandCoordinator.js';
import { UpgradeManager } from './upgrade/UpgradeManager.js';

export interface BootstrapDeps {
  projectRoot?: string;
  loadConfig?: (projectRoot: string) => Promise<BotConfig>;
  createStore?: (projectRoot: string) => FileStateStoreType;
  createGateway?: (
    appId: string,
    appSecret: string,
    observability?: {
      logLevel?: BotConfig['logLevel'];
      recordEvent: (event: import('./domain/types.js').BotEvent) => Promise<void>;
      recordError: (entry: import('./domain/types.js').BotErrorLogEntry) => Promise<void>;
      resolvePrivateChatId: (userId: string) => Promise<string | undefined>;
    },
  ) => FeishuGateway;
  logger?: Pick<typeof console, 'info' | 'error'>;
  taskController?: Pick<FeishuTaskController, 'handleMessage' | 'handleCardAction'> & Partial<Pick<FeishuTaskController, 'handleTopicClosed'>>;
  createTaskPlatform?: (input: CreateTaskPlatformInput) => TaskPlatformApplication;
  userWhitelistManager?: Pick<UserWhitelistManager, 'addUsers'>;
  hostControlSession?: HostControlMessageHandler;
}

export async function bootstrap(deps: BootstrapDeps = {}): Promise<void> {
  const projectRoot = deps.projectRoot ?? cwd();
  const loadConfigFn = deps.loadConfig ?? loadConfig;
  const createStoreFn = deps.createStore ?? ((root: string) => new FileStateStore(root));
  const createGatewayFn: NonNullable<BootstrapDeps['createGateway']> =
    deps.createGateway ??
    ((appId, appSecret, observability) => new LarkLongConnectionGateway(appId, appSecret, observability));

  const config = await loadConfigFn(projectRoot);
  const userWhitelistManager = deps.userWhitelistManager ?? new UserWhitelistManager(projectRoot, config);
  if (!config.taskPlatformRollout.enabled) throw new Error('The App Server task platform must be enabled.');
  if (!config.userSandboxes?.enabled || config.userSandboxes.legacyFallbackEnabled
    || config.userSandboxes.enabledOwners.length > 0 || config.readyPool.enabled) {
    throw new Error('User Sandbox must be enabled for all authorized owners with legacy fallback and task ready pool disabled.');
  }
  const logger = createAppLogger({ level: config.logLevel, sink: deps.logger ?? console });
  const store = createStoreFn(projectRoot);
  const codexHomeInit = await initializeProjectCodexHome({ projectRoot });
  const codexHomes = resolveCodexHomePaths(projectRoot);
  logger.info('startup.codex_home_ready', {
    codexHome: codexHomeInit.codexHome,
    configToml: codexHomeInit.configToml,
    copiedFrom: codexHomeInit.copiedFrom,
  });
  logger.info('startup.codex_session_isolation', {
    isolateSessions: config.codex.isolateSessions,
    projectCodexHome: codexHomes.project,
    globalCodexHome: codexHomes.global,
  });
  const gateway = createGatewayFn(config.feishu.appId, config.feishu.appSecret, {
    logLevel: config.logLevel,
    recordEvent: (event) => store.appendEvent(event),
    recordError: (entry) => store.appendErrorLog(entry),
    resolvePrivateChatId: (userId) => store.findPrivateChatIdByUser(userId),
  });
  const needsTaskPlatform = config.taskPlatformRollout.enabled;
  const taskPlatform = !deps.taskController && needsTaskPlatform
    ? (deps.createTaskPlatform ?? createTaskPlatform)({ projectRoot, config, codexHomes, gateway })
    : undefined;
  const taskController = deps.taskController ?? taskPlatform?.controller;
  // Task messages use the task platform SQLite receipt store.
  const inboundStore = taskPlatform?.store
    && typeof taskPlatform.store.claimInboundMessage === 'function'
    && typeof taskPlatform.store.completeInboundMessage === 'function'
    && typeof taskPlatform.store.failInboundMessage === 'function'
    ? taskPlatform.store
    : store;
  const destructiveCommandCoordinator = new DestructiveCommandCoordinator({
    store, config: config.upgrade,
    upgradeManager: new UpgradeManager({ projectRoot, config: config.upgrade }),
    notifier: gateway,
  });
  const hostControlSession = deps.hostControlSession ?? (config.hostControl?.enabled
    ? new HostControlClient(config.hostControl.socketPath)
    : undefined);
  if (taskPlatform) {
    logger.info('startup.task_health_started', {});
    const taskHealth = await taskPlatform.healthCheck();
    if (!taskHealth.ok) throw new Error(`Task platform health check failed: ${taskHealth.reason}`);
    logger.info('startup.task_recovery_started', {});
    await taskPlatform.recoverStartup();
    logger.info('startup.task_recovery_completed', {});
  }
  logger.info('startup.ready', {
    projects: config.projects.length,
    verbosity: config.ui.verbosity,
  });
  const onMessage = async (message: FeishuIncomingMessage) => {
    logger.info('inbound.received', {
      chat: message.chatId,
      type: message.chatType,
      messageId: message.messageId,
      threadId: message.threadId,
      text: message.text,
    });
    const receivedAt = new Date().toISOString();
    await store.appendEvent({
      type: 'command.received',
      at: receivedAt,
      data: {
        chatId: message.chatId,
        chatType: message.chatType,
        userId: message.userId,
        messageId: message.messageId,
        threadId: message.threadId,
        text: message.text,
        wasMentioned: message.wasMentioned,
        mentionsOpenIds: message.mentionsOpenIds,
        botOpenIdResolved: message.botOpenIdResolved,
      },
    });
    const generallyAuthorized = isAuthorizedMessage(config, message);
    try {
      if (generallyAuthorized) await taskPlatform?.observeAmbientMessage?.(message);
    } catch (error) {
      // Ambient state is an optional routing enhancement. A persistence failure
      // must fail closed for unmentioned chatter without blocking explicit
      // mentions or the public fixed workflows.
      logger.error('ambient_topic.observe_failed', {
        chat: message.chatId,
        threadId: message.threadId,
        messageId: message.messageId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    const ambientMessageAllowed = taskPlatform?.allowsAmbientMessage?.(message) === true;
    const publicFixedFlow = classifyPublicFixedFlow(config, message);
    if (message.chatType === 'group' && message.wasMentioned !== true && !publicFixedFlow
      && !ambientMessageAllowed) {
      logger.info('inbound.group_message_ignored', {
        chat: message.chatId, messageId: message.messageId, reason: 'bot_not_mentioned',
      });
      return { text: '', rendered: undefined };
    }
    const fixedFlowBypass = Boolean(publicFixedFlow) && isAuthorizedChat(config, message);
    if (!generallyAuthorized && !fixedFlowBypass) {
      logger.info('inbound.unauthorized_dropped', {
        chat: message.chatId,
        type: message.chatType,
        user: message.userId,
        messageId: message.messageId,
      });
      await store.appendEvent({
        type: 'command.unauthorized_dropped',
        at: receivedAt,
        data: {
          chatId: message.chatId,
          chatType: message.chatType,
          userId: message.userId,
          messageId: message.messageId,
          restrictUsers: config.restrictUsers,
          restrictChatIds: config.restrictChatIds,
        },
      });
      return { text: 'You are not allowed to control this bot.', rendered: undefined };
    }
    if (!generallyAuthorized && publicFixedFlow) {
      logger.info('inbound.fixed_flow_user_whitelist_bypassed', {
        chat: message.chatId, type: message.chatType, user: message.userId,
        messageId: message.messageId, fixedFlow: publicFixedFlow,
      });
      await store.appendEvent({
        type: 'command.fixed_flow_user_whitelist_bypassed',
        at: receivedAt,
        data: {
          chatId: message.chatId, chatType: message.chatType, userId: message.userId,
          messageId: message.messageId, fixedFlow: publicFixedFlow,
        },
      });
    }
    const textWithoutMentions = message.text.replace(/^(?:@\S+(?:\s+|$))*/, '').trim();
    if (generallyAuthorized && /^\/retry-sensitive\b/.test(textWithoutMentions)) {
      const reply = await taskPlatform?.retrySensitiveReply?.({ ...message, text: textWithoutMentions });
      if (reply) return reply;
      const match = textWithoutMentions.match(/^\/retry-sensitive\s+([a-f0-9]{32})$/);
      const delivery = new SensitiveReplyDelivery(resolve(projectRoot, '.link-bot/sensitive-replies'), gateway, undefined,
        config.sensitiveReplyDeliveryEnabled !== false);
      return { text: match ? await delivery.retry(match[1]!, message.userId)
        : '请使用 /retry-sensitive <投递编号> 重试私聊投递。', rendered: undefined };
    }
    const destructiveMenuCommand =
      message.source === 'bot_menu' && (message.text === '/upgrade' || message.text === '/restart')
        ? message.text.slice(1) as 'upgrade' | 'restart'
        : undefined;
    if (destructiveMenuCommand) {
      if (destructiveCommandCoordinator) {
        await destructiveCommandCoordinator.handleMenu({
          eventId: message.eventId,
          chatId: message.chatId,
          userId: message.userId,
          command: destructiveMenuCommand,
        });
      } else {
        await store.appendEvent({
          type: 'destructive_command.coordinator_unavailable_dropped',
          at: new Date().toISOString(),
          data: {
            eventId: message.eventId,
            chatId: message.chatId,
            userId: message.userId,
            command: destructiveMenuCommand,
          },
        });
      }
      return { text: '', rendered: undefined };
    }
    let claim: ClaimInboundMessageResult;
    try {
      claim = await inboundStore.claimInboundMessage(message);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('inbound.dedupe_failed', {
        chat: message.chatId,
        type: message.chatType,
        messageId: message.messageId,
        reason: errorMessage,
      });
      await store.appendErrorLog({
        at: new Date().toISOString(),
        source: 'inbound.dedupe',
        message: errorMessage,
        data: {
          chatId: message.chatId,
          chatType: message.chatType,
          userId: message.userId,
          messageId: message.messageId,
        },
      });
      return { text: '', rendered: undefined };
    }

    if (!claim.claimed) {
      await store.appendEvent({
        type: 'command.duplicate_dropped',
        at: new Date().toISOString(),
        data: {
          chatId: message.chatId,
          chatType: message.chatType,
          userId: message.userId,
          messageId: message.messageId,
          text: message.text,
          duplicateCount: claim.receipt.duplicateCount,
        },
      });
      return { text: '', rendered: undefined };
    }

    const completeInbound = async <T>(result: T): Promise<T> => {
      await inboundStore.completeInboundMessage(message.messageId);
      return result;
    };

    const parsed = parseIncomingText(message.text);
    if (parsed.kind === 'command' && parsed.name === 'adduser') {
      let reply = '';
      if (message.chatType !== 'group' || message.wasMentioned) {
        if (!config.upgrade.adminUsers.includes(message.userId)) {
          reply = 'Only administrators can use /adduser.';
        } else {
          const resolved = resolveMentionedOpenIds(parsed.args, message.mentions ?? []);
          reply = 'error' in resolved
            ? resolved.error
            : await userWhitelistManager.addUsers(message.userId, resolved.openIds);
        }
      }
      logger.info('outbound.replied', {
        chat: message.chatId, type: message.chatType, messageId: message.messageId, reply,
      });
      await store.appendEvent({
        type: 'command.replied',
        at: new Date().toISOString(),
        data: {
          chatId: message.chatId, chatType: message.chatType, userId: message.userId,
          messageId: message.messageId, text: message.text,
          replyPreview: reply.length <= 200 ? reply : `${reply.slice(0, 197)}...`,
        },
      });
      return completeInbound({ text: reply, rendered: undefined });
    }
    const isPrivate = message.chatType === 'private';
    const isHostAdministrator = isPrivate && config.hostControl?.enabled === true
      && config.hostControl.adminUsers.includes(message.userId);
    if (isPrivate && config.hostControl?.enabled && !isHostAdministrator) {
      return completeInbound({ text: '请在对应的话题群中使用 Link Bot；私聊仅作为管理员维护控制台开放。', rendered: undefined });
    }
    if (isHostAdministrator) {
      if (/^\/(?:disk|runtime)(?:\s|$)/i.test(textWithoutMentions) && taskController) {
        const diskReply = await taskController.handleMessage(message);
        return completeInbound({ text: diskReply.text, rendered: diskReply.rendered, delivery: diskReply.delivery });
      }
      const hostReply = await hostControlSession!.handleMessage(await hydrateHostImages(message, gateway, config));
      return completeInbound({ text: hostReply.reply, rendered: hostReply.renderedReply, delivery: hostReply.delivery });
    }

    try {
      const useTaskPlatform = taskPlatform?.shouldHandleMessage
        ? taskPlatform.shouldHandleMessage(message)
        : Boolean(taskController && taskPlatformEnabledFor(config, message.userId, projectFromNewCommand(config, message.text)));
      const taskReply = useTaskPlatform ? await taskController!.handleMessage(message) : undefined;
      const result = taskReply
        ? { reply: taskReply.text, renderedReply: taskReply.rendered, delivery: taskReply.delivery }
        : { reply: '当前消息无法由任务平台处理，请检查用户、项目和话题配置。' };
      logger.info('outbound.replied', {
        chat: message.chatId,
        type: message.chatType,
        messageId: message.messageId,
        reply: result.reply,
      });
      await store.appendEvent({
        type: 'command.replied',
        at: new Date().toISOString(),
        data: {
          chatId: message.chatId,
          chatType: message.chatType,
          userId: message.userId,
          messageId: message.messageId,
          text: message.text,
          replyPreview: result.reply.length <= 200 ? result.reply : `${result.reply.slice(0, 197)}...`,
        },
      });
      return completeInbound({ text: result.reply, rendered: result.renderedReply, delivery: result.delivery });
    } catch (error) {
      await inboundStore.failInboundMessage(message.messageId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
  const onCardAction = async (action: FeishuIncomingCardAction) => {
    // Old cards must not retain access after a user/chat is removed from config.
    // Apply before every dispatch path, including details and admin decisions.
    if (!isAuthorizedMessage(config, action)) {
      logger.info('inbound.card_action_unauthorized_dropped', {
        chat: action.chatId, type: action.chatType, user: action.userId,
        messageId: action.messageId, kind: action.action.kind,
      });
      await store.appendEvent({
        type: 'card_action.unauthorized_dropped', at: new Date().toISOString(),
        data: { chatId: action.chatId, chatType: action.chatType, userId: action.userId,
          messageId: action.messageId, kind: action.action.kind },
      });
      return { text: 'You are not allowed to control this bot.', rendered: undefined };
    }
    logger.info('inbound.card_action_received', {
      chat: action.chatId,
      type: action.chatType,
      messageId: action.messageId,
      kind: action.action.kind,
    });
    await store.appendEvent({
      type: 'card_action.received',
      at: new Date().toISOString(),
      data: {
        chatId: action.chatId,
        chatType: action.chatType,
        userId: action.userId,
        messageId: action.messageId,
        action: action.action,
      },
    });
    if (action.action.kind === 'destructive_command_decision') {
      if (destructiveCommandCoordinator) {
        await destructiveCommandCoordinator.handleDecision({ ...action, action: action.action });
      } else {
        await store.appendEvent({
          type: 'destructive_command.coordinator_unavailable_dropped',
          at: new Date().toISOString(),
          data: {
            chatId: action.chatId,
            userId: action.userId,
            messageId: action.messageId,
            requestId: action.action.requestId,
          },
        });
      }
      return { text: '', rendered: undefined };
    }
    if (action.action.kind === 'model_select'
      && action.chatType === 'private'
      && config.hostControl?.enabled === true
      && config.hostControl.adminUsers.includes(action.userId)) {
      const selected = action.action;
      const hostReply = await hostControlSession!.handleMessage({
        chatId: action.chatId, chatType: action.chatType, userId: action.userId,
        messageId: action.messageId, wasMentioned: true,
        text: `/model ${selected.model}${selected.reasoning ? ` ${selected.reasoning}` : ''}${selected.serviceTier ? ` ${selected.serviceTier}` : ''}`,
      });
      return { text: hostReply.reply, rendered: hostReply.renderedReply, delivery: hostReply.delivery };
    }
    const taskCard = action.action.kind === 'model_select'
      || action.action.kind === 'turn_detail'
      || action.action.kind === 'task_publish_decision'
      || action.action.kind === 'task_delete_decision'
      || action.action.kind === 'disk_cleanup_decision'
      || action.action.kind === 'app_server_request_decision'
      || action.action.kind === 'tool_auth_check'
      || action.action.kind === 'project_knowledge_decision'
      || action.action.kind === 'project_routing_select';
    const repositoryRefCard = action.action.kind === 'repository_ref_decision'
      || action.action.kind === 'repository_migration_decision';
    const policyCheckedCard = action.action.kind === 'tool_auth_check'
      || action.action.kind === 'turn_detail'
      || action.action.kind === 'project_knowledge_decision'
      || action.action.kind === 'project_routing_select'
      || repositoryRefCard;
    const administratorCard = action.action.kind === 'disk_cleanup_decision';
    const taskReply = (taskCard || repositoryRefCard) && taskController && (policyCheckedCard || administratorCard || taskCardEnabledForUser(config, action.userId))
      ? await taskController.handleCardAction(action)
      : undefined;
    const result = taskReply
      ? { reply: taskReply.text, renderedReply: taskReply.rendered, delivery: taskReply.delivery }
      : { reply: '该卡片无法由任务平台处理，请在当前话题重新发起操作。' };
    logger.info('outbound.card_action_replied', {
      chat: action.chatId,
      type: action.chatType,
      messageId: action.messageId,
      kind: action.action.kind,
      reply: result.reply,
    });
    await store.appendEvent({
      type: 'card_action.replied',
      at: new Date().toISOString(),
      data: {
        chatId: action.chatId,
        chatType: action.chatType,
        userId: action.userId,
        messageId: action.messageId,
        action: action.action,
        replyPreview: result.reply.length <= 200 ? result.reply : `${result.reply.slice(0, 197)}...`,
      },
    });
    return { text: result.reply, rendered: result.renderedReply, delivery: result.delivery };
  };
  logger.info('startup.gateway_starting', {});
  await gateway.start(onMessage, onCardAction, async (topic) => {
    logger.info('inbound.topic_closed', { chat: topic.chatId, topicId: topic.topicId, user: topic.operatorUserId });
    await taskController?.handleTopicClosed?.(topic);
  });
}

async function hydrateHostImages(
  message: FeishuIncomingMessage,
  gateway: FeishuGateway,
  config: BotConfig,
): Promise<FeishuIncomingMessage> {
  const media = config.media;
  const resources = message.resources?.filter((resource) => resource.kind === 'image') ?? [];
  if (!media?.enabled || resources.length === 0 || !gateway.downloadMessageResource) return message;
  const images: NonNullable<FeishuIncomingMessage['images']> = [];
  let total = 0;
  for (const resource of resources.slice(0, media.maxImagesPerTurn)) {
    const downloaded = await gateway.downloadMessageResource({
      messageId: resource.resourceOwnerMessageId, resourceKey: resource.resourceKey,
      kind: 'image', maxBytes: Math.min(media.maxImageBytes, media.maxTotalBytesPerTurn - total),
    });
    total += downloaded.data.length;
    if (total > media.maxTotalBytesPerTurn) throw new Error('Images exceed the configured per-turn size limit.');
    const mime = detectedHostImageMime(downloaded.data);
    images.push({ url: `data:${mime};base64,${downloaded.data.toString('base64')}`, detail: 'auto' });
  }
  return { ...message, text: message.text || '请分析这张图片。', images };
}

function detectedHostImageMime(data: Buffer): string {
  if (data.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  throw new Error('Host-control image is not a supported image format.');
}

async function main(): Promise<void> {
  await bootstrap();
}

export function isDirectEntrypoint(input: {
  argv1?: string;
  moduleUrl: string;
  forceMain?: string;
}): boolean {
  if (input.forceMain === '1' || input.forceMain === 'true') {
    return true;
  }
  if (input.argv1?.replace(/\\/g, '/').endsWith('/pm2/lib/ProcessContainerFork.js')) {
    return true;
  }
  return Boolean(input.argv1 && input.moduleUrl === pathToFileURL(input.argv1).href);
}

if (isDirectEntrypoint({
  argv1: process.argv[1],
  moduleUrl: import.meta.url,
  forceMain: process.env.LINK_BOT_FORCE_MAIN,
})) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { main };

function projectFromNewCommand(config: BotConfig, text: string) {
  const match = text.trim().match(/^(?:@\S+\s+)*\/new(?:\s+(\S+))?/i);
  return match?.[1] ? config.projects.find((project) => project.id === match[1]) : undefined;
}

function taskCardEnabledForUser(config: BotConfig, userId: string): boolean {
  const rollout = config.taskPlatformRollout;
  return rollout.enabled && (rollout.enabledOwners.length === 0 || rollout.enabledOwners.includes(userId));
}
