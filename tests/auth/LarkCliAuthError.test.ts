import { describe, expect, it } from 'vitest';
import { larkCliAuthorizationRequirement } from '../../src/auth/LarkCliAuthError.js';

describe('larkCliAuthorizationRequirement', () => {
  it('extracts required user scopes from a failed lark-cli command', () => {
    expect(larkCliAuthorizationRequirement({ item: {
      type: 'commandExecution', command: ['lark-cli', 'base', 'record', 'list'],
      aggregatedOutput: JSON.stringify({
        ok: false, error: { subtype: 'token_missing', missing_scopes: ['base:record:read'] },
      }),
    } })).toEqual({ scopes: ['base:record:read'], domains: [], subtype: 'token_missing' });
  });

  it('infers the minimal domain when auto identity fell back to bot because the user is missing', () => {
    expect(larkCliAuthorizationRequirement({ item: {
      type: 'commandExecution', command: 'lark-cli base record list',
      aggregatedOutput: JSON.stringify({
        identity: 'bot', identities: { user: { status: 'missing', available: false } },
        error: { subtype: 'token_missing' },
      }),
    } })).toEqual({ scopes: [], domains: ['base'], subtype: 'token_missing' });
  });

  it('hands a model-started device flow to the broker using its requested domain', () => {
    expect(larkCliAuthorizationRequirement({ item: {
      type: 'commandExecution', command: 'lark-cli auth login --domain base --no-wait --json',
      aggregatedOutput: JSON.stringify({ device_code: 'opaque', verification_url: 'https://auth.example' }),
    } })).toEqual({ scopes: [], domains: ['base'], subtype: 'manual_device_flow_started' });
  });

  it('does not intercept explicit bot auth failures or unrelated commands', () => {
    expect(larkCliAuthorizationRequirement({ item: {
      type: 'commandExecution', command: 'lark-cli base record list --as bot',
      aggregatedOutput: '{"identity":"bot","subtype":"missing_scope","missing_scopes":["base:record:read"]}',
    } })).toBeUndefined();
    expect(larkCliAuthorizationRequirement({ item: {
      type: 'commandExecution', command: 'git status',
      aggregatedOutput: 'token_missing requires scopes: base:record:read',
    } })).toBeUndefined();
  });

  it('does not request an unrelated default domain from a bare auth status check', () => {
    expect(larkCliAuthorizationRequirement({ item: {
      type: 'commandExecution', command: 'lark-cli auth status --json --verify',
      aggregatedOutput: JSON.stringify({ identity: 'bot', identities: { user: { status: 'missing' } } }),
    } })).toBeUndefined();
  });
});
