import type { ProjectConfig } from '../domain/types.js';
import type { IncomingResourceDescriptor } from '../media/MediaTypes.js';
import type { CodexModelCatalog } from '../models/CodexModelCatalog.js';
import type { CodexServiceTier,ExecutionProfile } from '../tasks/ExecutionProfile.js';
import type { FeishuIncomingCardAction } from './FeishuCardActions.js';
import type { FeishuIncomingMessage,FeishuOutgoingReply } from './FeishuGateway.js';
import { renderModelSelectorCard } from './ModelSelectorCard.js';
import { renderDiskCleanupConfirmationCard,renderTaskConfirmationCard } from './TaskPlatformCards.js';

export interface TaskControlOperations {
  switchProject?(input: TaskActorContext & { project: string }): Promise<string>;
  projectSwitchStatus?(input: TaskActorContext): Promise<string>;
  cancelProjectSwitch?(input: TaskActorContext): Promise<string>;
  runtime?(input: TaskActorContext & { upgrade: boolean }): Promise<string>;
  prepareSend?(input: TaskActorContext & { text: string }): Promise<FeishuOutgoingReply | undefined>;
  confirmProjectCreation?(input: TaskActorContext & { text: string }): Promise<FeishuOutgoingReply | undefined>;
  checkToolAuth?(input: TaskActorContext & { pendingId: string }): Promise<FeishuOutgoingReply>;
  projects(userId: string, actor?: TaskActorContext): Promise<ProjectConfig[]>;
  createTask(input: TaskActorContext & { projectId?: string; blank?: boolean }): Promise<{ taskId: string; contextId?: string }>;
  contexts(input: TaskActorContext): Promise<Array<{ id: string; state: string; threadId: string }>>;
  useContext(input: TaskActorContext & { contextId: string }): Promise<void>;
  repositories(input: TaskActorContext): Promise<Array<{ id: string; projectId: string; path: string; primary: boolean; status: string }>>;
  addRepository(input: TaskActorContext & { projectId: string; baseRef?: string }): Promise<{ id: string; path: string }>;
  migrateRepository?(input: TaskActorContext & { projectId: string; targetBaseRef: string }): Promise<string>;
  decideRepositoryMigration?(input: TaskActorContext & { migrationId: string; decision: 'confirm'|'reject' }): Promise<string>;
  memory(input: TaskActorContext & { query?: string }): Promise<string>;
  remember(input: TaskActorContext & { scope: 'task' | 'user'; text: string }): Promise<{ id: string }>;
  forget(input: TaskActorContext & { memoryId: string }): Promise<void>;
  dreamStatus(input: TaskActorContext): Promise<string>;
  confirmBotMemory(input: TaskActorContext & { memoryId: string }): Promise<string>;
  tasks(input: TaskActorContext): Promise<Array<{ id: string; projectId?: string; state: string; pinned: boolean }>>;
  useTask(input: TaskActorContext & { taskId: string }): Promise<void>;
  status(input: TaskActorContext): Promise<string>;
  model(input: TaskActorContext & { model?: string; reasoningEffort?: string; serviceTier?: CodexServiceTier }): Promise<string>;
  executionProfile(input: TaskActorContext): Promise<ExecutionProfile>;
  usage(input: TaskActorContext & { period: 'task' | 'today' | 'week' | 'month' }): Promise<string>;
  send(input: TaskActorContext & { text: string; inferFromContext?: boolean }): Promise<FeishuOutgoingReply | undefined>;
  selectProjectRouting?(input: TaskActorContext & { routingId: string; projectId?: string; cancel?: boolean }): Promise<FeishuOutgoingReply>;
  decideRepositoryRef?(input: TaskActorContext & { projectId: string; targetRef: string; originalText: string; decision: 'inspect'|'migrate'|'cancel' }): Promise<FeishuOutgoingReply>;
  closeTopic?(input: { chatId: string; topicId: string; operatorUserId?: string }): Promise<void>;
  interrupt(input: TaskActorContext): Promise<void>;
  stop(input: TaskActorContext): Promise<void>;
  resume(input: TaskActorContext): Promise<void>;
  pin(input: TaskActorContext & { pinned: boolean }): Promise<void>;
  requestPublish(input: TaskActorContext & { repository?: string }): Promise<{ requestId: string }>;
  decidePublish(input: TaskActorContext & { requestId: string; decision: 'confirm' | 'reject' }): Promise<string>;
  requestDelete(input: TaskActorContext): Promise<{ requestId: string }>;
  decideDelete(input: TaskActorContext & { requestId: string; decision: 'confirm' | 'reject' }): Promise<string>;
  decideAppServerRequest(input: TaskActorContext & {
    requestId: string;
    generation: number;
    decision: 'allow' | 'deny' | 'answer';
    answers?: Record<string, string[]>;
  }): Promise<string>;
  decideProjectKnowledge(input: TaskActorContext & { knowledgeId: string; decision: 'approve' | 'reject' }): Promise<string>;
}

