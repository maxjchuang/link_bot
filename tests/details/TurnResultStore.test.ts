import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TurnResultStore } from '../../src/details/TurnResultStore.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('public turn results', () => {
  it('redacts known credentials, preserves long ordinary lines, and rejects invalid offsets', async () => {
    const store = new TurnResultStore(join(await createTmpDir(), 'state.sqlite'));
    const identity = { ownerKind: 'task_platform' as const, taskId: 'task', localTurnId: 'turn' };
    try {
      store.save(identity, { kind: 'private_user', chatId: 'private', userId: 'owner' },
        `token=fake-test-secret\n${'x'.repeat(9000)}`, '2026-10-14T00:00:00Z');
      expect(store.readPage(identity).text).not.toContain('fake-test-secret');
      expect(store.metadata(identity)!.length).toBeGreaterThan(9000);
      for (const offset of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, 100000]) {
        expect(() => store.readPage(identity, offset)).toThrow('invalid_cursor');
      }
    } finally { store.close(); }
  });
  it('persists complete Unicode answers independently of detail retention and freezes the first result', async () => {
    const path = join(await createTmpDir(), 'state.sqlite');
    const identity = { ownerKind: 'host_manager' as const, taskId: 'task', localTurnId: 'turn' };
    const scope = { kind: 'private_user' as const, chatId: 'private', userId: 'owner' };
    const answer = '汉字🙂\n'.repeat(2000);
    let store = new TurnResultStore(path);
    try {
      store.save(identity, scope, answer, '2026-10-14T00:00:00Z');
      store.save(identity, scope, 'different', '2026-10-15T00:00:00Z');
      store.close(); store = new TurnResultStore(path);
      expect(store.metadata(identity)).toMatchObject({ scope, endedAt: '2026-10-14T00:00:00Z' });
      let text = '', offset = 0;
      for (;;) {
        const page = store.readPage(identity, offset);
        expect(page.text).not.toContain('�');
        text += page.text;
        if (page.nextOffset === undefined) break;
        offset = page.nextOffset;
      }
      expect(text).toBe(answer);
    } finally { store.close(); }
  });
});
