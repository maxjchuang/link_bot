import type { CodexBackendEvent } from '../backends/CodexBackend.js';
import type { TaskLifecycleEventSink } from '../tasks/TaskLifecycleService.js';
import type { AppServerRequestRecord } from '../approvals/AppServerRequestTypes.js';
import type { DetailPendingAction } from '../details/TurnDetailTypes.js';
import { DetailSanitizer, isSensitiveDetailCommand, sanitizeDetailText } from '../details/DetailSanitizer.js';
import { TurnCardSummaryProjection, type TurnCardSummary } from './TurnCardSummary.js';

export type ProjectedTurnPhase = 'running' | 'waiting_approval' | 'completed' | 'interrupted' | 'failed';

export interface ProcessPreview {
  source: 'summary' | 'plan' | 'progress';
  itemId: string;
  summaryIndex?: number;
  text: string;
  completed?: boolean;
}

export interface LiveTurnSnapshot {
  taskId: string;
  threadId?: string;
  turnId?: string;
  phase: ProjectedTurnPhase;
  pendingActions?: DetailPendingAction[];
  commentary: string;
  processPreviews?: ProcessPreview[];
  commandOutput: string;
  fileChangeOutput: string;
  diff?: string;
  diffTruncated?: boolean;
  items: unknown[];
  usage?: unknown;
  compacting: boolean;
  finalAnswer?: string;
  error?: string;
  revision: number;
  summary?: TurnCardSummary;
}

export class LiveTurnProjection implements TaskLifecycleEventSink {
  private readonly snapshots = new Map<string, MutableSnapshot>();
  private readonly listeners = new Set<(snapshot: LiveTurnSnapshot) => void>();

  updateRequest(request: AppServerRequestRecord): void {
    const snapshot = this.snapshots.get(request.taskId);
    if (!snapshot || snapshot.phase !== 'running' || snapshot.turnId !== request.turnId || snapshot.threadId !== request.threadId) return;
    if (snapshot.generation !== undefined && snapshot.generation !== request.generation) return;
    snapshot.generation ??= request.generation;
    if (request.status !== 'pending' && request.status !== 'decided') snapshot.pendingActions.delete(request.id);
    else {
      const status: DetailPendingAction['status'] = request.status === 'decided'
        ? request.responseState === 'failed' ? 'submission_failed' : 'submitting'
        : request.operationCard?.status === 'sent' ? 'delivered' : request.operationCard?.status === 'failed' ? 'preparation_failed' : 'preparing';
      if (snapshot.pendingActions.size >= 32 && !snapshot.pendingActions.has(request.id)) return;
      snapshot.pendingActions.set(request.id, { requestRef: request.id, generation: request.generation,
        handlerUserId: request.ownerUserId, expiresAt: request.expiresAt, status,
        title: request.method === 'item/commandExecution/requestApproval' ? '命令执行审批'
          : request.method === 'item/fileChange/requestApproval' ? '文件变更审批' : '需要补充信息',
        impact: sanitizeDetailText(request.riskSummary).text.slice(0, 240),
        ...(request.operationCard?.messageAppLink ? { messageAppLink: request.operationCard.messageAppLink } : {}),
        ...(request.operationCard?.messageId ? { messageId: request.operationCard.messageId } : {}) });
    }
    snapshot.revision++;
    for (const listener of this.listeners) listener(toSnapshot(snapshot));
  }

