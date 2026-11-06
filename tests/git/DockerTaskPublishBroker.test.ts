import { describe, expect, it, vi } from 'vitest';
import type { BotConfig } from '../../src/domain/types.js';
import { DockerTaskPublishBroker } from '../../src/git/DockerTaskPublishBroker.js';
import type { GitCommandRunner, GitPublishService } from '../../src/git/GitPublishService.js';
import type { TaskRecord } from '../../src/tasks/TaskTypes.js';
import { sampleConfig } from '../helpers/fakes.js';

describe('DockerTaskPublishBroker', () => {
  it('publishes with the configured identity of the task actor', async () => {
    const git: GitCommandRunner = { run: vi.fn(async (_cwd, args) => args[0] === 'remote' ? 'git@github.com:example/repo.git' : '') };
    const publisher = { request: vi.fn(async () => ({ id: 'pub_identity' })) } as unknown as GitPublishService;
    const provisioner = { exportWorkspace: vi.fn(async () => '/manager/export/task_1'), exportRepository: vi.fn() };
    const config = sampleConfig('/repo') as BotConfig;
    config.gitIdentities = { ou_owner: { name: 'Owner Name', email: 'owner@example.com' } };

    await new DockerTaskPublishBroker(config, provisioner, publisher, git).request(task(), {
      chatId: 'oc_1', chatType: 'private', userId: 'ou_owner',
    });

    expect(publisher.request).toHaveBeenCalledWith(expect.objectContaining({
      authorName: 'Owner Name', authorEmail: 'owner@example.com',
    }));
  });

  it('creates a controlled manager-side commit for dirty exported workspaces', async () => {
    const calls: string[][] = [];
    const git: GitCommandRunner = {
      run: vi.fn(async (_cwd, args) => {
        calls.push(args);
        if (args[0] === 'remote') return 'git@github.com:acme/repo.git';
        return args[0] === 'status' ? ' M src/index.ts' : '';
      }),
    };
    const publisher = {
      request: vi.fn(async () => ({ id: 'pub_1' })),
    } as unknown as GitPublishService;
    const provisioner = {
      exportWorkspace: vi.fn(async () => '/manager/export/task_1'),
      exportRepository: vi.fn(async () => '/manager/export/task_1/repository_2'),
    };
    const broker = new DockerTaskPublishBroker(sampleConfig('/repo') as BotConfig, provisioner, publisher, git);

    await expect(broker.request(task(), {
      chatId: 'oc_1', chatType: 'private', userId: 'ou_owner',
    })).resolves.toEqual({ requestId: 'pub_1' });

    expect(calls).toEqual([
      ['remote', 'get-url', 'origin'],
      ['remote', 'set-url', 'origin', 'git@github.com:acme/repo.git'],
      ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
      ['config', '--local', 'user.name', 'Owner Name'],
      ['config', '--local', 'user.email', 'owner@example.com'],
      ['status', '--porcelain=v1'],
      ['add', '--all'],
      ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'link_bot task task_1'],
    ]);
    expect(publisher.request).toHaveBeenCalledWith(expect.objectContaining({
      repositoryPath: '/manager/export/task_1', authorName: 'Owner Name', authorEmail: 'owner@example.com',
    }));
  });

  it('exports and publishes only the selected add-on repository identity', async () => {
    const git: GitCommandRunner = {
      run: vi.fn(async (_cwd, args) => args[0] === 'remote' ? 'git@github.com:acme/repo2.git' : ''),
    };
    const publisher = { request: vi.fn(async () => ({ id: 'pub_2' })) } as unknown as GitPublishService;
    const provisioner = {
      exportWorkspace: vi.fn(async () => '/manager/export/task_1'),
      exportRepository: vi.fn(async () => '/manager/export/task_1/repository_2'),
    };
    const broker = new DockerTaskPublishBroker(sampleConfig('/repo') as BotConfig, provisioner, publisher, git);
    const repository = {
      id: 'repository_2', taskId: 'task_1', projectId: 'repo2', checkoutPath: '/workspace/repositories/repo2',
      baseRef: 'develop', branchName: 'codex/ou_owner/task_1/repo2', isPrimary: false, addedBy: 'ou_owner',
      status: 'ready' as const, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };

    await expect(broker.request(task(), {
      chatId: 'oc_1', chatType: 'private', userId: 'ou_owner',
    }, repository)).resolves.toEqual({ requestId: 'pub_2' });

    expect(provisioner.exportWorkspace).not.toHaveBeenCalled();
    expect(provisioner.exportRepository).toHaveBeenCalledWith(task(), repository);
    expect(publisher.request).toHaveBeenCalledWith(expect.objectContaining({
      repositoryId: 'repository_2', repositoryPath: '/manager/export/task_1/repository_2',
      baseRef: 'develop', branchName: 'codex/ou_owner/task_1/repo2',
    }));
  });

  it('requests a clean manager-side fast-forward to an existing non-protected branch', async () => {
    const git: GitCommandRunner = { run: vi.fn(async (_cwd, args) => {
      if (args[0] === 'remote') return 'git@github.com:example/repo.git';
      return '';
    }) };
    const publisher = { requestExistingBranch: vi.fn(async () => ({ id: 'pub_existing' })) } as unknown as GitPublishService;
    const provisioner = { exportWorkspace: vi.fn(), exportRepository: vi.fn(async () => '/manager/export/repo') };
    const config = sampleConfig('/repo') as BotConfig;
    const broker = new DockerTaskPublishBroker(config, provisioner, publisher, git);
    const repository = { id: 'repository_1', taskId: 'task_1', projectId: 'repo', checkoutPath: '/workspace/projects/repo',
      baseRef: 'main', branchName: 'codex/ou_owner/task_1/repo', isPrimary: false, addedBy: 'ou_owner', status: 'ready' as const,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

    await expect(broker.requestExistingBranch(task(), { chatId: 'oc_1', chatType: 'private', userId: 'ou_owner' }, repository,
      'chore-release-to-develop', 'abcdef1234567')).resolves.toEqual({ requestId: 'pub_existing' });
    expect(git.run).toHaveBeenCalledWith('/manager/export/repo', [
      'fetch', '--no-tags', 'origin', '+refs/heads/chore-release-to-develop:refs/remotes/origin/chore-release-to-develop',
    ]);
    expect(publisher.requestExistingBranch).toHaveBeenCalledWith(expect.objectContaining({
      branchName: 'chore-release-to-develop', expectedHeadSha: 'abcdef1234567', repositoryId: 'repository_1',
    }));
  });

  it('publishes a new branch against an explicit merge request base', async () => {
    const git: GitCommandRunner = { run: vi.fn(async (_cwd, args) => {
      if (args[0] === 'remote') return 'git@github.com:example/repo.git';
      return '';
    }) };
    const publisher = { request: vi.fn(async () => ({ id: 'pub_mr' })) } as unknown as GitPublishService;
    const provisioner = { exportWorkspace: vi.fn(), exportRepository: vi.fn(async () => '/manager/export/repo') };
    const broker = new DockerTaskPublishBroker(sampleConfig('/repo') as BotConfig, provisioner, publisher, git);
    const repository = { id: 'repository_1', taskId: 'task_1', projectId: 'repo', checkoutPath: '/workspace/projects/repo',
      baseRef: 'main', branchName: 'codex/ou_owner/task_1/repo', isPrimary: false, addedBy: 'ou_owner', status: 'ready' as const,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

    await expect(broker.requestMergeRequest(task(), { chatId: 'oc_1', chatType: 'private', userId: 'ou_owner' }, repository,
      'codex/fix-tracking-8.2', 'release-2026.8.2', 'abcdef1234567')).resolves.toEqual({ requestId: 'pub_mr' });
    expect(git.run).toHaveBeenCalledWith('/manager/export/repo', [
      'fetch', '--no-tags', 'origin', '+refs/heads/release-2026.8.2:refs/remotes/origin/release-2026.8.2',
    ]);
    expect(git.run).toHaveBeenCalledWith('/manager/export/repo', [
      'checkout', '-B', 'codex/fix-tracking-8.2', 'HEAD',
    ]);
    expect(publisher.request).toHaveBeenCalledWith(expect.objectContaining({
      branchName: 'codex/fix-tracking-8.2', baseRef: 'release-2026.8.2', baseRevision: 'origin/release-2026.8.2',
      expectedHeadSha: 'abcdef1234567', repositoryId: 'repository_1',
    }));
  });

  it('rejects a duplicate publish while the same repository export is still running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provisioner = {
      exportWorkspace: vi.fn(),
      exportRepository: vi.fn(async () => { await gate; return '/manager/export/repo'; }),
    };
    const git: GitCommandRunner = { run: vi.fn(async (_cwd, args) => args[0] === 'remote' ? 'git@github.com:example/repo.git' : '') };
    const publisher = { requestExistingBranch: vi.fn(async () => ({ id: 'pub_existing' })) } as unknown as GitPublishService;
    const broker = new DockerTaskPublishBroker(sampleConfig('/repo') as BotConfig, provisioner, publisher, git);
    const repository = { id: 'repository_1', taskId: 'task_1', projectId: 'repo', checkoutPath: '/workspace/projects/repo',
      baseRef: 'main', branchName: 'codex/ou_owner/task_1/repo', isPrimary: false, addedBy: 'ou_owner', status: 'ready' as const,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    const first = broker.requestExistingBranch(task(), actor(), repository, 'feature/existing', 'abcdef1234567');
    await vi.waitFor(() => expect(provisioner.exportRepository).toHaveBeenCalledOnce());

    await expect(broker.requestExistingBranch(task(), actor(), repository, 'feature/existing', 'abcdef1234567'))
      .rejects.toThrow('MANAGER_OPERATION_BUSY');
    release();
    await first;
  });

  it('removes the exported repository after a terminal publish decision', async () => {
    const removeExportedPath = vi.fn(async () => undefined);
    const provisioner = { exportWorkspace: vi.fn(), exportRepository: vi.fn(), removeExportedPath };
    const publisher = { decide: vi.fn(async () => ({
      status: 'published', repositoryPath: '/manager/export/task_1/repository_1',
      branchName: 'feature/test', mergeRequestId: '1',
    })) } as unknown as GitPublishService;
    const broker = new DockerTaskPublishBroker(sampleConfig('/repo') as BotConfig, provisioner, publisher);

    await expect(broker.decide('pub_1', 'ou_owner', 'confirm')).resolves.toContain('Published');
    expect(removeExportedPath).toHaveBeenCalledWith('/manager/export/task_1/repository_1');
  });

  it('removes an exported workspace when request preparation fails', async () => {
    const removeExportedPath = vi.fn(async () => undefined);
    const provisioner = {
      exportWorkspace: vi.fn(async () => '/manager/export/task_1'), exportRepository: vi.fn(), removeExportedPath,
    };
    const git: GitCommandRunner = { run: vi.fn(async () => { throw new Error('remote unavailable'); }) };
    const publisher = { request: vi.fn() } as unknown as GitPublishService;
    const broker = new DockerTaskPublishBroker(sampleConfig('/repo') as BotConfig, provisioner, publisher, git);

    await expect(broker.request(task(), actor())).rejects.toThrow('remote unavailable');
    expect(removeExportedPath).toHaveBeenCalledWith('/manager/export/task_1');
    expect(publisher.request).not.toHaveBeenCalled();
  });

  it('keeps the exported repository while a publish result needs reconciliation', async () => {
    const removeExportedPath = vi.fn(async () => undefined);
    const provisioner = { exportWorkspace: vi.fn(), exportRepository: vi.fn(), removeExportedPath };
    const publisher = { decide: vi.fn(async () => ({
      status: 'unknown', repositoryPath: '/manager/export/task_1/repository_1', branchName: 'feature/test',
    })) } as unknown as GitPublishService;
    const broker = new DockerTaskPublishBroker(sampleConfig('/repo') as BotConfig, provisioner, publisher);

    await expect(broker.decide('pub_1', 'ou_owner', 'confirm')).resolves.toContain('unknown');
    expect(removeExportedPath).not.toHaveBeenCalled();
  });
});

function actor() {
  return { chatId: 'oc_1', chatType: 'private' as const, userId: 'ou_owner' };
}

function task(): TaskRecord {
  return {
    id: 'task_1', ownerUserId: 'ou_owner', projectId: 'repo', baseRef: 'main',
    branchName: 'codex/ou_owner/task_1', runtimeState: 'warm', pinned: false,
    lastUserInteractionAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}
