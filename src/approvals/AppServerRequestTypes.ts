export type AppServerRequestKind = 'approval' | 'user_input';
export type AppServerRequestStatus =
  | 'pending'
  | 'decided'
  | 'delivered'
  | 'expired'
  | 'resolved'
  | 'connection_lost';

export interface AppServerRequestRecord {
  purpose?: 'owner_authorization' | 'requester_clarification';
  requesterUserId?: string;
  groupServiceVersion?: number;
  sourceAudience?: import('../security/AgentExecutionIdentity.js').AgentExecutionIdentity['audience'];
  operationSnapshotHash?: string;
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
  /** Original RPC is cancelled; an owner decision is a durable one-operation ticket, not an RPC replay. */
  continuation?: {
    state: 'cancelling' | 'waiting' | 'queued' | 'submitted' | 'consumed' | 'unknown';
    operationHash: string;
    /** False for requests without enough data to reconstruct a controlled operation. */
    replayable?: boolean;
    resumedLocalTurnId?: string;
  };
}

export type DecideAppServerRequestResult =
  | { accepted: true; duplicate: boolean; request: AppServerRequestRecord }
  | {
      accepted: false;
      reason: 'not_found' | 'identity_mismatch' | 'generation_mismatch' | 'expired' | 'not_pending';
      request?: AppServerRequestRecord;
    };
