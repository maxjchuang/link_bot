import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { rollbackLiveCards } from '../../scripts/rollback-live-cards.mjs';

async function fixture(extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'linkbot-flag-rollback-')), directory = join(root, '.link-bot');
  await mkdir(directory, { mode: 0o700 });
  const config = { feishu: { appSecret: 'fake-secret-never-print' }, liveCards: { enabled: true, detailsEnabled: true, refreshIntervalMs: 2500 },
    hostControl: { enabled: true, managerProcessName: 'my-host-manager' }, ...extra };
  const path = join(directory, 'config.json'); await writeFile(path, JSON.stringify(config), { mode: 0o640 });
  return { root, directory, config, path };
}
describe('live-card configuration rollback', () => {
  it('rolls back only inline details, preserves normal cards/privacy, and previews without writing', async () => {
    const f = await fixture({ sensitiveReplyDeliveryEnabled: true,
      liveCards: { enabled: true, detailsEnabled: true, inlineDetailsEnabled: true, refreshIntervalMs: 1000 } });
    const before = await readFile(f.path, 'utf8');
    const preview = await rollbackLiveCards({ projectRoot: f.root, args: ['--inline-only'] });
    expect(preview).toMatchObject({ applied: false, mode: 'inline-only', flags: { enabled: true, detailsEnabled: true, inlineDetailsEnabled: false } });
    expect(await readFile(f.path, 'utf8')).toBe(before);
    const result = await rollbackLiveCards({ projectRoot: f.root, args: ['--inline-only', '--apply'] });
    expect(JSON.parse(await readFile(f.path, 'utf8'))).toEqual({ ...f.config, liveCards: { ...f.config.liveCards, inlineDetailsEnabled: false } });
    expect(await readFile(result.backup, 'utf8')).toBe(before);
  });
  it('refuses ambiguous rollback modes without writing', async () => {
    const f = await fixture();
    await expect(rollbackLiveCards({ projectRoot: f.root, args: ['--inline-only', '--all-cards', '--apply'] })).rejects.toThrow('either');
    expect(await readdir(f.directory)).toEqual(['config.json']);
  });
  it('previews by default without writing, restarting, or exposing credentials', async () => {
    const f = await fixture(), before = await readFile(f.path, 'utf8');
    const result = await rollbackLiveCards({ projectRoot: f.root, args: [] });
    expect(result).toMatchObject({ applied: false, changed: true, flags: { enabled: true, detailsEnabled: false }, restartRequired: true,
      restartCommand: 'pm2 restart link-bot my-host-manager --update-env' });
    expect(await readFile(f.path, 'utf8')).toBe(before); expect(await readdir(f.directory)).toEqual(['config.json']);
    expect(JSON.stringify(result)).not.toContain('fake-secret');
  });
  it('atomically disables only the new UI, retaining all other configuration and a private backup', async () => {
    const f = await fixture(), before = await readFile(f.path, 'utf8');
    const originalMode = (await stat(f.path)).mode & 0o777;
    const result = await rollbackLiveCards({ projectRoot: f.root, args: ['--apply'] });
    expect(JSON.parse(await readFile(f.path, 'utf8'))).toEqual({ ...f.config, liveCards: { ...f.config.liveCards, detailsEnabled: false } });
    expect(await readFile(result.backup, 'utf8')).toBe(before); expect((await stat(result.backup)).mode & 0o777).toBe(0o600);
    expect((await stat(f.path)).mode & 0o777).toBe(originalMode);
    expect((await rollbackLiveCards({ projectRoot: f.root, args: ['--apply'] })).changed).toBe(false);
    expect(await readdir(f.directory)).toHaveLength(2); expect(JSON.stringify(result)).not.toContain('fake-secret');
  });
  it('supports the second-level all-card fallback and custom gateway process names', async () => {
    const f = await fixture({ hostControl: { enabled: false } });
    const result = await rollbackLiveCards({ projectRoot: f.root, args: ['--all-cards', '--apply', '--process-name', 'my-bot'] });
    expect(result.flags).toEqual({ enabled: false, detailsEnabled: false });
    expect(result.restartCommand).toBe('pm2 restart my-bot --update-env');
    expect(JSON.parse(await readFile(f.path, 'utf8')).liveCards).toMatchObject({ enabled: false, detailsEnabled: false, refreshIntervalMs: 2500 });
  });
  it('refuses concurrent edits and keeps the latest user configuration', async () => {
    const f = await fixture(), newer = { ...f.config, logLevel: 'debug' };
    await expect(rollbackLiveCards({ projectRoot: f.root, args: ['--apply'], beforePublish: () => writeFile(f.path, JSON.stringify(newer)) }))
      .rejects.toThrow('concurrently');
    expect(JSON.parse(await readFile(f.path, 'utf8'))).toEqual(newer);
    expect((await readdir(f.directory)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });
  it.each(['{"token":"fake-secret-invalid"', '{"liveCards":[]}', '{"liveCards":{"enabled":"false"}}'])('refuses invalid input without leaking its contents', async (text) => {
    const f = await fixture(); await writeFile(f.path, text);
    await expect(rollbackLiveCards({ projectRoot: f.root, args: ['--apply'] })).rejects.not.toThrow('fake-secret');
    expect(await readFile(f.path, 'utf8')).toBe(text); expect(await readdir(f.directory)).toEqual(['config.json']);
  });
  it('refuses symlinked configuration and invalid command names without changing either file', async () => {
    const f = await fixture();
    await expect(rollbackLiveCards({ projectRoot: f.root, args: ['--dry-run', '--apply'] })).rejects.toThrow('either');
    await expect(rollbackLiveCards({ projectRoot: f.root, args: ['--apply', '--process-name', '--delete'] })).rejects.toThrow('Invalid process name');
    const other = join(f.directory, 'other.json'); await writeFile(other, JSON.stringify(f.config));
    const linkedRoot = await mkdtemp(join(tmpdir(), 'linkbot-linked-rollback-')); await mkdir(join(linkedRoot, '.link-bot'));
    await symlink(other, join(linkedRoot, '.link-bot/config.json'));
    await expect(rollbackLiveCards({ projectRoot: linkedRoot, args: ['--apply'] })).rejects.toThrow('regular');
    expect(JSON.parse(await readFile(other, 'utf8'))).toEqual(f.config);
  });
});
