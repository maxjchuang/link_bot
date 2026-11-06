import { randomUUID } from 'node:crypto';
import type { CodexBackendEvent } from '../backends/CodexBackend.js';
import { displayMode, type CodexServiceTier, type ExecutionProfile } from '../tasks/ExecutionProfile.js';
import type { FeishuGateway, FeishuReplyTarget } from '../feishu/FeishuGateway.js';
import { renderFeishuMessage } from '../feishu/FeishuMessageRenderer.js';
import { sanitizeUnresolvedSourceLinks } from '../feishu/SourceReferenceService.js';
import { LiveTurnProjection, type LiveTurnSnapshot } from '../projections/LiveTurnProjection.js';
import {
  appServerCardRecordId,
  newAppServerCardRecord,
  type AppServerTurnCardRecord,
  type AppServerTurnCardStore,
  type RequestReleaseMark,
} from './AppServerTurnCardStore.js';
import { formatCompactTokens } from '../usage/TokenUsageLedger.js';
import type { AppServerRequestRecord } from '../approvals/AppServerRequestTypes.js';
import { sanitizeDetailText, sanitizePublicAnswerText } from '../details/DetailSanitizer.js';
import { renderStructuredTurnCard } from './StructuredTurnCardRenderer.js';
import { renderStructuredFinalCard } from './StructuredFinalCardRenderer.js';
import type { DetailTurnIdentity } from '../details/TurnDetailTypes.js';
import { CardKitApiError } from './LiveTurnCardTypes.js';
import { observeCardDelivery, shownWaiting, waitingSample, settleReleaseMarks, type CardTelemetry } from './CardObservability.js';
import { emptyInlineDetails, type InlineDetailsSnapshot, type InlinePublicationContext } from '../details/InlineTurnDetails.js';
import { inlineCardRegions } from './InlineTaskCardLayout.js';
import { isTimelineTaskCard, timelineTaskShell } from './TimelineTaskCardLayout.js';

export interface AppServerTurnExperienceInput {
  taskId: string;
  turnId: string;
  projectId?: string;
  displayLabel?: string;
  messageId?: string;
  requesterUserId?: string;
  target: FeishuReplyTarget;
  ownerKind?: AppServerTurnCardRecord['ownerKind'];
  prompt?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: CodexServiceTier;
  pendingProfile?: ExecutionProfile;
  conversationRecovery?: { compactionEpoch: number; messageCount: number };
}

export interface AppServerTurnExperience {
  accepted(input: AppServerTurnExperienceInput): Promise<void>;
  requestChanged?(request: AppServerRequestRecord): Promise<void>;
  profileChanged?(taskId: string, effective: ExecutionProfile, pending?: ExecutionProfile): Promise<void>;
  event(event: CodexBackendEvent): Promise<boolean>;
  interruptTurn?(ownerKind: AppServerTurnCardRecord['ownerKind'], localTurnId: string, reason: string): Promise<boolean>;
  recoverOpenCards?(
    ownerKind: AppServerTurnCardRecord['ownerKind'],
    resolve: (record: AppServerTurnCardRecord) => Promise<{ status: 'completed' | 'failed' | 'interrupted'; answer?: string } | undefined>,
  ): Promise<void>;
  dispose?(): void;
}

interface ActiveCard extends AppServerTurnExperienceInput {
  inlineDetails?: boolean;
  inlineSnapshot?: InlineDetailsSnapshot;
  inlineSnapshotAt?: number;
  regionSignatures?: Map<string, string>;
  // A failed structural edit has an uncertain remote outcome. On the next fresh
  // authorization, reconcile by replacing the inner region once (never retry adds).
  regionResync?: boolean;
  headerSignature?: string;
  timelineShellTag?: string;
  structuredView?: boolean;
  detailCardRef?: string;
  inFlight?: Promise<void>;
  heartbeat?: NodeJS.Timeout;
  progressRetries?: number;
  urgent?: boolean;
  recordId: string;
  cardId: string;
  sequence: number;
  startedAt: number;
  timer?: NodeJS.Timeout;
  dirty: boolean;
  failed: boolean;
}

export class FeishuAppServerTurnExperience implements AppServerTurnExperience {
  private readonly projection = new LiveTurnProjection();
  private readonly cards = new Map<string, ActiveCard>();
  private readonly finalizationTimers = new Map<string, NodeJS.Timeout>();
  private readonly finalizationFlights = new Map<string, Promise<boolean>>();

  constructor(
    private readonly gateway: Pick<FeishuGateway,
      'createCardKitEntity' | 'sendCardKitEntityToTarget'
      | 'updateCardKitElement' | 'replaceCardKitEntity'>
      & Partial<Pick<FeishuGateway, 'addReaction' | 'updateCardKitRegions'>>,
    private readonly refreshIntervalMs = 1_000,
    private readonly clock: () => Date = () => new Date(),
    private readonly store: AppServerTurnCardStore = new MemoryAppServerTurnCardStore(),
    private readonly defaultOwnerKind: AppServerTurnCardRecord['ownerKind'] = 'task_platform',
    private readonly resolveSourceReferences?: (taskId: string, markdown: string) => Promise<string>,
    private readonly detailUi?: {
      enabled?: boolean;
      inlineEnabled?: boolean;
      flush?(): Promise<void>;
      readInline?(identity: DetailTurnIdentity, context: InlinePublicationContext): Promise<InlineDetailsSnapshot>;
      registerCard(identity: DetailTurnIdentity): string | undefined;
      saveResult?(identity: DetailTurnIdentity, answer: string, endedAt: string): void | { text: string; hasMore: boolean; endedAt: string };
    },
    private readonly telemetry?: CardTelemetry,
  ) {}

