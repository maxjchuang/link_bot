import {describe, expect, it, vi} from 'vitest';
import {SqliteStateStore} from '../../src/state/SqliteStateStore.js';
import {UserSandboxTaskProvisioner, modeAwareTaskProvisioner} from '../../src/runtime/UserSandboxTaskProvisioner.js';
import type {TaskRecord} from '../../src/tasks/TaskTypes.js';

function fixture() {
  const store = new SqliteStateStore(':memory:');
  const task: TaskRecord = {id: 'task_agent', ownerUserId: 'ou_owner', agentOwnerUserId: 'ou_owner', identityMode: 'personal-agent',
    runtimeMode: 'user-sandbox', mode: 'chat', baseRef: '', branchName: '', runtimeState: 'warm', pinned: false,
    createdAt: '', updatedAt: '', lastUserInteractionAt: ''};
  store.saveTask(task);
  const sandboxes = {ensure: vi.fn(async () => ({sandbox: {id: 'sandbox_owner'}})), reclaim: vi.fn(),
    refreshCodexAuth: vi.fn(), stageTaskAttachment: vi.fn(), exportTaskArtifact: vi.fn(), removeTaskAttachments: vi.fn()};
  return {store, task, sandboxes, provisioner: new UserSandboxTaskProvisioner(store, sandboxes as never,
    {personalAgent: {enabled: true, ownerUserId: 'ou_owner'}})};
}

describe('personal-agent sandbox execution', () => {
  it.each([{enabled: false as const}, {enabled: true as const, ownerUserId: 'ou_other'}])('rejects execution and attachment access after config identity changes: %j', async personalAgent => {
    const h = fixture(); try {
      const provisioner = new UserSandboxTaskProvisioner(h.store, h.sandboxes as never, {personalAgent});
      await expect(provisioner.resume(h.task)).rejects.toThrow('owner');
      await expect(provisioner.stageInboundAttachment(h.task, 'turn', '/source', 'file')).rejects.toThrow('owner');
      await expect(provisioner.refreshCodexAuth(h.task)).rejects.toThrow('owner');
      expect(h.sandboxes.ensure).not.toHaveBeenCalled();
      expect(h.sandboxes.stageTaskAttachment).not.toHaveBeenCalled();
      expect(h.sandboxes.refreshCodexAuth).not.toHaveBeenCalled();
      // Turning the feature off must still permit safe shutdown and inspection.
      await expect(provisioner.stop(h.task)).resolves.toBeUndefined();
      await expect(provisioner.delete(h.task)).resolves.toBeUndefined();
      await expect(provisioner.observeTaskState(h.task)).resolves.toBe('warm');
    } finally {h.store.close();}
  });
  it('never reclaims the shared owner sandbox before rejecting legacy fallback', async () => {
    const h = fixture(); try {
      await expect(h.provisioner.fallbackToLegacy(h.task.id, 'ou_owner')).rejects.toThrow('personal-agent');
      expect(h.sandboxes.reclaim).not.toHaveBeenCalled();
    } finally {h.store.close();}
  });

  it('cannot resume in a requester sandbox via a stale or forged task snapshot', async () => {
    const h = fixture(); try {
      await expect(h.provisioner.resume({...h.task, ownerUserId: 'ou_a'})).rejects.toThrow('owner');
      expect(h.sandboxes.ensure).not.toHaveBeenCalled();
      expect(await h.provisioner.resume(h.task)).toMatchObject({runtimeId: 'sandbox_owner'});
      expect(h.sandboxes.ensure).toHaveBeenCalledWith('ou_owner', {leaseWaitMs: 60000});
    } finally {h.store.close();}
  });

  it('routes attachments, export and refresh using persisted owner, not caller-provided owner', async () => {
    const h = fixture(); try {
      const forged = {...h.task, ownerUserId: 'ou_a'};
      await h.provisioner.stageInboundAttachment(forged, 'turn', '/source', 'file');
      await h.provisioner.exportArtifact(forged, '/artifact', '/destination');
      await h.provisioner.removeInboundAttachments(forged, 'turn');
      await h.provisioner.refreshCodexAuth(forged);
      expect(h.sandboxes.stageTaskAttachment).toHaveBeenCalledWith('ou_owner', h.task.id, 'turn', '/source', 'file', undefined);
      expect(h.sandboxes.exportTaskArtifact).toHaveBeenCalledWith('ou_owner', h.task.id, '/artifact', '/destination', undefined);
      expect(h.sandboxes.removeTaskAttachments).toHaveBeenCalledWith('ou_owner', h.task.id, 'turn', undefined);
      expect(h.sandboxes.refreshCodexAuth).toHaveBeenCalledWith('ou_owner');
    } finally {h.store.close();}
  });

  it('does not invoke either fallback or legacy provision even when fallback is globally enabled', async () => {
    const h = fixture(); try {
      const projectTask = {...h.task, mode: 'project' as const, projectId: 'repo', baseRef: 'main', branchName: 'work'};
      h.store.saveTask(projectTask);
      const fallbackToLegacy = vi.fn(); const legacyProvision = vi.fn();
      const hybrid = modeAwareTaskProvisioner(h.store, {provision: legacyProvision} as never,
        {provision: async () => {throw new Error('sandbox unavailable');}, fallbackToLegacy} as never, true);
      await expect(hybrid.provision({taskId: h.task.id, ownerUserId: 'ou_owner',
        project: {id: 'repo', name: 'repo', path: '', codexArgs: []}})).rejects.toThrow('sandbox unavailable');
      expect(fallbackToLegacy).not.toHaveBeenCalled(); expect(legacyProvision).not.toHaveBeenCalled();
    } finally {h.store.close();}
  });
});
