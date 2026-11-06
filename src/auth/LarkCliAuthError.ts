export interface LarkCliAuthorizationRequirement {
  scopes: string[];
  domains: string[];
  subtype: string;
}

const SCOPE = /^[a-z][a-z0-9_.-]*(?::[a-z0-9_.-]+)+$/i;
const DOMAIN = /^[a-z][a-z0-9_-]*$/i;
const COMMAND_DOMAINS: Record<string, string> = {
  application: 'application', approval: 'approval', apps: 'apps', attendance: 'attendance',
  base: 'base', calendar: 'calendar', contact: 'contact', doc: 'docs', docs: 'docs', drive: 'drive',
  event: 'event', im: 'im', mail: 'mail', markdown: 'markdown', mindnotes: 'mindnotes',
  minutes: 'minutes', note: 'note', okr: 'okr', sheets: 'sheets', slides: 'slides', task: 'task',
  vc: 'vc', wiki: 'wiki',
};

export function larkCliAuthorizationRequirement(
  event: { item: unknown },
): LarkCliAuthorizationRequirement | undefined {
  const item = record(event.item);
  if (item?.type !== 'commandExecution') return undefined;
  const command = commandText(item.command);
  if (!/(?:^|[\s/'"])(?:lark-cli)(?:[\s'"]|$)/i.test(command)) return undefined;
  if (/--as(?:=|\s+)bot(?:\s|$)/i.test(command)) return undefined;
  const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
  if (!output) return undefined;
  const manualDeviceFlow = /\blark-cli\s+auth\s+login\b/i.test(command)
    && /--no-wait(?:\s|$)/i.test(command)
    && /"device_code"\s*:/i.test(output);
  const detectedSubtype = firstMatch(output, [
    /"subtype"\s*:\s*"([a-z0-9_-]+)"/i,
    /\b(token_missing|need_user_authorization|missing_scope)\b/i,
  ]);
  const missingUser = userIdentityMissing(output);
  if (!manualDeviceFlow && !missingUser
    && (!detectedSubtype || !/(?:token_missing|need_user_authorization|missing_scope)/i.test(`${detectedSubtype} ${output}`))) return undefined;
  // A bot-scoped command cannot be fixed by asking the caller to re-authorize.
  // In auto mode, however, lark-cli may fall back to the bot precisely because
  // the nested user identity is missing, so the top-level identity alone is not
  // sufficient to reject the requirement.
  if (/"identity"\s*:\s*"bot"/i.test(output) && !missingUser && detectedSubtype === 'missing_scope') return undefined;
  const scopes = new Set<string>();
  for (const json of jsonObjects(output)) collectScopes(json, scopes);
  for (const match of output.matchAll(/requires? scope\(s\):\s*([^\n\r]+)/gi)) {
    for (const scope of match[1]!.split(/[\s,]+/)) if (SCOPE.test(scope)) scopes.add(scope);
  }
  collectCommandScopes(command, scopes);
  const domains = scopes.size === 0 ? commandDomains(command) : [];
  // Never fall back to LarkCliAuthProvider's approval-only default for an
  // unknown command: asking for the wrong permission would merely create a new
  // authorization loop.
  if (scopes.size === 0 && domains.length === 0) return undefined;
  return {
    scopes: [...scopes].sort(), domains,
    subtype: manualDeviceFlow ? 'manual_device_flow_started' : detectedSubtype ?? 'user_identity_missing',
  };
}

function collectCommandScopes(command: string, scopes: Set<string>): void {
  for (const match of command.matchAll(/--scope(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s"']+))/gi)) {
    for (const scope of (match[1] ?? match[2] ?? match[3] ?? '').split(/[\s,]+/)) {
      if (SCOPE.test(scope)) scopes.add(scope);
    }
  }
}

function commandDomains(command: string): string[] {
  const domains = new Set<string>();
  for (const match of command.matchAll(/--domain(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s"']+))/gi)) {
    for (const domain of (match[1] ?? match[2] ?? match[3] ?? '').split(/[\s,]+/)) {
      if (DOMAIN.test(domain)) domains.add(domain.toLowerCase());
    }
  }
  const subcommand = /\blark-cli\s+([a-z][a-z0-9_-]*)\b/i.exec(command)?.[1]?.toLowerCase();
  if (subcommand && COMMAND_DOMAINS[subcommand]) domains.add(COMMAND_DOMAINS[subcommand]);
  return [...domains].sort();
}

function userIdentityMissing(output: string): boolean {
  if (/user identity\s*(?:is|:)\s*(?:missing|expired|invalid)/i.test(output)) return true;
  for (const value of jsonObjects(output)) {
    const status = nestedUserStatus(value, new Set());
    if (status && /^(?:missing|expired|invalid|refresh_failed)$/i.test(status)) return true;
  }
  return false;
}

function nestedUserStatus(value: unknown, seen: Set<unknown>): string | undefined {
  if (!value || typeof value !== 'object' || seen.has(value)) return undefined;
  seen.add(value);
  if (!Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    const identities = record(object.identities);
    const user = record(identities?.user);
    if (typeof user?.status === 'string') return user.status;
    for (const nested of Object.values(object)) {
      const status = nestedUserStatus(nested, seen); if (status) return status;
    }
  } else {
    for (const nested of value) {
      const status = nestedUserStatus(nested, seen); if (status) return status;
    }
  }
  return undefined;
}

function collectScopes(value: unknown, scopes: Set<string>): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const object = value as Record<string, unknown>;
  for (const key of ['missing_scopes', 'required_scopes']) {
    const candidate = object[key];
    if (Array.isArray(candidate)) for (const scope of candidate) if (typeof scope === 'string' && SCOPE.test(scope)) scopes.add(scope);
  }
  for (const nested of Object.values(object)) collectScopes(nested, scopes);
}

function jsonObjects(value: string): unknown[] {
  const result: unknown[] = [];
  try { result.push(JSON.parse(value)); } catch { /* embedded JSON is handled below */ }
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    try { result.push(JSON.parse(trimmed)); } catch { /* ignore non-JSON command output */ }
  }
  return result;
}

function commandText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string').join(' ');
  return '';
}

function firstMatch(value: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