  async requestChanged(request: AppServerRequestRecord): Promise<void> {
    const card = this.cards.get(request.taskId);
    if (!card || (request.localTurnId && request.localTurnId !== card.turnId)) return;
    const before = this.projection.get(request.taskId);
    this.projection.updateRequest(request);
    const snapshot = this.projection.get(request.taskId);
    const at = request.deliveredAt ?? request.invalidatedAt;
    const removed = before?.revision !== snapshot?.revision && before?.pendingActions?.some((action) => action.requestRef === request.id)
      && !snapshot?.pendingActions?.some((action) => action.requestRef === request.id);
    const released = removed && at && Number.isFinite(Date.parse(at)) && Date.parse(at) <= this.clock().getTime();
    if (removed && !released) { try { this.telemetry?.observeReleaseUnavailable?.('missing_timestamp'); } catch { /* Isolated metrics. */ } }
    if (released && (this.store.get(card.recordId)?.requestReleasePending?.length ?? 0) >= 32) {
      try { this.telemetry?.observeReleaseUnavailable?.('capacity'); } catch { /* Isolated metrics. */ }
    }
    this.store.update(card.recordId, (current) => ({ ...current,
      ...(released ? { requestReleasePending: [...(current.requestReleasePending ?? []).filter((mark) => mark.requestRef !== request.id),
        { requestRef: request.id, at }].slice(0, 32) } : {}),
      snapshot: this.detailUi && snapshot ? { ...snapshot, finalAnswer: undefined } : snapshot }));
    this.schedule(request.taskId, true);
  }

  async accepted(input: AppServerTurnExperienceInput): Promise<void> {
    if (input.messageId) {
      await this.gateway.addReaction?.(input.messageId, 'Get').catch(() => undefined);
    }
    const ownerKind = input.ownerKind ?? this.defaultOwnerKind;
    let detailCardRef: string | undefined;
    try { if (this.detailUi?.enabled !== false) detailCardRef = this.detailUi?.registerCard({ ownerKind, taskId: input.taskId, localTurnId: input.turnId }); } catch { /* The display cannot stop execution. */ }
    const record = newAppServerCardRecord({
      ownerKind, taskId: input.taskId, localTurnId: input.turnId,
      projectId: input.projectId, displayLabel: input.displayLabel,
      target: input.target, requestMessageId: input.messageId, prompt: input.prompt,
      requesterUserId: input.requesterUserId,
      model: input.model, reasoningEffort: input.reasoningEffort, now: this.clock().toISOString(),
      serviceTier: input.serviceTier, pendingProfile: input.pendingProfile,
    });
    record.structuredView = this.detailUi !== undefined && this.detailUi.enabled !== false;
    record.inlineDetails = record.structuredView && this.detailUi?.inlineEnabled === true;
    record.detailCardRef = detailCardRef;
    this.store.save(record);
    try {
      const initialCard = record.structuredView ? structuredCard(input.displayLabel ?? input.projectId ?? '纯对话', undefined, 0, record, this.clock().getTime(), record.inlineDetails ? emptyInlineDetails() : undefined)
        : runningCard(input.displayLabel ?? input.projectId ?? '纯对话', undefined, 0, input);
      const created = await observeCardDelivery(this.telemetry, 'card_create', initialCard, () => this.gateway.createCardKitEntity(initialCard));
      this.store.update(record.id, (current) => ({ ...current, cardId: created.cardId }));
      const sent = await observeCardDelivery(this.telemetry, 'card_send', initialCard,
        () => this.gateway.sendCardKitEntityToTarget(input.target, created.cardId, record.sendUuid));
      try { this.telemetry?.observeWaiting?.('not_waiting'); } catch { /* Isolated metrics. */ }
      this.store.update(record.id, (current) => ({
        ...current, cardId: created.cardId, cardMessageId: sent.messageId, state: 'live',
      }));
      this.cards.set(input.taskId, {
        inlineDetails: record.inlineDetails,
        ...(record.inlineDetails ? { inlineSnapshot: emptyInlineDetails(), headerSignature: JSON.stringify(initialCard.header),
          timelineShellTag:timelineTaskShell(initialCard)?.tag,
          regionSignatures: new Map(inlineCardRegions(initialCard).map((region) => [region.elementId, JSON.stringify(region.element)])) } : {}),
        ...input, ownerKind, structuredView: record.structuredView, detailCardRef, recordId: record.id, cardId: created.cardId, sequence: 1, startedAt: Date.parse(record.startedAt),
        dirty: false, failed: false,
      });
      const active = this.cards.get(input.taskId)!;
      if (active.structuredView) {
        active.heartbeat = setInterval(() => this.schedule(input.taskId, true), 15000);
        active.heartbeat.unref();
      }
      const snapshot = this.projection.get(input.taskId);
      if (snapshot) this.schedule(input.taskId);
    } catch (error) {
      this.store.update(record.id, (current) => ({
        ...current, state: record.structuredView ? 'creating' : 'fallback', lastError: error instanceof Error ? error.message : String(error),
      }));
      if (record.structuredView) {
        // A missing running card must not discard the future result or terminal intent.
        this.cards.set(input.taskId, { ...input, ownerKind, structuredView: true, detailCardRef,
          inlineDetails: record.inlineDetails,
          recordId: record.id, cardId: this.store.get(record.id)?.cardId ?? '', sequence: 1,
          startedAt: Date.parse(record.startedAt), dirty: false, failed: true });
      }
      // The durable completion outbox remains the delivery fallback.
    }
  }

  async profileChanged(taskId: string, effective: ExecutionProfile, pending?: ExecutionProfile): Promise<void> {
    const card = this.cards.get(taskId);
    if (!card) return;
    card.model = effective.model;
    card.reasoningEffort = effective.reasoningEffort;
    card.serviceTier = effective.serviceTier;
    card.pendingProfile = pending;
    this.store.update(card.recordId, (current) => ({
      ...current,
      model: effective.model,
      reasoningEffort: effective.reasoningEffort,
      serviceTier: effective.serviceTier,
      pendingProfile: pending,
    }));
    card.dirty = true;
    this.schedule(taskId);
  }

