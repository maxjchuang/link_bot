// JWT claims are used only to compare cached credential freshness. The server
// still validates the token; do not treat these claims as authentication.
export function shouldReplaceCodexAuth(source, destination, now = Date.now()) {
  const incoming = metadata(source);
  const existing = metadata(destination);
  if (!incoming || !existing || incoming.account !== existing.account
    || incoming.subject !== existing.subject || incoming.expiry <= now + 60_000) return false;
  return incoming.refreshed > existing.refreshed
    || (incoming.refreshed === existing.refreshed && incoming.expiry > existing.expiry);
}

function metadata(contents) {
  try {
    const auth = JSON.parse(contents);
    const token = auth.tokens?.access_token;
    if (typeof token !== 'string') return undefined;
    const parts = token.split('.');
    if (parts.length !== 3) return undefined;
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const account = auth.tokens.account_id ?? claims['https://api.openai.com/auth']?.chatgpt_account_id;
    const refreshed = Date.parse(auth.last_refresh);
    if (typeof account !== 'string' || !account || typeof claims.sub !== 'string'
      || !claims.sub || !Number.isFinite(claims.exp) || !Number.isFinite(refreshed)) return undefined;
    return { account, subject: claims.sub, expiry: claims.exp * 1_000, refreshed };
  } catch {
    return undefined;
  }
}
