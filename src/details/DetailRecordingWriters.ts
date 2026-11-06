import type Database from 'better-sqlite3';
import { hostname } from 'node:os';
import { readlinkSync } from 'node:fs';

interface RecordingWriter { turn_key: string; owner: string; pid: number; process_scope: string }
// PID namespaces must match before absence of a PID can prove that its threads died.
const scope = (() => { try { return `${hostname()}:${readlinkSync('/proc/self/ns/pid')}`; } catch { return ''; } })();

function provenDead(row: RecordingWriter): boolean {
  if (!scope || row.process_scope !== scope || !Number.isSafeInteger(row.pid) || row.pid <= 0) return false;
  try { process.kill(row.pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

function reap(db: Database.Database, row: RecordingWriter): boolean {
  if (!provenDead(row)) return false;
  // Lost queued fragments and sanitizer state cannot be treated as a clean continuation.
  db.prepare(`UPDATE detail_turns SET payload=json_set(payload,'$.incomplete',json('true'),'$.redactionGapThrough',
    max(coalesce(json_extract(payload,'$.redactionGapThrough'),0),
      (SELECT coalesce(max(sequence),0) FROM detail_entries WHERE turn_key=?))) WHERE turn_key=?`).run(row.turn_key, row.turn_key);
  db.prepare('DELETE FROM detail_recording_writers WHERE turn_key=? AND owner=?').run(row.turn_key, row.owner);
  return true;
}

export function claimRecordingWriter(db: Database.Database, turnKey: string, owner: string): void {
  const prior = db.prepare('SELECT * FROM detail_recording_writers WHERE turn_key=?').get(turnKey) as RecordingWriter | undefined;
  if (prior && prior.owner === owner && prior.pid === process.pid && prior.process_scope === scope) return;
  if (prior && !reap(db, prior)) throw new Error('detail_writer_busy');
  db.prepare('INSERT INTO detail_recording_writers(turn_key,owner,pid,process_scope) VALUES(?,?,?,?)').run(turnKey, owner, process.pid, scope);
}

/** Bounded round-robin scan. Live, foreign-host/namespace, EPERM and reused PIDs stay protected. */
export function reapRecordingWriters(db: Database.Database, after: number, limit: number): number {
  const rows = db.prepare('SELECT rowid AS sequence,* FROM detail_recording_writers WHERE rowid>? ORDER BY rowid LIMIT ?')
    .all(after, limit) as Array<RecordingWriter & { sequence: number }>;
  for (const row of rows) reap(db, row);
  return rows.at(-1)?.sequence ?? 0;
}
