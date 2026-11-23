import {describe, expect, it} from 'vitest';
import {SqliteStateStore} from '../../src/state/SqliteStateStore.js';
import {GroupService} from '../../src/security/GroupService.js';
import {join} from 'node:path';
import {createTmpDir} from '../helpers/tmp.js';

function fixture(store = new SqliteStateStore(':memory:')) {
  let members = true;
  const service = new GroupService({store, agentId: 'agent_test', ownerUserId: 'ou_owner',
    verifyGroup: async () => members, clock: () => new Date(2000)});
  const event = (eventId: string, occurredAt: number, kind: 'added'|'removed' = 'added', operatorUserId?: string) =>
    service.handleLifecycle({eventId, occurredAt, kind, chatId: 'oc_group', operatorUserId});
  return {store, service, event, setMembers: (value: boolean) => {members = value;}};
}

describe('group service facts (no admission side effects)', () => {
  it('parses only owner private management commands, with replay identity', async () => {
    const h = fixture(); try {
      const message = {chatId: 'oc_private', chatType: 'private' as const, userId: 'ou_owner',
        text: '/agent group enable oc_group', messageId: 'msg_enable'};
      expect(await h.service.handleOwnerCommand({...message, text: '/project status'})).toBeUndefined();
      await expect(h.service.handleOwnerCommand({...message, userId: 'ou_member'})).rejects.toThrow('owner');
      await expect(h.service.handleOwnerCommand({...message, chatType: 'group'})).rejects.toThrow('private');
      expect(await h.service.handleOwnerCommand({...message, text: '/agent group enable'})).toContain('用法');
      await expect(h.service.handleOwnerCommand({...message, messageId: undefined})).rejects.toThrow('identity');
      expect(await h.service.handleOwnerCommand(message)).toContain('已记录');
      expect(await h.service.handleOwnerCommand(message)).toContain('已记录');
      expect(h.service.get('oc_group')?.version).toBe(1);
    } finally {h.store.close();}
  });
  it('requires owner invitation and verified group membership to enable', async () => {
    const h = fixture(); try {
      await h.event('unknown', 100);
      expect(h.service.get('oc_group')).toMatchObject({status: 'pending', version: 1});
      await h.event('other', 101, 'added', 'ou_other');
      expect(h.service.get('oc_group')?.status).toBe('pending');
      await h.event('owner', 102, 'added', 'ou_owner');
      expect(h.service.get('oc_group')).toMatchObject({status: 'enabled', ownerUserId: 'ou_owner', version: 3});
    } finally {h.store.close();}
  });

  it('fails closed when membership verification fails or throws', async () => {
    const h = fixture(); try {
      h.setMembers(false);
      await h.event('owner', 100, 'added', 'ou_owner');
      expect(h.service.get('oc_group')?.status).toBe('pending');
      await expect(h.service.manage({chatId: 'oc_group', actorUserId: 'ou_owner', chatType: 'private',
        commandId: 'command', enable: true})).rejects.toThrow('membership');
      const broken = new GroupService({store: h.store, agentId: 'agent_test', ownerUserId: 'ou_owner',
        verifyGroup: async () => {throw new Error('unavailable');}});
      await broken.handleLifecycle({chatId: 'oc_other', eventId: 'error', kind: 'added', occurredAt: 101, operatorUserId: 'ou_owner'});
      expect(broken.get('oc_other')?.status).toBe('pending');
    } finally {h.store.close();}
  });

  it('deduplicates across reopens and retains removal tombstones', async () => {
    const filename = join(await createTmpDir(), 'groups.sqlite');
    let h = fixture(new SqliteStateStore(filename));
    await h.event('remove', 200, 'removed');
    h.store.close();
    h = fixture(new SqliteStateStore(filename)); try {
      await h.event('remove', 200, 'removed');
      await h.event('old-invite', 100, 'added', 'ou_owner');
      expect(h.service.get('oc_group')).toMatchObject({status: 'revoked', version: 1});
      await h.event('fresh-invite', 201, 'added', 'ou_owner');
      expect(h.service.get('oc_group')).toMatchObject({status: 'enabled', version: 2});
      expect(h.service.isCurrent('oc_group', 1)).toBe(false);
      expect(h.service.isCurrent('oc_group', 2)).toBe(true);
    } finally {h.store.close();}
  });

  it.each([true, false])('removal wins equal timestamps, removal first=%s', async removalFirst => {
    const h = fixture(); try {
      if (removalFirst) {await h.event('remove', 100, 'removed'); await h.event('invite', 100, 'added', 'ou_owner');}
      else {await h.event('invite', 100, 'added', 'ou_owner'); await h.event('remove', 100, 'removed');}
      expect(h.service.get('oc_group')?.status).toBe('revoked');
    } finally {h.store.close();}
  });

  it('does not allow async verification to overwrite an intervening removal', async () => {
    const h = fixture(); try {
      let done!: (value: boolean) => void;
      const delayed = new GroupService({store: h.store, agentId: 'agent_test', ownerUserId: 'ou_owner',
        verifyGroup: () => new Promise(resolve => {done = resolve;})});
      const pending = delayed.handleLifecycle({chatId: 'oc_group', eventId: 'invite', occurredAt: 100, kind: 'added', operatorUserId: 'ou_owner'});
      await h.event('remove', 200, 'removed'); done(true); await pending;
      expect(h.service.get('oc_group')?.status).toBe('revoked');
    } finally {h.store.close();}
  });

  it('shares CAS and event deduplication across independent gateway/manager connections', async () => {
    const filename = join(await createTmpDir(), 'shared.sqlite');
    const h = fixture(new SqliteStateStore(filename));
    const second = new SqliteStateStore(filename);
    try {
      await h.event('invite', 100, 'added', 'ou_owner');
      const revoke = {agentId: 'agent_test', chatId: 'oc_group', ownerUserId: 'ou_owner', status: 'revoked' as const,
        eventId: 'command:stop', source: 'owner' as const, expectedVersion: 1, occurredAt: 2000, updatedAt: 'now'};
      second.applyGroupServiceTransition(revoke);
      h.store.applyGroupServiceTransition({...revoke, eventId: 'command:stale-enable', status: 'enabled', occurredAt: 2001});
      expect(h.service.get('oc_group')).toMatchObject({status: 'revoked', version: 2});
      second.applyGroupServiceTransition({...revoke, expectedVersion: 2});
      expect(h.service.get('oc_group')?.version).toBe(2);
    } finally {h.store.close(); second.close();}
  });

  it('explicit management is owner-private only, idempotent, and fences old lifecycle events', async () => {
    const h = fixture(); try {
      const command = {chatId: 'oc_group', commandId: 'enable', actorUserId: 'ou_owner', chatType: 'private' as const, enable: true};
      await expect(h.service.manage({...command, actorUserId: 'ou_other'})).rejects.toThrow('owner');
      await expect(h.service.manage({...command, chatType: 'group'})).rejects.toThrow('private');
      await h.service.manage(command); await h.service.manage(command);
      expect(h.service.get('oc_group')).toMatchObject({status: 'enabled', version: 1});
      await h.service.manage({...command, commandId: 'disable', enable: false});
      await h.event('delayed-invite', 1999, 'added', 'ou_owner');
      expect(h.service.get('oc_group')).toMatchObject({status: 'revoked', version: 2});
    } finally {h.store.close();}
  });

  it('rejects owner changes and invalid versions rather than accepting existing grants', async () => {
    const h = fixture(); try {
      await h.event('invite', 100, 'added', 'ou_owner');
      const other = new GroupService({store: h.store, agentId: 'agent_test', ownerUserId: 'ou_new', verifyGroup: async () => true});
      expect(other.isCurrent('oc_group', 1)).toBe(false);
      await expect(other.handleLifecycle({chatId: 'oc_group', eventId: 'new-owner', occurredAt: 200, kind: 'added', operatorUserId: 'ou_new'})).rejects.toThrow('owner');
      for (const version of [0, -1, NaN, 1.5]) expect(h.service.isCurrent('oc_group', version)).toBe(false);
    } finally {h.store.close();}
  });
});
