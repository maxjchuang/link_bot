import { join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { createTmpDir } from '../helpers/tmp.js';
import { SqliteTurnDetailStore } from '../../src/details/SqliteTurnDetailStore.js';
import { DetailResourceStore } from '../../src/details/DetailResourceStore.js';
import { TurnDetailRecorder } from '../../src/details/TurnDetailRecorder.js';
import { TurnDetailMaintenance } from '../../src/details/TurnDetailMaintenance.js';
import Database from 'better-sqlite3';

describe('physical detail quota under deletion failure', () => {
  it('does not expose a credential continuation after quota frees up and the recorder restarts', async () => {
    const root = await createTmpDir(), path = join(root, 'state.sqlite'), dir = join(root, 'resources');
    let store = new SqliteTurnDetailStore(path, { limitBytes: 65536 });
    const files = new DetailResourceStore(dir, { allocated: (id, owner) => store.registerResource(id, owner), removed: (id) => store.forgetResource(id) });
    const identity = { ownerKind: 'task_platform' as const, taskId: 'task', localTurnId: 'turn' }, now = new Date().toISOString();
    store.createTurn({ ...identity, threadId: 'thread', schemaVersion: 1, scope: { kind: 'private_user', chatId: 'chat', userId: 'owner' },
      lifecycle: 'running', availability: 'available', startedAt: now, retainedBytes: 0, truncated: false });
    let recorder = new TurnDetailRecorder(store, files);
    recorder.record(identity, { kind: 'command_item', itemId: 'cmd', command: 'pwd', completed: false }, 'cmd', now);
    const padding = files.create(JSON.stringify([identity.ownerKind, identity.taskId, identity.localTurnId]));
    const bytes = 65536 - store.getTurn(identity)!.retainedBytes - 100;
    store.reserveResource(identity, padding, bytes); files.append(padding, 0, 'x'.repeat(bytes));
    store.retireResource(identity, padding);
    expect(recorder.record(identity, { kind: 'command_delta', itemId: 'cmd', stream: 'combined', text: 'token=' }, 'prefix', now)).toBe(false);
    store.close(); store = new SqliteTurnDetailStore(path, { limitBytes: 65536 }); recorder = new TurnDetailRecorder(store, files);
    const maintenance = new TurnDetailMaintenance(path, files);
    try {
      expect(maintenance.run().removed).toBe(1);
      recorder.record(identity, { kind: 'command_delta', itemId: 'cmd', stream: 'combined', text: 'fake-gap-secret\n' }, 'continuation', now);
      const old = store.listEntries(identity).find((entry) => entry.itemId === 'cmd')!;
      expect(old.missing).toBe(true);
      expect(files.read(old.resource!.resourceId, old.resource!.committedBytes, 0, 100)).not.toContain('fake-gap-secret');
      recorder.record(identity, { kind: 'command_item', itemId: 'fresh', command: 'pwd', completed: false }, 'fresh', now);
      recorder.record(identity, { kind: 'command_delta', itemId: 'fresh', stream: 'combined', text: 'visible output\n' }, 'fresh-output', now);
      const fresh = store.listEntries(identity).find((entry) => entry.itemId === 'fresh')!;
      expect(files.read(fresh.resource!.resourceId, fresh.resource!.committedBytes, 0, 100)).toContain('visible output');
    } finally { maintenance.close(); store.close(); }
  });
  it('does not refund an uncommitted tail on metadata updates or resource replacement', async () => {
    const root = await createTmpDir(), path = join(root, 'state.sqlite'), dir = join(root, 'resources');
    const store = new SqliteTurnDetailStore(path, { limitBytes: 65536 }), db = new Database(path);
    const files = new DetailResourceStore(dir, { allocated: (id, owner) => store.registerResource(id, owner), removed: (id) => store.forgetResource(id) });
    const identity = { ownerKind: 'task_platform' as const, taskId: 'task', localTurnId: 'turn' };
    store.createTurn({ ...identity, threadId: 'thread', schemaVersion: 1, scope: { kind: 'private_user', chatId: 'chat', userId: 'owner' },
      lifecycle: 'running', availability: 'available', startedAt: new Date().toISOString(), retainedBytes: 0, truncated: false });
    const recorder = new TurnDetailRecorder(store, files), maintenance = new TurnDetailMaintenance(path, files);
    recorder.record(identity, { kind: 'command_item', itemId: 'cmd', command: 'pwd', completed: false }, 'cmd', new Date().toISOString());
    recorder.record(identity, { kind: 'command_delta', itemId: 'cmd', stream: 'combined', text: 'body\n' }, 'body', new Date().toISOString());
    const entry = store.listEntries(identity)[0]!, old = entry.resource!;
    try {
      expect(store.reserveResource(identity, old.resourceId, old.committedBytes + 4)).toBe(true);
      files.append(old.resourceId, old.committedBytes, 'tail'); // Crash window: bytes written, index not advanced.
      expect(store.putEntry(identity, { ...entry, metadata: { ...entry.metadata, status: 'failed' } }, 'metadata')).toBe(true);
      expect(db.prepare('SELECT held_bytes FROM detail_resource_registry WHERE resource_id=?').get(old.resourceId)).toEqual({ held_bytes: 4 });
      const next = files.create(JSON.stringify([identity.ownerKind, identity.taskId, identity.localTurnId]));
      expect(store.reserveResource(identity, next, 5)).toBe(true);
      files.append(next, 0, 'next\n'); store.confirmResourceSize(identity, next, 5);
      expect(store.putEntry(identity, { ...entry, resource: { ...old, resourceId: next, committedBytes: 5, revision: 2 } }, 'replace')).toBe(true);
      expect(db.prepare('SELECT retired,held_bytes FROM detail_resource_registry WHERE resource_id=?').get(old.resourceId)).toMatchObject({ retired: 1, held_bytes: expect.any(Number) });
      const charged = store.getTurn(identity)!.retainedBytes;
      expect(maintenance.run().removed).toBe(1);
      expect(store.getTurn(identity)!.retainedBytes).toBeLessThan(charged);
      expect(files.read(next, 5, 0, 5)).toBe('next\n');
    } finally { maintenance.close(); db.close(); store.close(); }
  });
  it('preserves the readable snapshot and charges failed staging when index publication rolls back', async () => {
    const root = await createTmpDir(), path = join(root, 'state.sqlite'), dir = join(root, 'resources');
    const store = new SqliteTurnDetailStore(path, { limitBytes: 65536 });
    const files = new DetailResourceStore(dir, { allocated: (id, owner) => store.registerResource(id, owner), removed: (id) => store.forgetResource(id) });
    const recorder = new TurnDetailRecorder(store, files), db = new Database(path), maintenance = new TurnDetailMaintenance(path, files);
    const identity = { ownerKind: 'task_platform' as const, taskId: 'task', localTurnId: 'turn' };
    store.createTurn({ ...identity, threadId: 'thread', schemaVersion: 1, scope: { kind: 'private_user', chatId: 'chat', userId: 'owner' },
      lifecycle: 'running', availability: 'available', startedAt: new Date().toISOString(), retainedBytes: 0, truncated: false });
    const diff = (text: string) => `diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -0,0 +1 @@\n+${text}\n`;
    recorder.record(identity, { kind: 'diff_snapshot', text: diff('readable') }, 'first', new Date().toISOString());
    const current = store.listEntries(identity)[0]!.resource!, before = store.getTurn(identity)!.retainedBytes;
    const original = files.remove.bind(files), remove = vi.spyOn(files, 'remove').mockImplementation(() => { throw new Error('unlink failed'); });
    try {
      db.exec(`CREATE TRIGGER fail_snapshot_publish BEFORE INSERT ON detail_entries BEGIN SELECT RAISE(ABORT,'injected index failure'); END;`);
      expect(recorder.record(identity, { kind: 'diff_snapshot', text: diff('staged') }, 'failed', new Date().toISOString())).toBe(false);
      expect(store.listEntries(identity)[0]!.resource!.resourceId).toBe(current.resourceId);
      expect(store.getTurn(identity)!.retainedBytes).toBeGreaterThan(before);
      expect(await readdir(dir)).toHaveLength(2);
      db.exec('DROP TRIGGER fail_snapshot_publish'); remove.mockImplementation(original);
      expect(maintenance.run().removed).toBe(1);
      expect(files.read(current.resourceId, current.committedBytes, 0, 200)).toContain('readable');
      expect(store.getTurn(identity)!.retainedBytes).toBe(before);
    } finally { maintenance.close(); db.close(); store.close(); }
  });
  it('retains charges across unlink/commit failure and restart, then refunds exactly once', async () => {
    const root = await createTmpDir(), path = join(root, 'state.sqlite'), dir = join(root, 'resources');
    let store = new SqliteTurnDetailStore(path, { limitBytes: 65536 });
    const files = new DetailResourceStore(dir, { allocated: (id, owner) => store.registerResource(id, owner), removed: (id) => store.forgetResource(id) });
    const recorder = new TurnDetailRecorder(store, files), db = new Database(path);
    const identity = { ownerKind: 'host_manager' as const, taskId: 'host', localTurnId: 'turn' };
    store.createTurn({ ...identity, threadId: 'thread', schemaVersion: 1, scope: { kind: 'private_user', chatId: 'chat', userId: 'owner' },
      lifecycle: 'running', availability: 'available', startedAt: new Date().toISOString(), retainedBytes: 0, truncated: false });
    const original = files.remove.bind(files);
    const remove = vi.spyOn(files, 'remove').mockImplementation(() => { throw new Error('unlink failure'); });
    for (let index = 0; index < 2; index++) recorder.record(identity, { kind: 'diff_snapshot', text:
      `diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -0,0 +1 @@\n+version ${index}\n` }, `diff-${index}`, new Date().toISOString());
    const active = store.listEntries(identity)[0]!.resource!;
    const charged = store.getTurn(identity)!.retainedBytes;
    remove.mockImplementation(original);
    let maintenance = new TurnDetailMaintenance(path, files);
    try {
      db.exec(`CREATE TRIGGER fail_retired_refund BEFORE DELETE ON detail_resource_deletions BEGIN SELECT RAISE(ABORT,'injected commit failure'); END;`);
      expect(maintenance.run().failed).toBe(1);
      expect(store.getTurn(identity)!.retainedBytes).toBe(charged);
      expect(await readdir(dir)).toEqual([active.resourceId]);
      db.exec('DROP TRIGGER fail_retired_refund');
      maintenance.close(); store.close(); store = new SqliteTurnDetailStore(path, { limitBytes: 65536 });
      maintenance = new TurnDetailMaintenance(path, files);
      expect(maintenance.run().removed).toBe(1);
      const refunded = store.getTurn(identity)!.retainedBytes;
      expect(refunded).toBeLessThan(charged);
      expect(maintenance.run().removed).toBe(0);
      expect(store.getTurn(identity)!.retainedBytes).toBe(refunded);
      expect(files.read(active.resourceId, active.committedBytes, 0, 100)).toContain('version 1');
      expect(() => store.retireResource(identity, active.resourceId)).toThrow('still referenced');
    } finally { maintenance.close(); store.close(); db.close(); }
  });
  it('measures migrated orphan debt before allowing new writes, without guessing an active allocation is retired', async () => {
    const root = await createTmpDir(), path = join(root, 'state.sqlite'), dir = join(root, 'resources');
    let store = new SqliteTurnDetailStore(path, { limitBytes: 65536 });
    const files = new DetailResourceStore(dir, { allocated: (id, owner) => store.registerResource(id, owner), removed: (id) => store.forgetResource(id) });
    const identity = { ownerKind: 'task_platform' as const, taskId: 'old-task', localTurnId: 'turn' };
    store.createTurn({ ...identity, threadId: 'thread', schemaVersion: 1, scope: { kind: 'private_user', chatId: 'chat', userId: 'owner' },
      lifecycle: 'running', availability: 'available', startedAt: new Date().toISOString(), retainedBytes: 0, truncated: false });
    const orphan = files.create(JSON.stringify([identity.ownerKind, identity.taskId, identity.localTurnId]));
    files.append(orphan, 0, 'x'.repeat(50000)); // Fixture for an old, unaccounted allocation; not a new recording write.
    store.close();
    const db = new Database(path);
    db.exec(`DROP INDEX detail_resource_registry_retired;
      ALTER TABLE detail_resource_registry DROP COLUMN retired;
      ALTER TABLE detail_resource_registry DROP COLUMN reserved_bytes;
      ALTER TABLE detail_resource_registry DROP COLUMN held_bytes;
      ALTER TABLE detail_resource_registry DROP COLUMN allocation_bytes;
      UPDATE detail_turns SET retained_bytes=4096,payload=json_set(payload,'$.retainedBytes',4096);
      PRAGMA user_version=29;`);
    store = new SqliteTurnDetailStore(path, { limitBytes: 65536 });
    const maintenance = new TurnDetailMaintenance(path, files);
    try {
      expect(store.bodyBudget(identity, '')).toBe(0);
      maintenance.run();
      expect(store.getTurn(identity)!.retainedBytes).toBeGreaterThanOrEqual(50000);
      expect(store.bodyBudget(identity, '')).toBeLessThan(15000);
      expect(maintenance.run().removed).toBe(0);
      expect(files.size(orphan)).toBe(50000);
      expect(store.reserveResource(identity, orphan, 65536)).toBe(false);
    } finally { maintenance.close(); db.close(); store.close(); }
  });
  it('keeps retired snapshots charged, stops growth, and retries only retired resources while running', async () => {
    const root = await createTmpDir(), path = join(root, 'state.sqlite'), dir = join(root, 'resources');
    const store = new SqliteTurnDetailStore(path, { limitBytes: 65536 });
    const files = new DetailResourceStore(dir, { allocated: (id, owner) => store.registerResource(id, owner), removed: (id) => store.forgetResource(id) });
    const recorder = new TurnDetailRecorder(store, files), maintenance = new TurnDetailMaintenance(path, files);
    const identity = { ownerKind: 'task_platform' as const, taskId: 'fixture', localTurnId: 'turn' };
    const now = new Date().toISOString();
    store.createTurn({ ...identity, threadId: 'thread', schemaVersion: 1, scope: { kind: 'private_user', chatId: 'chat', userId: 'owner' },
      lifecycle: 'running', availability: 'available', startedAt: now, retainedBytes: 0, truncated: false });
    const originalRemove = files.remove.bind(files);
    const remove = vi.spyOn(files, 'remove').mockImplementation(() => { throw new Error('injected unlink failure'); });
    const write = (index: number) => recorder.record(identity, { kind: 'diff_snapshot', text:
      `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1,900 @@\n${Array.from({ length: 900 }, (_, line) => `+safe-${index}-${line}\n`).join('')}` }, `snapshot-${index}`, now);
    const physical = async () => {
      let bytes = 0; for (const id of await readdir(dir)) bytes += (await stat(join(dir, id))).size;
      return bytes;
    };
    try {
      for (let index = 0; index < 24; index++) write(index);
      expect(await physical()).toBeLessThanOrEqual(65536);
      expect(store.getTurn(identity)!.retainedBytes).toBeGreaterThanOrEqual(await physical());
      expect(store.getTurn(identity)!.truncated).toBe(true);
      const active = store.listEntries(identity)[0]!.resource!;
      const charged = store.getTurn(identity)!.retainedBytes;
      expect(maintenance.run().removed).toBe(0);
      expect(store.getTurn(identity)!.retainedBytes).toBe(charged);
      remove.mockImplementation(originalRemove);
      expect(maintenance.run().removed).toBeGreaterThan(0);
      expect(store.getTurn(identity)!.lifecycle).toBe('running');
      expect(store.getEntry(identity, store.listEntries(identity)[0]!.entryId)!.resource!.resourceId).toBe(active.resourceId);
      expect(files.read(active.resourceId, active.committedBytes, 0, 100)).toContain('diff --git');
      expect(store.getTurn(identity)!.retainedBytes).toBeLessThan(charged);
      expect(write(100)).toBe(true);
      expect(await physical()).toBeLessThanOrEqual(65536);
    } finally { maintenance.close(); store.close(); }
  });
});
