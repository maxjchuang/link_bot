import type { SqliteStateStore } from '../state/SqliteStateStore.js';

export interface TaskPlatformSnapshot {
  taskStates: Record<string, number>;
  activeTurns: number;
  approvalWaits: number;
  pendingOutbox: number;
  pendingIntents: number;
  readySlots: number;
  unknownPublishes: number;
  dreamJobs: Record<string, number>;
  oldestPendingDreamAgeMs: number;
  startupLatency: Record<string, { p50: number; p95: number; count: number } | undefined>;
}

export class TaskPlatformDiagnostics {
  constructor(private readonly store: SqliteStateStore, private readonly clock: () => Date = () => new Date()) {}

  setMetric(name: string, value: number, labels: Record<string, string> = {}): void {
    const serializedLabels = JSON.stringify(Object.fromEntries(Object.entries(labels).sort()));
    this.store.db.prepare(`
      INSERT INTO metrics(name, labels, value, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(name, labels) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(name, serializedLabels, value, this.clock().toISOString());
  }

  clearMetrics(name: string): number {
    return this.store.db.prepare('DELETE FROM metrics WHERE name=?').run(name).changes;
  }

  audit(eventType: string, payload: Record<string, unknown>, eventKey?: string): boolean {
    return this.store.db.transaction(() => {
      const result = this.store.db.prepare(`
        INSERT OR IGNORE INTO audit_events(event_key, event_type, payload, created_at) VALUES (?, ?, ?, ?)
      `).run(eventKey ?? null, eventType, JSON.stringify(payload), this.clock().toISOString());
      if (result.changes === 1 && ['turn.orphan_queued_reconciled', 'turn.submission_outcome_unknown',
        'turn.continuation_reconciliation_required', 'turn.undelivered_followup_recovered'].includes(eventType)) {
        this.store.db.prepare(`
          INSERT INTO metrics(name, labels, value, updated_at) VALUES (?, ?, 1, ?)
          ON CONFLICT(name, labels) DO UPDATE SET value=value+1, updated_at=excluded.updated_at
        `).run('link_bot_turn_recovery_events', JSON.stringify({ event: eventType }), this.clock().toISOString());
      }
      return result.changes === 1;
    }).immediate();
  }

  snapshot(): TaskPlatformSnapshot {
    const taskStates = Object.fromEntries((this.store.db.prepare(`
      SELECT runtime_state AS state, COUNT(*) AS count FROM tasks GROUP BY runtime_state
    `).all() as Array<{ state: string; count: number }>).map((row) => [row.state, row.count]));
    return {
      taskStates,
      activeTurns: count(this.store, "SELECT COUNT(*) AS count FROM turns WHERE state IN ('queued','submitted','running','waiting_approval','waiting_user_input')"),
      approvalWaits: count(this.store, "SELECT COUNT(*) AS count FROM approvals WHERE status='pending'"),
      pendingOutbox: count(this.store, "SELECT COUNT(*) AS count FROM outbound_events WHERE status!='sent'"),
      pendingIntents: count(this.store, "SELECT COUNT(*) AS count FROM lifecycle_intents WHERE status='pending'"),
      readySlots: count(this.store, "SELECT COUNT(*) AS count FROM ready_slots WHERE status='ready'"),
      unknownPublishes: count(this.store, "SELECT COUNT(*) AS count FROM publish_requests WHERE status='unknown'"),
      dreamJobs: Object.fromEntries((this.store.db.prepare(`
        SELECT status, COUNT(*) AS count FROM dream_jobs GROUP BY status
      `).all() as Array<{ status: string; count: number }>).map((row) => [row.status, row.count])),
      oldestPendingDreamAgeMs: this.oldestPendingDreamAgeMs(),
      startupLatency: {
        ready: this.store.startupLatency('ready'),
        warm: this.store.startupLatency('warm'),
        cold: this.store.startupLatency('cold'),
      },
    };
  }

  refreshMetrics(): TaskPlatformSnapshot {
    const snapshot = this.snapshot();
    this.store.db.transaction(() => {
      for (const state of ['provisioning', 'hot', 'warming', 'warm', 'failed', 'archived']) {
        this.setMetric('link_bot_tasks', snapshot.taskStates[state] ?? 0, { state });
      }
      this.setMetric('link_bot_active_turns', snapshot.activeTurns);
      this.setMetric('link_bot_approval_waits', snapshot.approvalWaits);
      this.setMetric('link_bot_pending_outbox', snapshot.pendingOutbox);
      this.setMetric('link_bot_pending_lifecycle_intents', snapshot.pendingIntents);
      this.setMetric('link_bot_ready_slots', snapshot.readySlots);
      this.setMetric('link_bot_unknown_publishes', snapshot.unknownPublishes);
      for (const status of ['pending', 'running', 'deferred', 'completed', 'failed', 'interrupted']) {
        this.setMetric('link_bot_dream_jobs', snapshot.dreamJobs[status] ?? 0, { status });
      }
      this.setMetric('link_bot_dream_oldest_pending_age_ms', snapshot.oldestPendingDreamAgeMs);
      for (const [startupType, latency] of Object.entries(snapshot.startupLatency)) {
        this.setMetric('link_bot_startup_samples', latency?.count ?? 0, { startupType });
        this.setMetric('link_bot_startup_latency_ms', latency?.p50 ?? 0, { startupType, percentile: 'p50' });
        this.setMetric('link_bot_startup_latency_ms', latency?.p95 ?? 0, { startupType, percentile: 'p95' });
      }
    }).immediate();
    return snapshot;
  }

  health(requireMemory = false): { ok: boolean; checks: Record<string, boolean>; counts: Record<string, number> } {
    const integrity = this.store.db.pragma('quick_check', { simple: true }) === 'ok';
    let memoryIndex = true;
    if (requireMemory) {
      try {
        this.store.db.prepare('SELECT COUNT(*) FROM memory_entries_fts').get();
      } catch {
        memoryIndex = false;
      }
    }
    const snapshot = this.refreshMetrics();
    return {
      ok: integrity && memoryIndex,
      checks: { sqliteIntegrity: integrity, memoryIndex },
      counts: {
        pendingOutbox: snapshot.pendingOutbox,
        pendingIntents: snapshot.pendingIntents,
        hotTasks: snapshot.taskStates.hot ?? 0,
        activeTurns: snapshot.activeTurns,
        approvalWaits: snapshot.approvalWaits,
        readySlots: snapshot.readySlots,
        diskPressureHigh: metric(this.store, 'link_bot_disk_pressure', { level: 'high' }),
        unknownPublishes: snapshot.unknownPublishes,
        pendingDreams: snapshot.dreamJobs.pending ?? 0,
        runningDreams: snapshot.dreamJobs.running ?? 0,
        failedDreams: snapshot.dreamJobs.failed ?? 0,
      },
    };
  }

  private oldestPendingDreamAgeMs(): number {
    const row = this.store.db.prepare(`
      SELECT MIN(created_at) AS createdAt FROM dream_jobs WHERE status IN ('pending','deferred','interrupted','failed')
    `).get() as { createdAt: string | null };
    return row.createdAt ? Math.max(0, this.clock().getTime() - Date.parse(row.createdAt)) : 0;
  }
}

function count(store: SqliteStateStore, sql: string): number {
  return (store.db.prepare(sql).get() as { count: number }).count;
}

function metric(store: SqliteStateStore, name: string, labels: Record<string, string>): number {
  const serializedLabels = JSON.stringify(Object.fromEntries(Object.entries(labels).sort()));
  return (store.db.prepare('SELECT value FROM metrics WHERE name=? AND labels=?').get(name, serializedLabels) as {
    value: number;
  } | undefined)?.value ?? 0;
}
