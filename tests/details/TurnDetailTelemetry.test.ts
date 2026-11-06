import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createTmpDir } from '../helpers/tmp.js';
import { TurnDetailTelemetry } from '../../src/details/TurnDetailTelemetry.js';
import { SQLITE_SCHEMA_VERSION } from '../../src/state/SqliteSchema.js';
import { newAppServerCardRecord, SqliteAppServerTurnCardStore } from '../../src/livecards/AppServerTurnCardStore.js';

describe('safe detail telemetry', () => {
  it('keeps fixed-cardinality size/wait/release metrics across writer contention, including the strict two-second boundary', async () => {
    const path = join(await createTmpDir(), 'state.sqlite');
    const telemetry = new TurnDetailTelemetry(path), db = new Database(path);
    try {
      telemetry.observeCard('card_update', 'ok', 10, 4096);
      telemetry.observeCard('card_update', 'unavailable', 20, 8192);
      telemetry.observeCard('fake-card-secret' as never, 'ok', 10, 100);
      telemetry.observeCard('card_update', 'fake-error-secret' as never, 10, 100);
      telemetry.observeCard('card_update', 'ok', NaN, 100);
      telemetry.observeCard('card_update', 'ok', 1, -1);
      for (const sample of ['valid', 'false_wait', 'unknown', 'not_waiting'] as const) telemetry.observeWaiting(sample);
      telemetry.observeWaiting('fake-actor-secret' as never);
      telemetry.observeRelease(1999); telemetry.observeRelease(2000); telemetry.observeRelease(-1);
      telemetry.observeReleaseUnavailable('missing_timestamp'); telemetry.observeReleaseUnavailable('capacity');
      telemetry.observeReleaseUnavailable('fake-path-secret' as never);
      db.exec('BEGIN IMMEDIATE'); telemetry.flush(); db.exec('ROLLBACK'); telemetry.flush();
      const values = (name: string) => db.prepare('SELECT labels,value FROM metrics WHERE name=? ORDER BY labels').all(name);
      expect(values('link_bot_card_payload_bytes_max')).toEqual([
        { labels: JSON.stringify({ operation: 'card_update', outcome: 'ok' }), value: 4096 },
        { labels: JSON.stringify({ operation: 'card_update', outcome: 'unavailable' }), value: 8192 },
      ]);
      expect(values('link_bot_card_wait_samples_total')).toHaveLength(4);
      expect(values('link_bot_request_release_slo_samples_total')).toEqual([
        { labels: JSON.stringify({ result: 'at_or_over_2000ms' }), value: 1 },
        { labels: JSON.stringify({ result: 'under_2000ms' }), value: 1 },
      ]);
      expect(values('link_bot_request_release_unmeasured_total')).toHaveLength(2);
      const before = db.prepare('SELECT * FROM metrics ORDER BY name,labels').all(); telemetry.flush();
      expect(db.prepare('SELECT * FROM metrics ORDER BY name,labels').all()).toEqual(before);
      expect(JSON.stringify(before)).not.toContain('fake-');
    } finally { if (db.inTransaction) db.exec('ROLLBACK'); telemetry.close(); db.close(); }
  });

  it('exposes unresolved count and age rather than hiding requests without a clearing receipt', async () => {
    const path = join(await createTmpDir(), 'state.sqlite');
    const telemetry = new TurnDetailTelemetry(path), cards = new SqliteAppServerTurnCardStore(path), db = new Database(path);
    try {
      const at = new Date(Date.now() - 3000).toISOString();
      const record = newAppServerCardRecord({ ownerKind: 'task_platform', taskId: 'task', localTurnId: 'turn', target: { chatId: 'chat' }, now: at });
      cards.save({ ...record, requestReleasePending: [{ requestRef: 'fake-private-request-ref', at }] });
      telemetry.gauges();
      const value = (name: string) => (db.prepare('SELECT value FROM metrics WHERE name=?').get(`link_bot_detail_${name}`) as { value: number }).value;
      expect(value('pending_request_release_receipts')).toBe(1);
      expect(value('oldest_pending_request_release_ms')).toBeGreaterThanOrEqual(3000);
      expect(JSON.stringify(db.prepare('SELECT * FROM metrics').all())).not.toContain('fake-private');
      cards.update(record.id, (row) => ({ ...row, requestReleasePending: [] })); telemetry.gauges();
      expect(value('pending_request_release_receipts')).toBe(0); expect(value('oldest_pending_request_release_ms')).toBe(0);
    } finally { telemetry.close(); cards.close(); db.close(); }
  });
  it('does not block execution on a busy metrics writer and retains aggregates for retry', async () => {
    const path = join(await createTmpDir(), 'state.sqlite');
    const telemetry = new TurnDetailTelemetry(path), db = new Database(path);
    try {
      telemetry.observe('record', 'ok', 1);
      db.exec('BEGIN IMMEDIATE');
      expect(() => telemetry.flush()).not.toThrow();
      expect(db.prepare("SELECT count(*) AS n FROM metrics WHERE name='link_bot_detail_operations_total'").get()).toEqual({ n: 0 });
      db.exec('ROLLBACK');
      telemetry.flush();
      expect(db.prepare("SELECT value FROM metrics WHERE name='link_bot_detail_operations_total'").get()).toEqual({ value: 1 });
    } finally { telemetry.close(); db.close(); }
  });
  it('persists bounded numeric metrics only and aggregates across instances without arbitrary labels', async () => {
    const path = join(await createTmpDir(), 'state.sqlite');
    const first = new TurnDetailTelemetry(path), second = new TurnDetailTelemetry(path), db = new Database(path);
    try {
      first.observe('query', 'denied', 12); second.observe('query', 'denied', 20);
      first.observe('fake-secret-command' as never, 'denied', 10);
      first.observe('query', 'fake-password-body' as never, 10);
      first.flush(); second.flush();
      expect(db.pragma('user_version', { simple: true })).toBe(SQLITE_SCHEMA_VERSION);
      expect(db.prepare('SELECT version FROM detail_security_contract WHERE id=1').get()).toEqual({ version: 3 });
      const rows = db.prepare("SELECT * FROM metrics WHERE name LIKE 'link_bot_detail_%'").all();
      expect(JSON.stringify(rows)).not.toContain('fake-');
      expect(db.prepare("SELECT value FROM metrics WHERE name='link_bot_detail_operations_total' AND labels=?")
        .get(JSON.stringify({ operation: 'query', outcome: 'denied' }))).toEqual({ value: 2 });
      first.flush();
      expect(db.prepare("SELECT value FROM metrics WHERE name='link_bot_detail_operations_total' AND labels=?")
        .get(JSON.stringify({ operation: 'query', outcome: 'denied' }))).toEqual({ value: 2 });
    } finally { first.close(); second.close(); db.close(); }
  });
});
