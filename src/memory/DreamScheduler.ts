import type { SqliteStateStore } from '../state/SqliteStateStore.js';
import type { DreamJobRecord } from './MemoryTypes.js';
import { sanitizeDreamEvents } from './DreamEventPolicy.js';

export interface DreamScheduleConfig {
  timezone: string;
  startAfter: string;
}

export class DreamScheduler {
  constructor(
    private readonly store: SqliteStateStore,
    private readonly config: DreamScheduleConfig = { timezone: 'Asia/Shanghai', startAfter: '02:00' },
    private readonly clock: () => Date = () => new Date(),
  ) {
    assertTimezone(config.timezone);
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(config.startAfter)) throw new Error('Dream startAfter must be HH:mm.');
  }

  reconcile(): DreamJobRecord[] {
    const now = this.clock();
    const local = localParts(now, this.config.timezone);
    if (`${local.hour}:${local.minute}` < this.config.startAfter) return [];
    const created: DreamJobRecord[] = [];
    for (const task of this.store.listTasks()) {
      if (task.runtimeState === 'archived') continue;
      if (this.store.listDreamJobs().some((job) => job.scope === 'task' && job.scopeId === task.id && job.status !== 'completed')) continue;
      const watermark = this.store.dreamWatermark('task', task.id);
      const events = this.store.listTurnEventsAfter(task.id, watermark, 1_000);
      if (sanitizeDreamEvents(events, 24_000).length === 0) continue;
      const nowIso = now.toISOString();
      const job: DreamJobRecord = {
        id: `dream:task:${task.id}:${local.date}`, scope: 'task', scopeId: task.id,
        businessDate: local.date, status: 'pending', fromEventSequence: watermark,
        attemptCount: 0, createdAt: nowIso, updatedAt: nowIso,
      };
      if (this.store.createDreamJob(job)) created.push(job);
    }
    return created;
  }

  reconcileStartup(): DreamJobRecord[] {
    this.store.interruptRunningDreamJobs('manager_restart');
    return this.reconcile();
  }
}

function localParts(date: Date, timezone: string): { date: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: get('hour'), minute: get('minute') };
}

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  } catch {
    throw new Error(`Invalid Dream timezone: ${timezone}`);
  }
}
