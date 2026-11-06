import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createTmpDir } from '../helpers/tmp.js';
import { createTurnDetailRuntime } from '../../src/details/TurnDetailRuntime.js';
import { TurnDetailRecorder } from '../../src/details/TurnDetailRecorder.js';
import { AsyncTurnDetailRecorder } from '../../src/details/AsyncTurnDetailRecorder.js';
import type { Worker } from 'node:worker_threads';
import { SqliteStateStore } from '../../src/state/SqliteStateStore.js';

const identity = { ownerKind: 'task_platform' as const, taskId: 'task', localTurnId: 'turn' };
async function fixture() {
  const path = join(await createTmpDir(), 'state.sqlite'), runtime = createTurnDetailRuntime(path), db = new Database(path);
  runtime.sink.accepted({ ...identity, userId: 'owner', target: { chatId: 'private' } }); runtime.sink.bind('task', 'thread', 'remote');
  return { path, runtime, db };
}
describe('cross-process recording ownership', () => {
  it('prevents a second owner from writing and rejects non-owner release', async () => {
    const f = await fixture();
    try {
      f.runtime.store!.claimWriter(identity, 'first'); f.runtime.store!.claimWriter(identity, 'first');
      expect(() => f.runtime.store!.claimWriter(identity, 'second')).toThrow('detail_writer_busy');
      f.runtime.store!.releaseWriter(identity, 'second');
      expect(() => f.runtime.store!.claimWriter(identity, 'second')).toThrow('detail_writer_busy');
      f.runtime.store!.releaseWriter(identity, 'first');
      expect(() => f.runtime.store!.claimWriter(identity, 'second')).not.toThrow();
      f.runtime.store!.releaseWriter(identity, 'second');
    } finally { await f.runtime.close(); f.db.close(); }
  });
  it('never truncates a live owner tail even if an external source already made the turn terminal', async () => {
    const f = await fixture();
    const recorder = new TurnDetailRecorder(f.runtime.store!, f.runtime.resources!);
    try {
      f.runtime.store!.claimWriter(identity, 'owner');
      recorder.record(identity, { kind: 'process_delta', itemId: 'p', source: 'progress', text: 'safe\n' }, 'safe', new Date().toISOString());
      const resource = f.runtime.store!.listEntries(identity)[0]!.resource!;
      f.runtime.store!.reserveResource(identity, resource.resourceId, resource.committedBytes + 4);
      f.runtime.resources!.append(resource.resourceId, resource.committedBytes, 'tail');
      f.runtime.store!.completeTurn(identity, 'completed', new Date().toISOString());
      f.runtime.maintain();
      expect(f.runtime.resources!.size(resource.resourceId)).toBe(resource.committedBytes + 4);
      f.runtime.store!.releaseWriter(identity, 'owner'); f.runtime.maintain(); f.runtime.maintain();
      expect(f.runtime.resources!.size(resource.resourceId)).toBe(resource.committedBytes);
    } finally { await f.runtime.close(); f.db.close(); }
  });
  it.skipIf(process.platform !== 'linux')('marks a dead owner stream gap before a replacement writer can continue', async () => {
    const f = await fixture();
    try {
      f.runtime.store!.claimWriter(identity, 'old');
      const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
      await once(child, 'exit');
      f.db.prepare('UPDATE detail_recording_writers SET pid=?').run(child.pid);
      f.runtime.store!.claimWriter(identity, 'new');
      expect(f.runtime.store!.hasStreamGap(identity)).toBe(true);
      expect(f.runtime.store!.getTurn(identity)?.incomplete).toBe(true);
      f.runtime.store!.releaseWriter(identity, 'new');
    } finally { await f.runtime.close(); f.db.close(); }
  });
  it('does not infer death from a foreign host or PID namespace', async () => {
    const f = await fixture();
    try {
      f.runtime.store!.claimWriter(identity, 'foreign');
      f.db.prepare("UPDATE detail_recording_writers SET process_scope='foreign-namespace',pid=2147483647").run();
      f.runtime.maintain();
      expect(() => f.runtime.store!.claimWriter(identity, 'new')).toThrow('detail_writer_busy');
      expect(f.runtime.store!.hasStreamGap(identity)).toBe(false);
      f.runtime.store!.releaseWriter(identity, 'foreign');
    } finally { await f.runtime.close(); f.db.close(); }
  });
  it('acquires the guard before asynchronous recording and releases it only after terminal acknowledgement', async () => {
    const f = await fixture();
    try {
      f.runtime.sink.event({ type: 'item.delta', taskId: 'task', threadId: 'thread', turnId: 'remote', itemId: 'p', channel: 'agent_message', delta: 'safe\n' }, 'safe');
      expect(() => f.runtime.store!.claimWriter(identity, 'other')).toThrow('detail_writer_busy');
      await f.runtime.flush();
      expect(() => f.runtime.store!.claimWriter(identity, 'other')).toThrow('detail_writer_busy');
      f.runtime.sink.finish('task', 'turn', 'completed'); await f.runtime.flush();
      expect(f.db.prepare('SELECT count(*) AS n FROM detail_recording_writers').get()).toEqual({ n: 0 });
    } finally { await f.runtime.close(); f.db.close(); }
  });
  it('terminates a failed worker before releasing ownership, without replaying it', async () => {
    const f = await fixture(), recorder = new AsyncTurnDetailRecorder(f.path, f.runtime.store!);
    try {
      recorder.record(identity, { kind: 'process_delta', itemId: 'p', source: 'progress', text: 'safe\n' }, 'warmup', new Date().toISOString());
      await recorder.flush();
      const worker = (recorder as unknown as { worker: Worker }).worker;
      const exited = once(worker, 'exit');
      worker.postMessage({ sequence: 999, payload: 'injected malformed internal packet' });
      await exited;
      expect(f.runtime.store!.hasStreamGap(identity)).toBe(true);
      expect(f.db.prepare('SELECT count(*) AS n FROM detail_recording_writers').get()).toEqual({ n: 0 });
      expect(() => recorder.record(identity, { kind: 'terminal', lifecycle: 'completed' }, 'retry', new Date().toISOString())).toThrow('detail_queue_unavailable');
    } finally { await recorder.close(); await f.runtime.close(); f.db.close(); }
  });
  it('expires read access from authoritative terminal facts without deleting a protected writer body', async () => {
    const f = await fixture(), core = new SqliteStateStore(f.path);
    try {
      const old = '2020-01-01T00:00:00Z';
      core.saveTask({ id: 'task', ownerUserId: 'owner', projectId: 'fixture', baseRef: 'main', branchName: 'fixture', runtimeState: 'warm',
        pinned: false, createdAt: old, updatedAt: old, lastUserInteractionAt: old });
      core.saveTurn({ id: 'turn', taskId: 'task', state: 'completed', prompt: '', createdBy: 'owner', createdAt: old, updatedAt: old, completedAt: old });
      f.runtime.store!.claimWriter(identity, 'protected');
      new TurnDetailRecorder(f.runtime.store!, f.runtime.resources!).record(identity,
        { kind: 'process_delta', itemId: 'p', source: 'progress', text: 'safe\n' }, 'body', new Date().toISOString());
      const ref = f.runtime.store!.listEntries(identity)[0]!.resource!;
      f.runtime.maintain();
      expect(f.runtime.store!.getTurn(identity)?.availability).toBe('expired');
      expect(f.runtime.resources!.size(ref.resourceId)).toBe(ref.committedBytes);
      f.runtime.store!.releaseWriter(identity, 'protected'); f.runtime.maintain();
      expect(f.runtime.store!.getTurn(identity)?.availability).toBe('cleared');
    } finally { core.close(); await f.runtime.close(); f.db.close(); }
  });
});