  async event(event: CodexBackendEvent): Promise<boolean> {
    this.projection.append(event);
    if (event.type === 'backend.server_request' && this.cards.get(event.taskId)?.ownerKind === 'host_manager'
      && ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput'].includes(event.method)) {
      this.projection.append({ type: 'backend.error', taskId: event.taskId,
        message: '当前私聊 Host Manager 尚未接入交互审批或输入请求，未发送可操作卡片。请使用支持该操作的任务会话处理。' });
    }
    const snapshot = this.projection.get(event.taskId);
    const card = this.cards.get(event.taskId);
    if (!snapshot || !card) return false;
    this.store.update(card.recordId, (current) => ({
      ...current, snapshot: this.detailUi ? { ...snapshot, finalAnswer: undefined } : snapshot,
      ...(snapshot.turnId ? { codexTurnId: snapshot.turnId } : {}),
    }));
    if (event.type === 'turn.completed') {
      if (card.timer) clearTimeout(card.timer);
      if (card.heartbeat) clearInterval(card.heartbeat);
      card.dirty = false;
      try {
        await card.inFlight;
        const originalAnswer = snapshot.finalAnswer?.trim()
          || snapshot.error?.trim()
          || `任务${snapshot.phase === 'completed' ? '已完成' : '已结束'}。`;
        const resolvedAnswer = this.resolveSourceReferences
          ? await this.resolveSourceReferences(event.taskId, originalAnswer).catch(() => originalAnswer)
          : originalAnswer;
        const answer = sanitizePublicAnswerText(resolvedAnswer);
        const rendered = renderFeishuMessage({
          kind: snapshot.phase === 'completed' ? 'completion' : 'error',
          bodyMarkdown: answer, fallbackText: answer,
        }, { verbosity: 'normal' });
        const finalCard = await this.structuredFinal(this.store.get(card.recordId)!, answer,
          snapshot.phase === 'completed' ? 'completed' : snapshot.phase === 'interrupted' ? 'interrupted' : 'failed') ?? (rendered.preferred.kind === 'card'
          ? rendered.preferred.payload
          : { schema: '2.0', body: { elements: [{ tag: 'markdown', content: answer }] } });
        this.allocateFinalization(card.recordId, finalCard, snapshot.phase === 'interrupted' ? 'interrupted' : 'finalized');
        const delivered = await this.retryFinalization(this.store.get(card.recordId)!);
        if (!delivered) this.scheduleFinalizationRetry(card.recordId);
        this.cards.delete(event.taskId);
        return delivered || this.ownsStructuredFinal(card.recordId);
      } catch (error) {
        card.failed = true;
        this.store.update(card.recordId, (current) => ({
          ...current, state: current.finalizationIntent ? 'finalizing' : 'fallback',
          lastError: error instanceof Error ? error.message : String(error),
        }));
        this.cards.delete(event.taskId);
        this.scheduleFinalizationRetry(card.recordId);
        return this.ownsStructuredFinal(card.recordId);
      }
    }
    this.schedule(event.taskId);
    return false;
  }

  /** Existing structured final delivery survives disabling new live cards; do not replay legacy drafts. */
  async recoverFinalizations(ownerKind?: AppServerTurnCardRecord['ownerKind']): Promise<void> {
    for (const record of this.store.listOpen(ownerKind)) {
      if (record.structuredView && record.finalizationIntent && !await this.retryFinalization(record)) this.scheduleFinalizationRetry(record.id);
    }
  }

  async recoverOpenCards(
    ownerKind: AppServerTurnCardRecord['ownerKind'],
    resolve: (record: AppServerTurnCardRecord) => Promise<{ status: 'completed' | 'failed' | 'interrupted'; answer?: string } | undefined>,
  ): Promise<void> {
    for (const record of this.store.listOpen(ownerKind)) {
      let current = record;
      if (current.finalizationIntent) {
        if (!await this.retryFinalization(current)) this.scheduleFinalizationRetry(current.id);
        continue;
      }
      // Startup recovery can start new continuations before it reaches cards.
      // Cards owned by this live instance are not abandoned by a prior process.
      if (this.cards.get(current.taskId)?.recordId === current.id) continue;
      if (!current.cardId && !current.structuredView) {
        try {
          const recoveryCard = current.structuredView
            ? structuredCard(current.displayLabel ?? current.projectId ?? '纯对话', current.snapshot, 0, current, this.clock().getTime())
            : runningCard(current.displayLabel ?? current.projectId ?? '纯对话', current.snapshot, 0, current);
          const created = await observeCardDelivery(this.telemetry, 'card_create', recoveryCard, () => this.gateway.createCardKitEntity(recoveryCard));
          current = this.store.update(current.id, (value) => ({ ...value, cardId: created.cardId })) ?? current;
        } catch (error) {
          this.store.update(current.id, (value) => ({ ...value, state: 'fallback', lastError: error instanceof Error ? error.message : String(error) }));
          continue;
        }
      }
      if (!current.cardMessageId && !current.structuredView) {
        try {
          const sent = await observeCardDelivery(this.telemetry, 'card_send',
            runningCard(current.displayLabel ?? current.projectId ?? '纯对话', current.snapshot, 0, current),
            () => this.gateway.sendCardKitEntityToTarget(current.target, current.cardId!, current.sendUuid));
          try { this.telemetry?.observeWaiting?.(shownWaiting(current.snapshot, false).length ? 'unknown' : 'not_waiting'); } catch { /* Recovery has no live request truth. */ }
          current = this.store.update(current.id, (value) => ({ ...value, cardMessageId: sent.messageId, state: 'live' })) ?? current;
        } catch (error) {
          this.store.update(current.id, (value) => ({ ...value, state: 'fallback', lastError: error instanceof Error ? error.message : String(error) }));
          continue;
        }
      }
      this.store.update(current.id, (value) => ({ ...value, state: 'recovering' }));
      const resolution = await resolve(current) ?? { status: 'interrupted' as const };
      const originalAnswer = resolution.answer?.trim() || (resolution.status === 'interrupted'
        ? '机器人在任务执行期间发生重启，无法确认原任务已完整完成。任务已中断，请重新发送请求或要求继续核验。'
        : resolution.status === 'failed' ? '任务执行失败。' : '任务已完成。');
      const resolvedAnswer = this.resolveSourceReferences
        ? await this.resolveSourceReferences(record.taskId, originalAnswer).catch(() => originalAnswer)
        : originalAnswer;
      const answer = sanitizePublicAnswerText(resolvedAnswer);
      const rendered = renderFeishuMessage({
        kind: resolution.status === 'completed' ? 'completion' : 'error', bodyMarkdown: answer, fallbackText: answer,
      }, { verbosity: 'normal' });
      const finalCard = await this.structuredFinal(current, answer, resolution.status) ?? (rendered.preferred.kind === 'card' ? rendered.preferred.payload
        : { schema: '2.0', body: { elements: [{ tag: 'markdown', content: answer }] } });
      const terminalState = resolution.status === 'interrupted' ? 'interrupted' as const : 'finalized' as const;
      this.allocateFinalization(current.id, finalCard, terminalState);
      if (!await this.retryFinalization(this.store.get(current.id)!)) this.scheduleFinalizationRetry(current.id);
    }
  }

