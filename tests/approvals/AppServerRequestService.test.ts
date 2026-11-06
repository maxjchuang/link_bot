import { describe, expect, it, vi } from 'vitest';
import { AppServerRequestService } from '../../src/approvals/AppServerRequestService.js';
import type { AppServerRequestRecord } from '../../src/approvals/AppServerRequestTypes.js';
import type { BackendTask, CodexBackend, CodexBackendEvent, InterruptTurnInput, RespondServerRequestInput, ResumeTaskInput, StartTaskInput, StartTurnInput, SteerTurnInput, ThreadSnapshot } from '../../src/backends/CodexBackend.js';
import { FileStateStore } from '../../src/state/FileStateStore.js';
import type { TaskRecord, TurnRecord } from '../../src/tasks/TaskTypes.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('AppServerRequestService', () => {
  it('publishes preparation, submission and response failure separately and isolates view failures', async () => {
    const h = await createHarness();
    const changes: AppServerRequestRecord[] = [];
    h.service.subscribe((request) => { changes.push(request); });
    h.service.subscribe(() => { throw new Error('view failed'); });
    const request = await h.service.capture(serverRequest({ requestId: 7 }));
    expect(changes.at(-1)).toMatchObject({ status: 'pending', localTurnId: 'turn_1' });
    expect(changes.at(-1)?.operationCard).toBeUndefined();
    const respond = vi.spyOn(h.backend, 'respondToServerRequest').mockRejectedValueOnce(new Error('transport failed'));
    await expect(h.service.decide({ requestId: request.id, userId: 'ou_owner', generation: 1, decision: 'allow' })).rejects.toThrow('transport failed');
    expect(changes.slice(-2)).toMatchObject([{ status: 'decided', responseState: 'submitting' }, { status: 'decided', responseState: 'failed' }]);
    respond.mockRestore();
    await h.service.decide({ requestId: request.id, userId: 'ou_owner', generation: 1, decision: 'allow' });
    expect(changes.at(-1)).toMatchObject({ status: 'delivered', responseState: 'delivered' });
    h.service.dispose();
  });

  it('resolves only a matching live request and ignores reused ids from other generations', async () => {
    const h = await createHarness();
    const request = await h.service.capture(serverRequest({ requestId: 7 }));
    await h.service.resolve({ type: 'backend.server_request_resolved', taskId: 'task_1', threadId: 'thread_1', generation: 2, requestId: 7 });
    expect((await h.store.getAppServerRequest(request.id))?.status).toBe('pending');
    await h.service.resolve({ type: 'backend.server_request_resolved', taskId: 'task_1', threadId: 'thread_1', generation: 1, requestId: 7 });
    expect((await h.store.getAppServerRequest(request.id))?.status).toBe('resolved');
    expect((await h.service.decide({ requestId: request.id, userId: 'ou_owner', generation: 1, decision: 'allow' })).accepted).toBe(false);
    h.service.dispose();
  });

  it('expires undelivered requests proactively and invalidates terminal turn approvals', async () => {
    vi.useFakeTimers();
    const h = await createHarness();
    try {
      const changes: AppServerRequestRecord[] = [];
      h.service.subscribe((request) => { changes.push(request); });
      const first = await h.service.capture(serverRequest());
      h.now += 60000;
      await vi.advanceTimersByTimeAsync(60000);
      expect((await h.store.getAppServerRequest(first.id))!.status).toBe('expired');
      expect(changes.at(-1)!.status).toBe('expired');
      const second = await h.service.capture(serverRequest({ requestId: 'second' }));
      await h.service.closeTurn('task_1', 'turn_1');
      expect((await h.store.getAppServerRequest(second.id))!.status).toBe('resolved');
    } finally { h.service.dispose(); vi.useRealTimers(); }
  });

  it('keeps a real request pending when operation-card rendering fails without failing execution', async () => {
    const h = await createHarness();
    h.render.mockRejectedValueOnce(new Error('render failed'));
    try {
      const request = await h.service.capture(serverRequest());
      expect(request.status).toBe('pending');
      expect((await h.store.getAppServerRequest(request.id))?.operationCard?.status).toBe('failed');
    } finally { h.service.dispose(); }
  });
  it('persists an approval before rendering and deduplicates repeated server events', async () => {
    const harness = await createHarness();
    let persistedBeforeRender = false;
    harness.render.mockImplementation(async (request) => {
      persistedBeforeRender = Boolean(await harness.store.getAppServerRequest(request.id));
    });

    const first = await harness.service.capture(serverRequest());
    const duplicate = await harness.service.capture(serverRequest());

    expect(persistedBeforeRender).toBe(true);
    expect(duplicate.id).toBe(first.id);
    expect(harness.render).toHaveBeenCalledTimes(1);
    await expect(harness.store.getTurn('turn_1')).resolves.toMatchObject({ state: 'waiting_approval' });
  });

  it('does not collide when a restarted connection reuses its generation and request id for another turn', async () => {
    const harness = await createHarness();
    const first = await harness.service.capture(serverRequest());
    await harness.store.saveTurn({
      ...turnRecord(), id: 'turn_2', codexTurnId: 'turn_2',
      createdAt: '2026-07-28T01:01:00.000Z', updatedAt: '2026-07-28T01:01:00.000Z',
    });
    await harness.store.saveTask({ ...taskRecord(), activeTurnId: 'turn_2' });

    const restarted = await harness.service.capture(serverRequest({
      params: { threadId: 'thread_1', turnId: 'turn_2', command: 'git status' },
    }));

    expect(restarted.id).not.toBe(first.id);
    expect(harness.render).toHaveBeenCalledTimes(2);
    await expect(harness.store.getTurn('turn_2')).resolves.toMatchObject({ state: 'waiting_approval' });
  });

  it('enforces owner, expiry, and idempotent allow and deny callbacks', async () => {
    const harness = await createHarness();
    const allow = await harness.service.capture(serverRequest({ requestId: 'allow_1' }));
    await expect(harness.service.decide({
      requestId: allow.id, userId: 'ou_other', generation: 1, decision: 'allow',
    })).resolves.toMatchObject({ accepted: false, reason: 'identity_mismatch' });
    await expect(harness.service.decide({
      requestId: allow.id, userId: 'ou_owner', generation: 1, decision: 'allow',
    })).resolves.toMatchObject({ accepted: true, duplicate: false, request: { status: 'delivered' } });
    await expect(harness.service.decide({
      requestId: allow.id, userId: 'ou_owner', generation: 1, decision: 'allow',
    })).resolves.toMatchObject({ accepted: true, duplicate: true, request: { status: 'delivered' } });
    expect(harness.backend.responses).toEqual([
      expect.objectContaining({ requestId: 'allow_1', result: { decision: 'accept' } }),
    ]);

    const deny = await harness.service.capture(serverRequest({ requestId: 'deny_1' }));
    await harness.service.decide({ requestId: deny.id, userId: 'ou_owner', generation: 1, decision: 'deny' });
    expect(harness.backend.responses.at(-1)?.result).toEqual({ decision: 'decline' });

    harness.now += 2_000;
    const expired = await harness.service.capture(serverRequest({ requestId: 'expired_1' }));
    harness.now += 61_000;
    await expect(harness.service.decide({
      requestId: expired.id, userId: 'ou_owner', generation: 1, decision: 'allow',
    })).resolves.toMatchObject({ accepted: false, reason: 'expired', request: { status: 'expired' } });
  });

  it('answers user-input requests and rejects callbacks from another generation', async () => {
    const harness = await createHarness();
    const request = await harness.service.capture(serverRequest({
      requestId: 'input_1', method: 'item/tool/requestUserInput',
      params: { threadId: 'thread_1', turnId: 'turn_1', questions: [{ id: 'scope' }] },
    }));

    await expect(harness.service.decide({
      requestId: request.id, userId: 'ou_owner', generation: 2, decision: 'answer', answers: { scope: ['tests'] },
    })).resolves.toMatchObject({ accepted: false, reason: 'generation_mismatch' });
    await harness.service.decide({
      requestId: request.id, userId: 'ou_owner', generation: 1, decision: 'answer', answers: { scope: ['tests'] },
    });
    expect(harness.backend.responses).toEqual([
      expect.objectContaining({ requestId: 'input_1', result: { answers: { scope: { answers: ['tests'] } } } }),
    ]);
  });

  it('binds a collaborative approval to the user who created the active turn', async () => {
    const harness = await createHarness();
    await harness.store.saveTask({ ...taskRecord(), activeTurnId: 'turn_1' });
    await harness.store.saveTurn({ ...turnRecord(), createdBy: 'ou_member' });

    const request = await harness.service.capture(serverRequest({ requestId: 'member_approval' }));

    expect(request.ownerUserId).toBe('ou_member');
    await expect(harness.service.decide({
      requestId: request.id, userId: 'ou_member', generation: 1, decision: 'allow',
    })).resolves.toMatchObject({ accepted: true });
  });

  it('serializes concurrent duplicate callbacks and sends one protocol response', async () => {
    const harness = await createHarness();
    const request = await harness.service.capture(serverRequest({ requestId: 'concurrent_1' }));

    const results = await Promise.all([
      harness.service.decide({ requestId: request.id, userId: 'ou_owner', generation: 1, decision: 'allow' }),
      harness.service.decide({ requestId: request.id, userId: 'ou_owner', generation: 1, decision: 'allow' }),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ accepted: true, duplicate: false }),
      expect.objectContaining({ accepted: true, duplicate: true }),
    ]);
    expect(harness.backend.responses).toHaveLength(1);
  });
});

