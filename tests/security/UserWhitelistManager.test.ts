import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveMentionedOpenIds, UserWhitelistManager } from '../../src/security/UserWhitelistManager.js';
import { sampleConfig } from '../helpers/fakes.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('UserWhitelistManager', () => {
  it('resolves genuine Feishu mention placeholders and rejects unresolved text', () => {
    const mentions = [
      { key: '@_user_1', name: 'Alice', openId: 'ou_alice' },
      { key: '@_user_2', name: 'Bob', openId: 'ou_bob' },
    ];
    expect(resolveMentionedOpenIds(['@_user_1', '@Bob', '@_user_1'], mentions))
      .toEqual({ openIds: ['ou_alice', 'ou_bob'] });
    expect(resolveMentionedOpenIds(['ou_alice'], mentions)).toEqual({
      error: 'Unresolved Feishu user mention: ou_alice. Select the user with Feishu @ mention.',
    });
    expect(resolveMentionedOpenIds(['@Mallory'], mentions)).toMatchObject({ error: expect.stringContaining('@Mallory') });
  });

  it('atomically adds multiple unique users and updates live config', async () => {
    const { root, config, manager } = await harness(['ou_existing']);
    const reply = await manager.addUsers('ou_admin', ['ou_one', 'ou_two,ou_existing', 'ou_one']);

    expect(reply).toContain('Added to user whitelist: ou_one, ou_two');
    expect(reply).toContain('Already allowlisted: ou_existing');
    expect(config.allowedUsers).toEqual(['ou_existing', 'ou_one', 'ou_two']);
    const persisted = JSON.parse(await readFile(join(root, '.link-bot/config.json'), 'utf8'));
    expect(persisted.allowedUsers).toEqual(config.allowedUsers);
    expect(persisted.feishu.appSecret).toBe('secret');
    expect((await stat(join(root, '.link-bot/config.json'))).mode & 0o777).toBe(0o600);
  });

  it('rejects non-admin users without changing the config file', async () => {
    const { root, config, manager } = await harness([]);
    const before = await readFile(join(root, '.link-bot/config.json'), 'utf8');
    await expect(manager.addUsers('ou_other', ['ou_new'])).resolves.toBe('Only administrators can use /adduser.');
    expect(config.allowedUsers).toEqual([]);
    await expect(readFile(join(root, '.link-bot/config.json'), 'utf8')).resolves.toBe(before);
  });

  it('rejects missing and malformed open IDs', async () => {
    const { manager } = await harness([]);
    await expect(manager.addUsers('ou_admin', [])).resolves.toContain('Usage: /adduser');
    await expect(manager.addUsers('ou_admin', ['user_123'])).resolves.toBe('Invalid Feishu open_id: user_123');
  });
});

async function harness(allowedUsers: string[]) {
  const root = await createTmpDir();
  await mkdir(join(root, '.link-bot'), { recursive: true });
  const config = sampleConfig(root);
  config.allowedUsers = [...allowedUsers];
  config.upgrade.adminUsers = ['ou_admin'];
  await writeFile(join(root, '.link-bot/config.json'), JSON.stringify(config));
  return { root, config, manager: new UserWhitelistManager(root, config) };
}
