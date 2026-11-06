import type { CodexBackendEvent } from '../backends/CodexBackend.js';
import type { FeishuReplyTarget } from '../feishu/FeishuGateway.js';
import { adaptDetailEvent, detailTurnKey } from './DetailEventAdapter.js';
import type { TurnDetailRecorder } from './TurnDetailRecorder.js';
import type { TurnDetailStore } from './TurnDetailStore.js';
import { TURN_DETAIL_SCHEMA_VERSION, type DetailScope, type DetailTurnBinding, type DetailTurnIdentity } from './TurnDetailTypes.js';
import type { DetailTelemetryPort } from './TurnDetailTelemetry.js';
import type { TurnResultStore } from './TurnResultStore.js';

export interface DetailAcceptedTurn {
  ownerKind: 'task_platform' | 'host_manager';
  taskId: string;
  localTurnId: string;
  userId: string;
  target: FeishuReplyTarget & { chatType?: 'private' | 'group'; topicId?: string };
}

interface ActiveDetail extends DetailAcceptedTurn { startedAt: string; binding?: DetailTurnBinding; scope?: DetailScope; failed?: boolean }

/** Independent of card rendering and liveCards.enabled. All writes are isolated display copies. */
export class AppServerTurnDetailSink {
  private readonly active = new Map<string, ActiveDetail>();

  constructor(private readonly store: TurnDetailStore | undefined, private readonly recorder: Pick<TurnDetailRecorder, 'record'> | undefined,
    private readonly clock: () => Date = () => new Date(), private readonly telemetry?: DetailTelemetryPort,
    private readonly results?: TurnResultStore) {}

  saveResult(identity: DetailTurnIdentity, answer: string, endedAt: string): boolean {
    try {
      const turn = this.store?.getTurn(identity);
      if (!turn || !this.results) return false;
      this.results.save(identity, turn.scope, answer, endedAt); return true;
    } catch { return false; }
  }

  accepted(input: DetailAcceptedTurn): void {
    const previous = this.active.get(input.taskId);
    if (previous) this.interrupt(input.taskId, previous.localTurnId);
    const group = input.target.chatType === 'group';
    const scope: DetailScope | undefined = group
      ? input.target.topicId ? { kind: 'shared_group_topic', chatId: input.target.chatId, topicId: input.target.topicId } : undefined
      : input.userId && !input.target.topicId ? { kind: 'private_user', chatId: input.target.chatId, userId: input.userId } : undefined;
    this.active.set(input.taskId, { ...input, startedAt: this.clock().toISOString(), scope, failed: !scope || !this.store || !this.recorder });
  }

  bind(taskId: string, threadId: string | undefined, codexTurnId: string | undefined): void {
    const active = this.active.get(taskId);
    if (!active || !threadId || !codexTurnId || active.failed || !active.scope || !this.store) return;
    if (active.binding) return;
    active.binding = { ownerKind: active.ownerKind, taskId, localTurnId: active.localTurnId, threadId, codexTurnId };
    try {
      this.store.createTurn({ ...active.binding, schemaVersion: TURN_DETAIL_SCHEMA_VERSION, scope: active.scope,
        startedAt: active.startedAt, lifecycle: 'running', availability: 'available', retainedBytes: 0, truncated: false });
    } catch { active.failed = true; }
  }

  event(event: CodexBackendEvent, eventKey: string): Record<string, unknown> {
    const start = performance.now();
    const result = this.recordEvent(event, eventKey);
    try { this.telemetry?.observe('enqueue', result.detailUnavailable ? 'unavailable' : 'ok', performance.now() - start); } catch { /* Isolated metrics. */ }
    return result;
  }

  private recordEvent(event: CodexBackendEvent, eventKey: string): Record<string, unknown> {
    const active = this.active.get(event.taskId);
    const persisted: Record<string, unknown> = { type: event.type, taskId: event.taskId,
      ...(active ? { detailRef: detailTurnKey(active) } : { detailUnavailable: true }),
      ...('threadId' in event ? { threadId: event.threadId } : {}),
      ...('turnId' in event ? { turnId: event.turnId } : {}),
      ...('itemId' in event ? { itemId: event.itemId } : {}),
      ...('generation' in event ? { generation: event.generation } : {}),
      ...('status' in event ? { status: event.status } : {}),
    };
    if (!active || !this.store || !this.recorder) return { ...persisted, detailUnavailable: true };
    try {
      if (!active.binding && event.type === 'turn.started' && active.scope) {
        this.bind(event.taskId, event.threadId, event.turnId);
      }
      if (active.binding && !active.failed) {
        if (event.type === 'turn.completed' && event.turnId === active.binding.codexTurnId
          && typeof event.turn === 'object' && event.turn !== null && 'items' in event.turn && Array.isArray(event.turn.items)) {
          for (let index = event.turn.items.length - 1; index >= 0; index--) {
            const item = event.turn.items[index] as { type?: string; text?: unknown } | undefined;
            if (item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) {
              this.saveResult(active.binding, item.text.trim(), this.clock().toISOString()); break;
            }
          }
        }
        if (event.type === 'turn.completed' && event.turnId === active.binding.codexTurnId) this.backfillItems(active, event.turn, eventKey);
        const candidate = adaptDetailEvent(active.binding, event);
        if (candidate) this.recorder.record(active.binding, candidate, eventKey, this.clock().toISOString());
      }
      if (event.type === 'backend.disconnected' || event.type === 'task.exited') this.interrupt(event.taskId, active.localTurnId);
      if (event.type === 'turn.completed' && event.turnId === active.binding?.codexTurnId) this.active.delete(event.taskId);
    } catch {
      active.failed = true;
      try { this.store.markStreamGap(active); this.store.markIncomplete(active); } catch { /* Never retry execution or persist raw fallback data. */ }
    }
    if (active.failed) persisted.detailUnavailable = true;
    return persisted;
  }

  interrupt(taskId: string, localTurnId: string): void {
    this.finish(taskId, localTurnId, 'interrupted');
  }

  finish(taskId: string, localTurnId: string, lifecycle: 'completed' | 'failed' | 'interrupted', raw?: unknown): void {
    const active = this.active.get(taskId);
    if (!active || active.localTurnId !== localTurnId) return;
    try {
      if (active.binding && !active.failed) {
        if (raw) this.backfillItems(active, raw, `finish:${localTurnId}`);
        this.recorder?.record(active.binding, { kind: 'terminal', lifecycle }, `finish:${localTurnId}`, this.clock().toISOString());
      }
    } catch { /* Detail persistence cannot stop shutdown. */ }
    this.active.delete(taskId);
  }

  private backfillItems(active: ActiveDetail, raw: unknown, eventKey: string): void {
    if (!active.binding || !this.recorder || typeof raw !== 'object' || raw === null || !('items' in raw) || !Array.isArray(raw.items)) return;
    for (const [index, item] of raw.items.entries()) {
      const candidate = adaptDetailEvent(active.binding, { type: 'item.completed', taskId: active.taskId,
        threadId: active.binding.threadId, turnId: active.binding.codexTurnId!, item });
      if (candidate) this.recorder.record(active.binding, candidate, `${eventKey}:item:${index}`, this.clock().toISOString());
    }
  }
}
