import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { migrateSqliteSchema } from '../state/SqliteSchema.js';
import type { DetailResourceStore } from './DetailResourceStore.js';
import { TURN_DETAIL_RETENTION_MS, type DetailEntry, type DetailTurnRecord } from './TurnDetailTypes.js';
import { changeResourceHold, forgetResourceCharge, type ResourceCharge } from './TurnDetailResourceLedger.js';
import { reapRecordingWriters } from './DetailRecordingWriters.js';

interface TurnRow { turn_key: string; payload: string }

/** Bounded, fenced maintenance. Never enumerate user paths or infer termination from age/generation. */
export class TurnDetailMaintenance {
  private readonly db: Database.Database;
  private readonly owner = randomUUID();
  private writerCursor = 0;
  constructor(path: string, private readonly files: DetailResourceStore, private readonly clock: () => Date = () => new Date()) {
    this.db = new Database(path); migrateSqliteSchema(this.db);
  }

  run(limit = 16): { acquired: boolean; expired: number; removed: number; failed: number; repaired: number } {
    const report = { acquired: false, expired: 0, removed: 0, failed: 0, repaired: 0 };
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new Error('Invalid maintenance batch');
    const now = this.clock();
    if (!Number.isFinite(now.getTime())) return report;
    const stamp = now.toISOString();
    const prior = this.db.prepare('SELECT expires_at FROM detail_maintenance_lease WHERE id=1').get() as { expires_at: string } | undefined;
    if (prior && Date.parse(prior.expires_at) > now.getTime()) return report;
    let claimed: number;
    try { claimed = this.db.transaction(() => this.db.prepare(`INSERT INTO detail_maintenance_lease(id,owner,expires_at) VALUES(1,?,?)
      ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
      WHERE detail_maintenance_lease.expires_at<=?`).run(this.owner, new Date(now.getTime() + 120000).toISOString(), stamp).changes).immediate(); }
    catch { return report; }
    if (!claimed) return report;
    report.acquired = true;
    try {
      const cutoff = new Date(now.getTime() - TURN_DETAIL_RETENTION_MS).toISOString();
      // The first transaction commits unavailability before any physical removal.
      this.db.transaction(() => {
        this.requireLease();
        this.writerCursor = reapRecordingWriters(this.db, this.writerCursor, limit * 4);
        report.expired += this.expireGuardedTerminalCopies(limit, cutoff);
        this.measureUnknownResources(limit * 4);
        this.reconcile(limit);
        const deleted = this.db.prepare(`SELECT d.turn_key,d.payload,t.updated_at FROM detail_turns d JOIN tasks t ON t.id=json_extract(d.payload,'$.taskId')
          WHERE d.availability='available' AND json_extract(d.payload,'$.ownerKind')='task_platform'
          AND t.runtime_state='archived' AND json_extract(t.payload,'$.archiveReason')='explicit' LIMIT ?`)
          .all(limit) as Array<TurnRow & { updated_at: string }>;
        for (const row of deleted) {
          if (!Number.isFinite(Date.parse(row.updated_at))) continue;
          const turn = JSON.parse(row.payload) as DetailTurnRecord;
          this.saveTurn(row.turn_key, { ...turn, availability: 'expired',
            ...(turn.lifecycle === 'running' ? { lifecycle: 'interrupted' as const, endedAt: row.updated_at, incomplete: true } : {}) });
          report.expired++;
        }
        const rows = this.db.prepare(`SELECT turn_key,payload FROM detail_turns WHERE availability='available'
          AND ended_at<=? AND json_extract(payload,'$.lifecycle') IN ('completed','failed','interrupted') ORDER BY ended_at LIMIT ?`).all(cutoff, limit) as TurnRow[];
        for (const row of rows) {
          const turn = JSON.parse(row.payload) as DetailTurnRecord;
          if (!turn.endedAt || !Number.isFinite(Date.parse(turn.endedAt)) || Date.parse(turn.endedAt) > now.getTime() - TURN_DETAIL_RETENTION_MS) continue;
          this.saveTurn(row.turn_key, { ...turn, availability: 'expired' }); report.expired++;
        }
        this.db.prepare(`INSERT OR IGNORE INTO detail_resource_deletions(resource_id,turn_key)
          SELECT e.resource_id,e.turn_key FROM detail_entries e JOIN detail_turns t ON t.turn_key=e.turn_key
          WHERE t.availability IN ('expired','cleared') AND e.resource_id IS NOT NULL LIMIT ?`).run(limit * 64);
        this.db.prepare(`INSERT OR IGNORE INTO detail_resource_deletions(resource_id,turn_key)
          SELECT r.resource_id,r.turn_key FROM detail_resource_registry r JOIN detail_turns t ON t.turn_key=r.turn_key
          WHERE t.availability IN ('expired','cleared') OR (r.retired=1 AND NOT EXISTS(SELECT 1 FROM detail_entries e WHERE e.resource_id=r.resource_id))
          OR (json_extract(t.payload,'$.lifecycle') IN ('completed','failed','interrupted')
          AND r.created_at<=? AND NOT EXISTS(SELECT 1 FROM detail_entries e WHERE e.resource_id=r.resource_id)) LIMIT ?`)
          .run(new Date(now.getTime() - 3600000).toISOString(), limit * 64);
      }).immediate();
      const pending = this.db.prepare('SELECT resource_id,turn_key FROM detail_resource_deletions ORDER BY attempts,resource_id LIMIT ?').all(limit * 4) as Array<{ resource_id: string; turn_key: string }>;
      for (const item of pending) this.db.transaction(() => {
        this.requireLease();
        const turnRow = this.db.prepare('SELECT payload FROM detail_turns WHERE turn_key=?').get(item.turn_key) as { payload: string } | undefined;
        if (!turnRow) return; // Unknown ownership is never sufficient authority to unlink.
        const turn = JSON.parse(turnRow.payload) as DetailTurnRecord;
        const referenced = this.db.prepare('SELECT turn_key FROM detail_entries WHERE resource_id=?').get(item.resource_id) as { turn_key: string } | undefined;
        const charge = this.db.prepare('SELECT * FROM detail_resource_registry WHERE resource_id=?').get(item.resource_id) as ResourceCharge | undefined;
        if (this.db.prepare('SELECT 1 FROM detail_recording_writers WHERE turn_key=?').get(item.turn_key) && (!charge?.retired || referenced)) return;
        if (referenced && (referenced.turn_key !== item.turn_key || turn.availability === 'available')) return;
        if (turn.lifecycle === 'running' && (!charge?.retired || referenced)) return;
        try { this.files.remove(item.resource_id, false); }
        catch (error) {
          if ((error as { code?: string }).code !== 'ENOENT') {
            this.db.prepare('UPDATE detail_resource_deletions SET attempts=attempts+1 WHERE resource_id=?').run(item.resource_id); report.failed++; return;
          }
        }
        this.db.prepare('UPDATE detail_entries SET resource_id=NULL WHERE resource_id=? AND turn_key=?').run(item.resource_id, item.turn_key);
        forgetResourceCharge(this.db, item.resource_id); report.removed++;
      }).immediate();
      this.db.transaction(() => {
        this.requireLease();
        const rows = this.db.prepare(`SELECT turn_key,payload FROM detail_turns t WHERE availability='expired'
          AND NOT EXISTS(SELECT 1 FROM detail_resource_deletions q WHERE q.turn_key=t.turn_key)
          AND NOT EXISTS(SELECT 1 FROM detail_resource_registry r WHERE r.turn_key=t.turn_key) LIMIT ?`).all(limit) as TurnRow[];
        for (const row of rows) {
          // More resources than this batch can queue: do not clear until each indexed file was processed.
          const entries = this.db.prepare('SELECT resource_id FROM detail_entries WHERE turn_key=? AND resource_id IS NOT NULL').all(row.turn_key) as Array<{ resource_id: string }>;
          if (entries.some((entry) => this.db.prepare('SELECT 1 FROM detail_resource_registry WHERE resource_id=?').get(entry.resource_id))) continue;
          for (const table of ['detail_entries', 'detail_events', 'detail_browsers', 'detail_view_state']) this.db.prepare(`DELETE FROM ${table} WHERE turn_key=?`).run(row.turn_key);
          const { summaryTail: _tail, ...turn } = JSON.parse(row.payload) as DetailTurnRecord;
          this.saveTurn(row.turn_key, { ...turn, availability: 'cleared', retainedBytes: 4096 });
        }
        report.repaired = this.recoverBoundaries(limit);
      }).immediate();
    } catch { report.failed++; } // Never fail a business turn or resume tools due to housekeeping.
    finally { try { this.db.prepare('DELETE FROM detail_maintenance_lease WHERE id=1 AND owner=?').run(this.owner); } catch { /* The lease can expire safely. */ } }
    return report;
  }

