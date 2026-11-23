import {describe, expect, it} from 'vitest';
import {FileStateStore} from '../../src/state/FileStateStore.js';
import {SqliteStateStore} from '../../src/state/SqliteStateStore.js';
import type {TaskRecord} from '../../src/tasks/TaskTypes.js';
import {createTmpDir} from '../helpers/tmp.js';

function personalTask(): TaskRecord {
  return {id: 'task_identity', ownerUserId: 'ou_owner', identityMode: 'personal-agent', agentOwnerUserId: 'ou_owner',
    runtimeMode: 'user-sandbox', mode: 'chat', baseRef: '', branchName: '', runtimeState: 'warm', pinned: false,
    lastUserInteractionAt: '', createdAt: '', updatedAt: ''};
}

describe.each(['sqlite', 'file'] as const)('%s task identity persistence', kind => {
  async function fixture() {
    const store = kind === 'sqlite' ? new SqliteStateStore(':memory:') : new FileStateStore(await createTmpDir());
    return {store, close: () => { if (store instanceof SqliteStateStore) store.close(); }};
  }

  it('round-trips fixed identity while allowing ordinary task progress', async () => {
    const h = await fixture(); try {
      await h.store.saveTask(personalTask());
      await h.store.updateTask('task_identity', t => ({...t, runtimeState: 'hot'}));
      expect(await h.store.getTask('task_identity')).toMatchObject({identityMode: 'personal-agent', agentOwnerUserId: 'ou_owner', runtimeState: 'hot'});
    } finally { h.close(); }
  });

  it.each([
    {agentOwnerUserId: 'ou_other', ownerUserId: 'ou_other'}, {ownerUserId: 'ou_other'},
    {identityMode: undefined, agentOwnerUserId: undefined}, {identityMode: 'legacy', agentOwnerUserId: undefined},
  ])('refuses identity rewriting through save and update: %j', async patch => {
    const h = await fixture(); try {
      const original = personalTask(); await h.store.saveTask(original);
      await expect(Promise.resolve().then(() => h.store.saveTask({...original, ...patch} as TaskRecord))).rejects.toThrow('identity');
      await expect(Promise.resolve().then(() => h.store.updateTask(original.id, t => ({...t, ...patch} as TaskRecord)))).rejects.toThrow('identity');
      expect(await h.store.getTask(original.id)).toEqual(original);
    } finally { h.close(); }
  });

  it('rejects an updater that mutates identity in place', async () => {
    const h = await fixture(); try {
      await h.store.saveTask(personalTask());
      await expect(Promise.resolve().then(() => h.store.updateTask('task_identity', t => {
        delete t.identityMode; delete t.agentOwnerUserId; return t;
      }))).rejects.toThrow('identity');
      expect(await h.store.getTask('task_identity')).toMatchObject({identityMode: 'personal-agent'});
    } finally { h.close(); }
  });

  it('preserves legacy records but refuses converting them in place', async () => {
    const h = await fixture(); try {
      const legacy = {...personalTask(), identityMode: undefined, agentOwnerUserId: undefined};
      await h.store.saveTask(legacy);
      await h.store.updateTask(legacy.id, t => ({...t, pinned: true}));
      await expect(Promise.resolve().then(() => h.store.saveTask(personalTask()))).rejects.toThrow('identity');
      expect((await h.store.getTask(legacy.id))?.identityMode).toBeUndefined();
    } finally { h.close(); }
  });
});

it('cannot use the direct legacy fallback path on a personal-agent task', () => {
  const store = new SqliteStateStore(':memory:'); try {
    store.saveTask(personalTask());
    expect(() => store.fallbackUnstartedUserSandboxTaskToLegacy('task_identity')).toThrow('personal-agent');
    expect(store.getTask('task_identity')?.runtimeMode).toBe('user-sandbox');
  } finally { store.close(); }
});
