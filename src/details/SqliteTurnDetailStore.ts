import Database from 'better-sqlite3';
import { MAX_INLINE_TIMELINE_ITEMS } from './InlineTimelineLimits.js';
import { claimRecordingWriter } from './DetailRecordingWriters.js';
import { migrateSqliteSchema } from '../state/SqliteSchema.js';
import { detailTurnKey } from './DetailEventAdapter.js';
import { TURN_DETAIL_LIMIT_BYTES, type DetailCategory, type DetailEntry, type DetailTurnIdentity, type DetailTurnRecord } from './TurnDetailTypes.js';
import type { TurnDetailStore } from './TurnDetailStore.js';
import { changeResourceHold, forgetResourceCharge, type ResourceCharge } from './TurnDetailResourceLedger.js';

// Conservative fixed budget covers each bounded turn index, including evolving counters.
const TURN_INDEX_BUDGET = 4096;

export class SqliteTurnDetailStore implements TurnDetailStore {
  private readonly db: Database.Database;
  private readonly limitBytes: number;
  private readonly maxEntries: number;
  private readonly viewReserve: number;

  constructor(path: string, options: { limitBytes?: number; maxEntries?: number } = {}) {
    this.limitBytes = options.limitBytes ?? TURN_DETAIL_LIMIT_BYTES;
    this.maxEntries = options.maxEntries ?? 2048;
    this.viewReserve = this.limitBytes >= 1024 * 1024 ? 512 * 1024 : 0;
    if (!Number.isSafeInteger(this.limitBytes) || this.limitBytes < TURN_INDEX_BUDGET
      || !Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) throw new Error('Invalid detail quota');
    this.db = new Database(path);
    migrateSqliteSchema(this.db);
  }

  createTurn(record: DetailTurnRecord): DetailTurnRecord {
    return this.db.transaction(() => {
      const existing = this.getTurn(record);
      if (existing) {
        if (JSON.stringify(existing.scope) !== JSON.stringify(record.scope) || existing.threadId !== record.threadId
          || existing.codexTurnId !== record.codexTurnId) throw new Error('Detail turn binding mismatch');
        return existing;
      }
      const next = { ...record, retainedBytes: TURN_INDEX_BUDGET };
      // Reserve half for terminal fields and the bounded emergency summary.
      if (Buffer.byteLength(JSON.stringify(next)) > TURN_INDEX_BUDGET / 2) throw new Error('Detail turn index exceeds budget');
      this.db.prepare('INSERT INTO detail_turns(turn_key,payload,ended_at,availability,retained_bytes) VALUES(?,?,?,?,?)')
        .run(detailTurnKey(record), JSON.stringify(next), record.endedAt ?? null, record.availability, next.retainedBytes);
      return next;
    }).immediate();
  }

  getTurn(identity: DetailTurnIdentity): DetailTurnRecord | undefined {
    const row = this.db.prepare('SELECT payload FROM detail_turns WHERE turn_key=?').get(detailTurnKey(identity)) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as DetailTurnRecord : undefined;
  }

