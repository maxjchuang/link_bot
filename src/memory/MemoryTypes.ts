export type MemoryScope = 'task' | 'user' | 'bot';
export type MemoryKind = 'fact' | 'decision' | 'todo' | 'project' | 'checkpoint' | 'episode' | 'lesson';
export type MemoryStatus = 'candidate' | 'active' | 'forgotten' | 'expired' | 'rejected' | 'superseded';

export interface MemoryEntryRecord {
  id: string;
  scope: MemoryScope;
  scopeId: string;
  kind: MemoryKind;
  title: string;
  description: string;
  content: string;
  tags: string[];
  useWhen?: string;
  doNotUseWhen?: string;
  importance: number;
  confidence: number;
  visibility: 'private' | 'task' | 'bot';
  status: MemoryStatus;
  version: number;
  estimatedTokens: number;
  createdBy: string;
  supersedesMemoryId?: string;
  expiresAt?: string;
  lastConfirmedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemorySourceRecord {
  id: string;
  memoryId: string;
  taskId?: string;
  contextId?: string;
  eventKey: string;
  createdAt: string;
}

export interface ContextMemoryReadRecord {
  id: string;
  contextId: string;
  memoryId: string;
  memoryVersion: number;
  detailLevel: 'catalog' | 'summary' | 'full' | 'source';
  estimatedTokens: number;
  loadedAt: string;
}

export interface DreamJobRecord {
  id: string;
  scope: MemoryScope;
  scopeId: string;
  businessDate: string;
  status: 'pending' | 'running' | 'deferred' | 'completed' | 'failed' | 'interrupted';
  fromEventSequence: number;
  toEventSequence?: number;
  watermarkSequence?: number;
  attemptCount: number;
  checkpoint?: Record<string, unknown>;
  lastErrorCode?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface DreamMemoryProposal {
  kind: MemoryKind;
  title: string;
  description: string;
  content: string;
  tags?: string[];
  sourceEventKeys: string[];
  importance?: number;
  confidence?: number;
}

export interface DreamPatch {
  episode?: DreamMemoryProposal;
  candidates: DreamMemoryProposal[];
  globalCandidates?: DreamMemoryProposal[];
}
