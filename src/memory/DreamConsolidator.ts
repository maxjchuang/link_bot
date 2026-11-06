import { createHash } from 'node:crypto';
import type { TaskPlatformDiagnostics } from '../observability/TaskPlatformDiagnostics.js';
import type { SqliteStateStore } from '../state/SqliteStateStore.js';
import type { MemoryProjectionService } from './MemoryProjectionService.js';
import type { DreamJobRecord, DreamMemoryProposal, DreamPatch, MemoryEntryRecord, MemorySourceRecord } from './MemoryTypes.js';
import { redactSensitive, sanitizeDreamEvents, type SanitizedDreamEvent } from './DreamEventPolicy.js';

export const DREAM_MAINTENANCE_CAPABILITIES = Object.freeze({
  shell: false, network: false, workspaceRead: false, workspaceWrite: false,
  approval: false, publish: false, mutableMemory: false,
});

export interface DreamModel {
  consolidate(input: {
    jobId: string;
    taskId: string;
    events: SanitizedDreamEvent[];
    capabilities: typeof DREAM_MAINTENANCE_CAPABILITIES;
  }): Promise<DreamPatch>;
}

export interface DreamAdmissionController {
  claim(taskId: string, leaseId: string): Promise<boolean> | boolean;
  shouldContinue(taskId: string, leaseId: string): Promise<boolean> | boolean;
  release(leaseId: string): Promise<void> | void;
}

export interface DreamConsolidatorConfig {
  batchMaxEvents: number;
  batchMaxChars: number;
  botId?: string;
  allowGlobalCandidates?: boolean;
}

export class DreamConsolidator {
  constructor(
    private readonly store: SqliteStateStore,
    private readonly model: DreamModel,
    private readonly admission: DreamAdmissionController,
    private readonly projections?: MemoryProjectionService,
    private readonly diagnostics?: TaskPlatformDiagnostics,
    private readonly config: DreamConsolidatorConfig = { batchMaxEvents: 100, batchMaxChars: 24_000 },
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (!Number.isInteger(config.batchMaxEvents) || config.batchMaxEvents <= 0) throw new Error('Dream batchMaxEvents must be positive.');
    if (!Number.isInteger(config.batchMaxChars) || config.batchMaxChars < 1_000) throw new Error('Dream batchMaxChars must be at least 1000.');
  }

  async runNext(): Promise<DreamJobRecord | undefined> {
    const job = this.store.claimNextDreamJob();
    if (!job) return undefined;
    const leaseId = `dream:${job.id}:${job.attemptCount}`;
    if (!await this.admission.claim(job.scopeId, leaseId)) return this.defer(job, 'admission_denied');
    try {
      return await this.runClaimed(job, leaseId);
    } catch (error) {
      if (errorCode(error) === 'maintenance_interrupted') return this.interrupt(job, 'interactive_preemption');
      const now = this.clock().toISOString();
      const failed: DreamJobRecord = {
        ...job, status: 'failed', lastErrorCode: errorCode(error), updatedAt: now,
        checkpoint: { ...(job.checkpoint ?? {}), failureAt: now },
      };
      this.store.updateDreamJob(failed, 'running');
      this.diagnostics?.audit('dream.failed', { jobId: job.id, taskId: job.scopeId, error: errorCode(error) });
      return failed;
    } finally {
      await this.admission.release(leaseId);
    }
  }

