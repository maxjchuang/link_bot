#!/usr/bin/env node
import {existsSync, readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const policyPath = '/run/link-bot/secrets/agent-identity.json';
const realCli = '/usr/local/libexec/lark-cli';
export function explicitIdentity(args) {
  const choices = [];
  for (let i = 0; i < args.length && args[i] !== '--'; i++) {
    if (args[i] === '--as') choices.push(args[++i]);
    else if (args[i].startsWith('--as=')) choices.push(args[i].slice(5));
  }
  if (choices.length > 1 || choices.some(value => !['user','bot'].includes(value))) throw new Error('ambiguous_identity');
  return choices[0];
}

export function validateOwnerStatus(status, policy) {
  const value = status?.data ?? status;
  const user = value?.identities?.user;
  if (typeof policy?.appId !== 'string' || !policy.appId || typeof policy.ownerUserId !== 'string' || !policy.ownerUserId)
    throw new Error('invalid_owner_policy');
  // open_id is meaningful only within the SAME application; names are never compared.
  if (status?.ok === false || value?.appId !== policy.appId || user?.openId !== policy.ownerUserId)
    throw new Error('owner_account_mismatch');
  if (user?.verified !== true || user?.available !== true || user?.status !== 'ready' || user?.tokenStatus !== 'valid')
    throw new Error('owner_account_unavailable');
}

export function checkOwnerInvocation(args, policy, queryStatus) {
  const selected = explicitIdentity(args);
  for (const argument of args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--'))) {
    // The verification query uses the controlled default profile. Do not execute with a different one.
    if (argument === '--profile' || argument.startsWith('--profile=')) throw new Error('owner_profile_override_forbidden');
  }
  let serviceIndex = 0;
  while (args[serviceIndex]?.startsWith('-')) {
    const option = args[serviceIndex++];
    if (['--as','--format','--profile'].includes(option)) serviceIndex++;
    else if (!/^--(?:as|format|profile)=/.test(option)) throw new Error('unsupported_global_option');
  }
  const service = args[serviceIndex], command = args[serviceIndex + 1];
  const statusDiagnostic = service === 'auth' && command === 'status';
  if ((service === 'auth' && !statusDiagnostic) || service === 'config') throw new Error('owner_controlled_auth_required');
  // Bot transport remains host-managed. Sandbox business tools may not downgrade identities.
  if (selected === 'bot') throw new Error('owner_user_identity_required');
  if (selected !== 'user' && !statusDiagnostic) throw new Error('explicit_user_identity_required');
  let status = queryStatus();
  const value = status?.data ?? status, user = value?.identities?.user;
  // Native verification can refresh a token while returning the pre-refresh cached status.
  // Recheck once, only for the already verified same owner/app; never initiate login.
  if (status?.ok !== false && value?.appId === policy.appId && user?.openId === policy.ownerUserId
    && user?.verified === true && user?.available === true
    && (user?.status === 'needs_refresh' || user?.tokenStatus === 'needs_refresh')) status = queryStatus();
  validateOwnerStatus(status, policy);
}

export function main(args = process.argv.slice(2)) {
  if (!existsSync(policyPath)) {
    if (process.env.LINK_BOT_PERSONAL_AGENT === '1') throw new Error('owner_policy_missing');
    return;
  }
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  checkOwnerInvocation(args, policy, () => {
    const result = spawnSync(realCli, ['auth','status','--json','--verify'], {
      env: {...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1'},
      encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error('owner_verification_failed');
    try {return JSON.parse(result.stdout);} catch {throw new Error('owner_verification_failed');}
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {main();} catch {
    // Never forward native CLI errors, auth URLs, account IDs or credential payloads.
    process.stderr.write(JSON.stringify({ok: false, error: {type: 'authorization', subtype: 'agent_owner_verification_failed',
      message: 'Owner identity verification failed. Contact the agent owner; do not authorize as the requester.'}}) + '\n');
    process.exitCode = 77;
  }
}
