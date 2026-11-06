import type { ChatType } from '../domain/types.js';
import type { ContinuationInputSnapshot } from '../conversation/ContinuationInput.js';
import type { WorkspacePlan } from '../projects/WorkspacePlanParser.js';
import type { TaskExecutionProfileState, TurnExecutionProfile } from './ExecutionProfile.js';

export type TaskRuntimeState = 'provisioning' | 'hot' | 'warming' | 'warm' | 'failed' | 'archived';
export type TaskRuntimeMode = 'legacy-task-container' | 'user-sandbox';
export type TurnState = 'queued' | 'submitted' | 'running' | 'waiting_approval' | 'completed' | 'interrupted' | 'failed';
export type TaskScope = 'private' | 'group' | 'topic' | 'legacy';
export type TaskContextState = 'active' | 'archived' | 'failed';

export interface TaskRecord {
  id: string;
  ownerUserId: string;
  /** Missing on historical records means project mode. */
  mode?: 'chat' | 'project';
  /**
   * Selected once when a task is created. Missing values are legacy records
   * and are normalized to `legacy-task-container` on their next write.
   */
  runtimeMode?: TaskRuntimeMode;
  /** Missing means the original task-local user-sandbox layout. */
  sandboxWorkspaceLayout?: 'project';
  sandboxId?: string;
  sandboxGeneration?: number;
  appServerProcessGeneration?: number;
  codexThreadGeneration?: number;
  projectId?: string;
  pendingProjectBind?: {
    switch?: { operationId: string; notify?: boolean; actor: { userId: string; chatId: string; chatType: ChatType; topicId?: string; messageId?: string };
      sourceProjectId?: string; sourceThreadId?: string };
    resumeAfterBind?: { turnId: string; text: string };
    projectId: string;
    requestedBy: string;
    status: 'requested' | 'checkout_ready' | 'thread_opened' | 'failed';
    openedThreadId?: string;
    failure?: string;
    requestedAt: string;
    updatedAt: string;
  };
  projectBindHandoff?: string;
  projectWorkspacePath?: string;
  lastProjectSwitch?: { operationId: string; messageId?: string; projectId: string; status: 'completed'|'cancelled'|'failed'; error?: string };
  projectBindContinuation?: { requestedBy: string; turnId: string; text: string; localTurnId?: string;
    recoveryAttempts?: number; recoveryFailure?: string;
    actor?: NonNullable<NonNullable<TaskRecord['pendingProjectBind']>['switch']>['actor'] };
  /** Empty in chat mode; not a Git branch until a project is bound. */
  baseRef: string;
  branchName: string;
  runtimeId?: string;
  runtimeState: TaskRuntimeState;
  /** Why an archived task may or may not be resumed in its conversation. */
  archiveReason?: 'warm_retention_expired' | 'explicit';
  codexThreadId?: string;
  connectionGeneration?: number;
  activeTurnId?: string;
  model?: string;
  reasoningEffort?: string;
  executionProfile?: TaskExecutionProfileState;
  executionProfileLocked?: boolean;
  workspacePlan?: WorkspacePlan;
  pinned: boolean;
  lastUserInteractionAt: string;
  createdAt: string;
  updatedAt: string;
}

export function taskMode(task: TaskRecord): 'chat' | 'project' {
  if (task.mode === 'chat') return 'chat';
  if (task.mode === undefined || task.mode === 'project') return 'project';
  throw new Error(`Invalid task mode: ${String(task.mode)}`);
}

export function projectTask(task: TaskRecord): TaskRecord & {
  projectId: string; baseRef: string; branchName: string;
} {
  if (taskMode(task) !== 'project' || !task.projectId || !task.baseRef || !task.branchName) {
    throw new Error('Project task required');
  }
  return task as TaskRecord & { projectId: string; baseRef: string; branchName: string };
}

export type UserSandboxStatus = 'provisioning' | 'running' | 'stopping' | 'stopped' | 'failed';

export interface UserSandboxRecord {
  id: string;
  ownerId: string;
  generation: number;
  containerId?: string;
  /** Immutable image ID retained across reclamation until the owner upgrades. */
  runtimeImage?: string;
  status: UserSandboxStatus;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  lastActiveAt: string;
  updatedAt: string;
  stoppedAt?: string;
}

