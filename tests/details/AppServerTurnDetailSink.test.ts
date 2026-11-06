import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AppServerTurnDetailSink } from '../../src/details/AppServerTurnDetailSink.js';
import { SqliteTurnDetailStore } from '../../src/details/SqliteTurnDetailStore.js';
import { DetailResourceStore } from '../../src/details/DetailResourceStore.js';
import { TurnDetailRecorder } from '../../src/details/TurnDetailRecorder.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('App Server detail sink', () => {
  it('binds private and topic scopes to platform identities and leaves execution payloads untouched', async () => {
    const root = await createTmpDir();
    const store = new SqliteTurnDetailStore(join(root, 'state.sqlite'));
    const files = new DetailResourceStore(join(root, 'details'));
    const sink = new AppServerTurnDetailSink(store, new TurnDetailRecorder(store, files));
    const identity = { ownerKind: 'task_platform' as const, taskId: 'task', localTurnId: 'local' };
    try {
      sink.accepted({ ...identity, userId: 'ou_owner', target: { chatId: 'group', chatType: 'group', topicId: 'topic' } });
      sink.event({ type: 'turn.started', taskId: 'task', threadId: 'thread', turnId: 'turn' }, 'start');
      const event = { type: 'item.delta' as const, taskId: 'task', threadId: 'thread', turnId: 'turn', itemId: 'plan', channel: 'plan' as const, delta: 'plan\n' };
      const before = JSON.stringify(event);
      const persisted = sink.event(event, 'delta');
      expect(JSON.stringify(event)).toBe(before);
      expect(persisted).toMatchObject({ type: 'item.delta', detailRef: expect.any(String) });
      expect(JSON.stringify(persisted)).not.toContain('plan\\n');
      expect(store.getTurn(identity)?.scope).toEqual({ kind: 'shared_group_topic', chatId: 'group', topicId: 'topic' });
      sink.event({ ...event, turnId: 'other', delta: 'wrong-turn\n' }, 'other');
      expect(store.listEntries(identity)).toHaveLength(1);
      sink.event({ type: 'turn.completed', taskId: 'task', threadId: 'thread', turnId: 'turn', status: 'completed', turn: {} }, 'done');
      expect(store.getTurn(identity)?.lifecycle).toBe('completed');
    } finally { store.close(); }
  });

  it('never falls back to unsafe raw persistence after a detail storage failure or missing identity', async () => {
    const root = await createTmpDir();
    const store = new SqliteTurnDetailStore(join(root, 'state.sqlite'));
    const files = new DetailResourceStore(join(root, 'details'));
    const sink = new AppServerTurnDetailSink(store, new TurnDetailRecorder(store, files));
    try {
      sink.accepted({ ownerKind: 'host_manager', taskId: 'host', localTurnId: 'local', userId: 'user', target: { chatId: 'private' } });
      vi.spyOn(store, 'createTurn').mockImplementationOnce(() => { throw new Error('disk failed'); });
      expect(() => sink.event({ type: 'turn.started', taskId: 'host', threadId: 'thread', turnId: 'turn' }, 'start')).not.toThrow();
      const persisted = sink.event({ type: 'item.delta', taskId: 'host', threadId: 'thread', turnId: 'turn', itemId: 'cmd', channel: 'command', delta: 'private-raw-output' }, 'output');
      expect(JSON.stringify(persisted)).not.toContain('private-raw-output');
      sink.interrupt('host', 'local');
    } finally { store.close(); }
  });
});