  private async runClaimed(job: DreamJobRecord, leaseId: string): Promise<DreamJobRecord> {
    if (job.scope !== 'task') throw new Error('unsupported_dream_scope');
    const after = job.watermarkSequence ?? job.fromEventSequence;
    const rawEvents = this.store.listTurnEventsAfter(job.scopeId, after, this.config.batchMaxEvents + 1);
    const batchRaw = rawEvents.slice(0, this.config.batchMaxEvents);
    const events = sanitizeDreamEvents(batchRaw, this.config.batchMaxChars);
    if (events.length === 0) return this.completeWithoutModel(job, batchRaw.at(-1)?.sequence ?? after);
    if (!await this.admission.shouldContinue(job.scopeId, leaseId)) return this.interrupt(job, 'interactive_preemption');

    const patch = validatePatch(await this.model.consolidate({
      jobId: job.id, taskId: job.scopeId, events, capabilities: DREAM_MAINTENANCE_CAPABILITIES,
    }), new Set(events.map((event) => event.eventKey)));
    if (!await this.admission.shouldContinue(job.scopeId, leaseId)) return this.interrupt(job, 'interactive_preemption');

    const now = this.clock().toISOString();
    const lastSequence = events.at(-1)?.sequence ?? batchRaw.at(-1)?.sequence ?? after;
    const hasMore = rawEvents.length > this.config.batchMaxEvents || lastSequence < (batchRaw.at(-1)?.sequence ?? lastSequence);
    const records = this.recordsForPatch(job, patch, now);
    const next: DreamJobRecord = {
      ...job, status: hasMore ? 'deferred' : 'completed', toEventSequence: lastSequence,
      watermarkSequence: lastSequence, checkpoint: hasMore ? { nextEventSequence: lastSequence } : undefined,
      updatedAt: now, ...(hasMore ? {} : { completedAt: now }),
    };
    this.store.db.transaction(() => {
      for (const memory of records.memories) if (!this.store.getMemoryEntry(memory.id)) this.store.saveMemoryEntry(memory);
      for (const source of records.sources) this.store.saveMemorySource(source);
      if (!this.store.updateDreamJob(next, 'running')) throw new Error('dream_job_claim_lost');
    })();
    if (this.projections) {
      try {
        await this.projections.rebuild(job.scopeId);
      } catch (error) {
        this.diagnostics?.audit('dream.projection_failed', { jobId: job.id, taskId: job.scopeId, error: errorCode(error) });
      }
    }
    this.diagnostics?.audit('dream.batch_committed', {
      jobId: job.id, taskId: job.scopeId, events: events.length, memories: records.memories.length,
      watermark: lastSequence, completed: !hasMore,
    }, `dream.batch:${job.id}:${lastSequence}`);
    return next;
  }

  private recordsForPatch(job: DreamJobRecord, patch: DreamPatch, now: string): { memories: MemoryEntryRecord[]; sources: MemorySourceRecord[] } {
    const taskScope = this.store.getTaskScope(job.scopeId);
    const pairs: Array<{ proposal: DreamMemoryProposal; memory: MemoryEntryRecord }> = [];
    const proposals = [...(patch.episode ? [patch.episode] : []), ...patch.candidates];
    proposals.forEach((proposal, index) => pairs.push({
      proposal,
      memory: memoryRecord(job, proposal, index, 'task', job.scopeId, index === 0 && patch.episode === proposal ? 'active' : 'candidate', now),
    }));
    if (this.config.allowGlobalCandidates && this.config.botId && taskScope?.status === 'legacy') {
      for (const [index, proposal] of (patch.globalCandidates ?? []).entries()) {
        pairs.push({ proposal, memory: memoryRecord(job, proposal, 10_000 + index, 'bot', this.config.botId, 'candidate', now) });
      }
    }
    const memories = pairs.map(({ memory }) => memory);
    const contextId = this.store.getActiveTaskContext(job.scopeId)?.id;
    const sources = pairs.flatMap(({ memory, proposal }) => {
      return proposal.sourceEventKeys.map((eventKey) => ({
        id: `source:${memory.id}:${digest(eventKey)}`, memoryId: memory.id, taskId: job.scopeId,
        ...(contextId ? { contextId } : {}), eventKey, createdAt: now,
      } satisfies MemorySourceRecord));
    });
    return { memories, sources };
  }

  private completeWithoutModel(job: DreamJobRecord, watermark: number): DreamJobRecord {
    const now = this.clock().toISOString();
    const completed: DreamJobRecord = {
      ...job, status: 'completed', toEventSequence: watermark, watermarkSequence: watermark,
      updatedAt: now, completedAt: now,
    };
    if (!this.store.updateDreamJob(completed, 'running')) throw new Error('dream_job_claim_lost');
    return completed;
  }

  private defer(job: DreamJobRecord, code: string): DreamJobRecord {
    const deferred = { ...job, status: 'deferred' as const, lastErrorCode: code, updatedAt: this.clock().toISOString() };
    this.store.updateDreamJob(deferred, 'running');
    return deferred;
  }

