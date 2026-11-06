import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runSandboxRepositoryCreation } from '../../runtime/bin/link-bot-sandbox-repo-create.mjs';

async function roots() {
  const root = await mkdtemp(join(tmpdir(), 'repo-create-'));
  return { receiptRoot: join(root, 'receipts'), toolHome: join(root, 'tool-home') };
}
const github = {
  action: 'create', operationId: 'op_github_1', provider: 'github', namespace: 'owner', name: 'new-repo', private: true,
};

describe('sandbox repository creator', () => {

  it('preserves GitHub canonical casing through receipt readback', async () => {
    const dirs = await roots(); let views = 0;
    const runCli = vi.fn(async (_binary, args) => {
      if (args[0] === 'api') return { exitCode: 0, stdout: 'Owner\n', stderr: '' };
      if (args[1] === 'view') {
        if (++views === 1) return { exitCode: 1, stdout: '', stderr: '' };
        return { exitCode: 0, stderr: '', stdout: JSON.stringify({ id: 'gh_123', nameWithOwner: 'Owner/new-repo',
          sshUrl: 'git@github.com:Owner/new-repo.git', defaultBranchRef: { name: 'main' }, isPrivate: true }) };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    await runSandboxRepositoryCreation(github, { runCli, ...dirs });
    expect(await runSandboxRepositoryCreation({ ...github, action: 'readback' }, { runCli, ...dirs }))
      .toMatchObject({ status: 'created', canonicalPath: 'Owner/new-repo', cloneUrl: 'git@github.com:Owner/new-repo.git' });
  });

  it('creates a private GitHub repository with a README and keeps gh login under persistent tool home', async () => {
    const calls = [];
    const runCli = vi.fn(async (binary, args, options) => {
      calls.push({ binary, args, options });
      if (args[0] === 'api') return { stdout: 'owner\n', stderr: '', exitCode: 0 };
      if (args[0] === 'repo' && args[1] === 'view') {
        const views = calls.filter((call) => call.args[1] === 'view').length;
        return views === 1
          ? { stdout: '', stderr: 'not found', exitCode: 1 }
          : { stdout: JSON.stringify({ id: 'gh_123', nameWithOwner: 'owner/new-repo',
            sshUrl: 'git@github.com:owner/new-repo.git', defaultBranchRef: { name: 'main' },
            isPrivate: true, owner: { login: 'owner' } }), stderr: '', exitCode: 0 };
      }
      return { stdout: 'https://github.com/owner/new-repo\n', stderr: '', exitCode: 0 };
    });
    const dirs = await roots();

    expect(await runSandboxRepositoryCreation(github, { runCli, ...dirs })).toMatchObject({
      status: 'created', providerRepoId: 'gh_123', canonicalPath: 'owner/new-repo', defaultBranch: 'main',
    });
    expect(calls.find((call) => call.args[1] === 'create')?.args)
      .toEqual(['repo', 'create', 'owner/new-repo', '--private', '--add-readme']);
    expect(calls.every((call) => call.options.env.GH_CONFIG_DIR === join(dirs.toolHome, 'gh'))).toBe(true);
    expect((await stat(join(dirs.toolHome, 'gh'))).mode & 0o777).toBe(0o700);
  });

  it('returns auth_required without leaking token-shaped CLI errors', async () => {
    const runCli = vi.fn(async () => ({ stdout: '',
      stderr: 'not logged in; access_token=ghp_abcdefghijklmnopqrstuvwxyz123456', exitCode: 1 }));
    const result = await runSandboxRepositoryCreation({ ...github, action: 'validate' }, { runCli, ...await roots() });
    expect(result).toMatchObject({ status: 'auth_required' });
    expect(JSON.stringify(result)).not.toContain('ghp_');
  });

  it('never adopts a pre-existing same-name GitHub repository as this operation', async () => {
    const runCli = vi.fn(async (_binary, args) => args[0] === 'api'
      ? { stdout: 'owner\n', stderr: '', exitCode: 0 }
      : { stdout: JSON.stringify({ id: 'foreign', nameWithOwner: 'owner/new-repo',
        sshUrl: 'git@github.com:owner/new-repo.git', defaultBranchRef: { name: 'main' }, isPrivate: true }),
        stderr: '', exitCode: 0 });
    const result = await runSandboxRepositoryCreation(github, { runCli, ...await roots() });
    expect(result.status).toBe('exists_foreign');
    expect(runCli.mock.calls.some(([, args]) => args[1] === 'create')).toBe(false);
  });

  it('does not infer operation ownership from a same-name repository without a receipt', async () => {
    const runCli = vi.fn(async (_binary, args) => args[0] === 'api'
      ? { stdout: 'owner\n', stderr: '', exitCode: 0 }
      : { stdout: JSON.stringify({ id: 'gh_123', nameWithOwner: 'owner/new-repo',
        sshUrl: 'git@github.com:owner/new-repo.git', defaultBranchRef: { name: 'main' },
        isPrivate: true, owner: { login: 'owner' } }), stderr: '', exitCode: 0 });
    const result = await runSandboxRepositoryCreation({ ...github, action: 'readback' }, { runCli, ...await roots() });
    expect(result).toMatchObject({ status: 'exists_foreign', reason: 'unverified_existing_repository' });
  });

  it('does not persist token-shaped provider IDs from CLI readback as a repository receipt', async () => {
    const dirs = await roots();
    let views = 0;
    const runCli = vi.fn(async (_binary, args) => {
      if (args[0] === 'api') return { stdout: 'owner\n', stderr: '', exitCode: 0 };
      if (args[1] === 'view') {
        views += 1;
        return views === 1 ? { stdout: '', stderr: 'not found', exitCode: 1 }
          : { stdout: JSON.stringify({ id: 'ghp_abcdefghijklmnopqrstuvwxyz123456',
            nameWithOwner: 'owner/new-repo', sshUrl: 'git@github.com:owner/new-repo.git',
            defaultBranchRef: { name: 'main' }, isPrivate: true }), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const result = await runSandboxRepositoryCreation(github, { runCli, ...dirs });

    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('ghp_');
    await expect(readFile(join(dirs.receiptRoot, 'op_github_1.json'), 'utf8')).rejects.toThrow();
  });

  it('uses a matching sandbox receipt for duplicate create and readback instead of creating twice', async () => {
    let views = 0;
    const runCli = vi.fn(async (_binary, args) => {
      if (args[0] === 'api') return { stdout: 'owner\n', stderr: '', exitCode: 0 };
      if (args[1] === 'view') {
        views += 1;
        return views === 1 ? { stdout: '', stderr: 'not found', exitCode: 1 }
          : { stdout: JSON.stringify({ id: 'gh_123', nameWithOwner: 'owner/new-repo',
            sshUrl: 'git@github.com:owner/new-repo.git', defaultBranchRef: { name: 'main' },
            isPrivate: true, owner: { login: 'owner' } }), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const dirs = await roots();
    expect((await runSandboxRepositoryCreation(github, { runCli, ...dirs })).status).toBe('created');
    expect((await runSandboxRepositoryCreation(github, { runCli, ...dirs })).status).toBe('created');
    expect((await runSandboxRepositoryCreation({ ...github, action: 'readback' }, { runCli, ...dirs })).status).toBe('created');
    expect(runCli.mock.calls.filter(([, args]) => args[1] === 'create')).toHaveLength(1);
  });

  it('rejects a same-UID forged receipt containing a credential-bearing clone URL', async () => {
    const dirs = await roots();
    await mkdir(dirs.receiptRoot);
    await writeFile(join(dirs.receiptRoot, 'op_github_1.json'), JSON.stringify({
      status: 'created', operationId: 'op_github_1', provider: 'github', namespace: 'owner', name: 'new-repo',
      providerRepoId: 'gh_123', canonicalPath: 'owner/new-repo',
      cloneUrl: 'https://oauth2:ghp_abcdefghijklmnopqrstuvwxyz123456@github.com/owner/new-repo.git',
      defaultBranch: 'main', createdAt: '2026-10-08T00:00:00.000Z',
    }));
    const runCli = vi.fn();

    const result = await runSandboxRepositoryCreation(github, { runCli, ...dirs });

    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('ghp_');
    expect(runCli).not.toHaveBeenCalled();
  });

  it('rejects unsafe operation IDs before touching the filesystem or invoking a CLI', async () => {
    const runCli = vi.fn();
    await expect(runSandboxRepositoryCreation({ ...github, operationId: '../escape' }, {
      runCli, ...await roots(),
    })).rejects.toThrow('operationId');
    expect(runCli).not.toHaveBeenCalled();
  });
});
