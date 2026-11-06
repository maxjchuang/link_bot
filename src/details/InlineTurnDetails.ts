import type { FeishuGateway, FeishuReplyTarget } from '../feishu/FeishuGateway.js';
import type { TurnDetailStore } from './TurnDetailStore.js';
import { resolveInlineTimelineLimit } from './InlineTimelineLimits.js';
import type { DetailResourceStore } from './DetailResourceStore.js';
import { TURN_DETAIL_RETENTION_MS, TURN_DETAIL_SCHEMA_VERSION, type DetailCategory, type DetailEntry, type DetailTurnIdentity, type DetailTurnRecord } from './TurnDetailTypes.js';
import { sanitizeDetailText, isSensitiveDetailCommand } from './DetailSanitizer.js';
import { unavailableDetailAudit, type DetailAccessAuditPort, type DetailAccessReceipt } from './TurnDetailAccessAudit.js';

export const inlineCategories = ['process', 'commands', 'files'] as const;
export interface InlinePublicationContext { target: FeishuReplyTarget; requestMessageId?: string; requesterUserId?: string }
export interface InlineDetailItem { title: string; metadata: string; text: string; limited: boolean }
export interface InlineTimelineItem extends InlineDetailItem {
  entryId: string; category: DetailCategory; receivedAt: string; failed: boolean; command?: string; finalAnswer?: true;
  commandStatus?: 'succeeded' | 'failed' | 'running' | 'unknown';
  durationMs?: number;
}
export interface InlineDetailsSnapshot {
  status: 'available' | 'pending' | 'unavailable' | 'expired';
  incomplete?: boolean;
  timeline?: { total: number; maxItems?: number; items: InlineTimelineItem[] };
  categories: Record<DetailCategory, { total: number; items: InlineDetailItem[] }>;
}
export function emptyInlineDetails(status: InlineDetailsSnapshot['status'] = 'pending'): InlineDetailsSnapshot {
  return { status, categories: { process: { total: 0, items: [] }, commands: { total: 0, items: [] }, files: { total: 0, items: [] } } };
}

/** Publication authorization, not a forged viewer callback. Nothing is read using a clicked user's authority. */
export class InlineTurnDetailPublisher {
  private readonly maxItems: number;
  constructor(private readonly store: TurnDetailStore | undefined, private readonly files: DetailResourceStore | undefined,
    private readonly gateway: Pick<FeishuGateway, 'verifySensitiveReplySource' | 'resolveDetailMessageScope' | 'isDetailReaderMember'>,
    private readonly clock: () => Date = () => new Date(), private readonly audit: DetailAccessAuditPort = unavailableDetailAudit,
    maxItems?: number) { this.maxItems = resolveInlineTimelineLimit(maxItems); }

  async capture(identity: DetailTurnIdentity, context: InlinePublicationContext): Promise<InlineDetailsSnapshot> {
    const receipts: DetailAccessReceipt[] = [];
    try {
      for (const category of inlineCategories) receipts.push(this.audit.begin({ operation: 'inline_publish', category,
        actorId: context.requesterUserId ?? '', sourceMessageId: context.requestMessageId, sourceChatId: context.target.chatId, identity }));
      const snapshot = await this.read(identity, context);
      for (const receipt of receipts) receipt.finish(snapshot.status === 'available' ? 'served' : snapshot.status === 'expired' ? 'expired' : 'unavailable', identity);
      return snapshot;
    } catch {
      for (const receipt of receipts) { try { receipt.finish('unavailable', identity); } catch { /* Refuse disclosure if audit is unavailable. */ } }
      return emptyInlineDetails('unavailable');
    }
  }

