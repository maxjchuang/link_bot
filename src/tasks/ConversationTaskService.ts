import { createHash } from 'node:crypto';
import type { TaskActorContext } from '../feishu/FeishuTaskController.js';
import type { SqliteStateStore } from '../state/SqliteStateStore.js';
import type { TaskMembershipRecord, TaskRecord, TaskRuntimeMode, TaskScopeRecord } from './TaskTypes.js';
import type { WorkspacePlan } from '../projects/WorkspacePlanParser.js';

export type ConversationTaskAction = 'message' | 'context' | 'repository' | 'publish' | 'delete' | 'membership' | 'memory_admin' | 'global_memory';

export interface ConversationTaskResult {
  task: TaskRecord;
  scope: TaskScopeRecord;
  created: boolean;
}

export class ConversationTaskService {
  constructor(
    private readonly store: SqliteStateStore,
    private readonly clock: () => Date = () => new Date(),
    private readonly personalAgent?: {agentId: string; ownerUserId: string},
  ) {}

  /** Scope grant is checked without replacing the authenticated request actor. */
  executionOwnerFor(input: TaskActorContext): string {
    this.identity(input);
    return this.personalAgent?.ownerUserId ?? input.userId;
  }

  async getOrCreate(input: TaskActorContext & {
    projectId?: string; mode?: 'chat' | 'project'; baseRef?: string; workspacePlan?: WorkspacePlan;
    runtimeMode?: TaskRuntimeMode; sandboxWorkspaceLayout?: 'project';
  }): Promise<ConversationTaskResult> {
    const mode = input.mode ?? 'project';
    if (mode === 'chat' && (input.projectId !== undefined || input.runtimeMode !== 'user-sandbox')) {
      throw new Error('Chat task requires a project-free user sandbox.');
    }
    if (mode === 'project' && !input.projectId) throw new Error('Project task requires projectId.');
    const identity = this.identity(input);
    return this.store.withTaskLock(`scope:${identity.scopeKey}`, async () => {
      this.assertService(input);
      const existingScope = this.store.getTaskScopeByKey(identity.scopeKey)
        ?? (this.personalAgent ? undefined : this.resolveLegacyScope(input));
      if (existingScope) {
        const task = this.store.getTask(existingScope.taskId);
        if (!task) throw new Error(`Conversation scope references missing task: ${identity.scopeKey}`);
        if (!this.isExpiredLegacyConversation(task, existingScope, identity.scopeKey)) {
          this.assertTaskMode(task);
          this.observeAuthenticatedActor(task, existingScope, input.userId);
          return { task, scope: existingScope, created: false };
        }
      }

      const now = this.clock().toISOString();
      const taskId = taskIdForScope(identity.scopeKey);
      const task: TaskRecord = {
        id: taskId,
        ownerUserId: this.personalAgent?.ownerUserId ?? input.userId,
        ...(this.personalAgent ? {identityMode: 'personal-agent' as const, agentOwnerUserId: this.personalAgent.ownerUserId} : {}),
        ...(this.personalAgent && input.chatType === 'group' ? {groupServiceVersion: input.groupServiceVersion} : {}),
        mode,
        runtimeMode: input.runtimeMode ?? 'legacy-task-container',
        ...(input.sandboxWorkspaceLayout ? { sandboxWorkspaceLayout: input.sandboxWorkspaceLayout } : {}),
        baseRef: mode === 'chat' ? '' : input.baseRef ?? 'main',
        branchName: mode === 'chat' ? '' : `codex/${this.personalAgent?.ownerUserId ?? input.userId}/${taskId}`,
        ...(mode === 'project' ? {
          projectId: input.projectId!,
        } : {}),
        runtimeState: 'warm',
        pinned: false,
        ...(input.workspacePlan ? { workspacePlan: input.workspacePlan } : {}),
        lastUserInteractionAt: now,
        createdAt: now,
        updatedAt: now,
      };
      const scope: TaskScopeRecord = {
        taskId,
        ...identity,
        status: 'canonical',
        createdAt: now,
        updatedAt: now,
      };
      const membership = membershipRecord(taskId, task.ownerUserId, 'owner', now);
      const created = this.store.createConversationTask({ task, scope, membership,
        participants: input.userId !== task.ownerUserId ? [membershipRecord(taskId, input.userId, 'member', now)] : [],
        ...(this.personalAgent && input.chatType === 'group' ? {groupServiceFence: {
          agentId: this.personalAgent.agentId, ownerUserId: this.personalAgent.ownerUserId,
          chatId: input.chatId, version: input.groupServiceVersion!,
        }} : {}),
      });
      const persisted = this.store.getTask(taskId)!;
      this.assertTaskMode(persisted);
      this.observeAuthenticatedActor(persisted, scope, input.userId);
      return {task: persisted, scope: this.store.getTaskScope(taskId)!, created};
    });
  }

