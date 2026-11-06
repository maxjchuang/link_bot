import type { SqliteStateStore } from '../state/SqliteStateStore.js';
import type { MemoryEntryRecord } from './MemoryTypes.js';
import { MemoryService } from './MemoryService.js';

export class BotMemoryApprovalService {
  private readonly administrators: Set<string>;

  constructor(
    private readonly store: SqliteStateStore,
    private readonly memory: MemoryService,
    administratorIds: string[],
    private readonly enabled: boolean,
  ) {
    this.administrators = new Set(administratorIds);
  }

  confirm(input: { administratorId: string; taskId: string; contextId: string; memoryId: string }): MemoryEntryRecord {
    if (!this.enabled) throw new Error('Bot-global memory promotion is disabled.');
    if (!this.administrators.has(input.administratorId)) throw new Error('Bot memory requires an administrator.');
    const candidate = this.store.getMemoryEntry(input.memoryId);
    if (!candidate || candidate.scope !== 'bot') throw new Error('Bot memory candidate not found.');
    if (candidate.status === 'active') return candidate;
    if (candidate.status !== 'candidate') throw new Error('Bot memory candidate is not pending.');
    return this.memory.confirmCandidate({
      taskId: input.taskId, contextId: input.contextId, userId: input.administratorId,
      botId: candidate.scopeId, allowBotMemory: true, isAdministrator: true,
    }, candidate.id, candidate.version);
  }
}