  append(event: CodexBackendEvent): void {
    const snapshot = this.snapshotFor(event.taskId);
    if (isLateTurnEvent(snapshot, event)) return;
    if (event.type !== 'turn.completed' || !snapshot.completedTurnIds.has(event.turnId)) snapshot.summary.append(event);
    let changed = true;
    switch (event.type) {
      case 'turn.started':
        snapshot.threadId = event.threadId;
        snapshot.turnId = event.turnId;
        snapshot.phase = 'running';
        snapshot.pendingActions.clear();
        snapshot.generation = undefined;
        snapshot.commentary = '';
        snapshot.processPreviews.clear();
        snapshot.processStreams.clear();
        snapshot.commandOutput = '';
        snapshot.fileChangeOutput = '';
        snapshot.diff = undefined;
        snapshot.diffTruncated = false;
        snapshot.itemsById.clear();
        snapshot.usage = undefined;
        snapshot.compacting = false;
        snapshot.finalAnswer = undefined;
        snapshot.error = undefined;
        break;
      case 'item.started':
      case 'item.completed': {
        const itemId = itemIdentity(event.item);
        if (itemId) {
          snapshot.itemsById.set(itemId, projectedItem(event.item));
          while (snapshot.itemsById.size > 32) snapshot.itemsById.delete(snapshot.itemsById.keys().next().value!);
        }
        if (event.type === 'item.completed') {
          finishProcess(snapshot, event.item);
          if (isContextCompaction(event.item)) snapshot.compacting = false;
          const answer = agentMessageText(event.item);
          if (answer) snapshot.finalAnswer = answer;
        }
        if (event.type === 'item.started' && isContextCompaction(event.item)) snapshot.compacting = true;
        break;
      }
      case 'item.delta':
        if (event.channel === 'reasoning' && event.reasoningSource !== 'public_summary') { changed = false; break; }
        if (event.channel === 'agent_message' || event.channel === 'reasoning' || event.channel === 'plan') {
          appendProcess(snapshot, event);
        } else if (event.channel === 'command') {
          snapshot.commandOutput = appendBounded(snapshot.commandOutput, event.delta);
        } else {
          snapshot.fileChangeOutput = appendBounded(snapshot.fileChangeOutput, event.delta);
        }
        break;
      case 'turn.diff': {
        const safe = sanitizeDetailText(event.diff);
        snapshot.diff = safe.text.slice(0, MAX_PROJECTED_TEXT);
        snapshot.diffTruncated = safe.redacted || safe.text.length > MAX_PROJECTED_TEXT;
        break;
      }
      case 'usage.updated':
        snapshot.usage = event.usage;
        break;
      case 'turn.completed':
        if (snapshot.completedTurnIds.has(event.turnId)) return;
        snapshot.completedTurnIds.add(event.turnId);
        snapshot.phase = terminalPhase(event.status);
        snapshot.pendingActions.clear();
        for (const [key, stream] of snapshot.processStreams) {
          const safe = stream.sanitizer.finish();
          stream.committed = (stream.committed + safe.text).slice(-600);
          const preview = snapshot.processPreviews.get(key);
          if (preview) snapshot.processPreviews.set(key, { ...preview, text: stream.committed, completed: true });
        }
        snapshot.processStreams.clear();
        snapshot.finalAnswer ??= lastAgentMessage(event.turn);
        snapshot.error = turnError(event.turn);
        break;
      case 'backend.server_request':
        if (snapshot.phase === 'running' && typeof event.params === 'object' && event.params !== null) {
          const params = event.params as { threadId?: unknown; turnId?: unknown };
          if (params.threadId === snapshot.threadId && params.turnId === snapshot.turnId) snapshot.generation ??= event.generation;
        }
        changed = false;
        break;
      case 'backend.server_request_resolved':
        // Request packets are not delivery evidence; persisted request facts drive the view.
        changed = false;
        break;
      case 'backend.error':
        snapshot.error = sanitizeDetailText(event.message).text.slice(0, 1000);
        break;
      case 'backend.disconnected':
        snapshot.pendingActions.clear();
        if (snapshot.phase !== 'completed') snapshot.phase = 'interrupted';
        snapshot.error = sanitizeDetailText(event.reason).text.slice(0, 1000);
        break;
      case 'task.exited':
        snapshot.pendingActions.clear();
        if (snapshot.phase === 'running' || snapshot.phase === 'waiting_approval') snapshot.phase = 'interrupted';
        break;
      case 'task.output':
        snapshot.commandOutput = appendBounded(snapshot.commandOutput, event.text);
        break;
      case 'task.restarted':
        changed = false;
        break;
    }
    if (!changed) return;
    snapshot.revision += 1;
    const projected = toSnapshot(snapshot);
    for (const listener of this.listeners) listener(projected);
  }

