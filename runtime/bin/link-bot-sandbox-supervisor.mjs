#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { chown, chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { shouldReplaceCodexAuth } from './link-bot-codex-auth.mjs';

const bridgeRoot = process.env.LINK_BOT_BRIDGE_ROOT ?? '/run/link-bot/bridge';
const controlSocket = join(bridgeRoot, 'supervisor.sock');
const taskSocketRoot = join(bridgeRoot, 'tasks');
const maxAppServers = positiveInteger(process.env.LINK_BOT_MAX_APP_SERVERS, 8);
const currentSandboxGeneration = positiveInteger(process.env.LINK_BOT_SANDBOX_GENERATION, 1);
const hostUid = nonnegativeInteger(process.env.LINK_BOT_HOST_UID, 0);
const hostGid = nonnegativeInteger(process.env.LINK_BOT_HOST_GID, 0);
const taskUid = positiveInteger(process.env.LINK_BOT_TASK_UID, 10001);
const taskGid = positiveInteger(process.env.LINK_BOT_TASK_GID, 10001);
const supervisorUid = process.getuid?.() ?? hostUid;
const supervisorGid = process.getgid?.() ?? hostGid;
const unprivilegedTestMode = process.env.LINK_BOT_ALLOW_UNPRIVILEGED_TEST === '1';
if (!unprivilegedTestMode && hostUid === taskUid) throw new Error('host control UID must differ from the task process UID');
const stopGraceMs = positiveInteger(process.env.LINK_BOT_APP_SERVER_STOP_GRACE_MS, 10_000);
const detachedOutputLimit = positiveInteger(process.env.LINK_BOT_DETACHED_OUTPUT_BYTES, 1_048_576);
const workspaceRoot = process.env.LINK_BOT_WORKSPACE_ROOT ?? '/workspace';
const taskTmpRoot = unprivilegedTestMode && process.env.LINK_BOT_TASK_TMP_ROOT
  ? process.env.LINK_BOT_TASK_TMP_ROOT
  : '/tmp/link-bot/tasks';
const taskAuthSource = process.env.LINK_BOT_AUTH_FILE;
const sandboxHome = process.env.HOME ?? '/home/codex';
const sandboxStateRoot = join(sandboxHome, '.link-bot');
const sharedCodexHome = process.env.CODEX_HOME ?? join(sandboxHome, '.codex');
const sharedToolHome = process.env.LINK_BOT_TOOL_HOME ?? join(sharedCodexHome, 'tool-home');
const sharedNativeGitHome = process.env.LINK_BOT_NATIVE_GIT_HOME ?? join(sharedCodexHome, 'native-git');
const defaultAgentsFile = process.env.LINK_BOT_DEFAULT_AGENTS_FILE ?? '/opt/link-bot/defaults/AGENTS.md';
const managedStartPrefix = '<!-- link-bot:managed:start';
const managedEndMarker = '<!-- link-bot:managed:end -->';
const codexCommand = process.env.LINK_BOT_CODEX_COMMAND ?? 'codex';
const configuredCodexArgs = optionalArgv(process.env.LINK_BOT_CODEX_ARGS) ?? [
  '-c', 'features.context_management.experimental_mode=true',
  '-c', 'model_context_window=1000000',
  'app-server', '--stdio',
];
const tasks = new Map();
const projectInitializations = new Map();
const repositoryCreations = new Map();
let activeRepositoryCreationId;
const repositoryCreateCommand = unprivilegedTestMode && process.env.LINK_BOT_REPO_CREATE_COMMAND
  ? process.env.LINK_BOT_REPO_CREATE_COMMAND
  : '/usr/local/bin/link-bot-sandbox-repo-create';
const repositoryCreateTimeoutMs = positiveInteger(process.env.LINK_BOT_REPO_CREATE_TIMEOUT_MS, 300_000);
let shuttingDown = false;
let authSync = Promise.resolve();

await prepareOwnedDirectory(sandboxHome, 0o700, taskUid, taskGid, 'sandbox home');
await prepareOwnedDirectory(sandboxStateRoot, 0o700, taskUid, taskGid, 'sandbox state root');
await prepareOwnedDirectory(sharedCodexHome, 0o700, taskUid, taskGid, 'shared Codex home');
await prepareOwnedDirectory(sharedToolHome, 0o700, taskUid, taskGid, 'shared tool home');
await prepareOwnedDirectory(sharedNativeGitHome, 0o700, taskUid, taskGid, 'shared native Git home');
await verifyTaskWritableDirectories([sandboxStateRoot, sharedToolHome, sharedNativeGitHome]);
await importLegacyTaskHomes();
await prepareSharedAuth();
const platformInstructions = await prepareManagedAgentsInstructions();
const codexArgs = injectDeveloperInstructions(configuredCodexArgs, platformInstructions);
await reportGlobalAgentsOverride();
await prepareOwnedDirectory(taskSocketRoot, 0o700, hostUid, hostGid, 'task socket root');
// App Server processes do not survive a Supervisor restart. Remove their
// orphaned temporary state before accepting new work, then isolate every new
// process generation below this root so cleanup never targets arbitrary /tmp
// entries owned by tools or the base image.
await rm(taskTmpRoot, { recursive: true, force: true });
await prepareOwnedDirectory(taskTmpRoot, 0o711, supervisorUid, supervisorGid, 'task temporary root');
await rm(controlSocket, { force: true });