  async interruptTurn(
    ownerKind: AppServerTurnCardRecord['ownerKind'], localTurnId: string, reason: string,
  ): Promise<boolean> {
    reason = sanitizePublicAnswerText(reason);
    const record = this.store.get(appServerCardRecordId(ownerKind, localTurnId));
    if (!record || (!record.cardId && !record.structuredView) || ['finalized', 'interrupted', 'fallback'].includes(record.state)) return false;
    if (record.finalizationIntent) {
      // Late reset/shutdown must not replace a completed answer already owned by delivery.
      const delivered = await this.retryFinalization(record);
      if (!delivered) this.scheduleFinalizationRetry(record.id);
      return delivered || this.ownsStructuredFinal(record.id);
    }
    const active = this.cards.get(record.taskId);
    if (active?.recordId === record.id) {
      if (active.timer) clearTimeout(active.timer);
      if (active.heartbeat) clearInterval(active.heartbeat);
      active.dirty = false;
      await active.inFlight;
    }
    const rendered = renderFeishuMessage({ kind: 'error', bodyMarkdown: reason, fallbackText: reason }, { verbosity: 'normal' });
    const finalCard = await this.structuredFinal(record, reason, 'interrupted') ?? (rendered.preferred.kind === 'card' ? rendered.preferred.payload
      : { schema: '2.0', body: { elements: [{ tag: 'markdown', content: reason }] } });
    this.allocateFinalization(record.id, finalCard, 'interrupted');
    const delivered = await this.retryFinalization(this.store.get(record.id)!);
    if (!delivered) this.scheduleFinalizationRetry(record.id);
    if (this.cards.get(record.taskId)?.recordId === record.id) this.cards.delete(record.taskId);
    return delivered || this.ownsStructuredFinal(record.id);
  }

