import { describe, expect, it } from 'vitest';
import { shouldReplaceCodexAuth } from '../../runtime/bin/link-bot-codex-auth.mjs';

const now = Date.parse('2026-10-14T07:31:00Z');
function auth(refresh, expiry, account = 'account_1', subject = 'user_1') {
  const claims = { exp: Date.parse(expiry) / 1_000, sub: subject };
  return JSON.stringify({ last_refresh: refresh,
    tokens: { account_id: account, access_token: `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature` } });
}
const old = auth('2026-09-18', '2026-09-28');
const fresh = auth('2026-10-08', '2026-10-18');

describe('Codex authentication synchronization', () => {
  it('replaces the expired credential left in a reclaimed sandbox', () => {
    expect(shouldReplaceCodexAuth(fresh, old, now)).toBe(true);
  });
  it('preserves a credential refreshed more recently in the sandbox', () => {
    expect(shouldReplaceCodexAuth(fresh, auth('2026-10-12', '2026-10-22'), now)).toBe(false);
    expect(shouldReplaceCodexAuth(fresh, fresh, now)).toBe(false);
  });
  it('does not overwrite another account or user', () => {
    expect(shouldReplaceCodexAuth(fresh, auth('2026-09-18', '2026-09-28', 'another_account'), now)).toBe(false);
    expect(shouldReplaceCodexAuth(fresh, auth('2026-09-18', '2026-09-28', 'account_1', 'another_user'), now)).toBe(false);
  });
  it('rejects expired, malformed, or unidentifiable replacement credentials', () => {
    expect(shouldReplaceCodexAuth(auth('2026-10-10', '2026-10-13'), old, now)).toBe(false);
    for (const invalid of ['{', '{}', '{"tokens":{"access_token":"opaque"}}']) {
      expect(shouldReplaceCodexAuth(invalid, old, now)).toBe(false);
      expect(shouldReplaceCodexAuth(fresh, invalid, now)).toBe(false);
    }
  });
});