  get(taskId: string): LiveTurnSnapshot | undefined {
    const snapshot = this.snapshots.get(taskId);
    return snapshot ? toSnapshot(snapshot) : undefined;
  }

  subscribe(listener: (snapshot: LiveTurnSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private snapshotFor(taskId: string): MutableSnapshot {
    const existing = this.snapshots.get(taskId);
    if (existing) return existing;
    const created: MutableSnapshot = {
      taskId,
      phase: 'running',
      pendingActions: new Map(),
      commentary: '',
      processPreviews: new Map(),
      processStreams: new Map(),
      commandOutput: '',
      fileChangeOutput: '',
      itemsById: new Map(),
      compacting: false,
      completedTurnIds: new Set(),
      revision: 0,
      summary: new TurnCardSummaryProjection(),
    };
    this.snapshots.set(taskId, created);
    return created;
  }
}

interface MutableSnapshot {
  summary: TurnCardSummaryProjection;
  processPreviews: Map<string, ProcessPreview>;
  processStreams: Map<string, { sanitizer: DetailSanitizer; committed: string; itemId: string }>;
  diffTruncated?: boolean;
  generation?: number;
  pendingActions: Map<string, DetailPendingAction>;
  taskId: string;
  threadId?: string;
  turnId?: string;
  phase: ProjectedTurnPhase;
  commentary: string;
  commandOutput: string;
  fileChangeOutput: string;
  diff?: string;
  itemsById: Map<string, unknown>;
  usage?: unknown;
  compacting: boolean;
  finalAnswer?: string;
  error?: string;
  completedTurnIds: Set<string>;
  revision: number;
}

const MAX_PROJECTED_TEXT = 4_000;

function appendProcess(snapshot: MutableSnapshot, event: Extract<CodexBackendEvent, { type: 'item.delta' }>): void {
  const source: ProcessPreview['source'] = event.channel === 'reasoning' ? 'summary' : event.channel === 'plan' ? 'plan' : 'progress';
  const key = JSON.stringify([source, event.itemId, event.summaryIndex ?? null]);
  let stream = snapshot.processStreams.get(key);
  if (!stream) {
    if (snapshot.processStreams.size >= 32) return;
    stream = { sanitizer: new DetailSanitizer(), committed: '', itemId: event.itemId };
    snapshot.processStreams.set(key, stream);
  }
  const safe = stream.sanitizer.push(event.delta);
  stream.committed = (stream.committed + safe.text).slice(-600);
  putProcessPreview(snapshot, key, { source, itemId: event.itemId, summaryIndex: event.summaryIndex,
    text: (stream.committed + stream.sanitizer.preview().text).slice(-600) });
}

function putProcessPreview(snapshot: MutableSnapshot, key: string, preview: ProcessPreview): void {
  snapshot.processPreviews.delete(key);
  snapshot.processPreviews.set(key, preview);
  while (snapshot.processPreviews.size > 3) snapshot.processPreviews.delete(snapshot.processPreviews.keys().next().value!);
  snapshot.commentary = [...snapshot.processPreviews.values()].map((entry) => entry.text).join('\n');
}

function finishProcess(snapshot: MutableSnapshot, item: unknown): void {
  if (typeof item !== 'object' || item === null || !('id' in item) || typeof item.id !== 'string') return;
  const itemId = item.id;
  const row = item as Record<string, unknown>;
  const streamedKeys = new Set<string>();
  for (const [key, stream] of snapshot.processStreams) if (stream.itemId === item.id) {
    streamedKeys.add(key);
    stream.committed = (stream.committed + stream.sanitizer.finish().text).slice(-600);
    const preview = snapshot.processPreviews.get(key);
    if (preview) putProcessPreview(snapshot, key, { ...preview, text: stream.committed, completed: true });
  }
  const source: ProcessPreview['source'] | undefined = row.type === 'reasoning' ? 'summary' : row.type === 'plan' ? 'plan' : row.type === 'agentMessage' ? 'progress' : undefined;
  const texts = source === 'summary' ? (Array.isArray(row.summary) ? row.summary : []) : typeof row.text === 'string' ? [row.text] : [];
  if (source) texts.forEach((text, index) => {
    if (typeof text !== 'string') return;
    const summaryIndex = source === 'summary' ? index : undefined;
    const key = JSON.stringify([source, item.id, summaryIndex ?? null]);
    if (!streamedKeys.has(key)) putProcessPreview(snapshot, key, { source, itemId,
      summaryIndex, completed: true, text: sanitizeDetailText(text).text.slice(0, 600) });
  });
  for (const key of streamedKeys) snapshot.processStreams.delete(key);
}

function projectedItem(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return {};
  const item = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const field of ['id', 'type', 'status'] as const) if (typeof item[field] === 'string') result[field] = item[field].slice(0, 128);
  if (item.type === 'agentMessage' && typeof item.text === 'string') result.text = item.text.slice(0, MAX_PROJECTED_TEXT);
  if (item.type === 'commandExecution' && typeof item.command === 'string') {
    result.command = isSensitiveDetailCommand(item.command) ? '[敏感操作]' : sanitizeDetailText(item.command).text.slice(0, 1024);
  }
  return result;
}

function appendBounded(current: string, delta: string): string {
  return (current + delta).slice(-MAX_PROJECTED_TEXT);
}

function itemIdentity(item: unknown): string | undefined {
  return typeof item === 'object' && item !== null && 'id' in item && typeof item.id === 'string' ? item.id : undefined;
}

function agentMessageText(item: unknown): string | undefined {
  if (typeof item !== 'object' || item === null || !('type' in item) || item.type !== 'agentMessage') return undefined;
  if ('text' in item && typeof item.text === 'string' && item.text.trim()) return item.text;
  return undefined;
}

function isContextCompaction(item: unknown): boolean {
  return typeof item === 'object' && item !== null && 'type' in item && item.type === 'contextCompaction';
}

function lastAgentMessage(turn: unknown): string | undefined {
  if (typeof turn !== 'object' || turn === null || !('items' in turn) || !Array.isArray(turn.items)) return undefined;
  return turn.items.map(agentMessageText).filter((value): value is string => Boolean(value)).at(-1);
}

function turnError(turn: unknown): string | undefined {
  if (typeof turn !== 'object' || turn === null || !('error' in turn)) return undefined;
  const error = turn.error;
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return isContextWindowFailure(error.message)
      ? 'Codex 完成上下文压缩后仍超出上下文窗口。Link Bot 未自动切换会话；请使用 `/new --blank` 重置上下文后重试。'
      : error.message;
  }
  return undefined;
}

