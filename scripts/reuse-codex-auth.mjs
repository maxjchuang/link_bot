#!/usr/bin/env node
import { mkdir, lstat, realpath, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
const source = resolve(process.argv[2] ?? join(homedir(), '.codex/auth.json'));
const targetHome = process.env.LINK_BOT_CODEX_HOME ?? join(homedir(), '.codex-link-bot');
const target = join(targetHome, 'auth.json');
try {
  const metadata = await lstat(source);
  if (!metadata.isFile() && !metadata.isSymbolicLink()) throw new Error();
  await mkdir(targetHome, { recursive: true, mode: 0o700 });
  try {
    await lstat(target);
    if (await realpath(target) !== await realpath(source)) {
      console.error('An independent login already exists; it was preserved.'); process.exitCode = 1;
    } else console.log('Existing shared login is already linked.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await symlink(source, target); console.log('Linked the existing auth file without copying credentials or global configuration.');
  }
} catch { console.error('Unable to link the selected authentication file. No credential values are printed.'); process.exitCode = 1; }
