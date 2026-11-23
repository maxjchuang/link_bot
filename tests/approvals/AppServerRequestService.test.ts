import { describe, expect, it, vi } from 'vitest';
import { AppServerRequestService } from '../../src/approvals/AppServerRequestService.js';
import type { AppServerRequestRecord } from '../../src/approvals/AppServerRequestTypes.js';
import type { BackendTask, CodexBackend, CodexBackendEvent, InterruptTurnInput, RespondServerRequestInput, ResumeTaskInput, StartTaskInput, StartTurnInput, SteerTurnInput, ThreadSnapshot } from '../../src/backends/CodexBackend.js';
import { FileStateStore } from '../../src/state/FileStateStore.js';
import type { TaskRecord, TurnRecord } from '../../src/tasks/TaskTypes.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('AppServerRequestService', () => {
  it('atomically consumes an owner ticket under concurrent new native requests', async () => {
    const h = await createHarness(true);
    h.service.setOwnerContinuation({suspend: async () => undefined, resume: async () => undefined});
    try {
      const ticket = await h.service.capture(serverRequest());
      await h.service.decide({requestId: ticket.id, userId: 'ou_owner', generation: 1, decision: 'allow'});
      await h.store.updateAppServerRequest(ticket.id, current => ({...current,
        continuation: {...current.continuation!, state: 'submitted', resumedLocalTurnId: 'turn_1'}}));
      await Promise.all(['new-a', 'new-b'].map(requestId => h.service.capture(serverRequest({requestId, generation: 2}))));
      expect(h.backend.responses.filter(response => (response.result as {decision?: string}).decision === 'accept')).toHaveLength(1);
    } finally {h.service.dispose();}
  });
  it('does not auto-resume a file approval without a complete patch, but cancels the native blocker', async () => {
    const h = await createHarness(true);
    const suspend = vi.fn(async () => undefined), resume = vi.fn(async () => undefined);
    h.service.setOwnerContinuation({suspend, resume});
    try {
      const request = await h.service.capture(serverRequest({method: 'item/fileChange/requestApproval',
        params: {threadId: 'thread_1', turnId: 'turn_1', grantRoot: '/workspace'}}));
      expect(request.continuation).toMatchObject({state: 'waiting', replayable: false});
      expect(suspend).toHaveBeenCalledOnce();
      expect(h.backend.responses.at(-1)?.result).toEqual({decision: 'decline'});
      await expect(h.service.decide({requestId: request.id, userId: 'ou_owner', generation: 1, decision: 'allow'})).rejects.toThrow('snapshot');
      expect(resume).not.toHaveBeenCalled();
    } finally {h.service.dispose();}
  });
  it('cancels native user-input waiting and delivers owner answers as a new scoped continuation', async () => {
    const h = await createHarness(true);
    const resume = vi.fn(async () => undefined);
    h.service.setOwnerContinuation({suspend: async () => undefined, resume});
    try {
      const request = await h.service.capture(serverRequest({method: 'item/tool/requestUserInput',
        params: {threadId: 'thread_1', turnId: 'turn_1', questions: [{id: 'scope', question: 'Scope?', options: [{label: 'tests', description: 'Tests'}]}]}}));
      expect(h.backend.responses.at(-1)?.result).toEqual({answers: {}});
      await h.service.decide({requestId: request.id, userId: 'ou_owner', generation: 1, decision: 'answer', answers: {scope: ['tests']}});
      expect(resume).toHaveBeenCalledWith(expect.objectContaining({decision: 'answer', answers: {scope: ['tests']}}));
      expect(h.backend.responses).toHaveLength(1);
    } finally {h.service.dispose();}
  });
  it('keeps uncertain native cancellation non-replayable across recovery', async () => {
    const h = await createHarness(true);
    const resume = vi.fn(async () => undefined);
    h.service.setOwnerContinuation({suspend: async () => {throw new Error('timeout');}, resume});
    try {
      await expect(h.service.capture(serverRequest())).rejects.toThrow('unknown');
      const request = (await h.store.listPendingAppServerRequests())[0];
      expect(request.continuation?.state).toBe('unknown');
      await h.service.recover();
      expect(resume).not.toHaveBeenCalled();
      expect(await h.service.decide({requestId: request.id, userId: 'ou_owner', generation: 1, decision: 'allow'}))
        .toMatchObject({accepted: false, reason: 'not_pending'});
    } finally {h.service.dispose();}
  });
  it('cancels a native command before waiting for the owner and consumes only the exact new-turn operation once', async () => {
    const h = await createHarness(true);
    const suspend = vi.fn(async () => undefined);
    const resume = vi.fn(async () => undefined);
    h.service.setOwnerContinuation({suspend, resume});
    try {
      const request = await h.service.capture(serverRequest());
      expect(request.continuation?.state).toBe('waiting');
      expect(h.backend.responses).toMatchObject([{requestId: 'approval_1', result: {decision: 'decline'}}]);
      expect(suspend).toHaveBeenCalledOnce();
      // Only a real terminal transition releases the source turn.
      await h.store.updateTask('task_1', current => ({...current, activeTurnId: undefined}));
      await h.store.updateTurn('turn_1', current => ({...current, state: 'interrupted'}));
      await h.service.closeTurn('task_1', 'turn_1');
      expect((await h.store.getAppServerRequest(request.id))?.status).toBe('pending');
      await h.service.decide({requestId: request.id, userId: 'ou_owner', generation: 1, decision: 'allow'});
      expect(resume).toHaveBeenCalledOnce();
      expect(h.backend.responses).toHaveLength(1); // Never accept the old RPC.
      await h.store.saveTurn({...turnRecord(), id: 'turn_2', codexTurnId: 'turn_2', createdBy: 'ou_requester', groupServiceVersion: 1});
      await h.store.updateTask('task_1', current => ({...current, activeTurnId: 'turn_2'}));
      await h.store.updateAppServerRequest(request.id, current => ({...current,
        continuation: {...current.continuation!, state: 'submitted', resumedLocalTurnId: 'turn_2'}}));
      const next = await h.service.capture(serverRequest({generation: 2, requestId: 'new_rpc',
        params: {threadId: 'thread_1', turnId: 'turn_2', command: 'npm test'}}));
      expect(next.status).toBe('delivered');
      expect(h.backend.responses.at(-1)).toMatchObject({generation: 2, requestId: 'new_rpc', result: {decision: 'accept'}});
      expect((await h.store.getAppServerRequest(request.id))?.continuation?.state).toBe('consumed');
      // Another native request cannot consume the same approval.
      await h.service.capture(serverRequest({generation: 2, requestId: 'duplicate_rpc',
        params: {threadId: 'thread_1', turnId: 'turn_2', command: 'npm test'}}));
      expect(h.backend.responses.at(-1)?.result).toEqual({decision: 'decline'});
    } finally {h.service.dispose();}
  });

  it('does not use owner approval for changed command arguments or a different local turn', async () => {
    const h = await createHarness(true);
    h.service.setOwnerContinuation({suspend: async () => undefined, resume: async () => undefined});
    try {
      const request = await h.service.capture(serverRequest());
      await h.service.decide({requestId: request.id, userId: 'ou_owner', generation: 1, decision: 'allow'});
      await h.store.updateAppServerRequest(request.id, current => ({...current,
        continuation: {...current.continuation!, state: 'submitted', resumedLocalTurnId: 'turn_1'}}));
      await h.service.capture(serverRequest({requestId: 'changed-command',
        params: {threadId: 'thread_1', turnId: 'turn_1', command: 'npm publish'}}));
      expect(h.backend.responses.map(response => response.result)).toEqual([{decision: 'decline'}, {decision: 'decline'}]);
    } finally {h.service.dispose();}
  });
  it.each(['item/commandExecution/requestApproval','item/tool/requestUserInput'])(
    'assigns unclassified native personal-agent requests to the owner, not the requester: %s', async method => {
      const h = await createHarness(true); try {
        const request = await h.service.capture(serverRequest({method}));
        expect(request).toMatchObject({purpose: 'owner_authorization', ownerUserId: 'ou_owner',
          requesterUserId: 'ou_requester', groupServiceVersion: 1, sourceAudience: {chatId: 'oc_group', chatType: 'group'}});
        expect(request.operationSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
        expect(await h.service.decide({requestId: request.id, userId: 'ou_requester', generation: 1,
          decision: method.endsWith('requestUserInput') ? 'answer' : 'allow',
          ...(method.endsWith('requestUserInput') ? {answers: {scope: ['tests']}} : {})})).toMatchObject({accepted: false, reason: 'identity_mismatch'});
        expect(h.backend.responses).toHaveLength(0);
      } finally {h.service.dispose();}
    });
  it('rechecks group qualification and exact operation snapshot before owner approval', async () => {
    const h = await createHarness(true); try {
      const request = await h.service.capture(serverRequest());
      h.qualificationCurrent = false;
      await expect(h.service.decide({requestId: request.id, userId: 'ou_owner', generation: 1, decision: 'allow'})).rejects.toThrow('qualification');
      h.qualificationCurrent = true;
      await h.store.updateAppServerRequest(request.id, current => ({...current, payload: {command: 'different operation'}}));
      await expect(h.service.decide({requestId: request.id, userId: 'ou_owner', generation: 1, decision: 'allow'})).rejects.toThrow('changed');
      expect(h.backend.responses).toHaveLength(0);
    } finally {h.service.dispose();}
  });
  it('delivers a verified owner decision once without rewriting the requester', async () => {
    const h = await createHarness(true); try {
      const request = await h.service.capture(serverRequest());
      expect(await h.service.decide({requestId: request.id, userId: 'ou_owner', generation: 1, decision: 'allow'}))
        .toMatchObject({accepted: true});
      expect(h.backend.responses).toHaveLength(1);
      expect(await h.store.getTurn('turn_1')).toMatchObject({createdBy: 'ou_requester'});
    } finally {h.service.dispose();}
  });
  it('characterizes that delivering a denial alone does not finish the active turn', async () => {
    const h = await createHarness();
    try {
      const request = await h.service.capture(serverRequest());
      await h.service.decide({requestId: request.id, userId: 'ou_owner', generation: 1, decision: 'deny'});
      expect(h.backend.responses).toHaveLength(1);
      expect(h.backend.responses[0].result).toEqual({decision: 'decline'});
      await expect(h.store.getAppServerRequest(request.id)).resolves.toMatchObject({status: 'delivered'});
      await expect(h.store.getTask('task_1')).resolves.toMatchObject({activeTurnId: 'turn_1', pinned: true});
      await expect(h.store.getTurn('turn_1')).resolves.toMatchObject({state: 'waiting_approval'});
    } finally { h.service.dispose(); }
  });

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

async function createHarness(personalAgent = false) {
  let now = +new Date('2026-07-28T02:00:00.000Z');
  const clock = () => new Date(now);
  const store = new FileStateStore(await createTmpDir(), clock);
  await store.saveTask({...taskRecord(), ...(personalAgent ? {identityMode: 'personal-agent' as const,
    agentOwnerUserId: 'ou_owner', runtimeMode: 'user-sandbox' as const, activeTurnId: 'turn_1'} : {})});
  await store.saveTurn({...turnRecord(), ...(personalAgent ? {createdBy: 'ou_requester', groupServiceVersion: 1} : {})});
  const backend = new RequestBackend();
  const render = vi.fn<(request: AppServerRequestRecord) => Promise<void>>(async () => undefined);
  let qualificationCurrent = true;
  const service = new AppServerRequestService(store, backend, { render }, 60_000, clock, personalAgent ? () => {
    if (!qualificationCurrent) throw new Error('Group qualification revoked.');
    return {mode: 'personal-agent', agentId: 'agent_test', agentOwnerUserId: 'ou_owner', requesterUserId: 'ou_requester',
      audience: {chatId: 'oc_group', chatType: 'group'}, groupServiceVersion: 1};
  } : undefined);
  return {
    store, backend, render, service,
    get qualificationCurrent() {return qualificationCurrent;},
    set qualificationCurrent(value: boolean) {qualificationCurrent = value;},
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
