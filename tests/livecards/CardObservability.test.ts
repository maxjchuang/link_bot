import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { createTmpDir } from '../helpers/tmp.js';
import { FeishuAppServerTurnExperience } from '../../src/livecards/AppServerTurnExperience.js';
import { SqliteAppServerTurnCardStore } from '../../src/livecards/AppServerTurnCardStore.js';
import { observeCardDelivery, waitingSample } from '../../src/livecards/CardObservability.js';
import { CardKitApiError } from '../../src/livecards/LiveTurnCardTypes.js';
import type { AppServerRequestRecord } from '../../src/approvals/AppServerRequestTypes.js';
import type { LiveTurnSnapshot } from '../../src/projections/LiveTurnProjection.js';
import { SqliteStateStore } from '../../src/state/SqliteStateStore.js';
import { FeishuOutbox, FeishuGatewayOutboxTransport } from '../../src/feishu/FeishuOutbox.js';

afterEach(() => vi.useRealTimers());
const base = new Date('2026-10-16T00:00:00Z');
function telemetry() { return { observeCard: vi.fn(), observeWaiting: vi.fn(), observeRelease: vi.fn(), observeReleaseUnavailable: vi.fn() }; }
function request(): AppServerRequestRecord { return { id: 'request', localTurnId: 'local', taskId: 'task', threadId: 'thread', turnId: 'remote',
  generation: 1, serverRequestId: 1, kind: 'approval', method: 'item/commandExecution/requestApproval', ownerUserId: 'owner', status: 'pending',
  createdAt: base.toISOString(), expiresAt: new Date(base.getTime() + 60000).toISOString(), riskSummary: '', payload: {},
  operationCard: { status: 'sent', messageId: 'operation', at: base.toISOString() } }; }
async function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(base);
  const path = join(await createTmpDir(), 'state.sqlite'), store = new SqliteAppServerTurnCardStore(path);
  const stats = telemetry();
  const gateway = { createCardKitEntity: vi.fn(async () => ({ cardId: 'card' })),
    sendCardKitEntityToTarget: vi.fn(async () => ({ messageId: 'message' })), updateCardKitElement: vi.fn(async () => undefined),
    replaceCardKitEntity: vi.fn(async (_input: unknown): Promise<void> => undefined), sendOperationCardToTarget: vi.fn(async () => ({ messageId: 'fallback' })),
    sendTextToTarget: vi.fn(async () => undefined), sendRenderedMessageToTarget: vi.fn(async () => undefined) };
  const ui = { registerCard: () => 'a'.repeat(32) };
  const experience = new FeishuAppServerTurnExperience(gateway, 1000, undefined, store, 'task_platform', undefined, ui, stats);
  await experience.accepted({ taskId: 'task', turnId: 'local', target: { chatId: 'private' } });
  await experience.event({ type: 'turn.started', taskId: 'task', threadId: 'thread', turnId: 'remote' });
  return { path, store, stats, gateway, ui, experience, id: 'app-server:task_platform:local' };
}

