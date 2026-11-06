import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskPlatformDiagnostics } from '../../src/observability/TaskPlatformDiagnostics.js';
import { SqliteStateStore } from '../../src/state/SqliteStateStore.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('TaskPlatformDiagnostics', () => {
  it('counts recovery evidence once with fixed labels even when the audit is replayed', async () => {
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'));
    try {
      const diagnostics = new TaskPlatformDiagnostics(store);
      const event = 'turn.undelivered_followup_recovered';
      expect(diagnostics.audit(event, { taskId: 'private-task' }, 'once')).toBe(true);
      expect(diagnostics.audit(event, { taskId: 'private-task' }, 'once')).toBe(false);
      expect(store.db.prepare("SELECT labels,value FROM metrics WHERE name='link_bot_turn_recovery_events'").all())
        .toEqual([{ labels: JSON.stringify({ event }), value: 1 }]);
    } finally { store.close(); }
  });

  it('reports Dream queue metrics and fails managed-memory health when FTS is unavailable', async () => {
    const now = new Date('2026-07-28T06:00:00.000Z');
    const store = new SqliteStateStore(join(await createTmpDir(), 'state.sqlite'), () => now);
    store.saveDreamJob({
      id: 'dream:task:task_1:2026-07-28', scope: 'task', scopeId: 'task_1', businessDate: '2026-07-28',
      status: 'pending', fromEventSequence: 0, attemptCount: 0,
      createdAt: '2026-07-28T05:59:00.000Z', updatedAt: '2026-07-28T05:59:00.000Z',
    });
    const diagnostics = new TaskPlatformDiagnostics(store, () => now);
    diagnostics.setMetric('link_bot_disk_pressure', 1, { level: 'high' });
    expect(diagnostics.refreshMetrics()).toMatchObject({ dreamJobs: { pending: 1 }, oldestPendingDreamAgeMs: 60_000 });
    expect(diagnostics.health(true)).toMatchObject({
      ok: true, checks: { sqliteIntegrity: true, memoryIndex: true }, counts: { diskPressureHigh: 1 },
    });
    store.db.exec('DROP TABLE memory_entries_fts');
    expect(diagnostics.health(true)).toMatchObject({ ok: false, checks: { sqliteIntegrity: true, memoryIndex: false } });
    expect(diagnostics.health(false)).toMatchObject({ ok: true, checks: { memoryIndex: true } });
    store.close();
  });
});
