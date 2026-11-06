import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTmpDir } from '../helpers/tmp.js';
import { createTurnDetailRuntime } from '../../src/details/TurnDetailRuntime.js';
import { TurnDetailMaintenance } from '../../src/details/TurnDetailMaintenance.js';
import { TurnDetailRecorder } from '../../src/details/TurnDetailRecorder.js';
import { lstat, truncate, writeFile, readFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { detailTurnKey } from '../../src/details/DetailEventAdapter.js';
import { newAppServerCardRecord, SqliteAppServerTurnCardStore } from '../../src/livecards/AppServerTurnCardStore.js';
import { SqliteStateStore } from '../../src/state/SqliteStateStore.js';
import { TurnDetailService } from '../../src/details/TurnDetailService.js';
import { DetailAccessPolicy } from '../../src/details/DetailAccessPolicy.js';

describe('detail maintenance', () => {
  it('survives unlink followed by failed index commit and resumes the same tombstone', async () => {
    const path = join(await createTmpDir(), 'state.sqlite'), now = new Date();
    const runtime = createTurnDetailRuntime(path, () => now), db = new Database(path);
    const identity = { ownerKind: 'host_manager' as const, taskId: 'host', localTurnId: 'turn' };
    runtime.store!.createTurn({ ...identity, scope: { kind: 'private_user', chatId: 'chat', userId: 'owner' }, threadId: 'thread', schemaVersion: 1,
      startedAt: now.toISOString(), lifecycle: 'running', availability: 'available', retainedBytes: 0, truncated: false });
    new TurnDetailRecorder(runtime.store!, runtime.resources!).record(identity,
      { kind: 'process_delta', itemId: 'item', source: 'progress', text: 'safe body\n' }, 'body', now.toISOString());
    const entry = runtime.store!.listEntries(identity)[0]!;
    runtime.store!.completeTurn(identity, 'completed', '2020-01-01T00:00:00Z');
    try {
      db.exec(`CREATE TRIGGER fail_cleanup_commit BEFORE DELETE ON detail_resource_deletions BEGIN SELECT RAISE(ABORT,'test commit failure'); END;`);
      expect(runtime.maintenance!.run().failed).toBe(1);
      expect(runtime.store!.getTurn(identity)!.availability).toBe('expired');
      expect(() => runtime.resources!.read(entry.resource!.resourceId, entry.resource!.committedBytes, 0, 10)).toThrow();
      db.exec('DROP TRIGGER fail_cleanup_commit');
      expect(runtime.maintenance!.run().removed).toBe(1);
      expect(runtime.store!.getTurn(identity)!.availability).toBe('cleared');
    } finally { db.close(); runtime.close(); }
  });
  it('rechecks availability after asynchronous access checks and refuses a concurrently expired read', async () => {
    const path = join(await createTmpDir(), 'state.sqlite'), now = new Date();
    const runtime = createTurnDetailRuntime(path, () => now), db = new Database(path);
    const identity = { ownerKind: 'host_manager' as const, taskId: 'host', localTurnId: 'turn' };
    runtime.store!.createTurn({ ...identity, scope: { kind: 'private_user', chatId: 'chat', userId: 'owner' }, threadId: 'thread', schemaVersion: 1,
      startedAt: now.toISOString(), lifecycle: 'running', availability: 'available', retainedBytes: 0, truncated: false });
    new TurnDetailRecorder(runtime.store!, runtime.resources!).record(identity,
      { kind: 'process_delta', itemId: 'item', source: 'progress', text: 'safe body\n' }, 'body', now.toISOString());
    const entry = runtime.store!.listEntries(identity)[0]!;
    const policy = new DetailAccessPolicy({ resolveSource: async () => {
      const turn = runtime.store!.getTurn(identity)!;
      db.prepare("UPDATE detail_turns SET availability='expired',payload=? WHERE turn_key=?").run(JSON.stringify({ ...turn, availability: 'expired' }), detailTurnKey(identity));
      return { chatId: 'chat', chatType: 'private' };
    }, isGroupMember: async () => false, canReadTopic: async () => false });
    const service = new TurnDetailService(runtime.store!, runtime.resources!, policy, () => now);
    const read = vi.spyOn(runtime.resources!, 'readBytes');
    try {
      await expect(service.requireRead(identity, { userId: 'owner', sourceMessageId: 'source' })).rejects.toThrow('expired');
      await expect(service.readEntry(identity, entry.entryId, { userId: 'owner', sourceMessageId: 'source' })).rejects.toThrow('expired');
      expect(read).not.toHaveBeenCalled();
    } finally { db.close(); runtime.close(); }
  });
  it('uses authoritative task termination, keeps generation changes harmless and clears only explicit deletion archives', async () => {
    const path = join(await createTmpDir(), 'state.sqlite'), now = new Date();
    const runtime = createTurnDetailRuntime(path, () => now), core = new SqliteStateStore(path);
    const identity = { ownerKind: 'task_platform' as const, taskId: 'task', localTurnId: 'turn' };
    const scope = { kind: 'private_user' as const, chatId: 'chat', userId: 'owner' };
    core.saveTask({ id: 'task', ownerUserId: 'owner', projectId: 'repo', baseRef: 'main', branchName: 'branch', runtimeState: 'hot',
      connectionGeneration: 20, pinned: false, lastUserInteractionAt: now.toISOString(), createdAt: now.toISOString(), updatedAt: now.toISOString() });
    core.saveTurn({ id: 'turn', taskId: 'task', state: 'running', prompt: '', createdBy: 'owner', createdAt: '2020-01-01T00:00:00Z', updatedAt: now.toISOString() });
    runtime.store!.createTurn({ ...identity, scope, threadId: 'old-thread', schemaVersion: 1, startedAt: '2020-01-01T00:00:00Z',
      lifecycle: 'running', availability: 'available', retainedBytes: 0, truncated: false });
    try {
      runtime.maintenance!.run(); expect(runtime.store!.getTurn(identity)!.lifecycle).toBe('running');
      core.updateTurn('turn', (turn) => ({ ...turn, state: 'completed', completedAt: now.toISOString() }));
      runtime.maintenance!.run(); expect(runtime.store!.getTurn(identity)).toMatchObject({ lifecycle: 'completed', availability: 'available', endedAt: now.toISOString() });
      runtime.results!.save(identity, scope, 'public result', now.toISOString());
      core.updateTask('task', (task) => ({ ...task, runtimeState: 'archived', archiveReason: 'warm_retention_expired' }));
      runtime.maintenance!.run(); expect(runtime.store!.getTurn(identity)!.availability).toBe('available');
      core.updateTask('task', (task) => ({ ...task, archiveReason: 'explicit' }));
      runtime.maintenance!.run(); expect(runtime.store!.getTurn(identity)!.availability).toBe('cleared');
      expect(runtime.results!.readPage(identity).text).toBe('public result');
    } finally { core.close(); runtime.close(); }
  });
  it('recovers only terminal committed boundaries and labels missing bytes instead of inventing output', async () => {
    const path = join(await createTmpDir(), 'state.sqlite');
    const now = new Date();
    const runtime = createTurnDetailRuntime(path, () => now);
    const identity = { ownerKind: 'host_manager' as const, taskId: 'host', localTurnId: 'turn' };
    runtime.store!.createTurn({ ...identity, scope: { kind: 'private_user', chatId: 'chat', userId: 'owner' }, threadId: 'thread', schemaVersion: 1,
      startedAt: now.toISOString(), lifecycle: 'running', availability: 'available', retainedBytes: 0, truncated: false });
    const recorder = new TurnDetailRecorder(runtime.store!, runtime.resources!);
    recorder.record(identity, { kind: 'process_delta', itemId: 'item', source: 'progress', text: 'committed\n' }, 'body', now.toISOString());
    const entry = runtime.store!.listEntries(identity)[0]!, resource = entry.resource!;
    const resourcePath = join(`${path}.turn-details`, resource.resourceId);
    try {
      runtime.resources!.append(resource.resourceId, resource.committedBytes, 'uncommitted tail');
      runtime.maintenance!.run(1);
      expect((await lstat(resourcePath)).size).toBeGreaterThan(resource.committedBytes);
      runtime.store!.completeTurn(identity, 'completed', now.toISOString());
      runtime.maintenance!.run(1);
      expect((await lstat(resourcePath)).size).toBe(resource.committedBytes);
      await truncate(resourcePath, 1);
      runtime.maintenance!.run(1); runtime.maintenance!.run(1);
      expect(runtime.store!.getEntry(identity, entry.entryId)).toMatchObject({ missing: true });
      expect(runtime.store!.getEntry(identity, entry.entryId)!.resource).toBeUndefined();
      expect(runtime.store!.getTurn(identity)!.incomplete).toBe(true);
      expect(() => runtime.store!.putEntry(identity, entry, 'late')).toThrow('unavailable');
    } finally { runtime.close(); }
  });
  it('removes only explicitly owned terminal orphan allocations and preserves unknown files', async () => {
    const path = join(await createTmpDir(), 'state.sqlite');
    const now = new Date();
    const runtime = createTurnDetailRuntime(path, () => now), db = new Database(path);
    const identity = { ownerKind: 'host_manager' as const, taskId: 'host', localTurnId: 'turn' };
    runtime.store!.createTurn({ ...identity, scope: { kind: 'private_user', chatId: 'chat', userId: 'owner' }, threadId: 'thread', schemaVersion: 1,
      startedAt: now.toISOString(), lifecycle: 'running', availability: 'available', retainedBytes: 0, truncated: false });
    const orphan = runtime.resources!.create(detailTurnKey(identity));
    runtime.resources!.append(orphan, 0, 'allocated but not indexed');
    db.prepare("UPDATE detail_resource_registry SET created_at='2020-01-01T00:00:00Z' WHERE resource_id=?").run(orphan);
    const unknown = join(`${path}.turn-details`, 'a'.repeat(32));
    await writeFile(unknown, 'user-owned unknown file', { mode: 0o600 });
    try {
      runtime.maintenance!.run();
      expect(runtime.resources!.read(orphan, 25, 0, 25)).toContain('allocated');
      runtime.store!.completeTurn(identity, 'completed', now.toISOString());
      expect(runtime.maintenance!.run().removed).toBe(1);
      expect(() => runtime.resources!.read(orphan, 25, 0, 25)).toThrow();
      expect(await readFile(unknown, 'utf8')).toBe('user-owned unknown file');
      expect(runtime.store!.getTurn(identity)!.availability).toBe('available');
    } finally { db.close(); runtime.close(); }
  });
  it('excludes another maintenance worker and resumes persisted deletions after restart', async () => {
    const path = join(await createTmpDir(), 'state.sqlite'), now = new Date();
    let runtime = createTurnDetailRuntime(path, () => now);
    const identity = { ownerKind: 'task_platform' as const, taskId: 'task', localTurnId: 'turn' };
    runtime.store!.createTurn({ ...identity, scope: { kind: 'private_user', chatId: 'chat', userId: 'owner' }, threadId: 'thread', schemaVersion: 1,
      startedAt: now.toISOString(), lifecycle: 'running', availability: 'available', retainedBytes: 0, truncated: false });
    new TurnDetailRecorder(runtime.store!, runtime.resources!).record(identity,
      { kind: 'process_delta', itemId: 'item', source: 'progress', text: 'safe body\n' }, 'body', now.toISOString());
    runtime.store!.completeTurn(identity, 'completed', '2020-01-01T00:00:00Z');
    const other = new TurnDetailMaintenance(path, runtime.resources!, () => now);
    const original = runtime.resources!.remove.bind(runtime.resources!);
    const remove = vi.spyOn(runtime.resources!, 'remove').mockImplementation(() => {
      expect(other.run().acquired).toBe(false);
      throw new Error('retry later');
    });
    try {
      expect(runtime.maintenance!.run().failed).toBe(1);
      expect(runtime.store!.getTurn(identity)!.availability).toBe('expired');
      remove.mockImplementation(original);
      other.close(); runtime.close(); runtime = createTurnDetailRuntime(path, () => now);
      expect(runtime.maintenance!.run().removed).toBe(1);
      expect(runtime.store!.getTurn(identity)!.availability).toBe('cleared');
    } finally { runtime.close(); }
  });
  it('reconciles Host Manager lifecycle only from a durable result and terminal delivery intent', async () => {
    const path = join(await createTmpDir(), 'state.sqlite'), now = new Date();
    const runtime = createTurnDetailRuntime(path, () => now), cards = new SqliteAppServerTurnCardStore(path);
    const identity = { ownerKind: 'host_manager' as const, taskId: 'host', localTurnId: 'turn' };
    const scope = { kind: 'private_user' as const, chatId: 'chat', userId: 'owner' };
    runtime.store!.createTurn({ ...identity, scope, threadId: 'thread', schemaVersion: 1, startedAt: '2020-01-01T00:00:00Z',
      lifecycle: 'running', availability: 'available', retainedBytes: 0, truncated: false });
    runtime.results!.save(identity, scope, 'public interruption result', now.toISOString());
    const card = newAppServerCardRecord({ ownerKind: 'host_manager', taskId: 'host', localTurnId: 'turn', target: { chatId: 'chat' }, now: now.toISOString() });
    cards.save(card);
    try {
      runtime.maintenance!.run(); expect(runtime.store!.getTurn(identity)!.lifecycle).toBe('running');
      cards.update(card.id, (current) => ({ ...current, state: 'interrupted' }));
      runtime.maintenance!.run();
      expect(runtime.store!.getTurn(identity)).toMatchObject({ lifecycle: 'interrupted', endedAt: now.toISOString(), availability: 'available', incomplete: true });
    } finally { cards.close(); runtime.close(); }
  });
  it('keeps old active turns, makes expired turns unreadable before removal, retries deletes and preserves public results', async () => {
    const path = join(await createTmpDir(), 'state.sqlite');
    const now = new Date('2026-10-14T00:00:00Z');
    const runtime = createTurnDetailRuntime(path, () => now);
    const identity = { ownerKind: 'task_platform' as const, taskId: 'task', localTurnId: 'turn' };
    const scope = { kind: 'private_user' as const, chatId: 'chat', userId: 'owner' };
    runtime.store!.createTurn({ ...identity, scope, threadId: 'thread', schemaVersion: 1, startedAt: '2020-01-01T00:00:00Z',
      lifecycle: 'running', availability: 'available', retainedBytes: 0, truncated: false });
    const recorder = new TurnDetailRecorder(runtime.store!, runtime.resources!);
    recorder.record(identity, { kind: 'process_delta', itemId: 'item', source: 'progress', text: 'safe retained text\n' }, 'event', now.toISOString());
    const entry = runtime.store!.listEntries(identity)[0]!;
    const maintenance = new TurnDetailMaintenance(path, runtime.resources!, () => now);
    try {
      maintenance.run();
      expect(runtime.store!.getTurn(identity)!.availability).toBe('available');
      runtime.results!.save(identity, scope, 'complete answer', '2026-10-01T00:00:00Z');
      runtime.store!.completeTurn(identity, 'completed', '2026-10-01T00:00:00Z');
      const original = runtime.resources!.remove.bind(runtime.resources!);
      const remove = vi.spyOn(runtime.resources!, 'remove').mockImplementationOnce(() => {
        expect(runtime.store!.getTurn(identity)!.availability).toBe('expired');
        throw new Error('temporary deletion failure');
      });
      maintenance.run();
      expect(runtime.store!.getTurn(identity)!.availability).toBe('expired');
      expect(runtime.resources!.read(entry.resource!.resourceId, entry.resource!.committedBytes, 0, 100)).toContain('safe retained');
      remove.mockImplementation(original);
      maintenance.run();
      expect(runtime.store!.getTurn(identity)!.availability).toBe('cleared');
      expect(runtime.store!.listEntries(identity)).toEqual([]);
      expect(runtime.results!.readPage(identity).text).toBe('complete answer');
      expect(() => runtime.resources!.read(entry.resource!.resourceId, entry.resource!.committedBytes, 0, 100)).toThrow();
    } finally { maintenance.close(); runtime.close(); }
  });
});
