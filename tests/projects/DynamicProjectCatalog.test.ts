import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DynamicProjectCatalog } from '../../src/projects/DynamicProjectCatalog.js';
import type { DynamicProjectRecord } from '../../src/projects/DynamicProjectTypes.js';
import { SqliteStateStore } from '../../src/state/SqliteStateStore.js';
import { sampleConfig } from '../helpers/fakes.js';
import { createTmpDir } from '../helpers/tmp.js';

const NOW = '2026-10-08T00:00:00.000Z';

function dynamicProject(): DynamicProjectRecord {
  return {
    id: 'dyn_1', provider: 'github', providerRepoId: '12345', namespace: 'team', name: 'new-repo',
    cloneUrl: 'git@github.com:team/new-repo.git', defaultBranch: 'main',
    ownerUserId: 'ou_owner', chatId: 'oc_group', topicId: 'topic_origin', state: 'active',
    createdAt: NOW, updatedAt: NOW,
  };
}

describe('DynamicProjectCatalog', () => {
  it('requires creator and exact topic while preserving configured project ACLs', async () => {
    const root = await createTmpDir();
    const store = new SqliteStateStore(join(root, 'state.sqlite'));
    const config = sampleConfig(root);
    config.projects[0]!.access = { allowedUsers: [], allowedChats: ['oc_group'], knowledgeApprovers: [] };
    store.saveDynamicProject(dynamicProject());
    const catalog = new DynamicProjectCatalog(store, config);
    const original = { chatType: 'group' as const, chatId: 'oc_group', topicId: 'topic_origin', userId: 'ou_owner' };

    expect(catalog.resolveFor(original, 'dyn_1')?.id).toBe('dyn_1');
    expect(catalog.resolveFor({ ...original, topicId: 'topic_other' }, 'dyn_1')).toBeUndefined();
    expect(catalog.resolveFor({ ...original, userId: 'ou_member' }, 'dyn_1')).toBeUndefined();
    expect(catalog.resolveFor({ ...original, chatId: 'oc_other' }, 'dyn_1')).toBeUndefined();
    expect(catalog.resolveFor({ ...original, topicId: undefined }, 'dyn_1')).toBeUndefined();
    expect(catalog.resolveFor({ ...original, userId: 'ou_member' }, 'repo')?.id).toBe('repo');
    expect(catalog.listFor(original).map((project) => project.id)).toContain('dyn_1');
    expect(catalog.listFor({ ...original, userId: 'ou_member' }).map((project) => project.id)).not.toContain('dyn_1');
    store.close();
  });

  it('rejects an internal ID collision with a configured project instead of resolving the wrong identity', async () => {
    const root = await createTmpDir();
    const store = new SqliteStateStore(join(root, 'state.sqlite'));
    const config = sampleConfig(root);
    config.projects[0]!.id = 'dyn_1';
    config.projects[0]!.access = { allowedUsers: [], allowedChats: ['oc_group'], knowledgeApprovers: [] };
    store.saveDynamicProject(dynamicProject());
    const catalog = new DynamicProjectCatalog(store, config);
    expect(() => catalog.resolveFor({
      chatType: 'group', chatId: 'oc_group', topicId: 'topic_origin', userId: 'ou_owner',
    }, 'dyn_1')).toThrow('collision');
    store.close();
  });
});
