import type { TaskActorContext } from '../feishu/FeishuTaskController.js';
import type { WorkspacePlan } from './WorkspacePlanParser.js';

export interface ProjectRoutingCandidate {
  projectId: string;
  confidence: number;
  evidence: string[];
}

export interface PendingProjectRoutingRecord extends TaskActorContext {
  id: string;
  originalMessageId: string;
  text: string;
  candidates: ProjectRoutingCandidate[];
  workspacePlan?: WorkspacePlan;
  status: 'pending' | 'dispatching' | 'dispatched' | 'expired' | 'cancelled' | 'failed';
  selectedProjectId?: string;
  taskId?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}
