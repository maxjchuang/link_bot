import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import type { FeishuReplyTarget } from '../feishu/FeishuGateway.js';
import type { LiveTurnSnapshot } from '../projections/LiveTurnProjection.js';
import { migrateSqliteSchema } from '../state/SqliteSchema.js';
import type { CodexServiceTier, ExecutionProfile } from '../tasks/ExecutionProfile.js';

export type AppServerCardState = 'creating' | 'live' | 'recovering' | 'finalizing' | 'finalized' | 'interrupted' | 'fallback';
export interface RequestReleaseMark { requestRef: string; at: string }

export interface AppServerFinalizationIntent {
  sequence: number;
  uuid: string;
  card: Record<string, unknown>;
  terminalState: 'finalized' | 'interrupted';
  deliveryMode?: 'outbox';
  attempts?: number;
  nextAttemptAt?: string;
  fallbackRequested?: boolean;
  fallbackAttempts?: number;
  /** Sanitized public answer only; never recover text from arbitrary historical card payloads. */
  fallbackText?: string;
}

export interface AppServerTurnCardRecord {
  /** Absent on legacy records; do not rewrite historical payloads. */
  schemaVersion?: number;
  structuredView?: boolean;
  inlineDetails?: boolean;
  detailCardRef?: string;
  id: string;
  ownerKind: 'task_platform' | 'host_manager';
  taskId: string;
  localTurnId: string;
  projectId?: string;
  displayLabel?: string;
  prompt?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: CodexServiceTier;
  pendingProfile?: ExecutionProfile;
  target: FeishuReplyTarget;
  requestMessageId?: string;
  requesterUserId?: string;
  cardId?: string;
  cardMessageId?: string;
  fallbackMessageId?: string;
  codexTurnId?: string;
  state: AppServerCardState;
  nextSequence: number;
  sendUuid: string;
  startedAt: string;
  updatedAt: string;
  snapshot?: LiveTurnSnapshot;
  finalizationIntent?: AppServerFinalizationIntent;
  /** Bounded unresolved measurements; not proof of a card delivery or client display. */
  requestReleasePending?: RequestReleaseMark[];
  lastError?: string;
  /** Quarantined delivery retains the original intent for diagnosis/manual retry, outside listOpen. */
  deliveryFailure?: 'permanent' | 'retry_exhausted' | 'historical_legacy';
}

export interface AppServerTurnCardStore {
  save(record: AppServerTurnCardRecord): void;
  get(id: string): AppServerTurnCardRecord | undefined;
  update(id: string, updater: (record: AppServerTurnCardRecord) => AppServerTurnCardRecord): AppServerTurnCardRecord | undefined;
  listOpen(ownerKind?: AppServerTurnCardRecord['ownerKind']): AppServerTurnCardRecord[];
  enqueueFinalFallback?(id: string): boolean;
  close?(): void;
}

export class SqliteAppServerTurnCardStore implements AppServerTurnCardStore {
  private readonly db: Database.Database;

  constructor(databasePath: string, private readonly clock: () => Date = () => new Date()) {
    this.db = new Database(databasePath);
    migrateSqliteSchema(this.db);
  }

  save(record: AppServerTurnCardRecord): void {
    this.db.prepare(`
      INSERT INTO live_cards(id, task_id, turn_id, operation_sequence, payload, created_at, updated_at)
      VALUES (@id, @taskId, @localTurnId, @operationSequence, @payload, @startedAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET operation_sequence=excluded.operation_sequence,
        payload=excluded.payload, updated_at=excluded.updated_at
    `).run({
      id: record.id, taskId: record.taskId, localTurnId: record.localTurnId,
      operationSequence: record.nextSequence, payload: JSON.stringify(record),
      startedAt: record.startedAt, updatedAt: record.updatedAt,
    });
  }

  get(id: string): AppServerTurnCardRecord | undefined {
    const row = this.db.prepare('SELECT payload FROM live_cards WHERE id=?').get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as AppServerTurnCardRecord : undefined;
  }

