import type { RepositoryProvider } from './DynamicProjectTypes.js';

export type RepositoryCreationDraft = {
  namespace: string;
  name: string;
  description?: string;
  private: true;
} & { provider: 'github' };

export type SandboxRepoRequest = RepositoryCreationDraft & {
  action: 'validate' | 'create' | 'readback';
  operationId: string;
};

export interface SandboxRepoResult {
  status: 'ready' | 'auth_required' | 'created' | 'not_found' | 'exists_foreign' | 'failed';
  providerRepoId?: string;
  canonicalPath?: string;
  cloneUrl?: string;
  defaultBranch?: string;
  reason?: string;
}

export type RepositoryCreationReceipt = SandboxRepoResult & {
  operationId: string;
  provider: RepositoryProvider;
  namespace: string;
  name: string;
  createdAt: string;
};
