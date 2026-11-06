import { describe, expect, it, vi } from 'vitest';
import { DetailAccessPolicy } from '../../src/details/DetailAccessPolicy.js';

describe('detail read policy', () => {
  it('requires verified source, current membership and topic access without granting execution permissions', async () => {
    const source = vi.fn(async () => ({ chatId: 'group', chatType: 'group' as const, topicId: 'topic' }));
    const member = vi.fn(async () => true);
    const topic = vi.fn(async () => true);
    const policy = new DetailAccessPolicy({ resolveSource: source, isGroupMember: member, canReadTopic: topic });
    const scope = { kind: 'shared_group_topic' as const, chatId: 'group', topicId: 'topic' };
    await expect(policy.requireRead(scope, { userId: 'member', sourceMessageId: 'original-card' })).resolves.toBeUndefined();
    source.mockResolvedValueOnce({ chatId: 'group', chatType: 'group', topicId: 'sibling' });
    await expect(policy.requireRead(scope, { userId: 'member', sourceMessageId: 'forwarded' })).rejects.toThrow('access_denied');
    member.mockResolvedValueOnce(false);
    await expect(policy.requireRead(scope, { userId: 'member', sourceMessageId: 'original-card' })).rejects.toThrow('access_denied');
    topic.mockRejectedValueOnce(new Error('scope missing'));
    await expect(policy.requireRead(scope, { userId: 'member', sourceMessageId: 'original-card' })).rejects.toThrow('access_unavailable');
  });
  it('allows the private owner but fails closed and distinguishes source outages from actual denials', async () => {
    const source = vi.fn().mockResolvedValue({ chatId: 'private', chatType: 'private' });
    const policy = new DetailAccessPolicy({ resolveSource: source, isGroupMember: vi.fn(), canReadTopic: vi.fn() });
    const scope = { kind: 'private_user' as const, chatId: 'private', userId: 'owner' };
    const actor = { userId: 'owner', sourceMessageId: 'card' };
    await expect(policy.requireRead(scope, actor)).resolves.toBeUndefined();
    source.mockRejectedValueOnce(new Error('HTTP 503'));
    await expect(policy.requireRead(scope, actor)).rejects.toThrow('access_unavailable');
    source.mockResolvedValueOnce(undefined);
    await expect(policy.requireRead(scope, actor)).rejects.toThrow('access_denied');
    source.mockResolvedValueOnce({ chatId: 'another', chatType: 'private' });
    await expect(policy.requireRead(scope, actor)).rejects.toThrow('access_denied');
  });

  it('does not expand a private conversation to another user', async () => {
    const policy = new DetailAccessPolicy({ resolveSource: async () => ({ chatId: 'private', chatType: 'private' }), isGroupMember: async () => true, canReadTopic: async () => true });
    const scope = { kind: 'private_user' as const, chatId: 'private', userId: 'owner' };
    await expect(policy.requireRead(scope, { userId: 'other', sourceMessageId: 'card' })).rejects.toThrow('access_denied');
  });
});
