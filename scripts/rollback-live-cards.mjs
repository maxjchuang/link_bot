import { lstat, readFile, open, rename, unlink } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

/** Changes presentation flags only. No rebuild, database changes, service calls or automatic re-enable. */
export async function rollbackLiveCards({ projectRoot = process.cwd(), args = process.argv.slice(2), beforePublish } = {}) {
  if (args.includes('--apply') && args.includes('--dry-run')) throw new Error('Choose either --apply or --dry-run; nothing changed.');
  let apply = false, all = false, inline = false, processName = 'link-bot';
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--apply') apply = true;
    else if (args[index] === '--dry-run') apply = false;
    else if (args[index] === '--all-cards') all = true;
    else if (args[index] === '--inline-only') inline = true;
    else if (args[index] === '--process-name') processName = args[++index];
    else throw new Error('Usage: npm run livecards:rollback -- [--apply | --dry-run] [--all-cards | --inline-only] [--process-name NAME]');
  }
  if (all && inline) throw new Error('Choose either --all-cards or --inline-only; nothing changed.');
  const path = resolve(projectRoot, '.link-bot/config.json');
  const parent = await lstat(dirname(path)), info = await lstat(path);
  if (!parent.isDirectory() || parent.isSymbolicLink() || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Rollback requires a regular, unlinked config file in a real .link-bot directory.');
  const original = await readFile(path, 'utf8');
  let config;
  try { config = JSON.parse(original); } catch { throw new Error('Cannot parse config; nothing changed.'); }
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(config) || config.liveCards !== undefined && !object(config.liveCards)) throw new Error('Invalid config/liveCards shape; nothing changed.');
  for (const field of ['enabled', 'detailsEnabled', 'inlineDetailsEnabled']) if (config.liveCards?.[field] !== undefined && typeof config.liveCards[field] !== 'boolean') throw new Error('Invalid live-card flag type; nothing changed.');
  const next = { ...config, liveCards: { ...config.liveCards, ...(inline ? { inlineDetailsEnabled: false }
    : { detailsEnabled: false, ...(all ? { enabled: false } : {}) }) } };
  const processes = [processName];
  if (config.hostControl?.enabled === true) processes.push(config.hostControl.managerProcessName ?? 'link-bot-host-manager');
  if (processes.some((name) => typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(name))) throw new Error('Invalid process name; nothing changed.');
  const changed = JSON.stringify(config) !== JSON.stringify(next);
  const result = { applied: false, changed, mode: inline ? 'inline-only' : all ? 'all-cards' : 'details-only',
    flags: { enabled: next.liveCards.enabled ?? true, detailsEnabled: next.liveCards.detailsEnabled ?? false,
      ...(inline ? { inlineDetailsEnabled: false } : {}) },
    restartRequired: true, restartCommand: `pm2 restart ${[...new Set(processes)].join(' ')} --update-env` };
  if (!apply || !changed) return result;
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('Run rollback as the config file owner; nothing changed.');
  const suffix = randomUUID(), backup = join(dirname(path), `config.livecards-rollback-${suffix}.backup.json`), temporary = `${path}.rollback-${suffix}.tmp`;
  const save = async (file, text, mode, preserveOwner = false) => {
    const handle = await open(file, 'wx', mode);
    try {
      await handle.writeFile(text);
      if (preserveOwner) { await handle.chown(info.uid, info.gid); await handle.chmod(mode); }
      await handle.sync();
    } finally { await handle.close(); }
  };
  await save(backup, original, 0o600);
  let published = false;
  try {
    await save(temporary, `${JSON.stringify(next, null, 2)}\n`, info.mode & 0o777, true);
    await beforePublish?.();
    const current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.uid !== info.uid || current.gid !== info.gid
      || current.ino !== info.ino || current.dev !== info.dev || current.mode !== info.mode
      || await readFile(path, 'utf8') !== original) throw new Error('Config changed concurrently; rollback not published.');
    await rename(temporary, path); published = true;
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    return { ...result, applied: true, backup };
  } finally { if (!published) await unlink(temporary).catch(() => undefined); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  rollbackLiveCards().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(error instanceof Error ? error.message : 'Live-card rollback failed.'); process.exitCode = 1;
  });
}
