import { createHash } from 'node:crypto';
import type { FeishuIncomingCardAction, TurnDetailCardAction } from '../feishu/FeishuCardActions.js';
import type { FeishuGateway, FeishuOutgoingReply } from '../feishu/FeishuGateway.js';
import { DetailAccessPolicy } from './DetailAccessPolicy.js';
import type { DetailViewStore } from './DetailViewStore.js';
import type { TurnDetailStore } from './TurnDetailStore.js';
import type { DetailResourceStore } from './DetailResourceStore.js';
import { TurnDetailService } from './TurnDetailService.js';
import { renderTurnDetailCard } from './TurnDetailCardRenderer.js';
import type { TurnResultStore } from './TurnResultStore.js';
import type { DetailTurnIdentity } from './TurnDetailTypes.js';
import type { TurnArtifactRequest, TurnDetailArtifactService } from './TurnDetailArtifactService.js';
import type { DetailTelemetryPort } from './TurnDetailTelemetry.js';
import { detailAccessFailure, unavailableDetailAudit, type DetailAccessAuditPort, type DetailAccessOutcome } from './TurnDetailAccessAudit.js';
import { observeCardDelivery } from '../livecards/CardObservability.js';
import { safeOperationLink } from '../livecards/TaskCardLayout.js';

interface BrowserState { category: string; messageId?: string; digest?: string; card?: Record<string, unknown>; pending?: boolean }
interface AccessResult { outcome: DetailAccessOutcome; identity?: DetailTurnIdentity }

