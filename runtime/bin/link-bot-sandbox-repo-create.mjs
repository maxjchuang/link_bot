#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const DEFAULT_TOOL_HOME = '/home/codex/.codex/tool-home';
const DEFAULT_RECEIPT_ROOT = '/workspace/.linkbot/repository-creations';
const MAX_INPUT_BYTES = 16_384;

/** Trusted sandbox-local adapter. All CLI output is normalized before leaving this module. */
export async function runSandboxRepositoryCreation(request, options = {}) {
  validateRequest(request);
  const toolHome = options.toolHome ?? process.env.LINK_BOT_TOOL_HOME ?? DEFAULT_TOOL_HOME;
  const receiptRoot = options.receiptRoot ?? DEFAULT_RECEIPT_ROOT;
  const runCli = options.runCli ?? execCli;
  const now = options.clock ?? (() => new Date());
  await ensurePrivateDirectory(toolHome);
  await ensurePrivateDirectory(join(toolHome, 'gh'));
  await ensurePrivateDirectory(receiptRoot);
  const env = {
    ...process.env,
    LINK_BOT_TOOL_HOME: toolHome,
    GH_CONFIG_DIR: join(toolHome, 'gh'),
    GH_PROMPT_DISABLED: '1',
  };
  const receiptPath = join(receiptRoot, `${request.operationId}.json`);
  const receipt = await readReceipt(receiptPath);
  if (receipt && !sameReceiptTarget(receipt, request)) throw new Error('operationId belongs to a different repository target.');
  if (receipt && !validReceiptMetadata(receipt, request)) {
    return { status: 'failed', reason: 'invalid_receipt' };
  }
  if (request.action === 'create' && receipt?.status === 'created') {
    if (receipt.defaultBranch) return resultFromReceipt(receipt);
    const current = await readProviderRepository(request, runCli, env);
    if (current.status !== 'created' || current.providerRepoId !== receipt.providerRepoId) {
      return { status: 'failed', reason: 'receipt_identity_mismatch' };
    }
    return completeDefaultBranch(request, current, { runCli, env, receiptRoot, receiptPath, now });
  }
  if (request.action === 'readback') {
    const existing = await readProviderRepository(request, runCli, env);
    if (existing.status !== 'created') return existing;
    if (!receipt) return { status: 'exists_foreign', reason: 'unverified_existing_repository' };
    if (existing.providerRepoId !== receipt.providerRepoId || existing.canonicalPath !== receipt.canonicalPath) {
      return { status: 'exists_foreign', reason: 'receipt_identity_mismatch' };
    }
    // A receipt proves this operation owns the remote, even if the process
    // crashed before its initial branch was created or persisted.
    const completed = await completeDefaultBranch(request, existing, { runCli, env, receiptRoot, receiptPath, now });
    if (completed.status === 'created') await saveReceipt(receiptPath, request, completed, now());
    return completed;
  }
  const login = await githubLogin(runCli, env);
  if (!login) return { status: 'auth_required', reason: 'github_login_required' };
  const before = await readGitHubRepository(request, runCli, env);
  if (before.status === 'created') return { status: 'exists_foreign', reason: 'unverified_existing_repository' };
  if (before.status !== 'not_found') return before;
  if (request.action === 'validate') return { status: 'ready' };
  const created = await runCli('gh', ['repo', 'create', targetPath(request), '--private', '--add-readme'], { env });
  if (created.exitCode !== 0) {
    const existing = await readGitHubRepository(request, runCli, env);
    return existing.status === 'created'
      ? { status: 'exists_foreign', reason: 'unverified_existing_repository' }
      : { status: 'failed', reason: 'github_create_failed' };
  }
  const readback = await readGitHubRepository(request, runCli, env);
  if (readback.status !== 'created') return readback;
  await saveReceipt(receiptPath, request, readback, now());
  return completeDefaultBranch(request, readback, { runCli, env, receiptRoot, receiptPath, now });
}

async function completeDefaultBranch(request, result, context) {
  if (result.defaultBranch) return result;
  if (!result.cloneUrl) return { status: 'failed', reason: 'clone_url_missing' };
  const branch = 'main';
  const directory = await mkdtemp(join(context.receiptRoot, `${request.operationId}-bootstrap-`));
  await writeFile(join(directory, 'README.md'), `# ${request.name}\n`, { mode: 0o600 });
  const commands = [
    ['init', '-b', branch, directory],
    ['-C', directory, 'add', 'README.md'],
    ['-C', directory, '-c', 'user.name=Link Bot Bootstrap', '-c', 'user.email=link-bot-bootstrap@localhost',
      'commit', '-m', 'Initialize repository'],
    ['-C', directory, 'remote', 'add', 'origin', result.cloneUrl],
    ['-C', directory, 'push', 'origin', `HEAD:refs/heads/${branch}`],
  ];
  for (const args of commands) {
    const output = await context.runCli('git', args, { env: context.env });
    if (output.exitCode !== 0) return { status: 'auth_required', reason: 'git_bootstrap_failed' };
  }
  const confirmed = await readProviderRepository(request, context.runCli, context.env);
  if (confirmed.status !== 'created' || confirmed.providerRepoId !== result.providerRepoId) {
    return { status: 'failed', reason: 'default_branch_readback_failed' };
  }
  if (!confirmed.defaultBranch) return { status: 'failed', reason: 'default_branch_unconfirmed' };
  await saveReceipt(context.receiptPath, request, confirmed, context.now());
  return confirmed;
}