const control = createServer((socket) => {
  let buffered = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffered += chunk;
    if (buffered.length > 1_048_576) {
      socket.destroy(new Error('control request exceeds 1 MiB'));
      return;
    }
    const newline = buffered.indexOf('\n');
    if (newline < 0) return;
    const line = buffered.slice(0, newline);
    buffered = '';
    void handleControlLine(line).then(
      (response) => socket.end(`${JSON.stringify(response)}\n`),
      (error) => socket.end(`${JSON.stringify({ ok: false, error: safeError(error) })}\n`),
    );
  });
});

await listen(control, controlSocket);
await chmod(controlSocket, 0o600);
await chown(controlSocket, hostUid, hostGid);
log('supervisor.ready', { controlSocket, maxAppServers });

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

async function handleControlLine(line) {
  const request = JSON.parse(line);
  const id = typeof request.id === 'string' || typeof request.id === 'number' ? request.id : undefined;
  try {
    const result = await dispatch(request.method, request.params ?? {});
    return { id, ok: true, result };
  } catch (error) {
    return { id, ok: false, error: safeError(error) };
  }
}

async function dispatch(method, params) {
  if (shuttingDown && method !== 'Health') throw new Error('supervisor is shutting down');
  switch (method) {
    case 'StartTask': return startTask(params);
    case 'StopTask': return stopTask(params);
    case 'InspectTask': return inspectTask(params);
    case 'ListTasks': return { tasks: [...tasks.values()].map(taskSnapshot) };
    case 'Health': return {
      status: shuttingDown ? 'stopping' : 'ready', taskCount: tasks.size, maxAppServers,
      capabilities: ['RefreshCodexAuth'],
    };
    case 'EnsureProject': return ensureProject(params);
    case 'RefreshCodexAuth': {
      if (params.ownerId !== process.env.LINK_BOT_OWNER_ID) throw new Error('authentication owner mismatch');
      if (requiredGeneration(params.sandboxGeneration, 'sandboxGeneration') !== currentSandboxGeneration) {
        throw new Error('stale sandbox generation');
      }
      if (typeof params.contents !== 'string' || Buffer.byteLength(params.contents) > 65_536) {
        throw new Error('invalid authentication payload');
      }
      const updated = await syncSharedAuth(params.contents);
      if (!updated) throw new Error('No newer valid Codex credentials are available. Please sign in again on the host.');
      return { updated };
    }
    case 'ValidateRepositoryCreation': return repositoryCreation(params, 'validate');
    case 'CreateRepository': return repositoryCreation(params, 'create');
    case 'ReadRepositoryCreation': return repositoryCreation(params, 'readback');
    default: throw new Error(`unsupported supervisor method: ${String(method)}`);
  }
}

async function repositoryCreation(params, action) {
  const request = validatedRepositoryRequest(params, action);
  const prior = repositoryCreations.get(request.operationId);
  if (action === 'create') {
    if (activeRepositoryCreationId && activeRepositoryCreationId !== request.operationId) {
      throw new Error('another repository creation is in flight');
    }
    if (prior?.state === 'completed') return prior.result;
    if (prior?.state === 'uncertain') throw new Error('repository creation outcome is uncertain; use readback');
    if (prior?.state === 'in_flight') return prior.promise;
    activeRepositoryCreationId = request.operationId;
    const promise = invokeRepositoryHelper(request);
    repositoryCreations.set(request.operationId, { state: 'in_flight', promise });
    try {
      const result = await promise;
      if (result.status === 'created') repositoryCreations.set(request.operationId, { state: 'completed', result });
      else if (result.status === 'auth_required'
        && ['github_login_required', 'git_bootstrap_failed'].includes(result.reason)) {
        // The helper returns these only before provider creation or after it
        // has saved the same-operation receipt needed to resume Git bootstrap.
        repositoryCreations.delete(request.operationId);
      } else repositoryCreations.set(request.operationId, { state: 'uncertain' });
      return result;
    } catch (error) {
      repositoryCreations.set(request.operationId, { state: 'uncertain' });
      throw error;
    } finally {
      activeRepositoryCreationId = undefined;
    }
  }
  if (action === 'readback' && prior?.state === 'in_flight') {
    throw new Error('repository creation is still in flight');
  }
  const result = await invokeRepositoryHelper(request);
  if (action === 'readback' && result.status === 'created') {
    repositoryCreations.set(request.operationId, { state: 'completed', result });
  }
  return result;
}