async function createHarness() {
  let now = +new Date('2026-07-28T02:00:00.000Z');
  const clock = () => new Date(now);
  const store = new FileStateStore(await createTmpDir(), clock);
  await store.saveTask(taskRecord());
  await store.saveTurn(turnRecord());
  const backend = new RequestBackend();
  const render = vi.fn<(request: AppServerRequestRecord) => Promise<void>>(async () => undefined);
  const service = new AppServerRequestService(store, backend, { render }, 60_000, clock);
  return {
    store, backend, render, service,
    get now() { return now; },
    set now(value: number) { now = value; },
  };
}

function serverRequest(overrides: Partial<Extract<CodexBackendEvent, { type: 'backend.server_request' }>> = {}): Extract<CodexBackendEvent, { type: 'backend.server_request' }> {
  return {
    type: 'backend.server_request', taskId: 'task_1', generation: 1, requestId: 'approval_1',
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread_1', turnId: 'turn_1', command: 'npm test' },
    ...overrides,
  };
}

function taskRecord(): TaskRecord {
  return {
    id: 'task_1', ownerUserId: 'ou_owner', projectId: 'repo', baseRef: 'main', branchName: 'task-1',
    runtimeState: 'hot', codexThreadId: 'thread_1', pinned: false,
    lastUserInteractionAt: '2026-07-28T01:00:00.000Z', createdAt: '2026-07-28T01:00:00.000Z', updatedAt: '2026-07-28T01:00:00.000Z',
  };
}

