import { describe, expect, it, vi } from 'vitest';
import { LiveTurnProjection } from '../../src/projections/LiveTurnProjection.js';
import type { AppServerRequestRecord } from '../../src/approvals/AppServerRequestTypes.js';

describe('LiveTurnProjection', () => {
  it('keeps process sources and summary parts separate with at most three recent previews', () => {
    const p = new LiveTurnProjection();
    p.append({ type: 'turn.started', taskId: 'task', threadId: 'thread', turnId: 'turn' });
    const delta = { type: 'item.delta' as const, taskId: 'task', threadId: 'thread', turnId: 'turn' };
    p.append({ ...delta, itemId: 'reason', channel: 'reasoning', reasoningSource: 'public_summary', summaryIndex: 0, delta: 'first\n' });
    p.append({ ...delta, itemId: 'reason', channel: 'reasoning', reasoningSource: 'public_summary', summaryIndex: 1, delta: 'second\n' });
    p.append({ ...delta, itemId: 'plan', channel: 'plan', delta: 'plan\n' });
    p.append({ ...delta, itemId: 'progress', channel: 'agent_message', delta: 'progress\n' });
    expect(p.get('task')?.processPreviews).toMatchObject([
      { source: 'summary', summaryIndex: 1, text: 'second\n' }, { source: 'plan', text: 'plan\n' }, { source: 'progress', text: 'progress\n' },
    ]);
    p.append({ ...delta, itemId: 'progress', channel: 'agent_message', delta: 'API_KEY=fake-' });
    p.append({ ...delta, itemId: 'progress', channel: 'agent_message', delta: 'test-secret' });
    expect(JSON.stringify(p.get('task'))).not.toContain('fake-test-secret');
    expect(p.get('task')?.processPreviews?.length).toBeLessThanOrEqual(3);
  });
  it('does not call internal tools or undelivered requests waiting for user approval', () => {
    const projection = new LiveTurnProjection();
    projection.append({ type: 'turn.started', taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_1' });
    projection.append({ type: 'backend.server_request', taskId: 'task_1', generation: 1, requestId: 1, method: 'item/tool/call', params: {} });
    expect(projection.get('task_1')?.phase).toBe('running');
    const request: AppServerRequestRecord = { id: 'req', taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_1', generation: 1,
      serverRequestId: 2, kind: 'approval', method: 'item/commandExecution/requestApproval', ownerUserId: 'owner', riskSummary: '', payload: {},
      status: 'pending', createdAt: '2026-10-13T00:00:00Z', expiresAt: '2999-01-01T00:00:00Z' };
    projection.updateRequest(request);
    expect(projection.get('task_1')).toMatchObject({ phase: 'running', pendingActions: [{ status: 'preparing', handlerUserId: 'owner' }] });
    projection.updateRequest({ ...request, operationCard: { status: 'sent', messageId: 'msg', at: request.createdAt } });
    expect(projection.get('task_1')).toMatchObject({ phase: 'running', pendingActions: [{ status: 'delivered', messageId: 'msg' }] });
    projection.updateRequest({ ...request, id: 'stale-generation', generation: 0 });
    expect(projection.get('task_1')?.pendingActions).toHaveLength(1);
    projection.updateRequest({ ...request, id: 'second' });
    projection.updateRequest({ ...request, status: 'resolved' });
    expect(projection.get('task_1')?.pendingActions).toHaveLength(1);
    projection.append({ type: 'turn.completed', taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_1', status: 'completed', turn: {} });
    projection.updateRequest(request);
    expect(projection.get('task_1')?.pendingActions).toEqual([]);
  });
  it('projects structured events without terminal parsing', () => {
    const projection = new LiveTurnProjection();
    projection.append({ type: 'turn.started', taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_1' });
    projection.append({
      type: 'item.delta', taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_1', itemId: 'reason_1',
      channel: 'reasoning', reasoningSource: 'public_summary', delta: 'Checking tests. ',
    });
    projection.append({
      type: 'item.delta', taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_1', itemId: 'cmd_1',
      channel: 'command', delta: 'npm test\n',
    });
    projection.append({
      type: 'item.delta', taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_1', itemId: 'file_1',
      channel: 'file_change', delta: 'M src/index.ts\n',
    });
    projection.append({ type: 'turn.diff', taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_1', diff: '+change' });
    projection.append({ type: 'usage.updated', taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_1', usage: { total: 10 } });
    projection.append({
      type: 'item.completed', taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_1',
      item: { id: 'answer_1', type: 'agentMessage', text: 'Done.' },
    });

    expect(projection.get('task_1')).toMatchObject({
      phase: 'running', commentary: 'Checking tests. \nDone.', commandOutput: 'npm test\n',
      fileChangeOutput: 'M src/index.ts\n', diff: '+change', usage: { total: 10 }, finalAnswer: 'Done.',
      items: [{ id: 'answer_1', type: 'agentMessage', text: 'Done.' }],
    });
  });

  it('does not publish raw or legacy mixed reasoning through deltas or opaque items', () => {
    const projection = new LiveTurnProjection();
    projection.append({ type: 'turn.started', taskId: 'task', threadId: 'thread', turnId: 'turn' });
    for (const reasoningSource of [undefined, 'internal_reasoning'] as const) {
      projection.append({ type: 'item.delta', taskId: 'task', threadId: 'thread', turnId: 'turn', itemId: 'reason',
        channel: 'reasoning', reasoningSource, delta: 'private-thought' });
    }
    projection.append({ type: 'item.completed', taskId: 'task', threadId: 'thread', turnId: 'turn',
      item: { id: 'reason', type: 'reasoning', content: ['private-thought'] } });
    expect(JSON.stringify(projection.get('task'))).not.toContain('private-thought');
  });

  it('bounds opaque items and Diff previews and labels incomplete previews', () => {
    const projection = new LiveTurnProjection();
    projection.append({ type: 'turn.started', taskId: 'task', threadId: 'thread', turnId: 'turn' });
    for (let id = 0; id < 100; id++) projection.append({ type: 'item.started', taskId: 'task', threadId: 'thread', turnId: 'turn',
      item: { id: String(id), type: 'unknown', opaqueBody: 'x'.repeat(100000) } });
    projection.append({ type: 'turn.diff', taskId: 'task', threadId: 'thread', turnId: 'turn', diff: 'diff --git a/a b/a\n' + '+line\n'.repeat(10000) });
    const snapshot = projection.get('task')!;
    expect(snapshot.items.length).toBeLessThanOrEqual(32);
    expect(snapshot.diff!.length).toBeLessThanOrEqual(4000);
    expect(snapshot.diff).toContain('diff --git a/a b/a');
    expect(snapshot.diffTruncated).toBe(true);
    expect(JSON.stringify(snapshot).length).toBeLessThan(10000);
  });

  it('finalizes each turn once and ignores late events', () => {
    const projection = new LiveTurnProjection();
    const listener = vi.fn();
    projection.subscribe(listener);
    projection.append({ type: 'turn.started', taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_1' });
    const completed = {
      type: 'turn.completed' as const, taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_1', status: 'completed',
      turn: { id: 'turn_1', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: 'Final.' }] },
    };
    projection.append(completed);
    projection.append(completed);
    projection.append({
      type: 'item.delta', taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_1', itemId: 'late',
      channel: 'agent_message', delta: 'duplicated late text',
    });

    expect(projection.get('task_1')).toMatchObject({ phase: 'completed', finalAnswer: 'Final.', commentary: '', revision: 2 });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('moves approval, disconnect, and failed completion into explicit phases', () => {
    const projection = new LiveTurnProjection();
    projection.append({ type: 'turn.started', taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_1' });
    projection.append({
      type: 'backend.server_request', taskId: 'task_1', generation: 1, requestId: 7,
      method: 'item/commandExecution/requestApproval', params: {},
    });
    expect(projection.get('task_1')?.phase).toBe('running');
    projection.append({
      type: 'backend.disconnected', taskId: 'task_1', generation: 1, reason: 'socket lost',
    });
    expect(projection.get('task_1')).toMatchObject({ phase: 'interrupted', error: 'socket lost' });

    projection.append({ type: 'turn.started', taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_2' });
    projection.append({
      type: 'turn.completed', taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_2', status: 'failed',
      turn: { id: 'turn_2', status: 'failed', items: [], error: { message: 'model failed' } },
    });
    expect(projection.get('task_1')).toMatchObject({ phase: 'failed', error: 'model failed' });
  });

  it('projects context compaction and gives an explicit reset instruction on overflow', () => {
    const projection = new LiveTurnProjection();
    projection.append({ type: 'turn.started', taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_1' });
    projection.append({
      type: 'item.started', taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_1',
      item: { id: 'compact_1', type: 'contextCompaction' },
    });
    expect(projection.get('task_1')?.compacting).toBe(true);
    projection.append({
      type: 'item.completed', taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_1',
      item: { id: 'compact_1', type: 'contextCompaction' },
    });
    expect(projection.get('task_1')?.compacting).toBe(false);
    projection.append({
      type: 'turn.completed', taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_1', status: 'failed',
      turn: { error: { message: 'maximum context length exceeded after compaction' } },
    });
    expect(projection.get('task_1')?.error).toContain('/new --blank');
  });
});