function terminalPhase(status: string): ProjectedTurnPhase {
  if (status === 'completed') return 'completed';
  if (status === 'interrupted') return 'interrupted';
  return 'failed';
}

export function isContextWindowFailure(value: string): boolean {
  return /context window|context length|maximum context|too many (?:input )?tokens|prompt (?:is )?too long/i.test(value);
}

function isLateTurnEvent(snapshot: MutableSnapshot, event: CodexBackendEvent): boolean {
  if (!('turnId' in event) || typeof event.turnId !== 'string') return false;
  if (event.type === 'turn.completed') return false;
  return snapshot.completedTurnIds.has(event.turnId);
}

function toSnapshot(snapshot: MutableSnapshot): LiveTurnSnapshot {
  return {
    taskId: snapshot.taskId,
    threadId: snapshot.threadId,
    turnId: snapshot.turnId,
    phase: snapshot.phase,
    pendingActions: [...snapshot.pendingActions.values()],
    commentary: snapshot.commentary,
    processPreviews: [...snapshot.processPreviews.values()],
    commandOutput: snapshot.commandOutput,
    fileChangeOutput: snapshot.fileChangeOutput,
    diff: snapshot.diff,
    diffTruncated: snapshot.diffTruncated,
    items: [...snapshot.itemsById.values()],
    usage: snapshot.usage,
    compacting: snapshot.compacting,
    finalAnswer: snapshot.finalAnswer,
    error: snapshot.error,
    revision: snapshot.revision,
    summary: snapshot.summary.get(),
  };
}