  close(): void { this.db.close(); }
  private requireLease(): void {
    const row = this.db.prepare('SELECT owner,expires_at FROM detail_maintenance_lease WHERE id=1').get() as { owner: string; expires_at: string } | undefined;
    if (row?.owner !== this.owner || Date.parse(row.expires_at) <= this.clock().getTime()) throw new Error('Maintenance lease lost');
  }
  private saveTurn(key: string, turn: DetailTurnRecord): void {
    this.db.prepare('UPDATE detail_turns SET payload=?,availability=?,ended_at=?,retained_bytes=? WHERE turn_key=?')
      .run(JSON.stringify(turn), turn.availability, turn.endedAt ?? null, turn.retainedBytes, key);
  }
  private measureUnknownResources(limit: number): void {
    const rows = this.db.prepare('SELECT * FROM detail_resource_registry WHERE reserved_bytes<0 AND turn_key IS NOT NULL LIMIT ?')
      .all(limit) as Array<ResourceCharge & { resource_id: string }>;
    for (const row of rows) {
      let size: number;
      try { size = this.files.size(row.resource_id); }
      catch (error) { if ((error as { code?: string }).code !== 'ENOENT') continue; size = 0; }
      const indexed = this.db.prepare('SELECT payload FROM detail_entries WHERE resource_id=?').get(row.resource_id) as { payload: string } | undefined;
      const base = indexed ? (JSON.parse(indexed.payload) as DetailEntry).resource?.committedBytes ?? 0 : 0;
      changeResourceHold(this.db, row.resource_id, indexed ? Math.max(0, size - base) : row.allocation_bytes + size, size);
    }
  }
  private reconcile(limit: number): void {
    const rows = this.db.prepare(`SELECT d.turn_key,d.payload,t.payload AS core FROM detail_turns d JOIN turns t
      ON t.id=json_extract(d.payload,'$.localTurnId') AND t.task_id=json_extract(d.payload,'$.taskId')
      WHERE json_extract(d.payload,'$.ownerKind')='task_platform' AND json_extract(d.payload,'$.lifecycle')='running'
      AND NOT EXISTS(SELECT 1 FROM detail_recording_writers w WHERE w.turn_key=d.turn_key)
      AND t.state IN ('completed','failed','interrupted') LIMIT ?`).all(limit) as Array<TurnRow & { core: string }>;
    for (const row of rows) {
      const core = JSON.parse(row.core) as { state: 'completed' | 'failed' | 'interrupted'; completedAt?: string };
      if (!core.completedAt || !Number.isFinite(Date.parse(core.completedAt))) continue;
      this.saveTurn(row.turn_key, { ...JSON.parse(row.payload), lifecycle: core.state, endedAt: core.completedAt, incomplete: true });
    }
    const hosts = this.db.prepare(`SELECT d.turn_key,d.payload,c.payload AS card,r.ended_at FROM detail_turns d
      JOIN live_cards c ON c.turn_id=json_extract(d.payload,'$.localTurnId') AND c.task_id=json_extract(d.payload,'$.taskId')
      JOIN turn_results r ON r.turn_key=d.turn_key
      WHERE json_extract(d.payload,'$.ownerKind')='host_manager' AND json_extract(c.payload,'$.ownerKind')='host_manager'
      AND NOT EXISTS(SELECT 1 FROM detail_recording_writers w WHERE w.turn_key=d.turn_key)
      AND json_extract(d.payload,'$.lifecycle')='running' AND json_extract(c.payload,'$.state') IN ('finalizing','finalized','interrupted') LIMIT ?`)
      .all(limit) as Array<TurnRow & { card: string; ended_at: string }>;
    for (const row of hosts) {
      if (!Number.isFinite(Date.parse(row.ended_at))) continue;
      const card = JSON.parse(row.card) as { state: string; snapshot?: { phase?: string }; finalizationIntent?: { terminalState?: string } };
      const lifecycle = card.state === 'interrupted' || card.finalizationIntent?.terminalState === 'interrupted' ? 'interrupted'
        : card.snapshot?.phase === 'failed' ? 'failed' : 'completed';
      this.saveTurn(row.turn_key, { ...JSON.parse(row.payload), lifecycle, endedAt: row.ended_at, incomplete: true });
    }
  }
  private expireGuardedTerminalCopies(limit: number, cutoff: string): number {
    // Guarding physical writes must not extend read access beyond authoritative terminal retention.
    const rows = this.db.prepare(`SELECT d.turn_key,d.payload,json_extract(t.payload,'$.completedAt') AS ended_at
      FROM detail_turns d JOIN turns t ON t.id=json_extract(d.payload,'$.localTurnId') AND t.task_id=json_extract(d.payload,'$.taskId')
      WHERE d.availability='available' AND json_extract(d.payload,'$.ownerKind')='task_platform'
      AND t.state IN ('completed','failed','interrupted') AND json_extract(t.payload,'$.completedAt')<=?
      AND EXISTS(SELECT 1 FROM detail_recording_writers w WHERE w.turn_key=d.turn_key)
      UNION ALL SELECT d.turn_key,d.payload,r.ended_at FROM detail_turns d JOIN live_cards c
      ON c.turn_id=json_extract(d.payload,'$.localTurnId') AND c.task_id=json_extract(d.payload,'$.taskId')
      JOIN turn_results r ON r.turn_key=d.turn_key WHERE d.availability='available'
      AND json_extract(d.payload,'$.ownerKind')='host_manager' AND json_extract(c.payload,'$.ownerKind')='host_manager'
      AND json_extract(c.payload,'$.state') IN ('finalizing','finalized','interrupted') AND r.ended_at<=?
      AND EXISTS(SELECT 1 FROM detail_recording_writers w WHERE w.turn_key=d.turn_key) LIMIT ?`).all(cutoff, cutoff, limit) as Array<TurnRow & { ended_at: string }>;
    let expired = 0;
    for (const row of rows) {
      if (!Number.isFinite(Date.parse(row.ended_at)) || Date.parse(row.ended_at) > Date.parse(cutoff)) continue;
      this.saveTurn(row.turn_key, { ...JSON.parse(row.payload), availability: 'expired', endedAt: row.ended_at, incomplete: true });
      expired++;
    }
    return expired;
  }
  private recoverBoundaries(limit: number): number {
    // Never truncate an active writer's uncommitted tail. Terminal indices are immutable.
    const after = (this.db.prepare('SELECT boundary_after FROM detail_maintenance_progress WHERE id=1').get() as { boundary_after: number }).boundary_after;
    const rows = this.db.prepare(`SELECT e.sequence,e.payload,e.turn_key,t.payload AS turn FROM detail_entries e JOIN detail_turns t ON t.turn_key=e.turn_key
      WHERE t.availability='available' AND json_extract(t.payload,'$.lifecycle') IN ('completed','failed','interrupted')
      AND NOT EXISTS(SELECT 1 FROM detail_recording_writers w WHERE w.turn_key=t.turn_key)
      AND json_extract(e.payload,'$.resource') IS NOT NULL AND e.sequence>? ORDER BY e.sequence LIMIT ?`).all(after, limit) as Array<{ sequence: number; payload: string; turn_key: string; turn: string }>;
    let repaired = 0;
    for (const row of rows) {
      const entry = JSON.parse(row.payload) as DetailEntry;
      try {
        this.files.recoverBoundary(entry.resource!.resourceId, entry.resource!.committedBytes);
        changeResourceHold(this.db, entry.resource!.resourceId, 0, entry.resource!.committedBytes);
      }
      catch {
        this.db.prepare('UPDATE detail_entries SET payload=? WHERE sequence=?').run(JSON.stringify({ ...entry, resource: undefined, missing: true }), row.sequence);
        const latest = this.db.prepare('SELECT payload FROM detail_turns WHERE turn_key=?').get(row.turn_key) as { payload: string };
        this.saveTurn(row.turn_key, { ...JSON.parse(latest.payload), incomplete: true });
      }
      repaired++;
    }
    this.db.prepare('UPDATE detail_maintenance_progress SET boundary_after=? WHERE id=1').run(rows.at(-1)?.sequence ?? 0);
    return repaired;
  }
}
