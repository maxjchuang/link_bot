import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { TaskCredentialManager } from '../../src/runtime/TaskCredentialManager.js';
import { createTmpDir } from '../helpers/tmp.js';

it('keeps manager application credentials outside the task authentication projection', async () => {
  const root = await createTmpDir(), source = join(root, 'manager'), task = join(root, 'task');
  await mkdir(source);
  await writeFile(join(source, 'auth.json'), JSON.stringify({ token: 'fixture-codex-auth' }));
  await writeFile(join(source, 'tool-credentials.env'), 'LARK_APP_SECRET=fixture-manager-secret\n');
  await writeFile(join(source, 'config.json'), JSON.stringify({ appSecret: 'fixture-manager-secret' }));
  const manager = new TaskCredentialManager(source);
  expect(await manager.stageMinimumAuth(task)).toEqual(['auth.json']);
  expect(await readdir(task)).toEqual(['auth.json']);
  expect(await readFile(join(task, 'auth.json'), 'utf8')).not.toContain('fixture-manager-secret');
});

it('rejects a shared tool credential file during task authentication repair', async () => {
  const root = await createTmpDir();
  const target = { stop: vi.fn(async () => undefined), copyFile: vi.fn(async () => undefined) };
  await expect(new TaskCredentialManager(root).replaceFailedTaskAuth(target, [join(root, 'tool-credentials.env')]))
    .rejects.toThrow('minimum allowlist');
  expect(target.copyFile).not.toHaveBeenCalled();
});
