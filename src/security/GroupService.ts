import type {SqliteStateStore} from '../state/SqliteStateStore.js';
import type {GroupLifecycleEvent, GroupServiceRecord} from './GroupServiceTypes.js';
import type {FeishuIncomingMessage} from '../feishu/FeishuGateway.js';

/** Maintains facts only. It does not bypass global admission or open group access. */
export class GroupService {
  constructor(private readonly deps: {
    store: SqliteStateStore;
    agentId: string;
    ownerUserId: string;
    /** Fresh verification of BOTH owner membership and bot presence in this group. */
    verifyGroup: (chatId: string, ownerUserId: string) => Promise<boolean>;
    clock?: () => Date;
  }) {}

  get(chatId: string): GroupServiceRecord | undefined {
    return this.deps.store.getGroupService(this.deps.agentId, chatId);
  }

  isCurrent(chatId: string, version: number): boolean {
    const row = this.get(chatId);
    return Number.isSafeInteger(version) && version > 0 && row?.version === version
      && row.status === 'enabled' && row.ownerUserId === this.deps.ownerUserId;
  }

  async handleOwnerCommand(message: FeishuIncomingMessage): Promise<string | undefined> {
    if (!/^\/agent\s+group(?:\s|$)/.test(message.text.trim())) return undefined;
    if (message.userId !== this.deps.ownerUserId || message.chatType !== 'private') {
      throw new Error('Group management requires owner private chat.');
    }
    const match = /^\/agent\s+group\s+(enable|disable)\s+(oc_[A-Za-z0-9_-]+)$/.exec(message.text.trim());
    if (!match) return '用法：/agent group enable <chat_id> 或 /agent group disable <chat_id>';
    if (!message.messageId) throw new Error('Group management requires authenticated command identity.');
    const record = await this.manage({chatId: match[2], actorUserId: message.userId, chatType: message.chatType,
      commandId: message.messageId, enable: match[1] === 'enable'});
    if (record?.eventId !== `command:${message.messageId}`) return '群服务状态已变化，请重新查询并发送新的管理命令。';
    return record.status === 'enabled' ? '已记录群服务启用；实际请求仍受总开关与准入校验控制。' : '已撤销群服务资格。';
  }

  async handleLifecycle(event: GroupLifecycleEvent): Promise<GroupServiceRecord | undefined> {
    if (!event.eventId || !event.chatId || !Number.isSafeInteger(event.occurredAt) || event.occurredAt <= 0
      || !['added', 'removed'].includes(event.kind)) throw new Error('Invalid group lifecycle event.');
    const before = this.get(event.chatId);
    let status: GroupServiceRecord['status'] = event.kind === 'removed' ? 'revoked' : 'pending';
    if (event.kind === 'added' && event.operatorUserId === this.deps.ownerUserId) {
      try {if (await this.deps.verifyGroup(event.chatId, this.deps.ownerUserId)) status = 'enabled';}
      catch { /* Identity queries fail closed; pending is not an admission grant. */ }
    }
    return this.deps.store.applyGroupServiceTransition({
      agentId: this.deps.agentId, chatId: event.chatId, ownerUserId: this.deps.ownerUserId,
      status, eventId: `platform:${event.eventId}`, occurredAt: event.occurredAt,
      source: 'lifecycle', expectedVersion: before?.version ?? 0, updatedAt: this.now().toISOString(),
    });
  }

  async manage(input: {chatId: string; actorUserId: string; chatType: 'private'|'group'; commandId: string; enable: boolean}): Promise<GroupServiceRecord | undefined> {
    if (input.actorUserId !== this.deps.ownerUserId) throw new Error('Group management requires the agent owner.');
    if (input.chatType !== 'private') throw new Error('Group management requires owner private chat.');
    if (!input.commandId || !input.chatId) throw new Error('Group management requires authenticated command identity.');
    const before = this.get(input.chatId);
    if (input.enable && !await this.deps.verifyGroup(input.chatId, this.deps.ownerUserId)) {
      throw new Error('Group membership could not be verified.');
    }
    return this.deps.store.applyGroupServiceTransition({
      agentId: this.deps.agentId, chatId: input.chatId, ownerUserId: this.deps.ownerUserId,
      status: input.enable ? 'enabled' : 'revoked', eventId: `command:${input.commandId}`,
      occurredAt: Math.max(this.now().getTime(), before?.occurredAt ?? 0), source: 'owner',
      expectedVersion: before?.version ?? 0, updatedAt: this.now().toISOString(),
    });
  }

  private now(): Date {return (this.deps.clock ?? (() => new Date()))();}
}