function validatedRepositoryRequest(params, action) {
  if (typeof params.ownerUserId !== 'string' || params.ownerUserId !== process.env.LINK_BOT_OWNER_ID) {
    throw new Error('repository creation owner mismatch');
  }
  if (requiredGeneration(params.sandboxGeneration, 'sandboxGeneration') !== currentSandboxGeneration) {
    throw new Error('stale sandbox generation');
  }
  if (typeof params.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(params.operationId)) {
    throw new Error('invalid operationId');
  }
  const segment = '[A-Za-z0-9][A-Za-z0-9._-]{0,79}';
  if (typeof params.namespace !== 'string' || !new RegExp(`^${segment}(?:/${segment}){0,3}$`).test(params.namespace)
    || typeof params.name !== 'string' || !new RegExp(`^${segment}$`).test(params.name)
    || params.private !== true || params.provider !== 'github') {
    throw new Error('invalid repository creation target');
  }
  if (params.description !== undefined && (typeof params.description !== 'string'
    || params.description.length > 500 || /\0/.test(params.description))) throw new Error('invalid repository description');
  return {
    action, operationId: params.operationId, provider: params.provider,
    namespace: params.namespace, name: params.name, private: true,
    ...(params.description ? { description: params.description } : {}),
  };
}

function invokeRepositoryHelper(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(repositoryCreateCommand, [], {
      env: { ...process.env, HOME: sandboxHome, LINK_BOT_TOOL_HOME: sharedToolHome,
        GH_CONFIG_DIR: join(sharedToolHome, 'gh'), GH_PROMPT_DISABLED: '1' },
      ...(unprivilegedTestMode ? {} : { uid: taskUid, gid: taskGid }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let settled = false;
    let oversized = false;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, repositoryCreateTimeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 16_384) { oversized = true; child.kill('SIGKILL'); }
    });
    // Provider stderr may contain credentials. Drain but never log or return it.
    child.stderr.resume();
    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error('repository helper could not start'));
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (timedOut) return reject(new Error('repository helper timed out'));
      if (oversized) return resolve({ status: 'failed', reason: 'helper_output_too_large' });
      let parsed;
      try { parsed = JSON.parse(stdout.trim()); } catch { return resolve({ status: 'failed', reason: 'invalid_helper_result' }); }
      const result = normalizedRepositoryResult(parsed, request);
      if (code !== 0 && result.status !== 'auth_required' && result.status !== 'failed') {
        return resolve({ status: 'failed', reason: 'helper_failed' });
      }
      resolve(result);
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

function normalizedRepositoryResult(value, request) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['ready', 'auth_required', 'created', 'not_found', 'exists_foreign', 'failed'].includes(value.status)) {
    return { status: 'failed', reason: 'invalid_helper_result' };
  }
  const reason = typeof value.reason === 'string' && /^[a-z][a-z0-9_]{0,100}$/.test(value.reason)
    ? value.reason : undefined;
  if (value.status !== 'created') return { status: value.status, ...(reason ? { reason } : {}) };
  const target = `${request.namespace}/${request.name}`;
  const sameTarget = typeof value.canonicalPath === 'string' && (request.provider === 'github'
    ? value.canonicalPath.toLowerCase() === target.toLowerCase() : value.canonicalPath === target);
  const expectedClone = `git@github.com:${value.canonicalPath}.git`;
  if (typeof value.providerRepoId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(value.providerRepoId)
    || /gh[pousr]_[A-Za-z0-9]{20,}/i.test(value.providerRepoId)
    || !sameTarget || value.cloneUrl !== expectedClone
    || typeof value.defaultBranch !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(value.defaultBranch)
    || /gh[pousr]_[A-Za-z0-9]{20,}/i.test(value.defaultBranch)) {
    return { status: 'failed', reason: 'invalid_helper_result' };
  }
  return { status: 'created', providerRepoId: value.providerRepoId, canonicalPath: value.canonicalPath,
    cloneUrl: expectedClone, defaultBranch: value.defaultBranch };
}