function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid repository request.');
  if (typeof request.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(request.operationId)) {
    throw new Error('Invalid operationId.');
  }
  if (!['validate', 'create', 'readback'].includes(request.action)) throw new Error('Invalid repository action.');
  const segment = '[A-Za-z0-9][A-Za-z0-9._-]{0,79}';
  if (typeof request.namespace !== 'string'
    || !new RegExp(`^${segment}(?:/${segment}){0,3}$`).test(request.namespace)
    || typeof request.name !== 'string' || !new RegExp(`^${segment}$`).test(request.name)) {
    throw new Error('Invalid repository namespace or name.');
  }
  if (request.private !== true) throw new Error('Repository visibility must be private.');
  if (request.description !== undefined && (typeof request.description !== 'string'
    || request.description.length > 500 || /\0/.test(request.description)
    || /(?:gh[pousr]_[A-Za-z0-9]{20,}|(?:access|refresh)[_-]?token\s*[:=]|Bearer\s+\S+)/i.test(request.description))) {
    throw new Error('Invalid description.');
  }
  if (request.provider !== 'github') throw new Error('Invalid repository provider.');
}

function targetPath(request) { return `${request.namespace}/${request.name}`; }

async function readProviderRepository(request, runCli, env) {
  return readGitHubRepository(request, runCli, env);
}

async function githubLogin(runCli, env) {
  const output = await runCli('gh', ['api', 'user', '--jq', '.login'], { env });
  return output.exitCode === 0 && /^[A-Za-z0-9-]{1,80}$/.test(output.stdout.trim()) ? output.stdout.trim() : undefined;
}

async function readGitHubRepository(request, runCli, env) {
  const output = await runCli('gh', ['repo', 'view', targetPath(request), '--json',
    'id,nameWithOwner,sshUrl,defaultBranchRef,isPrivate,owner'], { env });
  if (output.exitCode !== 0) return { status: 'not_found' };
  const data = parseJson(output.stdout);
  const canonicalPath = stringValue(data?.nameWithOwner);
  const providerRepoId = stringValue(data?.id);
  const cloneUrl = stringValue(data?.sshUrl);
  if (canonicalPath?.toLowerCase() !== targetPath(request).toLowerCase() || !providerRepoId
    || looksLikeCredential(providerRepoId)
    || cloneUrl !== `git@github.com:${canonicalPath}.git` || data?.isPrivate !== true) {
    return { status: 'failed', reason: 'github_identity_mismatch' };
  }
  return { status: 'created', providerRepoId, canonicalPath, cloneUrl,
    ...(stringValue(data?.defaultBranchRef?.name) ? { defaultBranch: data.defaultBranchRef.name } : {}) };
}

function parseJson(value) { try { return JSON.parse(value); } catch { return undefined; } }
function stringValue(value) { return typeof value === 'string' && value.length > 0 ? value : undefined; }
function isAuthError(value) { return /AUTH|LOGIN|TOKEN|UNAUTHORIZED/i.test(String(value?.error?.code ?? '')); }

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function readReceipt(path) {
  try { return parseJson(await readFile(path, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
}

function sameReceiptTarget(receipt, request) {
  return receipt.operationId === request.operationId && receipt.provider === request.provider
    && receipt.namespace === request.namespace && receipt.name === request.name;
}

function validReceiptMetadata(receipt, request) {
  const target = targetPath(request);
  const expectedCloneUrl = `git@github.com:${receipt.canonicalPath}.git`;
  return receipt.status === 'created'
    && /^[A-Za-z0-9:_-]{1,128}$/.test(String(receipt.providerRepoId ?? ''))
    && !looksLikeCredential(receipt.providerRepoId)
    && typeof receipt.canonicalPath === 'string'
    && (request.provider === 'github' ? receipt.canonicalPath.toLowerCase() === target.toLowerCase() : receipt.canonicalPath === target)
    && receipt.cloneUrl === expectedCloneUrl
    && (receipt.defaultBranch === undefined || /^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(receipt.defaultBranch));
}

function looksLikeCredential(value) {
  return typeof value === 'string'
    && /gh[pousr]_[A-Za-z0-9]{20,}|(?:access|refresh)[_-]?token\s*[:=]|Bearer\s+\S+/i.test(value);
}

function resultFromReceipt(receipt) {
  return { status: receipt.status, providerRepoId: receipt.providerRepoId,
    canonicalPath: receipt.canonicalPath, cloneUrl: receipt.cloneUrl, defaultBranch: receipt.defaultBranch };
}

async function saveReceipt(path, request, result, now) {
  const receipt = { ...result, operationId: request.operationId, provider: request.provider,
    namespace: request.namespace, name: request.name, createdAt: now.toISOString() };
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(receipt), { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

async function execCli(binary, args, options) {
  return new Promise((done) => {
    execFile(binary, args, { env: options.env, maxBuffer: 262_144, timeout: 120_000, shell: false },
      (error, stdout, stderr) => done({
        stdout: String(stdout).slice(0, 262_144), stderr: String(stderr).slice(0, 65_536),
        exitCode: error ? typeof error.code === 'number' ? error.code : 1 : 0,
      }));
  });
}

async function readOneRequest() {
  let body = '';
  for await (const chunk of process.stdin) {
    body += chunk;
    if (body.length > MAX_INPUT_BYTES) throw new Error('Repository request too large.');
  }
  return JSON.parse(body);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runSandboxRepositoryCreation(await readOneRequest());
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stdout.write('{"status":"failed","reason":"invalid_or_unavailable_request"}\n');
    process.exitCode = 1;
  }
}