  private async structuredFinal(record: AppServerTurnCardRecord, answer: string,
    phase: 'completed' | 'failed' | 'interrupted'): Promise<Record<string, unknown> | undefined> {
    let result: { text: string; hasMore: boolean; endedAt: string } | undefined;
    try {
      result = this.detailUi?.saveResult?.({ ownerKind: record.ownerKind, taskId: record.taskId,
        localTurnId: record.localTurnId }, answer, this.clock().toISOString()) || undefined;
    } catch { /* Keep the same layout and explicitly report incomplete result retention. */ }
    if (!record.structuredView) return undefined;
    const available = result && (!result.hasMore || record.detailCardRef) ? result : undefined;
    const full = sanitizePublicAnswerText(answer);
    // The storage browser's 2,000-code-point page size is NOT the card capacity.
    // Prefer the entire public answer whenever the serialized card can hold it.
    const canonical = available && !available.hasMore ? available.text : full;
    const footer = statusFooter(record, contextUsage(record.snapshot?.usage),
      Date.parse(result?.endedAt ?? this.clock().toISOString()) - Date.parse(record.startedAt)).replaceAll('等待上报', '未上报').split('\n');
    try {
      this.store.update(record.id, (value) => ({ ...value,
        snapshot: value.snapshot ? { ...value.snapshot, finalAnswer: undefined } : undefined }));
    } catch { /* Result display storage cannot stop execution or recovery. */ }
    const inlineDetails = record.inlineDetails ? await this.readInline(record, true) : undefined;
    const elapsedMs = Date.parse(result?.endedAt ?? this.clock().toISOString()) - Date.parse(record.startedAt);
    const render = (text: string, hasMore: boolean) => renderStructuredFinalCard({
      label: record.displayLabel ?? record.projectId ?? '纯对话', inlineDetails,
      cardRef: record.detailCardRef, phase, answer: text, finalAnswer: canonical, hasMore, footer, elapsedMs });
    try {
      // An answer larger than the entire budget cannot fit even with no process
      // preview. Avoid serializing that oversized answer through every shrink pass.
      if (Buffer.byteLength(canonical) <= 24000) {
        const card = render(canonical, false);
        if (Buffer.byteLength(JSON.stringify(card)) <= 24000) return card;
      }
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'inline_card_budget_exceeded') throw error;
    }
    // Actual overflow only: keep a bounded preview and trailing links visible,
    // with an explicit, freshly-authorized file-download route (not pagination).
    // Preserve link-bearing Markdown lines verbatim, including parentheses and
    // query strings; reconstructing URLs with a delimiter regex breaks links.
    const linkLines = [...new Set(canonical.split('\n').filter(line => /https?:\/\//.test(line)))];
    const links: string[] = []; let linkBytes = 0;
    for (const line of linkLines) {
      const bytes = Buffer.byteLength(JSON.stringify(line));
      if (linkBytes + bytes > 6000) continue;
      links.push(line); linkBytes += bytes;
    }
    const preview = Array.from(canonical).slice(0, 2000).join('')
      + (links.length ? `\n\n相关链接：\n${links.join('\n')}` : '')
      + (links.length < linkLines.length ? '\n部分链接超出卡片容量，请下载完整答复查看。' : '')
      + (!available || !record.detailCardRef ? '\n\n⚠️ 答复超出单卡容量，且完整答复存储或入口不可用；此处仅为部分预览。' : '');
    return render(preview, !!available && !!record.detailCardRef);
  }

  private async readInline(record: AppServerTurnCardRecord, flush = false): Promise<InlineDetailsSnapshot> {
    let incomplete = false;
    if (flush && this.detailUi?.flush) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([this.detailUi.flush(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('inline_flush_timeout')), 2000);
        })]);
      } catch { incomplete = true; }
      finally { if (timer) clearTimeout(timer); }
    }
    try {
      const value = await this.detailUi?.readInline?.({ ownerKind: record.ownerKind, taskId: record.taskId, localTurnId: record.localTurnId },
        { target: record.target, requesterUserId: record.requesterUserId, requestMessageId: record.requestMessageId }) ?? emptyInlineDetails('unavailable');
      return { ...value, incomplete: value.incomplete || incomplete };
    } catch { return emptyInlineDetails('unavailable'); }
  }

  dispose(): void {
    for (const card of this.cards.values()) {
      if (card.timer) clearTimeout(card.timer);
      if (card.heartbeat) clearInterval(card.heartbeat);
    }
    this.cards.clear();
    for (const timer of this.finalizationTimers.values()) clearTimeout(timer);
    this.finalizationTimers.clear();
  }

  private allocateFinalization(
    recordId: string, card: Record<string, unknown>, terminalState: 'finalized' | 'interrupted',
  ): { card: Record<string, unknown>; sequence: number; uuid: string } {
    const uuid = randomUUID();
    const updated = this.store.update(recordId, (current) => {
      if (current.finalizationIntent) return current;
      const intent = { card, sequence: current.nextSequence, uuid, terminalState };
      return { ...current, state: 'finalizing', nextSequence: current.nextSequence + 1, finalizationIntent: intent };
    });
    if (!updated?.finalizationIntent) throw new Error(`App Server live card record not found: ${recordId}`);
    return {
      card: updated.finalizationIntent.card,
      sequence: updated.finalizationIntent.sequence,
      uuid: updated.finalizationIntent.uuid,
    };
  }

  private retryFinalization(record: AppServerTurnCardRecord): Promise<boolean> {
    const prior = this.finalizationFlights.get(record.id);
    if (prior) return prior;
    const run = this.deliverFinalization(record);
    this.finalizationFlights.set(record.id, run);
    return run.finally(() => { if (this.finalizationFlights.get(record.id) === run) this.finalizationFlights.delete(record.id); });
  }

  private async deliverFinalization(record: AppServerTurnCardRecord): Promise<boolean> {
    // Re-read the authoritative delivery owner; queued sends must never race original-card updates.
    record = this.store.get(record.id) ?? record;
    if (record.deliveryFailure) return false;
    if (!record.finalizationIntent) return ['finalized', 'interrupted'].includes(record.state);
    if (record.finalizationIntent.deliveryMode === 'outbox') return true;
    if (record.finalizationIntent.fallbackRequested || !record.cardId || !record.cardMessageId) {
      return this.queueFinalFallback(record.id);
    }
    const intent = record.finalizationIntent;
    // Do not replay old task results into today's conversations after an upgrade.
    if (!record.structuredView && record.lastError && this.clock().getTime() - Date.parse(record.startedAt) > 86_400_000) {
      return this.quarantineFinal(record.id, 'historical_legacy');
    }
    if ((intent.attempts ?? 0) >= 12) return this.quarantineFinal(record.id, 'retry_exhausted');
    if (intent.nextAttemptAt && Date.parse(intent.nextAttemptAt) > this.clock().getTime()) return false;
    const attempts = (intent.attempts ?? 0) + 1;
    this.store.update(record.id, (current) => ({ ...current, finalizationIntent: { ...current.finalizationIntent!, attempts,
      nextAttemptAt: new Date(this.clock().getTime() + Math.min(30_000, 1_000 * 2 ** (attempts - 1))).toISOString() } }));
    const cardId = record.cardId;
    try {
      await observeCardDelivery(this.telemetry, record.structuredView ? 'card_final' : 'legacy_card_final', intent.card, () => record.inlineDetails && !intent.card.header && !isTimelineTaskCard(intent.card)
        ? this.updateInlineRegions(cardId, intent.card, intent.sequence, intent.uuid)
        : this.gateway.replaceCardKitEntity({
        cardId, card: intent.card,
        sequence: intent.sequence, uuid: intent.uuid,
      }));
      try { this.telemetry?.observeWaiting?.('not_waiting'); } catch { /* Isolated metrics. */ }
      this.acknowledgeReleases(record.id, record.requestReleasePending ?? [], []);
      this.store.update(record.id, (current) => ({
        ...current, state: record.finalizationIntent!.terminalState ?? 'finalized', finalizationIntent: undefined,
      }));
      const timer = this.finalizationTimers.get(record.id);
      if (timer) clearTimeout(timer);
      this.finalizationTimers.delete(record.id);
      return true;
    } catch (error) {
      this.store.update(record.id, (current) => ({ ...current, lastError: error instanceof Error ? error.message : String(error) }));
      if (error instanceof CardKitApiError && error.retryAfterMs) {
        this.store.update(record.id, (current) => ({ ...current, finalizationIntent: { ...current.finalizationIntent!,
          nextAttemptAt: new Date(this.clock().getTime() + Math.max(error.retryAfterMs!, 1000 * 2 ** Math.min(attempts - 1, 5))).toISOString() } }));
      }
      if (error instanceof CardKitApiError && (error.category === 'permanent' || error.category === 'payload')) {
        if (!record.structuredView) {
          const text = sanitizePublicAnswerText(record.snapshot?.finalAnswer ?? '').trim();
          if (!text) return this.quarantineFinal(record.id, 'permanent');
          this.store.update(record.id, (current) => ({ ...current,
            finalizationIntent: { ...current.finalizationIntent!, fallbackText: boundedFallbackText(text) } }));
        }
        this.store.update(record.id, (current) => ({ ...current,
          finalizationIntent: { ...current.finalizationIntent!, fallbackRequested: true } }));
        return this.queueFinalFallback(record.id);
      }
      if (attempts >= 12) return this.quarantineFinal(record.id, 'retry_exhausted');
      return false;
    }
  }

  private updateInlineRegions(cardId: string, payload: Record<string, unknown>, sequence: number, uuid: string): Promise<void> {
    if (!this.gateway.updateCardKitRegions) return Promise.reject(new Error('inline_regions_unavailable'));
    return this.gateway.updateCardKitRegions({ cardId, regions: inlineCardRegions(payload), sequence, uuid });
  }

  private ownsStructuredFinal(id: string): boolean {
    const record = this.store.get(id);
    return record?.structuredView === true && record.finalizationIntent !== undefined;
  }

  private queueFinalFallback(id: string): boolean {
    const record = this.store.get(id);
    if (!record?.finalizationIntent || record.deliveryFailure) return false;
    if ((record.finalizationIntent.fallbackAttempts ?? 0) >= 12) return this.quarantineFinal(id, 'retry_exhausted');
    this.store.update(id, (current) => ({ ...current, finalizationIntent: { ...current.finalizationIntent!,
      fallbackAttempts: (current.finalizationIntent!.fallbackAttempts ?? 0) + 1 } }));
    try { return this.store.enqueueFinalFallback?.(id) ?? false; }
    catch { return false; } // Keep the saved intent; retry the atomic handoff later.
  }

  private quarantineFinal(id: string, reason: NonNullable<AppServerTurnCardRecord['deliveryFailure']>): false {
    this.store.update(id, (current) => ({ ...current, state: 'fallback', deliveryFailure: reason }));
    return false;
  }

  private scheduleFinalizationRetry(recordId: string, attempt = 1): void {
    const saved = this.store.get(recordId);
    if (!saved?.finalizationIntent || saved.deliveryFailure || saved.finalizationIntent.deliveryMode === 'outbox') return;
    if (this.finalizationTimers.has(recordId)) return;
    const delay = Math.max(1_000, Date.parse(saved.finalizationIntent.nextAttemptAt ?? '') - this.clock().getTime()
      || Math.min(30_000, 1_000 * (2 ** Math.max(0, attempt - 1))));
    const timer = setTimeout(() => {
      this.finalizationTimers.delete(recordId);
      const record = this.store.get(recordId);
      if (!record?.finalizationIntent) return;
      void this.retryFinalization(record).then((completed) => {
        if (!completed) this.scheduleFinalizationRetry(recordId, attempt + 1);
      }).catch(() => this.scheduleFinalizationRetry(recordId, attempt + 1));
    }, delay);
    timer.unref();
    this.finalizationTimers.set(recordId, timer);
  }

  private schedule(taskId: string, immediate = false): void {
    const card = this.cards.get(taskId);
    if (!card || card.failed) return;
    card.dirty = true;
    card.urgent ||= immediate;
    if (card.inFlight) return;
    if (card.timer && !immediate) return;
    if (card.timer) clearTimeout(card.timer);
    card.timer = setTimeout(() => {
      card.timer = undefined;
      if (!card.dirty) return;
      card.dirty = false;
      card.urgent = false;
      let shown: string[] = [], releases: RequestReleaseMark[] = [];
      const update = (async () => {
        let freshInline = false;
        if (card.inlineDetails && (card.inlineSnapshotAt === undefined || this.clock().getTime() - card.inlineSnapshotAt >= 5000)) {
          const record = this.store.get(card.recordId);
          card.inlineSnapshot = record ? await this.readInline(record) : emptyInlineDetails('unavailable');
          card.inlineSnapshotAt = this.clock().getTime();
          freshInline = true;
        }
        // Re-read after publication authorization; approval/expiry may have changed meanwhile.
        const render = () => {
          const snapshot = this.projection.get(taskId);
          shown = shownWaiting(snapshot, card.structuredView === true);
          releases = this.store.get(card.recordId)?.requestReleasePending ?? [];
          return card.structuredView ? structuredCard(card.displayLabel ?? card.projectId ?? '纯对话', snapshot,
            this.clock().getTime() - card.startedAt, card, this.clock().getTime(), card.inlineDetails ? card.inlineSnapshot ?? emptyInlineDetails() : undefined)
            : runningElement(snapshot, this.clock().getTime() - card.startedAt, card);
        };
        let payload = render(), regions = card.inlineDetails ? inlineCardRegions(payload) : undefined;
        const headerChanged = () => !!regions && JSON.stringify(payload.header) !== card.headerSignature;
        const shellChanged = () => !!regions && timelineTaskShell(payload)?.tag !== card.timelineShellTag;
        const dirty = () => regions?.filter((region) => card.regionResync || card.regionSignatures?.get(region.elementId) !== JSON.stringify(region.element));
        let changed = dirty();
        // Main-body budget changes can reveal a different subset of cached details. Such
        // publication still needs a fresh scope proof, even inside the five-second throttle.
        // A header transition republishes the entire card, including cached
        // previews. Always refresh their scope proof before such a replacement.
        if (!freshInline && (headerChanged() || shellChanged() || changed?.some((region) => region.elementId.startsWith('inline_') || region.elementId === 'timeline_content'))) {
          const record = this.store.get(card.recordId);
          card.inlineSnapshot = record ? await this.readInline(record) : emptyInlineDetails('unavailable');
          card.inlineSnapshotAt = this.clock().getTime();
          payload = render(); regions = inlineCardRegions(payload); changed = dirty();
        }
        if (changed && !changed.length && !headerChanged() && !shellChanged()) return;
        // Replace the shell only when changing between the initial text-only
        // placeholder and an actual process panel. Normal updates never own it.
        const targetRegions = shellChanged() ? [...(changed ?? []).filter(region=>region.elementId!=='timeline_content'),
          {elementId:'turn_timeline',element:timelineTaskShell(payload)!}] : changed;
        const updates = targetRegions?.map(region=>{
          const previous = card.regionSignatures?.get(region.elementId);
          return region.elementId==='timeline_content' && previous && !card.regionResync
            ? {...region,previousElement:JSON.parse(previous) as Record<string,unknown>} : region;
        });
        const operation = this.allocateUpdate(card.recordId);
        await observeCardDelivery(this.telemetry, 'card_update', payload, () => regions && !headerChanged()
          ? this.gateway.updateCardKitRegions ? this.gateway.updateCardKitRegions({ cardId: card.cardId, regions: updates!, ...operation })
            : Promise.reject(new Error('inline_regions_unavailable'))
          : card.structuredView ? this.gateway.replaceCardKitEntity({ cardId: card.cardId, card: payload, ...operation })
            : this.gateway.updateCardKitElement({ cardId: card.cardId, elementId: 'app_server_progress', element: payload, ...operation }));
        if (regions) {
          card.regionSignatures = new Map(regions.map((region) => [region.elementId, JSON.stringify(region.element)]));
          card.headerSignature = JSON.stringify(payload.header);
          card.timelineShellTag = timelineTaskShell(payload)?.tag;
          card.regionResync = false;
        }
      })();
      card.inFlight = update.then(() => {
        card.progressRetries = 0;
        try { this.telemetry?.observeWaiting?.(waitingSample(shown, this.projection.get(taskId), this.clock().getTime())); } catch { /* Isolated metrics. */ }
        this.acknowledgeReleases(card.recordId, releases, shown);
      }).catch((error) => {
        card.regionResync = true;
        card.failed = error instanceof CardKitApiError && error.category !== 'retryable';
        if (!card.failed) { card.dirty = true; card.progressRetries = (card.progressRetries ?? 0) + 1; }
        this.store.update(card.recordId, (current) => ({ ...current, lastError: error instanceof Error ? error.message : String(error) }));
      }).finally(() => {
        card.inFlight = undefined;
        if (card.dirty && this.cards.get(taskId) === card && this.projection.get(taskId)?.phase === 'running') this.schedule(taskId, card.urgent);
      });
    }, card.urgent ? 0 : Math.min(30000, this.refreshIntervalMs * 2 ** Math.max(0, (card.progressRetries ?? 0) - 1)));
    card.timer.unref();
  }

  private allocateUpdate(recordId: string): { sequence: number; uuid: string } {
    const uuid = randomUUID();
    const updated = this.store.update(recordId, (current) => ({ ...current, nextSequence: current.nextSequence + 1 }));
    if (!updated) throw new Error(`App Server live card record not found: ${recordId}`);
    return { sequence: updated.nextSequence - 1, uuid };
  }

  private acknowledgeReleases(recordId: string, captured: RequestReleaseMark[], shown: string[]): void {
    if (!captured.length) return;
    try {
      let elapsed: number[] = [];
      this.store.update(recordId, (current) => {
        const settled = settleReleaseMarks(current, captured, shown, this.clock().getTime());
        elapsed = settled.elapsed;
        return { ...current, requestReleasePending: settled.remaining };
      });
      for (const value of elapsed) { try { this.telemetry?.observeRelease?.(value); } catch { /* Isolated metrics. */ } }
    } catch { /* Keep unresolved timing facts for a later receipt/recovery; never stop execution. */ }
  }
}

