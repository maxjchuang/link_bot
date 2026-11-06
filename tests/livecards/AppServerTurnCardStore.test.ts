import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SqliteAppServerTurnCardStore, newAppServerCardRecord } from '../../src/livecards/AppServerTurnCardStore.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('SqliteAppServerTurnCardStore', () => {
  it('versions new records and accepts legacy records without rewriting their start time', async () => {
    const store = new SqliteAppServerTurnCardStore(join(await createTmpDir(), 'state.sqlite'));
    try {
      const record = newAppServerCardRecord({ ownerKind: 'host_manager', taskId: 'host', localTurnId: 'turn',
        target: { chatId: 'user' }, now: '2026-10-13T01:00:00.000Z' });
      expect(record.schemaVersion).toBe(2);
      store.save(record);
      expect(store.get(record.id)?.startedAt).toBe(record.startedAt);
      const { schemaVersion: _version, ...legacy } = record;
      store.save(legacy);
      expect(store.get(record.id)?.schemaVersion).toBeUndefined();
      expect(store.get(record.id)?.startedAt).toBe(record.startedAt);
    } finally { store.close(); }
  });
  it('filters closed card payloads in SQLite before parsing them in Node', async () => {
    const store = new SqliteAppServerTurnCardStore(join(await createTmpDir(), 'state.sqlite'));
    const now = '2026-09-30T00:00:00.000Z';
    const input = { ownerKind: 'task_platform' as const, taskId: 'task_1', projectId: 'repo',
      target: { chatId: 'oc_1' }, now };
    const closed = newAppServerCardRecord({ ...input, localTurnId: 'closed' });
    store.save({ ...closed, state: 'finalized', lastError: 'x'.repeat(250_000) });
    const open = newAppServerCardRecord({ ...input, localTurnId: 'open' });
    store.save({ ...open, state: 'live' });
    const other = newAppServerCardRecord({ ...input, ownerKind: 'host_manager', localTurnId: 'other' });
    store.save({ ...other, state: 'live' });

    const originalParse = JSON.parse;
    const parse = vi.spyOn(JSON, 'parse').mockImplementation((value, reviver) => {
      if (value.length > 100_000) throw new Error('Closed card crossed into V8');
      return originalParse(value, reviver);
    });
    try {
      expect(store.listOpen('task_platform').map((record) => record.id)).toEqual([open.id]);
      expect(store.listOpen().map((record) => record.id)).toEqual([open.id, other.id]);
    } finally {
      parse.mockRestore();
      store.close();
    }
  });
});
