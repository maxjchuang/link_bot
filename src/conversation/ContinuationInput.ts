import type { ConversationContext, ConversationContextImage } from './ConversationContextProvider.js';
import type { IncomingResourceDescriptor } from '../media/MediaTypes.js';

/** Manager-owned provenance and bounded display input, never model tool arguments. */
export interface ContinuationInputSnapshot {
  version: 1;
  sourceContextId?: string;
  incompleteReason?: string;
  request: { chatId: string; chatType: 'group'|'private'; userId: string; topicId?: string;
    messageId?: string; rootId?: string; createdAt?: string; resources?: IncomingResourceDescriptor[] };
  conversation?: ConversationContext;
  followupMessageIds?: string[];
  attachmentIds: string[];
  images: Array<Pick<ConversationContextImage, 'messageId'|'imageKey'|'forwardedEnvelopeMessageId'>>;
  capturedAt: string;
  expiresAt: string;
}

/** The enclosing message and child association both come from fetched history,
 * never from tool/model arguments. Also recognizes pre-fix persisted snapshots. */
export function imageAuthorizationMessage(context: ConversationContext | undefined,
  image: Pick<ConversationContextImage, 'messageId'|'imageKey'|'forwardedEnvelopeMessageId'>): string {
  const envelopes = context?.messages.filter(message => message.messageType === 'merge_forward'
    && message.images?.some(child => child.messageId === image.messageId && child.imageKey === image.imageKey)) ?? [];
  if (image.forwardedEnvelopeMessageId) {
    if (!envelopes.some(message => message.messageId === image.forwardedEnvelopeMessageId)) {
      throw new Error('转发材料缺少可信的外层消息关联，已暂停续办。');
    }
    return image.forwardedEnvelopeMessageId;
  }
  return envelopes[0]?.messageId ?? image.messageId;
}

export function withoutImageBodies(context: ConversationContext | undefined): ConversationContext | undefined {
  if (!context) return undefined;
  const clean = ({dataUrl:_body,...image}:ConversationContextImage) => image;
  const result={...context,messages:context.messages.map(message=>({...message,images:message.images?.map(clean)})),
    images:context.images?.map(clean)};
  if(Buffer.byteLength(JSON.stringify(result))>128_000) {
    return {...result,messages:[],truncated:true,unavailableReason:'handoff_snapshot_budget'};
  }
  return result;
}