  getEntry(identity: DetailTurnIdentity, entryId: string): DetailEntry | undefined {
    const row = this.db.prepare('SELECT payload FROM detail_entries WHERE turn_key=? AND entry_id=?')
      .get(detailTurnKey(identity), entryId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as DetailEntry : undefined;
  }

  hasEvent(identity: DetailTurnIdentity, eventKey: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM detail_events WHERE turn_key=? AND event_key=?').get(detailTurnKey(identity), eventKey));
  }

  markIncomplete(identity: DetailTurnIdentity, safeTail?: string): void {
    this.db.transaction(() => {
      const turn = this.getTurn(identity);
      if (turn) this.saveTurn({ ...turn, incomplete: true, ...(safeTail ? { summaryTail: safeTail.slice(-512) } : {}) });
    }).immediate();
  }

  markTruncated(identity: DetailTurnIdentity): void {
    this.db.transaction(() => {
      const turn = this.getTurn(identity);
      if (turn) this.saveTurn({ ...turn, truncated: true });
    }).immediate();
  }

  markStreamGap(identity: DetailTurnIdentity): void {
    this.db.transaction(() => {
      const turn = this.getTurn(identity);
      if (!turn) return;
      const through = (this.db.prepare('SELECT coalesce(max(sequence),0) AS n FROM detail_entries WHERE turn_key=?').get(detailTurnKey(identity)) as { n: number }).n;
      this.saveTurn({ ...turn, incomplete: true, redactionGapThrough: Math.max(turn.redactionGapThrough ?? 0, through) });
    }).immediate();
  }

  hasStreamGap(identity: DetailTurnIdentity, entryId?: string): boolean {
    const through = this.getTurn(identity)?.redactionGapThrough;
    if (through === undefined) return false;
    if (!entryId) return true;
    const entry = this.db.prepare('SELECT sequence FROM detail_entries WHERE turn_key=? AND entry_id=?').get(detailTurnKey(identity), entryId) as { sequence: number } | undefined;
    return entry !== undefined && entry.sequence <= through;
  }

  bodyBudget(identity: DetailTurnIdentity, entryId: string): number {
    const turn = this.getTurn(identity);
    if (!turn || turn.availability !== 'available') return 0;
    if (this.db.prepare('SELECT 1 FROM detail_resource_registry WHERE turn_key=? AND reserved_bytes<0 LIMIT 1').get(detailTurnKey(identity))) return 0;
    const prior = this.getEntry(identity, entryId);
    const held = prior?.resource ? (this.db.prepare('SELECT held_bytes FROM detail_resource_registry WHERE resource_id=?').get(prior.resource.resourceId) as { held_bytes: number } | undefined)?.held_bytes ?? 0 : 0;
    // Keep headroom for entry metadata and event indexes before any file write.
    return Math.max(0, this.limitBytes - this.viewReserve - turn.retainedBytes + (prior?.resource?.committedBytes ?? 0) + held - 2048);
  }

  replaceFileEntries(identity: DetailTurnIdentity, entries: DetailEntry[], eventKey: string): boolean {
    const rejected = new Error('Detail snapshot quota exceeded');
    try {
      return this.db.transaction(() => {
        if (this.hasEvent(identity, eventKey)) return false;
        const key = detailTurnKey(identity);
        const turn = this.getTurn(identity);
        if (!turn || turn.availability !== 'available' || turn.lifecycle !== 'running') throw new Error('Detail turn unavailable');
        const old = this.db.prepare("SELECT resource_id,retained_bytes FROM detail_entries WHERE turn_key=? AND json_extract(payload,'$.category')='files'")
          .all(key) as Array<{ resource_id: string | null; retained_bytes: number }>;
        let released = 0;
        for (const row of old) {
          if (!row.resource_id) { released += row.retained_bytes; continue; }
          // Transfer the entire old entry bill to its immutable retired resource. Nothing is refunded yet.
          this.retireIndexedResource(key, row.resource_id, row.retained_bytes);
        }
        this.db.prepare("DELETE FROM detail_entries WHERE turn_key=? AND json_extract(payload,'$.category')='files'").run(key);
        this.saveTurn({ ...turn, retainedBytes: turn.retainedBytes - released });
        for (const entry of entries) if (!this.putEntry(identity, entry, `${eventKey}:${entry.entryId}`)) throw rejected;
        const updated = this.getTurn(identity)!;
        const eventBytes = Buffer.byteLength(eventKey) + 128;
        if (!eventKey || Buffer.byteLength(eventKey) > 256 || updated.retainedBytes + eventBytes > this.limitBytes - this.viewReserve) throw rejected;
        this.db.prepare('INSERT INTO detail_events(turn_key,event_key,retained_bytes) VALUES(?,?,?)').run(key, eventKey, eventBytes);
        this.saveTurn({ ...updated, retainedBytes: updated.retainedBytes + eventBytes });
        return true;
      }).immediate();
    } catch (error) {
      if (error !== rejected) throw error;
      this.markTruncated(identity);
      return false;
    }
  }

  putEntry(identity: DetailTurnIdentity, entry: DetailEntry, eventKey: string): boolean {
    return this.db.transaction(() => {
      const key = detailTurnKey(identity);
      const turn = this.getTurn(identity);
      if (!turn || turn.availability !== 'available' || turn.lifecycle !== 'running') throw new Error('Detail turn unavailable');
      if (Buffer.byteLength(eventKey) > 256 || !eventKey) throw new Error('Invalid detail event identity');
      if (this.db.prepare('SELECT 1 FROM detail_events WHERE turn_key=? AND event_key=?').get(key, eventKey)) return false;
      const prior = this.db.prepare('SELECT retained_bytes,resource_id FROM detail_entries WHERE turn_key=? AND entry_id=?')
        .get(key, entry.entryId) as { retained_bytes: number; resource_id: string | null } | undefined;
      let held = 0;
      if (entry.resource) {
        this.registerResource(entry.resource.resourceId, key);
        if (!this.reserveResource(identity, entry.resource.resourceId, entry.resource.committedBytes)) return false;
        const charge = this.db.prepare('SELECT * FROM detail_resource_registry WHERE resource_id=?').get(entry.resource.resourceId) as ResourceCharge;
        if (charge.retired || charge.reserved_bytes < entry.resource.committedBytes) throw new Error('Unconfirmed resource boundary');
        // A metadata-only update must not refund an outstanding, still-physical uncommitted tail.
        held = charge.held_bytes - Math.max(0, charge.reserved_bytes - entry.resource.committedBytes);
        if (held < 0) throw new Error('Invalid resource transfer');
      }
      const payload = JSON.stringify(entry);
      if (Buffer.byteLength(payload) > 8192 || (entry.resource && (!Number.isSafeInteger(entry.resource.committedBytes)
        || entry.resource.committedBytes < 0 || !/^[a-f0-9]{32}$/.test(entry.resource.resourceId)))) throw new Error('Invalid detail entry');
      const entryBytes = Buffer.byteLength(payload) + (entry.resource?.committedBytes ?? 0) + 128;
      const eventBytes = Buffer.byteLength(eventKey) + 128;
      const currentTurn = this.getTurn(identity)!;
      const replacingResource = prior?.resource_id && prior.resource_id !== entry.resource?.resourceId;
      const retainedBytes = currentTurn.retainedBytes - (replacingResource ? 0 : prior?.retained_bytes ?? 0) - held + entryBytes + eventBytes;
      const count = this.db.prepare('SELECT count(*) AS n FROM detail_entries WHERE turn_key=?').get(key) as { n: number };
      const events = this.db.prepare('SELECT count(*) AS n FROM detail_events WHERE turn_key=?').get(key) as { n: number };
      if (retainedBytes > this.limitBytes - this.viewReserve || (!prior && count.n >= this.maxEntries) || events.n >= 32768) {
        this.saveTurn({ ...currentTurn, truncated: true });
        return false;
      }
      if (replacingResource) this.retireIndexedResource(key, prior.resource_id!, prior.retained_bytes);
      this.db.prepare(`INSERT INTO detail_entries(turn_key,entry_id,resource_id,payload,retained_bytes) VALUES(?,?,?,?,?)
        ON CONFLICT(turn_key,entry_id) DO UPDATE SET resource_id=excluded.resource_id,payload=excluded.payload,retained_bytes=excluded.retained_bytes`)
        .run(key, entry.entryId, entry.resource?.resourceId ?? null, payload, entryBytes);
      if (entry.resource) this.db.prepare('UPDATE detail_resource_registry SET held_bytes=held_bytes-? WHERE resource_id=?').run(held, entry.resource.resourceId);
      this.db.prepare('INSERT INTO detail_events(turn_key,event_key,retained_bytes) VALUES(?,?,?)').run(key, eventKey, eventBytes);
      this.saveTurn({ ...currentTurn, retainedBytes });
      return true;
    }).immediate();
  }

  listEntries(identity: DetailTurnIdentity, afterEntryId?: string, limit = 100): DetailEntry[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid detail page size');
    const key = detailTurnKey(identity);
    let after = 0;
    if (afterEntryId) {
      const row = this.db.prepare('SELECT sequence FROM detail_entries WHERE turn_key=? AND entry_id=?').get(key, afterEntryId) as { sequence: number } | undefined;
      if (!row) throw new Error('Detail cursor entry missing');
      after = row.sequence;
    }
    return (this.db.prepare('SELECT payload FROM detail_entries WHERE turn_key=? AND sequence>? ORDER BY sequence LIMIT ?')
      .all(key, after, limit) as Array<{ payload: string }>).map((row) => JSON.parse(row.payload) as DetailEntry);
  }

  completeTurn(identity: DetailTurnIdentity, lifecycle: 'completed' | 'failed' | 'interrupted', endedAt: string): void {
    if (!Number.isFinite(Date.parse(endedAt))) throw new Error('Invalid detail terminal time');
    this.db.transaction(() => {
      const turn = this.getTurn(identity);
      if (turn && turn.lifecycle === 'running') this.saveTurn({ ...turn, lifecycle, endedAt });
    }).immediate();
  }

  categorySequence(identity: DetailTurnIdentity, category: DetailCategory): number {
    return (this.db.prepare("SELECT coalesce(max(sequence),0) AS n FROM detail_entries WHERE turn_key=? AND json_extract(payload,'$.category')=?")
      .get(detailTurnKey(identity), category) as { n: number }).n;
  }

  categoryTail(identity: DetailTurnIdentity, category: DetailCategory, limit: number): { total: number; entries: DetailEntry[] } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5) throw new Error('invalid_limit');
    const key = detailTurnKey(identity);
    const total = (this.db.prepare("SELECT count(*) AS n FROM detail_entries WHERE turn_key=? AND json_extract(payload,'$.category')=?")
      .get(key, category) as { n: number }).n;
    const rows = this.db.prepare("SELECT payload FROM detail_entries WHERE turn_key=? AND json_extract(payload,'$.category')=? ORDER BY sequence DESC LIMIT ?")
      .all(key, category, limit) as Array<{ payload: string }>;
    return { total, entries: rows.reverse().map((row) => JSON.parse(row.payload) as DetailEntry) };
  }

  /** Global first-observation order, not three independently truncated category tails. */
  timelineTail(identity: DetailTurnIdentity, limit: number): { total: number; entries: DetailEntry[] } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_INLINE_TIMELINE_ITEMS) throw new Error('invalid_limit');
    const key = detailTurnKey(identity);
    const total = (this.db.prepare('SELECT count(*) AS n FROM detail_entries WHERE turn_key=?').get(key) as { n: number }).n;
    const rows = this.db.prepare('SELECT payload FROM detail_entries WHERE turn_key=? ORDER BY sequence DESC LIMIT ?')
      .all(key, limit) as Array<{ payload: string }>;
    return { total, entries: rows.reverse().map((row) => JSON.parse(row.payload) as DetailEntry) };
  }

  categoryPage(identity: DetailTurnIdentity, category: DetailCategory, after: number, through: number, limit: number): Array<{ entry: DetailEntry; sequence: number }> {
    if (![after, through, limit].every(Number.isSafeInteger) || after < 0 || through < 0 || limit < 1 || limit > 20) throw new Error('invalid_cursor');
    return (this.db.prepare("SELECT sequence,payload FROM detail_entries WHERE turn_key=? AND json_extract(payload,'$.category')=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?")
      .all(detailTurnKey(identity), category, after, through, limit) as Array<{ sequence: number; payload: string }>).map((row) => ({ sequence: row.sequence, entry: JSON.parse(row.payload) as DetailEntry }));
  }

  close(): void { this.db.close(); }

  claimWriter(identity: DetailTurnIdentity, owner: string): void {
    this.db.transaction(() => claimRecordingWriter(this.db, detailTurnKey(identity), owner)).immediate();
  }
  releaseWriter(identity: DetailTurnIdentity, owner: string): void {
    this.db.prepare('DELETE FROM detail_recording_writers WHERE turn_key=? AND owner=?').run(detailTurnKey(identity), owner);
  }
  releaseWriters(owner: string): void { this.db.prepare('DELETE FROM detail_recording_writers WHERE owner=?').run(owner); }

  registerResource(id: string, ownerKey?: string): void {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid detail resource id');
    const accepted = this.db.transaction(() => {
      const prior = this.db.prepare('SELECT * FROM detail_resource_registry WHERE resource_id=?').get(id) as ResourceCharge | undefined;
      if (prior) {
        if (ownerKey && prior.turn_key !== ownerKey) throw new Error('Detail resource ownership mismatch');
        if (prior.retired) throw new Error('Resource retired');
        return true;
      }
      const allocation = 256 + Buffer.byteLength(ownerKey ?? '');
      if (ownerKey) {
        const row = this.db.prepare('SELECT payload FROM detail_turns WHERE turn_key=?').get(ownerKey) as { payload: string } | undefined;
        if (!row) throw new Error('Unknown resource owner');
        const turn = JSON.parse(row.payload) as DetailTurnRecord;
        if (turn.lifecycle !== 'running' || turn.availability !== 'available') throw new Error('Detail turn unavailable');
        if (turn.retainedBytes + allocation > this.limitBytes - this.viewReserve
          || this.db.prepare('SELECT 1 FROM detail_resource_registry WHERE turn_key=? AND reserved_bytes<0 LIMIT 1').get(ownerKey)) {
          this.saveTurn({ ...turn, truncated: true }); return false;
        }
        this.saveTurn({ ...turn, retainedBytes: turn.retainedBytes + allocation });
      }
      this.db.prepare(`INSERT INTO detail_resource_registry(resource_id,turn_key,created_at,reserved_bytes,held_bytes,allocation_bytes)
        VALUES(?,?,?,0,?,?)`).run(id, ownerKey ?? null, new Date().toISOString(), ownerKey ? allocation : 0, allocation);
      return true;
    }).immediate();
    if (!accepted) throw new Error('Resource allocation quota exceeded');
  }

  reserveResource(identity: DetailTurnIdentity, id: string, bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid resource reservation');
    return this.db.transaction(() => {
      const turn = this.getTurn(identity), row = this.db.prepare('SELECT * FROM detail_resource_registry WHERE resource_id=?').get(id) as ResourceCharge | undefined;
      if (!turn || turn.lifecycle !== 'running' || turn.availability !== 'available' || !row || row.turn_key !== detailTurnKey(identity) || row.retired || row.reserved_bytes < 0) return false;
      if (this.db.prepare('SELECT 1 FROM detail_resource_registry WHERE turn_key=? AND reserved_bytes<0 LIMIT 1').get(detailTurnKey(identity))) return false;
      const entry = this.db.prepare('SELECT payload FROM detail_entries WHERE resource_id=?').get(id) as { payload: string } | undefined;
      const base = entry ? (JSON.parse(entry.payload) as DetailEntry).resource?.committedBytes ?? 0 : 0;
      const hold = Math.max(row.held_bytes, entry ? Math.max(0, bytes - base) : row.allocation_bytes + bytes);
      if (turn.retainedBytes + hold - row.held_bytes > this.limitBytes - this.viewReserve) {
        this.saveTurn({ ...turn, truncated: true }); return false;
      }
      changeResourceHold(this.db, id, hold, Math.max(bytes, row.reserved_bytes)); return true;
    }).immediate();
  }

  confirmResourceSize(identity: DetailTurnIdentity, id: string, bytes: number): void {
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM detail_resource_registry WHERE resource_id=?').get(id) as ResourceCharge | undefined;
      if (!row || row.turn_key !== detailTurnKey(identity) || row.retired || bytes < 0 || bytes > row.reserved_bytes) throw new Error('Invalid resource confirmation');
      const entry = this.db.prepare('SELECT payload FROM detail_entries WHERE resource_id=?').get(id) as { payload: string } | undefined;
      const base = entry ? (JSON.parse(entry.payload) as DetailEntry).resource?.committedBytes ?? 0 : 0;
      if (bytes < base) throw new Error('Resource shrank below committed index');
      changeResourceHold(this.db, id, entry ? bytes - base : row.allocation_bytes + bytes, bytes);
    }).immediate();
  }

  retireResource(identity: DetailTurnIdentity, id: string): void {
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM detail_resource_registry WHERE resource_id=?').get(id) as ResourceCharge | undefined;
      if (!row || row.turn_key !== detailTurnKey(identity)) throw new Error('Unknown resource owner');
      if (this.db.prepare('SELECT 1 FROM detail_entries WHERE resource_id=?').get(id)) throw new Error('Resource still referenced');
      this.db.prepare('UPDATE detail_resource_registry SET retired=1 WHERE resource_id=?').run(id);
      this.db.prepare('INSERT OR IGNORE INTO detail_resource_deletions(resource_id,turn_key) VALUES(?,?)').run(id, row.turn_key);
    }).immediate();
  }

  forgetResource(id: string): void { this.db.transaction(() => forgetResourceCharge(this.db, id)).immediate(); }

  private retireIndexedResource(key: string, id: string, bill: number): void {
    const charge = this.db.prepare('SELECT turn_key FROM detail_resource_registry WHERE resource_id=?').get(id) as { turn_key: string } | undefined;
    if (charge?.turn_key !== key) throw new Error('Missing resource charge');
    this.db.prepare('UPDATE detail_resource_registry SET held_bytes=held_bytes+?,retired=1 WHERE resource_id=?').run(bill, id);
    this.db.prepare('INSERT OR IGNORE INTO detail_resource_deletions(resource_id,turn_key) VALUES(?,?)').run(id, key);
  }

  private saveTurn(turn: DetailTurnRecord): void {
    if (Buffer.byteLength(JSON.stringify(turn)) > TURN_INDEX_BUDGET) throw new Error('Detail turn index exceeds budget');
    this.db.prepare('UPDATE detail_turns SET payload=?,ended_at=?,availability=?,retained_bytes=? WHERE turn_key=?')
      .run(JSON.stringify(turn), turn.endedAt ?? null, turn.availability, turn.retainedBytes, detailTurnKey(turn));
  }
}