  private async read(identity: DetailTurnIdentity, context: InlinePublicationContext): Promise<InlineDetailsSnapshot> {
    try {
      const before = this.store?.getTurn(identity);
      if (!before) return emptyInlineDetails('pending');
      if (!this.matches(before, context) || !this.store?.categoryTail || !this.store.timelineTail || !this.files
        || !context.requestMessageId || !context.requesterUserId || !this.gateway.verifySensitiveReplySource
        || !this.gateway.resolveDetailMessageScope) return emptyInlineDetails('unavailable');
      if (!this.live(before)) return emptyInlineDetails('expired');
      if (!await this.gateway.verifySensitiveReplySource(context.requestMessageId, context.target.chatId, context.requesterUserId)) return emptyInlineDetails('unavailable');
      const source = await this.gateway.resolveDetailMessageScope(context.requestMessageId);
      if (!source || source.chatId !== before.scope.chatId) return emptyInlineDetails('unavailable');
      if (before.scope.kind === 'private_user') {
        if (source.chatType !== 'private' || source.topicId) return emptyInlineDetails('unavailable');
      } else if (source.chatType !== 'group' || source.topicId !== before.scope.topicId
        || !await this.gateway.isDetailReaderMember?.(before.scope.chatId, context.requesterUserId)) return emptyInlineDetails('unavailable');
      if (before.scope.kind === 'shared_group_topic') {
        if (!context.target.replyToMessageId) return emptyInlineDetails('unavailable');
        const target = context.target.replyToMessageId === context.requestMessageId ? source
          : await this.gateway.resolveDetailMessageScope(context.target.replyToMessageId);
        if (target?.chatId !== before.scope.chatId || target.chatType !== 'group' || target.topicId !== before.scope.topicId) return emptyInlineDetails('unavailable');
      }
      // Authoritative retention/scope may change while remote authorization is in flight.
      const turn = this.store.getTurn(identity);
      if (!turn || !this.matches(turn, context) || JSON.stringify(turn.scope) !== JSON.stringify(before.scope)) return emptyInlineDetails('unavailable');
      if (!this.live(turn)) return emptyInlineDetails('expired');
      const result = emptyInlineDetails('available');
      result.incomplete = turn.incomplete || turn.truncated;
      const cache = new Map<string, InlineTimelineItem>();
      const display = (entry: DetailEntry, limit = 768): InlineTimelineItem => {
          const cacheKey = `${entry.entryId}:${limit}`;
          const cached = cache.get(cacheKey);
          if (cached) return cached;
          const category = entry.category;
          let text = '', limited = false;
          if (entry.resource) {
            try {
              const bytes = this.files!.readBytes(entry.resource.resourceId, entry.resource.committedBytes, 0, limit + 4);
              let size = Math.min(bytes.length, limit);
              while (size < bytes.length && size > 0 && (bytes[size]! & 0xc0) === 0x80) size--;
              text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
              limited = entry.resource.committedBytes > size || entry.resource.truncated;
            } catch { text = '正文暂时无法读取。'; result.incomplete = true; }
          } else { text = '正文尚未留存。'; result.incomplete = true; }
          const command = typeof entry.metadata.command === 'string' ? entry.metadata.command : undefined;
          const title = command ? isSensitiveDetailCommand(command) ? '敏感操作（内容已保护）' : command
            : String(entry.metadata.path ?? (category === 'commands' ? '命令输出' : entry.source === 'plan' ? '计划' : entry.source === 'summary' ? '公开摘要' : '进度'));
          const metadata = category === 'commands'
            ? `${entry.metadata.completed === true ? '已结束' : '执行中／状态未完整上报'} · 退出码：${entry.metadata.exitCode ?? '未上报'}`
            : category === 'files' ? `新增 ${entry.metadata.added ?? '未上报'} · 删除 ${entry.metadata.removed ?? '未上报'}` : entry.receivedAt;
          const failed = entry.metadata.status === 'failed' || typeof entry.metadata.exitCode === 'number' && entry.metadata.exitCode !== 0;
          const commandStatus: InlineTimelineItem['commandStatus'] = failed ? 'failed'
            : entry.metadata.completed === true && entry.metadata.exitCode === 0 ? 'succeeded'
            : entry.metadata.completed === false ? 'running' : 'unknown';
          const recordedDuration = entry.metadata.durationMs;
          const start = entry.metadata.startedAtMs, end = entry.metadata.completedAtMs;
          const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
          const durationMs = validTime(recordedDuration) ? recordedDuration
            : validTime(start) && validTime(end) && end >= start ? end - start : undefined;
          const item = { entryId: entry.entryId, category, receivedAt: entry.receivedAt,
            ...(category === 'commands' ? {commandStatus,...(durationMs !== undefined ? {durationMs} : {})} : {}),
            ...(entry.metadata.finalAnswer === true ? {finalAnswer:true as const} : {}),
            ...(command ? {command: sanitizeDetailText(isSensitiveDetailCommand(command) ? '[敏感操作]' : command).text} : {}),
            failed,
            title: sanitizeDetailText(title.slice(0, 500)).text, metadata: sanitizeDetailText(metadata.slice(0, 200)).text,
            text: sanitizeDetailText(text).text, limited: limited || entry.resource?.redacted === true };
          cache.set(cacheKey, item);
          return item;
      };
      for (const category of inlineCategories) {
        const page = this.store.categoryTail(identity, category, 5);
        result.categories[category] = { total: page.total, items: page.entries.map(entry => display(entry)) };
      }
      const tail = this.store.timelineTail(identity, this.maxItems);
      // The timeline is the primary reading surface, not a download index. Keep
      // bounded, UTF-8-safe bodies; the renderer applies the total card budget.
      result.timeline = { total: tail.total, maxItems:this.maxItems, items: tail.entries.map(entry => display(entry, 8192)) };
      return result;
    } catch { return emptyInlineDetails('unavailable'); }
  }

  private matches(turn: DetailTurnRecord, context: InlinePublicationContext): boolean {
    if (turn.schemaVersion !== TURN_DETAIL_SCHEMA_VERSION || turn.scope.chatId !== context.target.chatId) return false;
    return turn.scope.kind === 'private_user' ? turn.scope.userId === context.requesterUserId && !context.target.replyInThread
      : context.target.replyInThread === true;
  }
  private live(turn: DetailTurnRecord): boolean {
    return Number.isFinite(this.clock().getTime()) && turn.availability === 'available' && (turn.lifecycle === 'running'
      || !!turn.endedAt && Number.isFinite(Date.parse(turn.endedAt)) && this.clock().getTime() < Date.parse(turn.endedAt) + TURN_DETAIL_RETENTION_MS);
  }
}
