import type { DetailScope } from './TurnDetailTypes.js';

/** Identity and source must come from a verified platform callback, never button parameters. */
export interface DetailReadContext { userId: string; sourceMessageId: string }
export interface DetailAccessPort {
  resolveSource(messageId: string): Promise<{ chatId: string; chatType: 'private' | 'group'; topicId?: string } | undefined>;
  isGroupMember(chatId: string, userId: string): Promise<boolean>;
  canReadTopic(chatId: string, topicId: string, userId: string): Promise<boolean>;
}

export class DetailAccessPolicy {
  constructor(private readonly port: DetailAccessPort) {}

  async requireRead(scope: DetailScope, actor: DetailReadContext): Promise<void> {
    const check = (allowed: boolean) => { if (!allowed) throw new Error('access_denied'); };
    try {
      check(scope.kind === 'private_user' || scope.kind === 'shared_group_topic');
      check(Boolean(actor.userId && actor.sourceMessageId));
      if (scope.kind === 'private_user') check(actor.userId === scope.userId);
      const source = await this.port.resolveSource(actor.sourceMessageId);
      if (!source) throw new Error('access_denied');
      check(source.chatId === scope.chatId);
      if (scope.kind === 'shared_group_topic') {
        if (source.chatType !== 'group' || source.topicId !== scope.topicId || await this.port.isGroupMember(scope.chatId, actor.userId) !== true
          || await this.port.canReadTopic(scope.chatId, scope.topicId, actor.userId) !== true) throw new Error('access_denied');
      } else check(source.chatType === 'private' && !source.topicId);
    } catch (error) {
      // API/schema failures still fail closed, but are not evidence that the actor was denied.
      throw new Error(error instanceof Error && error.message === 'access_denied' ? 'access_denied' : 'access_unavailable');
    }
  }
}
