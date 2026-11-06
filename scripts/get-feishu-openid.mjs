#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const DEFAULT_TIMEOUT_SECONDS = 120;

export function parseArgs(argv) {
  const options = { mode: 'wait', timeoutSeconds: DEFAULT_TIMEOUT_SECONDS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--all') options.mode = 'all';
    else if (arg === '--timeout') options.timeoutSeconds = positiveNumber(argv[++index], arg);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

export async function getFeishuOpenId({
  args = process.argv.slice(2),
  eventsDir = resolve(process.cwd(), '.link-bot/events'),
  now = () => Date.now(),
  wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
} = {}) {
  const options = parseArgs(args);
  if (options.help) return { help: usage() };
  const startedAt = now();

  if (options.mode === 'all') return { entries: await readOpenIds(eventsDir) };

  const deadline = startedAt + options.timeoutSeconds * 1_000;
  while (now() <= deadline) {
    const entries = await readOpenIds(eventsDir);
    const received = entries.find((entry) => entry.receivedAtMs >= startedAt);
    if (received) return { entries: [received] };
    await wait(500);
  }
  throw new Error(`Timed out after ${options.timeoutSeconds}s waiting for a Feishu message.`);
}

export async function readOpenIds(eventsDir) {
  const files = await readdir(eventsDir).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const entries = new Map();
  for (const file of files.filter((name) => name.endsWith('.jsonl')).sort().reverse()) {
    const path = join(eventsDir, file);
    if (!(await stat(path)).isFile()) continue;
    for (const line of (await readFile(path, 'utf8')).split('\n')) {
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        const userId = event?.data?.userId;
        if (event?.type !== 'command.received' || typeof userId !== 'string' || !userId.startsWith('ou_')) continue;
        const receivedAtMs = Date.parse(event.at);
        const previous = entries.get(userId);
        if (!previous || receivedAtMs > previous.receivedAtMs) {
          entries.set(userId, { openId: userId, receivedAt: event.at, receivedAtMs });
        }
      } catch {
        // Ignore incomplete or non-JSON event-log lines.
      }
    }
  }
  return [...entries.values()].sort((left, right) => right.receivedAtMs - left.receivedAtMs);
}

function positiveNumber(value, option) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${option} requires a positive number.`);
  return parsed;
}

function usage() {
  return `Usage: node scripts/get-feishu-openid.mjs [options]\n\nOptions:\n  --timeout <seconds>  Wait timeout. Default: ${DEFAULT_TIMEOUT_SECONDS}.\n  --all                List open IDs already present in local event logs.\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!options.help && options.mode === 'wait') {
      console.log('Send any text message to the Feishu bot now. Waiting for the sender open_id...');
    }
    const result = await getFeishuOpenId();
    if (result.help) console.log(result.help);
    else if (result.entries.length === 0) console.log('No Feishu user open IDs found.');
    else for (const entry of result.entries) console.log(`${entry.openId}\t${entry.receivedAt}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
