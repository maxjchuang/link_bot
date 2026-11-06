import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BotMemoryApprovalService } from '../../src/memory/BotMemoryApprovalService.js';
import {
  DREAM_MAINTENANCE_CAPABILITIES, DreamConsolidator, SqliteDreamAdmissionController, type DreamAdmissionController, type DreamModel,
} from '../../src/memory/DreamConsolidator.js';
import { MemoryService } from '../../src/memory/MemoryService.js';
import type { DreamJobRecord, DreamPatch } from '../../src/memory/MemoryTypes.js';
import { SqliteStateStore } from '../../src/state/SqliteStateStore.js';
import type { TaskContextRecord, TaskMembershipRecord, TaskRecord, TaskScopeRecord } from '../../src/tasks/TaskTypes.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('DreamConsolidator', () => {
  it('uses a tool-less maintenance context, redacts input, and commits memory/source/watermark atomically', async () => {
    const { store } = await harness();
    store.appendTurnEvent({
      eventKey: 'message_1', taskId: 'task_1', eventType: 'user.message',
      payload: { text: 'Keep retry bounded. api_key=super-secret-value', userId: 'alice@example.com' },
    });
    const job = saveJob(store);
    let observed = '';
    const model: DreamModel = { consolidate: async (input) => {
      expect(input.capabilities).toEqual(DREAM_MAINTENANCE_CAPABILITIES);
      expect(Object.values(input.capabilities).every((value) => value === false)).toBe(true);
      observed = input.events[0]!.text;
      return patch('message_1');
    } };
    const dream = new DreamConsolidator(store, model, allowAdmission(store));

    const result = await dream.runNext();
    expect(result).toMatchObject({ id: job.id, status: 'completed', watermarkSequence: 1 });
    expect(observed).not.toContain('super-secret-value');
    expect(observed).not.toContain('alice@example.com');
    expect(store.listMemoryEntries('task', 'task_1')).toHaveLength(2);
    const episode = store.listMemoryEntries('task', 'task_1').find((entry) => entry.kind === 'episode')!;
    expect(episode.status).toBe('active');
    expect(store.listMemorySources(episode.id)).toMatchObject([{ eventKey: 'message_1', taskId: 'task_1' }]);
    expect(store.dreamWatermark('task', 'task_1')).toBe(1);
    expect(store.getTask('task_1')?.lastUserInteractionAt).toBe(NOW);
    store.close();
  });

  it('does not call the model when a claimed job has no eligible events', async () => {
    const { store } = await harness();
    store.appendTurnEvent({ eventKey: 'delta', taskId: 'task_1', eventType: 'item.delta', payload: { text: 'noise' } });
    saveJob(store);
    let calls = 0;
    const dream = new DreamConsolidator(store, { consolidate: async () => { calls += 1; return patch('delta'); } }, allowAdmission(store));
    expect(await dream.runNext()).toMatchObject({ status: 'completed', watermarkSequence: 1 });
    expect(calls).toBe(0);
    store.close();
  });

  it('allows only one scheduler to claim a Dream and counts it against ACTIVE capacity', async () => {
    const { store } = await harness();
    store.appendTurnEvent({ eventKey: 'message_1', taskId: 'task_1', eventType: 'user.message', payload: { text: 'alpha' } });
    saveJob(store);
    let releaseModel!: () => void;
    const gate = new Promise<void>((resolve) => { releaseModel = resolve; });
    let calls = 0;
    const model: DreamModel = { consolidate: async () => { calls += 1; await gate; return patch('message_1'); } };
    const first = new DreamConsolidator(store, model, allowAdmission(store)).runNext();
    await Promise.resolve();
    const second = await new DreamConsolidator(store, model, allowAdmission(store)).runNext();
    expect(second).toBeUndefined();
    expect(activeLeases(store)).toBe(1);
    releaseModel();
    await first;
    expect(calls).toBe(1);
    expect(activeLeases(store)).toBe(0);
    store.close();
  });

  it('does not advance the watermark on failure or preemption and retries without duplicate memory', async () => {
    const { store } = await harness();
    store.appendTurnEvent({ eventKey: 'message_1', taskId: 'task_1', eventType: 'user.message', payload: { text: 'alpha' } });
    const job = saveJob(store);
    let attempts = 0;
    const model: DreamModel = { consolidate: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('model_unavailable');
      return patch('message_1');
    } };
    const dream = new DreamConsolidator(store, model, allowAdmission(store));
    expect(await dream.runNext()).toMatchObject({ status: 'failed' });
    expect(store.dreamWatermark('task', 'task_1')).toBe(0);
    expect(await dream.runNext()).toMatchObject({ status: 'completed', watermarkSequence: 1 });
    const memoryIds = store.listMemoryEntries('task', 'task_1').map((entry) => entry.id);
    expect(new Set(memoryIds).size).toBe(memoryIds.length);

    store.appendTurnEvent({ eventKey: 'message_2', taskId: 'task_1', eventType: 'user.message', payload: { text: 'beta' } });
    saveJob(store, '2026-07-29', 1);
    const preempt: DreamAdmissionController = { claim: () => true, shouldContinue: () => false, release: () => undefined };
    expect(await new DreamConsolidator(store, model, preempt).runNext()).toMatchObject({ status: 'interrupted' });
    expect(store.dreamWatermark('task', 'task_1')).toBe(1);
    expect(store.getDreamJob(job.id)).toMatchObject({ status: 'completed' });
    store.close();
  });

  it('defers under pressure or interactive load while preserving four-turn capacity', async () => {
    const { store } = await harness();
    store.appendTurnEvent({ eventKey: 'message_1', taskId: 'task_1', eventType: 'user.message', payload: { text: 'alpha' } });
    saveJob(store);
    store.claimActiveTurn('task_1', 'interactive_1', 4);
    store.claimActiveTurn('task_1', 'interactive_2', 4);
    const admission = new SqliteDreamAdmissionController(store, 4, 2);
    const dream = new DreamConsolidator(store, { consolidate: async () => patch('message_1') }, admission);
    expect(await dream.runNext()).toMatchObject({ status: 'deferred', lastErrorCode: 'admission_denied' });
    expect(activeLeases(store)).toBe(2);
    expect(store.claimActiveTurn('task_1', 'interactive_3', 4)).toBe(true);
    expect(store.claimActiveTurn('task_1', 'interactive_4', 4)).toBe(true);
    expect(store.claimActiveTurn('task_1', 'interactive_5', 4)).toBe(false);
    store.close();
  });

  it('keeps global output as redacted candidates and requires idempotent administrator confirmation', async () => {
    const { store } = await harness('legacy');
    store.appendTurnEvent({ eventKey: 'message_1', taskId: 'task_1', eventType: 'user.message', payload: { text: 'shared lesson' } });
    saveJob(store);
    const model: DreamModel = { consolidate: async () => ({
      ...patch('message_1'),
      globalCandidates: [{
        kind: 'lesson', title: 'Shared retry lesson', description: 'safe candidate',
        content: 'Use bounded retries. password=hunter2', sourceEventKeys: ['message_1'],
      }],
    }) };
    await new DreamConsolidator(store, model, allowAdmission(store), undefined, undefined, {
      batchMaxEvents: 100, batchMaxChars: 24_000, botId: 'linkbot', allowGlobalCandidates: true,
    }).runNext();
    const candidate = store.listMemoryEntries('bot', 'linkbot')[0]!;
    expect(candidate).toMatchObject({ status: 'candidate', visibility: 'bot' });
    expect(candidate.content).not.toContain('hunter2');
    expect(store.listMemorySources(candidate.id)).toEqual([]);

    const memory = new MemoryService(store, () => new Date(NOW));
    const approvals = new BotMemoryApprovalService(store, memory, ['ou_admin'], true);
    expect(() => approvals.confirm({ administratorId: 'ou_1', taskId: 'task_1', contextId: 'context_1', memoryId: candidate.id })).toThrow('administrator');
    store.saveTaskMembership(membership('task_1', 'ou_admin', 'administrator'));
    const confirmed = approvals.confirm({ administratorId: 'ou_admin', taskId: 'task_1', contextId: 'context_1', memoryId: candidate.id });
    expect(confirmed).toMatchObject({ status: 'active', version: 2 });
    expect(approvals.confirm({ administratorId: 'ou_admin', taskId: 'task_1', contextId: 'context_1', memoryId: candidate.id })).toEqual(confirmed);
    store.close();
  });

  it('persists bounded batch checkpoints and never skips events when the event budget is exhausted', async () => {
    const { store } = await harness();
    for (let index = 1; index <= 3; index += 1) {
      store.appendTurnEvent({ eventKey: `message_${index}`, taskId: 'task_1', eventType: 'user.message', payload: { text: `event ${index}` } });
    }
    saveJob(store);
    const seen: string[] = [];
    const model: DreamModel = { consolidate: async ({ events }) => {
      seen.push(...events.map((event) => event.eventKey));
      return patch(events[0]!.eventKey);
    } };
    const dream = new DreamConsolidator(store, model, allowAdmission(store), undefined, undefined, {
      batchMaxEvents: 1, batchMaxChars: 1_000,
    });
    expect(await dream.runNext()).toMatchObject({ status: 'deferred', watermarkSequence: 1, checkpoint: { nextEventSequence: 1 } });
    expect(await dream.runNext()).toMatchObject({ status: 'deferred', watermarkSequence: 2, checkpoint: { nextEventSequence: 2 } });
    expect(await dream.runNext()).toMatchObject({ status: 'completed', watermarkSequence: 3 });
    expect(seen).toEqual(['message_1', 'message_2', 'message_3']);
    expect(store.listMemoryEntries('task', 'task_1')).toHaveLength(6);
    store.close();
  });

  it('rejects forged source references before writing memory or advancing the watermark', async () => {
    const { store } = await harness();
    store.appendTurnEvent({ eventKey: 'message_1', taskId: 'task_1', eventType: 'user.message', payload: { text: 'alpha' } });
    saveJob(store);
    const bad: DreamModel = { consolidate: async () => patch('message_from_another_task') };
    expect(await new DreamConsolidator(store, bad, allowAdmission(store)).runNext()).toMatchObject({
      status: 'failed', lastErrorCode: 'invalid_dream_source',
    });
    expect(store.listMemoryEntries('task', 'task_1')).toEqual([]);
    expect(store.dreamWatermark('task', 'task_1')).toBe(0);
    store.close();
  });
});