async function startTask(params) {
  const taskId = requiredId(params.taskId, 'taskId');
  const sandboxGeneration = requiredGeneration(params.sandboxGeneration, 'sandboxGeneration');
  if (sandboxGeneration !== currentSandboxGeneration) throw new Error('stale sandbox generation');
  const processGeneration = requiredGeneration(params.processGeneration, 'processGeneration');
  const cwd = await prepareTaskCwd(params.cwd, taskId);
  const existing = tasks.get(taskId);
  if (existing) {
    if (existing.sandboxGeneration === sandboxGeneration && existing.processGeneration === processGeneration) {
      return taskSnapshot(existing);
    }
    await stopManagedTask(existing, 'generation_replaced');
  }
  if (tasks.size >= maxAppServers) throw new Error(`app-server capacity reached (${maxAppServers})`);
  await prepareSharedAuth();

  const tmpDirectory = join(taskTmpRoot, `${safeId(taskId)}-g${processGeneration}`);
  await rm(tmpDirectory, { recursive: true, force: true });
  await prepareOwnedDirectory(tmpDirectory, 0o700, taskUid, taskGid, 'task temporary directory');
  const socketPath = join(taskSocketRoot, `${safeId(taskId)}-${processGeneration}.sock`);
  await rm(socketPath, { force: true });
  const task = {
    taskId,
    threadId: typeof params.threadId === 'string' ? params.threadId : undefined,
    sandboxGeneration,
    processGeneration,
    socketPath,
    tmpDirectory,
    startedAt: new Date().toISOString(),
    state: 'starting',
    client: undefined,
    detachedOutput: [],
    detachedOutputBytes: 0,
  };
  const server = createServer((client) => attachClient(task, client));
  task.server = server;
  await listen(server, socketPath);
  await chmod(socketPath, 0o600);
  await chown(socketPath, hostUid, hostGid);

  const child = spawn(codexCommand, codexArgs, {
    cwd,
    env: {
      ...process.env,
      HOME: sandboxHome,
      CODEX_HOME: sharedCodexHome,
      LINK_BOT_TASK_ID: taskId,
      LINK_BOT_SANDBOX_GENERATION: String(sandboxGeneration),
      LINK_BOT_PROCESS_GENERATION: String(processGeneration),
      TMPDIR: tmpDirectory,
      TMP: tmpDirectory,
      TEMP: tmpDirectory,
      NODE_COMPILE_CACHE: join(tmpDirectory, 'node-compile-cache'),
    },
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(unprivilegedTestMode ? {} : { uid: taskUid, gid: taskGid }),
  });
  task.child = child;
  tasks.set(taskId, task);
  child.stdout.on('data', (chunk) => forwardOrBuffer(task, chunk));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => log('appserver.stderr', {
    taskId, sandboxGeneration, processGeneration, message: String(chunk).slice(-4_000),
  }));
  child.once('exit', (code, signal) => void finalizeExitedTask(task, code, signal));
  try {
    await waitForSpawn(child);
  } catch (error) {
    task.state = 'failed';
    task.failure = safeError(error);
    log('appserver.spawn_failed', { taskId, sandboxGeneration, processGeneration, error: task.failure });
    await closeServer(task.server);
    await rm(task.socketPath, { force: true });
    await rm(task.tmpDirectory, { recursive: true, force: true });
    if (tasks.get(task.taskId) === task) tasks.delete(task.taskId);
    throw error;
  }
  task.state = 'running';
  log('appserver.started', { taskId, sandboxGeneration, processGeneration, pid: child.pid, socketPath });
  return taskSnapshot(task);
}

async function prepareTaskCwd(value, taskId) {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('invalid task cwd');
  const tasksRoot = join(workspaceRoot, 'tasks');
  const expected = join(tasksRoot, safeId(taskId));
  if (value !== expected) {
    const projectId = value.startsWith(`${workspaceRoot}/`) ? value.slice(workspaceRoot.length + 1) : '';
    if (!isProjectId(projectId) || value !== join(workspaceRoot, projectId)) throw new Error('invalid shared project cwd');
    const metadata = await lstat(value);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== taskUid) {
      throw new Error('shared project cwd is not an owned directory');
    }
    const [root, resolved] = await Promise.all([realpath(workspaceRoot), realpath(value)]);
    if (resolved !== join(root, projectId)) throw new Error('shared project cwd escaped the workspace root');
    return resolved;
  }
  await prepareOwnedDirectory(tasksRoot, 0o711, supervisorUid, supervisorGid, 'tasks root');
  await mkdir(expected, { recursive: true, mode: 0o700 });
  const [root, resolved] = await Promise.all([realpath(workspaceRoot), realpath(expected)]);
  if (resolved !== join(root, 'tasks', safeId(taskId))) throw new Error('task cwd escaped the workspace root');
  await prepareOwnedDirectory(resolved, 0o700, taskUid, taskGid, 'task cwd');
  return resolved;
}

async function ensureProject(params) {
  const projectId = params.projectId;
  if (!isProjectId(projectId)) throw new Error('invalid project id');
  const cloneUrl = params.cloneUrl;
  if (!repositoryKey(cloneUrl)) throw new Error('invalid project clone URL');
  const baseRef = params.baseRef;
  if (typeof baseRef !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(baseRef)
    || baseRef.includes('..') || baseRef.endsWith('.lock')) throw new Error('invalid project base ref');
  const existing = projectInitializations.get(projectId);
  if (existing) return existing;
  const operation = initializeProject(projectId, cloneUrl, baseRef);
  projectInitializations.set(projectId, operation);
  try { return await operation; } finally { projectInitializations.delete(projectId); }
}

