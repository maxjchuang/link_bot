import type { ContextCheckpointWriter } from '../contexts/TaskContextService.js';
import type { SqliteStateStore } from '../state/SqliteStateStore.js';
import type { MemoryEntryRecord } from './MemoryTypes.js';
import { estimateTokens } from './MemoryService.js';

export class MemoryCheckpointWriter implements ContextCheckpointWriter {
  constructor(
    private readonly store: SqliteStateStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async create(input: Parameters<ContextCheckpointWriter['create']>[0]): Promise<{ memoryId: string }> {
    const memoryId = `checkpoint:${input.context.id}:v1`;
    const existing = this.store.getMemoryEntry(memoryId);
    if (existing) return { memoryId: existing.id };
    const task = this.store.getTask(input.taskId);
    if (!task || input.context.taskId !== task.id) throw new Error('Checkpoint context does not belong to task.');
    const repositories = this.store.listTaskRepositories(task.id).map((repository) => ({
      id: repository.id, projectId: repository.projectId, checkoutPath: repository.checkoutPath,
      baseRef: repository.baseRef, baseCommit: repository.baseCommit, branchName: repository.branchName,
    }));
    const turns = this.store.listTurnsByTask(task.id).slice(-20);
    const resume = task.pendingProjectBind?.resumeAfterBind ?? task.projectBindContinuation;
    const content = redactCheckpoint(JSON.stringify({
      objective: resume?.text ?? turns.at(-1)?.prompt ?? 'No current objective recorded.',
      repositories,
      completedWork: turns.filter((turn) => turn.state === 'completed' && turn.id !== resume?.turnId).map((turn) => turn.prompt).slice(-10),
      outstandingWork: [...(resume ? [resume.text] : []), ...turns.filter((turn) => turn.id !== resume?.turnId && !['completed', 'failed', 'interrupted'].includes(turn.state)).map((turn) => turn.prompt)],
      failedAttempts: turns.filter((turn) => turn.state === 'failed').map((turn) => ({ prompt: turn.prompt, failure: turn.failure })).slice(-10),
      nextActions: resume ? [resume.text] : turns.at(-1)?.state === 'completed' ? [] : [turns.at(-1)?.prompt].filter(Boolean),
    })).slice(0, 24_000);
    const now = this.clock().toISOString();
    const memory: MemoryEntryRecord = {
      id: memoryId, scope: 'task', scopeId: task.id, kind: 'checkpoint', title: 'Context checkpoint',
      description: `Continuity checkpoint for ${input.context.id}.`, content, tags: ['checkpoint', 'continuity'],
      importance: 1, confidence: 1, visibility: 'task', status: 'active', version: 1,
      estimatedTokens: estimateTokens(content), createdBy: input.createdBy, createdAt: now, updatedAt: now,
    };
    this.store.saveMemoryEntry(memory);
    return { memoryId };
  }
}

function redactCheckpoint(value: string): string {
  return value
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[redacted private key]')
    .replace(/((?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*)[^\s",}]{8,}/gi, '$1[redacted]');
}
