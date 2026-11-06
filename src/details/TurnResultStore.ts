import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { migrateSqliteSchema } from '../state/SqliteSchema.js';
import { detailTurnKey } from './DetailEventAdapter.js';
import type { DetailScope, DetailTurnIdentity } from './TurnDetailTypes.js';
import { sanitizePublicAnswerText } from './DetailSanitizer.js';

/** Internal storage only. Callers must authorize the saved scope before reading an answer. */
export class TurnResultStore {
  private readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    try { migrateSqliteSchema(this.db); } catch (error) { this.db.close(); throw error; }
  }

  /** Accept only finalized public text, never raw reasoning or tool output. First result wins. */
  save(identity: DetailTurnIdentity, scope: DetailScope, answer: string, endedAt: string): void {
    if (!Number.isFinite(Date.parse(endedAt)) || answer.includes('\0')) throw new Error('invalid_result');
    // The full public answer is already in memory. Preserve long ordinary lines,
    // while applying the same known-secret redaction before new persistence.
    const safe = sanitizePublicAnswerText(answer);
    this.db.prepare(`INSERT OR IGNORE INTO turn_results(turn_key,scope,answer,answer_length,ended_at)
      VALUES(?,?,?,length(?),?)`).run(detailTurnKey(identity), JSON.stringify(scope), safe, safe, endedAt);
  }

  metadata(identity: DetailTurnIdentity): { scope: DetailScope; endedAt: string; length: number } | undefined {
    const row = this.db.prepare('SELECT scope,ended_at,answer_length FROM turn_results WHERE turn_key=?')
      .get(detailTurnKey(identity)) as { scope: string; ended_at: string; answer_length: number } | undefined;
    return row ? { scope: JSON.parse(row.scope) as DetailScope, endedAt: row.ended_at, length: row.answer_length } : undefined;
  }

  readPage(identity: DetailTurnIdentity, offset = 0): { text: string; nextOffset?: number } {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid_cursor');
    // SQLite substr counts Unicode code points; no UTF-16 surrogate or UTF-8 byte splitting.
    const row = this.db.prepare('SELECT substr(answer,?,2000) AS text,answer_length FROM turn_results WHERE turn_key=?')
      .get(offset + 1, detailTurnKey(identity)) as { text: string; answer_length: number } | undefined;
    if (!row) throw new Error('not_found');
    if (offset > row.answer_length) throw new Error('invalid_cursor');
    const next = offset + Array.from(row.text).length;
    return { text: row.text, ...(next < row.answer_length ? { nextOffset: next } : {}) };
  }

  close(): void { this.db.close(); }

  stateRef(identity: DetailTurnIdentity, viewer: string, kind: 'cursor' | 'browser', value?: unknown): string {
    return createHash('sha256').update(JSON.stringify([detailTurnKey(identity), viewer, kind, kind === 'cursor' ? value : 'result']))
      .digest('hex').slice(0, 32);
  }

  saveState(identity: DetailTurnIdentity, viewer: string, kind: 'cursor' | 'browser', value: unknown): string {
    const payload = JSON.stringify(value);
    if (!viewer || viewer.length > 128 || !payload || Buffer.byteLength(payload) > 24000) throw new Error('invalid_cursor');
    const key = detailTurnKey(identity), ref = this.stateRef(identity, viewer, kind, value);
    return this.db.transaction(() => {
      const count = this.db.prepare('SELECT count(*) AS n FROM turn_result_views WHERE turn_key=? AND kind=? AND ref<>?')
        .get(key, kind, ref) as { n: number };
      if (count.n >= 256) {
        if (kind === 'browser') throw new Error('view_quota');
        this.db.prepare('DELETE FROM turn_result_views WHERE ref=(SELECT ref FROM turn_result_views WHERE turn_key=? AND kind=? ORDER BY updated_at LIMIT 1)').run(key, kind);
      }
      this.db.prepare(`INSERT INTO turn_result_views(ref,turn_key,viewer_id,kind,payload,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(ref) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at`)
        .run(ref, key, viewer, kind, payload, new Date().toISOString());
      return ref;
    }).immediate();
  }

  getState(ref: string, identity: DetailTurnIdentity, viewer: string, kind: 'cursor' | 'browser'): unknown | undefined {
    const row = this.db.prepare('SELECT payload FROM turn_result_views WHERE ref=? AND turn_key=? AND viewer_id=? AND kind=?')
      .get(ref, detailTurnKey(identity), viewer, kind) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }

  /** Only after scope authorization: share a page position, never another viewer's browser. */
  forkCursor(ref: string, identity: DetailTurnIdentity, viewer: string): string | undefined {
    const row = this.db.prepare("SELECT payload FROM turn_result_views WHERE ref=? AND turn_key=? AND kind='cursor'")
      .get(ref, detailTurnKey(identity)) as { payload: string } | undefined;
    return row ? this.saveState(identity, viewer, 'cursor', JSON.parse(row.payload)) : undefined;
  }
}