export interface TaskActorContext {
  chatId: string;
  chatType: 'private' | 'group';
  userId: string;
  topicId?: string;
  messageId?: string;
  rootId?: string;
  createdAt?: string;
  resources?: IncomingResourceDescriptor[];
  /** Internal task-scope discriminator; never accepted from a Feishu payload. */
  taskPurpose?: string;
  /** Internal workflow policy; pins this task to one execution profile. */
  fixedExecutionProfile?: ExecutionProfile;
}

export interface DiskControlOperations {
  inventory(input: TaskActorContext): Promise<string>;
  requestCleanup(input: TaskActorContext & { taskIds?: string[] }): Promise<{ requestId: string; summary: string }>;
  decideCleanup(input: TaskActorContext & { requestId: string; decision: 'confirm' | 'reject' }): Promise<string>;
}

export class FeishuTaskController {
  constructor(
    private readonly operations: TaskControlOperations,
    private readonly allowUnmentionedGroupMessage: (message: FeishuIncomingMessage) => boolean | Promise<boolean> = () => false,
    private readonly diskOperations?: DiskControlOperations,
    private readonly readModelCatalog?: () => Promise<CodexModelCatalog>,
    private readonly detailController?: { handle(input: FeishuIncomingCardAction & { action: import('./FeishuCardActions.js').TurnDetailCardAction }): Promise<FeishuOutgoingReply> },
  ) {}