class MemoryAppServerTurnCardStore implements AppServerTurnCardStore {
  private readonly records = new Map<string, AppServerTurnCardRecord>();
  save(record: AppServerTurnCardRecord): void { this.records.set(record.id, structuredClone(record)); }
  get(id: string): AppServerTurnCardRecord | undefined { const value = this.records.get(id); return value ? structuredClone(value) : undefined; }
  update(id: string, updater: (record: AppServerTurnCardRecord) => AppServerTurnCardRecord): AppServerTurnCardRecord | undefined {
    const current = this.get(id); if (!current) return undefined;
    const next = updater(current); this.save(next); return next;
  }
  listOpen(ownerKind?: AppServerTurnCardRecord['ownerKind']): AppServerTurnCardRecord[] {
    return [...this.records.values()].filter((record) => (!ownerKind || record.ownerKind === ownerKind)
      && !['finalized', 'interrupted', 'fallback'].includes(record.state)).map((record) => structuredClone(record));
  }
}

function structuredCard(label: string, snapshot: LiveTurnSnapshot | undefined, elapsedMs: number,
  metadata: { detailCardRef?: string; model?: string; reasoningEffort?: string; serviceTier?: CodexServiceTier; pendingProfile?: ExecutionProfile }, nowMs?: number, inlineDetails?: InlineDetailsSnapshot): Record<string, unknown> {
  return renderStructuredTurnCard({ label, cardRef: metadata.detailCardRef, snapshot, elapsedMs, nowMs, inlineDetails,
    footer: statusFooter(metadata, contextUsage(snapshot?.usage), elapsedMs).split('\n') });
}

