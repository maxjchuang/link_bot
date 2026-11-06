import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { migrateSqliteSchema } from '../state/SqliteSchema.js';
import { detailTurnKey } from './DetailEventAdapter.js';
import { TURN_DETAIL_LIMIT_BYTES, type DetailTurnIdentity, type DetailTurnRecord } from './TurnDetailTypes.js';

export class DetailViewStore {
  private readonly db: Database.Database;
  constructor(path: string, private readonly clock: () => Date = () => new Date()) { this.db = new Database(path); migrateSqliteSchema(this.db); }

  registerCard(identity: DetailTurnIdentity): string {
    return this.db.transaction(() => {
      const key = detailTurnKey(identity);
      const prior = this.db.prepare('SELECT card_ref FROM detail_card_refs WHERE turn_key=?').get(key) as { card_ref: string } | undefined;
      if (prior) return prior.card_ref;
      const ref = randomBytes(16).toString('hex');
      this.db.prepare('INSERT INTO detail_card_refs(card_ref,turn_key) VALUES(?,?)').run(ref, key);
      return ref;
    }).immediate();
  }

  resolveCard(ref: string): DetailTurnIdentity | undefined {
    if (!/^[a-f0-9]{32}$/.test(ref)) return undefined;
    const row = this.db.prepare('SELECT turn_key FROM detail_card_refs WHERE card_ref=?').get(ref) as { turn_key: string } | undefined;
    if (!row) return undefined;
    const [ownerKind, taskId, localTurnId] = JSON.parse(row.turn_key) as [DetailTurnIdentity['ownerKind'], string, string];
    return { ownerKind, taskId, localTurnId };
  }

  saveCursor(identity: DetailTurnIdentity, viewerId: string, value: unknown, expiresAt: string): string {
    return this.saveState('cursor', identity, viewerId, value, expiresAt);
  }

  getCursor(ref: string, identity: DetailTurnIdentity, viewerId: string, now: string): unknown | undefined {
    return this.getState('cursor', ref, identity, viewerId, now);
  }

  /** Only call after requireRead: group readers may open their own copy of another viewer's page. */
  forkCursor(ref: string, identity: DetailTurnIdentity, viewerId: string, now: string): string | undefined {
    const row = this.db.prepare("SELECT payload,expires_at FROM detail_view_state WHERE ref=? AND turn_key=? AND kind='cursor' AND expires_at>?")
      .get(ref, detailTurnKey(identity), now) as { payload: string; expires_at: string } | undefined;
    if (!row) return undefined;
    const value = JSON.parse(row.payload) as Record<string, unknown>;
    if (value.kind !== 'body' && value.kind !== 'list') return undefined;
    return this.saveCursor(identity, viewerId, { ...value, ...(value.kind === 'body' ? { viewerId } : {}) }, row.expires_at);
  }

  browserRef(identity: DetailTurnIdentity, viewerId: string, category: string): string {
    return createHash('sha256').update(JSON.stringify(['browser', detailTurnKey(identity), viewerId, category])).digest('hex').slice(0, 32);
  }

  saveBrowser(identity: DetailTurnIdentity, viewerId: string, value: unknown, expiresAt: string): string {
    return this.saveState('browser', identity, viewerId, value, expiresAt);
  }

  getBrowser(ref: string, identity: DetailTurnIdentity, viewerId: string, now: string): unknown | undefined {
    return this.getState('browser', ref, identity, viewerId, now);
  }

  close(): void { this.db.close(); }

  private getState(kind: string, ref: string, identity: DetailTurnIdentity, viewerId: string, now: string): unknown | undefined {
    if (!/^[a-f0-9]{32}$/.test(ref) || !Number.isFinite(Date.parse(now))) return undefined;
    const row = this.db.prepare('SELECT payload FROM detail_view_state WHERE ref=? AND turn_key=? AND viewer_id=? AND kind=? AND expires_at>?')
      .get(ref, detailTurnKey(identity), viewerId, kind, new Date(now).toISOString()) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }

  private saveState(kind: string, identity: DetailTurnIdentity, viewerId: string, value: unknown, expiresAt: string): string {
    const payload = JSON.stringify(value);
    if (!payload || Buffer.byteLength(payload) > 24000 || !viewerId || viewerId.length > 128 || !Number.isFinite(Date.parse(expiresAt))) throw new Error('invalid_view');
    const key = detailTurnKey(identity);
    const stable = kind === 'browser' && typeof value === 'object' && value !== null && 'category' in value ? value.category : payload;
    const ref = createHash('sha256').update(JSON.stringify([kind, key, viewerId, stable])).digest('hex').slice(0, 32);
    return this.db.transaction(() => {
      const now = this.clock().toISOString();
      const turnRow = this.db.prepare('SELECT payload FROM detail_turns WHERE turn_key=?').get(key) as { payload: string } | undefined;
      if (!turnRow) throw new Error('not_found');
      const turn = JSON.parse(turnRow.payload) as DetailTurnRecord;
      if (turn.availability !== 'available') throw new Error('expired');
      let retainedBytes = turn.retainedBytes;
      const expired = this.db.prepare('SELECT coalesce(sum(bytes),0) AS bytes FROM detail_view_state WHERE turn_key=? AND expires_at<=?').get(key, now) as { bytes: number };
      this.db.prepare('DELETE FROM detail_view_state WHERE turn_key=? AND expires_at<=?').run(key, now);
      retainedBytes -= expired.bytes;
      const count = this.db.prepare('SELECT count(*) AS n FROM detail_view_state WHERE turn_key=? AND kind=? AND ref<>?').get(key, kind, ref) as { n: number };
      if (count.n >= (kind === 'cursor' ? 64 : 256)) {
        if (kind === 'browser') throw new Error('view_quota');
        const oldest = this.db.prepare('SELECT ref,bytes FROM detail_view_state WHERE turn_key=? AND kind=? ORDER BY updated_at LIMIT 1').get(key, kind) as { ref: string; bytes: number };
        this.db.prepare('DELETE FROM detail_view_state WHERE ref=?').run(oldest.ref);
        retainedBytes -= oldest.bytes;
      }
      const prior = this.db.prepare('SELECT bytes FROM detail_view_state WHERE ref=?').get(ref) as { bytes: number } | undefined;
      const bytes = Buffer.byteLength(payload) + Buffer.byteLength(viewerId) + 256;
      const used = this.db.prepare('SELECT coalesce(sum(bytes),0) AS bytes FROM detail_view_state WHERE turn_key=?').get(key) as { bytes: number };
      const next = retainedBytes - (prior?.bytes ?? 0) + bytes;
      if (next > TURN_DETAIL_LIMIT_BYTES || used.bytes - (prior?.bytes ?? 0) + bytes > 256 * 1024) throw new Error('view_quota');
      this.db.prepare(`INSERT INTO detail_view_state(ref,turn_key,viewer_id,kind,payload,bytes,expires_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(ref) DO UPDATE SET payload=excluded.payload,bytes=excluded.bytes,expires_at=excluded.expires_at,updated_at=excluded.updated_at`)
        .run(ref, key, viewerId, kind, payload, bytes, new Date(expiresAt).toISOString(), now);
      this.db.prepare('UPDATE detail_turns SET retained_bytes=?,payload=? WHERE turn_key=?').run(next, JSON.stringify({ ...turn, retainedBytes: next }), key);
      return ref;
    }).immediate();
  }
}