  async handleMessage(message: FeishuIncomingMessage): Promise<FeishuOutgoingReply> {
    const trimmed = stripMention(message.text).trim();
    if (message.chatType === 'group' && !message.wasMentioned
      && !await this.allowUnmentionedGroupMessage(message)) return { text: '' };
    const actor = actorContext(message);
    if (!trimmed.startsWith('/')) {
      if (!trimmed && message.chatType !== 'group' && !message.resources?.length) return { text: '' };
      const text = trimmed || (message.resources?.length ? '请分析这个附件。' : '');
      const creation = await this.operations.confirmProjectCreation?.({ ...actor, text });
      if (creation) return creation;
      const authorization = await this.operations.prepareSend?.({ ...actor, text });
      if (authorization) return authorization;
      const response = await this.operations.send({
        ...actor, text,
        ...(!trimmed && !message.resources?.length ? { inferFromContext: true } : {}),
      });
      return response ?? { text: '' };
    }
    const [command, ...args] = trimmed.slice(1).split(/\s+/);
    switch (command?.toLowerCase()) {
      case 'project': {
        if (args[0] === 'switch' && args.length === 2 && this.operations.switchProject)
          return {text:await this.operations.switchProject({...actor,project:args[1]!})};
        if (args[0] === 'status' && args.length === 1 && this.operations.projectSwitchStatus)
          return {text:await this.operations.projectSwitchStatus(actor)};
        if (args[0] === 'cancel' && args.length === 1 && this.operations.cancelProjectSwitch)
          return {text:await this.operations.cancelProjectSwitch(actor)};
        return {text:'用法：/project switch <项目ID或仓库路径>；/project status；/project cancel'};
      }
      case 'runtime': {
        if (args.length > 1 || (args[0] && !['status', 'upgrade'].includes(args[0]))) {
          return { text: '用法：/runtime 查看版本；/runtime upgrade 升级自己的沙箱到平台稳定版。' };
        }
        if (!this.operations.runtime) return { text: '沙箱运行时管理不可用。' };
        return { text: await this.operations.runtime({ ...actor, upgrade: args[0] === 'upgrade' }) };
      }
      case 'projects': {
        const projects = await this.operations.projects(message.userId, actor);
        return { text: projects.map((project) => `${project.id}: ${project.name}`).join('\n') || 'No projects available.' };
      }
      case 'new': {
        const blank = args.includes('--blank');
        const projectId = args.find((arg) => arg !== '--blank');
        const task = await this.operations.createTask({ ...actor, projectId, blank });
        return { text: task.contextId
          ? `Started context ${task.contextId} in task ${task.taskId}.`
          : `Created task ${task.taskId}.` };
      }
      case 'contexts': {
        const contexts = await this.operations.contexts(actor);
        return { text: contexts.map((context) => `${context.id} ${context.state} ${context.threadId}`).join('\n') || 'No contexts.' };
      }
      case 'usage': {
        const period = (args[0]?.toLowerCase() ?? 'task') as 'task' | 'today' | 'week' | 'month';
        if (!['task', 'today', 'week', 'month'].includes(period)) return { text: 'Usage: /usage [task|today|week|month]' };
        return { text: await this.operations.usage({ ...actor, period }) };
      }
      case 'use-context':
        if (!args[0]) return { text: 'Usage: /use-context <context-id>' };
        await this.operations.useContext({ ...actor, contextId: args[0] });
        return { text: `Using context ${args[0]}.` };
      case 'repos': {
        const repositories = await this.operations.repositories(actor);
        return { text: repositories.map((repository) =>
          `${repository.id} ${repository.projectId} ${repository.status}${repository.primary ? ' primary' : ''} ${repository.path}`,
        ).join('\n') || 'No repositories.' };
      }
      case 'repo':
        if (args[0] !== 'add' || !args[1]) return { text: 'Usage: /repo add <project> [ref]' };
        {
          const repository = await this.operations.addRepository({ ...actor, projectId: args[1], baseRef: args[2] });
          return { text: `Added repository ${repository.id} at ${repository.path}.` };
        }
      case 'rebase-project':
        if (!args[0] || !args[1]) return { text: 'Usage: /rebase-project <project> <target-ref>' };
        if (!this.operations.migrateRepository) return { text: 'Repository migration is unavailable.' };
        return { text: await this.operations.migrateRepository({ ...actor, projectId: args[0], targetBaseRef: args[1] }) };
      case 'memory':
        if (args[0] === 'approve') {
          if (!args[1]) return { text: 'Usage: /memory approve <memory-id>' };
          return { text: await this.operations.confirmBotMemory({ ...actor, memoryId: args[1] }) };
        }
        return { text: await this.operations.memory({ ...actor, query: args.join(' ') || undefined }) };
      case 'remember': {
        const scope = args[0] === 'user' || args[0] === 'task' ? args.shift() as 'task' | 'user' : 'task';
        const text = args.join(' ').trim();
        if (!text) return { text: 'Usage: /remember [task|user] <text>' };
        const memory = await this.operations.remember({ ...actor, scope, text });
        return { text: `Remembered as ${memory.id}.` };
      }
      case 'forget':
        if (!args[0]) return { text: 'Usage: /forget <memory-id>' };
        await this.operations.forget({ ...actor, memoryId: args[0] });
        return { text: `Forgot ${args[0]}.` };
      case 'dream':
        if (args[0] && args[0] !== 'status') return { text: 'Usage: /dream status' };
        return { text: await this.operations.dreamStatus(actor) };
      case 'tasks': {
        const tasks = await this.operations.tasks(actor);
        return { text: tasks.map((task) => `${task.id} ${task.projectId} ${task.state}${task.pinned ? ' pinned' : ''}`).join('\n') || 'No tasks.' };
      }
      case 'use':
        if (!args[0]) return { text: 'Usage: /use <task-id>' };
        await this.operations.useTask({ ...actor, taskId: args[0] });
        return { text: `Using task ${args[0]}.` };
      case 'status':
      case 'current':
        return { text: await this.operations.status(actor) };
      case 'model': {
        if (args.length === 0 && this.readModelCatalog) {
          const catalog = await this.readModelCatalog();
          if (catalog.kind === 'unavailable') return { text: catalog.message };
          const current = await this.operations.executionProfile(actor);
          const fallbackText = await this.operations.model(actor);
          return {
            text: fallbackText,
            rendered: renderModelSelectorCard({
              chatId: actor.chatId,
              chatType: actor.chatType,
              ...(actor.topicId ? { topicId: actor.topicId } : {}),
              current,
              clientVersion: catalog.clientVersion,
              fetchedAt: catalog.fetchedAt,
              models: catalog.models,
              fallbackText,
            }),
          };
        }
        const tier = args[2]?.toLowerCase();
        if (tier && tier !== 'fast' && tier !== 'default' && tier !== 'standard') {
          return { text: 'Usage: /model [model] [reasoning-effort] [default|fast]' };
        }
        return { text: await this.operations.model({
          ...actor,
          model: args[0],
          reasoningEffort: args[1],
          ...(tier ? { serviceTier: tier === 'fast' ? 'fast' : 'default' } : {}),
        }) };
      }
      case 'interrupt': await this.operations.interrupt(actor); return { text: 'Interrupt requested.' };
      case 'stop': await this.operations.stop(actor); return { text: 'Task stopped.' };
      case 'resume': await this.operations.resume(actor); return { text: 'Task resumed.' };
      case 'pin': await this.operations.pin({ ...actor, pinned: true }); return { text: 'Task pinned.' };
      case 'unpin': await this.operations.pin({ ...actor, pinned: false }); return { text: 'Task unpinned.' };
      case 'publish': {
        const request = await this.operations.requestPublish({ ...actor, repository: args[0] });
        return { text: `Publish confirmation required: ${request.requestId}.`, rendered: renderTaskConfirmationCard('publish', request.requestId, actor) };
      }
      case 'delete': {
        const request = await this.operations.requestDelete(actor);
        return { text: `Delete confirmation required: ${request.requestId}.`, rendered: renderTaskConfirmationCard('delete', request.requestId, actor) };
      }
      case 'disk': {
        if (!this.diskOperations) return { text: 'Disk administration is unavailable.' };
        const operation = args[0]?.toLowerCase() ?? 'inventory';
        if ((operation === 'inventory' && args.length === 1) || args.length === 0) {
          return { text: await this.diskOperations.inventory(actor) };
        }
        if (operation !== 'cleanup') {
          return { text: 'Usage: /disk inventory | /disk cleanup policy | /disk cleanup <task-id> [task-id...]' };
        }
        const selection = args.slice(1);
        if (selection.length === 0) {
          return { text: 'Usage: /disk cleanup policy | /disk cleanup <task-id> [task-id...]' };
        }
        const taskIds = selection.length === 1 && selection[0]?.toLowerCase() === 'policy'
          ? undefined
          : selection;
        if (selection.some((value) => value.toLowerCase() === 'policy') && taskIds) {
          return { text: 'Use either policy or exact task IDs, not both.' };
        }
        const request = await this.diskOperations.requestCleanup({ ...actor, ...(taskIds ? { taskIds } : {}) });
        return {
          text: `Disk cleanup confirmation required: ${request.requestId}.`,
          rendered: renderDiskCleanupConfirmationCard(request.requestId, request.summary, actor),
        };
      }
      default: return { text: 'Unknown task command.' };
    }
  }

