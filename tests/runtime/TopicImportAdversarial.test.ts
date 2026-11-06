import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UserSandboxDockerRuntime } from '../../src/runtime/UserSandboxDockerRuntime.js';
import type { DockerCommandRunner } from '../../src/runtime/DockerRuntime.js';
import { createTmpDir } from '../helpers/tmp.js';

const run = promisify(execFile);
const localPath = '/workspace/deepseek-harness';
const repositoryUrl = 'https://github.com/deepseek-ai/deepseek-harness.git';

/** Independent review fixture: real Git commands against disposable local files.
 * Only Docker transport and provider metadata are simulated; no live container,
 * application database, credentials, or network are used. */
async function fixture(options: { unborn?: boolean; origin?: string; canonical?: string; providerUnavailable?: boolean } = {}) {
  const root = await createTmpDir(), repo = join(root, 'deepseek-harness');
  await mkdir(repo);
  const git = async (...args: string[]) => (await run('git', ['-C', repo, ...args])).stdout.trim();
  await git('init');
  await git('symbolic-ref', 'HEAD', 'refs/heads/feature/local-analysis');
  await git('remote', 'add', 'origin', options.origin ?? repositoryUrl);
  if (!options.unborn) {
    await writeFile(join(repo, 'README.md'), 'original\n');
    await git('add', 'README.md');
    await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
    await writeFile(join(repo, 'README.md'), 'staged work\n');
    await git('add', 'README.md');
    await writeFile(join(repo, 'README.md'), 'unstaged work\n');
    await writeFile(join(repo, 'private-notes.txt'), 'untracked work\n');
  }
  const commands: string[][] = [];
  const runner: DockerCommandRunner = { run: async dockerArgs => {
    expect(dockerArgs.slice(0, 3)).toEqual(['exec', '--user', '10001:10001']);
    const args = dockerArgs.slice(4); commands.push(args);
    if (args[0] === 'gh') {
      expect(args.slice(0, 3)).toEqual(['gh', 'repo', 'view']);
      if (options.providerUnavailable) return { stdout: '', stderr: 'GitHub CLI login required', exitCode: 4 };
      return { stdout: JSON.stringify({ id: 'R_fixture_123', nameWithOwner: options.canonical ?? 'deepseek-ai/deepseek-harness', defaultBranchRef: { name: 'main' } }), stderr: '', exitCode: 0 };
    }
    if (args[0] === 'curl' && options.providerUnavailable) {
      expect(args.at(-1)).toBe('https://api.github.com/repos/deepseek-ai/deepseek-harness');
      return { stdout: JSON.stringify({ message: 'API rate limit exceeded' }), stderr: 'HTTP 403', exitCode: 22 };
    }
    if (args[0] !== 'git' && args[0] !== 'realpath') throw new Error(`Unexpected import command: ${args[0]}`);
    if (args[0] === 'git' && !['rev-parse', 'remote', 'symbolic-ref'].includes(args[3] ?? '')) throw new Error('Import attempted a non-inspection Git command.');
    const mapped = args.slice(1).map(arg => arg === localPath ? repo
      : arg.startsWith('/workspace/') ? join(root, arg.slice('/workspace/'.length)) : arg);
    try {
      const result = args[0] === 'realpath'
        ? { stdout: await realpath(mapped.at(-1)!), stderr: '' }
        : await run(args[0], mapped);
      return { ...result, stdout: result.stdout.replaceAll(root, '/workspace'), exitCode: 0 };
    } catch (error) {
      const result = error as { stdout?: string; stderr?: string; code?: number };
      return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: typeof result.code === 'number' ? result.code : 1 };
    }
  } };
  const docker = new UserSandboxDockerRuntime({ image: 'unused:test', bridgeRoot: root, cpuLimit: 1,
    memoryLimitBytes: 1024, pidLimit: 32, tmpfsLimitBytes: 1024, network: 'none', maxAppServersPerUser: 2, hostUid: 1001, hostGid: 1001 }, runner);
  const runtime = docker.describe({ id: 'fixture', ownerId: 'ou_fixture', generation: 1 });
  const snapshot = async () => ({ head: await git('rev-parse', 'HEAD'), branch: await git('symbolic-ref', '--short', 'HEAD'),
    status: await git('status', '--porcelain'), index: await git('ls-files', '-s'),
    readme: await readFile(join(repo, 'README.md'), 'utf8'), notes: await readFile(join(repo, 'private-notes.txt'), 'utf8') });
  return { root, repo, git, commands, docker, runtime, snapshot };
}

