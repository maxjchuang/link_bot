import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SqliteTurnDetailStore } from '../../src/details/SqliteTurnDetailStore.js';
import { DetailResourceStore } from '../../src/details/DetailResourceStore.js';
import { TurnDetailRecorder } from '../../src/details/TurnDetailRecorder.js';
import type { DetailCandidate, DetailTurnRecord } from '../../src/details/TurnDetailTypes.js';
import { createTmpDir } from '../helpers/tmp.js';

const turn: DetailTurnRecord = { schemaVersion: 1, ownerKind: 'host_manager', taskId: 'host', localTurnId: 'local',
  threadId: 'thread', codexTurnId: 'turn', scope: { kind: 'private_user', chatId: 'chat', userId: 'user' },
  startedAt: '2026-10-13T00:00:00.000Z', lifecycle: 'running', availability: 'available', retainedBytes: 0, truncated: false };

async function harness(limitBytes?: number) {
  const root = await createTmpDir();
  const store = new SqliteTurnDetailStore(join(root, 'state.sqlite'), { limitBytes });
  const files = new DetailResourceStore(join(root, 'details'));
  store.createTurn(turn);
  let recorder = new TurnDetailRecorder(store, files);
  let sequence = 0;
  return { store, files, restart() { recorder = new TurnDetailRecorder(store, files); },
    record(event: DetailCandidate, key = `event-${++sequence}`) { return recorder.record(turn, event, key, turn.startedAt); } };
}

