import { join } from 'node:path';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { SqliteStateStore } from '../../src/state/SqliteStateStore.js';
import type { TaskRecord } from '../../src/tasks/TaskTypes.js';
import type { TaskRuntimeProvisioner } from '../../src/tasks/TaskPlatformService.js';
import {
  SandboxProjectBootstrapError, UserSandboxTaskProvisioner, modeAwareTaskProvisioner,
} from '../../src/runtime/UserSandboxTaskProvisioner.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('UserSandboxTaskProvisioner', () => {
  it('preserves repository paths when resuming a legacy multi-project task', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'));
    const task: TaskRecord = { ...sandboxTask('task_legacy_resume'), runtimeMode: 'legacy-task-container' };
    const project = { id: 'repo', name: 'Repo', path: '/repo', codexArgs: [] };
    const repositories = [{
      id: 'repository_1', taskId: task.id, projectId: project.id, checkoutPath: '/workspace/projects/repo',
      baseRef: 'main', branchName: 'task_branch', isPrimary: false, addedBy: task.ownerUserId,
      createdAt: '', updatedAt: '', status: 'ready' as const,
    }];
    const resume = vi.fn(async () => ({ cwd: '/workspace', branchName: task.branchName }));
    const hybrid = modeAwareTaskProvisioner(store, { resume } as unknown as TaskRuntimeProvisioner,
      new UserSandboxTaskProvisioner(store, {} as never));

    await hybrid.resume(task, project, repositories);

    expect(resume).toHaveBeenCalledWith(task, project, repositories);
    store.close();
  });

  it('routes credential recovery to the owning sandbox without touching legacy containers', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'));
    const task = sandboxTask('task_auth');
    store.saveTask(task);
    const refresh = vi.fn(async () => undefined);
    const sandbox = new UserSandboxTaskProvisioner(store, { refreshCodexAuth: refresh } as never);
    const legacyRefresh = vi.fn(async () => undefined);
    const hybrid = modeAwareTaskProvisioner(store, { refreshCodexAuth: legacyRefresh } as unknown as TaskRuntimeProvisioner, sandbox);
    await hybrid.refreshCodexAuth!(task);
    expect(refresh).toHaveBeenCalledWith(task.ownerUserId);
    expect(legacyRefresh).not.toHaveBeenCalled();
    const legacy = { ...task, runtimeMode: 'legacy-task-container' as const };
    await hybrid.refreshCodexAuth!(legacy);
    expect(legacyRefresh).toHaveBeenCalledWith(legacy);
    store.close();
  });
  it('does not treat an auth-required empty project directory as checkout-ready', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'));
    const task: TaskRecord = { ...sandboxTask('task_auth_bind'), mode: 'chat', projectId: undefined, baseRef: '', branchName: '' };
    store.saveTask(task);
    const ensure = vi.fn(async () => ({ sandbox: { id: 'sandbox_1' } }));
    const ensureProjectWorkspace = vi.fn(async () => ({ projectId: 'repo', cwd: '/workspace/repo', status: 'auth_required' }));
    const provisioner = new UserSandboxTaskProvisioner(store, { ensure, ensureProjectWorkspace } as never);
    await expect(provisioner.prepareProjectBinding(task, { id: 'repo', name: 'Repo', path: '', codexArgs: [],
      sandboxCloneUrl: 'git@github.com:owner/repo.git', baseRef: 'main' })).rejects.toThrow('authentication');
    expect(store.getTask(task.id)?.mode).toBe('chat');
    expect(ensure).not.toHaveBeenCalled();
    store.close();
  });
  it('prepares a project checkout for a pending chat bind without relabeling or copying its scratch task', async () => {
    const root = await createTmpDir();
    const scratch = join(root, 'scratch');
    const checkout = join(root, 'checkout');
    await mkdir(scratch);
    await mkdir(checkout);
    await writeFile(join(scratch, 'draft.md'), 'private scratch draft');
    const store = new SqliteStateStore(join(root, 'state.sqlite'));
    const task: TaskRecord = { ...sandboxTask('task_chat_bind'), mode: 'chat', projectId: undefined, baseRef: '', branchName: '' };
    store.saveTask(task);
    const ensure = vi.fn(async () => ({ sandbox: { id: 'sandbox_1' } }));
    const ensureProjectWorkspace = vi.fn(async () => ({ projectId: 'repo', cwd: checkout, status: 'ready' }));
    const provisioner = new UserSandboxTaskProvisioner(store, { ensure, ensureProjectWorkspace } as never);

    await expect(provisioner.prepareProjectBinding(task, {
      id: 'repo', name: 'Repo', path: '/repo', repositoryPath: 'team/repo', codexArgs: [], baseRef: 'develop',
    })).resolves.toMatchObject({ cwd: checkout, runtimeId: 'sandbox_1' });
    expect(ensureProjectWorkspace).toHaveBeenCalledWith('ou_1', {
      projectId: 'repo', cloneUrl: 'git@github.com:team/repo.git', baseRef: 'develop',
    });
    expect(store.getTask(task.id)).toMatchObject({ mode: 'chat' });
    expect(store.getTask(task.id)).not.toHaveProperty('projectId');
    await expect(access(join(checkout, 'draft.md'))).rejects.toThrow();
    store.close();
  });

  it('reuses an imported clone for binding and restart without ever cloning a replacement', async () => {
    const store=new SqliteStateStore(join(await createTmpDir(),'state.sqlite'));
    const task:TaskRecord={...sandboxTask('task_import'),mode:'chat',projectId:undefined,baseRef:'',branchName:''};
    store.saveTask(task);
    const inspectLocalProject=vi.fn(async()=>({localPath:'/workspace/harness',branchName:'work-in-progress'}));
    const inspectExistingProject=vi.fn(async()=>{throw new Error('provider offline');});
    const ensureProjectWorkspace=vi.fn();
    const provisioner=new UserSandboxTaskProvisioner(store,{inspectLocalProject,inspectExistingProject,ensureProjectWorkspace,
      ensure:vi.fn(async()=>({sandbox:{id:'sandbox_1'}}))} as never);
    const project={id:'dyn_import',name:'harness',path:'',codexArgs:[],sandboxCloneUrl:'https://github.com/team/harness.git',sandboxLocalPath:'/workspace/harness'};
    expect(await provisioner.prepareProjectBinding(task,project)).toMatchObject({cwd:'/workspace/harness',branchName:'work-in-progress'});
    const bound={...task,mode:'project' as const,projectId:project.id,sandboxWorkspaceLayout:'project' as const};
    store.saveTask(bound);
    expect(await provisioner.resume(bound,project)).toMatchObject({cwd:'/workspace/harness',branchName:'work-in-progress'});
    inspectLocalProject.mockRejectedValueOnce(new Error('directory missing'));
    await expect(provisioner.resume(bound,project)).rejects.toThrow('missing');
    expect(inspectLocalProject).toHaveBeenCalledWith(task.ownerUserId,'/workspace/harness',project.sandboxCloneUrl);
    expect(inspectExistingProject).not.toHaveBeenCalled();
    expect(ensureProjectWorkspace).not.toHaveBeenCalled();
    store.close();
  });
  it('prepares a dynamic GitHub checkout from a trusted clone URL without a host checkout path', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'));
    const task: TaskRecord = { ...sandboxTask('task_dynamic'), mode: 'chat', projectId: undefined,
      baseRef: '', branchName: '' };
    store.saveTask(task);
    const ensure = vi.fn(async () => ({ sandbox: { id: 'sandbox_1' } }));
    const ensureProjectWorkspace = vi.fn(async () => ({ projectId: 'dyn_1', cwd: '/workspace/dyn_1', status: 'ready' }));
    const provisioner = new UserSandboxTaskProvisioner(store, { ensure, ensureProjectWorkspace } as never);
    const descriptor = { id: 'dyn_1', name: 'repo', path: '', codexArgs: [],
      sandboxCloneUrl: 'git@github.com:owner/repo.git', baseRef: 'main' };

    await expect(provisioner.prepareProjectBinding(task, descriptor)).resolves.toMatchObject({
      cwd: '/workspace/dyn_1', runtimeId: 'sandbox_1',
    });
    expect(ensureProjectWorkspace).toHaveBeenCalledWith('ou_1', {
      projectId: 'dyn_1', cloneUrl: 'git@github.com:owner/repo.git', baseRef: 'main',
    });
    expect(store.getTask(task.id)).not.toHaveProperty('projectId');
    store.close();
  });

  it('provisions and resumes chat in its task directory without loading a project', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'));
    const task: TaskRecord = { ...sandboxTask('task_chat'), mode: 'chat', projectId: undefined, baseRef: '', branchName: '' };
    store.saveTask(task);
    const ensure = vi.fn(async () => ({ sandbox: { id: 'sandbox_1' } }));
    const ensureProjectWorkspace = vi.fn();
    const provisioner = new UserSandboxTaskProvisioner(store, { ensure, ensureProjectWorkspace } as never);

    expect((await provisioner.provision({ taskId: task.id, ownerUserId: task.ownerUserId })).cwd)
      .toBe('/workspace/tasks/task_chat');
    expect((await provisioner.resume(task)).cwd).toBe('/workspace/tasks/task_chat');
    expect(ensure).toHaveBeenLastCalledWith(task.ownerUserId, { leaseWaitMs: 60_000 });
    expect(ensureProjectWorkspace).not.toHaveBeenCalled();
    store.close();
  });

  it('never falls back to a legacy container when a chat sandbox fails to start', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'));
    const task: TaskRecord = { ...sandboxTask('task_chat'), mode: 'chat', projectId: undefined, baseRef: '', branchName: '' };
    store.saveTask(task);
    const legacyProvision = vi.fn();
    const fallbackToLegacy = vi.fn();
    const hybrid = modeAwareTaskProvisioner(store,
      { provision: legacyProvision } as unknown as TaskRuntimeProvisioner,
      { provision: vi.fn(async () => { throw new Error('sandbox unavailable'); }), fallbackToLegacy } as unknown as UserSandboxTaskProvisioner,
      true);

    await expect(hybrid.provision({ taskId: task.id, ownerUserId: task.ownerUserId }))
      .rejects.toThrow('sandbox unavailable');
    expect(fallbackToLegacy).not.toHaveBeenCalled();
    expect(legacyProvision).not.toHaveBeenCalled();
    store.close();
  });

  it('rejects a project task without a project before invoking legacy provision', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'));
    const task: TaskRecord = { ...sandboxTask('task_legacy'), runtimeMode: 'legacy-task-container' };
    store.saveTask(task);
    const legacyProvision = vi.fn(async () => ({ cwd: '/workspace', branchName: task.branchName }));
    const hybrid = modeAwareTaskProvisioner(store,
      { provision: legacyProvision } as unknown as TaskRuntimeProvisioner,
      { provision: vi.fn() } as unknown as UserSandboxTaskProvisioner);

    await expect(hybrid.provision({ taskId: task.id, ownerUserId: task.ownerUserId }))
      .rejects.toThrow('Project task required');
    expect(legacyProvision).not.toHaveBeenCalled();
    store.close();
  });


  it('keeps the original task-local cwd for previously created sandbox tasks', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'));
    const task = sandboxTask('task_1');
    store.saveTask(task);
    const ensure = vi.fn(async () => ({
      sandbox: { id: 'sandbox_1', ownerId: 'ou_1', generation: 2 },
      runtime: { supervisorSocketPath: '/bridge/supervisor.sock' },
    }));
    const provisioner = new UserSandboxTaskProvisioner(store, { ensure } as never);

    await expect(provisioner.provision({
      taskId: task.id, ownerUserId: task.ownerUserId,
      project: { id: 'repo', name: 'Repo', path: '/repo', codexArgs: [] },
    })).resolves.toMatchObject({
      cwd: '/workspace/tasks/task_1', runtimeId: 'sandbox_1', branchName: task.branchName,
    });
    expect(ensure).toHaveBeenCalledWith('ou_1');
    store.close();
  });

  it('starts sibling tasks in one shared project checkout without changing its Git state', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'));
    const first = { ...sandboxTask('task_1'), sandboxWorkspaceLayout: 'project' as const };
    const second = { ...sandboxTask('task_2'), sandboxWorkspaceLayout: 'project' as const };
    store.saveTask(first);
    store.saveTask(second);
    const ensure = vi.fn(async () => ({ sandbox: { id: 'sandbox_1' } }));
    const ensureProjectWorkspace = vi.fn(async () => ({ projectId: 'repo', cwd: '/workspace/repo', status: 'ready' }));
    const provisioner = new UserSandboxTaskProvisioner(store, { ensure, ensureProjectWorkspace } as never);
    const project = { id: 'repo', name: 'Repo', path: '/repo', repositoryPath: 'team/repo', codexArgs: [] };

    const [one, two] = await Promise.all([first, second].map((task) => provisioner.provision({
      taskId: task.id, ownerUserId: task.ownerUserId, project,
    })));
    expect(one.cwd).toBe('/workspace/repo');
    expect(two.cwd).toBe('/workspace/repo');
    expect(ensureProjectWorkspace).toHaveBeenCalledTimes(2);
    expect(ensureProjectWorkspace).toHaveBeenCalledWith('ou_1', {
      projectId: 'repo', cloneUrl: 'git@github.com:team/repo.git', baseRef: 'main',
    });
    store.close();
  });

  it('does not silently fall back to legacy when shared-project preparation fails', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'));
    const task = { ...sandboxTask('task_1'), sandboxWorkspaceLayout: 'project' as const };
    store.saveTask(task);
    const legacy = { provision: vi.fn(), resume: vi.fn(), stop: vi.fn(), delete: vi.fn() } as unknown as TaskRuntimeProvisioner;
    const sandbox = { provision: vi.fn(async () => { throw new SandboxProjectBootstrapError('clone failed'); }) } as unknown as UserSandboxTaskProvisioner;
    const hybrid = modeAwareTaskProvisioner(store, legacy, sandbox, true);

    await expect(hybrid.provision({ taskId: task.id, ownerUserId: task.ownerUserId,
      project: { id: 'repo', name: 'Repo', path: '/repo', codexArgs: [] } })).rejects.toThrow('clone failed');
    expect(legacy.provision).not.toHaveBeenCalled();
    expect(store.getTask(task.id)?.runtimeMode).toBe('user-sandbox');
    store.close();
  });

  it('keeps legacy optional operations away from transparent sandbox tasks', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'));
    const task = sandboxTask('task_1');
    store.saveTask(task);
    const legacyProvision = vi.fn();
    const legacyExport = vi.fn();
    const legacy = {
      provision: legacyProvision,
      resume: vi.fn(), stop: vi.fn(), delete: vi.fn(),
      exportWorkspace: legacyExport,
    } as unknown as TaskRuntimeProvisioner;
    const sandboxProvision = vi.fn(async () => ({ cwd: '/workspace/tasks/task_1', branchName: task.branchName }));
    const sandbox = { provision: sandboxProvision } as unknown as UserSandboxTaskProvisioner;
    const hybrid = modeAwareTaskProvisioner(store, legacy, sandbox) as TaskRuntimeProvisioner & {
      exportWorkspace(task: TaskRecord): Promise<string>;
    };

    await hybrid.provision({
      taskId: task.id, ownerUserId: task.ownerUserId,
      project: { id: 'repo', name: 'Repo', path: '/repo', codexArgs: [] },
    });
    expect(sandboxProvision).toHaveBeenCalledOnce();
    expect(legacyProvision).not.toHaveBeenCalled();
    expect(() => hybrid.exportWorkspace(task)).toThrow('not available on transparent user-sandbox tasks');
    expect(legacyExport).not.toHaveBeenCalled();
    store.close();
  });

  it('falls back exactly once before any sandbox runtime or turn is owned', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'));
    const task = sandboxTask('task_1');
    store.saveTask(task);
    const legacyProvision = vi.fn(async () => ({ cwd: '/workspace', branchName: task.branchName }));
    const legacy = {
      provision: legacyProvision, resume: vi.fn(), stop: vi.fn(), delete: vi.fn(),
    } as unknown as TaskRuntimeProvisioner;
    const failure = new Error('sandbox unavailable');
    const fallbackToLegacy = vi.fn(async () => store.fallbackUnstartedUserSandboxTaskToLegacy(task.id)!);
    const sandbox = {
      provision: vi.fn(async () => { throw failure; }), fallbackToLegacy,
    } as unknown as UserSandboxTaskProvisioner;
    const hybrid = modeAwareTaskProvisioner(store, legacy, sandbox, true);

    await expect(hybrid.provision({
      taskId: task.id, ownerUserId: task.ownerUserId,
      project: { id: 'repo', name: 'Repo', path: '/repo', codexArgs: [] },
    })).resolves.toMatchObject({ cwd: '/workspace' });
    expect(store.getTask(task.id)?.runtimeMode).toBe('legacy-task-container');
    expect(fallbackToLegacy).toHaveBeenCalledOnce();
    expect(legacyProvision).toHaveBeenCalledOnce();
    store.close();
  });
});

function sandboxTask(id: string): TaskRecord {
  return {
    id, ownerUserId: 'ou_1', runtimeMode: 'user-sandbox', projectId: 'repo', baseRef: 'main',
    branchName: `codex/ou_1/${id}`, runtimeState: 'provisioning', pinned: false,
    lastUserInteractionAt: '2026-09-20T00:00:00.000Z',
    createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
  };
}
