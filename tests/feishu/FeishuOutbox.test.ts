import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe,expect,it,vi } from 'vitest';
import { detailTurnKey } from '../../src/details/DetailEventAdapter.js';
import { TurnResultStore } from '../../src/details/TurnResultStore.js';
import { FeishuApprovalOutboxRenderer,FeishuGatewayOutboxTransport,FeishuOutbox } from '../../src/feishu/FeishuOutbox.js';
import { newAppServerCardRecord,SqliteAppServerTurnCardStore } from '../../src/livecards/AppServerTurnCardStore.js';
import { CardKitApiError } from '../../src/livecards/LiveTurnCardTypes.js';
import { MediaService } from '../../src/media/MediaService.js';
import { TaskPlatformDiagnostics } from '../../src/observability/TaskPlatformDiagnostics.js';
import { SqliteStateStore } from '../../src/state/SqliteStateStore.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('FeishuOutbox', () => {
  it('bounds final fallback retries and keeps quarantine durable across outbox recreation', async () => {
    const path = join(await createTmpDir(), 'state.sqlite');
    const state = new SqliteStateStore(path), cards = new SqliteAppServerTurnCardStore(path);
    let now = new Date('2026-10-16T00:00:00Z');
    const record = newAppServerCardRecord({ ownerKind: 'host_manager', taskId: 'task', localTurnId: 'turn', target: { chatId: 'chat' }, now: now.toISOString() });
    cards.save({ ...record, structuredView: true, state: 'finalizing', finalizationIntent: {
      card: { schema: '2.0', body: { elements: [] } }, uuid: 'saved', sequence: 2, terminalState: 'finalized',
    } });
    cards.enqueueFinalFallback(record.id);
    const deliver = vi.fn(async () => { throw new CardKitApiError('outage', 'retryable', 503, 60_000); });
    let outbox = new FeishuOutbox(state, { deliver }, () => now);
    try {
      for (let attempt = 1; attempt <= 12; attempt++) {
        expect(await outbox.flush()).toEqual({ sent: 0, failed: 1 });
        expect(await outbox.flush()).toEqual({ sent: 0, failed: 0 });
        now = new Date(now.getTime() + 45_000);
        expect(await outbox.flush()).toEqual({ sent: 0, failed: 0 });
        now = new Date(now.getTime() + 16_000);
        outbox = new FeishuOutbox(state, { deliver }, () => now);
      }
      expect(deliver).toHaveBeenCalledTimes(12);
      expect(cards.get(record.id)).toMatchObject({ state: 'fallback', deliveryFailure: 'retry_exhausted',
        finalizationIntent: { uuid: 'saved', deliveryMode: 'outbox' } });
      expect(cards.listOpen()).toHaveLength(0);
      expect(await outbox.flush()).toEqual({ sent: 0, failed: 0 });
      expect(outbox.pending()[0]!.attempts).toBe(-1);
    } finally { state.close(); cards.close(); }
  });
  it('delivers referenced safe public results without duplicating backend payloads in the outbox', async () => {
    const path = join(await createTmpDir(), 'state.sqlite');
    const state = new SqliteStateStore(path), results = new TurnResultStore(path);
    const identity = { ownerKind: 'task_platform' as const, taskId: 'task', localTurnId: 'turn' };
    results.save(identity, { kind: 'private_user', chatId: 'chat', userId: 'owner' }, 'public safe answer\ntoken=fake-outbox-secret', new Date().toISOString());
    const send = vi.fn(async () => undefined);
    const outbox = new FeishuOutbox(state, new FeishuGatewayOutboxTransport({ sendTextToTarget: vi.fn(), sendRenderedMessageToTarget: send }, state));
    try {
      outbox.enqueue({ dedupeKey: 'final-ref', target: { chatId: 'chat' }, eventType: 'card',
        payload: { kind: 'task_turn_final', taskId: 'task', status: 'completed', resultRef: detailTurnKey(identity) } });
      expect(JSON.stringify(outbox.pending())).not.toContain('public safe answer');
      expect(await outbox.flush()).toEqual({ sent: 1, failed: 0 });
      expect(JSON.stringify(send.mock.calls)).toContain('public safe answer');
      expect(JSON.stringify(send.mock.calls)).not.toContain('fake-outbox-secret');
    } finally { results.close(); state.close(); }
  });
  it('rolls back a failed atomic handoff and preserves permanently rejected sends for diagnosis', async () => {
    const path = join(await createTmpDir(), 'state.sqlite');
    const state = new SqliteStateStore(path), cards = new SqliteAppServerTurnCardStore(path);
    const record = newAppServerCardRecord({ ownerKind: 'task_platform', taskId: 'task', localTurnId: 'turn', target: { chatId: 'chat' }, now: new Date().toISOString() });
    record.structuredView = true; record.state = 'finalizing';
    record.finalizationIntent = { card: { schema: '2.0', body: { elements: [] } }, sequence: 2, uuid: 'uuid', terminalState: 'finalized' };
    cards.save(record);
    const send = vi.fn(async () => { throw new CardKitApiError('bad card payload', 'payload'); });
    const outbox = new FeishuOutbox(state, new FeishuGatewayOutboxTransport({ sendOperationCardToTarget: send,
      sendTextToTarget: vi.fn(), sendRenderedMessageToTarget: vi.fn() }, state));
    try {
      state.db.exec(`CREATE TRIGGER fail_handoff BEFORE UPDATE ON live_cards
        WHEN json_extract(NEW.payload,'$.finalizationIntent.deliveryMode')='outbox' BEGIN SELECT RAISE(ABORT,'test handoff failure'); END;`);
      expect(() => cards.enqueueFinalFallback(record.id)).toThrow('test handoff failure');
      expect(outbox.pending()).toHaveLength(0);
      expect(cards.get(record.id)!.finalizationIntent!.deliveryMode).toBeUndefined();
      state.db.exec('DROP TRIGGER fail_handoff');
      cards.enqueueFinalFallback(record.id);
      expect(await outbox.flush()).toEqual({ sent: 0, failed: 1 });
      expect(await outbox.flush()).toEqual({ sent: 0, failed: 0 });
      expect(outbox.pending()[0]!.attempts).toBe(-1);
      expect(cards.get(record.id)).toMatchObject({ state: 'fallback', deliveryFailure: 'permanent' });
      expect(cards.get(record.id)!.finalizationIntent).toBeDefined();
      expect(cards.listOpen()).toHaveLength(0);
      expect(send).toHaveBeenCalledOnce();
    } finally { state.close(); cards.close(); }
  });
  it('reuses the same send UUID after remote receipt but failed local finalization', async () => {
    const path = join(await createTmpDir(), 'state.sqlite');
    const state = new SqliteStateStore(path), cards = new SqliteAppServerTurnCardStore(path);
    const record = newAppServerCardRecord({ ownerKind: 'task_platform', taskId: 'task', localTurnId: 'turn', target: { chatId: 'chat' }, now: new Date().toISOString() });
    record.structuredView = true; record.state = 'finalizing';
    record.finalizationIntent = { card: { schema: '2.0', body: { elements: [] } }, sequence: 2, uuid: 'uuid', terminalState: 'interrupted' };
    cards.save(record); cards.enqueueFinalFallback(record.id);
    const send = vi.fn(async () => ({ messageId: 'same-remote-message' }));
    let now = new Date();
    const outbox = new FeishuOutbox(state, new FeishuGatewayOutboxTransport({ sendOperationCardToTarget: send,
      sendTextToTarget: vi.fn(), sendRenderedMessageToTarget: vi.fn() }, state), () => now);
    try {
      state.db.exec(`CREATE TRIGGER fail_final_write BEFORE UPDATE ON live_cards
        WHEN json_extract(NEW.payload,'$.state')='interrupted' BEGIN SELECT RAISE(ABORT,'test local failure'); END;`);
      expect(await outbox.flush()).toEqual({ sent: 0, failed: 1 });
      expect(cards.get(record.id)!.state).toBe('finalizing');
      state.db.exec('DROP TRIGGER fail_final_write');
      expect(await outbox.flush()).toEqual({ sent: 0, failed: 0 });
      now = new Date(now.getTime() + 2_000);
      expect(await outbox.flush()).toEqual({ sent: 1, failed: 0 });
      expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
      expect(cards.get(record.id)!.state).toBe('interrupted');
      expect(cards.enqueueFinalFallback(record.id)).toBe(false);
    } finally { state.close(); cards.close(); }
  });
  it('durably sends the exact final card once and closes its intent after receipt', async () => {
    const path = join(await createTmpDir(), 'state.sqlite');
    const store = new SqliteStateStore(path), cards = new SqliteAppServerTurnCardStore(path);
    const record = newAppServerCardRecord({ ownerKind: 'host_manager', taskId: 'task', localTurnId: 'turn',
      target: { chatId: 'group', replyToMessageId: 'root', replyInThread: true }, now: new Date().toISOString() });
    record.structuredView = true;
    const card = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'final answer' }] } };
    record.finalizationIntent = { card, uuid: 'final-uuid', sequence: 3, terminalState: 'finalized' };
    record.state = 'finalizing'; cards.save(record);
    const send = vi.fn().mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValue({ messageId: 'final-message' });
    const text = vi.fn(), rendered = vi.fn();
    let now = new Date();
    const outbox = new FeishuOutbox(store, new FeishuGatewayOutboxTransport({ sendOperationCardToTarget: send,
      sendTextToTarget: text, sendRenderedMessageToTarget: rendered }, store), () => now);
    try {
      expect(cards.enqueueFinalFallback(record.id)).toBe(true);
      expect(cards.enqueueFinalFallback(record.id)).toBe(true);
      expect(outbox.pending()).toHaveLength(1);
      expect(await outbox.flush()).toEqual({ sent: 0, failed: 1 });
      expect(cards.get(record.id)!.state).toBe('finalizing');
      expect(await outbox.flush()).toEqual({ sent: 0, failed: 0 });
      now = new Date(now.getTime() + 2_000);
      expect(await outbox.flush()).toEqual({ sent: 1, failed: 0 });
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
      expect(send).toHaveBeenLastCalledWith(record.target, card, expect.any(String));
      expect(cards.get(record.id)).toMatchObject({ state: 'finalized', fallbackMessageId: 'final-message' });
      expect(cards.get(record.id)!.finalizationIntent).toBeUndefined();
      expect(await outbox.flush()).toEqual({ sent: 0, failed: 0 });
      expect(text).not.toHaveBeenCalled(); expect(rendered).not.toHaveBeenCalled();
    } finally { cards.close(); store.close(); }
  });
  it('does not let an exhausted legacy card block a newer reply', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'));
    const deliver = vi.fn(async () => undefined);
    const outbox = new FeishuOutbox(store, { deliver });
    const old = outbox.enqueue({ dedupeKey: 'old-card', target: { chatId: 'oc_1' }, eventType: 'card', payload: { kind: 'sample_progress' } });
    store.db.prepare("UPDATE outbound_events SET attempts=1000000, last_error='HTTP 400' WHERE id=?").run(old.id);
    const recent = outbox.enqueue({ dedupeKey: 'new-final', target: { chatId: 'oc_1' }, eventType: 'text', payload: { text: 'done' } });

    await expect(outbox.flush(1)).resolves.toEqual({ sent: 1, failed: 0 });

    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ id: recent.id }));
    expect(outbox.pending()).toMatchObject([expect.objectContaining({ id: old.id })]);
    store.close();
  });

  it('stops retrying a permanent Feishu HTTP 400 response', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'));
    const error = Object.assign(new Error('Request failed with status code 400'), { response: { status: 400 } });
    const deliver = vi.fn(async () => { throw error; });
    const outbox = new FeishuOutbox(store, { deliver });
    outbox.enqueue({ dedupeKey: 'bad-card', target: { chatId: 'oc_1' }, eventType: 'card', payload: { kind: 'sample_progress' } });

    await expect(outbox.flush()).resolves.toEqual({ sent: 0, failed: 1 });
    await expect(outbox.flush()).resolves.toEqual({ sent: 0, failed: 0 });

    expect(deliver).toHaveBeenCalledOnce();
    expect(outbox.pending()[0]).toMatchObject({ attempts: -1, lastError: expect.stringContaining('400') });
    store.close();
  });

  it('persists before delivery and survives outage/retry without duplicate final replies', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'));
    let offline = true;
    const deliver = vi.fn(async () => { if (offline) throw new Error('Feishu unavailable'); });
    const outbox = new FeishuOutbox(store, { deliver });

    const first = outbox.enqueue({ dedupeKey: 'turn_1:final', target: { chatId: 'oc_1' }, eventType: 'text', payload: { text: 'done' } });
    const duplicate = outbox.enqueue({ dedupeKey: 'turn_1:final', target: { chatId: 'oc_1' }, eventType: 'text', payload: { text: 'done' } });
    expect(duplicate.id).toBe(first.id);
    await expect(outbox.flush()).resolves.toEqual({ sent: 0, failed: 1 });
    expect(outbox.pending()).toHaveLength(1);

    offline = false;
    await expect(outbox.flush()).resolves.toEqual({ sent: 1, failed: 0 });
    await expect(outbox.flush()).resolves.toEqual({ sent: 0, failed: 0 });
    expect(deliver).toHaveBeenCalledTimes(2);
    store.close();
  });

  it('rebuilds a missing card with the same durable dedupe key and exposes health counts', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'));
    const outbox = new FeishuOutbox(store, { deliver: async () => undefined });
    outbox.enqueue({ dedupeKey: 'turn_1:card', target: { chatId: 'oc_1' }, eventType: 'card', payload: { state: 'running' } });
    outbox.enqueue({ dedupeKey: 'turn_1:card', target: { chatId: 'oc_1' }, eventType: 'card_rebuild', payload: { state: 'running' } });
    const diagnostics = new TaskPlatformDiagnostics(store);
    diagnostics.setMetric('link_bot_hot_tasks', 2, { project: 'repo' });
    store.recordStartupMetric({ startupType: 'ready', durationMs: 500 });
    store.recordStartupMetric({ startupType: 'ready', durationMs: 900 });
    expect(diagnostics.audit('task.created', { taskId: 'task_1' }, 'task.created:task_1')).toBe(true);
    expect(diagnostics.audit('task.created', { taskId: 'task_1' }, 'task.created:task_1')).toBe(false);

    expect(outbox.pending()).toHaveLength(1);
    expect(diagnostics.health()).toMatchObject({ ok: true, checks: { sqliteIntegrity: true }, counts: { pendingOutbox: 1 } });
    expect(diagnostics.snapshot()).toMatchObject({
      activeTurns: 0, readySlots: 0, unknownPublishes: 0,
      startupLatency: { ready: { p50: 500, p95: 900, count: 2 } },
    });
    expect((store.db.prepare("SELECT COUNT(*) AS count FROM metrics WHERE name='link_bot_startup_latency_ms'").get() as { count: number }).count).toBe(6);
    store.close();
  });

  it('persists an approval card before Feishu delivery and deduplicates rebuilds', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'));
    const outbox = new FeishuOutbox(store, { deliver: async () => undefined });
    const renderer = new FeishuApprovalOutboxRenderer(outbox);
    const request = {
      id: 'asr_1', kind: 'approval' as const, ownerUserId: 'ou_owner', taskId: 'task_1',
      threadId: 'thread_1', turnId: 'turn_1', generation: 2, serverRequestId: 7,
      method: 'item/commandExecution/requestApproval', riskSummary: 'Run tests', payload: {},
      status: 'pending' as const, createdAt: '2026-07-28T00:00:00.000Z', expiresAt: '2026-07-28T00:05:00.000Z',
    };
    await renderer.render(request);
    await renderer.render(request);

    expect(outbox.pending()).toHaveLength(1);
    expect(outbox.pending()[0]).toMatchObject({
      dedupeKey: 'asr_1:approval-card', target: { chatId: 'ou_owner', receiveIdType: 'open_id', mentionUserId: 'ou_owner' },
      eventType: 'card', payload: { requestId: 'asr_1', generation: 2 },
    });
    store.close();
  });

  it('delivers legacy finals as text, App Server finals as Markdown cards, and approvals as actionable cards', async () => {
    const sendTextToTarget = vi.fn(async () => undefined);
    const sendRenderedMessageToTarget = vi.fn(async (_target: unknown, _rendered: unknown) => undefined);
    const sendOperationCardToTarget = vi.fn(async () => ({ messageId: 'approval-message' }));
    const transport = new FeishuGatewayOutboxTransport({ sendTextToTarget, sendRenderedMessageToTarget, sendOperationCardToTarget });
    await transport.deliver({
      id: 'out_1', dedupeKey: 'turn_1:final', target: { chatId: 'oc_1' }, eventType: 'text',
      status: 'pending', attempts: 0, payload: {
        taskId: 'task_1', status: 'completed',
        turn: { items: [{ type: 'agentMessage', text: 'Implemented and verified.' }] },
      }, createdAt: '2026-07-28T00:00:00.000Z', updatedAt: '2026-07-28T00:00:00.000Z',
    });
    expect(sendTextToTarget).toHaveBeenCalledWith({ chatId: 'oc_1' }, 'Implemented and verified.');
    await transport.deliver({
      id: 'out_final_card', dedupeKey: 'turn_2:final', target: { chatId: 'oc_1' }, eventType: 'card',
      status: 'pending', attempts: 0, payload: {
        kind: 'task_turn_final', taskId: 'task_1', status: 'completed',
        turn: { items: [{ type: 'agentMessage', text: '**Markdown result**' }] },
      }, createdAt: '2026-07-28T00:00:00.000Z', updatedAt: '2026-07-28T00:00:00.000Z',
    });
    expect(sendRenderedMessageToTarget).toHaveBeenCalledWith(
      { chatId: 'oc_1' },
      expect.objectContaining({
        preferred: expect.objectContaining({
          kind: 'card',
          payload: expect.objectContaining({ body: { elements: [{ tag: 'markdown', content: '**Markdown result**' }] } }),
        }),
      }),
    );

    const request = {
      id: 'asr_1', kind: 'approval' as const, ownerUserId: 'ou_owner', taskId: 'task_1',
      threadId: 'thread_1', turnId: 'turn_1', generation: 2, serverRequestId: 7,
      method: 'item/commandExecution/requestApproval', riskSummary: 'Run tests', payload: {},
      status: 'pending' as const, createdAt: '2026-07-28T00:00:00.000Z', expiresAt: '2999-07-28T00:05:00.000Z',
    };
    await transport.deliver({
      id: 'out_2', dedupeKey: 'asr_1:approval-card', target: { chatId: 'ou_owner' }, eventType: 'card',
      status: 'pending', attempts: 0, payload: { kind: 'app_server_request', request, generation: 2 },
      createdAt: '2026-07-28T00:00:00.000Z', updatedAt: '2026-07-28T00:00:00.000Z',
    });
    expect(sendOperationCardToTarget).toHaveBeenCalledWith(
      { chatId: 'ou_owner', receiveIdType: 'open_id' },
      expect.any(Object), 'out_2',
    );
  });

  it('records only a real operation card receipt and never revives a resolved request', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'));
    const now = new Date('2026-10-13T00:00:00Z');
    const request = { id: 'asr', kind: 'approval' as const, ownerUserId: 'owner', taskId: 'task', threadId: 'thread', turnId: 'turn',
      generation: 1, serverRequestId: 7, method: 'item/commandExecution/requestApproval', riskSummary: '', payload: {}, status: 'pending' as const,
      createdAt: now.toISOString(), expiresAt: '2999-10-13T01:00:00Z' };
    store.saveAppServerRequest(request);
    const messageAppLink = 'https://applink.feishu.cn/client/chat/open?openChatId=oc_chat&position=42';
    const delivered = vi.fn(async () => ({ messageId: 'msg', messageAppLink }));
    const outbox = new FeishuOutbox(store, { deliver: delivered }, () => now);
    const notify = vi.fn();
    outbox.subscribeApproval(notify);
    outbox.enqueue({ dedupeKey: 'approval', target: { chatId: 'chat' }, eventType: 'card',
      payload: { kind: 'app_server_request', requestId: 'asr', generation: 1 } });
    expect(store.getAppServerRequest('asr')!.operationCard).toBeUndefined();
    await outbox.flush();
    expect(store.getAppServerRequest('asr')).toMatchObject({ status: 'pending', operationCard: { status: 'sent', messageId: 'msg', messageAppLink } });
    expect(store.getAppServerRequest('asr')!.deliveredAt).toBeUndefined();
    expect(notify).toHaveBeenCalledOnce();
    store.saveAppServerRequest({ ...request, status: 'resolved' });
    outbox.enqueue({ dedupeKey: 'late', target: { chatId: 'chat' }, eventType: 'card',
      payload: { kind: 'app_server_request', requestId: 'asr', generation: 1 } });
    await outbox.flush();
    expect(store.getAppServerRequest('asr')).toMatchObject({ status: 'resolved' });
    expect(store.getAppServerRequest('asr')!.operationCard).toBeUndefined();
    store.close();
  });

  it('silently drains legacy warm-retention warnings without sending a Feishu message', async () => {
    const sendTextToTarget = vi.fn(async () => undefined);
    const sendRenderedMessageToTarget = vi.fn(async () => undefined);
    const transport = new FeishuGatewayOutboxTransport({ sendTextToTarget, sendRenderedMessageToTarget });

    await transport.deliver({
      id: 'out_retention', dedupeKey: 'task:task_1:disk-retention:legacy', target: { chatId: 'ou_owner' },
      eventType: 'text', status: 'pending', attempts: 0,
      payload: { kind: 'disk_retention_warning', taskId: 'task_1', text: 'legacy warning' },
      createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z',
    });

    expect(sendTextToTarget).not.toHaveBeenCalled();
    expect(sendRenderedMessageToTarget).not.toHaveBeenCalled();
  });

  it('delivers a durable pre-rendered authorization card', async () => {
    const sendRenderedMessageToTarget = vi.fn(async () => undefined);
    const transport = new FeishuGatewayOutboxTransport({
      sendTextToTarget: vi.fn(async () => undefined), sendRenderedMessageToTarget,
    });
    const rendered = {
      preferred: { kind: 'card' as const, payload: { schema: '2.0' } },
      fallback: { kind: 'text' as const, text: '需要授权' },
    };
    await transport.deliver({
      id: 'out_auth', dedupeKey: 'turn_1:lark-auth-required', target: { chatId: 'oc_group' },
      eventType: 'card', status: 'pending', attempts: 0,
      payload: { kind: 'rendered_message', rendered },
      createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z',
    });
    expect(sendRenderedMessageToTarget).toHaveBeenCalledWith({ chatId: 'oc_group' }, rendered);
  });

  it('preserves the group topic actor in durable publish approval cards', async () => {
    const sendRenderedMessageToTarget = vi.fn(async (_target: unknown, _rendered: unknown) => undefined);
    const transport = new FeishuGatewayOutboxTransport({
      sendTextToTarget: vi.fn(async () => undefined), sendRenderedMessageToTarget,
    });
    await transport.deliver({
      id: 'out_publish', dedupeKey: 'pub_1:card',
      target: { chatId: 'oc_group', chatType: 'group', topicId: 'omt_topic', replyToMessageId: 'om_request',
        replyInThread: true, mentionUserId: 'ou_owner' },
      eventType: 'card', status: 'pending', attempts: 0,
      payload: { kind: 'task_publish_confirmation', requestId: 'pub_1', forceUpdate: true },
      createdAt: '2026-07-28T00:00:00.000Z', updatedAt: '2026-07-28T00:00:00.000Z',
    });

    const rendered = sendRenderedMessageToTarget.mock.calls[0]![1];
    expect(JSON.stringify(rendered)).toContain('"chatType":"group"');
    expect(JSON.stringify(rendered)).toContain('"topicId":"omt_topic"');
  });

  it('renders a durable repository migration decision card in its original topic', async () => {
    const sendRenderedMessageToTarget = vi.fn(async (_target: unknown, _rendered: unknown) => undefined);
    const transport = new FeishuGatewayOutboxTransport({
      sendTextToTarget: vi.fn(async () => undefined), sendRenderedMessageToTarget,
    });
    await transport.deliver({
      id: 'out_migration', dedupeKey: 'repository_migration_1:card',
      target: { chatId: 'oc_group', chatType: 'group', topicId: 'omt_topic', mentionUserId: 'ou_owner' },
      eventType: 'card', status: 'pending', attempts: 0,
      payload: { kind: 'repository_migration_confirmation', migration: {
        id: 'repository_migration_1', taskId: 'task_1', repositoryId: 'repository_1', projectId: 'repo',
        sourceBaseRef: 'develop', targetBaseRef: 'release', targetBaseCommit: 'a'.repeat(40),
        state: 'conflict_waiting', conflictPath: '/workspace/projects/repo.migration-1', requestedBy: 'ou_owner',
        createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z',
      } },
      createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z',
    });

    const [target, rendered] = sendRenderedMessageToTarget.mock.calls[0]!;
    expect(target).toMatchObject({ chatId: 'oc_group', topicId: 'omt_topic' });
    const serialized = JSON.stringify(rendered);
    expect(serialized).toContain('repository_migration_decision');
    expect(serialized).toContain('确认采用冲突副本');
    expect(serialized).toContain('omt_topic');
  });

  it('leases delivery atomically across concurrent flushes and retries a stale sending lease', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'));
    let now = new Date('2026-07-28T00:00:00.000Z');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const deliver = vi.fn(async () => gate);
    const outbox = new FeishuOutbox(store, { deliver }, () => now);
    outbox.enqueue({ dedupeKey: 'once', target: { chatId: 'oc_1' }, eventType: 'text', payload: { text: 'done' } });

    const first = outbox.flush();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    await expect(outbox.flush()).resolves.toEqual({ sent: 0, failed: 0 });
    release();
    await expect(first).resolves.toEqual({ sent: 1, failed: 0 });

    outbox.enqueue({ dedupeKey: 'stale', target: { chatId: 'oc_1' }, eventType: 'text', payload: { text: 'retry' } });
    store.db.prepare("UPDATE outbound_events SET status='sending' WHERE dedupe_key='stale'").run();
    await expect(outbox.flush()).resolves.toEqual({ sent: 0, failed: 0 });
    now = new Date('2026-07-28T00:01:00.000Z');
    await expect(outbox.flush()).resolves.toEqual({ sent: 1, failed: 0 });
    expect(deliver).toHaveBeenCalledTimes(2);
    store.close();
  });

  it('uploads media once, persists the resource key, and sends it after its dependency', async () => {
    const root = await createTmpDir();
    const store = new SqliteStateStore(join(root, 'state.sqlite'));
    const storagePath = join(root, 'result.txt');
    await writeFile(storagePath, 'result');
    const media = new MediaService({
      enabled: true, storageRoot: join(root, 'media'), maxImagesPerTurn: 8, maxFilesPerTurn: 10,
      maxImageBytes: 10_485_760, maxFileBytes: 52_428_800, maxTotalBytesPerTurn: 104_857_600,
      pendingGroupAttachmentTtlMs: 300_000, retentionHours: 24,
    }, store, {}, {});
    media.saveAttachment({
      id: 'att_1', direction: 'outbound', kind: 'file', originalName: 'result.txt', safeName: 'result.txt',
      detectedMime: 'text/plain', sizeBytes: 6, sha256: 'abc', storagePath, chatId: 'oc_1', taskId: 'task_1',
      turnId: 'turn_1', status: 'exported', createdAt: '2026-07-28T00:00:00.000Z', updatedAt: '2026-07-28T00:00:00.000Z',
    });
    const uploadFile = vi.fn(async () => 'file_key_1');
    const sendMediaToTarget = vi.fn(async () => ({ messageId: 'om_file_1' }));
    const transport = new FeishuGatewayOutboxTransport({
      sendTextToTarget: vi.fn(async () => undefined), sendRenderedMessageToTarget: vi.fn(async () => undefined),
      uploadFile, sendMediaToTarget,
    }, store, media);
    const outbox = new FeishuOutbox(store, transport);
    outbox.enqueue({
      dedupeKey: 'artifact-send', target: { chatId: 'oc_1' }, eventType: 'media_send',
      payload: { kind: 'media_send', attachmentId: 'att_1', dependsOnDedupeKey: 'turn-final' },
    });
    await expect(outbox.flush()).resolves.toEqual({ sent: 0, failed: 0 });
    outbox.enqueue({ dedupeKey: 'turn-final', target: { chatId: 'oc_1' }, eventType: 'text', payload: { text: 'done' } });
    await expect(outbox.flush()).resolves.toEqual({ sent: 1, failed: 0 });
    await expect(outbox.flush()).resolves.toEqual({ sent: 1, failed: 0 });
    expect(uploadFile).toHaveBeenCalledOnce();
    expect(sendMediaToTarget).toHaveBeenCalledWith({ chatId: 'oc_1' }, {
      kind: 'file', resourceKey: 'file_key_1', uuid: expect.stringMatching(/^out_/),
    });
    expect(media.getAttachment('att_1')).toMatchObject({ status: 'sent', remoteResourceKey: 'file_key_1' });
    store.close();
  });

  it('resolves source references for a durable final-message fallback', async () => {
    const sendRenderedMessageToTarget = vi.fn(async () => undefined);
    const resolveSourceReferences = vi.fn(async (_taskId: string, text: string) =>
      text.replace('/workspace/repo/a.go:10', 'https://github.com/example/repo/blob/abc/a.go#L10'));
    const transport = new FeishuGatewayOutboxTransport({
      sendTextToTarget: vi.fn(async () => undefined), sendRenderedMessageToTarget,
    }, undefined, undefined, resolveSourceReferences);
    await transport.deliver({
      id: 'out_source', dedupeKey: 'source:final', target: { chatId: 'oc_1' }, eventType: 'card',
      status: 'pending', attempts: 0,
      payload: { kind: 'task_turn_final', taskId: 'task_1', status: 'completed',
        turn: { items: [{ type: 'agentMessage', text: '[代码](/workspace/repo/a.go:10)' }] } },
      createdAt: '2026-07-28T00:00:00.000Z', updatedAt: '2026-07-28T00:00:00.000Z',
    });
    expect(resolveSourceReferences).toHaveBeenCalledWith('task_1', '[代码](/workspace/repo/a.go:10)');
    expect(JSON.stringify(sendRenderedMessageToTarget.mock.calls)).toContain('https://github.com/example/repo/blob/abc/a.go#L10');
  });
});
