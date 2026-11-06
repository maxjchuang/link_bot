import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectUsageService } from '../../src/projects/ProjectUsageService.js';
import { SqliteStateStore } from '../../src/state/SqliteStateStore.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('ProjectUsageService', () => {
  it('tracks private users independently and shares group-chat history', async () => {
    let now = new Date('2026-07-31T00:00:00Z');
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'));
    const usage = new ProjectUsageService(store, () => now);
    usage.record({ chatType: 'private', chatId: 'dm1', userId: 'u1' }, 'one');
    now = new Date('2026-07-31T00:01:00Z');
    usage.record({ chatType: 'group', chatId: 'team', userId: 'u1' }, 'two');

    expect(usage.recent({ chatType: 'private', chatId: 'dm2', userId: 'u1' }, ['one', 'two'])).toBe('one');
    expect(usage.recent({ chatType: 'group', chatId: 'team', userId: 'u2' }, ['one', 'two'])).toBe('two');
    expect(usage.recent({ chatType: 'group', chatId: 'other', userId: 'u1' }, ['one', 'two'])).toBeUndefined();
    store.close();
  });
});
