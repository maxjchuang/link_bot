import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { createTmpDir } from '../helpers/tmp.js';
import { createTurnDetailRuntime } from '../../src/details/TurnDetailRuntime.js';
import { AsyncTurnDetailRecorder } from '../../src/details/AsyncTurnDetailRecorder.js';
import { AppServerTurnDetailSink } from '../../src/details/AppServerTurnDetailSink.js';

const identity = { ownerKind: 'task_platform' as const, taskId: 'task', localTurnId: 'local' };
const accepted = { ...identity, userId: 'owner', target: { chatId: 'private' } };
const stamp = '2026-10-15T00:00:00Z';

describe('bounded recording worker', () => {
  it('queues without synchronous resource writes and drains ordered redacted output before shutdown', async () => {
    const path = join(await createTmpDir(), 'state.sqlite');
    const runtime = createTurnDetailRuntime(path);
    runtime.sink.accepted(accepted); runtime.sink.bind('task', 'thread', 'remote');
    const delta = { type: 'item.delta' as const, taskId: 'task', threadId: 'thread', turnId: 'remote',
      itemId: 'progress', channel: 'agent_message' as const };
    runtime.sink.event({ ...delta, delta: 'safe\ntoken=' }, 'one');
    runtime.sink.event({ ...delta, delta: 'fake-worker-secret\nlast line\n' }, 'two');
    expect(runtime.store!.listEntries(identity)).toHaveLength(0);
    runtime.sink.event({ type: 'turn.completed', taskId: 'task', threadId: 'thread', turnId: 'remote',
      status: 'completed', turn: {} }, 'terminal');
    await runtime.flush();
    try {
      expect(runtime.store!.getTurn(identity)?.lifecycle).toBe('completed');
      const resource = runtime.store!.listEntries(identity)[0]!.resource!;
      const body = runtime.resources!.read(resource.resourceId, resource.committedBytes, 0, 1000);
      expect(body).toContain('safe'); expect(body).toContain('last line');
      expect(body).not.toContain('fake-worker-secret');
    } finally { await runtime.close(); }
  });

  it('fails closed on queue overflow without replaying dropped events or resuming a secret continuation', async () => {
    const path = join(await createTmpDir(), 'state.sqlite');
    const runtime = createTurnDetailRuntime(path);
    const recorder = new AsyncTurnDetailRecorder(path, runtime.store!, 4096, 1);
    const sink = new AppServerTurnDetailSink(runtime.store, recorder);
    sink.accepted(accepted); sink.bind('task', 'thread', 'remote');
    const delta = { type: 'item.delta' as const, taskId: 'task', threadId: 'thread', turnId: 'remote',
      itemId: 'progress', channel: 'agent_message' as const };
    try {
      sink.event({ ...delta, delta: 'token=' }, 'one');
      expect(sink.event({ ...delta, delta: 'fake-overflow-secret' }, 'two')).toMatchObject({ detailUnavailable: true });
      await recorder.flush();
      expect(sink.event({ ...delta, delta: 'fake-continuation-secret\n' }, 'three')).toMatchObject({ detailUnavailable: true });
      expect(runtime.store!.getTurn(identity)?.incomplete).toBe(true);
      expect(runtime.store!.hasStreamGap(identity)).toBe(true);
      const stored = JSON.stringify(runtime.store!.listEntries(identity));
      expect(stored).not.toContain('fake-overflow-secret');
      expect(stored).not.toContain('fake-continuation-secret');
    } finally { await recorder.close(); await runtime.close(); }
  });

  it('bounds single snapshots before worker allocation', async () => {
    const path = join(await createTmpDir(), 'state.sqlite');
    const runtime = createTurnDetailRuntime(path);
    const recorder = new AsyncTurnDetailRecorder(path, runtime.store!, 1024);
    try {
      expect(() => recorder.record(identity, { kind: 'diff_snapshot', text: 'x'.repeat(2048) }, 'large', stamp)).toThrow('detail_queue_limit');
      expect(recorder.busy).toBe(false);
    } finally { await recorder.close(); await runtime.close(); }
  });

  it('marks acknowledged active streams unsafe when the worker dies and never silently restarts it', async () => {
    const path = join(await createTmpDir(), 'state.sqlite');
    const runtime = createTurnDetailRuntime(path);
    runtime.sink.accepted(accepted); runtime.sink.bind('task', 'thread', 'remote');
    const recorder = new AsyncTurnDetailRecorder(path, runtime.store!);
    try {
      recorder.record(identity, { kind: 'process_delta', itemId: 'p', source: 'progress', text: 'token=' }, 'one', stamp);
      await recorder.flush();
      const worker = (recorder as unknown as { worker: Worker }).worker;
      await worker.terminate();
      expect(runtime.store!.getTurn(identity)?.incomplete).toBe(true);
      expect(runtime.store!.hasStreamGap(identity)).toBe(true);
      expect(() => recorder.record(identity, { kind: 'process_delta', itemId: 'p', source: 'progress', text: 'secret\n' }, 'two', stamp))
        .toThrow('detail_queue_unavailable');
      await expect(recorder.flush()).rejects.toThrow('detail_worker_unavailable');
      await recorder.close();
      const replacement = new AsyncTurnDetailRecorder(path, runtime.store!);
      try {
        replacement.record(identity, { kind: 'process_delta', itemId: 'p', source: 'progress', text: 'fake-crash-secret\nfresh line\n' }, 'after-restart', stamp);
        await replacement.flush();
        const resource = runtime.store!.listEntries(identity)[0]!.resource!;
        const text = runtime.resources!.read(resource.resourceId, resource.committedBytes, 0, 1000);
        expect(text).not.toContain('fake-crash-secret');
        expect(text).toContain('[敏感内容已隐藏]'); // Unknown old-stream continuation stays conservatively hidden.
      } finally { await replacement.close(); }
    } finally { await recorder.close(); await runtime.close(); }
  });

  it('does not turn worker initialization failure into an execution error or raw fallback', async () => {
    const root = await createTmpDir();
    const runtime = createTurnDetailRuntime(join(root, 'state.sqlite'));
    runtime.sink.accepted(accepted); runtime.sink.bind('task', 'thread', 'remote');
    const recorder = new AsyncTurnDetailRecorder(join(root, 'missing', 'state.sqlite'), runtime.store!);
    try {
      expect(() => recorder.record(identity, { kind: 'process_delta', itemId: 'p', source: 'progress', text: 'fake-private-body' }, 'one', stamp)).not.toThrow();
      await expect(recorder.flush()).rejects.toThrow('detail_worker_unavailable');
      expect(runtime.store!.getTurn(identity)?.incomplete).toBe(true);
      expect(runtime.store!.listEntries(identity)).toHaveLength(0);
    } finally { await recorder.close(); await runtime.close(); }
  });
});
