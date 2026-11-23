import type {BotConfig} from '../domain/types.js';
import type {TaskActorContext} from '../feishu/FeishuTaskController.js';
import type {SqliteStateStore} from '../state/SqliteStateStore.js';
import {agentIdForApp} from './AgentExecutionIdentity.js';
import {isAuthorizedChat} from './guards.js';

/** Ordinary task admission only. It never grants host/admin/approval authority. */
export class PersonalAgentAdmission {
  constructor(private readonly config: Pick<BotConfig, 'personalAgent'|'feishu'|'restrictChatIds'|'allowedChatIds'>,
    private readonly store: Pick<SqliteStateStore, 'getGroupService'>,
    private readonly isCurrentMember: (chatId: string, userId: string) => Promise<boolean>) {}

  async admit(actor: TaskActorContext): Promise<TaskActorContext | undefined> {
    const mode = this.config.personalAgent;
    if (!mode?.enabled || !actor.userId || !actor.chatId) return undefined;
    // Strip any supplied epoch. Only a server-side grant may populate this field.
    const {groupServiceVersion: _untrustedVersion, ...principal} = actor;
    if (actor.chatType === 'private') return actor.userId === mode.ownerUserId ? principal : undefined;
    if (!isAuthorizedChat(this.config, actor)) return undefined;
    const agentId = agentIdForApp(this.config.feishu.appId);
    const before = this.store.getGroupService(agentId, actor.chatId);
    if (before?.status !== 'enabled' || before.ownerUserId !== mode.ownerUserId) return undefined;
    try {if (!await this.isCurrentMember(actor.chatId, actor.userId)) return undefined;}
    catch {return undefined;}
    const after = this.store.getGroupService(agentId, actor.chatId);
    if (!this.config.personalAgent?.enabled || this.config.personalAgent.ownerUserId !== mode.ownerUserId
      || after?.version !== before.version || after.status !== 'enabled' || after.ownerUserId !== mode.ownerUserId) return undefined;
    return {...principal, groupServiceVersion: before.version};
  }
}
