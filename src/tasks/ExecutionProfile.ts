export type CodexServiceTier = 'default' | 'fast';

export interface ExecutionProfile {
  model: string;
  reasoningEffort: string;
  serviceTier: CodexServiceTier;
}

export type ExecutionProfileSource =
  | 'global'
  | 'host-default'
  | 'worker-default'
  | 'project'
  | 'project-user-default'
  | 'task-temporary'
  | 'workflow-override';

export interface SourcedExecutionProfile extends ExecutionProfile {
  source: ExecutionProfileSource;
}

export interface ConfirmedExecutionProfile extends SourcedExecutionProfile {
  confirmedAt: string;
}

export interface PendingExecutionProfile extends SourcedExecutionProfile {
  applyFromNextTurn: true;
  requestedAt: string;
}

export interface TaskExecutionProfileState {
  configured: SourcedExecutionProfile;
  effective: ConfirmedExecutionProfile;
  pending?: PendingExecutionProfile;
}

export interface TurnExecutionProfile extends SourcedExecutionProfile {
  requestedAt: string;
  confirmedAt?: string;
}

export interface ConversationExecutionProfileRecord extends SourcedExecutionProfile {
  scopeKey: string;
  chatId: string;
  topicId?: string;
  ownerUserId: string;
  status: 'pending' | 'consumed';
  createdAt: string;
  updatedAt: string;
  consumedTaskId?: string;
}

export const DEFAULT_EXECUTION_PROFILE: SourcedExecutionProfile = {
  model: 'gpt-6.1-sol',
  reasoningEffort: 'medium',
  serviceTier: 'default',
  source: 'worker-default',
};

export const RESTRICTED_USER_EXECUTION_PROFILE: ExecutionProfile = {
  model: 'gpt-6.1-sol',
  reasoningEffort: 'medium',
  serviceTier: 'default',
};

export const DEFAULT_HOST_EXECUTION_PROFILE: SourcedExecutionProfile = {
  model: 'gpt-6.1-sol', reasoningEffort: 'medium', serviceTier: 'default', source: 'host-default',
};

export function completeExecutionProfile(
  input: Partial<ExecutionProfile> | undefined,
  fallback: SourcedExecutionProfile = DEFAULT_EXECUTION_PROFILE,
  source: ExecutionProfileSource = fallback.source,
): SourcedExecutionProfile {
  return {
    model: input?.model?.trim() || fallback.model,
    reasoningEffort: input?.reasoningEffort?.trim() || fallback.reasoningEffort,
    serviceTier: input?.serviceTier ?? fallback.serviceTier,
    source,
  };
}

export function taskExecutionProfile(
  task: { model?: string; reasoningEffort?: string; executionProfile?: TaskExecutionProfileState },
  now = new Date().toISOString(),
): TaskExecutionProfileState {
  if (task.executionProfile) return task.executionProfile;
  const configured = completeExecutionProfile({
    model: task.model,
    reasoningEffort: task.reasoningEffort,
  });
  return { configured, effective: { ...configured, confirmedAt: now } };
}

export function displayMode(tier: CodexServiceTier): string {
  return tier === 'fast' ? 'Fast' : '标准';
}
