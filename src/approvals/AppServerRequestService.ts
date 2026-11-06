import { createHash } from 'node:crypto';
import type { CodexBackend, CodexBackendEvent } from '../backends/CodexBackend.js';
import type { AppServerRequestRecord, DecideAppServerRequestResult } from './AppServerRequestTypes.js';

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
]);
const USER_INPUT_METHOD = 'item/tool/requestUserInput';
const MAX_PAYLOAD_CHARS = 16_384;

export interface AppServerRequestRenderer {
  render(request: AppServerRequestRecord): Promise<void>;
}

export interface AppServerRequestStore {
  getTask(taskId: string): Promise<import('../tasks/TaskTypes.js').TaskRecord | undefined> | import('../tasks/TaskTypes.js').TaskRecord | undefined;
  updateTask(taskId: string, updater: (current: import('../tasks/TaskTypes.js').TaskRecord) => import('../tasks/TaskTypes.js').TaskRecord): Promise<import('../tasks/TaskTypes.js').TaskRecord | undefined> | import('../tasks/TaskTypes.js').TaskRecord | undefined;
  updateTurn(turnId: string, updater: (current: import('../tasks/TaskTypes.js').TurnRecord) => import('../tasks/TaskTypes.js').TurnRecord): Promise<import('../tasks/TaskTypes.js').TurnRecord | undefined> | import('../tasks/TaskTypes.js').TurnRecord | undefined;
  getTurn?(turnId: string): Promise<import('../tasks/TaskTypes.js').TurnRecord | undefined> | import('../tasks/TaskTypes.js').TurnRecord | undefined;
  createAppServerRequest(record: AppServerRequestRecord): Promise<{ created: boolean; request: AppServerRequestRecord }> | { created: boolean; request: AppServerRequestRecord };
  getAppServerRequest(requestId: string): Promise<AppServerRequestRecord | undefined> | AppServerRequestRecord | undefined;
  listPendingAppServerRequests(): Promise<AppServerRequestRecord[]> | AppServerRequestRecord[];
  updateAppServerRequest(requestId: string, updater: (current: AppServerRequestRecord) => AppServerRequestRecord): Promise<AppServerRequestRecord | undefined> | AppServerRequestRecord | undefined;
  decideAppServerRequest(input: {
    requestId: string; userId: string; generation: number; decision: 'allow' | 'deny' | 'answer'; answers?: Record<string, string[]>;
  }): Promise<DecideAppServerRequestResult> | DecideAppServerRequestResult;
  markAppServerRequestDelivered(requestId: string): Promise<AppServerRequestRecord | undefined> | AppServerRequestRecord | undefined;
}

