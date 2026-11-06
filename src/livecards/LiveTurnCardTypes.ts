import type { FeishuReplyTarget } from '../feishu/FeishuGateway.js';
import type { RenderedFeishuMessage } from '../feishu/FeishuMessageRenderer.js';

export type RenderedPair = {
  preferred: RenderedFeishuMessage;
  fallback: RenderedFeishuMessage;
};

export type LiveTurnState =
  | 'creating'
  | 'live'
  | 'recovering'
  | 'finalizing'
  | 'finalized'
  | 'failed'
  | 'fallback';

export interface FinalizationIntent {
  sequence: number;
  uuid: string;
  card: Record<string, unknown>;
}

export interface LiveTurnRecord {
  turnId: string;
  sourceSessionId: string;
  activeSessionId: string;
  chatId: string;
  projectId: string;
  prompt: string;
  startedAt: string;
  outputStartOffset: number;
  replyTarget?: FeishuReplyTarget;
  state: LiveTurnState;
  cardId?: string;
  messageId?: string;
  sendUuid: string;
  nextSequence: number;
  lastRenderedHash?: string;
  recoveryAttempt: number;
  finalizationIntent?: FinalizationIntent;
}

export type CardKitErrorCategory = 'retryable' | 'permanent' | 'payload';

export class CardKitApiError extends Error {
  constructor(message: string, readonly category: CardKitErrorCategory, readonly code?: number, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'CardKitApiError';
  }
}

export interface CardKitGateway {
  updateCardKitRegions?(input: {
    cardId: string; regions: Array<{ elementId: string; element: Record<string, unknown>; previousElement?: Record<string, unknown> }>;
    sequence: number; uuid: string;
  }): Promise<void>;
  createCardKitEntity(card: Record<string, unknown>): Promise<{ cardId: string }>;
  sendCardKitEntityToTarget(
    target: FeishuReplyTarget,
    cardId: string,
    uuid: string,
  ): Promise<{ messageId: string }>;
  updateCardKitElement(input: {
    cardId: string;
    elementId: string;
    element: Record<string, unknown>;
    sequence: number;
    uuid: string;
  }): Promise<void>;
  replaceCardKitEntity(input: {
    cardId: string;
    card: Record<string, unknown>;
    sequence: number;
    uuid: string;
  }): Promise<void>;
}
