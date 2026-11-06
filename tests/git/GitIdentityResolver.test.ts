import { describe, expect, it } from 'vitest';
import { GitIdentityResolver } from '../../src/git/GitIdentityResolver.js';

describe('GitIdentityResolver', () => {
  it('uses the configured Git identity for a Feishu user', () => {
    const resolver = new GitIdentityResolver({
      ou_owner: { name: 'Owner Name', email: 'owner@example.com' },
    });
    expect(resolver.resolve('ou_owner')).toEqual({ name: 'Owner Name', email: 'owner@example.com' });
  });

  it('refuses to create commits when no verified identity exists', () => {
    expect(() => new GitIdentityResolver().resolve('ou_unknown')).toThrow('git_identity_required');
  });

  it('rejects internal platform identifiers as commit identities', () => {
    expect(() => new GitIdentityResolver({
      ou_owner: { name: 'ou_owner', email: 'ou_owner@link-bot.local' },
    }).resolve('ou_owner')).toThrow('git_identity_invalid');
  });
});
