import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TurnDetailService } from '../../src/details/TurnDetailService.js';
import { DetailAccessPolicy } from '../../src/details/DetailAccessPolicy.js';
import { SqliteTurnDetailStore } from '../../src/details/SqliteTurnDetailStore.js';
import { DetailResourceStore } from '../../src/details/DetailResourceStore.js';
import { TurnDetailRecorder } from '../../src/details/TurnDetailRecorder.js';
import { createTmpDir } from '../helpers/tmp.js';
import { DetailViewStore } from '../../src/details/DetailViewStore.js';

describe('read-only turn detail service', () => {
  it('reads fixed committed UTF-8 pages, rejects transferred cursors and enforces terminal retention', async () => {
    const root = await createTmpDir();
    const store = new SqliteTurnDetailStore(join(root, 'state.sqlite'));
    const files = new DetailResourceStore(join(root, 'details'));
    const identity = { ownerKind: 'task_platform' as const, taskId: 'task', localTurnId: 'local' };
    const start = '2026-10-13T00:00:00Z';
    let now = Date.parse(start);
    let member = true;
    const policy = new DetailAccessPolicy({ resolveSource: async () => ({ chatId: 'group', chatType: 'group', topicId: 'topic' }),
      isGroupMember: async () => member, canReadTopic: async () => true });
    const views = new DetailViewStore(join(root, 'state.sqlite'), () => new Date(now));
    let service = new TurnDetailService(store, files, policy, () => new Date(now), views);
    store.createTurn({ ...identity, threadId: 'thread', codexTurnId: 'turn', schemaVersion: 1,
      scope: { kind: 'shared_group_topic', chatId: 'group', topicId: 'topic' }, startedAt: start,
      lifecycle: 'running', availability: 'available', retainedBytes: 0, truncated: false });
    const recorder = new TurnDetailRecorder(store, files);
    recorder.record(identity, { kind: 'command_item', itemId: 'cmd', command: 'pwd', completed: false }, 'command', start);
    const text = '汉字🙂\n'.repeat(1000);
    recorder.record(identity, { kind: 'command_delta', itemId: 'cmd', stream: 'combined', text }, 'output', start);
    const entry = store.listEntries(identity)[0]!;
    const actor = { userId: 'member', sourceMessageId: 'card' };
    try {
      const first = await service.readEntry(identity, entry.entryId, actor);
      expect(first.text).not.toContain('�');
      expect(first.nextCursorRef).toBeDefined();
      // A new service instance must be able to continue the same frozen page after restart.
      service.dispose(); service = new TurnDetailService(store, files, policy, () => new Date(now), views);
      recorder.record(identity, { kind: 'command_delta', itemId: 'cmd', stream: 'combined', text: 'later\n' }, 'later', start);
      let combined = first.text;
      let cursor = first.nextCursorRef;
      while (cursor) {
        const page = await service.readEntry(identity, entry.entryId, actor, cursor);
        combined += page.text;
        cursor = page.nextCursorRef;
      }
      expect(combined).toBe(text);
      await expect(service.readEntry(identity, entry.entryId, { ...actor, userId: 'other-member' }, first.nextCursorRef)).rejects.toThrow('invalid_cursor');
      member = false;
      await expect(service.readEntry(identity, entry.entryId, actor, first.nextCursorRef)).rejects.toThrow('access_denied');
      member = true;
      for (let index = 0; index < 10; index++) recorder.record(identity,
        { kind: 'command_item', itemId: `cmd-${index}`, command: 'pwd', completed: false }, `cmd-${index}`, start);
      const directory = await service.list(identity, 'commands', actor);
      expect(directory.entries).toHaveLength(8);
      expect(directory.entries[0]!.preview).not.toContain('�');
      expect(directory.entries[0]!.preview).toBe(text.slice(0, directory.entries[0]!.preview!.length));
      expect(Buffer.byteLength(directory.entries[0]!.preview!)).toBeLessThanOrEqual(768);
      expect(directory.entries[0]!.previewHasMore).toBe(true);
      const read = vi.spyOn(files, 'readBytes');
      member = false;
      await expect(service.list(identity, 'commands', actor)).rejects.toThrow('access_denied');
      expect(read).not.toHaveBeenCalled();
      member = true; read.mockRestore();
      expect(directory.nextCursorRef).toBeDefined();
      recorder.record(identity, { kind: 'command_item', itemId: 'new-after-list', command: 'pwd', completed: false }, 'after-list', start);
      service = new TurnDetailService(store, files, policy, () => new Date(now), views);
      const rest = await service.list(identity, 'commands', actor, directory.nextCursorRef);
      expect(rest.entries).toHaveLength(3);
      expect(rest.entries.some((entry) => entry.itemId === 'new-after-list')).toBe(false);
      now += 8 * 24 * 60 * 60 * 1000;
      // Active work does not expire solely because its start is old.
      await expect(service.readEntry(identity, entry.entryId, actor)).resolves.toMatchObject({ missing: false });
      store.completeTurn(identity, 'completed', start);
      now += 7 * 24 * 60 * 60 * 1000;
      await expect(service.readEntry(identity, entry.entryId, actor)).rejects.toThrow('expired');
    } finally { views.close(); store.close(); }
  });
});