function runningCard(
  projectId: string, snapshot?: LiveTurnSnapshot, elapsedMs = 0,
  metadata?: { model?: string; reasoningEffort?: string; serviceTier?: CodexServiceTier; pendingProfile?: ExecutionProfile; conversationRecovery?: { compactionEpoch: number; messageCount: number } },
): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { streaming_mode: true, update_multi: true, summary: { content: `Codex 正在处理：${projectId}` } },
    header: { template: 'blue', title: { tag: 'plain_text', content: 'Codex 正在工作' } },
    body: { elements: [runningElement(snapshot, elapsedMs, metadata)] },
  };
}

function runningElement(
  snapshot?: LiveTurnSnapshot, elapsedMs = 0,
  metadata?: { model?: string; reasoningEffort?: string; serviceTier?: CodexServiceTier; pendingProfile?: ExecutionProfile; conversationRecovery?: { compactionEpoch: number; messageCount: number } },
): Record<string, unknown> {
  const usage = contextUsage(snapshot?.usage);
  const sections = [
    snapshot?.compacting ? '🗜️ **正在压缩上下文…**' : '',
    metadata?.conversationRecovery ? `♻️ **已从话题记录恢复 ${metadata.conversationRecovery.messageCount} 条上下文**` : '',
    snapshot?.error ? `⚠️ ${sanitizeDetailText(snapshot.error).text.slice(0, 1000)}` : '',
    ...(snapshot?.pendingActions ?? []).map((action) => action.status === 'delivered'
      ? `⏳ **待确认** · 处理人：<at id=${action.handlerUserId}></at> · 请使用已送达的操作卡`
      : action.status === 'submitting' ? '⏳ **正在提交操作**'
      : action.status === 'submission_failed' ? '⚠️ **操作提交失败** · 原处理人可在操作卡重试'
      : action.status === 'preparation_failed' ? '⚠️ **操作请求准备失败，正在重试投递**'
      : '⏳ **正在准备操作请求**'),
    ...(snapshot?.processPreviews?.length ? snapshot.processPreviews.map((entry) =>
      `**${entry.source === 'summary' ? '思考摘要' : entry.source === 'plan' ? '计划' : '进度'}**\n${sanitizeUnresolvedSourceLinks(entry.text.trim())}`)
      : [snapshot?.commentary.trim() && snapshot.processPreviews === undefined
        ? '_历史过程未分区记录，不能安全恢复混合摘要。_' : '_正在准备任务…_']),
    snapshot?.commandOutput.trim() ? `\n**命令输出**\n\`\`\`\n${bounded(snapshot.commandOutput.trim(), 4_000)}\n\`\`\`` : '',
    snapshot?.fileChangeOutput.trim() ? `\n**文件变更**\n${sanitizeUnresolvedSourceLinks(bounded(snapshot.fileChangeOutput.trim(), 3_000))}` : '',
    snapshot?.diff?.trim() ? `\n**Diff${snapshot.diffTruncated ? '（预览已截断或脱敏）' : ''}**\n\`\`\`diff\n${bounded(snapshot.diff.trim(), 4_000)}\n\`\`\`` : '',
    `\n---\n${statusFooter(metadata, usage, elapsedMs)}`,
  ].filter(Boolean);
  return { tag: 'markdown', element_id: 'app_server_progress', content: sections.join('\n') };
}

