import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FeishuAppServerTurnExperience } from '../../src/livecards/AppServerTurnExperience.js';
import type { AppServerRequestRecord } from '../../src/approvals/AppServerRequestTypes.js';
import { newAppServerCardRecord, SqliteAppServerTurnCardStore } from '../../src/livecards/AppServerTurnCardStore.js';
import { CardKitApiError } from '../../src/livecards/LiveTurnCardTypes.js';
import { SqliteStateStore } from '../../src/state/SqliteStateStore.js';
import { FeishuOutbox, FeishuGatewayOutboxTransport } from '../../src/feishu/FeishuOutbox.js';

afterEach(() => vi.useRealTimers());

describe('FeishuAppServerTurnExperience', () => {
  it('leaves a newly accepted continuation live when startup recovery reaches the cards phase', async () => {
    const store = new SqliteAppServerTurnCardStore(join(await mkdtemp(join(tmpdir(), 'startup-continuation-card-')), 'state.sqlite'));
    const gateway = {
      createCardKitEntity: vi.fn(async () => ({ cardId: 'card' })),
      sendCardKitEntityToTarget: vi.fn(async () => ({ messageId: 'message' })),
      updateCardKitElement: vi.fn(async () => undefined), replaceCardKitEntity: vi.fn(async () => undefined),
    };
    const experience = new FeishuAppServerTurnExperience(gateway, 1000, undefined, store);
    try {
      await experience.accepted({ taskId: 'task', turnId: 'continuation', projectId: 'repo', target: { chatId: 'chat' } });
      const resolve = vi.fn(async () => ({ status: 'interrupted' as const }));
      await experience.recoverOpenCards('task_platform', resolve);
      expect(resolve).not.toHaveBeenCalled();
      expect(gateway.replaceCardKitEntity).not.toHaveBeenCalled();
      expect(store.listOpen('task_platform')[0]).toMatchObject({ localTurnId: 'continuation', state: 'live' });
      await experience.event({ type: 'turn.started', taskId: 'task', threadId: 'thread', turnId: 'remote' });
      await experience.event({ type: 'turn.completed', taskId: 'task', threadId: 'thread', turnId: 'remote', status: 'completed',
        turn: { items: [{ type: 'agentMessage', text: 'actual result' }] } });
      expect(JSON.stringify(gateway.replaceCardKitEntity.mock.calls)).toContain('actual result');
      expect(JSON.stringify(gateway.replaceCardKitEntity.mock.calls)).not.toContain('任务已中断');
    } finally { experience.dispose(); store.close(); }
  });

  it.each(['historical_legacy', 'retry_exhausted', 'permanent'] as const)('quarantines %s without discarding the intent or reviving it after restart', async (reason) => {
    const path = join(await mkdtemp(join(tmpdir(), 'quarantine-final-')), 'state.sqlite');
    const store = new SqliteAppServerTurnCardStore(path);
    const now = new Date('2026-10-16T00:00:00Z');
    const record = newAppServerCardRecord({ ownerKind: 'task_platform', taskId: 'task', localTurnId: 'turn',
      target: { chatId: 'chat' }, now: reason === 'historical_legacy' ? '2026-10-12T00:00:00Z' : now.toISOString() });
    store.save({ ...record, state: 'finalizing', cardId: 'card', cardMessageId: 'message', lastError: 'previous failure',
      finalizationIntent: { card: { invalid: true }, sequence: 9, uuid: 'same-operation', terminalState: 'finalized',
        attempts: reason === 'retry_exhausted' ? 11 : 0 } });
    const gateway = { createCardKitEntity: vi.fn(), sendCardKitEntityToTarget: vi.fn(), updateCardKitElement: vi.fn(),
      replaceCardKitEntity: vi.fn(async () => { throw new CardKitApiError('rejected', reason === 'permanent' ? 'payload' : 'retryable'); }) };
    let experience = new FeishuAppServerTurnExperience(gateway, 1000, () => now, store);
    const resolve = vi.fn();
    try {
      await experience.recoverOpenCards('task_platform', resolve);
      expect(store.get(record.id)).toMatchObject({ state: 'fallback', deliveryFailure: reason,
        finalizationIntent: { sequence: 9, uuid: 'same-operation', card: { invalid: true } } });
      expect(store.listOpen()).toHaveLength(0);
      experience.dispose();
      experience = new FeishuAppServerTurnExperience(gateway, 1000, () => now, store);
      await experience.recoverOpenCards('task_platform', resolve);
      expect(resolve).not.toHaveBeenCalled();
      expect(gateway.replaceCardKitEntity).toHaveBeenCalledTimes(reason === 'historical_legacy' ? 0 : 1);
    } finally { experience.dispose(); store.close(); }
  });
  it.each([{ name: 'short', suffix: '' }, { name: 'multibyte-and-escaped', suffix: '汉🙂"\\'.repeat(9000) }])(
    'uses a byte-bounded sanitized public text fallback for a fresh legacy card ($name)', async ({ suffix }) => {
    const path = join(await mkdtemp(join(tmpdir(), 'legacy-final-')), 'state.sqlite');
    const cards = new SqliteAppServerTurnCardStore(path), state = new SqliteStateStore(path);
    const gateway = { createCardKitEntity: vi.fn(async () => ({ cardId: 'card' })),
      sendCardKitEntityToTarget: vi.fn(async () => ({ messageId: 'message' })), updateCardKitElement: vi.fn(),
      replaceCardKitEntity: vi.fn(async () => { throw new CardKitApiError('invalid image key', 'payload'); }),
      sendOperationCardToTarget: vi.fn(async () => ({ messageId: 'safe-final' })), sendTextToTarget: vi.fn(), sendRenderedMessageToTarget: vi.fn() };
    const experience = new FeishuAppServerTurnExperience(gateway, 1000, undefined, cards);
    const outbox = new FeishuOutbox(state, new FeishuGatewayOutboxTransport(gateway, state));
    const target = { chatId: 'group', replyToMessageId: 'source', replyInThread: true };
    try {
      await experience.accepted({ taskId: 'task', turnId: 'turn', target });
      await experience.event({ type: 'turn.started', taskId: 'task', threadId: 'thread', turnId: 'remote' });
      expect(await experience.event({ type: 'turn.completed', taskId: 'task', threadId: 'thread', turnId: 'remote', status: 'completed',
        turn: { items: [{ type: 'agentMessage', text: `public answer${suffix}\ntoken=fake-legacy-secret` }] } })).toBe(true);
      expect(outbox.pending()).toHaveLength(1);
      expect(outbox.pending()[0]!.payload).toMatchObject({ kind: 'legacy_turn_final' });
      expect(JSON.stringify(cards.get('app-server:task_platform:turn')!.finalizationIntent!.fallbackText)).not.toContain('fake-legacy-secret');
      expect(await outbox.flush()).toEqual({ sent: 1, failed: 0 });
      expect(gateway.sendOperationCardToTarget).toHaveBeenCalledWith(target,
        expect.objectContaining({ schema: '2.0' }), expect.any(String));
      const sentCard = (gateway.sendOperationCardToTarget.mock.calls[0] as unknown as [unknown, unknown])[1];
      expect(Buffer.byteLength(JSON.stringify(sentCard))).toBeLessThan(24_000);
      if (suffix) expect(JSON.stringify(sentCard)).toContain('部分预览');
      expect(cards.get('app-server:task_platform:turn')!.state).toBe('finalized');
    } finally { experience.dispose(); cards.close(); state.close(); }
  });
  it('persists rate-limit deadlines and retry counts across restart', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'rate-limit-final-')), 'state.sqlite');
    const store = new SqliteAppServerTurnCardStore(path);
    let now = new Date('2026-10-16T00:00:00Z');
    const record = newAppServerCardRecord({ ownerKind: 'task_platform', taskId: 'task', localTurnId: 'turn', target: { chatId: 'chat' }, now: now.toISOString() });
    store.save({ ...record, state: 'finalizing', structuredView: true, cardId: 'card', cardMessageId: 'message',
      finalizationIntent: { card: { safe: true }, sequence: 2, uuid: 'stable', terminalState: 'finalized' } });
    const gateway = { createCardKitEntity: vi.fn(), sendCardKitEntityToTarget: vi.fn(), updateCardKitElement: vi.fn(),
      replaceCardKitEntity: vi.fn().mockRejectedValueOnce(new CardKitApiError('rate limited', 'retryable', 429, 60_000)).mockResolvedValue(undefined) };
    let experience = new FeishuAppServerTurnExperience(gateway, 1000, () => now, store);
    try {
      await experience.recoverOpenCards('task_platform', vi.fn());
      expect(store.get(record.id)!.finalizationIntent).toMatchObject({ attempts: 1, nextAttemptAt: '2026-10-16T00:01:00.000Z' });
      experience.dispose(); experience = new FeishuAppServerTurnExperience(gateway, 1000, () => now, store);
      now = new Date('2026-10-16T00:00:59Z');
      await experience.recoverOpenCards('task_platform', vi.fn());
      expect(gateway.replaceCardKitEntity).toHaveBeenCalledOnce();
      now = new Date('2026-10-16T00:01:01Z');
      await experience.recoverOpenCards('task_platform', vi.fn());
      expect(gateway.replaceCardKitEntity).toHaveBeenCalledTimes(2);
      expect(gateway.replaceCardKitEntity.mock.calls[0]).toEqual(gateway.replaceCardKitEntity.mock.calls[1]);
      expect(store.get(record.id)!.state).toBe('finalized');
    } finally { experience.dispose(); store.close(); }
  });
  it.each([false, true])('delivery-only rollback recovery never creates progress cards or replays legacy drafts (structured=%s)', async (structuredView) => {
    const path = join(await mkdtemp(join(tmpdir(), 'rollback-draft-')), 'state.sqlite'), store = new SqliteAppServerTurnCardStore(path);
    const record = newAppServerCardRecord({ ownerKind: 'task_platform', taskId: 'task', localTurnId: 'turn', target: { chatId: 'private' }, now: new Date().toISOString() });
    store.save({ ...record, structuredView, ...(structuredView ? {} : { state: 'finalizing', finalizationIntent: {
      card: { body: 'untrusted legacy draft' }, uuid: 'legacy', sequence: 1, terminalState: 'finalized',
    } }) });
    const gateway = { createCardKitEntity: vi.fn(), sendCardKitEntityToTarget: vi.fn(), updateCardKitElement: vi.fn(), replaceCardKitEntity: vi.fn() };
    const experience = new FeishuAppServerTurnExperience(gateway, 1000, undefined, store);
    try {
      await experience.recoverFinalizations();
      for (const method of Object.values(gateway)) expect(method).not.toHaveBeenCalled();
      expect(store.get(record.id)?.state).toBe(structuredView ? 'creating' : 'finalizing');
    } finally { experience.dispose(); store.close(); }
  });
  it('rolls back only the new UI while keeping public-result persistence and redaction', async () => {
    const gateway = { createCardKitEntity: vi.fn(async () => ({ cardId: 'card' })),
      sendCardKitEntityToTarget: vi.fn(async () => ({ messageId: 'message' })), updateCardKitElement: vi.fn(async () => undefined),
      replaceCardKitEntity: vi.fn(async () => undefined) };
    const registerCard = vi.fn(() => 'a'.repeat(32)), saveResult = vi.fn();
    const experience = new FeishuAppServerTurnExperience(gateway, 1000, undefined, undefined, 'task_platform', undefined,
      { enabled: false, registerCard, saveResult });
    try {
      await experience.accepted({ taskId: 'task', turnId: 'local', target: { chatId: 'chat' } });
      expect(JSON.stringify(gateway.createCardKitEntity.mock.calls)).not.toContain('turn_detail');
      expect(registerCard).not.toHaveBeenCalled();
      await experience.event({ type: 'turn.started', taskId: 'task', threadId: 'thread', turnId: 'remote' });
      await experience.event({ type: 'turn.completed', taskId: 'task', threadId: 'thread', turnId: 'remote', status: 'completed',
        turn: { items: [{ type: 'agentMessage', text: 'public answer\ntoken=fake-rollback-secret' }] } });
      expect(saveResult).toHaveBeenCalled();
      expect(JSON.stringify(saveResult.mock.calls)).not.toContain('fake-rollback-secret');
      expect(JSON.stringify(gateway.replaceCardKitEntity.mock.calls)).not.toContain('fake-rollback-secret');
    } finally { experience.dispose(); }
  });
  it('serializes a concurrent completion and late interruption into one final operation', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'final-serialize-')), 'state.sqlite');
    const store = new SqliteAppServerTurnCardStore(path);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const gateway = { createCardKitEntity: vi.fn(async () => ({ cardId: 'card' })),
      sendCardKitEntityToTarget: vi.fn(async () => ({ messageId: 'message' })),
      updateCardKitElement: vi.fn(async () => undefined), replaceCardKitEntity: vi.fn(async () => pending) };
    const experience = new FeishuAppServerTurnExperience(gateway, 1000, undefined, store, 'task_platform', undefined,
      { registerCard: () => 'a'.repeat(32), saveResult: (_id, answer, endedAt) => ({ text: answer, hasMore: false, endedAt }) });
    try {
      await experience.accepted({ taskId: 'task', turnId: 'local', target: { chatId: 'chat' } });
      await experience.event({ type: 'turn.started', taskId: 'task', threadId: 'thread', turnId: 'remote' });
      const completion = experience.event({ type: 'turn.completed', taskId: 'task', threadId: 'thread', turnId: 'remote', status: 'completed',
        turn: { items: [{ type: 'agentMessage', text: 'completed answer' }] } });
      // The terminal handler yields for any outstanding progress update before allocating its intent.
      await Promise.resolve(); await Promise.resolve();
      expect(gateway.replaceCardKitEntity).toHaveBeenCalledOnce();
      const interruption = experience.interruptTurn('task_platform', 'local', 'late reset');
      release();
      expect(await completion).toBe(true); expect(await interruption).toBe(true);
      expect(gateway.replaceCardKitEntity).toHaveBeenCalledOnce();
      expect(JSON.stringify(gateway.replaceCardKitEntity.mock.calls[0])).toContain('completed answer');
    } finally { release(); experience.dispose(); store.close(); }
  });
  it.each(['create', 'send', 'permanent'] as const)('queues the same structured final when %s delivery fails', async (failure) => {
    const path = join(await mkdtemp(join(tmpdir(), 'final-fallback-')), 'state.sqlite');
    const store = new SqliteAppServerTurnCardStore(path), state = new SqliteStateStore(path);
    const gateway = {
      createCardKitEntity: vi.fn(async () => { if (failure === 'create') throw new Error('create failed'); return { cardId: 'card' }; }),
      sendCardKitEntityToTarget: vi.fn(async () => { if (failure === 'send') throw new Error('send failed'); return { messageId: 'running' }; }),
      updateCardKitElement: vi.fn(async () => undefined),
      replaceCardKitEntity: vi.fn(async () => { throw new CardKitApiError('original card gone', 'permanent'); }),
      sendOperationCardToTarget: vi.fn(async () => ({ messageId: 'fallback' })),
      sendTextToTarget: vi.fn(async () => undefined), sendRenderedMessageToTarget: vi.fn(async () => undefined),
    };
    const outbox = new FeishuOutbox(state, new FeishuGatewayOutboxTransport(gateway, state));
    const experience = new FeishuAppServerTurnExperience(gateway, 1000, undefined, store, 'host_manager', undefined,
      { registerCard: () => 'a'.repeat(32), saveResult: (_id, answer, endedAt) => ({ text: answer, hasMore: false, endedAt }) });
    try {
      await experience.accepted({ taskId: 'task', turnId: 'local', target: { chatId: 'private' } });
      await experience.event({ type: 'turn.started', taskId: 'task', threadId: 'thread', turnId: 'remote' });
      expect(await experience.event({ type: 'turn.completed', taskId: 'task', threadId: 'thread', turnId: 'remote',
        status: 'completed', turn: { items: [{ type: 'agentMessage', text: 'complete public answer' }] } })).toBe(true);
      const intent = store.get('app-server:host_manager:local')!.finalizationIntent!;
      expect(intent.deliveryMode).toBe('outbox');
      expect(outbox.pending()).toHaveLength(1);
      const text = JSON.stringify(intent.card);
      for (const label of ['complete public answer', '过程记录', '命令与输出', '文件变更', 'app_server_footer']) expect(text).toContain(label);
      await experience.recoverOpenCards('host_manager', async () => undefined);
      expect(outbox.pending()).toHaveLength(1);
      const replacements = gateway.replaceCardKitEntity.mock.calls.length;
      expect(await experience.interruptTurn('host_manager', 'local', 'late shutdown')).toBe(true);
      expect(store.get('app-server:host_manager:local')!.finalizationIntent).toEqual(intent);
      await outbox.flush();
      expect(gateway.sendOperationCardToTarget).toHaveBeenCalledWith({ chatId: 'private' }, intent.card, expect.any(String));
      expect(store.get('app-server:host_manager:local')!.state).toBe('finalized');
      expect(gateway.replaceCardKitEntity.mock.calls.length).toBe(replacements);
      expect(gateway.sendTextToTarget).not.toHaveBeenCalled();
    } finally { experience.dispose(); store.close(); state.close(); }
  });
  it('owns ambiguous structured replacement retries without generic fallback and preserves the exact intent across restart', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'ambiguous-final-')), 'state.sqlite');
    let store = new SqliteAppServerTurnCardStore(path);
    const gateway = { createCardKitEntity: vi.fn(async () => ({ cardId: 'card' })),
      sendCardKitEntityToTarget: vi.fn(async () => ({ messageId: 'running' })), updateCardKitElement: vi.fn(async () => undefined),
      replaceCardKitEntity: vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(undefined) };
    let experience = new FeishuAppServerTurnExperience(gateway, 1000, undefined, store, 'task_platform', undefined,
      { registerCard: () => 'a'.repeat(32), saveResult: (_id, answer, endedAt) => ({ text: answer, hasMore: false, endedAt }) });
    try {
      await experience.accepted({ taskId: 'task', turnId: 'local', target: { chatId: 'chat' } });
      await experience.event({ type: 'turn.started', taskId: 'task', threadId: 'thread', turnId: 'remote' });
      expect(await experience.event({ type: 'turn.completed', taskId: 'task', threadId: 'thread', turnId: 'remote',
        status: 'completed', turn: { items: [{ type: 'agentMessage', text: 'answer' }] } })).toBe(true);
      const intent = store.get('app-server:task_platform:local')!.finalizationIntent!;
      expect(intent.deliveryMode).toBeUndefined();
      experience.dispose(); store.close(); store = new SqliteAppServerTurnCardStore(path);
      experience = new FeishuAppServerTurnExperience(gateway, 1000, undefined, store);
      // Restart must not bypass the persisted backoff deadline.
      await experience.recoverOpenCards('task_platform', async () => undefined);
      expect(gateway.replaceCardKitEntity).toHaveBeenCalledOnce();
      store.update('app-server:task_platform:local', (current) => ({ ...current,
        finalizationIntent: { ...current.finalizationIntent!, nextAttemptAt: new Date(0).toISOString() } }));
      await experience.recoverOpenCards('task_platform', async () => undefined);
      expect(gateway.replaceCardKitEntity.mock.calls[0]).toEqual(gateway.replaceCardKitEntity.mock.calls[1]);
      expect(store.get('app-server:task_platform:local')!.state).toBe('finalized');
    } finally { experience.dispose(); store.close(); }
  });
  it('does not paginate an ordinary structured final just because the storage browser has another page', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'final-card-')), 'state.sqlite');
    const store = new SqliteAppServerTurnCardStore(path);
    let now = new Date('2026-10-14T00:00:00Z');
    const gateway = { createCardKitEntity: vi.fn(async () => ({ cardId: 'card' })),
      sendCardKitEntityToTarget: vi.fn(async () => ({ messageId: 'message' })),
      updateCardKitElement: vi.fn(async () => undefined), replaceCardKitEntity: vi.fn(async () => undefined) };
    const experience = new FeishuAppServerTurnExperience(gateway, 1000, () => now, store, 'task_platform', undefined,
      { registerCard: () => 'a'.repeat(32), saveResult: (_identity, answer, endedAt) => ({ text: answer.slice(0, 2000), hasMore: true, endedAt }) });
    try {
      await experience.accepted({ taskId: 'task', turnId: 'local', target: { chatId: 'chat' } });
      await experience.event({ type: 'turn.started', taskId: 'task', threadId: 'thread', turnId: 'remote' });
      now = new Date('2026-10-14T00:00:12Z');
      await experience.event({ type: 'turn.completed', taskId: 'task', threadId: 'thread', turnId: 'remote', status: 'completed',
        turn: { items: [{ type: 'agentMessage', text: 'answer'.repeat(1000) }] } });
      const final = JSON.stringify(gateway.replaceCardKitEntity.mock.calls.at(-1));
      for (const label of ['过程记录', '命令与输出', '文件变更', 'app_server_footer', '12 秒']) expect(final).toContain(label);
      expect(final).toContain('answer'.repeat(1000));
      expect(final).not.toContain('完整答复');
      expect(final).not.toContain('等待上报');
      expect(store.get('app-server:task_platform:local')!.snapshot!.finalAnswer).toBeUndefined();
    } finally { experience.dispose(); store.close(); }
  });
  it('stores the complete public answer before final card delivery and isolates result storage failures', async () => {
    const gateway = { createCardKitEntity: vi.fn(async () => ({ cardId: 'card' })),
      sendCardKitEntityToTarget: vi.fn(async () => ({ messageId: 'message' })),
      updateCardKitElement: vi.fn(async () => undefined), replaceCardKitEntity: vi.fn(async () => undefined) };
    const saveResult = vi.fn(() => { throw new Error('storage unavailable'); });
    const experience = new FeishuAppServerTurnExperience(gateway, 1000,
      () => new Date('2026-10-14T00:00:00Z'), undefined, 'task_platform', undefined,
      { registerCard: () => 'a'.repeat(32), saveResult });
    try {
      await experience.accepted({ taskId: 'task', turnId: 'local', target: { chatId: 'chat' } });
      await experience.event({ type: 'turn.started', taskId: 'task', threadId: 'thread', turnId: 'remote' });
      const answer = '全文🙂\n'.repeat(2000).trim();
      await expect(experience.event({ type: 'turn.completed', taskId: 'task', threadId: 'thread', turnId: 'remote',
        status: 'completed', turn: { items: [{ type: 'agentMessage', text: answer }] } })).resolves.toBe(true);
      expect(saveResult).toHaveBeenCalledWith({ ownerKind: 'task_platform', taskId: 'task', localTurnId: 'local' },
        answer, '2026-10-14T00:00:00.000Z');
      expect(gateway.replaceCardKitEntity).toHaveBeenCalled();
      const degraded = JSON.stringify(gateway.replaceCardKitEntity.mock.calls.at(-1));
      expect(degraded).toContain('完整答复存储或入口不可用');
      expect(degraded).toContain('app_server_footer');
      expect(degraded).not.toContain('"category":"result"');
    } finally { experience.dispose(); }
  });
  it('refreshes idle elapsed time and retries a transient progress failure without failing the turn', async () => {
    vi.useFakeTimers();
    const gateway = { createCardKitEntity: vi.fn(async () => ({ cardId: 'card' })),
      sendCardKitEntityToTarget: vi.fn(async () => ({ messageId: 'message' })),
      updateCardKitElement: vi.fn(async () => undefined), replaceCardKitEntity: vi.fn(async () => undefined) };
    const experience = new FeishuAppServerTurnExperience(gateway, 1000, undefined, undefined, 'task_platform', undefined,
      { registerCard: () => 'a'.repeat(32) });
    try {
      await experience.accepted({ taskId: 'task', turnId: 'local', target: { chatId: 'chat' } });
      await experience.event({ type: 'turn.started', taskId: 'task', threadId: 'thread', turnId: 'turn' });
      gateway.replaceCardKitEntity.mockRejectedValueOnce(new Error('temporary failure'));
      await vi.advanceTimersByTimeAsync(3000);
      expect(gateway.replaceCardKitEntity.mock.calls.length).toBeGreaterThanOrEqual(2);
      const count = gateway.replaceCardKitEntity.mock.calls.length;
      await vi.advanceTimersByTimeAsync(15000);
      expect(gateway.replaceCardKitEntity.mock.calls.length).toBeGreaterThan(count);
      expect(JSON.stringify(gateway.replaceCardKitEntity.mock.calls.at(-1))).toContain('已运行');
    } finally { experience.dispose(); vi.useRealTimers(); }
  });
  it('uses the structured layout and registered readonly detail buttons only when the UI is enabled', async () => {
    vi.useFakeTimers();
    const gateway = { createCardKitEntity: vi.fn(async () => ({ cardId: 'card' })),
      sendCardKitEntityToTarget: vi.fn(async () => ({ messageId: 'message' })),
      updateCardKitElement: vi.fn(async () => undefined), replaceCardKitEntity: vi.fn(async () => undefined) };
    const registerCard = vi.fn(() => 'a'.repeat(32));
    const experience = new FeishuAppServerTurnExperience(gateway, 1000, undefined, undefined, 'task_platform', undefined, { registerCard });
    try {
      await experience.accepted({ taskId: 'task', turnId: 'local', target: { chatId: 'chat' } });
      const card = JSON.stringify(gateway.createCardKitEntity.mock.calls);
      expect(card).toContain('turn_detail');
      expect(card).toContain('app_server_footer');
      expect(registerCard).toHaveBeenCalledWith({ ownerKind: 'task_platform', taskId: 'task', localTurnId: 'local' });
      await experience.event({ type: 'turn.started', taskId: 'task', threadId: 'thread', turnId: 'turn' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(gateway.replaceCardKitEntity).toHaveBeenCalled();
      expect(gateway.updateCardKitElement).not.toHaveBeenCalled();
    } finally { experience.dispose(); vi.useRealTimers(); }
  });
  it('renders receipt-backed action states immediately and preserves the runtime footer', async () => {
    vi.useFakeTimers();
    const gateway = { createCardKitEntity: vi.fn(async () => ({ cardId: 'card' })),
      sendCardKitEntityToTarget: vi.fn(async () => ({ messageId: 'message' })),
      updateCardKitElement: vi.fn(async () => undefined), replaceCardKitEntity: vi.fn(async () => undefined) };
    const experience = new FeishuAppServerTurnExperience(gateway, 1000);
    const request: AppServerRequestRecord = { id: 'req', localTurnId: 'local', taskId: 'task', threadId: 'thread', turnId: 'turn',
      generation: 1, serverRequestId: 1, kind: 'approval', method: 'item/commandExecution/requestApproval', ownerUserId: 'ou_owner',
      status: 'pending', createdAt: '2026-10-13T00:00:00Z', expiresAt: '2999-10-13T01:00:00Z', riskSummary: '', payload: {} };
    const frame = () => JSON.stringify(gateway.updateCardKitElement.mock.calls.at(-1));
    try {
      await experience.accepted({ taskId: 'task', turnId: 'local', target: { chatId: 'chat' } });
      await experience.event({ type: 'turn.started', taskId: 'task', threadId: 'thread', turnId: 'turn' });
      await experience.requestChanged(request);
      await vi.advanceTimersByTimeAsync(0);
      expect(frame()).toContain('正在准备操作请求');
      expect(frame()).not.toContain('待确认');
      await experience.requestChanged({ ...request, operationCard: { status: 'sent', messageId: 'approval-message', at: request.createdAt } });
      await vi.advanceTimersByTimeAsync(0);
      expect(frame()).toContain('待确认');
      expect(frame()).toContain('ou_owner');
      for (const field of ['模型', '思考强度', '模式', '上下文', '任务累计', '已运行']) expect(frame()).toContain(field);
      await experience.requestChanged({ ...request, status: 'decided', responseState: 'failed' });
      await vi.advanceTimersByTimeAsync(0);
      expect(frame()).toContain('操作提交失败');
      expect(frame()).not.toContain('待确认');
      await experience.requestChanged({ ...request, status: 'delivered' });
      await vi.advanceTimersByTimeAsync(0);
      expect(frame()).not.toContain('操作提交失败');
    } finally { experience.dispose(); vi.useRealTimers(); }
  });
  it('reports unsupported Host Manager approvals without pretending an action card was sent', async () => {
    vi.useFakeTimers();
    const gateway = { createCardKitEntity: vi.fn(async () => ({ cardId: 'card' })),
      sendCardKitEntityToTarget: vi.fn(async () => ({ messageId: 'message' })),
      updateCardKitElement: vi.fn(async () => undefined), replaceCardKitEntity: vi.fn(async () => undefined) };
    const experience = new FeishuAppServerTurnExperience(gateway, 100);
    try {
      await experience.accepted({ ownerKind: 'host_manager', taskId: 'host', turnId: 'local', target: { chatId: 'user' } });
      await experience.event({ type: 'turn.started', taskId: 'host', threadId: 'thread', turnId: 'turn' });
      await experience.event({ type: 'backend.server_request', taskId: 'host', generation: 1, requestId: 1,
        method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn' } });
      await vi.advanceTimersByTimeAsync(100);
      const content = JSON.stringify(gateway.updateCardKitElement.mock.calls);
      expect(content).toContain('尚未接入交互审批');
      expect(content).not.toContain('等待你的确认');
    } finally { experience.dispose(); vi.useRealTimers(); }
  });
  it('labels an unbound chat without persisting a fake project identity', async () => {
    const gateway = {
      createCardKitEntity: vi.fn(async () => ({ cardId: 'card_chat' })),
      sendCardKitEntityToTarget: vi.fn(async () => ({ messageId: 'om_chat' })),
      updateCardKitElement: vi.fn(async () => undefined),
      replaceCardKitEntity: vi.fn(async () => undefined),
    };
    const root = await mkdtemp(join(tmpdir(), 'chat-card-'));
    const store = new SqliteAppServerTurnCardStore(join(root, 'cards.sqlite'));
    const experience = new FeishuAppServerTurnExperience(gateway, 1000, undefined, store);
    await experience.accepted({ taskId: 'chat_task', turnId: 'chat_turn', displayLabel: '纯对话', target: { chatId: 'oc_chat' } });
    expect(JSON.stringify(gateway.createCardKitEntity.mock.calls[0])).toContain('纯对话');
    const record = store.listOpen()[0]!;
    expect(record.displayLabel).toBe('纯对话');
    expect(record).not.toHaveProperty('projectId');
    store.close();
  });

  it('reacts, streams structured progress, and replaces the same card with Markdown', async () => {
    vi.useFakeTimers();
    const gateway = {
      addReaction: vi.fn(async () => undefined),
      createCardKitEntity: vi.fn(async () => ({ cardId: 'card_1' })),
      sendCardKitEntityToTarget: vi.fn(async () => ({ messageId: 'om_card' })),
      updateCardKitElement: vi.fn(async () => undefined),
      replaceCardKitEntity: vi.fn(async () => undefined),
    };
    const experience = new FeishuAppServerTurnExperience(gateway, 100);
    await experience.accepted({
      taskId: 'task_1', turnId: 'local_turn', projectId: 'repo', messageId: 'om_user',
      model: 'gpt-5.6', reasoningEffort: 'high', serviceTier: 'fast',
      target: { chatId: 'oc_1', replyToMessageId: 'om_user' },
    });
    expect(gateway.addReaction).toHaveBeenCalledWith('om_user', 'Get');
    expect(gateway.createCardKitEntity).toHaveBeenCalledWith(expect.objectContaining({
      header: expect.objectContaining({
        title: expect.objectContaining({ content: 'Codex 正在工作' }),
      }),
    }));

    await experience.event({ type: 'turn.started', taskId: 'task_1', threadId: 'thread_1', turnId: 'remote_turn' });
    await experience.event({
      type: 'usage.updated', taskId: 'task_1', threadId: 'thread_1', turnId: 'remote_turn',
      usage: {
        total: { totalTokens: 1_000_000 }, last: { totalTokens: 142_673 }, modelContextWindow: 258_400,
        codeBotTaskTotalTokens: 12_345_678,
      },
    });
    await experience.event({
      type: 'item.started', taskId: 'task_1', threadId: 'thread_1', turnId: 'remote_turn',
      item: { id: 'compact_1', type: 'contextCompaction' },
    });
    await experience.event({
      type: 'item.delta', taskId: 'task_1', threadId: 'thread_1', turnId: 'remote_turn',
      itemId: 'item_1', channel: 'agent_message', delta: '正在检查工作区',
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(gateway.updateCardKitElement).toHaveBeenCalledWith(expect.objectContaining({
      cardId: 'card_1', elementId: 'app_server_progress',
      element: expect.objectContaining({ content: expect.stringContaining('正在检查工作区') }),
    }));
    const lastUpdate = gateway.updateCardKitElement.mock.calls.at(-1) as unknown as [{ element: { content: string } }];
    const liveContent = lastUpdate[0].element.content;
    expect(liveContent).toContain('gpt-5.6');
    expect(liveContent).toContain('high');
    expect(liveContent).toContain('模型：gpt-5.6</font>\n>');
    expect(liveContent).toContain('思考强度：high</font>\n>');
    expect(liveContent).toContain('模式：Fast</font>\n>');
    expect(liveContent).toContain('上下文：55.2%</font>\n>');
    expect(liveContent).toContain('任务累计：12.35M tokens</font>\n>');
    expect(liveContent).toContain('已运行：0 秒');
    expect(liveContent).toContain('正在压缩上下文');

    await experience.event({ type: 'item.delta', taskId: 'task_1', threadId: 'thread_1', turnId: 'remote_turn',
      itemId: 'file_1', channel: 'file_change', delta: '[修改](/workspace/repo/a.go:10)',
    });
    await vi.advanceTimersByTimeAsync(100);
    const fileUpdate = gateway.updateCardKitElement.mock.calls.at(-1) as unknown as [{ element: { content: string } }];
    expect(fileUpdate[0].element.content).toContain('修改（`a.go:10`，本地路径）');
    expect(fileUpdate[0].element.content).not.toContain('](/workspace/');

    await expect(experience.event({
      type: 'turn.completed', taskId: 'task_1', threadId: 'thread_1', turnId: 'remote_turn',
      status: 'completed', turn: { items: [{ type: 'agentMessage', text: '**工作区干净。**' }] },
    })).resolves.toBe(true);
    expect(gateway.replaceCardKitEntity).toHaveBeenCalledWith(expect.objectContaining({
      cardId: 'card_1',
      card: expect.objectContaining({
        body: { elements: [expect.objectContaining({ content: '**工作区干净。**' })] },
      }),
    }));
  });

  it('returns false when final card replacement fails so the durable outbox can deliver it', async () => {
    const gateway = {
      addReaction: vi.fn(async () => { throw new Error('reaction denied'); }),
      createCardKitEntity: vi.fn(async () => ({ cardId: 'card_1' })),
      sendCardKitEntityToTarget: vi.fn(async () => ({ messageId: 'om_card' })),
      updateCardKitElement: vi.fn(async () => undefined),
      replaceCardKitEntity: vi.fn(async () => { throw new Error('CardKit unavailable'); }),
    };
    const experience = new FeishuAppServerTurnExperience(gateway);
    await expect(experience.accepted({
      taskId: 'task_1', turnId: 'local_turn', projectId: 'repo', messageId: 'om_user',
      target: { chatId: 'oc_1' },
    })).resolves.toBeUndefined();
    await experience.event({ type: 'turn.started', taskId: 'task_1', threadId: 'thread_1', turnId: 'remote_turn' });
    await expect(experience.event({
      type: 'turn.completed', taskId: 'task_1', threadId: 'thread_1', turnId: 'remote_turn',
      status: 'completed', turn: { items: [{ type: 'agentMessage', text: 'done' }] },
    })).resolves.toBe(false);
  });

  it('resolves task source references before finalizing a live card', async () => {
    const gateway = {
      createCardKitEntity: vi.fn(async () => ({ cardId: 'card_source' })),
      sendCardKitEntityToTarget: vi.fn(async () => ({ messageId: 'om_source' })),
      updateCardKitElement: vi.fn(async () => undefined),
      replaceCardKitEntity: vi.fn(async () => undefined),
    };
    const resolveSourceReferences = vi.fn(async (_taskId: string, text: string) =>
      text.replace('/workspace/repo/a.go:10', 'https://github.com/example/repo/blob/abc/a.go#L10'));
    const experience = new FeishuAppServerTurnExperience(
      gateway, 1_000, undefined, undefined, 'task_platform', resolveSourceReferences,
    );
    await experience.accepted({ taskId: 'task_1', turnId: 'local_1', projectId: 'repo', target: { chatId: 'oc_1' } });
    await experience.event({ type: 'turn.started', taskId: 'task_1', threadId: 'thread_1', turnId: 'remote_1' });
    await experience.event({ type: 'turn.completed', taskId: 'task_1', threadId: 'thread_1', turnId: 'remote_1',
      status: 'completed', turn: { items: [{ type: 'agentMessage', text: '[代码](/workspace/repo/a.go:10)' }] } });
    expect(resolveSourceReferences).toHaveBeenCalledWith('task_1', '[代码](/workspace/repo/a.go:10)');
    expect(JSON.stringify(gateway.replaceCardKitEntity.mock.calls)).toContain('https://github.com/example/repo/blob/abc/a.go#L10');
    experience.dispose();
  });

  it('recovers and closes an orphaned running card after the owning process restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'app-server-card-'));
    const databasePath = join(root, 'state.sqlite');
    const firstStore = new SqliteAppServerTurnCardStore(databasePath);
    const gateway = {
      addReaction: vi.fn(async () => undefined),
      createCardKitEntity: vi.fn(async () => ({ cardId: 'card_orphan' })),
      sendCardKitEntityToTarget: vi.fn(async () => ({ messageId: 'om_orphan' })),
      updateCardKitElement: vi.fn(async () => undefined),
      replaceCardKitEntity: vi.fn(async () => undefined),
    };
    const first = new FeishuAppServerTurnExperience(gateway, 100, () => new Date('2026-08-08T00:00:00Z'), firstStore, 'host_manager');
    await first.accepted({
      taskId: 'host_task', turnId: 'host_turn_1', projectId: 'link-bot', ownerKind: 'host_manager',
      messageId: 'om_request', target: { chatId: 'oc_admin', replyToMessageId: 'om_request' },
    });
    firstStore.close();

    const restartedStore = new SqliteAppServerTurnCardStore(databasePath);
    const restarted = new FeishuAppServerTurnExperience(gateway, 100, undefined, restartedStore, 'host_manager');
    await restarted.recoverOpenCards('host_manager', async () => ({ status: 'interrupted' }));

    expect(gateway.replaceCardKitEntity).toHaveBeenCalledWith(expect.objectContaining({
      cardId: 'card_orphan', sequence: 1,
      card: expect.objectContaining({ body: expect.any(Object) }),
    }));
    expect(restartedStore.listOpen('host_manager')).toEqual([]);
    restartedStore.close();
  });

  it('persists finalization intent and retries the same operation after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'app-server-card-finalize-'));
    const databasePath = join(root, 'state.sqlite');
    const firstStore = new SqliteAppServerTurnCardStore(databasePath);
    const replaceCardKitEntity = vi.fn()
      .mockRejectedValueOnce(new Error('temporary outage'))
      .mockResolvedValueOnce(undefined);
    const gateway = {
      addReaction: vi.fn(async () => undefined),
      createCardKitEntity: vi.fn(async () => ({ cardId: 'card_finalizing' })),
      sendCardKitEntityToTarget: vi.fn(async () => ({ messageId: 'om_finalizing' })),
      updateCardKitElement: vi.fn(async () => undefined), replaceCardKitEntity,
    };
    const first = new FeishuAppServerTurnExperience(gateway, 100, undefined, firstStore);
    await first.accepted({ taskId: 'task_1', turnId: 'local_turn_1', projectId: 'repo', target: { chatId: 'oc_1' } });
    await first.event({ type: 'turn.started', taskId: 'task_1', threadId: 'thread_1', turnId: 'remote_turn_1' });
    await expect(first.event({
      type: 'turn.completed', taskId: 'task_1', threadId: 'thread_1', turnId: 'remote_turn_1',
      status: 'completed', turn: { items: [{ type: 'agentMessage', text: 'done' }] },
    })).resolves.toBe(false);
    const pending = firstStore.listOpen('task_platform')[0]!;
    const intent = pending.finalizationIntent!;
    first.dispose();
    firstStore.close();

    const restartedStore = new SqliteAppServerTurnCardStore(databasePath);
    const restarted = new FeishuAppServerTurnExperience(gateway, 100, undefined, restartedStore);
    restartedStore.update(pending.id, (current) => ({ ...current,
      finalizationIntent: { ...current.finalizationIntent!, nextAttemptAt: new Date(0).toISOString() } }));
    await restarted.recoverOpenCards('task_platform', async () => undefined);
    expect(replaceCardKitEntity).toHaveBeenLastCalledWith(expect.objectContaining({
      cardId: 'card_finalizing', sequence: intent.sequence, uuid: intent.uuid,
    }));
    expect(restartedStore.listOpen('task_platform')).toEqual([]);
    restartedStore.close();
  });
});
