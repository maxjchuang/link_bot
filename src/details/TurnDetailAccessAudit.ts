import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { migrateSqliteSchema } from '../state/SqliteSchema.js';
import type { DetailCategory, DetailTurnIdentity } from './TurnDetailTypes.js';

export type DetailAccessOutcome = 'served' | 'duplicate' | 'queued' | 'delivered' | 'denied' | 'expired'
  | 'not_found' | 'invalid_cursor' | 'snapshot_changed' | 'busy' | 'unavailable';
export interface DetailAccessAttempt {
  operation: 'view' | 'page' | 'download_request' | 'download_delivery' | 'inline_publish';
  category: DetailCategory | 'result';
  actorId: string; sourceMessageId?: string; sourceChatId?: string;
  cardRef?: string; itemRef?: string; cursorRef?: string; deliveryKey?: string;
  identity?: DetailTurnIdentity;
}
export interface DetailAccessReceipt { finish(outcome: DetailAccessOutcome, identity?: DetailTurnIdentity): void }
export interface DetailAccessAuditPort { begin(attempt: DetailAccessAttempt): DetailAccessReceipt }
export const unavailableDetailAudit: DetailAccessAuditPort = { begin: () => { throw new Error('detail_audit_unavailable'); } };

/** Per-attempt history, not aggregate metrics. No bodies, arbitrary labels or raw platform IDs. */
export class TurnDetailAccessAudit implements DetailAccessAuditPort {
  private readonly db: Database.Database;
  constructor(path: string, private readonly clock: () => Date = () => new Date()) {
    this.db = new Database(path);
    try { migrateSqliteSchema(this.db); } catch (error) { this.db.close(); throw error; }
    this.db.pragma('busy_timeout=0'); // Refuse disclosure rather than stall execution behind an audit writer.
  }

  begin(attempt: DetailAccessAttempt): DetailAccessReceipt {
    if (!['view', 'page', 'download_request', 'download_delivery', 'inline_publish'].includes(attempt.operation)
      || !['process', 'commands', 'files', 'result'].includes(attempt.category)) throw new Error('invalid_detail_audit');
    const metadata: Record<string, string | number> = { version: 1, operation: attempt.operation, category: attempt.category };
    // Explicit allowlist; extra properties supplied by a caller can never reach the database.
    for (const field of ['actorId', 'sourceMessageId', 'sourceChatId', 'cardRef', 'itemRef', 'cursorRef', 'deliveryKey'] as const) {
      if (attempt[field] !== undefined) metadata[`${field}Hash`] = fingerprint(field, attempt[field]!);
    }
    if (attempt.identity) metadata.turnHash = turnFingerprint(attempt.identity);
    const id = randomUUID();
    const insert = (phase: 'attempt' | 'outcome', payload: Record<string, string | number>) => {
      try {
        this.db.prepare('INSERT INTO audit_events(event_key,event_type,payload,created_at) VALUES(?,?,?,?)')
          .run(`detail-access:${id}:${phase}`, `detail_access.${phase}`, JSON.stringify({ ...payload, attemptId: id }), this.clock().toISOString());
      } catch { throw new Error('detail_audit_unavailable'); }
    };
    insert('attempt', metadata); // Must commit before any read/publish/upload side effect.
    let finished = false;
    return { finish: (outcome, identity) => {
      if (finished) return;
      if (!['served', 'duplicate', 'queued', 'delivered', 'denied', 'expired', 'not_found', 'invalid_cursor',
        'snapshot_changed', 'busy', 'unavailable'].includes(outcome)) throw new Error('invalid_detail_audit');
      insert('outcome', { ...metadata, outcome, ...(identity ? { turnHash: turnFingerprint(identity) } : {}) });
      finished = true;
    } };
  }
  close(): void { this.db.close(); }
}

function fingerprint(field: string, value: string): string {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('invalid_detail_audit');
  return createHash('sha256').update(`${field}\0${value}`).digest('hex');
}
function turnFingerprint(identity: DetailTurnIdentity): string {
  return fingerprint('turn', JSON.stringify([identity.ownerKind, identity.taskId, identity.localTurnId]));
}

export function detailAccessFailure(error: unknown): DetailAccessOutcome {
  const code = error instanceof Error ? error.message : '';
  return code === 'access_denied' ? 'denied' : code === 'expired' || code === 'cleared' ? 'expired'
    : code === 'not_found' ? 'not_found' : code === 'invalid_cursor' ? 'invalid_cursor'
      : code === 'snapshot_changed' ? 'snapshot_changed' : code === 'artifact_busy' ? 'busy' : 'unavailable';
}
