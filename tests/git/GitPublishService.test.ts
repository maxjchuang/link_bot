import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  GitHubMergeRequestBroker, GitPublishService, RemoteAwareMergeRequestBroker,
  type MergeRequestBroker,
} from '../../src/git/GitPublishService.js';
import { SqliteStateStore } from '../../src/state/SqliteStateStore.js';
import { createTmpDir } from '../helpers/tmp.js';

const exec = promisify(execFile);

describe('GitPublishService', () => {
  it('requires owner confirmation and idempotently pushes one controlled branch and MR', async () => {
    const harness = await createHarness();
    await expect(exec('git', ['-C', harness.repository, 'push', 'origin', 'HEAD'])).rejects.toBeDefined();
    const request = await harness.service.request(requestInput(harness));
    await expect(harness.service.decide(request.id, 'ou_other', 'confirm')).rejects.toThrow('owner');

    const published = await harness.service.decide(request.id, 'ou_owner', 'confirm');
    expect(published).toMatchObject({ status: 'published', branchName: 'codex/ou_owner/task_1', mergeRequestId: 'mr_1' });
    await expect(harness.service.decide(request.id, 'ou_owner', 'confirm')).resolves.toMatchObject({ status: 'published' });
    expect(harness.mergeRequests.created).toHaveLength(1);
    const refs = (await exec('git', ['--git-dir', harness.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/codex/'])).stdout.trim().split('\n').filter(Boolean);
    expect(refs).toEqual(['refs/heads/codex/ou_owner/task_1']);
    harness.store.close();
  });

  it('keeps rejected, expired, and duplicate confirmations authoritative', async () => {
    const rejectedHarness = await createHarness();
    const rejected = await rejectedHarness.service.request(requestInput(rejectedHarness));
    await expect(rejectedHarness.service.decide(rejected.id, 'ou_owner', 'reject')).resolves.toMatchObject({ status: 'rejected' });
    await expect(rejectedHarness.service.decide(rejected.id, 'ou_owner', 'confirm')).resolves.toMatchObject({ status: 'rejected' });
    expect(rejectedHarness.mergeRequests.created).toHaveLength(0);
    rejectedHarness.store.close();

    const expiredHarness = await createHarness();
    const expired = await expiredHarness.service.request({ ...requestInput(expiredHarness), ttlMs: 1_000 });
    expiredHarness.now += 2_000;
    await expect(expiredHarness.service.decide(expired.id, 'ou_owner', 'confirm')).resolves.toMatchObject({ status: 'expired' });
    expect(expiredHarness.mergeRequests.created).toHaveLength(0);
    expiredHarness.store.close();
  });

  it('renews an expired approval window when the same publish is explicitly requested again', async () => {
    const harness = await createHarness();
    const input = { ...requestInput(harness), ttlMs: 1_000 };
    const first = await harness.service.request(input);
    harness.now += 2_000;

    const renewed = await harness.service.request(input);

    expect(renewed).toMatchObject({ id: first.id, status: 'pending' });
    expect(renewed.expiresAt).not.toBe(first.expiresAt);
    await expect(harness.service.decide(renewed.id, 'ou_owner', 'confirm'))
      .resolves.toMatchObject({ status: 'published' });
    expect(harness.mergeRequests.created).toHaveLength(1);
    harness.store.close();
  });

  it('reconciles an unknown MR outcome after the branch was pushed without pushing twice', async () => {
    const harness = await createHarness();
    harness.mergeRequests.failNextCreate = true;
    const request = await harness.service.request(requestInput(harness));

    await expect(harness.service.decide(request.id, 'ou_owner', 'confirm')).resolves.toMatchObject({ status: 'unknown' });
    await expect(harness.service.reconcile(request.id, 'ou_owner')).resolves.toMatchObject({ status: 'published', mergeRequestId: 'mr_1' });
    expect(harness.mergeRequests.created).toHaveLength(1);
    harness.store.close();
  });

  it('fast-forwards an existing branch without creating another merge request', async () => {
    const harness = await createHarness();
    const baseSha = (await exec('git', ['-C', harness.repository, 'rev-parse', 'main'])).stdout.trim();
    const headSha = (await exec('git', ['-C', harness.repository, 'rev-parse', 'HEAD'])).stdout.trim();
    await exec('git', ['--git-dir', harness.remote, 'branch', 'chore-reflux', baseSha]);

    const request = await harness.service.requestExistingBranch({
      taskId: 'task_1', ownerUserId: 'ou_owner', repositoryPath: harness.repository, remote: harness.remote,
      branchName: 'chore-reflux', expectedHeadSha: headSha, authorName: 'Owner User', authorEmail: 'owner@example.com',
    });
    await expect(harness.service.decide(request.id, 'ou_owner', 'confirm')).resolves.toMatchObject({
      status: 'published', publishMode: 'existing_branch', branchName: 'chore-reflux',
    });
    const remoteHead = (await exec('git', ['--git-dir', harness.remote, 'rev-parse', 'refs/heads/chore-reflux'])).stdout.trim();
    expect(remoteHead).toBe(headSha);
    expect(harness.mergeRequests.created).toEqual([]);
    harness.store.close();
  });

  it('force-updates a divergent non-protected branch only after owner confirmation', async () => {
    const harness = await createHarness();
    const baseSha = (await exec('git', ['-C', harness.repository, 'rev-parse', 'main'])).stdout.trim();
    const headSha = (await exec('git', ['-C', harness.repository, 'rev-parse', 'HEAD'])).stdout.trim();
    const treeSha = (await exec('git', ['-C', harness.repository, 'rev-parse', `${baseSha}^{tree}`])).stdout.trim();
    const divergent = (await exec('git', ['-C', harness.repository, 'commit-tree', treeSha, '-p', baseSha, '-m', 'divergent remote'])).stdout.trim();
    await exec('git', ['-C', harness.repository, 'push', harness.remote, `${divergent}:refs/heads/chore-rebased`]);

    const request = await harness.service.requestExistingBranch({
      taskId: 'task_1', ownerUserId: 'ou_owner', repositoryPath: harness.repository, remote: harness.remote,
      branchName: 'chore-rebased', expectedHeadSha: headSha, authorName: 'Owner User', authorEmail: 'owner@example.com',
    });
    expect(request).toMatchObject({ status: 'pending', forceUpdate: true, baseSha: divergent, headSha });
    expect((await exec('git', ['--git-dir', harness.remote, 'rev-parse', 'refs/heads/chore-rebased'])).stdout.trim()).toBe(divergent);
    await expect(harness.service.decide(request.id, 'ou_other', 'confirm')).rejects.toThrow('owner');
    await expect(harness.service.decide(request.id, 'ou_owner', 'confirm')).resolves.toMatchObject({
      status: 'published', forceUpdate: true,
    });
    expect((await exec('git', ['--git-dir', harness.remote, 'rev-parse', 'refs/heads/chore-rebased'])).stdout.trim()).toBe(headSha);
    harness.store.close();
  });

  it('rejects forbidden paths and secret-like additions before confirmation', async () => {
    const harness = await createHarness();
    await writeFile(join(harness.repository, '.env'), 'API_KEY="abcdefghijklmnop"\n');
    await exec('git', ['-C', harness.repository, 'add', '.env']);
    await exec('git', ['-C', harness.repository, 'commit', '-m', 'add secret']);

    await expect(harness.service.request(requestInput(harness))).rejects.toThrow('forbidden path');
    expect(harness.mergeRequests.created).toHaveLength(0);
    harness.store.close();
  });

  it('allows conventional environment templates while still validating their contents', async () => {
    const harness = await createHarness();
    await writeFile(join(harness.repository, '.env.example'), 'API_URL=https://example.test\n');
    await exec('git', ['-C', harness.repository, 'add', '.env.example']);
    await exec('git', ['-C', harness.repository, 'commit', '-m', 'document environment']);

    await expect(harness.service.request(requestInput(harness))).resolves.toMatchObject({ status: 'pending' });
    harness.store.close();

    const secretHarness = await createHarness();
    await writeFile(join(secretHarness.repository, '.env.local.example'), 'API_KEY="abcdefghijklmnop"\n');
    await exec('git', ['-C', secretHarness.repository, 'add', '.env.local.example']);
    await exec('git', ['-C', secretHarness.repository, 'commit', '-m', 'unsafe environment example']);
    await expect(secretHarness.service.request(requestInput(secretHarness))).rejects.toThrow('POSSIBLE_SECRET');
    secretHarness.store.close();
  });

  it('reports a non-retryable secret location without exposing its value', async () => {
    const harness = await createHarness();
    await writeFile(join(harness.repository, 'config.ts'), 'export const apiKey = "abcdefghijklmnop";\n');
    await exec('git', ['-C', harness.repository, 'add', 'config.ts']);
    await exec('git', ['-C', harness.repository, 'commit', '-m', 'add config']);

    await expect(harness.service.request(requestInput(harness))).rejects.toThrow(
      /NON_RETRYABLE\[POSSIBLE_SECRET\].*config\.ts:1.*Do not retry publishing the unchanged Head/,
    );
    harness.store.close();
  });

  it('explains when a commit was created from a different target branch', async () => {
    const harness = await createHarness();
    await exec('git', ['-C', harness.repository, 'checkout', 'main']);
    await exec('git', ['-C', harness.repository, 'checkout', '--orphan', 'develop']);
    await exec('git', ['-C', harness.repository, 'rm', '-rf', '.']);
    await writeFile(join(harness.repository, 'develop.txt'), 'develop\n');
    await exec('git', ['-C', harness.repository, 'add', 'develop.txt']);
    await exec('git', ['-C', harness.repository, 'commit', '-m', 'develop root']);
    await exec('git', ['-C', harness.repository, 'checkout', 'codex/ou_owner/task_1']);

    await expect(harness.service.request({ ...requestInput(harness), baseRef: 'develop' }))
      .rejects.toThrow(/not based on the latest remote target develop@[a-f0-9]{12}.*local branch refs are not authoritative/);
    harness.store.close();
  });
});

describe('GitHubMergeRequestBroker', () => {
  it('finds an existing idempotency marker before creating a pull request', async () => {
    const calls: string[][] = [];
    const outputs = ['[]', 'https://github.com/acme/repo/pull/42', '[{"number":42}]'];
    const broker = new GitHubMergeRequestBroker({
      run: async (_cwd, args) => { calls.push(args); return outputs.shift()!; },
    });

    await expect(broker.createOrUpdate({
      idempotencyKey: 'key_1', repositoryPath: '/repo', branchName: 'codex/ou/task', baseRef: 'main',
      title: 'Task', body: 'Body',
    })).resolves.toEqual({ id: '42' });
    await expect(broker.findByIdempotencyKey('key_1', '/repo')).resolves.toEqual({ id: '42' });
    expect(calls[1]).toEqual(expect.arrayContaining([
      'pr', 'create', '--head', 'codex/ou/task', '--base', 'main', '--body', expect.stringContaining('link-bot-idempotency:key_1'),
    ]));
  });
});

describe('PullRequestBroker', () => {
});

describe('RemoteAwareMergeRequestBroker', () => {

  it('fails clearly for an unsupported remote instead of guessing GitHub', async () => {
    const broker = new RemoteAwareMergeRequestBroker(
      fakeProvider('github', []), { run: async () => '/tmp/repo.git' },
    );
    await expect(broker.findByIdempotencyKey('key', '/repo')).rejects.toThrow('Unsupported merge request provider');
  });
});

async function createHarness() {
  const root = await createTmpDir();
  const repository = join(root, 'task-repo');
  const remote = join(root, 'remote.git');
  await exec('git', ['init', repository]);
  await exec('git', ['-C', repository, 'checkout', '-b', 'main']);
  await exec('git', ['-C', repository, 'config', 'user.name', 'Owner User']);
  await exec('git', ['-C', repository, 'config', 'user.email', 'owner@example.com']);
  await writeFile(join(repository, 'README.md'), 'base\n');
  await exec('git', ['-C', repository, 'add', 'README.md']);
  await exec('git', ['-C', repository, 'commit', '-m', 'base']);
  await exec('git', ['clone', '--bare', repository, remote]);
  await exec('git', ['-C', repository, 'checkout', '-b', 'codex/ou_owner/task_1']);
  await writeFile(join(repository, 'feature.txt'), 'feature\n');
  await exec('git', ['-C', repository, 'add', 'feature.txt']);
  await exec('git', ['-C', repository, 'commit', '-m', 'feature']);
  await exec('git', ['-C', repository, 'remote', 'add', 'origin', join(root, 'container-has-no-remote-credentials.git')]);
  let now = +new Date('2026-07-28T05:00:00.000Z');
  const clock = () => new Date(now);
  const store = new SqliteStateStore(join(root, 'state.sqlite'), clock);
  store.saveTask({
    id: 'task_1', ownerUserId: 'ou_owner', projectId: 'repo', baseRef: 'main', branchName: 'codex/ou_owner/task_1',
    runtimeState: 'hot', pinned: false, lastUserInteractionAt: clock().toISOString(),
    createdAt: clock().toISOString(), updatedAt: clock().toISOString(),
  });
  const mergeRequests = new FakeMergeRequestBroker();
  const service = new GitPublishService(store, mergeRequests, undefined, clock);
  return {
    repository, remote, store, mergeRequests, service,
    get now() { return now; },
    set now(value: number) { now = value; },
  };
}

function requestInput(harness: Awaited<ReturnType<typeof createHarness>>) {
  return {
    taskId: 'task_1', ownerUserId: 'ou_owner', repositoryPath: harness.repository,
    remote: harness.remote, baseRef: 'main', authorName: 'Owner User', authorEmail: 'owner@example.com',
  };
}

class FakeMergeRequestBroker implements MergeRequestBroker {
  readonly created: string[] = [];
  failNextCreate = false;
  async findByIdempotencyKey(key: string): Promise<{ id: string } | undefined> {
    return this.created.includes(key) ? { id: 'mr_1' } : undefined;
  }
  async createOrUpdate(input: { idempotencyKey: string }): Promise<{ id: string }> {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error('MR provider timeout with unknown outcome');
    }
    this.created.push(input.idempotencyKey);
    return { id: 'mr_1' };
  }
}

function fakeProvider(name: string, calls: string[]): MergeRequestBroker {
  return {
    findByIdempotencyKey: async () => { calls.push(name); return undefined; },
    createOrUpdate: async () => { calls.push(name); return { id: '1' }; },
  };
}
