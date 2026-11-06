export const TURN_DETAIL_SCHEMA_VERSION = 1;
export const TURN_DETAIL_LIMIT_BYTES = 50 * 1024 * 1024;
export const TURN_DETAIL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface DetailTurnIdentity {
  ownerKind: 'task_platform' | 'host_manager';
  taskId: string;
  localTurnId: string;
}

export interface DetailTurnBinding extends DetailTurnIdentity {
  threadId: string;
  codexTurnId?: string;
}

export type DetailLifecycle = 'running' | 'completed' | 'failed' | 'interrupted';
export type DetailCategory = 'process' | 'commands' | 'files';
export type DetailScope =
  | { kind: 'shared_group_topic'; chatId: string; topicId: string }
  | { kind: 'private_user'; chatId: string; userId: string };

export interface DetailPendingAction {
  requestRef: string;
  generation: number;
  handlerUserId: string;
  expiresAt: string;
  status: 'preparing' | 'preparation_failed' | 'delivered' | 'submitting' | 'submission_failed';
  messageId?: string;
  title?: string;
  impact?: string;
  messageAppLink?: string;
}

export interface DetailTurnRecord extends DetailTurnBinding {
  schemaVersion: number;
  scope: DetailScope;
  startedAt: string;
  endedAt?: string;
  lifecycle: DetailLifecycle;
  availability: 'available' | 'expired' | 'cleared';
  retainedBytes: number;
  truncated: boolean;
  incomplete?: boolean;
  redactionGapThrough?: number;
  summaryTail?: string;
}

export interface DetailResourceRef {
  resourceId: string;
  committedBytes: number;
  revision: number;
  truncated: boolean;
  redacted: boolean;
}

/** Candidate events are NOT safe to persist: the recorder must sanitize first. */
export type DetailCandidate =
  | { kind: 'process_item'; itemId: string; completed: boolean; finalAnswer?: true; segments: Array<{ source: 'summary' | 'progress' | 'plan'; partIndex?: number; text: string }> }
  | { kind: 'process_delta'; itemId: string; source: 'summary' | 'progress' | 'plan'; partIndex?: number; text: string }
  | { kind: 'process_part'; itemId: string; partIndex: number }
  | { kind: 'command_delta'; itemId: string; stream: 'stdout' | 'stderr' | 'combined'; text: string }
  | { kind: 'command_item'; itemId: string; completed: boolean; command?: string; cwd?: string; status?: string;
      exitCode?: number; startedAtMs?: number; completedAtMs?: number; durationMs?: number; aggregatedOutput?: string }
  | { kind: 'diff_snapshot'; text: string }
  | { kind: 'terminal'; lifecycle: Exclude<DetailLifecycle, 'running'> };

export interface DetailEntry {
  entryId: string;
  category: DetailCategory;
  itemId: string;
  source?: 'summary' | 'progress' | 'plan';
  partIndex?: number;
  receivedAt: string;
  metadata: Record<string, string | number | boolean>;
  resource?: DetailResourceRef;
  missing?: boolean;
}

export interface DetailPage {
  entries: DetailEntry[];
  text?: string;
  nextCursorRef?: string;
  truncated: boolean;
}
