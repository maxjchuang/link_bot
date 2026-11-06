import QRCode from 'qrcode';
import type { FeishuGateway, FeishuOutgoingReply } from '../feishu/FeishuGateway.js';
import { renderToolAuthorizationCard } from '../feishu/TaskPlatformCards.js';
import type { PendingAuthenticatedTurn } from './AuthTypes.js';

export function createToolAuthorizationCardRenderer(
  gateway: Pick<FeishuGateway, 'uploadImage'>,
  onFallback?: (pending: PendingAuthenticatedTurn, error: unknown) => void,
): (pending: PendingAuthenticatedTurn) => Promise<NonNullable<FeishuOutgoingReply['rendered']>> {
  return async (pending) => {
    if (!gateway.uploadImage) return renderToolAuthorizationCard(pending);
    try {
      const image = await QRCode.toBuffer(pending.authorizationUrl, { type: 'png', width: 320, margin: 2 });
      const imageKey = await gateway.uploadImage(image);
      return renderToolAuthorizationCard(pending, imageKey);
    } catch (error) {
      onFallback?.(pending, error);
      return renderToolAuthorizationCard(pending);
    }
  };
}
