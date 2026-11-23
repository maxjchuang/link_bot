/** Facts from the authenticated platform dispatcher, never message/body claims. */
export interface GroupLifecycleEvent {
  eventId: string;
  chatId: string;
  occurredAt: number;
  kind: 'added' | 'removed';
  operatorUserId?: string;
}

export interface GroupServiceRecord {
  agentId: string;
  chatId: string;
  ownerUserId: string;
  status: 'pending' | 'enabled' | 'revoked';
  version: number;
  eventId: string;
  occurredAt: number;
  source: 'lifecycle' | 'owner';
  updatedAt: string;
}

export interface GroupServiceTransition extends Omit<GroupServiceRecord, 'version'> {
  /** Snapshot BEFORE async member verification; stale verification cannot grant service. */
  expectedVersion: number;
}
