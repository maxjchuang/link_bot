import type Database from 'better-sqlite3';

export interface ResourceCharge { turn_key: string | null; reserved_bytes: number; held_bytes: number; retired: number; allocation_bytes: number }

export function changeResourceHold(db: Database.Database, id: string, hold: number, reserved: number): void {
  const row = db.prepare('SELECT * FROM detail_resource_registry WHERE resource_id=?').get(id) as ResourceCharge | undefined;
  if (!row || !Number.isSafeInteger(hold) || hold < 0 || !Number.isSafeInteger(reserved) || reserved < 0) throw new Error('Invalid resource charge');
  if (row.turn_key) {
    const turn = db.prepare('SELECT payload,retained_bytes FROM detail_turns WHERE turn_key=?').get(row.turn_key) as { payload: string; retained_bytes: number } | undefined;
    if (turn) {
      const next = turn.retained_bytes + hold - row.held_bytes;
      if (next < 4096) throw new Error('Invalid resource refund');
      db.prepare('UPDATE detail_turns SET retained_bytes=?,payload=? WHERE turn_key=?')
        .run(next, JSON.stringify({ ...JSON.parse(turn.payload), retainedBytes: next }), row.turn_key);
    }
  }
  db.prepare('UPDATE detail_resource_registry SET held_bytes=?,reserved_bytes=? WHERE resource_id=?').run(hold, reserved, id);
}

/** Caller has already unlinked + synced, or verified ENOENT. Never refund a referenced resource here. */
export function forgetResourceCharge(db: Database.Database, id: string): void {
  if (db.prepare('SELECT 1 FROM detail_entries WHERE resource_id=?').get(id)) throw new Error('Resource still referenced');
  const row = db.prepare('SELECT * FROM detail_resource_registry WHERE resource_id=?').get(id) as ResourceCharge | undefined;
  if (row) changeResourceHold(db, id, 0, Math.max(0, row.reserved_bytes));
  db.prepare('DELETE FROM detail_resource_registry WHERE resource_id=?').run(id);
  db.prepare('DELETE FROM detail_resource_deletions WHERE resource_id=?').run(id);
}
