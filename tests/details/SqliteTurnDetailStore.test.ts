import Database from 'better-sqlite3';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteTurnDetailStore } from '../../src/details/SqliteTurnDetailStore.js';
import { migrateSqliteSchema } from '../../src/state/SqliteSchema.js';
import type { DetailEntry, DetailTurnRecord } from '../../src/details/TurnDetailTypes.js';
import { createTmpDir } from '../helpers/tmp.js';

const record: DetailTurnRecord = { schemaVersion: 1, ownerKind: 'host_manager', taskId: 'host', localTurnId: 'local',
  threadId: 'thread', codexTurnId: 'turn', scope: { kind: 'private_user', chatId: 'chat', userId: 'user' },
  startedAt: '2026-10-13T00:00:00.000Z', lifecycle: 'running', availability: 'available', retainedBytes: 0, truncated: false };
const entry: DetailEntry = { entryId: 'entry', category: 'commands', itemId: 'cmd', receivedAt: record.startedAt,
  metadata: { command: 'pwd' }, resource: { resourceId: 'a'.repeat(32), committedBytes: 4, revision: 1, redacted: false, truncated: false } };

describe('SQLite detail store', () => {
  it('shares the migrated WAL database without requiring a Task Platform task row', async () => {
    const path = join(await createTmpDir(), 'state.sqlite');
    const db = new Database(path);
    migrateSqliteSchema(db);
    db.close();
    const store = new SqliteTurnDetailStore(path);
    const other = new SqliteTurnDetailStore(path);
    try {
      expect(store.createTurn(record).retainedBytes).toBeGreaterThan(0);
      expect(store.putEntry(record, entry, 'event-1')).toBe(true);
      expect(other.getTurn(record)?.scope).toEqual(record.scope);
      const before = store.getTurn(record)?.retainedBytes;
      expect(other.putEntry(record, { ...entry, metadata: { command: 'changed' } }, 'event-1')).toBe(false);
      expect(store.getTurn(record)?.retainedBytes).toBe(before);
      expect(store.listEntries(record)[0]).toEqual(entry);
      expect(store.getTurn({ ...record, ownerKind: 'task_platform' })).toBeUndefined();
    } finally { store.close(); other.close(); }
  });

  it('replaces entry snapshots rather than summing cumulative output and enforces quota', async () => {
    const store = new SqliteTurnDetailStore(join(await createTmpDir(), 'state.sqlite'), { limitBytes: 6000, maxEntries: 2 });
    try {
      store.createTurn(record);
      expect(store.putEntry(record, entry, 'event-1')).toBe(true);
      const before = store.getTurn(record)!.retainedBytes;
      expect(store.putEntry(record, { ...entry, resource: { ...entry.resource!, committedBytes: 8, revision: 2 } }, 'event-2')).toBe(true);
      // New event identity is counted too, but the old body is replaced rather than accumulated.
      expect(store.getTurn(record)!.retainedBytes - before).toBe(4 + Buffer.byteLength('event-2') + 128);
      expect(store.putEntry(record, { ...entry, entryId: 'too-large', resource: { ...entry.resource!, committedBytes: 6000 } }, 'event-3')).toBe(false);
      expect(store.getTurn(record)!.truncated).toBe(true);
      expect(store.getTurn(record)!.retainedBytes).toBeLessThanOrEqual(6000);
      expect(store.listEntries(record)).toHaveLength(1);
      store.completeTurn(record, 'completed', '2026-10-14T00:00:00.000Z');
      store.completeTurn(record, 'failed', '2026-10-15T00:00:00.000Z');
      expect(store.getTurn(record)!.endedAt).toBe('2026-10-14T00:00:00.000Z');
    } finally { store.close(); }
  });
});