  async handleCardAction(input: FeishuIncomingCardAction): Promise<FeishuOutgoingReply> {
    const actor = actorContext(input);
    const action = input.action;
    if (action.kind === 'turn_detail') return this.detailController?.handle({ ...input, action }) ?? { text: '详情功能当前未启用。' };
    if (action.kind === 'model_select') {
      return { text: await this.operations.model({
        ...actor, model: action.model, reasoningEffort: action.reasoning, serviceTier: action.serviceTier,
      }) };
    }
    if (action.kind === 'task_publish_decision') {
      return { text: await this.operations.decidePublish({ ...actor, requestId: action.requestId, decision: action.decision }) };
    }
    if (action.kind === 'task_delete_decision') {
      return { text: await this.operations.decideDelete({ ...actor, requestId: action.requestId, decision: action.decision }) };
    }
    if (action.kind === 'disk_cleanup_decision') {
      if (!this.diskOperations) return { text: 'Disk administration is unavailable.' };
      return { text: await this.diskOperations.decideCleanup({
        ...actor, requestId: action.requestId, decision: action.decision,
      }) };
    }
    if (action.kind === 'app_server_request_decision') {
      return { text: await this.operations.decideAppServerRequest({
        ...actor, requestId: action.requestId, generation: action.generation,
        decision: action.decision, answers: action.answers,
      }) };
    }
    if (action.kind === 'project_knowledge_decision') {
      return { text: await this.operations.decideProjectKnowledge({
        ...actor, knowledgeId: action.knowledgeId, decision: action.decision,
      }) };
    }
    if (action.kind === 'tool_auth_check') {
      if (!this.operations.checkToolAuth) return { text: 'Tool authentication is unavailable.' };
      return this.operations.checkToolAuth({ ...actor, pendingId: action.pendingId });
    }
    if (action.kind === 'project_routing_select') {
      if (!this.operations.selectProjectRouting) return { text: '项目路由不可用。' };
      return this.operations.selectProjectRouting({ ...actor, routingId: action.routingId, projectId: action.projectId, cancel: action.cancel });
    }
    if (action.kind === 'repository_ref_decision') {
      if (!this.operations.decideRepositoryRef) return { text: '仓库分支决策不可用。' };
      return this.operations.decideRepositoryRef({ ...actor, ...action });
    }
    if (action.kind === 'repository_migration_decision') {
      if (!this.operations.decideRepositoryMigration) return { text: '仓库迁移确认不可用。' };
      return { text: await this.operations.decideRepositoryMigration({ ...actor, ...action }) };
    }
    return { text: 'This card belongs to the unsupported control path.' };
  }

  async handleTopicClosed(input: { chatId: string; topicId: string; operatorUserId?: string }): Promise<void> {
    await this.operations.closeTopic?.(input);
  }
}

function actorContext(input: Pick<FeishuIncomingMessage, 'chatId' | 'chatType' | 'userId' | 'threadId' | 'messageId' | 'rootId' | 'createdAt' | 'resources'>): TaskActorContext {
  return {
    chatId: input.chatId, chatType: input.chatType, userId: input.userId,
    ...(input.threadId ? { topicId: input.threadId } : {}),
    ...(input.messageId ? { messageId: input.messageId } : {}),
    ...(input.rootId ? { rootId: input.rootId } : {}),
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    ...(input.resources?.length ? { resources: input.resources } : {}),
  };
}

function stripMention(text: string): string {
  return text.replace(/^(?:@\S+(?:\s+|$))*/, '');
}
