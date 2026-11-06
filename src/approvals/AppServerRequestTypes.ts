export type AppServerRequestKind = 'approval' | 'user_input';
export type AppServerRequestStatus =
  | 'pending'
  | 'decided'
  | 'delivered'
  | 'expired'
  | 'resolved'
  | 'connection_lost';

export interface AppServerRequestRecord {
  id: string;
  kind: AppServerRequestKind;
  ownerUserId: string;
  taskId: string;
  threadId: string;
  turnId: string;
  localTurnId?: string;
  generation: number;
  serverRequestId: string | number;
  method: string;
  riskSummary: string;
  payload: unknown;
  status: AppServerRequestStatus;
  createdAt: string;
  expiresAt: string;
  decision?: 'allow' | 'deny' | 'answer';
  answers?: Record<string, string[]>;
  decidedAt?: string;
  deliveredAt?: string;
  invalidatedAt?: string;
  /** Feishu operation-card receipt; deliveredAt remains the response-to-Codex timestamp. */
  operationCard?: { status: 'sent' | 'failed'; messageId?: string; messageAppLink?: string; at: string };
  responseState?: 'submitting' | 'failed' | 'delivered';
}

export type DecideAppServerRequestResult =
  | { accepted: true; duplicate: boolean; request: AppServerRequestRecord }
  | {
      accepted: false;
      reason: 'not_found' | 'identity_mismatch' | 'generation_mismatch' | 'expired' | 'not_pending';
      request?: AppServerRequestRecord;
    };
