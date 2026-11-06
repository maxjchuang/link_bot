import { join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { createTmpDir } from '../helpers/tmp.js';
import { createTurnDetailRuntime } from '../../src/details/TurnDetailRuntime.js';
import { FeishuTurnDetailController } from '../../src/details/FeishuTurnDetailController.js';
import type { FeishuGateway } from '../../src/feishu/FeishuGateway.js';
import { SqliteTurnDetailStore } from '../../src/details/SqliteTurnDetailStore.js';
import { DetailResourceStore } from '../../src/details/DetailResourceStore.js';
import { TurnDetailRecorder } from '../../src/details/TurnDetailRecorder.js';

describe('detail safety integration', () => {
  it.each(['task_platform', 'host_manager'] as const)('preserves %s results, redaction and authorized reads across restart and expiry', async (ownerKind) => {
    const path = join(await createTmpDir(), 'state.sqlite');
    let now = new Date('2026-10-14T00:00:00Z');
    let runtime = createTurnDetailRuntime(path, () => now);
    const identity = { ownerKind, taskId: 'task', localTurnId: 'local' };
    runtime.sink.accepted({ ...identity, userId: 'owner', target: { chatId: 'private' } });
    runtime.sink.bind('task', 'thread', 'remote');
    const journal = runtime.sink.event({ type: 'item.delta', taskId: 'task', threadId: 'thread', turnId: 'remote',
      itemId: 'progress', channel: 'agent_message', delta: 'safe progress\ntoken=fake-integration-secret\n' }, 'progress');
    runtime.sink.event({ type: 'item.delta', taskId: 'task', threadId: 'thread', turnId: 'remote', itemId: 'raw',
      channel: 'reasoning', reasoningSource: 'internal_reasoning', delta: 'raw-private-reasoning' }, 'raw');
    runtime.sink.event({ type: 'turn.completed', taskId: 'task', threadId: 'thread', turnId: 'remote', status: 'completed',
      turn: { items: [{ type: 'agentMessage', text: 'complete public answer\ntoken=fake-final-secret' }] } }, 'terminal');
    const cardRef = runtime.views!.registerCard(identity);
    expect(JSON.stringify(journal)).not.toContain('fake-integration-secret');
    await runtime.close(); runtime = createTurnDetailRuntime(path, () => now);
    const replace = vi.fn(async (_id: string, _card: Record<string, unknown>) => undefined);
    const gateway = { resolveDetailMessageScope: async () => ({ chatId: 'private', chatType: 'private' }),
      isDetailReaderMember: async () => false, sendOperationCardToTarget: async () => ({ messageId: 'browser' }), replaceDetailMessageCard: replace } as unknown as FeishuGateway;
    const controller = new FeishuTurnDetailController(runtime.store!, runtime.resources!, runtime.views!, gateway, () => now, runtime.results, undefined, runtime.telemetry, runtime.audit);
    const input = { chatId: 'private', chatType: 'private' as const, userId: 'owner', messageId: 'source',
      action: { kind: 'turn_detail' as const, cardRef, category: 'result' as const } };
    const db = new Database(path);
    try {
      expect((await controller.handle(input)).text).toBe('');
      expect(JSON.stringify(replace.mock.calls)).toContain('complete public answer');
      expect(JSON.stringify(replace.mock.calls)).not.toContain('fake-final-secret');
      expect((await controller.handle({ ...input, userId: 'other' })).text).toContain('访问权限');
      now = new Date('2026-10-22T00:00:00Z'); runtime.maintain();
      expect(runtime.store!.getTurn(identity)!.availability).toBe('cleared');
      expect((await controller.handle(input)).text).toBe('');
      expect(runtime.results!.readPage(identity).text).toContain('complete public answer');
      const stored = JSON.stringify(db.prepare('SELECT payload FROM detail_entries').all());
      expect(stored).not.toContain('raw-private-reasoning');
      expect(stored).not.toContain('fake-integration-secret');
      runtime.telemetry!.flush();
      expect(JSON.stringify(db.prepare("SELECT * FROM metrics WHERE name LIKE 'link_bot_detail_%'").all())).not.toContain('secret');
    } finally { db.close(); await runtime.close(); }
  });
  it('bounds many small items and an over-quota stream without leaking temporary resource copies', async () => {
    const root = await createTmpDir(), path = join(root, 'state.sqlite');
    const limitBytes = 64 * 1024;
    const store = new SqliteTurnDetailStore(path, { limitBytes, maxEntries: 32 });
    const files = new DetailResourceStore(join(root, 'resources'), { allocated: (id, owner) => store.registerResource(id, owner), removed: (id) => store.forgetResource(id) });
    const identity = { ownerKind: 'task_platform' as const, taskId: 'task', localTurnId: 'local' };
    store.createTurn({ ...identity, threadId: 'thread', scope: { kind: 'private_user', chatId: 'chat', userId: 'owner' },
      schemaVersion: 1, lifecycle: 'running', availability: 'available', startedAt: new Date().toISOString(), retainedBytes: 0, truncated: false });
    const recorder = new TurnDetailRecorder(store, files);
    const started = performance.now();
    try {
      for (let index = 0; index < 200; index++) recorder.record(identity,
        { kind: 'process_delta', itemId: `small-${index}`, source: 'progress', text: 'short safe line\n' }, `small-${index}`, new Date().toISOString());
      for (let index = 0; index < 100; index++) recorder.record(identity,
        { kind: 'process_delta', itemId: 'small-0', source: 'progress', text: 'safe line\n'.repeat(200) }, `long-${index}`, new Date().toISOString());
      expect(store.getTurn(identity)!.retainedBytes).toBeLessThanOrEqual(limitBytes);
      expect(store.getTurn(identity)!.truncated).toBe(true);
      expect(store.listEntries(identity)).toHaveLength(32);
      const resources = await readdir(join(root, 'resources'));
      expect(resources.length).toBeLessThanOrEqual(32);
      let physicalBytes = 0;
      for (const id of resources) physicalBytes += (await stat(join(root, 'resources', id))).size;
      expect(physicalBytes).toBeLessThanOrEqual(limitBytes);
      // A smoke sample, not a client P95 or production performance gate.
      expect(Number.isFinite(performance.now() - started)).toBe(true);
    } finally { store.close(); }
  });
});
