import {describe, expect, it, vi} from 'vitest';
import {checkOwnerInvocation, explicitIdentity, validateOwnerStatus} from '../../runtime/bin/link-bot-lark-owner-check.mjs';

const policy = {appId: 'app_test', ownerUserId: 'ou_owner'};
const status = {appId: 'app_test', identities: {user: {openId: 'ou_owner', userName: 'Same Name',
  verified: true, available: true, status: 'ready', tokenStatus: 'valid'}}};
describe('owner CLI identity guard', () => {
  it.each([['--profile','other','docs','+create','--as','user'],
    ['docs','+create','--as','user','--profile=other']].map(args => [args]))('rejects executing under a profile other than the verified one: %j', args => {
    const query = vi.fn(() => status);
    expect(() => checkOwnerInvocation(args, policy, query)).toThrow('profile_override');
    expect(query).not.toHaveBeenCalled();
  });
  it('validates the actual application and user account, not a name', () => {
    expect(() => validateOwnerStatus(status, policy)).not.toThrow();
    expect(() => validateOwnerStatus({ok: true, identity: 'user', data: status}, policy)).not.toThrow();
    expect(() => validateOwnerStatus({...status, appId: 'different_app'}, policy)).toThrow('mismatch');
    expect(() => validateOwnerStatus({...status, identities: {user: {...status.identities.user, openId: 'ou_other'}}}, policy)).toThrow('mismatch');
  });
  it.each([{verified: false}, {available: false}, {status: 'needs_refresh'}, {tokenStatus: 'expired'}])('fails closed when user credentials are not ready: %j', patch => {
    expect(() => validateOwnerStatus({...status, identities: {user: {...status.identities.user, ...patch}}}, policy)).toThrow('unavailable');
  });
  it('requires explicit user identity and cannot downgrade to bot', () => {
    const query = vi.fn(() => status);
    for (const args of [['docs','+create'], ['docs','+create','--as','bot'], ['--as=user','--as=bot','docs','+create']])
      expect(() => checkOwnerInvocation(args, policy, query)).toThrow();
    expect(query).not.toHaveBeenCalled();
    checkOwnerInvocation(['docs','+create','--as','user'], policy, query);
    expect(query).toHaveBeenCalledOnce();
  });
  it('does not parse --as bot inside message content as an actual identity switch', () => {
    expect(explicitIdentity(['im','+messages-send','--text','example --as bot text','--as','user'])).toBe('user');
    expect(explicitIdentity(['docs','+create','--','--as','bot'])).toBeUndefined();
  });
  it('permits native auth status diagnostics without the unsupported --as flag, but still verifies the owner', () => {
    const query = vi.fn(() => status);
    expect(() => checkOwnerInvocation(['auth','status','--json','--verify'], policy, query)).not.toThrow();
    expect(query).toHaveBeenCalledOnce();
    expect(() => checkOwnerInvocation(['auth','login'], policy, query)).toThrow('owner_controlled_auth_required');
  });
  it.each([['auth','login','--as','user'], ['--as','user','auth','logout'], ['config','init','--as=user']].map(args => [args]))(
    'does not allow sandbox business requests to overwrite owner credentials: %j', args => {
      expect(() => checkOwnerInvocation(args, policy, () => status)).toThrow('owner_controlled_auth_required');
    });
  it('does not accept bot-only verification as proof of the owner user', () => {
    expect(() => validateOwnerStatus({identity: 'bot', verified: true, appId: 'app_test'}, policy)).toThrow();
    expect(() => validateOwnerStatus({ok: false, data: status}, policy)).toThrow();
  });
});
