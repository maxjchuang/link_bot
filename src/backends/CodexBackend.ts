/** Raised before sending an RPC: this input was definitely not delivered. */
export class NoActiveTurnError extends Error {
  constructor(readonly taskId: string) {
    super(`Codex task has no active turn: ${taskId}`);
    this.name = 'NoActiveTurnError';
  }
}

export type CodexBackendEvent =
  | { type: 'task.output'; taskId: string; text: string }
  | { type: 'task.restarted'; taskId: string; reason: 'codex_cli_update' }
  | { type: 'task.exited'; taskId: string; exitCode?: number }
  | { type: 'turn.started'; taskId: string; threadId: string; turnId: string }
  | { type: 'item.started' | 'item.completed'; taskId: string; threadId: string; turnId: string; item: unknown; startedAtMs?: number; completedAtMs?: number }
  | { type: 'item.summary_part'; taskId: string; threadId: string; turnId: string; itemId: string; summaryIndex: number }
  | {
      type: 'item.delta';
      taskId: string;
      threadId: string;
      turnId: string;
      itemId: string;
      channel: 'agent_message' | 'command' | 'file_change' | 'reasoning' | 'plan';
      delta: string;
      /** Missing in legacy records: do not interpret mixed reasoning as public. */
      reasoningSource?: 'public_summary' | 'internal_reasoning';
      summaryIndex?: number;
      contentIndex?: number;
      outputStream?: 'stdout' | 'stderr' | 'combined';
    }
  | { type: 'turn.diff'; taskId: string; threadId: string; turnId: string; diff: string }
  | { type: 'usage.updated'; taskId: string; threadId: string; turnId: string; usage: unknown }
  | { type: 'turn.completed'; taskId: string; threadId: string; turnId: string; status: string; turn: unknown }
  | { type: 'backend.server_request'; taskId: string; generation: number; requestId: string | number; method: string; params: unknown }
  | { type: 'backend.server_request_resolved'; taskId: string; threadId: string; generation: number; requestId: string | number }
  | { type: 'backend.error'; taskId: string; message: string; details?: unknown }
  | { type: 'backend.disconnected'; taskId: string; generation: number; reason: string };

export interface BackendTask {
  taskId: string;
  threadId?: string;
  generation?: number;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: CodexServiceTier;
}

export interface BackendContext {
  taskId: string;
  threadId: string;
}

export interface StartTaskInput {
  taskId: string;
  cwd: string;
  args: string[];
  codexHome?: string;
  executionProfile?: ExecutionProfile;
}

export interface ResumeTaskInput extends StartTaskInput {
  threadId: string;
}

export interface StartTurnInput {
  taskId: string;
  prompt: string;
  executionProfile?: ExecutionProfile;
  images?: Array<{ url: string; detail?: 'auto' | 'low' | 'high' }>;
}

export interface StartTurnResult { turnId: string }

export interface SteerTurnInput extends StartTurnInput { expectedTurnId?: string }

export interface InterruptTurnInput {
  taskId: string;
}

export interface CreateContextInput { taskId: string }
export interface ResumeContextInput { taskId: string; threadId: string }
export interface ArchiveContextInput extends ResumeContextInput {}
export interface CompactContextInput { taskId: string }

export interface ThreadSnapshot {
  taskId: string;
  threadId?: string;
  items: unknown[];
  turns?: unknown[];
}

export interface ObservedTurnSnapshot {
  id: string;
  status: string;
  raw?: unknown;
}

export interface RespondServerRequestInput {
  taskId: string;
  generation: number;
  requestId: string | number;
  result: unknown;
}

export interface RunMaintenanceTurnInput {
  taskId: string;
  prompt: string;
  outputSchema: Record<string, unknown>;
}
export interface RunStructuredWorkspaceTurnInput extends RunMaintenanceTurnInput {
  cwd: string;
  intent?: 'review' | 'remediation';
}

export interface CodexBackend {
  healthCheck(): Promise<{ ok: true } | { ok: false; reason: string }>;
  getVersion?(): Promise<string | undefined>;
  startTask(input: StartTaskInput): Promise<BackendTask>;
  resumeTask(input: ResumeTaskInput): Promise<BackendTask>;
  createContext?(input: CreateContextInput): Promise<BackendContext>;
  resumeContext?(input: ResumeContextInput): Promise<BackendContext>;
  archiveContext?(input: ArchiveContextInput): Promise<void>;
  compactContext?(input: CompactContextInput): Promise<void>;
  startTurn(input: StartTurnInput): Promise<void | StartTurnResult>;
  restoreActiveTurn?(taskId: string, turnId: string): Promise<void>;
  assertSteerTarget?(taskId: string, expectedTurnId?: string): void;
  steerTurn(input: SteerTurnInput): Promise<void>;
  interruptTurn(input: InterruptTurnInput): Promise<void>;
  respondToServerRequest(input: RespondServerRequestInput): Promise<void>;
  runMaintenanceTurn?(input: RunMaintenanceTurnInput): Promise<unknown>;
  runStructuredWorkspaceTurn?(input: RunStructuredWorkspaceTurnInput): Promise<unknown>;
  interruptMaintenance?(taskId: string): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  readObservedTurn?(taskId: string, turnId: string): ObservedTurnSnapshot | undefined;
  readThread(taskId: string): Promise<ThreadSnapshot>;
  events(taskId: string): AsyncIterable<CodexBackendEvent>;
}
import type { ExecutionProfile, CodexServiceTier } from '../tasks/ExecutionProfile.js';