async function initializeProject(projectId, cloneUrl, baseRef) {
  const cwd = join(workspaceRoot, projectId);
  const linkbotRoot = join(workspaceRoot, '.linkbot');
  const bootstrapRoot = join(linkbotRoot, 'project-bootstrap');
  const marker = join(bootstrapRoot, `${projectId}.json`);
  let current;
  try { current = await lstat(cwd); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (current) {
    if (!current.isDirectory() || current.isSymbolicLink() || current.uid !== taskUid) {
      throw new Error('shared project path is not an owned directory');
    }
    const root = await realpath(workspaceRoot);
    if (await realpath(cwd) !== join(root, projectId)) throw new Error('shared project path escaped the workspace root');
    const topLevel = await runProjectGit(['-C', cwd, 'rev-parse', '--show-toplevel']);
    if (topLevel.code === 0) {
      if (topLevel.stdout.trim() !== cwd) throw new Error('shared project is not a repository root');
      await rm(marker, { force: true });
      return { projectId, cwd, status: 'ready' };
    }
    if ((await readdir(cwd)).length !== 0) throw new Error('shared project path exists but is not an empty Git checkout');
  }
  await prepareOwnedDirectory(linkbotRoot, 0o700, taskUid, taskGid, 'workspace metadata root');
  await prepareOwnedDirectory(bootstrapRoot, 0o700, taskUid, taskGid, 'project bootstrap root');
  const temporary = join(bootstrapRoot, `${projectId}-${randomUUID()}`);
  // An existing empty directory may be the cwd of a task waiting for Git
  // authorization. Clone into it in place instead of unlinking its cwd.
  const destination = current ? cwd : temporary;
  const cloned = await runProjectGit([
    'clone', '--depth', '1', '--single-branch', '--no-tags', '--branch', baseRef, '--', cloneUrl, destination,
  ], 240_000);
  if (cloned.code === 0) {
    try {
      if (!current) await rename(temporary, cwd);
      await rm(marker, { force: true });
      return { projectId, cwd, status: 'ready' };
    } catch (error) {
      if (!current) await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
  if (!current) await rm(temporary, { recursive: true, force: true });
  if (!isGitAuthFailure(cloned.stderr)) throw new Error('project clone failed; inspect sandbox Git access or base branch');
  if (!current) await prepareOwnedDirectory(cwd, 0o700, taskUid, taskGid, 'project authentication workspace');
  await writeFile(marker, JSON.stringify({ projectId, cloneUrl, baseRef }), { mode: 0o600 });
  await chown(marker, taskUid, taskGid);
  return { projectId, cwd, status: 'auth_required' };
}

function isProjectId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)
    && !['tasks', '.linkbot'].includes(value) && !value.includes('..');
}

function repositoryKey(value) {
  if (typeof value !== 'string') return undefined;
  const ssh = /^git@(github\.com):([A-Za-z0-9._/-]+?)(?:\.git)?$/.exec(value);
  if (ssh) return `${ssh[1]}/${ssh[2]}`.toLowerCase();
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash
      || !['github.com'].includes(parsed.hostname)
      || !/^\/[A-Za-z0-9._/-]+$/.test(parsed.pathname)) return undefined;
    return `${parsed.hostname}${parsed.pathname.replace(/\.git$/, '')}`.toLowerCase();
  } catch { return undefined; }
}

function isGitAuthFailure(stderr) {
  return /permission denied|authentication failed|authorization failed|could not read username|publickey|auth_required|auth-003|repository not found/i.test(stderr);
}

function runProjectGit(args, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(unprivilegedTestMode ? '/usr/bin/git' : '/usr/local/bin/git', args, {
      env: { ...process.env, HOME: sandboxHome, GIT_TERMINAL_PROMPT: '0' },
      ...(unprivilegedTestMode ? {} : { uid: taskUid, gid: taskGid }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-4096); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
  });
}