function statusFooter(
  metadata: { model?: string; reasoningEffort?: string; serviceTier?: CodexServiceTier; pendingProfile?: ExecutionProfile } | undefined,
  usage: { current: number; window: number; taskTotal?: number } | undefined,
  elapsedMs: number,
): string {
  return [
    `> <font color='grey'>模型：${metadata?.model ?? '未知'}</font>`,
    `> <font color='grey'>思考强度：${metadata?.reasoningEffort ?? '未知'}</font>`,
    `> <font color='grey'>模式：${displayMode(metadata?.serviceTier ?? 'default')}</font>`,
    ...(metadata?.pendingProfile
      ? [`> <font color='grey'>下一轮：${metadata.pendingProfile.model} · ${metadata.pendingProfile.reasoningEffort} · ${displayMode(metadata.pendingProfile.serviceTier)}</font>`]
      : []),
    `> <font color='grey'>上下文：${usage ? `${(usage.current / usage.window * 100).toFixed(1)}%` : '等待上报'}</font>`,
    `> <font color='grey'>任务累计：${usage?.taskTotal === undefined ? '等待上报' : `${formatCompactTokens(usage.taskTotal)} tokens`}</font>`,
    `> <font color='grey'>已运行：${formatDuration(elapsedMs)}</font>`,
  ].join('\n');
}

function formatDuration(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function contextUsage(value: unknown): { current: number; window: number; taskTotal?: number } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const last = record.last;
  const current = last && typeof last === 'object' && !Array.isArray(last)
    ? (last as Record<string, unknown>).totalTokens : undefined;
  const window = record.modelContextWindow;
  const taskTotal = record.codeBotTaskTotalTokens;
  return typeof current === 'number' && Number.isFinite(current)
    && typeof window === 'number' && Number.isFinite(window) && window > 0
    ? { current, window, ...(typeof taskTotal === 'number' && Number.isFinite(taskTotal) ? { taskTotal } : {}) } : undefined;
}


/** Budget serialized UTF-8 bytes, including JSON escapes, not JavaScript character count. */
function boundedFallbackText(text: string): string {
  const chars: string[] = []; let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(JSON.stringify(char)) - 2;
    if (bytes + size > 20_000) return `${chars.join('')}\n\n⚠️ 答复超过投递上限，此处仅为部分预览。`;
    chars.push(char); bytes += size;
  }
  return chars.join('');
}

function bounded(value: string, length: number): string {
  return value.length <= length ? value : `…${value.slice(-(length - 1))}`;
}
