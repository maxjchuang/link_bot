import type {BotConfig} from '../domain/types.js';
import type {SqliteStateStore} from '../state/SqliteStateStore.js';
import type {TaskRecord, TurnRecord} from '../tasks/TaskTypes.js';
import {resolveAgentExecutionIdentity} from './AgentExecutionIdentity.js';

/** Checks persisted provenance, never substitutes today's grant for an old operation. */
export function assertPersonalAgentWorkCurrent(
  config: Pick<BotConfig, 'personalAgent'|'feishu'>,
  store: Pick<SqliteStateStore, 'getTaskScope'|'getGroupService'>,
  task: TaskRecord,
  operation: Pick<TurnRecord, 'createdBy'|'groupServiceVersion'>,
): void {
  if (task.identityMode !== 'personal-agent') return;
  const scope = store.getTaskScope(task.id);
  if (!scope) throw new Error('personal_agent_work_scope_missing');
  const identity = resolveAgentExecutionIdentity({config, task, scope,
    requesterUserId: operation.createdBy, groupServiceVersion: operation.groupServiceVersion});
  if (identity.audience.chatType === 'private') return;
  if (task.groupServiceVersion !== operation.groupServiceVersion) throw new Error('personal_agent_task_epoch_mismatch');
  const grant = store.getGroupService(identity.agentId, identity.audience.chatId);
  if (grant?.status !== 'enabled' || grant.ownerUserId !== identity.agentOwnerUserId
    || grant.version !== operation.groupServiceVersion) throw new Error('personal_agent_work_revoked');
}
