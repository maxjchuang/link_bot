import { mkdir } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { DockerTaskProvisioner } from '../../src/runtime/DockerTaskProvisioner.js';
import { createTmpDir } from '../helpers/tmp.js';
import { GitIdentityResolver } from '../../src/git/GitIdentityResolver.js';

const testGitIdentities = new GitIdentityResolver({ ou_1: { name: 'Test User', email: 'test@example.com' } });

describe('DockerTaskProvisioner repository migration', () => {
  it('validates a resolved conflict copy before adopting it', async () => {
    const root = await createTmpDir();
    const baseCommit = 'a'.repeat(40);
    const docker = {
      describe: vi.fn(() => ({ taskId: 'task_1' })),
      runRepositoryMigrationGit: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      adoptRepositoryMigrationInTask: vi.fn(async () => undefined),
    };
    const provisioner = new DockerTaskProvisioner(docker as never, {} as never, root);
    const repository = { id: 'repository_1', taskId: 'task_1', projectId: 'repo', checkoutPath: '/workspace/projects/repo',
      baseRef: 'develop', branchName: 'task_branch', isPrimary: true, addedBy: 'ou_1', createdAt: '', updatedAt: '', status: 'ready' as const };
    const migration = { id: 'repository_migration_12345678901234567890', taskId: 'task_1', repositoryId: repository.id,
      projectId: 'repo', sourceBaseRef: 'develop', targetBaseRef: 'release', targetBaseCommit: baseCommit,
      state: 'conflict_waiting' as const, conflictPath: '/workspace/projects/repo.migration-12345678901234567890',
      requestedBy: 'ou_1', createdAt: '', updatedAt: '' };

    await expect(provisioner.finalizeRepositoryMigration({ id: 'task_1', runtimeId: 'runtime_1' } as never, repository, migration))
      .resolves.toEqual({ baseCommit });
    expect(docker.runRepositoryMigrationGit).toHaveBeenCalledWith(
      expect.anything(), migration.conflictPath, ['diff', '--name-only', '--diff-filter=U', '--'],
    );
    expect(docker.runRepositoryMigrationGit).toHaveBeenCalledWith(
      expect.anything(), migration.conflictPath, ['merge-base', '--is-ancestor', baseCommit, 'HEAD'],
    );
    expect(docker.adoptRepositoryMigrationInTask).toHaveBeenCalledWith(
      expect.anything(), migration.conflictPath, repository.checkoutPath,
    );
  });

  it('keeps the original repository when the conflict copy is still unmerged', async () => {
    const root = await createTmpDir();
    const docker = {
      describe: vi.fn(() => ({ taskId: 'task_1' })),
      runRepositoryMigrationGit: vi.fn(async () => ({ stdout: 'src/conflicted.ts\n', stderr: '', exitCode: 0 })),
      adoptRepositoryMigrationInTask: vi.fn(async () => undefined),
    };
    const provisioner = new DockerTaskProvisioner(docker as never, {} as never, root);
    const repository = { id: 'repository_1', taskId: 'task_1', projectId: 'repo', checkoutPath: '/workspace/projects/repo',
      baseRef: 'develop', branchName: 'task_branch', isPrimary: true, addedBy: 'ou_1', createdAt: '', updatedAt: '', status: 'ready' as const };
    const migration = { id: 'repository_migration_12345678901234567890', taskId: 'task_1', repositoryId: repository.id,
      projectId: 'repo', sourceBaseRef: 'develop', targetBaseRef: 'release', targetBaseCommit: 'a'.repeat(40),
      state: 'conflict_waiting' as const, conflictPath: '/workspace/projects/repo.migration-12345678901234567890',
      requestedBy: 'ou_1', createdAt: '', updatedAt: '' };

    await expect(provisioner.finalizeRepositoryMigration({ id: 'task_1' } as never, repository, migration))
      .rejects.toThrow('still has unresolved conflicts');
    expect(docker.adoptRepositoryMigrationInTask).not.toHaveBeenCalled();
  });

  it('builds the transferable patch from the recorded source base and switches only after validation', async () => {
    const root = await createTmpDir();
    const docker = {
      describe: vi.fn(() => ({ taskId: 'task_1' })),
      copyGitRepositorySnapshotFromTask: vi.fn(async () => undefined),
      replaceRepositoryInTask: vi.fn(async () => undefined),
      copyRepositoryToTask: vi.fn(async () => undefined),
    };
    const calls: string[][] = [];
    const git = { run: vi.fn(async (_cwd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'clone') await mkdir(args.at(-1)!, { recursive: true });
      if (args.join(' ') === 'remote get-url origin') return 'https://code.example/repo.git';
      if (args.join(' ') === 'config --get linkbot.export.originalHead') return 'target_commit';
      if (args[0] === 'rev-parse') return 'target_commit';
      return '';
    }), runRaw: vi.fn(async (_cwd: string, args: string[]) => {
      calls.push(args);
      return Buffer.from('binary patch\n');
    }) };
    const provisioner = new DockerTaskProvisioner(docker as never, {} as never, root, git, undefined, undefined, undefined, undefined, testGitIdentities);

    await expect(provisioner.migrateRepository(
      { id: 'task_1', ownerUserId: 'ou_1', projectId: 'repo', baseRef: 'develop', branchName: 'task_branch', runtimeState: 'hot', pinned: false, lastUserInteractionAt: '', createdAt: '', updatedAt: '' },
      { id: 'repo', name: 'Repo', path: root } as never,
      { id: 'repository_1', taskId: 'task_1', projectId: 'repo', checkoutPath: '/workspace/projects/repo', baseRef: 'develop', baseCommit: 'source_commit', branchName: 'task_branch', isPrimary: false, addedBy: 'ou_1', createdAt: '', updatedAt: '', status: 'ready' },
      'release-2026.8.3', 'migration_1',
    )).resolves.toEqual({ status: 'completed', baseCommit: 'target_commit', commitMappings: [] });

    expect(calls).toContainEqual(['diff', '--cached', '--binary', '--full-index', 'target_commit', '--']);
    expect(calls).toContainEqual(['reset', '--mixed', 'target_commit']);
    expect(docker.copyGitRepositorySnapshotFromTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task_1' }), '/workspace/projects/repo', expect.any(String),
    );
    expect(calls).toContainEqual(['diff', '--check']);
    expect(docker.replaceRepositoryInTask).toHaveBeenCalledOnce();
  });

  it('does not misreport a corrupt patch as a source conflict', async () => {
    const root = await createTmpDir();
    const docker = {
      describe: vi.fn(() => ({ taskId: 'task_1' })), copyGitRepositorySnapshotFromTask: vi.fn(async () => undefined),
      replaceRepositoryInTask: vi.fn(async () => undefined), copyRepositoryToTask: vi.fn(async () => undefined),
    };
    const git = {
      run: vi.fn(async (_cwd: string, args: string[]) => {
        if (args[0] === 'clone') await mkdir(args.at(-1)!, { recursive: true });
        if (args.join(' ') === 'remote get-url origin') return 'https://code.example/repo.git';
        if (args.join(' ') === 'config --get linkbot.export.originalHead') return 'target_commit';
        if (args[0] === 'rev-parse') return 'target_commit';
        if (args[0] === 'apply') throw new Error('Manager Git apply failed: error: corrupt patch at line 7');
        return '';
      }),
      runRaw: vi.fn(async () => Buffer.from('broken patch\n')),
    };
    const provisioner = new DockerTaskProvisioner(docker as never, {} as never, root, git, undefined, undefined, undefined, undefined, testGitIdentities);

    await expect(provisioner.migrateRepository(
      { id: 'task_1', ownerUserId: 'ou_1', projectId: 'repo', baseRef: 'develop', branchName: 'task_branch', runtimeState: 'hot', pinned: false, lastUserInteractionAt: '', createdAt: '', updatedAt: '' },
      { id: 'repo', name: 'Repo', path: root } as never,
      { id: 'repository_1', taskId: 'task_1', projectId: 'repo', checkoutPath: '/workspace/projects/repo', baseRef: 'develop', baseCommit: 'source_commit', branchName: 'task_branch', isPrimary: false, addedBy: 'ou_1', createdAt: '', updatedAt: '', status: 'ready' },
      'release-2026.8.3', 'migration_2',
    )).rejects.toThrow('corrupt patch');
    expect(docker.copyRepositoryToTask).not.toHaveBeenCalled();
  });

  it('fetches the advertised source HEAD instead of requesting task commits by raw SHA', async () => {
    const root = await createTmpDir();
    const docker = {
      describe: vi.fn(() => ({ taskId: 'task_1' })), copyGitRepositorySnapshotFromTask: vi.fn(async () => undefined),
      replaceRepositoryInTask: vi.fn(async () => undefined), copyRepositoryToTask: vi.fn(async () => undefined),
    };
    const calls: string[][] = [];
    let revParseCount = 0;
    const git = {
      run: vi.fn(async (_cwd: string, args: string[]) => {
        calls.push(args);
        if (args[0] === 'clone') await mkdir(args.at(-1)!, { recursive: true });
        if (args.join(' ') === 'remote get-url origin') return 'https://code.example/repo.git';
        if (args.join(' ') === 'config --get linkbot.export.originalHead') return 'source_head';
        if (args[0] === 'rev-list') return 'task_commit_1\ntask_commit_2';
        if (args[0] === 'cherry') return '+ task_commit_1\n+ task_commit_2';
        if (args[0] === 'rev-parse') return revParseCount++ === 0 ? 'source_head' : revParseCount === 2 ? 'target_base' : `mapped_${revParseCount}`;
        return '';
      }),
      runRaw: vi.fn(async () => Buffer.alloc(0)),
    };
    const provisioner = new DockerTaskProvisioner(docker as never, {} as never, root, git, undefined, undefined, undefined, undefined, testGitIdentities);

    await provisioner.migrateRepository(
      { id: 'task_1', ownerUserId: 'ou_1', projectId: 'repo', baseRef: 'develop', branchName: 'task_branch', runtimeState: 'hot', pinned: false, lastUserInteractionAt: '', createdAt: '', updatedAt: '' },
      { id: 'repo', name: 'Repo', path: root } as never,
      { id: 'repository_1', taskId: 'task_1', projectId: 'repo', checkoutPath: '/workspace/projects/repo', baseRef: 'develop', baseCommit: 'source_base', branchName: 'task_branch', isPrimary: false, addedBy: 'ou_1', createdAt: '', updatedAt: '', status: 'ready' },
      'release-2026.8.3', 'migration_3',
    );

    expect(calls).toContainEqual(['fetch', '--no-tags', expect.stringContaining('current'), 'HEAD:refs/link-bot/migration-source']);
    expect(calls.filter((args) => args[0] === 'fetch')).not.toContainEqual(expect.arrayContaining(['task_commit_1']));
    expect(calls).toContainEqual(['cherry-pick', 'task_commit_1']);
    expect(calls).toContainEqual(['cherry-pick', 'task_commit_2']);
  });

  it('skips commits whose patches already exist on the new baseline', async () => {
    const root = await createTmpDir();
    const docker = {
      describe: vi.fn(() => ({ taskId: 'task_1' })), copyGitRepositorySnapshotFromTask: vi.fn(async () => undefined),
      replaceRepositoryInTask: vi.fn(async () => undefined), copyRepositoryToTask: vi.fn(async () => undefined),
    };
    const calls: string[][] = [];
    let revParseCount = 0;
    const git = {
      run: vi.fn(async (_cwd: string, args: string[]) => {
        calls.push(args);
        if (args[0] === 'clone') await mkdir(args.at(-1)!, { recursive: true });
        if (args.join(' ') === 'remote get-url origin') return 'https://code.example/repo.git';
        if (args.join(' ') === 'config --get linkbot.export.originalHead') return 'source_head';
        if (args[0] === 'rev-list') return 'already_upstream\ntask_only';
        if (args[0] === 'cherry') return '- already_upstream\n+ task_only';
        if (args[0] === 'rev-parse') return revParseCount++ === 0 ? 'source_head' : revParseCount === 2 ? 'target_base' : 'mapped_task_only';
        return '';
      }),
      runRaw: vi.fn(async () => Buffer.alloc(0)),
    };
    const provisioner = new DockerTaskProvisioner(docker as never, {} as never, root, git, undefined, undefined, undefined, undefined, testGitIdentities);

    await provisioner.migrateRepository(
      { id: 'task_1', ownerUserId: 'ou_1', projectId: 'repo', baseRef: 'develop', branchName: 'task_branch', runtimeState: 'hot', pinned: false, lastUserInteractionAt: '', createdAt: '', updatedAt: '' },
      { id: 'repo', name: 'Repo', path: root } as never,
      { id: 'repository_1', taskId: 'task_1', projectId: 'repo', checkoutPath: '/workspace/projects/repo', baseRef: 'develop', baseCommit: 'stale_base', branchName: 'task_branch', isPrimary: false, addedBy: 'ou_1', createdAt: '', updatedAt: '', status: 'ready' },
      'release-2026.8.3', 'migration_4',
    );

    expect(calls).toContainEqual(['cherry', 'target_base', 'refs/link-bot/migration-source']);
    expect(calls).not.toContainEqual(['cherry-pick', 'already_upstream']);
    expect(calls).toContainEqual(['cherry-pick', 'task_only']);
  });
});