async function prepareOwnedDirectory(path, mode, ownerUid, ownerGid, label) {
  await mkdir(path, { recursive: true, mode });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} is not a directory: ${path}`);
  const currentMode = metadata.mode & 0o777;
  const needsOwnership = metadata.uid !== ownerUid || metadata.gid !== ownerGid;
  if (currentMode !== mode) {
    // The production supervisor intentionally lacks CAP_FOWNER. Temporarily owning an
    // existing directory lets it repair the mode with its narrower CAP_CHOWN.
    if (metadata.uid !== supervisorUid || metadata.gid !== supervisorGid) {
      await chown(path, supervisorUid, supervisorGid);
    }
    await chmod(path, mode);
  }
  if (needsOwnership || currentMode !== mode) await chown(path, ownerUid, ownerGid);
}

async function verifyTaskWritableDirectories(paths) {
  const script = [
    "const { closeSync, openSync, unlinkSync } = require('node:fs');",
    "const { join } = require('node:path');",
    'for (const directory of process.argv.slice(1)) {',
    "  const probe = join(directory, `.task-write-probe-${process.pid}`);",
    "  closeSync(openSync(probe, 'wx', 0o600));",
    '  unlinkSync(probe);',
    '}',
  ].join('\n');
  const child = spawn(process.execPath, ['-e', script, ...paths], {
    stdio: ['ignore', 'ignore', 'pipe'],
    ...(unprivilegedTestMode ? {} : { uid: taskUid, gid: taskGid }),
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0) {
    throw new Error(`task process cannot write generation-local state: ${stderr.trim() || result.signal || result.code}`);
  }
}

async function prepareSharedAuth() {
  if (!taskAuthSource) return;
  const contents = await readBoundedRegularFile(taskAuthSource, 65_536, 'sandbox authentication source');
  await syncSharedAuth(contents);
}

function syncSharedAuth(contents) {
  const pending = authSync.then(() => replaceSharedAuth(contents));
  authSync = pending.catch(() => undefined);
  return pending;
}

async function replaceSharedAuth(contents) {
  const destination = join(sharedCodexHome, 'auth.json');
  let existing;
  try {
    await prepareOwnedFile(destination, 0o600, taskUid, taskGid, 'shared Codex authentication');
    existing = await readBoundedRegularFile(destination, 65_536, 'shared Codex authentication');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existing !== undefined && !shouldReplaceCodexAuth(contents, existing)) return false;
  // A Codex process may have refreshed the file while we inspected it.
  if (existing !== undefined) {
    const latest = await readBoundedRegularFile(destination, 65_536, 'shared Codex authentication');
    if (latest !== existing && !shouldReplaceCodexAuth(contents, latest)) return false;
  }
  await atomicWriteOwnedFile(destination, contents, 0o600, taskUid, taskGid, 'shared Codex authentication');
  log('auth.synchronized', {});
  return true;
}

async function prepareManagedAgentsInstructions() {
  const template = await readBoundedRegularFile(defaultAgentsFile, 262_144, 'platform AGENTS template');
  const managedBlock = requireManagedBlock(template, 'platform AGENTS template');
  const destination = join(sharedCodexHome, 'AGENTS.md');
  let existing = '';
  try {
    existing = await readBoundedRegularFile(destination, 262_144, 'shared Codex AGENTS.md');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const startCount = countOccurrences(existing, managedStartPrefix);
  const endCount = countOccurrences(existing, managedEndMarker);
  if (startCount !== endCount || startCount > 1) {
    throw new Error('shared Codex AGENTS.md has malformed or duplicate link-bot managed markers');
  }
  let updated;
  if (startCount === 1) {
    const start = existing.indexOf(managedStartPrefix);
    const startLineEnd = existing.indexOf('\n', start);
    const end = existing.indexOf(managedEndMarker, start);
    if (startLineEnd < 0 || end < startLineEnd) {
      throw new Error('shared Codex AGENTS.md has malformed link-bot managed markers');
    }
    updated = `${existing.slice(0, start)}${managedBlock}${existing.slice(end + managedEndMarker.length)}`;
  } else {
    const separator = existing.length === 0 ? '' : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    updated = `${existing}${separator}${managedBlock}\n`;
  }
  if (Buffer.byteLength(updated) > 262_144) throw new Error('shared Codex AGENTS.md exceeds 256 KiB after update');
  if (updated === existing) {
    await prepareOwnedFile(destination, 0o600, taskUid, taskGid, 'shared Codex AGENTS.md');
    return managedBlock;
  }
  await atomicWriteOwnedFile(destination, updated, 0o600, taskUid, taskGid, 'shared Codex AGENTS.md');
  return managedBlock;
}

function requireManagedBlock(contents, label) {
  const startCount = countOccurrences(contents, managedStartPrefix);
  const endCount = countOccurrences(contents, managedEndMarker);
  const start = contents.indexOf(managedStartPrefix);
  const startLineEnd = contents.indexOf('\n', start);
  const end = contents.indexOf(managedEndMarker, start);
  if (startCount !== 1 || endCount !== 1 || start < 0 || startLineEnd < 0 || end < startLineEnd) {
    throw new Error(`${label} must contain exactly one valid link-bot managed block`);
  }
  return contents.slice(start, end + managedEndMarker.length);
}

function countOccurrences(contents, needle) {
  let count = 0;
  let offset = 0;
  while ((offset = contents.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

async function readBoundedRegularFile(path, maximumBytes, label) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximumBytes) {
      throw new Error(metadata.size > maximumBytes ? `${label} exceeds ${maximumBytes} bytes` : `${label} is not a regular file: ${path}`);
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function atomicWriteOwnedFile(path, contents, mode, ownerUid, ownerGid, label) {
  const staged = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(staged, contents, { flag: 'wx', mode });
    await prepareOwnedFile(staged, mode, ownerUid, ownerGid, `staged ${label}`);
    await rename(staged, path);
    await prepareOwnedFile(path, mode, ownerUid, ownerGid, label);
  } finally {
    await rm(staged, { force: true });
  }
}

function injectDeveloperInstructions(args, instructions) {
  const configArgs = ['-c', `developer_instructions=${JSON.stringify(instructions)}`];
  const appServerIndex = args.indexOf('app-server');
  if (appServerIndex < 0) return [...args, ...configArgs];
  return [...args.slice(0, appServerIndex), ...configArgs, ...args.slice(appServerIndex)];
}

async function reportGlobalAgentsOverride() {
  const override = join(sharedCodexHome, 'AGENTS.override.md');
  try {
    const metadata = await lstat(override);
    log('instructions.global_override_detected', {
      path: override, regularFile: metadata.isFile() && !metadata.isSymbolicLink(),
      platformDeveloperInstructionsInjected: true,
    });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function importLegacyTaskHomes() {
  const migrationRoot = join(sharedCodexHome, '.link-bot', 'migrations');
  const marker = join(migrationRoot, 'shared-home-v1.json');
  try {
    await prepareOwnedFile(marker, 0o600, taskUid, taskGid, 'shared-home migration marker');
    return;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const tasksRoot = join(workspaceRoot, 'tasks');
  let taskEntries;
  try {
    taskEntries = await readdir(tasksRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    taskEntries = [];
  }
  const legacyHomes = [];
  for (const entry of taskEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = join(tasksRoot, entry.name, '.codex');
    try {
      const metadata = await lstat(candidate);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        legacyHomes.push({ task: entry.name, path: candidate, modifiedAt: metadata.mtimeMs });
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  legacyHomes.sort((left, right) => left.modifiedAt - right.modifiedAt || left.task.localeCompare(right.task));

  for (const legacy of legacyHomes) {
    await mergeOwnedTree(legacy.path, sharedCodexHome, new Map([
      ['auth.json', undefined],
      ['tool-credentials.env', undefined],
      ['.tmp', undefined],
      ['tmp', undefined],
      ['thread-writer-locks', undefined],
      ['tool-home', sharedToolHome],
      ['native-git', sharedNativeGitHome],
    ]));
  }

  await prepareOwnedDirectory(migrationRoot, 0o700, taskUid, taskGid, 'migration marker directory');
  const stagedMarker = `${marker}.${process.pid}.tmp`;
  await writeFile(stagedMarker, `${JSON.stringify({
    version: 1,
    completedAt: new Date().toISOString(),
    importedTaskHomes: legacyHomes.map((legacy) => legacy.task),
  })}\n`, { mode: 0o600 });
  await prepareOwnedFile(stagedMarker, 0o600, taskUid, taskGid, 'staged shared-home migration marker');
  await rename(stagedMarker, marker);
}

async function mergeOwnedTree(source, destination, topLevelRoutes) {
  await prepareOwnedDirectory(destination, 0o700, taskUid, taskGid, 'legacy import destination');
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const metadata = await lstat(sourcePath);
    if (metadata.isSymbolicLink()) continue;
    let destinationPath = join(destination, entry.name);
    if (topLevelRoutes?.has(entry.name)) {
      destinationPath = topLevelRoutes.get(entry.name);
      if (!destinationPath) continue;
    }
    if (metadata.isDirectory()) {
      await mergeOwnedTree(sourcePath, destinationPath);
      continue;
    }
    if (!metadata.isFile()) continue;
    try {
      const destinationMetadata = await lstat(destinationPath);
      if (!destinationMetadata.isFile() || destinationMetadata.isSymbolicLink()) {
        throw new Error(`legacy import destination is not a regular file: ${destinationPath}`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await pipeline(
      createReadStream(sourcePath),
      createWriteStream(destinationPath, { flags: 'w', mode: metadata.mode & 0o777 }),
    );
    await prepareOwnedFile(
      destinationPath, metadata.mode & 0o777, taskUid, taskGid, 'legacy imported file',
    );
  }
}

async function prepareOwnedFile(path, mode, ownerUid, ownerGid, label) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} is not a regular file: ${path}`);
  const currentMode = metadata.mode & 0o777;
  const needsOwnership = metadata.uid !== ownerUid || metadata.gid !== ownerGid;
  if (currentMode !== mode) {
    if (metadata.uid !== supervisorUid || metadata.gid !== supervisorGid) {
      await chown(path, supervisorUid, supervisorGid);
    }
    await chmod(path, mode);
  }
  if (needsOwnership || currentMode !== mode) await chown(path, ownerUid, ownerGid);
}