describe('card receipt observability', () => {
  it('isolates metric errors and exports only numeric size/duration plus fixed operation/outcome', async () => {
    const stats = telemetry(), payload = { body: 'fake-private-card-body' };
    await expect(observeCardDelivery(stats, 'card_create', payload, async () => 'created')).resolves.toBe('created');
    expect(stats.observeCard).toHaveBeenCalledWith('card_create', 'ok', expect.any(Number), Buffer.byteLength(JSON.stringify(payload)));
    await expect(observeCardDelivery(stats, 'card_update', payload, async () => { throw new Error('fake-private-error'); })).rejects.toThrow('fake-private-error');
    expect(stats.observeCard.mock.calls.at(-1)![1]).toBe('unavailable');
    expect(JSON.stringify(stats.observeCard.mock.calls)).not.toContain('fake-private');
    stats.observeCard.mockImplementation(() => { throw new Error('metrics failed'); });
    await expect(observeCardDelivery(stats, 'card_update', payload, async () => 'ok')).resolves.toBe('ok');
  });

  it('classifies missing receipts, expiry, cleared facts and unknown history separately from valid waits', () => {
    const snapshot = { phase: 'running', pendingActions: [{ requestRef: 'r', status: 'delivered', handlerUserId: 'owner',
      messageId: 'message', expiresAt: new Date(base.getTime() + 1000).toISOString() }] } as LiveTurnSnapshot;
    expect(waitingSample(['r'], snapshot, base.getTime())).toBe('valid');
    expect(waitingSample(['r'], snapshot, base.getTime() + 1000)).toBe('false_wait');
    expect(waitingSample(['r'], { ...snapshot, pendingActions: [] }, base.getTime())).toBe('false_wait');
    expect(waitingSample(['r'], { ...snapshot, phase: 'completed' }, base.getTime())).toBe('false_wait');
    expect(waitingSample(['r'], { ...snapshot, pendingActions: [{ ...snapshot.pendingActions![0]!, messageId: undefined }] }, base.getTime())).toBe('false_wait');
    expect(waitingSample(['r'], undefined, base.getTime())).toBe('unknown');
    expect(waitingSample([], snapshot, base.getTime())).toBe('not_waiting');
  });

  it('retains release facts on a failed update and emits latency only on a confirmed clearing version', async () => {
    const f = await fixture();
    try {
      await f.experience.requestChanged(request()); await vi.advanceTimersByTimeAsync(0);
      expect(f.stats.observeWaiting).toHaveBeenCalledWith('valid');
      await vi.advanceTimersByTimeAsync(250);
      f.gateway.replaceCardKitEntity.mockRejectedValueOnce(new Error('fake-update-error'));
      const resolved = { ...request(), status: 'delivered' as const, deliveredAt: new Date().toISOString() };
      await f.experience.requestChanged(resolved); await vi.advanceTimersByTimeAsync(0);
      expect(f.stats.observeRelease).not.toHaveBeenCalled();
      expect(f.store.get(f.id)!.requestReleasePending).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.stats.observeRelease).toHaveBeenCalledOnce(); expect(f.stats.observeRelease).toHaveBeenCalledWith(1000);
      expect(f.store.get(f.id)!.requestReleasePending).toHaveLength(0);
      await f.experience.requestChanged(resolved); await vi.advanceTimersByTimeAsync(0);
      expect(f.stats.observeRelease).toHaveBeenCalledOnce();
      expect(f.stats.observeCard.mock.calls.some(([op, outcome]) => op === 'card_update' && outcome === 'unavailable')).toBe(true);
    } finally { f.experience.dispose(); f.store.close(); }
  });

  it('detects a stale in-flight waiting card and does not settle latency before the following clearing receipt', async () => {
    const f = await fixture();
    let oldAck!: () => void, newAck!: () => void;
    const old = new Promise<void>((resolve) => { oldAck = resolve; }), fresh = new Promise<void>((resolve) => { newAck = resolve; });
    f.gateway.replaceCardKitEntity.mockImplementationOnce(async () => old).mockImplementationOnce(async () => fresh);
    try {
      await f.experience.requestChanged(request()); await vi.advanceTimersByTimeAsync(0);
      await f.experience.requestChanged({ ...request(), status: 'resolved', invalidatedAt: new Date().toISOString() });
      await vi.advanceTimersByTimeAsync(500); oldAck(); await vi.advanceTimersByTimeAsync(0);
      expect(f.stats.observeWaiting).toHaveBeenCalledWith('false_wait');
      expect(f.stats.observeRelease).not.toHaveBeenCalled();
      expect(f.gateway.replaceCardKitEntity).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(600); newAck(); await vi.advanceTimersByTimeAsync(0);
      expect(f.stats.observeRelease).toHaveBeenCalledOnce(); expect(f.stats.observeRelease).toHaveBeenCalledWith(1100);
      expect(f.store.get(f.id)!.requestReleasePending).toHaveLength(0);
    } finally { oldAck(); newAck(); f.experience.dispose(); f.store.close(); }
  });

  it('survives restart without turning pending or missing timestamp observations into zero-latency successes', async () => {
    const f = await fixture();
    try {
      await f.experience.requestChanged(request()); await vi.advanceTimersByTimeAsync(0);
      f.gateway.replaceCardKitEntity.mockRejectedValueOnce(new CardKitApiError('gone', 'permanent'));
      await f.experience.requestChanged({ ...request(), status: 'delivered', deliveredAt: new Date().toISOString() });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.stats.observeRelease).not.toHaveBeenCalled();
      f.experience.dispose(); f.store.close();
      const reopened = new SqliteAppServerTurnCardStore(f.path);
      const recovered = new FeishuAppServerTurnExperience(f.gateway, 1000, undefined, reopened, 'task_platform', undefined, f.ui, f.stats);
      try {
        await vi.advanceTimersByTimeAsync(3000);
        await recovered.recoverOpenCards('task_platform', async () => ({ status: 'completed', answer: 'public answer' }));
        expect(f.stats.observeRelease).toHaveBeenCalledOnce(); expect(f.stats.observeRelease).toHaveBeenCalledWith(3000);
        expect(reopened.get(f.id)!.requestReleasePending).toHaveLength(0);
        expect(f.stats.observeCard).toHaveBeenCalledWith('card_final', 'ok', expect.any(Number), expect.any(Number));
      } finally { recovered.dispose(); reopened.close(); }
    } finally { f.experience.dispose(); }
  });

  it('settles a durable final fallback only after its successful outbox receipt, including failed send time', async () => {
    const f = await fixture(), state = new SqliteStateStore(f.path);
    const outbox = new FeishuOutbox(state, new FeishuGatewayOutboxTransport(f.gateway, state, undefined, undefined, undefined, f.stats));
    try {
      await f.experience.requestChanged(request()); await vi.advanceTimersByTimeAsync(0);
      f.gateway.replaceCardKitEntity.mockRejectedValue(new CardKitApiError('gone', 'permanent'));
      await f.experience.requestChanged({ ...request(), status: 'delivered', deliveredAt: new Date().toISOString() });
      await vi.advanceTimersByTimeAsync(0);
      await f.experience.event({ type: 'turn.completed', taskId: 'task', threadId: 'thread', turnId: 'remote', status: 'completed', turn: {} });
      f.gateway.sendOperationCardToTarget.mockRejectedValueOnce(new Error('send unavailable'));
      await outbox.flush();
      expect(f.stats.observeRelease).not.toHaveBeenCalled();
      expect(f.store.get(f.id)!.requestReleasePending).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(3000); await outbox.flush();
      expect(f.stats.observeRelease).toHaveBeenCalledOnce(); expect(f.stats.observeRelease).toHaveBeenCalledWith(3000);
      expect(f.stats.observeCard.mock.calls.filter(([op, outcome]) => op === 'card_fallback_send').map(([, outcome]) => outcome)).toEqual(['unavailable', 'ok']);
      expect(f.store.get(f.id)!.requestReleasePending).toHaveLength(0);
      await outbox.flush(); expect(f.stats.observeRelease).toHaveBeenCalledOnce();
    } finally { f.experience.dispose(); f.store.close(); state.close(); }
  });

  it('counts missing release timestamps and ignores mismatched request identity without fabricating timing', async () => {
    const f = await fixture();
    try {
      await f.experience.requestChanged(request()); await vi.advanceTimersByTimeAsync(0);
      await f.experience.requestChanged({ ...request(), turnId: 'other', status: 'resolved', invalidatedAt: new Date().toISOString() });
      expect(f.store.get(f.id)!.requestReleasePending).toBeUndefined();
      await f.experience.requestChanged({ ...request(), status: 'resolved' }); await vi.advanceTimersByTimeAsync(0);
      expect(f.stats.observeReleaseUnavailable).toHaveBeenCalledOnce(); expect(f.stats.observeReleaseUnavailable).toHaveBeenCalledWith('missing_timestamp');
      expect(f.stats.observeRelease).not.toHaveBeenCalled();
    } finally { f.experience.dispose(); f.store.close(); }
  });

  it('bounds pending timing state and explicitly counts measurements lost to capacity', async () => {
    const f = await fixture();
    f.gateway.replaceCardKitEntity.mockRejectedValue(new CardKitApiError('gone', 'permanent'));
    try {
      for (let index = 0; index < 33; index++) {
        const pending = { ...request(), id: `request-${index}` };
        await f.experience.requestChanged(pending); await vi.advanceTimersByTimeAsync(0);
        await f.experience.requestChanged({ ...pending, status: 'resolved', invalidatedAt: new Date().toISOString() });
      }
      expect(f.store.get(f.id)!.requestReleasePending).toHaveLength(32);
      expect(f.stats.observeReleaseUnavailable.mock.calls).toEqual([['capacity']]);
      expect(f.stats.observeRelease).not.toHaveBeenCalled();
    } finally { f.experience.dispose(); f.store.close(); }
  });

  it('counts operation-card receipts and failures, not skipped expired/resolved requests', async () => {
    const f = await fixture();
    const transport = new FeishuGatewayOutboxTransport(f.gateway, undefined, undefined, undefined, undefined, f.stats);
    const pending = { id: 'outbox', dedupeKey: 'key', target: { chatId: 'private' }, eventType: 'card' as const, status: 'pending' as const,
      attempts: 0, payload: { kind: 'app_server_request', request: request(), generation: 1 }, createdAt: base.toISOString(), updatedAt: base.toISOString() };
    try {
      await transport.deliver(pending);
      f.gateway.sendOperationCardToTarget.mockRejectedValueOnce(new Error('network unavailable'));
      await expect(transport.deliver(pending)).rejects.toThrow('network unavailable');
      await transport.deliver({ ...pending, payload: { ...pending.payload, request: { ...request(), status: 'resolved' } } });
      expect(f.stats.observeCard.mock.calls.filter(([op]) => op === 'operation_card_send').map(([, outcome]) => outcome)).toEqual(['ok', 'unavailable']);
      expect(f.gateway.sendOperationCardToTarget).toHaveBeenCalledTimes(2);
    } finally { f.experience.dispose(); f.store.close(); }
  });
});