describe('detail recorder', () => {
  it('uses completion-only aggregate output without duplicating streamed output and labels missing output', async () => {
    const h = await harness();
    try {
      h.record({ kind: 'command_item', itemId: 'fallback', completed: true, command: 'pwd', aggregatedOutput: 'complete output' });
      const read = (itemId: string) => {
        const entry = h.store.listEntries(turn).find((entry) => entry.itemId === itemId)!;
        return h.files.read(entry.resource!.resourceId, entry.resource!.committedBytes, 0, 1000);
      };
      expect(read('fallback')).toBe('complete output');
      h.record({ kind: 'command_item', itemId: 'streamed', completed: false, command: 'pwd' });
      h.record({ kind: 'command_delta', itemId: 'streamed', stream: 'combined', text: 'once' });
      h.record({ kind: 'command_item', itemId: 'streamed', completed: true, command: 'pwd', aggregatedOutput: 'once' });
      expect(read('streamed')).toBe('once');
      h.record({ kind: 'command_item', itemId: 'missing', completed: true, command: 'pwd' });
      expect(h.store.listEntries(turn).find((entry) => entry.itemId === 'missing')!.missing).toBe(true);
    } finally { h.store.close(); }
  });

  it('completes public summary parts independently without recording internal content', async () => {
    const h = await harness();
    try {
      h.record({ kind: 'process_delta', itemId: 'reason', source: 'summary', partIndex: 0, text: 'first' });
      h.record({ kind: 'process_item', itemId: 'reason', completed: true,
        segments: [{ source: 'summary', partIndex: 0, text: 'first' }, { source: 'summary', partIndex: 1, text: 'second' }] });
      const entries = h.store.listEntries(turn);
      expect(entries).toHaveLength(2);
      expect(entries.map((entry) => entry.metadata.completed)).toEqual([true, true]);
      expect(entries.map((entry) => h.files.read(entry.resource!.resourceId, entry.resource!.committedBytes, 0, 100))).toEqual(['first', 'second']);
    } finally { h.store.close(); }
  });
  it('isolates commands, keeps repeated text, and replays recorded event identities idempotently', async () => {
    const h = await harness();
    try {
      h.record({ kind: 'command_item', itemId: 'a', completed: false, command: 'pwd' });
      h.record({ kind: 'command_item', itemId: 'b', completed: false, command: 'npm test' });
      h.record({ kind: 'command_delta', itemId: 'a', stream: 'combined', text: 'same\n' }, 'once');
      h.record({ kind: 'command_delta', itemId: 'b', stream: 'combined', text: 'other\n' });
      h.record({ kind: 'command_delta', itemId: 'a', stream: 'combined', text: 'same\n' });
      expect(h.record({ kind: 'command_delta', itemId: 'a', stream: 'combined', text: 'same\n' }, 'once')).toBe(false);
      const entries = h.store.listEntries(turn);
      const a = entries.find((entry) => entry.itemId === 'a')!.resource!;
      expect(h.files.read(a.resourceId, a.committedBytes, 0, 100)).toBe('same\nsame\n');
      expect(entries.find((entry) => entry.itemId === 'a')!.metadata.outputStream).toBe('combined');
    } finally { h.store.close(); }
  });

  it('does not leak incomplete credential lines after a recorder restart', async () => {
    const h = await harness();
    try {
      h.record({ kind: 'command_item', itemId: 'a', completed: false, command: 'npm test' });
      h.record({ kind: 'command_delta', itemId: 'a', stream: 'combined', text: 'API_KEY=fake-' });
      h.restart();
      h.record({ kind: 'command_delta', itemId: 'a', stream: 'combined', text: 'test-secret\nsafe\n' });
      const entry = h.store.listEntries(turn)[0];
      expect(h.files.read(entry.resource!.resourceId, entry.resource!.committedBytes, 0, 100)).not.toContain('test-secret');
      expect(entry.missing).toBe(true);
      h.record({ kind: 'command_item', itemId: 'sensitive', completed: false, command: 'cat .env' });
      h.record({ kind: 'command_delta', itemId: 'sensitive', stream: 'combined', text: 'fake-test-secret\n' });
      expect(JSON.stringify(h.store.listEntries(turn))).not.toContain('fake-test-secret');
      h.record({ kind: 'command_item', itemId: 'multiline', completed: false, command: 'npm test' });
      h.record({ kind: 'command_delta', itemId: 'multiline', stream: 'combined', text: '"refresh_to' });
      h.restart();
      h.record({ kind: 'command_delta', itemId: 'multiline', stream: 'combined', text: 'ken":\n"fake-test-secret"\n' });
      const multiline = h.store.listEntries(turn).find((entry) => entry.itemId === 'multiline')!.resource!;
      expect(h.files.read(multiline.resourceId, multiline.committedBytes, 0, 100)).not.toContain('fake-test-secret');
    } finally { h.store.close(); }
  });

  it('replaces cumulative Diff and records safe per-file snapshots', async () => {
    const h = await harness();
    try {
      const prefix = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n';
      h.record({ kind: 'diff_snapshot', text: prefix + '@@ -1 +1 @@\n-old\n+new\n' });
      h.record({ kind: 'diff_snapshot', text: prefix + '@@ -1 +1,2 @@\n-old\n+new\n+next\n' });
      const entries = h.store.listEntries(turn);
      expect(entries).toHaveLength(1);
      expect(entries[0].metadata).toMatchObject({ path: 'a', added: 2, removed: 1, complete: true });
      const resource = entries[0].resource!;
      const body = h.files.read(resource.resourceId, resource.committedBytes, 0, 1000);
      expect(body.match(/diff --git/g)).toHaveLength(1);
      expect(body).toContain('+next');
      expect(h.record({ kind: 'diff_snapshot', text: prefix + '@@ -1 +1,2 @@\n-old\n+new\n+next\n' }, 'event-2')).toBe(false);
      // A later snapshot no longer includes a.ts; stale file records must disappear.
      h.record({ kind: 'diff_snapshot', text: 'diff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-old\n+new\n' });
      expect(h.store.listEntries(turn)).toHaveLength(1);
      expect(h.store.listEntries(turn)[0].metadata.path).toBe('b');
    } finally { h.store.close(); }
  });

  it('separates streams when actually reported and freezes terminal details', async () => {
    const h = await harness();
    try {
      h.record({ kind: 'command_item', itemId: 'a', completed: false, command: 'npm test' });
      h.record({ kind: 'command_delta', itemId: 'a', stream: 'stdout', text: 'normal\n' });
      h.record({ kind: 'command_delta', itemId: 'a', stream: 'stderr', text: 'error\n' });
      const outputs = h.store.listEntries(turn).filter((entry) => entry.resource);
      expect(outputs.map((entry) => entry.metadata.outputStream).sort()).toEqual(['stderr', 'stdout']);
      expect(h.files.read(outputs[0].resource!.resourceId, outputs[0].resource!.committedBytes, 0, 100)).toBe('normal\n');
      h.record({ kind: 'terminal', lifecycle: 'completed' });
      expect(h.record({ kind: 'command_delta', itemId: 'a', stream: 'stdout', text: 'late\n' })).toBe(false);
    } finally { h.store.close(); }
  });

  it('bounds storage after quota rejection and isolates persistence failures from execution', async () => {
    const h = await harness(6000);
    try {
      h.record({ kind: 'command_item', itemId: 'a', completed: false, command: 'npm test' });
      expect(h.record({ kind: 'command_delta', itemId: 'a', stream: 'combined', text: ('line\n').repeat(1000) })).toBe(false);
      expect(h.store.getTurn(turn)!.retainedBytes).toBeLessThanOrEqual(6000);
      expect(h.store.getTurn(turn)!.truncated).toBe(true);
      const failure = vi.spyOn(h.store, 'putEntry').mockImplementationOnce(() => { throw new Error('disk failed'); });
      expect(() => h.record({ kind: 'command_item', itemId: 'b', completed: false, command: 'pwd' })).not.toThrow();
      failure.mockRestore();
      expect(h.store.getTurn(turn)!.incomplete).toBe(true);
    } finally { h.store.close(); }
  });
});
