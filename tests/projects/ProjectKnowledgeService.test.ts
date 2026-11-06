import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectKnowledgeService } from '../../src/projects/ProjectKnowledgeService.js';
import { SqliteStateStore } from '../../src/state/SqliteStateStore.js';
import { sampleConfig } from '../helpers/fakes.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('ProjectKnowledgeService', () => {
  it('persists candidates and permits configured approvers to activate a version', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'));
    const config = sampleConfig('/tmp/repo');
    config.projects[0]!.access = { allowedUsers: [], allowedChats: [], knowledgeApprovers: ['ou_reviewer'] };
    const service = new ProjectKnowledgeService(store, config);

    const candidate = service.propose({
      projectId: 'repo', kind: 'workflow', title: 'Testing', content: 'Run npm test.',
      evidence: ['turn_event_1'], proposerId: 'ou_codex', taskId: 'task_1', turnId: 'turn_1', confidence: 0.9,
    });
    expect(candidate).toMatchObject({ status: 'candidate', version: 1 });

    expect(service.decide(candidate.id, 'ou_reviewer', 'approve')).toMatchObject({ status: 'active', approvedBy: 'ou_reviewer' });
    expect(service.listActive('repo')).toHaveLength(1);
    store.close();
  });

  it('rejects decisions by users outside the project approver list and global admins', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'));
    const config = sampleConfig('/tmp/repo');
    config.projects[0]!.access = { allowedUsers: [], allowedChats: [], knowledgeApprovers: [] };
    const service = new ProjectKnowledgeService(store, config);
    const candidate = service.propose({ projectId: 'repo', kind: 'caution', title: 'Caution', content: 'Do not edit generated files.', evidence: [], proposerId: 'ou_x', taskId: 'task_1', turnId: 'turn_1', confidence: 1 });

    expect(() => service.decide(candidate.id, 'ou_other', 'reject')).toThrow('approver');
    store.close();
  });

  it('activates knowledge proposed by a global administrator without a separate approval', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'));
    const config = sampleConfig('/tmp/repo');
    config.upgrade.adminUsers = ['ou_admin'];
    const service = new ProjectKnowledgeService(store, config);

    const knowledge = service.propose({
      projectId: 'repo', kind: 'workflow', title: 'Admin workflow', content: 'Use the repository workflow.',
      evidence: ['administrator instruction'], proposerId: 'ou_admin', taskId: 'task_1', turnId: 'turn_1', confidence: 1,
    });

    expect(knowledge).toMatchObject({ status: 'active', approvedBy: 'ou_admin', decidedAt: expect.any(String) });
    expect(service.listActive('repo')).toEqual([knowledge]);
    store.close();
  });
});
