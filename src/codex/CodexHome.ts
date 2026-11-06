import { constants } from 'node:fs';
import { access, copyFile, lstat, readlink, rm, mkdir, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CodexHomePaths, CodexHomeSource } from '../domain/types.js';

export type CodexHomeConfigInitStatus = 'existing' | 'copied' | 'missing-default';

export interface CodexHomeInitializationResult {
  codexHome: string;
  configToml: CodexHomeConfigInitStatus;
  copiedFrom?: string;
}

export interface CodexHomeInitializationOptions {
  projectRoot: string;
  defaultCodexHome?: string;
}

export function resolveProjectCodexHome(projectRoot: string): string {
  return join(projectRoot, '.link-bot/codex-home');
}

export function resolveGlobalCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_HOME?.trim();
  return resolve(configured || join(env.HOME ?? '', '.codex'));
}

export function resolveCodexHomePaths(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): CodexHomePaths {
  return {
    project: resolveProjectCodexHome(projectRoot),
    global: resolveGlobalCodexHome(env),
  };
}

export function codexHomeForSource(
  paths: CodexHomePaths,
  source: CodexHomeSource = 'project',
): string {
  return paths[source];
}

export async function initializeProjectCodexHome(options: CodexHomeInitializationOptions): Promise<CodexHomeInitializationResult> {
  const codexHome = resolveProjectCodexHome(options.projectRoot);
  await mkdir(codexHome, { recursive: true });

  const defaultCodexHome = options.defaultCodexHome ?? defaultUserCodexHome();
  await initializeAuthSymlink(codexHome, defaultCodexHome);

  const localConfig = join(codexHome, 'config.toml');
  if (await pathExists(localConfig)) {
    return { codexHome, configToml: 'existing' };
  }

  const defaultConfig = join(defaultCodexHome, 'config.toml');
  if (!(await pathExists(defaultConfig))) {
    return { codexHome, configToml: 'missing-default' };
  }

  await copyFile(defaultConfig, localConfig);
  return { codexHome, configToml: 'copied', copiedFrom: defaultConfig };
}

function defaultUserCodexHome(): string {
  return join(process.env.HOME ?? '', '.codex');
}

async function initializeAuthSymlink(codexHome: string, defaultCodexHome: string): Promise<void> {
  const localAuth = join(codexHome, 'auth.json');
  const defaultAuth = join(defaultCodexHome, 'auth.json');
  if (!(await pathExists(defaultAuth))) {
    return;
  }

  const localAuthStat = await lstatOptional(localAuth);
  if (!localAuthStat) {
    await symlink(defaultAuth, localAuth);
    return;
  }

  if (!localAuthStat.isSymbolicLink()) {
    return;
  }

  const currentTarget = await readlink(localAuth);
  if (currentTarget === defaultAuth || (await pathExists(localAuth))) {
    return;
  }

  await rm(localAuth);
  await symlink(defaultAuth, localAuth);
}

async function lstatOptional(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
