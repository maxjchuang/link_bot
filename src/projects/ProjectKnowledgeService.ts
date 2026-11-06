import { randomUUID } from 'node:crypto';
import type { BotConfig } from '../domain/types.js';
import type { SqliteStateStore } from '../state/SqliteStateStore.js';
import { ProjectAccessPolicy } from './ProjectAccessPolicy.js';

export type ProjectKnowledgeKind = 'overview' | 'workflow' | 'caution' | 'dependency';
export type ProjectKnowledgeStatus = 'candidate' | 'active' | 'rejected' | 'superseded';

export interface ProjectKnowledgeRecord {
  id: string;
  projectId: string;
  kind: ProjectKnowledgeKind;
  title: string;
  content: string;
  evidence: string[];
  confidence: number;
  proposerId: string;
  taskId: string;
  turnId: string;
  status: ProjectKnowledgeStatus;
  version: number;
  approvedBy?: string;
  decidedAt?: string;
  supersedesId?: string;
  createdAt: string;
  updatedAt: string;
}

export class ProjectKnowledgeService {
  private readonly access: ProjectAccessPolicy;

  constructor(
    private readonly store: SqliteStateStore,
    private readonly config: Pick<BotConfig, 'projects' | 'upgrade'>,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.access = new ProjectAccessPolicy(config);
  }

  propose(input: Omit<ProjectKnowledgeRecord, 'id' | 'status' | 'version' | 'createdAt' | 'updatedAt'>): ProjectKnowledgeRecord {
    const project = this.config.projects.find((candidate) => candidate.id === input.projectId);
    if (!project) throw new Error(`Project not found: ${input.projectId}`);
    if (!['overview', 'workflow', 'caution', 'dependency'].includes(input.kind)) throw new Error('Invalid project knowledge kind.');
    if (!input.title.trim() || !input.content.trim()) throw new Error('Project knowledge title and content are required.');
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) throw new Error('Invalid project knowledge confidence.');
    const now = this.clock().toISOString();
    const autoApproved = this.config.upgrade.adminUsers.includes(input.proposerId);
    const version = ((this.store.db.prepare('SELECT MAX(version) AS version FROM project_knowledge WHERE project_id=?').get(input.projectId) as { version?: number }).version ?? 0) + 1;
    const record: ProjectKnowledgeRecord = {
      ...input, id: `project_knowledge_${randomUUID()}`, status: autoApproved ? 'active' : 'candidate', version,
      ...(autoApproved ? { approvedBy: input.proposerId, decidedAt: now } : {}),
      createdAt: now, updatedAt: now,
    };
    if (autoApproved) {
      for (const active of this.listActive(input.projectId).filter((item) => item.kind === input.kind && item.title === input.title)) {
        this.save({ ...active, status: 'superseded', updatedAt: now });
        record.supersedesId = active.id;
      }
    }
    this.save(record);
    return record;
  }

  decide(id: string, approverId: string, decision: 'approve' | 'reject'): ProjectKnowledgeRecord {
    return this.store.db.transaction(() => {
      const candidate = this.get(id);
      if (!candidate) throw new Error('Project knowledge candidate not found.');
      const project = this.config.projects.find((item) => item.id === candidate.projectId);
      if (!project || !this.access.canApproveKnowledge(project, approverId)) throw new Error('Project knowledge decision requires an approver.');
      if (candidate.status !== 'candidate') return candidate;
      const now = this.clock().toISOString();
      if (decision === 'approve') {
        for (const active of this.listActive(candidate.projectId).filter((item) => item.kind === candidate.kind && item.title === candidate.title)) {
          this.save({ ...active, status: 'superseded', updatedAt: now });
          candidate.supersedesId = active.id;
        }
      }
      const decided: ProjectKnowledgeRecord = {
        ...candidate, status: decision === 'approve' ? 'active' : 'rejected', approvedBy: approverId,
        decidedAt: now, updatedAt: now,
      };
      this.save(decided);
      return decided;
    })();
  }

  get(id: string): ProjectKnowledgeRecord | undefined {
    const row = this.store.db.prepare('SELECT payload FROM project_knowledge WHERE id=?').get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as ProjectKnowledgeRecord : undefined;
  }

  listActive(projectId: string): ProjectKnowledgeRecord[] {
    return (this.store.db.prepare("SELECT payload FROM project_knowledge WHERE project_id=? AND status='active' ORDER BY version").all(projectId) as Array<{ payload: string }>)
      .map((row) => JSON.parse(row.payload) as ProjectKnowledgeRecord);
  }

  private save(record: ProjectKnowledgeRecord): void {
    this.store.db.prepare(`
      INSERT INTO project_knowledge(id, project_id, status, version, payload, created_at, updated_at)
      VALUES (@id, @projectId, @status, @version, @payload, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, payload=excluded.payload, updated_at=excluded.updated_at
    `).run({ ...record, payload: JSON.stringify(record) });
  }
}
