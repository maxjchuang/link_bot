export type RepositoryProvider = 'github';

/** Non-secret repository identity. Access is the creator AND the creating topic. */
export interface DynamicProjectRecord {
  id: string;
  provider: RepositoryProvider;
  /** Remote provider ID, or local:<sha256(provider:path)> for a verified localPath import. */
  providerRepoId: string;
  namespace: string;
  name: string;
  cloneUrl: string;
  defaultBranch: string;
  /** Existing clone in the owner's container; never a host checkout path. */
  localPath?: string;
  ownerUserId: string;
  chatId: string;
  topicId: string;
  state: 'registered' | 'active' | 'suspended';
  createdAt: string;
  updatedAt: string;
}

export type ProjectCreationStatus =
  | 'collecting' | 'awaiting_confirmation' | 'creating' | 'remote_created'
  | 'registered' | 'checkout_ready' | 'bound' | 'failed';

/** Host-side operation metadata only; provider login and tokens never enter this record. */
export interface ProjectCreationOperation {
  operationId: string;
  ownerUserId: string;
  chatId: string;
  topicId: string;
  provider?: RepositoryProvider;
  namespace?: string;
  name?: string;
  description?: string;
  status: ProjectCreationStatus;
  expiresAt: string;
  confirmedMessageId?: string;
  createAttemptedAt?: string;
  providerRepoId?: string;
  projectId?: string;
  cloneUrl?: string;
  defaultBranch?: string;
  failure?: string;
  summaryText?: string;
  createdAt: string;
  updatedAt: string;
}

export function isDynamicProjectRecord(value: unknown): value is DynamicProjectRecord {
  return Boolean(value && typeof value === 'object' && typeof (value as DynamicProjectRecord).providerRepoId === 'string');
}