  resolve(input: TaskActorContext): ConversationTaskResult | undefined {
    const identity = this.identity(input);
    const scope = this.store.getTaskScopeByKey(identity.scopeKey) ?? (this.personalAgent ? undefined : this.resolveLegacyScope(input));
    if (!scope) return undefined;
    const task = this.store.getTask(scope.taskId);
    if (!task) throw new Error(`Conversation scope references missing task: ${identity.scopeKey}`);
    this.assertTaskMode(task);
    return { task, scope, created: false };
  }

  shouldStartSuccessor(input: TaskActorContext): boolean {
    const resolved = this.resolve(input);
    return Boolean(resolved && this.isExpiredLegacyConversation(
      resolved.task, resolved.scope, this.identity(input).scopeKey,
    ));
  }

  private identity(input: TaskActorContext): ReturnType<typeof conversationTaskIdentity> {
    if (!this.personalAgent) return conversationTaskIdentity(input);
    this.assertService(input);
    const {agentId} = this.personalAgent;
    if (!agentId || !this.personalAgent.ownerUserId) throw new Error('Personal-agent identity is required.');
    const purpose = input.taskPurpose ? `:purpose:${createHash('sha256').update(input.taskPurpose).digest('hex').slice(0, 16)}` : '';
    if (input.chatType === 'private') return {scope: 'private', scopeKey: `agent-private:${agentId}:${input.userId}${purpose}`,
      chatId: input.chatId, privateUserId: input.userId};
    return input.topicId
      ? {scope: 'topic', scopeKey: `agent-topic:${agentId}:${input.chatId}:${input.topicId}:service:${input.groupServiceVersion}${purpose}`, chatId: input.chatId, topicId: input.topicId}
      : {scope: 'group', scopeKey: `agent-group:${agentId}:${input.chatId}:service:${input.groupServiceVersion}${purpose}`, chatId: input.chatId};
  }

  private assertService(input: TaskActorContext): void {
    if (!this.personalAgent) return;
    if (input.chatType === 'private') {
      if (input.userId !== this.personalAgent.ownerUserId) throw new Error('Personal-agent private chat requires owner.');
      return;
    }
    const grant = this.store.getGroupService(this.personalAgent.agentId, input.chatId);
    if (!grant || grant.status !== 'enabled' || grant.ownerUserId !== this.personalAgent.ownerUserId
      || !Number.isSafeInteger(input.groupServiceVersion) || grant.version !== input.groupServiceVersion) {
      throw new Error('Group service is not current.');
    }
  }

  private assertTaskMode(task: TaskRecord): void {
    if (this.personalAgent && (task.identityMode !== 'personal-agent' || task.agentOwnerUserId !== this.personalAgent.ownerUserId
      || task.ownerUserId !== this.personalAgent.ownerUserId || task.runtimeMode !== 'user-sandbox')) {
      throw new Error('Personal-agent task identity mismatch.');
    }
    if (!this.personalAgent && task.identityMode === 'personal-agent') throw new Error('Personal-agent task requires personal-agent service.');
  }

  private isExpiredLegacyConversation(task: TaskRecord, scope: TaskScopeRecord, personalScopeKey: string): boolean {
    return (scope.scope === 'topic' || scope.scope === 'group')
      && scope.scopeKey !== personalScopeKey
      && (task.runtimeMode ?? 'legacy-task-container') === 'legacy-task-container'
      && task.runtimeState === 'archived'
      && (task.archiveReason === 'warm_retention_expired'
        || (task.archiveReason === undefined && this.store.wasArchivedByWarmRetention(task.id)));
  }

  private resolveLegacyScope(input: TaskActorContext): TaskScopeRecord | undefined {
    if (input.chatType === 'private') return undefined;
    const legacy = this.store.getTaskScopeByKey(legacyConversationTaskIdentity(input).scopeKey);
    if (!legacy) return undefined;
    const task = this.store.getTask(legacy.taskId);
    if (!task || (task.runtimeMode ?? 'legacy-task-container') !== 'legacy-task-container') return undefined;
    return legacy;
  }

