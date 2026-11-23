import {createHash} from 'node:crypto';
import type {BotConfig, ChatType} from '../domain/types.js';
import type {TaskRecord, TaskScopeRecord} from '../tasks/TaskTypes.js';

export interface AgentExecutionIdentity {
  mode: 'legacy' | 'personal-agent';
  agentId: string;
  agentOwnerUserId: string;
  requesterUserId: string;
  audience: {chatId: string; chatType: ChatType; topicId?: string};
  groupServiceVersion?: number;
}

export interface AgentExecutionIdentityInput {
  config: Pick<BotConfig, 'feishu' | 'personalAgent'>;
  task: Pick<TaskRecord, 'id' | 'ownerUserId' | 'identityMode' | 'agentOwnerUserId' | 'runtimeMode'>;
  scope: TaskScopeRecord;
  /** Supplied by authenticated ingress or persisted turn provenance, never message text. */
  requesterUserId: string;
  /** Submitted operation's service version, not a newer version substituted on retry. */
  groupServiceVersion?: number;
}

type TaskIdentityFields = Pick<TaskRecord, 'id' | 'ownerUserId' | 'identityMode' | 'agentOwnerUserId' | 'runtimeMode' | 'groupServiceVersion'>;

export function agentIdForApp(appId: string): string {
  if (!identifier(appId)) throw new Error('agent_app_identity_invalid');
  return `agent_${createHash('sha256').update(appId).digest('hex').slice(0, 24)}`;
}

/** Execution ownership only; never use this result as the request actor or audience. */
export function resolveTaskExecutionOwner(config: Pick<BotConfig, 'personalAgent'>, task: TaskIdentityFields): string {
  assertTaskIdentityTransition(task, task);
  if (!identifier(task.ownerUserId)) throw new Error('agent_task_owner_missing');
  if (checkedMode(task) === 'legacy') return task.ownerUserId;
  if (!config.personalAgent?.enabled || config.personalAgent.ownerUserId !== task.agentOwnerUserId) {
    throw new Error('agent_execution_owner_unavailable');
  }
  return task.agentOwnerUserId!;
}

/** Storage fence: normal updates may not retarget, erase or convert a task's identity. */
export function assertTaskIdentityTransition(previous: TaskIdentityFields | undefined, next: TaskIdentityFields): void {
  const nextMode = checkedMode(next);
  if (nextMode === 'personal-agent'
    && (!identifier(next.agentOwnerUserId) || next.agentOwnerUserId !== next.ownerUserId || next.runtimeMode !== 'user-sandbox')) {
    throw new Error('agent_task_identity_invalid');
  }
  if (nextMode === 'legacy' && next.agentOwnerUserId !== undefined) throw new Error('agent_task_identity_invalid');
  if (next.groupServiceVersion !== undefined && (!Number.isSafeInteger(next.groupServiceVersion) || next.groupServiceVersion < 1))
    throw new Error('agent_task_epoch_invalid');
  if (!previous) return;
  const previousMode = checkedMode(previous);
  if (previous.id !== next.id || previousMode !== nextMode
    || previousMode === 'personal-agent' && (previous.agentOwnerUserId !== next.agentOwnerUserId
      || previous.ownerUserId !== next.ownerUserId || previous.groupServiceVersion !== next.groupServiceVersion)) {
    throw new Error('agent_task_identity_immutable');
  }
}

function checkedMode(task: TaskIdentityFields): AgentExecutionIdentity['mode'] {
  const mode = task.identityMode === undefined ? 'legacy' : task.identityMode;
  if (mode !== 'legacy' && mode !== 'personal-agent') throw new Error('agent_identity_mode_invalid');
  return mode;
}

/** Resolves identity only. Callers must independently check admission and action permissions. */
export function resolveAgentExecutionIdentity(input: AgentExecutionIdentityInput): AgentExecutionIdentity {
  const {config, task, scope, requesterUserId} = input;
  const mode = checkedMode(task);
  if (scope.taskId !== task.id) throw new Error('agent_identity_scope_mismatch');
  if (!identifier(config.feishu.appId) || !identifier(requesterUserId) || !identifier(task.ownerUserId)) {
    throw new Error('agent_identity_missing');
  }
  const audience = resolveAudience(scope);
  if (audience.chatType === 'private' && scope.privateUserId !== requesterUserId) {
    throw new Error('agent_identity_private_actor_mismatch');
  }
  const agentId = agentIdForApp(config.feishu.appId);
  if (mode === 'legacy') {
    if (task.agentOwnerUserId !== undefined) throw new Error('agent_identity_mode_missing_or_conflicting');
    return {mode, agentId, agentOwnerUserId: task.ownerUserId, requesterUserId, audience};
  }

  if (!config.personalAgent?.enabled) throw new Error('personal_agent_disabled');
  const owner = config.personalAgent.ownerUserId;
  if (!identifier(owner) || !identifier(task.agentOwnerUserId)) throw new Error('agent_execution_owner_missing');
  if (task.agentOwnerUserId !== owner || task.ownerUserId !== owner) throw new Error('agent_execution_owner_mismatch');
  if (task.runtimeMode !== 'user-sandbox') throw new Error('agent_execution_sandbox_required');
  if (scope.status !== 'canonical') throw new Error('agent_identity_scope_not_canonical');
  if (audience.chatType === 'private' && requesterUserId !== owner) throw new Error('agent_identity_private_owner_required');
  if (audience.chatType === 'group' && (!Number.isSafeInteger(input.groupServiceVersion) || input.groupServiceVersion! < 1)) {
    throw new Error('agent_group_service_version_required');
  }
  return {mode, agentId, agentOwnerUserId: owner, requesterUserId, audience,
    ...(audience.chatType === 'group' ? {groupServiceVersion: input.groupServiceVersion} : {})};
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
}

function resolveAudience(scope: TaskScopeRecord): AgentExecutionIdentity['audience'] {
  if (!identifier(scope.chatId)) throw new Error('agent_audience_missing');
  if (scope.scope === 'topic' && identifier(scope.topicId)) {
    return {chatId: scope.chatId, chatType: 'group', topicId: scope.topicId};
  }
  if (scope.scope === 'group' && scope.topicId === undefined) return {chatId: scope.chatId, chatType: 'group'};
  if (scope.scope === 'private' && scope.topicId === undefined && identifier(scope.privateUserId)) {
    return {chatId: scope.chatId, chatType: 'private'};
  }
  throw new Error('agent_audience_invalid');
}