export interface TaskScopeRecord {
  taskId: string;
  scope: TaskScope;
  scopeKey: string;
  chatId?: string;
  topicId?: string;
  privateUserId?: string;
  status: 'canonical' | 'legacy';
  createdAt: string;
  updatedAt: string;
}

export interface TaskMembershipRecord {
  id: string;
  taskId: string;
  userId: string;
  role: 'member' | 'owner' | 'administrator';
  status: 'active' | 'removed';
  createdAt: string;
  updatedAt: string;
}

export interface TaskContextRecord {
  id: string;
  taskId: string;
  codexThreadId: string;
  state: TaskContextState;
  checkpointMemoryId?: string;
  mediaToolRevision?: number;
  projectBindingToolRevision?: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  usage?: {
    /** Lifetime accounting reported by Codex; never use this as context occupancy. */
    totalTokens: number;
    /** Current context footprint reported as tokenUsage.last.totalTokens. */
    currentTokens: number;
    modelContextWindow: number;
    observedAt: string;
  };
}

export interface TaskRepositoryRecord {
  id: string;
  taskId: string;
  projectId: string;
  checkoutPath: string;
  baseRef: string;
  baseCommit?: string;
  branchName: string;
  isPrimary: boolean;
  addedBy: string;
  createdAt: string;
  updatedAt: string;
  status?: 'provisioning' | 'ready' | 'failed';
  failure?: string;
  workspaceSpecId?: string;
  specVersion?: number;
  generation?: number;
  changeSetId?: string;
}

export interface WorkspaceSpecRepositoryRecord {
  projectId: string;
  role: 'primary' | 'dependency';
  requestedBaseRef: string;
  resolvedBaseSha?: string;
  changeSetId: string;
}

export interface WorkspaceSpecRecord {
  id: string;
  taskId: string;
  version: number;
  generation: number;
  state: 'draft' | 'reconciling' | 'ready' | 'conflict' | 'failed' | 'superseded';
  repositories: WorkspaceSpecRepositoryRecord[];
  source: { messageId?: string; turnId?: string; requestedBy: string; reason: 'initial' | 'explicit_change' | 'legacy_recovery' | 'publish_sync' };
  createdAt: string;
  updatedAt: string;
}

export interface ChangeSetRecord {
  id: string;
  taskId: string;
  projectId: string;
  baseSha?: string;
  commits: Array<{ sequence: number; originalSha: string; patchId: string; message: string; authorName: string; authorEmail: string }>;
  uncommittedPatchDigest?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RepositoryMigrationRecord {
  id: string;
  taskId: string;
  repositoryId: string;
  projectId: string;
  sourceBaseRef: string;
  sourceBaseCommit?: string;
  targetBaseRef: string;
  targetBaseCommit?: string;
  state: 'planning' | 'applying' | 'conflict_waiting' | 'completed' | 'rolled_back' | 'failed';
  conflictPath?: string;
  failure?: string;
  requestedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface TurnRecord {
  inputHandoff?: ContinuationInputSnapshot;
  id: string;
  taskId: string;
  codexTurnId?: string;
  /** Durable start boundary: submitting/unknown must be reconciled before replay. */
  submissionPhase?: 'prepared' | 'submitting' | 'accepted' | 'unknown';
  internalOperationId?: string;
  state: TurnState;
  prompt: string;
  createdBy: string;
  /** Verified ingress message, not a model-supplied recipient or a mutable binding. */
  sourceMessageId?: string;
  sourceChatId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  failure?: string;
  retryCount?: number;
  retryOfTurnId?: string;
  executionProfile?: TurnExecutionProfile;
}

export type TaskBindingKey =
  | { chatType: 'private'; userId: string }
  | { chatType: 'group'; chatId: string; userId: string; topicId?: string };

export interface TaskBindingRecord {
  id: string;
  chatType: ChatType;
  chatId?: string;
  userId: string;
  topicId?: string;
  lastMessageId?: string;
  taskId: string;
  createdAt: string;
  updatedAt: string;
}