  observeAuthenticatedActor(task: TaskRecord, scope: TaskScopeRecord, userId: string): TaskMembershipRecord {
    this.assertTaskMode(task);
    if (scope.taskId !== task.id) {
      throw new Error('Task participant scope mismatch.');
    }
    if (scope.scope === 'private' && scope.privateUserId !== userId) throw new Error('Private task identity mismatch.');
    const current = this.store.getTaskMembership(task.id, userId);
    if (current?.status === 'active') return current;
    if (current?.status === 'removed') throw new Error('Task membership is removed.');
    if (scope.scope === 'private') throw new Error('Private task membership is missing.');
    const now = this.clock().toISOString();
    const membership = membershipRecord(task.id, userId, 'member', now);
    this.store.saveTaskMembership(membership);
    return membership;
  }

  authorize(taskId: string, userId: string, action: ConversationTaskAction, groupServiceVersion?: number): TaskMembershipRecord {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error('Task not found.');
    this.assertTaskMode(task);
    if (this.personalAgent) {
      const scope = this.store.getTaskScope(taskId);
      if (!scope?.chatId) throw new Error('Task scope is required.');
      this.assertService({userId, chatId: scope.chatId, chatType: scope.scope === 'private' ? 'private' : 'group',
        groupServiceVersion});
    }
    const membership = this.store.getTaskMembership(taskId, userId);
    if (!membership || membership.status !== 'active') throw new Error('Task membership is not active.');
    if (this.personalAgent && ['delete','membership','memory_admin','global_memory'].includes(action)
      && userId !== this.personalAgent.ownerUserId) throw new Error('Task action requires agent owner.');
    if (!this.personalAgent && isPrivileged(action) && membership.role === 'member') {
      throw new Error(`Task action requires owner or administrator: ${action}`);
    }
    return membership;
  }

  removeMember(taskId: string, userId: string): TaskMembershipRecord {
    const membership = this.store.getTaskMembership(taskId, userId);
    if (!membership) throw new Error('Task membership not found.');
    const removed = { ...membership, status: 'removed' as const, updatedAt: this.clock().toISOString() };
    this.store.saveTaskMembership(removed);
    return removed;
  }
}

export function conversationTaskIdentity(input: TaskActorContext): Pick<
  TaskScopeRecord, 'scope' | 'scopeKey' | 'chatId' | 'topicId' | 'privateUserId'
> {
  const purpose = input.taskPurpose ? `:purpose:${createHash('sha256').update(input.taskPurpose).digest('hex').slice(0, 16)}` : '';
  if (input.chatType === 'private') {
    return { scope: 'private', scopeKey: `private:${input.userId}${purpose}`, chatId: input.chatId, privateUserId: input.userId };
  }
  if (input.topicId) {
    return {
      scope: 'topic', scopeKey: `personal-topic:${input.userId}:${input.chatId}:${input.topicId}${purpose}`,
      chatId: input.chatId, topicId: input.topicId,
    };
  }
  return { scope: 'group', scopeKey: `personal-group:${input.userId}:${input.chatId}${purpose}`, chatId: input.chatId };
}

export function legacyConversationTaskIdentity(input: TaskActorContext): Pick<
  TaskScopeRecord, 'scope' | 'scopeKey' | 'chatId' | 'topicId'
> {
  const purpose = input.taskPurpose ? `:purpose:${createHash('sha256').update(input.taskPurpose).digest('hex').slice(0, 16)}` : '';
  return input.topicId
    ? { scope: 'topic', scopeKey: `topic:${input.chatId}:${input.topicId}${purpose}`, chatId: input.chatId, topicId: input.topicId }
    : { scope: 'group', scopeKey: `group:${input.chatId}${purpose}`, chatId: input.chatId };
}

export function taskIdForScope(scopeKey: string): string {
  return `task_${createHash('sha256').update(scopeKey).digest('hex').slice(0, 24)}`;
}

function membershipRecord(
  taskId: string,
  userId: string,
  role: TaskMembershipRecord['role'],
  now: string,
): TaskMembershipRecord {
  return {
    id: `membership:${taskId}:${userId}`,
    taskId,
    userId,
    role,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

function isPrivileged(action: ConversationTaskAction): boolean {
  return ['repository', 'publish', 'delete', 'membership', 'memory_admin', 'global_memory'].includes(action);
}