function turnRecord(): TurnRecord {
  return {
    id: 'turn_1', taskId: 'task_1', codexTurnId: 'turn_1', state: 'running', prompt: 'test', createdBy: 'ou_owner',
    createdAt: '2026-07-28T01:00:00.000Z', updatedAt: '2026-07-28T01:00:00.000Z',
  };
}

class RequestBackend implements CodexBackend {
  readonly responses: RespondServerRequestInput[] = [];
  async healthCheck(): Promise<{ ok: true }> { return { ok: true }; }
  async startTask(input: StartTaskInput): Promise<BackendTask> { return { taskId: input.taskId }; }
  async resumeTask(input: ResumeTaskInput): Promise<BackendTask> { return { taskId: input.taskId }; }
  async startTurn(_input: StartTurnInput): Promise<void> {}
  async steerTurn(_input: SteerTurnInput): Promise<void> {}
  async interruptTurn(_input: InterruptTurnInput): Promise<void> {}
  async respondToServerRequest(input: RespondServerRequestInput): Promise<void> { this.responses.push(input); }
  async stopTask(): Promise<void> {}
  async readThread(taskId: string): Promise<ThreadSnapshot> { return { taskId, items: [] }; }
  async *events(): AsyncIterable<CodexBackendEvent> {}
}