async function stopTask(params) {
  const taskId = requiredId(params.taskId, 'taskId');
  const expectedSandboxGeneration = requiredGeneration(params.sandboxGeneration, 'sandboxGeneration');
  const expectedProcessGeneration = requiredGeneration(params.expectedProcessGeneration, 'expectedProcessGeneration');
  const task = tasks.get(taskId);
  if (!task) return { taskId, status: 'not_found' };
  if (task.sandboxGeneration !== expectedSandboxGeneration || task.processGeneration !== expectedProcessGeneration) {
    throw new Error('stale task generation');
  }
  await stopManagedTask(task, typeof params.reason === 'string' ? params.reason : 'requested');
  return { taskId, status: 'stopped' };
}

function inspectTask(params) {
  const taskId = requiredId(params.taskId, 'taskId');
  const task = tasks.get(taskId);
  return task ? taskSnapshot(task) : { taskId, status: 'not_found' };
}

function attachClient(task, client) {
  if (task.client && !task.client.destroyed) task.client.destroy(new Error('replaced by a newer host connection'));
  task.client = client;
  for (const chunk of task.detachedOutput) client.write(chunk);
  task.detachedOutput = [];
  task.detachedOutputBytes = 0;
  client.on('data', (chunk) => {
    if (task.child?.stdin.writable) task.child.stdin.write(chunk);
  });
  client.on('close', () => {
    if (task.client === client) task.client = undefined;
  });
  client.on('error', (error) => log('appserver.client_error', { taskId: task.taskId, error: safeError(error) }));
}