describe('topic import adversarial review — real Git fixtures', () => {
  it('validates an already-registered checkout without any provider access when the network is unavailable',async()=>{
    const f=await fixture({providerUnavailable:true}),before=await f.snapshot();
    expect(await f.docker.inspectLocalProject(f.runtime,localPath,repositoryUrl)).toEqual({localPath,branchName:'feature/local-analysis'});
    expect(f.commands.some(args=>args[0]==='gh'||args[0]==='curl')).toBe(false);
    expect(await f.snapshot()).toEqual(before);
  });

  it('imports even when provider login is missing and the API is rate limited, without changing local files',async()=>{
    const f=await fixture({providerUnavailable:true}),before=await f.snapshot();
    await expect(f.docker.inspectExistingProject(f.runtime,localPath,repositoryUrl)).resolves.toMatchObject({
      providerRepoId:expect.stringMatching(/^local:[a-f0-9]{64}$/),localPath,defaultBranch:'feature/local-analysis',
    });
    expect(f.commands.some(args=>['gh','curl'].includes(args[0]!))).toBe(false);
    expect(await f.snapshot()).toEqual(before);
  });
  it('preserves branch, HEAD, staged, unstaged and untracked content', async () => {
    const f = await fixture(), before = await f.snapshot();
    const result = await f.docker.inspectExistingProject(f.runtime, localPath, repositoryUrl);
    expect(result).toMatchObject({ localPath, branchName: 'feature/local-analysis', providerRepoId: expect.stringMatching(/^local:[a-f0-9]{64}$/), defaultBranch: 'feature/local-analysis' });
    expect(await f.snapshot()).toEqual(before);
    expect(f.commands.some(args => args.some(arg => ['clone', 'fetch', 'checkout', 'switch', 'reset', 'clean', 'push'].includes(arg)))).toBe(false);
  });

  it('rejects the wrong remote before consulting provider metadata', async () => {
    const f = await fixture(), before = await f.snapshot();
    await expect(f.docker.inspectExistingProject(f.runtime, localPath, 'https://github.com/other/repository.git')).rejects.toThrow('origin');
    expect(f.commands.some(args => args[0] === 'gh')).toBe(false);
    expect(await f.snapshot()).toEqual(before);
  });

  it('does not turn a missing clone into a download or a new directory', async () => {
    const f = await fixture();
    await expect(f.docker.inspectExistingProject(f.runtime, '/workspace/missing', repositoryUrl)).rejects.toThrow();
    expect(f.commands).toHaveLength(1);
    expect(f.commands[0]?.[0]).toBe('realpath');
  });

  it('rejects a symlink alias even when it leads to a valid repository', async () => {
    const f = await fixture();
    await symlink(f.repo, join(f.root, 'alias'));
    await expect(f.docker.inspectExistingProject(f.runtime, '/workspace/alias', repositoryUrl)).rejects.toThrow('root');
    expect(f.commands.some(args => args[0] === 'gh')).toBe(false);
  });

  it('accepts provider-canonical GitHub owner casing without rewriting the remote', async () => {
    const url = 'https://github.com/DeepSeek-AI/DeepSeek-Harness.git';
    const f = await fixture({ origin: url });
    const mixed=await f.docker.inspectExistingProject(f.runtime,localPath,url);
    const lower=await f.docker.inspectExistingProject(f.runtime,localPath,repositoryUrl);
    const ssh=await f.docker.inspectExistingProject(f.runtime,localPath,'git@github.com:deepseek-ai/deepseek-harness.git');
    expect(mixed.providerRepoId).toBe(lower.providerRepoId);
    expect(ssh.providerRepoId).toBe(lower.providerRepoId);
    expect(await f.git('remote', 'get-url', 'origin')).toBe(url);
  });

  it('rejects an unborn repository that has only git init plus an origin URL', async () => {
    const f = await fixture({ unborn: true });
    await expect(f.docker.inspectExistingProject(f.runtime, localPath, repositoryUrl)).rejects.toThrow();
  });

  it('keeps a detached HEAD and local changes without creating a branch', async () => {
    const f = await fixture(), head = await f.git('rev-parse', 'HEAD');
    await f.git('checkout', '--detach', head);
    const status = await f.git('status', '--porcelain'), index = await f.git('ls-files', '-s');
    const result = await f.docker.inspectExistingProject(f.runtime, localPath, repositoryUrl);
    expect(result.branchName).toMatch(/^detached@/);
    expect(await f.git('rev-parse', 'HEAD')).toBe(head);
    expect(await f.git('status', '--porcelain')).toBe(status);
    expect(await f.git('ls-files', '-s')).toBe(index);
  });
});
