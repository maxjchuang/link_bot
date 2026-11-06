#!/usr/bin/env node
import { access, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { ensureHostCodexRuntime } from './host-codex-runtime.mjs';

const DEFAULT_PROCESS_NAME = 'link-bot';
const DEFAULT_ENTRY = 'dist/src/index.js';
const DEFAULT_LOG_ROTATION = Object.freeze({
  enabled: true,
  maxSize: '100M',
  retain: 7,
  compress: true,
  dateFormat: 'YYYY-MM-DD_HH-mm-ss',
  workerInterval: 30,
  rotateInterval: '0 0 * * *',
  rotateModule: true,
});

export function parseArgs(argv) {
  const options = { entry: DEFAULT_ENTRY, processName: DEFAULT_PROCESS_NAME, skipBuild: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--process-name') {
      options.processName = readValue(argv, ++index, arg);
    } else if (arg === '--entry') {
      options.entry = readValue(argv, ++index, arg);
    } else if (arg === '--skip-build') {
      options.skipBuild = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

export async function launchPm2({
  args = process.argv.slice(2),
  commandRunner = runCommand,
  platform = process.platform,
  projectRoot = process.cwd(),
  env = process.env,
  invokedByHostManager = detectHostManagerAncestor(env),
  prepareHostCodex = ensureHostCodexRuntime,
  verifyHostReady = verifyHostControlReady,
} = {}) {
  const options = parseArgs(args);
  if (options.help) return { help: usage() };
  if (platform !== 'linux') throw new Error('This PM2 launch script only supports Linux.');

  const configPath = resolve(projectRoot, '.link-bot/config.json');
  await access(configPath).catch(() => {
    throw new Error(`Missing required config: ${configPath}`);
  });

  const entry = resolve(projectRoot, options.entry);
  if (options.skipBuild) {
    await access(entry).catch(() => { throw new Error(`Missing prebuilt entry: ${entry}`); });
  } else {
    await commandRunner('npm', ['run', 'build'], { cwd: projectRoot });
  }
  const diskConfig = JSON.parse(await readFile(configPath, 'utf8'));
  if (diskConfig.codex?.command) {
    const command = await prepareHostCodex(projectRoot, { commandRunner, env, command: diskConfig.codex.command });
    if (diskConfig.codex.command !== command) {
      diskConfig.codex.command = command;
      const mode = (await stat(configPath)).mode & 0o777;
      const staged = `${configPath}.${process.pid}.tmp`;
      await writeFile(staged, `${JSON.stringify(diskConfig, null, 2)}\n`, { mode });
      await rename(staged, configPath);
    }
  }
  await configurePm2LogRotation(commandRunner, projectRoot, diskConfig.pm2LogRotation);
  if (diskConfig.hostControl?.enabled) {
    const managerName = diskConfig.hostControl.managerProcessName || 'link-bot-host-manager';
    const managerEntry = resolve(projectRoot, 'dist/src/host-manager.js');
    if (options.skipBuild) {
      await access(managerEntry).catch(() => { throw new Error(`Missing prebuilt host manager: ${managerEntry}`); });
    }
    const restartRequestPath = resolve(projectRoot, '.link-bot/host-manager-restart-request.json');
    const deferManagerRestart = invokedByHostManager || await hasPendingRestart(restartRequestPath, managerName);
    if (deferManagerRestart) {
      await writeFile(restartRequestPath, JSON.stringify({
        managerName, requestedAt: new Date().toISOString(), requestedBy: 'host-control',
        state: 'requested', updatedAt: new Date().toISOString(),
      }), { encoding: 'utf8', mode: 0o600 });
    } else if (await pm2ProcessExists(commandRunner, projectRoot, managerName)) {
      await commandRunner('pm2', ['restart', managerName, '--update-env'], { cwd: projectRoot });
    } else {
      await commandRunner('pm2', ['start', managerEntry, '--name', managerName], { cwd: projectRoot });
    }
  }
  if (await pm2ProcessExists(commandRunner, projectRoot, options.processName)) {
    await commandRunner('pm2', ['restart', options.processName, '--update-env'], { cwd: projectRoot });
  } else {
    await commandRunner('pm2', ['start', entry, '--name', options.processName], { cwd: projectRoot });
  }
  await commandRunner('pm2', ['save'], { cwd: projectRoot });
  if (diskConfig.hostControl?.enabled) {
    await verifyHostReady(resolve(projectRoot, diskConfig.hostControl.socketPath ?? '.link-bot/host-control.sock'));
  }
  return { entry, processName: options.processName };
}

export function normalizePm2LogRotation(value) {
  if (value === undefined) return { ...DEFAULT_LOG_ROTATION };
  if (!isObject(value)) throw new Error('pm2LogRotation must be an object.');
  const enabled = optionalBoolean(value.enabled, DEFAULT_LOG_ROTATION.enabled, 'pm2LogRotation.enabled');
  const maxSize = optionalString(value.maxSize, DEFAULT_LOG_ROTATION.maxSize, 'pm2LogRotation.maxSize');
  if (!/^\d+(?:K|M|G)$/i.test(maxSize)) throw new Error('pm2LogRotation.maxSize must use K, M, or G units.');
  const retain = boundedInteger(value.retain, DEFAULT_LOG_ROTATION.retain, 1, 90, 'pm2LogRotation.retain');
  const workerInterval = boundedInteger(
    value.workerInterval, DEFAULT_LOG_ROTATION.workerInterval, 1, 3600, 'pm2LogRotation.workerInterval',
  );
  return {
    enabled,
    maxSize,
    retain,
    compress: optionalBoolean(value.compress, DEFAULT_LOG_ROTATION.compress, 'pm2LogRotation.compress'),
    dateFormat: optionalString(value.dateFormat, DEFAULT_LOG_ROTATION.dateFormat, 'pm2LogRotation.dateFormat'),
    workerInterval,
    rotateInterval: optionalString(
      value.rotateInterval, DEFAULT_LOG_ROTATION.rotateInterval, 'pm2LogRotation.rotateInterval',
    ),
    rotateModule: optionalBoolean(
      value.rotateModule, DEFAULT_LOG_ROTATION.rotateModule, 'pm2LogRotation.rotateModule',
    ),
  };
}

export async function configurePm2LogRotation(commandRunner, projectRoot, rawConfig) {
  const config = normalizePm2LogRotation(rawConfig);
  if (!config.enabled) return config;
  if (!await pm2ProcessExists(commandRunner, projectRoot, 'pm2-logrotate')) {
    await commandRunner('pm2', ['install', 'pm2-logrotate'], { cwd: projectRoot });
  }
  const settings = [
    ['max_size', config.maxSize],
    ['retain', String(config.retain)],
    ['compress', String(config.compress)],
    ['dateFormat', config.dateFormat],
    ['workerInterval', String(config.workerInterval)],
    ['rotateInterval', config.rotateInterval],
    ['rotateModule', String(config.rotateModule)],
  ];
  for (const [key, setting] of settings) {
    await commandRunner('pm2', ['set', `pm2-logrotate:${key}`, setting], { cwd: projectRoot });
  }
  return config;
}

async function hasPendingRestart(path, managerName) {
  try {
    const request = JSON.parse(await readFile(path, 'utf8'));
    return request?.managerName === managerName && ['requested', 'ready', 'executing'].includes(request.state);
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return false;
    throw error;
  }
}

// A Codex shell can remove its own environment variables (for example with
// `env -u`), but it must not be able to turn a deferred self-restart into an
// immediate restart that kills the active App Server turn. On Linux, retain
// the trusted context by inspecting the inherited environment of ancestors.
export function detectHostManagerAncestor(env = process.env, startPid = process.ppid, read = readFileSync) {
  if (env.LINK_BOT_HOST_MANAGER === '1') return true;
  let pid = startPid;
  const visited = new Set();
  for (let depth = 0; pid > 1 && depth < 64 && !visited.has(pid); depth += 1) {
    visited.add(pid);
    try {
      const environment = read(`/proc/${pid}/environ`);
      if (environment.toString().split('\0').includes('LINK_BOT_HOST_MANAGER=1')) return true;
      const status = read(`/proc/${pid}/status`, 'utf8').toString();
      const parent = /^PPid:\s*(\d+)$/m.exec(status)?.[1];
      if (!parent) return false;
      pid = Number(parent);
    } catch {
      return false;
    }
  }
  return false;
}

function readValue(argv, index, option) {
  const value = argv[index];
  if (!value) throw new Error(`${option} requires a value.`);
  return value;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalBoolean(value, fallback, path) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean.`);
  return value;
}

function optionalString(value, fallback, path) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} must be a non-empty string.`);
  return value.trim();
}

function boundedInteger(value, fallback, minimum, maximum, path) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${path} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

async function pm2ProcessExists(commandRunner, cwd, processName) {
  try {
    await commandRunner('pm2', ['describe', processName], { cwd, silent: true });
    return true;
  } catch {
    return false;
  }
}

function runCommand(command, args, options) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.silent ? 'ignore' : 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolveCommand();
      else reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}.`));
    });
  });
}

export async function verifyHostControlReady(socketPath, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await new Promise((resolveReady, reject) => {
        const socket = createConnection(socketPath);
        let output = '';
        const timer = setTimeout(() => finish(new Error('Host control health request timed out.')), 1_000);
        function finish(error) {
          clearTimeout(timer);
          socket.destroy();
          if (error) reject(error); else resolveReady();
        }
        socket.setEncoding('utf8');
        socket.once('connect', () => socket.write(`${JSON.stringify({ message: {
          chatId: '__link_bot_health__', chatType: 'private', userId: '__link_bot_health__',
          messageId: '__link_bot_health__', text: '/status',
        } })}\n`));
        socket.on('data', (chunk) => { output += chunk; });
        socket.once('error', finish);
        socket.once('end', () => {
          try {
            const response = JSON.parse(output);
            if (response.ok !== true || !response.result?.reply?.startsWith('Host App Server')) {
              throw new Error('Invalid Host control health response.');
            }
            finish();
          } catch (error) { finish(error); }
        });
      });
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw new Error(`Host Manager did not become ready: ${error.message}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
}

function usage() {
  return `Usage: node scripts/launch-pm2-linux.mjs [options]\n\nOptions:\n  --process-name <name>  PM2 process name. Default: link-bot.\n  --entry <path>         App entrypoint. Default: dist/src/index.js.\n  --skip-build           Restart from prebuilt dist after checking entry files.\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  launchPm2()
    .then((result) => {
      if (result.help) console.log(result.help);
      else console.log(`PM2 process ${result.processName} launched from ${result.entry}.`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
