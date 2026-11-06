import type { BotConfig } from '../domain/types.js';
import type { FeishuIncomingMessage } from '../feishu/FeishuGateway.js';

export function classifyPublicFixedFlow(_config: BotConfig, _message: Partial<FeishuIncomingMessage>): undefined {
  return undefined;
}