  update(id: string, updater: (record: AppServerTurnCardRecord) => AppServerTurnCardRecord): AppServerTurnCardRecord | undefined {
    const update = this.db.transaction(() => {
      const current = this.get(id);
      if (!current) return undefined;
      const next = { ...updater(current), updatedAt: this.clock().toISOString() };
      this.save(next);
      return next;
    });
    // BEGIN IMMEDIATE acquires the write reservation before the SELECT. A
    // deferred transaction can otherwise fail on read-to-write promotion with
    // SQLITE_BUSY_SNAPSHOT even when busy_timeout is configured.
    return update.immediate();
  }

  listOpen(ownerKind?: AppServerTurnCardRecord['ownerKind']): AppServerTurnCardRecord[] {
    // Closed cards retain large render snapshots. Filter inside SQLite before
    // crossing into V8: loading every payload can exhaust the Node heap after
    // a long-lived installation accumulates years of completed turns.
    const rows = this.db.prepare(`
      SELECT payload FROM live_cards
      WHERE id LIKE 'app-server:%'
        AND json_extract(payload, '$.state') IN ('creating', 'live', 'recovering', 'finalizing')
        AND (? IS NULL OR json_extract(payload, '$.ownerKind') = ?)
      ORDER BY created_at
    `).all(ownerKind ?? null, ownerKind ?? null) as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as AppServerTurnCardRecord);
  }

  close(): void { this.db.close(); }

  /** Atomic handoff shared by the gateway and host-manager; only the gateway flushes it. */
  enqueueFinalFallback(id: string): boolean {
    return this.db.transaction(() => {
      const record = this.get(id);
      if (!record?.finalizationIntent || record.state !== 'finalizing') return false;
      const intent = record.finalizationIntent;
      if (!record.structuredView && !intent.fallbackText) return false;
      const dedupeKey = `structured-final:${id}:${intent.uuid}`;
      const outboxId = `out_${createHash('sha256').update(dedupeKey).digest('hex').slice(0, 24)}`;
      const now = this.clock().toISOString();
      this.db.prepare(`INSERT OR IGNORE INTO outbound_events(id,dedupe_key,target,event_type,status,attempts,payload,created_at,updated_at)
        VALUES(?,?,?,'card','pending',0,?,?,?)`).run(outboxId, dedupeKey, JSON.stringify(record.target),
          JSON.stringify({ kind: record.structuredView ? 'structured_turn_final' : 'legacy_turn_final', recordId: id, intentUuid: intent.uuid }), now, now);
      this.save({ ...record, finalizationIntent: { ...intent, deliveryMode: 'outbox' }, updatedAt: now });
      return true;
    }).immediate();
  }
}

export function appServerCardRecordId(ownerKind: AppServerTurnCardRecord['ownerKind'], localTurnId: string): string {
  return `app-server:${ownerKind}:${localTurnId}`;
}

export function newAppServerCardRecord(input: {
  ownerKind: AppServerTurnCardRecord['ownerKind']; taskId: string; localTurnId: string;
  projectId?: string; displayLabel?: string; target: FeishuReplyTarget; requestMessageId?: string; prompt?: string;
  requesterUserId?: string;
  model?: string; reasoningEffort?: string; serviceTier?: CodexServiceTier; pendingProfile?: ExecutionProfile; now: string;
}): AppServerTurnCardRecord {
  return {
    schemaVersion: 2,
    id: appServerCardRecordId(input.ownerKind, input.localTurnId), ownerKind: input.ownerKind,
    taskId: input.taskId, localTurnId: input.localTurnId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.displayLabel ? { displayLabel: input.displayLabel } : {}),
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
    ...(input.pendingProfile ? { pendingProfile: input.pendingProfile } : {}),
    target: input.target, ...(input.requestMessageId ? { requestMessageId: input.requestMessageId } : {}),
    ...(input.requesterUserId ? { requesterUserId: input.requesterUserId } : {}),
    state: 'creating', nextSequence: 1, sendUuid: randomUUID(), startedAt: input.now, updatedAt: input.now,
  };
}
