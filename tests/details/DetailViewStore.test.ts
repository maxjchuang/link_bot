import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteTurnDetailStore } from '../../src/details/SqliteTurnDetailStore.js';
import { DetailViewStore } from '../../src/details/DetailViewStore.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('durable detail view state', () => {
  it('keeps opaque card selectors and viewer-bound cursors across a restart', async () => {
    const path = join(await createTmpDir(), 'state.sqlite');
    const details = new SqliteTurnDetailStore(path);
    const identity = { ownerKind: 'host_manager' as const, taskId: 'task', localTurnId: 'local' };
    details.createTurn({ ...identity, threadId: 'thread', codexTurnId: 'turn', schemaVersion: 1,
      scope: { kind: 'private_user', chatId: 'private', userId: 'owner' }, startedAt: '2026-10-14T00:00:00Z',
      lifecycle: 'running', availability: 'available', retainedBytes: 0, truncated: false });
    let views = new DetailViewStore(path);
    try {
      const cardRef = views.registerCard(identity);
      expect(cardRef).toMatch(/^[a-f0-9]{32}$/);
      expect(views.registerCard(identity)).toBe(cardRef);
      const cursor = views.saveCursor(identity, 'owner', { kind: 'test', offset: 10 }, '2026-10-14T00:10:00Z');
      views.close(); views = new DetailViewStore(path);
      expect(views.resolveCard(cardRef)).toEqual(identity);
      expect(views.getCursor(cursor, identity, 'owner', '2026-10-14T00:01:00Z')).toEqual({ kind: 'test', offset: 10 });
      expect(views.getCursor(cursor, identity, 'other', '2026-10-14T00:01:00Z')).toBeUndefined();
      expect(views.getCursor(cursor, { ...identity, localTurnId: 'other' }, 'owner', '2026-10-14T00:01:00Z')).toBeUndefined();
      expect(views.getCursor(cursor, identity, 'owner', '2026-10-14T00:10:00Z')).toBeUndefined();
    } finally { views.close(); details.close(); }
  });
});
