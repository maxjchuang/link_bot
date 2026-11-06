import type { TaskActorContext } from '../feishu/FeishuTaskController.js';

export interface PendingAuthenticatedTurn extends TaskActorContext {
  id: string;
  provider: string;
  text: string;
  loginSessionId: string;
  authorizationUrl: string;
  triggerCreatedAt?: string;
  expiresAt: string;
  createdAt: string;
  requestedScopes?: string[];
  sourceTaskId?: string;
  sourceTurnId?: string;
  resumeState?: 'authenticated' | 'resuming' | 'resume_failed';
  resumeAttempt?: number;
  resumeStartedAt?: string;
  lastResumeError?: string;
}

export interface ToolAuthResumeContext {
  pendingId: string;
  attempt: number;
  sourceTaskId?: string;
  sourceTurnId?: string;
}

export interface ToolAuthRequest {
  scopes?: string[];
  domains?: string[];
}

export interface ToolAuthProvider {
  readonly id: string;
  requiresAuth(text: string): boolean;
  isAuthenticated(userId: string): Promise<boolean>;
  begin(userId: string, request?: ToolAuthRequest): Promise<{ sessionId: string; authorizationUrl: string; expiresAt: string }>;
  complete(userId: string, sessionId: string): Promise<'pending' | 'authenticated' | 'expired'>;
  discard?(userId: string, sessionId: string): Promise<void>;
  project(userId: string, destination: string): Promise<boolean>;
}
