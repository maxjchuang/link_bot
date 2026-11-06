import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AppServerRequestRenderer } from '../approvals/AppServerRequestService.js';
import type { AppServerRequestRecord } from '../approvals/AppServerRequestTypes.js';
import { sanitizePublicAnswerText } from '../details/DetailSanitizer.js';
import type { TurnArtifactRequest,TurnDetailArtifactService } from '../details/TurnDetailArtifactService.js';
import type { AppServerTurnCardRecord } from '../livecards/AppServerTurnCardStore.js';
import { observeCardDelivery,settleReleaseMarks,type CardTelemetry } from '../livecards/CardObservability.js';
import { CardKitApiError } from '../livecards/LiveTurnCardTypes.js';
import type { MediaService } from '../media/MediaService.js';
import type { ProjectKnowledgeRecord } from '../projects/ProjectKnowledgeService.js';
import type { SqliteStateStore } from '../state/SqliteStateStore.js';
import type { RepositoryMigrationRecord } from '../tasks/TaskTypes.js';
import type { FeishuGateway } from './FeishuGateway.js';
import { renderFeishuMessage,type RenderedFeishuMessage } from './FeishuMessageRenderer.js';
import { renderAppServerRequestCard,renderProjectKnowledgeCard,renderRepositoryMigrationConfirmationCard,renderTaskConfirmationCard } from './TaskPlatformCards.js';

const MAX_DELIVERY_ATTEMPTS = 1_000;
const MAX_FINAL_DELIVERY_ATTEMPTS = 12;
const isTurnFinal = (payload: Record<string, unknown>) => ['structured_turn_final', 'legacy_turn_final'].includes(String(payload.kind));

export interface FeishuOutboxRecord {
  id: string;
  dedupeKey: string;
  target: {
    chatId: string;
    receiveIdType?: 'chat_id' | 'open_id';
    replyToMessageId?: string;
    replyInThread?: boolean;
    mentionUserId?: string;
    chatType?: 'private' | 'group';
    topicId?: string;
    updateMessageId?: string;
  };
  eventType: 'text' | 'card' | 'card_rebuild' | 'media_send';
  status: 'pending' | 'sending' | 'sent';
  attempts: number;
  payload: unknown;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface FeishuOutboxTransport {
  deliver(record: FeishuOutboxRecord): Promise<void | { messageId: string; messageAppLink?: string }>;
}

export class FeishuOutbox {
  private readonly approvalListeners = new Set<(request: AppServerRequestRecord) => void | Promise<void>>();