export class AppServerRequestService {
  private readonly decisionQueues = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<(request: AppServerRequestRecord) => void | Promise<void>>();
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly store: AppServerRequestStore,
    private readonly backend: CodexBackend,
    private readonly renderer: AppServerRequestRenderer,
    private readonly ttlMs = 300_000,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  subscribe(listener: (request: AppServerRequestRecord) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  dispose(): void {
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    this.listeners.clear();
  }

  async recover(): Promise<void> {
    for (const request of await this.store.listPendingAppServerRequests()) {
      this.scheduleExpiry(request);
      await this.publish(request);
    }
  }

  async resolve(event: Extract<CodexBackendEvent, { type: 'backend.server_request_resolved' }>): Promise<void> {
    const task = await this.store.getTask(event.taskId);
    const active = task?.activeTurnId ? await this.store.getTurn?.(task.activeTurnId) : undefined;
    const matches = (await this.store.listPendingAppServerRequests()).filter((request) => request.taskId === event.taskId
      && request.threadId === event.threadId && request.generation === event.generation && request.serverRequestId === event.requestId
      && (!active?.codexTurnId || request.turnId === active.codexTurnId));
    if (matches.length !== 1) return; // The upstream notice has no turn id: ambiguous reuse is not evidence.
    const resolved = await this.store.updateAppServerRequest(matches[0]!.id, (current) =>
      current.status === 'pending' || current.status === 'decided'
        ? { ...current, status: 'resolved', invalidatedAt: this.clock().toISOString() } : current);
    if (resolved) await this.publish(resolved);
  }

  async closeTurn(taskId: string, codexTurnId: string): Promise<void> {
    for (const request of await this.store.listPendingAppServerRequests()) {
      if (request.taskId !== taskId || request.turnId !== codexTurnId) continue;
      const closed = await this.store.updateAppServerRequest(request.id, (current) => current.status === 'pending' || current.status === 'decided'
        ? { ...current, status: 'resolved', invalidatedAt: this.clock().toISOString() } : current);
      if (closed) await this.publish(closed);
    }
  }

  async capture(event: Extract<CodexBackendEvent, { type: 'backend.server_request' }>): Promise<AppServerRequestRecord> {
    const kind = requestKind(event.method);
    const params = requireRecord(event.params, 'app-server request params');
    const threadId = requireString(params.threadId, 'app-server request threadId');
    const turnId = requireString(params.turnId, 'app-server request turnId');
    const task = await this.store.getTask(event.taskId);
    if (!task) throw new Error(`Task not found for app-server request: ${event.taskId}`);
    if (task.codexThreadId && task.codexThreadId !== threadId) {
      throw new Error(`App-server request thread does not match task ${event.taskId}.`);
    }

    const activeTurn = task.activeTurnId ? await this.store.getTurn?.(task.activeTurnId) : undefined;
    const now = this.clock();
    const record: AppServerRequestRecord = {
      id: requestRecordId(event.taskId, threadId, turnId, event.generation, event.requestId),
      kind,
      // In a collaborative group task, the authenticated user who started the
      // turn must be able to answer the approval or user-input request.
      ownerUserId: activeTurn?.createdBy ?? task.ownerUserId,
      taskId: event.taskId,
      threadId,
      turnId,
      localTurnId: task.activeTurnId ?? turnId,
      generation: event.generation,
      serverRequestId: event.requestId,
      method: event.method,
      riskSummary: riskSummary(event.method, params),
      payload: boundedPayload(params),
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
    };
    const persisted = await this.store.createAppServerRequest(record);
    if (persisted.created) {
      this.scheduleExpiry(persisted.request);
      await this.publish(persisted.request);
      const localTurnId = task.activeTurnId ?? turnId;
      await this.store.updateTask(event.taskId, (current) => ({
        ...current,
        activeTurnId: localTurnId,
        connectionGeneration: event.generation,
        pinned: true,
        updatedAt: now.toISOString(),
      }));
      await this.store.updateTurn(localTurnId, (current) => ({
        ...current,
        codexTurnId: turnId,
        state: 'waiting_approval',
        updatedAt: now.toISOString(),
      }));
      try { await this.renderer.render(persisted.request); }
      catch {
        const failed = await this.store.updateAppServerRequest(persisted.request.id, (current) => current.status === 'pending'
          ? { ...current, operationCard: { status: 'failed', at: this.clock().toISOString() } } : current);
        if (failed) await this.publish(failed);
      }
    }
    return persisted.request;
  }

  decide(input: {
    requestId: string;
    userId: string;
    generation: number;
    decision: 'allow' | 'deny' | 'answer';
    answers?: Record<string, string[]>;
  }): Promise<DecideAppServerRequestResult> {
    const previous = this.decisionQueues.get(input.requestId) ?? Promise.resolve();
    const current = previous.then(() => this.decideAndRespond(input));
    const chain = current.catch(() => undefined);
    this.decisionQueues.set(input.requestId, chain);
    return current.finally(() => {
      if (this.decisionQueues.get(input.requestId) === chain) this.decisionQueues.delete(input.requestId);
    });
  }

  private async decideAndRespond(input: {
    requestId: string;
    userId: string;
    generation: number;
    decision: 'allow' | 'deny' | 'answer';
    answers?: Record<string, string[]>;
  }): Promise<DecideAppServerRequestResult> {
    const existing = await this.store.getAppServerRequest(input.requestId);
    if (existing) validateDecision(existing, input.decision, input.answers);
    const decided = await this.store.decideAppServerRequest(input);
    if (!decided.accepted) {
      if (decided.request) await this.publish(decided.request);
      return decided;
    }
    if (decided.request.status === 'delivered') return decided;
    const submitting = await this.store.updateAppServerRequest(decided.request.id, (current) =>
      current.status === 'decided' ? { ...current, responseState: 'submitting' } : current);
    if (!submitting || submitting.status !== 'decided') return { accepted: false, reason: 'not_pending', request: submitting };
    await this.publish(submitting);
    try {
      await this.backend.respondToServerRequest({
        taskId: decided.request.taskId,
        generation: decided.request.generation,
        requestId: decided.request.serverRequestId,
        result: responsePayload(decided.request),
      });
    } catch (error) {
      const failed = await this.store.updateAppServerRequest(decided.request.id, (current) =>
        current.status === 'decided' ? { ...current, responseState: 'failed' } : current);
      if (failed) await this.publish(failed);
      throw error;
    }
    const delivered = await this.store.markAppServerRequestDelivered(decided.request.id);
    const completed = delivered ? await this.store.updateAppServerRequest(delivered.id, (current) =>
      current.status === 'delivered' ? { ...current, responseState: 'delivered' } : current) : undefined;
    if (completed) await this.publish(completed);
    return { accepted: true, duplicate: decided.duplicate, request: completed ?? delivered ?? decided.request };
  }

  private async publish(request: AppServerRequestRecord): Promise<void> {
    if (request.status !== 'pending') {
      const timer = this.expiryTimers.get(request.id);
      if (timer) clearTimeout(timer);
      this.expiryTimers.delete(request.id);
    }
    await Promise.allSettled([...this.listeners].map(async (listener) => { await listener(request); }));
  }

  private scheduleExpiry(request: AppServerRequestRecord): void {
    if (request.status !== 'pending' || this.expiryTimers.has(request.id)) return;
    const delay = Math.max(0, Date.parse(request.expiresAt) - this.clock().getTime());
    const timer = setTimeout(() => {
      this.expiryTimers.delete(request.id);
      void Promise.resolve().then(() => this.store.updateAppServerRequest(request.id, (current) => current.status === 'pending'
        && Date.parse(current.expiresAt) <= this.clock().getTime()
        ? { ...current, status: 'expired', invalidatedAt: this.clock().toISOString() } : current))
        .then(async (updated) => { if (updated) await this.publish(updated); }).catch(() => undefined);
    }, delay);
    timer.unref();
    this.expiryTimers.set(request.id, timer);
  }
}

function requestKind(method: string): AppServerRequestRecord['kind'] {
  if (APPROVAL_METHODS.has(method)) return 'approval';
  if (method === USER_INPUT_METHOD) return 'user_input';
  throw new Error(`Unsupported app-server request method: ${method}`);
}

function validateDecision(
  request: AppServerRequestRecord,
  decision: 'allow' | 'deny' | 'answer',
  answers: Record<string, string[]> | undefined,
): void {
  if (request.kind === 'approval' && decision === 'answer') {
    throw new Error('Approval requests require an allow or deny decision.');
  }
  if (request.kind === 'user_input' && decision !== 'answer') {
    throw new Error('User-input requests require answers.');
  }
  if (decision === 'answer' && !answers) {
    throw new Error('User-input answers are required.');
  }
}

function responsePayload(request: AppServerRequestRecord): unknown {
  if (request.decision === 'allow') return { decision: 'accept' };
  if (request.decision === 'deny') return { decision: 'decline' };
  if (request.decision === 'answer' && request.answers) {
    return {
      answers: Object.fromEntries(
        Object.entries(request.answers).map(([questionId, answers]) => [questionId, { answers }]),
      ),
    };
  }
  throw new Error(`App-server request has no deliverable decision: ${request.id}`);
}

function requestRecordId(
  taskId: string,
  threadId: string,
  turnId: string,
  generation: number,
  requestId: string | number,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([taskId, threadId, turnId, generation, requestId]))
    .digest('hex')
    .slice(0, 24);
  return `asr_${digest}`;
}

function boundedPayload(params: Record<string, unknown>): unknown {
  const serialized = JSON.stringify(params);
  if (serialized.length <= MAX_PAYLOAD_CHARS) return params;
  return { truncated: true, preview: serialized.slice(0, MAX_PAYLOAD_CHARS) };
}

function riskSummary(method: string, params: Record<string, unknown>): string {
  if (method === 'item/commandExecution/requestApproval') {
    const command = typeof params.command === 'string' ? params.command : JSON.stringify(params.command ?? 'command');
    return `Run command: ${command}`.slice(0, 500);
  }
  if (method === 'item/fileChange/requestApproval') {
    return `Apply file changes${typeof params.reason === 'string' ? `: ${params.reason}` : ''}`.slice(0, 500);
  }
  return 'Codex requires user input.';
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${field}.`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Invalid ${field}.`);
  return value;
}