function forwardOrBuffer(task, chunk) {
  if (task.client && !task.client.destroyed && task.client.writable) {
    task.client.write(chunk);
    return;
  }
  const value = Buffer.from(chunk);
  task.detachedOutput.push(value);
  task.detachedOutputBytes += value.byteLength;
  while (task.detachedOutputBytes > detachedOutputLimit && task.detachedOutput.length > 0) {
    task.detachedOutputBytes -= task.detachedOutput.shift().byteLength;
    task.outputGap = true;
  }
}

async function stopManagedTask(task, reason) {
  if (task.stopPromise) return task.stopPromise;
  task.state = 'stopping';
  task.stopPromise = (async () => {
    task.client?.end();
    task.child?.stdin.end();
    signalProcessGroup(task.child, 'SIGTERM');
    const exited = await waitForExit(task.child, stopGraceMs);
    if (!exited) {
      signalProcessGroup(task.child, 'SIGKILL');
      await waitForExit(task.child, 2_000);
    }
    await closeServer(task.server);
    await rm(task.socketPath, { force: true });
    await rm(task.tmpDirectory, { recursive: true, force: true });
    if (tasks.get(task.taskId) === task) tasks.delete(task.taskId);
    log('appserver.stopped', {
      taskId: task.taskId, sandboxGeneration: task.sandboxGeneration,
      processGeneration: task.processGeneration, reason,
    });
  })();
  return task.stopPromise;
}

async function finalizeExitedTask(task, code, signal) {
  task.state = 'exited';
  task.exitCode = code;
  task.exitSignal = signal;
  task.client?.end();
  await closeServer(task.server);
  await rm(task.socketPath, { force: true });
  await rm(task.tmpDirectory, { recursive: true, force: true });
  if (tasks.get(task.taskId) === task) tasks.delete(task.taskId);
  log('appserver.exited', {
    taskId: task.taskId, sandboxGeneration: task.sandboxGeneration,
    processGeneration: task.processGeneration, code, signal,
  });
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('supervisor.stopping', { signal, taskCount: tasks.size });
  await closeServer(control);
  await Promise.allSettled([...tasks.values()].map((task) => stopManagedTask(task, 'supervisor_shutdown')));
  await rm(controlSocket, { force: true });
  process.exit(0);
}

function taskSnapshot(task) {
  return {
    taskId: task.taskId,
    threadId: task.threadId,
    sandboxGeneration: task.sandboxGeneration,
    processGeneration: task.processGeneration,
    socketPath: task.socketPath,
    status: task.state,
    pid: task.child?.pid,
    startedAt: task.startedAt,
    outputGap: task.outputGap === true,
    failure: task.failure,
  };
}

function listen(server, path) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(path);
  });
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { child.off('exit', onExit); resolve(false); }, timeoutMs);
    const onExit = () => { clearTimeout(timeout); resolve(true); };
    child.once('exit', onExit);
  });
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off('spawn', onSpawn);
      child.off('error', onError);
    };
    const onSpawn = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

function signalProcessGroup(child, signal) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, signal); } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function requiredId(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) throw new Error(`invalid ${field}`);
  return value;
}

function requiredGeneration(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid ${field}`);
  return value;
}

function safeId(value) {
  return value.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 80);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonnegativeInteger(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function optionalArgv(value) {
  if (value === undefined) return undefined;
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== 'string' || item.includes('\0'))) {
    throw new Error('LINK_BOT_CODEX_ARGS must be a non-empty JSON string array');
  }
  return parsed;
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function log(kind, payload) {
  process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), kind, source: 'supervisor', ...payload })}\n`);
}
