import { lstat, mkdir, readFile, readlink, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  codexHomeForSource,
  initializeProjectCodexHome,
  resolveGlobalCodexHome,
  resolveProjectCodexHome,
} from '../../src/codex/CodexHome.js';
import { createTmpDir } from '../helpers/tmp.js';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

describe('CodexHome', () => {
  it('resolves the global home from non-empty CODEX_HOME before HOME', () => {
    expect(resolveGlobalCodexHome({ HOME: '/users/example', CODEX_HOME: '/shared/codex' })).toBe('/shared/codex');
    expect(resolveGlobalCodexHome({ HOME: '/users/example', CODEX_HOME: '   ' })).toBe('/users/example/.codex');
  });

  it('maps legacy and explicit sources through trusted application paths', () => {
    const paths = { project: '/repo/.link-bot/codex-home', global: '/users/example/.codex' };

    expect(codexHomeForSource(paths)).toBe(paths.project);
    expect(codexHomeForSource(paths, 'project')).toBe(paths.project);
    expect(codexHomeForSource(paths, 'global')).toBe(paths.global);
  });

  it('resolves to the project-local codex home and ignores CODEX_HOME', async () => {
    const root = await createTmpDir();
    const original = process.env.CODEX_HOME;
    process.env.CODEX_HOME = '/tmp/shared-codex-home';
    try {
      expect(resolveProjectCodexHome(root)).toBe(join(root, '.link-bot/codex-home'));
    } finally {
      if (original === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = original;
      }
    }
  });

  it('copies only default config.toml when local config is missing', async () => {
    const root = await createTmpDir();
    const defaultHome = join(root, 'default-codex');
    await mkdir(defaultHome, { recursive: true });
    await writeFile(join(defaultHome, 'config.toml'), 'model = "gpt-5.5"\n', 'utf8');
    await writeFile(join(defaultHome, 'hooks.json'), '{"hooks":{}}\n', 'utf8');

    const result = await initializeProjectCodexHome({ projectRoot: root, defaultCodexHome: defaultHome });

    expect(result).toEqual({
      codexHome: join(root, '.link-bot/codex-home'),
      configToml: 'copied',
      copiedFrom: join(defaultHome, 'config.toml'),
    });
    await expect(readFile(join(root, '.link-bot/codex-home/config.toml'), 'utf8')).resolves.toBe('model = "gpt-5.5"\n');
    await expect(exists(join(root, '.link-bot/codex-home/hooks.json'))).resolves.toBe(false);
  });

  it('symlinks default auth.json when local auth is missing', async () => {
    const root = await createTmpDir();
    const defaultHome = join(root, 'default-codex');
    await mkdir(defaultHome, { recursive: true });
    await writeFile(join(defaultHome, 'auth.json'), '{"token":"shared"}\n', 'utf8');

    const result = await initializeProjectCodexHome({ projectRoot: root, defaultCodexHome: defaultHome });
    const localAuth = join(result.codexHome, 'auth.json');

    await expect(lstat(localAuth)).resolves.toMatchObject({ isSymbolicLink: expect.any(Function) });
    expect((await lstat(localAuth)).isSymbolicLink()).toBe(true);
    await expect(readlink(localAuth)).resolves.toBe(join(defaultHome, 'auth.json'));
  });

  it('does not overwrite an existing project-local auth.json', async () => {
    const root = await createTmpDir();
    const defaultHome = join(root, 'default-codex');
    const localHome = resolveProjectCodexHome(root);
    await mkdir(defaultHome, { recursive: true });
    await mkdir(localHome, { recursive: true });
    await writeFile(join(defaultHome, 'auth.json'), '{"token":"shared"}\n', 'utf8');
    await writeFile(join(localHome, 'auth.json'), '{"token":"local"}\n', 'utf8');

    await initializeProjectCodexHome({ projectRoot: root, defaultCodexHome: defaultHome });

    await expect(readFile(join(localHome, 'auth.json'), 'utf8')).resolves.toBe('{"token":"local"}\n');
  });

  it('repairs a broken project-local auth.json symlink', async () => {
    const root = await createTmpDir();
    const defaultHome = join(root, 'default-codex');
    const localHome = resolveProjectCodexHome(root);
    await mkdir(defaultHome, { recursive: true });
    await mkdir(localHome, { recursive: true });
    await writeFile(join(defaultHome, 'auth.json'), '{"token":"shared"}\n', 'utf8');
    await symlink(join(root, 'missing-auth.json'), join(localHome, 'auth.json'));

    await initializeProjectCodexHome({ projectRoot: root, defaultCodexHome: defaultHome });

    await expect(readlink(join(localHome, 'auth.json'))).resolves.toBe(join(defaultHome, 'auth.json'));
  });

  it('does not overwrite an existing project-local config.toml', async () => {
    const root = await createTmpDir();
    const defaultHome = join(root, 'default-codex');
    const localHome = resolveProjectCodexHome(root);
    await mkdir(defaultHome, { recursive: true });
    await mkdir(localHome, { recursive: true });
    await writeFile(join(defaultHome, 'config.toml'), 'model = "default"\n', 'utf8');
    await writeFile(join(localHome, 'config.toml'), 'model = "local"\n', 'utf8');

    const result = await initializeProjectCodexHome({ projectRoot: root, defaultCodexHome: defaultHome });

    expect(result.configToml).toBe('existing');
    await expect(readFile(join(localHome, 'config.toml'), 'utf8')).resolves.toBe('model = "local"\n');
  });

  it('creates only the local directory when default config.toml is missing', async () => {
    const root = await createTmpDir();
    const defaultHome = join(root, 'missing-default-codex');

    const result = await initializeProjectCodexHome({ projectRoot: root, defaultCodexHome: defaultHome });

    expect(result).toEqual({
      codexHome: join(root, '.link-bot/codex-home'),
      configToml: 'missing-default',
    });
    await expect(exists(join(root, '.link-bot/codex-home'))).resolves.toBe(true);
    await expect(exists(join(root, '.link-bot/codex-home/config.toml'))).resolves.toBe(false);
  });

  it('resolves different project roots to different codex homes', async () => {
    const parent = await createTmpDir();
    expect(resolveProjectCodexHome(join(parent, 'a'))).toBe(join(parent, 'a/.link-bot/codex-home'));
    expect(resolveProjectCodexHome(join(parent, 'b'))).toBe(join(parent, 'b/.link-bot/codex-home'));
  });
});