  subscribeApproval(listener: (request: AppServerRequestRecord) => void | Promise<void>): () => void {
    this.approvalListeners.add(listener);
    return () => { this.approvalListeners.delete(listener); };
  }
  constructor(
    private readonly store: SqliteStateStore,
    private readonly transport: FeishuOutboxTransport,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  enqueue(input: {
    dedupeKey: string;
    target: FeishuOutboxRecord['target'];
    eventType: FeishuOutboxRecord['eventType'];
    payload: unknown;
  }): FeishuOutboxRecord {
    const prior = this.findByDedupeKey(input.dedupeKey);
    if (prior) return prior;
    const now = this.clock().toISOString();
    const record: FeishuOutboxRecord = {
      id: `out_${createHash('sha256').update(input.dedupeKey).digest('hex').slice(0, 24)}`,
      ...input, status: 'pending', attempts: 0, createdAt: now, updatedAt: now,
    };
    this.store.db.prepare(`
      INSERT INTO outbound_events(id, dedupe_key, target, event_type, status, attempts, payload, created_at, updated_at)
      VALUES (@id, @dedupeKey, @target, @eventType, @status, @attempts, @payload, @createdAt, @updatedAt)
    `).run({ ...record, target: JSON.stringify(record.target), payload: JSON.stringify(record.payload) });
    return record;
  }

  async flush(limit = 100): Promise<{ sent: number; failed: number }> {
    const records = this.claimForDelivery(limit);
    let sent = 0;
    let failed = 0;
    for (const row of records) {
      const record = fromRow(row);
      const payload = isRecord(record.payload) ? record.payload : {};
      const dependency = typeof payload.dependsOnDedupeKey === 'string'
        ? this.findByDedupeKey(payload.dependsOnDedupeKey) : undefined;
      if (typeof payload.dependsOnDedupeKey === 'string' && dependency?.status !== 'sent') {
        this.store.db.prepare("UPDATE outbound_events SET status='pending', updated_at=? WHERE id=?")
          .run(this.clock().toISOString(), record.id);
        continue;
      }
      try {
        const receipt = await this.transport.deliver({ ...record, status: 'sending', attempts: record.attempts + 1 });
        let changedRequest: AppServerRequestRecord | undefined;
        this.store.db.transaction(() => {
          if (payload.kind === 'app_server_request' && receipt?.messageId) {
            changedRequest = this.store.updateAppServerRequest(String(payload.requestId), (current) => current.status === 'pending'
              && current.generation === payload.generation && Date.parse(current.expiresAt) > this.clock().getTime()
              ? { ...current, operationCard: { status: 'sent', messageId: receipt.messageId,
                ...(receipt.messageAppLink ? { messageAppLink: receipt.messageAppLink } : {}), at: this.clock().toISOString() } } : current);
          }
          this.store.db.prepare("UPDATE outbound_events SET status='sent', attempts=attempts+1, last_error=NULL, updated_at=? WHERE id=?")
            .run(this.clock().toISOString(), record.id);
        }).immediate();
        if (changedRequest) await this.notifyApproval(changedRequest);
        sent += 1;
      } catch (error) {
        // Keep permanent failures in the durable outbox for diagnosis, but do
        // not retry an expired or invalid Feishu message on every timer tick.
        const permanentFinal = (isTurnFinal(payload) || payload.kind === 'turn_detail_artifact') && error instanceof CardKitApiError
          && (error.category === 'permanent' || error.category === 'payload');
        const deniedArtifact = payload.kind === 'turn_detail_artifact' && error instanceof Error
          && ['access_denied', 'expired', 'cleared', 'not_found', 'snapshot_changed', 'invalid_artifact'].includes(error.message);
        const exhaustedFinal = isTurnFinal(payload) && record.attempts + 1 >= MAX_FINAL_DELIVERY_ATTEMPTS;
        const attempts = isPermanentDeliveryFailure(error) || permanentFinal || deniedArtifact || exhaustedFinal ? -1 : record.attempts + 1;
        this.store.db.transaction(() => {
          this.store.db.prepare("UPDATE outbound_events SET status='pending', attempts=?, last_error=?, updated_at=? WHERE id=?")
            .run(attempts, safeError(error), this.clock().toISOString(), record.id);
          if (isTurnFinal(payload) && error instanceof CardKitApiError && error.retryAfterMs) {
            this.store.db.prepare('UPDATE outbound_events SET payload=? WHERE id=?').run(JSON.stringify({ ...payload,
              nextAttemptAt: new Date(this.clock().getTime() + error.retryAfterMs).toISOString() }), record.id);
          }
          if (attempts === -1 && isTurnFinal(payload)) {
            const row = this.store.db.prepare('SELECT payload FROM live_cards WHERE id=?').get(String(payload.recordId)) as { payload: string } | undefined;
            const card = row ? JSON.parse(row.payload) as AppServerTurnCardRecord : undefined;
            if (card && card.finalizationIntent && card.finalizationIntent.uuid === payload.intentUuid && card.finalizationIntent.deliveryMode === 'outbox') {
              const updatedAt = this.clock().toISOString();
              this.store.db.prepare('UPDATE live_cards SET payload=?,updated_at=? WHERE id=?').run(JSON.stringify({ ...card,
                state: 'fallback', deliveryFailure: exhaustedFinal ? 'retry_exhausted' : 'permanent', lastError: safeError(error), updatedAt }), updatedAt, card.id);
            }
          }
        }).immediate();
        failed += 1;
        if (payload.kind === 'app_server_request') {
          const changed = this.store.updateAppServerRequest(String(payload.requestId), (current) => current.status === 'pending' && current.operationCard?.status !== 'sent'
            ? { ...current, operationCard: { status: 'failed', at: this.clock().toISOString() } } : current);
          if (changed) await this.notifyApproval(changed);
        }
      }
    }
    return { sent, failed };
  }

  pending(): FeishuOutboxRecord[] {
    return (this.store.db.prepare("SELECT * FROM outbound_events WHERE status!='sent' ORDER BY created_at, rowid").all() as OutboxRow[]).map(fromRow);
  }

  getByDedupeKey(dedupeKey: string): FeishuOutboxRecord | undefined {
    return this.findByDedupeKey(dedupeKey);
  }

  private async notifyApproval(request: AppServerRequestRecord): Promise<void> {
    await Promise.allSettled([...this.approvalListeners].map(async (listener) => { await listener(request); }));
  }

  private findByDedupeKey(dedupeKey: string): FeishuOutboxRecord | undefined {
    const row = this.store.db.prepare('SELECT * FROM outbound_events WHERE dedupe_key=?').get(dedupeKey) as OutboxRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  private claimForDelivery(limit: number, leaseMs = 30_000): OutboxRow[] {
    return this.store.db.transaction(() => {
      const now = this.clock();
      const staleBefore = new Date(now.getTime() - leaseMs).toISOString();
      const candidates = this.store.db.prepare(`
        SELECT * FROM outbound_events
        WHERE attempts>=0 AND attempts<? AND (status='pending' OR (status='sending' AND updated_at<=?))
          AND (COALESCE(json_extract(payload,'$.kind'),'') NOT IN ('structured_turn_final','legacy_turn_final')
            OR attempts=0 OR (julianday(?) - julianday(updated_at))*86400000 >= MIN(30000,1000*(1 << MIN(attempts-1,5))))
          AND (COALESCE(json_extract(payload,'$.kind'),'') NOT IN ('structured_turn_final','legacy_turn_final')
            OR json_extract(payload,'$.nextAttemptAt') IS NULL OR json_extract(payload,'$.nextAttemptAt')<=?)
        ORDER BY created_at, rowid LIMIT ?
      `).all(MAX_DELIVERY_ATTEMPTS, staleBefore, now.toISOString(), now.toISOString(), limit) as OutboxRow[];
      const claimed: OutboxRow[] = [];
      for (const row of candidates) {
        const changed = this.store.db.prepare(`
          UPDATE outbound_events SET status='sending', updated_at=?
          WHERE id=? AND attempts>=0 AND attempts<?
            AND (status='pending' OR (status='sending' AND updated_at<=?))
        `).run(now.toISOString(), row.id, MAX_DELIVERY_ATTEMPTS, staleBefore).changes;
        if (changed === 1) claimed.push({ ...row, status: 'sending', updated_at: now.toISOString() });
      }
      return claimed;
    })();
  }
}

export class FeishuApprovalOutboxRenderer implements AppServerRequestRenderer {
  constructor(
    private readonly outbox: FeishuOutbox,
    private readonly targetForRequest: (request: AppServerRequestRecord) => FeishuOutboxRecord['target'] =
      (request) => ({ chatId: request.ownerUserId, receiveIdType: 'open_id', mentionUserId: request.ownerUserId }),
  ) {}

  async render(request: AppServerRequestRecord): Promise<void> {
    this.outbox.enqueue({
      dedupeKey: `${request.id}:approval-card`,
      target: this.targetForRequest(request),
      eventType: 'card',
      payload: {
        kind: 'app_server_request', requestId: request.id, generation: request.generation,
        requestKind: request.kind, riskSummary: request.riskSummary, expiresAt: request.expiresAt, request,
      },
    });
  }
}

export class FeishuGatewayOutboxTransport implements FeishuOutboxTransport {
  constructor(
    private readonly gateway: Pick<FeishuGateway, 'sendTextToTarget' | 'sendRenderedMessageToTarget'>
      & Partial<Pick<FeishuGateway, 'updateMessageCard'|'uploadImage'|'uploadFile'|'sendMediaToTarget'|'sendOperationCardToTarget'|'resolveOperationCardLink'>>,
    private readonly store?: SqliteStateStore,
    private readonly media?: MediaService,
    private readonly resolveSourceReferences?: (taskId: string, markdown: string) => Promise<string>,
    private readonly turnArtifacts?: TurnDetailArtifactService,
    private readonly cardTelemetry?: CardTelemetry,
    private readonly cardClock: () => Date = () => new Date(),
  ) {}

  async deliver(record: FeishuOutboxRecord): Promise<void | { messageId: string; messageAppLink?: string }> {
    const payload = requireRecord(record.payload);
    if (payload.kind === 'turn_detail_artifact') {
      if (!this.turnArtifacts) throw new Error('Detail artifact transport unavailable.');
      return this.turnArtifacts.deliver(payload.request as TurnArtifactRequest, record.id);
    }
    if (isTurnFinal(payload)) {
      if (!this.store || !this.gateway.sendOperationCardToTarget) throw new Error('Structured final transport unavailable.');
      const row = this.store.db.prepare('SELECT payload FROM live_cards WHERE id=?').get(String(payload.recordId)) as { payload: string } | undefined;
      if (!row) throw new Error('Structured final record missing.');
      const current = JSON.parse(row.payload) as AppServerTurnCardRecord;
      if (current.deliveryFailure) throw new CardKitApiError('Final delivery is quarantined.', 'permanent');
      if (['finalized', 'interrupted'].includes(current.state)) return;
      const intent = current.finalizationIntent;
      if (!intent || intent.uuid !== payload.intentUuid || intent.deliveryMode !== 'outbox'
        || (payload.kind === 'structured_turn_final' ? !current.structuredView : current.structuredView || !intent.fallbackText)) {
        throw new CardKitApiError('Final intent mismatch.', 'permanent');
      }
      const finalCard = current.structuredView ? intent.card : { schema: '2.0', body: { elements: [
        { tag: 'markdown', content: intent.fallbackText },
      ] } };
      // Structured finals keep their exact saved card. Legacy fallback uses only sanitized public text.
      // Neither path may change the destination or retry outside the original topic.
      const receipt = await observeCardDelivery(this.cardTelemetry, 'card_fallback_send', finalCard, async () => {
        const result = await this.gateway.sendOperationCardToTarget!(current.target, finalCard, record.id);
        if (!result.messageId) throw new Error('Structured final receipt missing.');
        return result;
      });
      let elapsed: number[] = [];
      this.store.db.transaction(() => {
        const latestRow = this.store!.db.prepare('SELECT payload FROM live_cards WHERE id=?').get(current.id) as { payload: string };
        const latest = JSON.parse(latestRow.payload) as AppServerTurnCardRecord;
        if (latest.finalizationIntent?.uuid !== intent.uuid || latest.finalizationIntent.deliveryMode !== 'outbox') return;
        const settled = settleReleaseMarks(latest, current.requestReleasePending ?? [], [], this.cardClock().getTime());
        elapsed = settled.elapsed;
        const next = { ...latest, state: intent.terminalState, finalizationIntent: undefined,
          requestReleasePending: settled.remaining,
          fallbackMessageId: receipt.messageId, updatedAt: new Date().toISOString() };
        this.store!.db.prepare('UPDATE live_cards SET payload=?,updated_at=? WHERE id=?').run(JSON.stringify(next), next.updatedAt, latest.id);
      }).immediate();
      try { this.cardTelemetry?.observeWaiting?.('not_waiting'); } catch { /* Isolated metrics. */ }
      for (const value of elapsed) { try { this.cardTelemetry?.observeRelease?.(value); } catch { /* Isolated metrics. */ } }
      return receipt;
    }
    // Warm-retention cleanup is intentionally silent. Treat durable warnings
    // queued by older versions as delivered without sending them to Feishu.
    if (payload.kind === 'disk_retention_warning') return;
    // Backward compatibility for durable events written before targets carried
    // an explicit receive-id type. Feishu OpenIDs are stable `ou_` identifiers.
    const target = !record.target.receiveIdType && record.target.chatId.startsWith('ou_')
      ? { ...record.target, receiveIdType: 'open_id' as const }
      : record.target;
    if (payload.kind === 'media_send') {
      if (!this.store || !this.media || !this.gateway.sendMediaToTarget) throw new Error('Media outbox transport is unavailable.');
      const attachmentId = String(payload.attachmentId ?? '');
      const attachment = this.media.getAttachment(attachmentId);
      if (!attachment || attachment.direction !== 'outbound') throw new Error('Outbound media attachment was not found.');
      if (attachment.managedSource === 'turn_detail') throw new Error('Detail artifacts require scoped authorization.');
      let resourceKey = attachment.remoteResourceKey;
      if (!resourceKey) {
        const data = await readFile(attachment.storagePath);
        if (attachment.kind === 'image') {
          if (!this.gateway.uploadImage) throw new Error('Feishu image upload is unavailable.');
          resourceKey = await this.gateway.uploadImage(data);
        } else {
          if (!this.gateway.uploadFile) throw new Error('Feishu file upload is unavailable.');
          resourceKey = await this.gateway.uploadFile(data, attachment.safeName);
        }
        this.media.saveAttachment({
          ...attachment, remoteResourceKey: resourceKey, status: 'uploaded', updatedAt: new Date().toISOString(),
        });
      }
      const sent = await this.gateway.sendMediaToTarget(target, {
        kind: attachment.kind, resourceKey, uuid: record.id,
      });
      const now = new Date().toISOString();
      this.media.saveAttachment({
        ...attachment, remoteResourceKey: resourceKey, status: 'sent', updatedAt: now,
      });
      this.store.db.prepare(`
        INSERT INTO artifact_deliveries(
          id,attachment_id,target,disposition,status,remote_resource_key,message_id,attempts,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status,remote_resource_key=excluded.remote_resource_key,
          message_id=excluded.message_id,attempts=artifact_deliveries.attempts+1,updated_at=excluded.updated_at,last_error=NULL
      `).run(
        `delivery_${record.id}`, attachment.id, JSON.stringify(target), attachment.kind, 'sent', resourceKey,
        sent.messageId ?? null, 1, attachment.createdAt, now,
      );
      return;
    }
    if (payload.kind === 'rendered_message') {
      await this.gateway.sendRenderedMessageToTarget(target, payload.rendered as {
        preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage;
      });
      return;
    }
    if (payload.kind === 'app_server_request') {
      const request = this.store ? this.store.getAppServerRequest(String(payload.requestId)) : payload.request as AppServerRequestRecord | undefined;
      if (!request || request.status !== 'pending' || request.generation !== payload.generation
        || !Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt) <= Date.now()) return;
      const rendered = renderAppServerRequestCard(request, {
        chatId: target.chatId,
        chatType: target.chatType ?? 'private',
        ...(target.topicId ? { topicId: target.topicId } : {}),
      });
      if (rendered.preferred.kind !== 'card') throw new Error('Operation card must be interactive');
      const operationCard = rendered.preferred.payload;
      return observeCardDelivery(this.cardTelemetry, 'operation_card_send', operationCard, async () => {
        if (!this.gateway.sendOperationCardToTarget) throw new Error('Operation card transport unavailable');
        const receipt = await this.gateway.sendOperationCardToTarget(target, operationCard, record.id);
        if (!receipt.messageId) throw new Error('Operation card receipt missing');
        const messageAppLink = receipt.messageAppLink ?? await this.gateway.resolveOperationCardLink?.(receipt.messageId).catch(() => undefined);
        return { ...receipt, ...(messageAppLink ? { messageAppLink } : {}) };
      });
    }
    if (payload.kind === 'project_knowledge_candidate') {
      await this.gateway.sendRenderedMessageToTarget(target, renderProjectKnowledgeCard(
        payload.knowledge as ProjectKnowledgeRecord,
        { chatId: target.chatId, chatType: target.chatType ?? 'private', ...(target.topicId ? { topicId: target.topicId } : {}) },
      ));
      return;
    }
    if (payload.kind === 'task_publish_confirmation') {
      await this.gateway.sendRenderedMessageToTarget(target, renderTaskConfirmationCard('publish', String(payload.requestId), {
        chatId: target.chatId, chatType: target.chatType ?? 'private', userId: target.mentionUserId ?? target.chatId,
        ...(target.topicId ? { topicId: target.topicId } : {}),
      }, { forceUpdate: payload.forceUpdate === true,
        branchName: typeof payload.branchName === 'string' ? payload.branchName : undefined,
        previousHeadSha: typeof payload.previousHeadSha === 'string' ? payload.previousHeadSha : undefined,
        newHeadSha: typeof payload.newHeadSha === 'string' ? payload.newHeadSha : undefined }));
      return;
    }
    if (payload.kind === 'repository_migration_confirmation') {
      await this.gateway.sendRenderedMessageToTarget(target, renderRepositoryMigrationConfirmationCard(
        payload.migration as RepositoryMigrationRecord,
        { chatId: target.chatId, chatType: target.chatType ?? 'private', ...(target.topicId ? { topicId: target.topicId } : {}) },
      ));
      return;
    }
    let text = finalEventText(payload);
    if (payload.kind === 'task_turn_final') {
      if (typeof payload.resultRef === 'string') {
        const result = this.store?.db.prepare('SELECT answer FROM turn_results WHERE turn_key=?').get(payload.resultRef) as { answer: string } | undefined;
        if (!result) throw new Error('Public turn result unavailable.');
        text = result.answer;
      }
      const resolvedText = this.resolveSourceReferences && typeof payload.taskId === 'string'
        ? await this.resolveSourceReferences(payload.taskId, text).catch(() => text)
        : text;
      const deliveredText = sanitizePublicAnswerText(resolvedText);
      await this.gateway.sendRenderedMessageToTarget(target, renderFeishuMessage({
        kind: payload.status === 'completed' ? 'completion' : 'error',
        bodyMarkdown: deliveredText, fallbackText: deliveredText,
      }, { verbosity: 'normal' }));
      return;
    }
    await this.gateway.sendTextToTarget(target, text);
  }
}

interface OutboxRow {
  id: string;
  dedupe_key: string;
  target: string;
  event_type: FeishuOutboxRecord['eventType'];
  status: FeishuOutboxRecord['status'];
  attempts: number;
  payload: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function fromRow(row: OutboxRow): FeishuOutboxRecord {
  return {
    id: row.id, dedupeKey: row.dedupe_key,
    target: JSON.parse(row.target) as FeishuOutboxRecord['target'], eventType: row.event_type,
    status: row.status, attempts: row.attempts, payload: JSON.parse(row.payload) as unknown,
    createdAt: row.created_at, updatedAt: row.updated_at, ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/(?:https?:\/\/)[^\s@]+@/g, 'https://[redacted]@').slice(0, 500);
}

function isPermanentDeliveryFailure(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const response = isRecord(error.response) ? error.response : undefined;
  const status = response?.status ?? error.status;
  return status === 400 || status === 404;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Feishu outbox payload.');
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function finalEventText(payload: Record<string, unknown>): string {
  if (typeof payload.text === 'string') return payload.text;
  const turn = payload.turn;
  if (turn && typeof turn === 'object' && !Array.isArray(turn)) {
    const items = (turn as Record<string, unknown>).items;
    if (Array.isArray(items)) {
      const answer = [...items].reverse().find((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
        const record = item as Record<string, unknown>;
        return (record.type === 'agentMessage' || record.type === 'agent_message') && typeof record.text === 'string';
      }) as Record<string, unknown> | undefined;
      if (typeof answer?.text === 'string') return answer.text;
    }
  }
  return `Task ${String(payload.taskId ?? '')} turn ${String(payload.status ?? 'completed')}.`;
}