export class FeishuTurnDetailController {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly store: TurnDetailStore, private readonly files: DetailResourceStore,
    private readonly views: DetailViewStore, private readonly gateway: FeishuGateway, private readonly clock: () => Date = () => new Date(),
    private readonly results?: TurnResultStore,
    private readonly artifacts?: { service: TurnDetailArtifactService; enqueue(request: TurnArtifactRequest): void },
    private readonly telemetry?: DetailTelemetryPort, private readonly audit: DetailAccessAuditPort = unavailableDetailAudit) {}

  handle(input: FeishuIncomingCardAction & { action: TurnDetailCardAction }): Promise<FeishuOutgoingReply> {
    const key = `${input.action.cardRef}:${input.userId}:${input.action.category}`;
    const prior = this.queues.get(key) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(async () => {
      const start = performance.now();
      const result: AccessResult = { outcome: 'unavailable' };
      try {
        const receipt = this.audit.begin({ operation: input.action.download ? 'download_request' : input.action.cursorRef ? 'page' : 'view',
          category: input.action.category, actorId: input.userId, sourceMessageId: input.messageId, sourceChatId: input.chatId,
          cardRef: input.action.cardRef, itemRef: input.action.itemRef, cursorRef: input.action.cursorRef });
        const reply = await this.open(input, result);
        receipt.finish(result.outcome, result.identity);
        return reply;
      } catch {
        result.outcome = 'unavailable';
        return { text: '详情暂不可用；任务执行不受影响，请重试。' };
      } finally {
        const outcome = ['served', 'duplicate', 'queued'].includes(result.outcome) ? 'ok'
          : result.outcome === 'denied' ? 'denied' : result.outcome === 'expired' ? 'expired' : 'unavailable';
        try { this.telemetry?.observe('query', outcome, performance.now() - start); } catch { /* Isolated metrics. */ }
      }
    });
    this.queues.set(key, run);
    return run.finally(() => { if (this.queues.get(key) === run) this.queues.delete(key); });
  }

  private async open(input: FeishuIncomingCardAction & { action: TurnDetailCardAction }, result: AccessResult): Promise<FeishuOutgoingReply> {
    try {
      const identity = this.views.resolveCard(input.action.cardRef);
      result.identity = identity;
      if (!identity || !input.messageId) throw new Error('not_found');
      if (!this.gateway.resolveDetailMessageScope || !this.gateway.isDetailReaderMember || !this.gateway.sendOperationCardToTarget || !this.gateway.replaceDetailMessageCard) throw new Error('unavailable');
      let proof: { chatId: string; chatType: 'private' | 'group'; topicId?: string } | undefined;
      let sourceRead: ReturnType<NonNullable<FeishuGateway['resolveDetailMessageScope']>> | undefined;
      let memberRead: Promise<boolean> | undefined;
      // Share only within the read phase of one callback; never cache across actors/callbacks.
      const refreshAccess = () => { sourceRead = undefined; memberRead = undefined; };
      const policy = new DetailAccessPolicy({
        resolveSource: async (messageId) => {
          if (messageId !== input.messageId) return undefined;
          proof = await (sourceRead ??= this.gateway.resolveDetailMessageScope!(messageId));
          if (proof && proof.chatId !== input.chatId) throw new Error('access_denied');
          return proof;
        },
        isGroupMember: (chatId, viewerId) => memberRead ??= this.gateway.isDetailReaderMember!(chatId, viewerId),
        // This handler is only reached from a verified platform callback. The actor just read this
        // source card; independently verified message scope and fresh group membership bind that proof.
        canReadTopic: async (chatId, topicId, viewerId) => viewerId === input.userId && proof?.chatType === 'group' && proof.chatId === chatId && proof.topicId === topicId,
      });
      const service = new TurnDetailService(this.store, this.files, policy, this.clock, this.views);
      const actor = { userId: input.userId, sourceMessageId: input.messageId };
      if (input.action.download) {
        if (!this.artifacts || input.action.itemRef || input.action.cursorRef) throw new Error('unavailable');
        const category = input.action.category;
        const request = { identity, category, actor, ...this.artifacts.service.snapshot(identity, category) };
        const scope = await this.artifacts.service.requireRead(request);
        await policy.requireRead(scope, actor); // Bind the verified callback chat, not button parameters.
        this.artifacts.enqueue(request);
        result.outcome = 'queued';
        return { text: '安全附件已排队；大附件会按编号分片，可依次拼接。每片上传与发送前重新校验权限，已发送副本无法撤回。' };
      }
      if (input.action.category === 'result') return await this.openResult(input, identity, policy, result, refreshAccess);
      await service.requireRead(identity, actor);
      const action = { ...input.action };
      if (action.cursorRef) {
        const own = this.views.getCursor(action.cursorRef, identity, actor.userId, this.clock().toISOString());
        if (!own) {
          const forked = this.views.forkCursor(action.cursorRef, identity, actor.userId, this.clock().toISOString());
          if (!forked) throw new Error('invalid_cursor');
          action.cursorRef = forked;
        }
      }
      if (action.itemRef && this.store.getEntry(identity, action.itemRef)?.category !== action.category) throw new Error('invalid_cursor');
      const page = action.itemRef ? await service.readEntry(identity, action.itemRef, actor, action.cursorRef)
        : await service.list(identity, action.category as 'process' | 'commands' | 'files', actor, action.cursorRef);
      if ('entry' in page && page.entry.category !== action.category) throw new Error('invalid_cursor');
      const card = renderTurnDetailCard(action, page, this.artifacts !== undefined);
      const ref = this.views.browserRef(identity, actor.userId, action.category);
      const now = this.clock().toISOString();
      const previous = this.views.getBrowser(ref, identity, actor.userId, now) as BrowserState | undefined;
      const digest = createHash('sha256').update(JSON.stringify(card)).digest('hex');
      const feedback = async (content: string, messageId: string): Promise<FeishuOutgoingReply> => {
        // Reopening from the main card must not silently update an old message off-screen.
        if (input.messageId === messageId) return this.feedback(content);
        const link = safeOperationLink(await this.gateway.resolveOperationCardLink?.(messageId).catch(() => undefined));
        if (!link) return this.feedback(`${content} 暂无可用定位链接，请查看原详情回复。`);
        refreshAccess();
        await service.requireRead(identity, actor); // Recheck after resolving the remote position.
        return { text: `打开详情卡片：${link}`, toast: { type: 'info', content } };
      };
      if (previous?.messageId && previous.digest === digest && previous.pending !== true) {
        const reply = await feedback('内容没有变化，请查看已打开的详情卡片。', previous.messageId);
        result.outcome = 'duplicate'; return reply;
      }
      const state: BrowserState = { category: action.category, messageId: previous?.messageId, digest, card, pending: true };
      const expiresAt = '9999-01-01T00:00:00.000Z'; // Authoritative turn retention is checked on every operation.
      this.views.saveBrowser(identity, actor.userId, state, expiresAt);
      refreshAccess(); // A new remote proof is still required immediately before publication.
      await service.requireRead(identity, actor); // Do not publish an intent after access/retention changed.
      const turn = this.store.getTurn(identity)!;
      if (state.messageId) await observeCardDelivery(this.telemetry, 'detail_card_update', card,
        () => this.gateway.replaceDetailMessageCard!(state.messageId!, card));
      else {
        const target = turn.scope.kind === 'shared_group_topic'
          ? { chatId: turn.scope.chatId, replyToMessageId: input.messageId, replyInThread: true }
          : { chatId: turn.scope.chatId, replyToMessageId: input.messageId };
        const receipt = await observeCardDelivery(this.telemetry, 'detail_card_send', card,
          () => this.gateway.sendOperationCardToTarget!(target, card, ref));
        state.messageId = receipt.messageId;
        // Save the receipt before any retry PATCH. UUID replays may return an older payload;
        // only ambiguous retries need that PATCH, never a confirmed first publication.
        this.views.saveBrowser(identity, actor.userId, state, expiresAt);
        if (previous?.pending) await observeCardDelivery(this.telemetry, 'detail_card_update', card,
          () => this.gateway.replaceDetailMessageCard!(state.messageId!, card));
      }
      this.views.saveBrowser(identity, actor.userId, { ...state, card: undefined, pending: false }, expiresAt);
      result.outcome = 'served';
      return previous?.messageId ? await feedback('详情卡片已更新。', state.messageId!)
        : this.feedback('详情已在当前会话回复中打开，可直接展开阅读。');
    } catch (error) {
      result.outcome = detailAccessFailure(error);
      const code = error instanceof Error ? error.message : 'unavailable';
      const messages: Record<string, string> = { access_denied: '你没有此详情的访问权限，或入口不属于当前会话/话题。',
        access_unavailable: '暂时无法核验详情访问权限，请稍后重试；任务执行不受影响。',
        expired: '详情已过期。', cleared: '详情已清理。', not_found: '详情尚未完整记录或入口不存在。',
        invalid_cursor: '此分页已失效，请点击“刷新最新”重新打开。', snapshot_changed: '文件快照已更新，请查看最新版本。', view_quota: '浏览状态容量已达上限，请稍后再试。' };
      const text = messages[code] ?? '详情暂不可用；任务执行不受影响，请重试。';
      return { text, toast: { type: 'error', content: text } };
    }
  }

  private feedback(content: string): FeishuOutgoingReply { return { text: '', toast: { type: 'info', content } }; }

  private async openResult(input: FeishuIncomingCardAction & { action: TurnDetailCardAction },
    identity: DetailTurnIdentity, policy: DetailAccessPolicy, result: AccessResult, refreshAccess: () => void): Promise<FeishuOutgoingReply> {
    const results = this.results;
    const metadata = results?.metadata(identity);
    if (!results || !metadata) throw new Error('not_found');
    const actor = { userId: input.userId, sourceMessageId: input.messageId! };
    await policy.requireRead(metadata.scope, actor);
    if (input.action.itemRef) throw new Error('invalid_cursor');
    let offset = 0;
    if (input.action.cursorRef) {
      let state = results.getState(input.action.cursorRef, identity, actor.userId, 'cursor');
      if (!state) {
        const ref = results.forkCursor(input.action.cursorRef, identity, actor.userId);
        if (ref) state = results.getState(ref, identity, actor.userId, 'cursor');
      }
      if (!state || typeof state !== 'object' || !('offset' in state) || typeof state.offset !== 'number') throw new Error('invalid_cursor');
      offset = state.offset;
    }
    const page = results.readPage(identity, offset);
    const base = { kind: 'turn_detail' as const, cardRef: input.action.cardRef, category: 'result' as const };
    const button = (label: string, cursorRef?: string) => ({ tag: 'button', text: { tag: 'plain_text', content: label },
      behaviors: [{ type: 'callback', value: { ...base, ...(cursorRef ? { cursorRef } : {}) } }] });
    const elements: Record<string, unknown>[] = [{ tag: 'markdown', content: page.text || '没有公开答复正文。' }];
    if (page.nextOffset !== undefined) elements.push(button('下一页', results.saveState(identity, actor.userId, 'cursor', { offset: page.nextOffset })));
    if (offset > 0) elements.push(button('上一页', results.saveState(identity, actor.userId, 'cursor', { offset: Math.max(0, offset - 2000) })));
    elements.push(button('回到首页'));
    if (this.artifacts) elements.push({ tag: 'button', text: { tag: 'plain_text', content: '下载完整答复' },
      behaviors: [{ type: 'callback', value: { ...base, download: true } }] });
    const card = { schema: '2.0', header: { title: { tag: 'plain_text', content: '完整答复' } }, body: { elements } };
    const ref = results.stateRef(identity, actor.userId, 'browser');
    const previous = results.getState(ref, identity, actor.userId, 'browser') as BrowserState | undefined;
    const digest = createHash('sha256').update(JSON.stringify(card)).digest('hex');
    // Even duplicate clicks above performed fresh authorization.
    if (previous?.messageId && previous.digest === digest && previous.pending !== true) {
      result.outcome = 'duplicate'; return this.feedback('内容没有变化，请查看已打开的完整答复卡片。');
    }
    const state: BrowserState = { category: 'result', messageId: previous?.messageId, digest, card, pending: true };
    results.saveState(identity, actor.userId, 'browser', state);
    refreshAccess();
    await policy.requireRead(metadata.scope, actor);
    const hadMessage = !!state.messageId;
    if (!state.messageId) {
      const target = { chatId: metadata.scope.chatId, replyToMessageId: input.messageId,
        ...(metadata.scope.kind === 'shared_group_topic' ? { replyInThread: true } : {}) };
      const receipt = await observeCardDelivery(this.telemetry, 'detail_card_send', card,
        () => this.gateway.sendOperationCardToTarget!(target, card, ref));
      state.messageId = receipt.messageId;
      results.saveState(identity, actor.userId, 'browser', state);
    }
    await observeCardDelivery(this.telemetry, 'detail_card_update', card,
      () => this.gateway.replaceDetailMessageCard!(state.messageId!, card));
    results.saveState(identity, actor.userId, 'browser', { ...state, card: undefined, pending: false });
    result.outcome = 'served';
    return this.feedback(hadMessage ? '完整答复卡片已更新。' : '完整答复已在当前会话回复中打开。');
  }
}
