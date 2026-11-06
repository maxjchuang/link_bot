import { describe, expect, it } from 'vitest';
import { ProjectAccessPolicy } from '../../src/projects/ProjectAccessPolicy.js';
import { sampleConfig } from '../helpers/fakes.js';
import type { DynamicProjectRecord } from '../../src/projects/DynamicProjectTypes.js';

describe('ProjectAccessPolicy', () => {
  it('filters private users and shared chats independently with an administrator override', () => {
    const config = sampleConfig('/tmp/repo');
    config.upgrade.adminUsers = ['ou_admin'];
    config.projects = [
      { ...config.projects[0]!, access: { allowedUsers: ['ou_one'], allowedChats: ['oc_team'], knowledgeApprovers: [] } },
      { ...config.projects[1]!, access: { allowedUsers: ['ou_two'], allowedChats: [], knowledgeApprovers: [] } },
    ];
    const policy = new ProjectAccessPolicy(config);

    expect(policy.list({ chatType: 'private', chatId: 'oc_dm', userId: 'ou_one' }).map((p) => p.id)).toEqual(['repo']);
    expect(policy.list({ chatType: 'group', chatId: 'oc_team', userId: 'ou_two' }).map((p) => p.id)).toEqual(['repo']);
    expect(policy.list({ chatType: 'private', chatId: 'oc_dm', userId: 'ou_admin' })).toHaveLength(2);
  });

  it('defaults projects without ACLs to administrators only', () => {
    const config = sampleConfig('/tmp/repo');
    config.upgrade.adminUsers = ['ou_admin'];
    const policy = new ProjectAccessPolicy(config);
    expect(policy.list({ chatType: 'private', chatId: 'oc_dm', userId: 'ou_1' })).toEqual([]);
    expect(policy.list({ chatType: 'private', chatId: 'oc_dm', userId: 'ou_admin' })).toHaveLength(2);
  });

  it('supports an explicit wildcard for private-user access without opening group chats', () => {
    const config = sampleConfig('/tmp/repo');
    config.projects = [{
      ...config.projects[0]!,
      access: { allowedUsers: ['*'], allowedChats: [], knowledgeApprovers: [] },
    }];
    const policy = new ProjectAccessPolicy(config);

    expect(policy.list({ chatType: 'private', chatId: 'oc_dm', userId: 'ou_anyone' })).toHaveLength(1);
    expect(policy.list({ chatType: 'group', chatId: 'oc_team', userId: 'ou_anyone' })).toEqual([]);
  });

  it('supports an explicit wildcard for group access without opening private chats', () => {
    const config = sampleConfig('/tmp/repo');
    config.projects = [{
      ...config.projects[0]!,
      access: { allowedUsers: [], allowedChats: ['*'], knowledgeApprovers: [] },
    }];
    const policy = new ProjectAccessPolicy(config);

    expect(policy.list({ chatType: 'group', chatId: 'oc_any', userId: 'ou_anyone' })).toHaveLength(1);
    expect(policy.list({ chatType: 'private', chatId: 'oc_dm', userId: 'ou_anyone' })).toEqual([]);
  });

  it('never treats group membership or administrator status as access to another requester’s dynamic project', () => {
    const config = sampleConfig('/tmp/repo');
    config.upgrade.adminUsers = ['ou_admin'];
    const policy = new ProjectAccessPolicy(config);
    const project = {
      id: 'dyn_1', provider: 'github', providerRepoId: '12345', namespace: 'team', name: 'repo',
      cloneUrl: 'git@github.com:team/repo.git', defaultBranch: 'main',
      ownerUserId: 'ou_owner', chatId: 'oc_group', topicId: 'topic_1', state: 'active',
      createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z',
    } as DynamicProjectRecord;
    const owner = { chatType: 'group' as const, chatId: 'oc_group', topicId: 'topic_1', userId: 'ou_owner' };

    expect(policy.canAccess(project, owner)).toBe(true);
    expect(policy.canAccess(project, { ...owner, userId: 'ou_admin' })).toBe(false);
    expect(policy.canAccess(project, { ...owner, userId: 'ou_member' })).toBe(false);
    expect(policy.canAccess(project, { ...owner, topicId: 'topic_2' })).toBe(false);
  });
});