const NOW = '2026-07-28T06:00:00.000Z';

async function harness(scope: TaskScopeRecord['scope'] = 'private') {
  const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'), () => new Date(NOW));
  store.saveTask(task());
  store.saveTaskMembership(membership('task_1', 'ou_1', 'owner'));
  store.saveTaskContext(context());
  store.saveTaskScope({
    taskId: 'task_1', scope, scopeKey: `${scope}:task_1`, status: scope === 'legacy' ? 'legacy' : 'canonical',
    ...(scope === 'private' ? { privateUserId: 'ou_1' } : {}), createdAt: NOW, updatedAt: NOW,
  });
  return { store };
}

function saveJob(store: SqliteStateStore, date = '2026-07-28', fromEventSequence = 0): DreamJobRecord {
  const job: DreamJobRecord = {
    id: `dream:task:task_1:${date}`, scope: 'task', scopeId: 'task_1', businessDate: date,
    status: 'pending', fromEventSequence, attemptCount: 0, createdAt: NOW, updatedAt: NOW,
  };
  store.createDreamJob(job);
  return job;
}

function patch(source: string): DreamPatch {
  return {
    episode: { kind: 'episode', title: 'Nightly summary', description: 'A bounded summary', content: 'Discussed bounded retries.', sourceEventKeys: [source] },
    candidates: [{ kind: 'lesson', title: 'Retry lesson', description: 'Candidate retry guidance', content: 'Prefer bounded retries.', sourceEventKeys: [source] }],
  };
}

function allowAdmission(store: SqliteStateStore): DreamAdmissionController {
  return new SqliteDreamAdmissionController(store, 4, 2);
}

function activeLeases(store: SqliteStateStore): number {
  return (store.db.prepare("SELECT COUNT(*) AS count FROM runtime_leases WHERE lease_type='active_turn' AND status='active'").get() as { count: number }).count;
}

function task(): TaskRecord {
  return {
    id: 'task_1', ownerUserId: 'ou_1', projectId: 'repo', baseRef: 'main', branchName: 'codex/ou_1/task_1',
    runtimeState: 'hot', pinned: false, lastUserInteractionAt: NOW, createdAt: NOW, updatedAt: NOW,
  };
}

function context(): TaskContextRecord {
  return { id: 'context_1', taskId: 'task_1', codexThreadId: 'thread_1', state: 'active', createdBy: 'system', createdAt: NOW, updatedAt: NOW };
}

function membership(taskId: string, userId: string, role: TaskMembershipRecord['role']): TaskMembershipRecord {
  return { id: `membership:${taskId}:${userId}`, taskId, userId, role, status: 'active', createdAt: NOW, updatedAt: NOW };
}