  private interrupt(job: DreamJobRecord, code: string): DreamJobRecord {
    const interrupted = { ...job, status: 'interrupted' as const, lastErrorCode: code, updatedAt: this.clock().toISOString() };
    this.store.updateDreamJob(interrupted, 'running');
    return interrupted;
  }
}

export class SqliteDreamAdmissionController implements DreamAdmissionController {
  constructor(
    private readonly store: SqliteStateStore,
    private readonly maxActiveTurns = 4,
    private readonly maxInteractiveActiveTurns = 2,
    private readonly underResourcePressure: () => Promise<boolean> = async () => false,
  ) {}

  async claim(taskId: string, leaseId: string): Promise<boolean> {
    if (this.store.getTask(taskId)?.runtimeState !== 'hot') return false;
    if (await this.underResourcePressure()) return false;
    if (this.interactiveCount() >= this.maxInteractiveActiveTurns) return false;
    return this.store.claimActiveTurn(taskId, leaseId, this.maxActiveTurns);
  }

  async shouldContinue(taskId: string): Promise<boolean> {
    return !this.store.getTask(taskId)?.activeTurnId && !await this.underResourcePressure();
  }

  release(leaseId: string): void {
    this.store.releaseActiveTurn(leaseId);
  }

  private interactiveCount(): number {
    return (this.store.db.prepare(`
      SELECT COUNT(*) AS count FROM runtime_leases
      WHERE lease_type='active_turn' AND status='active' AND id NOT LIKE 'active-turn:dream:%'
    `).get() as { count: number }).count;
  }
}

function validatePatch(patch: DreamPatch, allowedSources: Set<string>): DreamPatch {
  if (!patch || typeof patch !== 'object' || !Array.isArray(patch.candidates)) throw new Error('invalid_dream_patch');
  const validate = (proposal: DreamMemoryProposal): DreamMemoryProposal => {
    if (!proposal || typeof proposal !== 'object') throw new Error('invalid_dream_proposal');
    if (!['fact', 'decision', 'todo', 'project', 'checkpoint', 'episode', 'lesson'].includes(proposal.kind)) throw new Error('invalid_dream_kind');
    const title = bounded(redactSensitive(proposal.title), 200);
    const description = bounded(redactSensitive(proposal.description), 500);
    const content = bounded(redactSensitive(proposal.content), 24_000);
    if (!title || !description || !content) throw new Error('invalid_dream_content');
    const sourceEventKeys = [...new Set(proposal.sourceEventKeys ?? [])];
    if (sourceEventKeys.some((key) => !allowedSources.has(key))) throw new Error('invalid_dream_source');
    return { ...proposal, title, description, content, sourceEventKeys, tags: (proposal.tags ?? []).slice(0, 20) };
  };
  const candidates = patch.candidates.slice(0, 20).map(validate);
  const globalCandidates = (patch.globalCandidates ?? []).slice(0, 10).map(validate).map((proposal) => ({
    ...proposal, sourceEventKeys: [], content: redactSensitive(proposal.content),
  }));
  return { ...(patch.episode ? { episode: validate(patch.episode) } : {}), candidates, globalCandidates };
}

function memoryRecord(
  job: DreamJobRecord, proposal: DreamMemoryProposal, index: number, scope: MemoryEntryRecord['scope'], scopeId: string,
  status: MemoryEntryRecord['status'], now: string,
): MemoryEntryRecord {
  const content = bounded(redactSensitive(proposal.content), 24_000);
  return {
    id: `memory:dream:${digest(`${job.id}:${job.watermarkSequence ?? job.fromEventSequence}:${index}`)}`,
    scope, scopeId, kind: proposal.kind, title: bounded(redactSensitive(proposal.title), 200),
    description: fingerprint(proposal), content, tags: [...new Set(proposal.tags ?? [])].slice(0, 20),
    importance: clamp(proposal.importance ?? 0.5), confidence: clamp(proposal.confidence ?? 0.5),
    visibility: scope === 'task' ? 'task' : 'bot', status, version: 1,
    estimatedTokens: Math.ceil(content.length / 4), createdBy: `system:dream:${job.id}`,
    createdAt: now, updatedAt: now,
  };
}

function fingerprint(proposal: DreamMemoryProposal): string {
  return bounded(redactSensitive(proposal.description), 500);
}

function bounded(value: string, max: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max) : '';
}

function clamp(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : 'unknown_dream_failure';
}
