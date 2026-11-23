import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {loadConfig} from '../../src/config/loadConfig.js';
import {createTmpDir} from '../helpers/tmp.js';

async function load(overrides: Record<string, unknown> = {}) {
  const root = await createTmpDir();
  await mkdir(join(root, '.link-bot'));
  await writeFile(join(root, '.link-bot/config.json'), JSON.stringify({
    feishu: {appId: 'fixture-app', appSecret: 'fixture-secret'},
    projects: [{id: 'fixture', name: 'Fixture', path: root}],
    output: {directMaxChars: 3000, chunkSize: 2000},
    codex: {command: 'codex'},
    upgrade: {adminUsers: ['ou_owner']},
    ...overrides,
  }));
  return loadConfig(root);
}

describe('personal-agent configuration', () => {
  it('defaults off without changing user or group admission', async () => {
    const c = await load();
    expect(c.personalAgent).toEqual({enabled: false});
    expect(c.allowUnlistedGroupUsers).toBe(false);
    expect(c.allowedUsers).toEqual([]);
  });

  it('accepts a fixed owner without enabling unlisted group users', async () => {
    const c = await load({personalAgent: {enabled: true, ownerUserId: 'ou_owner'}});
    expect(c.personalAgent).toEqual({enabled: true, ownerUserId: 'ou_owner'});
    expect(c.allowUnlistedGroupUsers).toBe(false);
  });

  it.each([null, [], true, 'on', {enabled: 'true'}, {enabled: true},
    {enabled: true, ownerUserId: ''}, {enabled: true, ownerUserId: '*'},
    {enabled: true, ownerUserId: 'ou_owner\n'}].map(value => [value]))('rejects malformed personal identity: %j', async (personalAgent) => {
    await expect(load({personalAgent})).rejects.toThrow('personalAgent');
  });

  it.each([
    {upgrade: {adminUsers: []}},
    {upgrade: {adminUsers: ['ou_other']}},
    {upgrade: {adminUsers: ['ou_owner', 'ou_other']}},
    {hostControl: {enabled: true, adminUsers: [], projectId: 'fixture'}},
    {dream: {administratorIds: ['ou_other']}},
    {codexHooks: {adminUsers: ['ou_other']}},
  ])('rejects conflicting administrative identities: %j', async (overrides) => {
    await expect(load({...overrides, personalAgent: {enabled: true, ownerUserId: 'ou_owner'}}))
      .rejects.toThrow('personalAgent');
  });

  it.each([
    {userSandboxes: {enabled: false}},
    {userSandboxes: {enabledOwners: ['ou_other']}},
    {userSandboxes: {legacyFallbackEnabled: true}},
    {restrictUsers: true, allowedUsers: ['ou_other']},
  ])('rejects an unavailable owner execution/maintenance path: %j', async (overrides) => {
    await expect(load({...overrides, personalAgent: {enabled: true, ownerUserId: 'ou_owner'}}))
      .rejects.toThrow('personalAgent');
  });

  it('accepts an owner-only host and restricted owner sandbox', async () => {
    await expect(load({
      personalAgent: {enabled: true, ownerUserId: 'ou_owner'},
      restrictUsers: true, allowedUsers: ['ou_owner'],
      hostControl: {enabled: true, adminUsers: ['ou_owner'], projectId: 'fixture'},
      userSandboxes: {enabledOwners: ['ou_owner']},
    })).resolves.toMatchObject({personalAgent: {enabled: true}});
  });

  it('keeps disabled-mode legacy configurations compatible', async () => {
    await expect(load({
      personalAgent: {enabled: false},
      upgrade: {adminUsers: ['ou_other']}, userSandboxes: {enabled: false},
    })).resolves.toMatchObject({personalAgent: {enabled: false}});
  });
});
