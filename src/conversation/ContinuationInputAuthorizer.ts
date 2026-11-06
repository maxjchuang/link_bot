import type { FeishuGateway } from '../feishu/FeishuGateway.js';
import type { TaskActorContext } from '../feishu/FeishuTaskController.js';

/** Shared by production wiring and continuation regression tests. */
export function continuationInputAuthorizer(gateway: Pick<FeishuGateway,
  'verifySensitiveReplySource'|'resolveDetailMessageScope'|'isDetailReaderMember'>) {
  return async ({ actor, sourceMessageIds }: { actor: TaskActorContext; sourceMessageIds: string[] }): Promise<boolean> => {
    if (!actor.messageId || !gateway.verifySensitiveReplySource || !gateway.resolveDetailMessageScope) return false;
    if (!await gateway.verifySensitiveReplySource(actor.messageId, actor.chatId, actor.userId)) return false;
    if (actor.chatType === 'group' && (!gateway.isDetailReaderMember || !await gateway.isDetailReaderMember(actor.chatId, actor.userId))) return false;
    for (let index = 0; index < sourceMessageIds.length; index += 4) {
      const matches = await Promise.all(sourceMessageIds.slice(index, index + 4).map(async messageId => {
        const scope = await gateway.resolveDetailMessageScope!(messageId);
        return Boolean(scope && scope.chatId === actor.chatId && scope.chatType === actor.chatType
          && (scope.topicId === actor.topicId || messageId === actor.rootId && !scope.topicId));
      }));
      if (matches.some(match => !match)) return false;
    }
    return true;
  };
}
