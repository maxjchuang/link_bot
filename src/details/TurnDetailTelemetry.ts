import Database from 'better-sqlite3';
import { migrateSqliteSchema } from '../state/SqliteSchema.js';
import type { CardOperation, CardTelemetryPort, WaitingSample } from '../livecards/CardObservability.js';

export type DetailOperation = 'enqueue' | 'record' | 'query' | 'download' | 'cleanup' | CardOperation | 'request_release';
export type DetailOutcome = 'ok' | 'denied' | 'expired' | 'unavailable' | 'truncated';
export interface DetailTelemetryPort extends Partial<CardTelemetryPort> { observe(operation: DetailOperation, outcome: DetailOutcome, elapsedMs: number): void }
const buckets = [10, 50, 100, 500, 1000, 5000, 60000];
const cardOperations: CardOperation[] = ['card_create', 'card_send', 'card_update', 'card_final', 'legacy_card_final', 'card_fallback_send', 'detail_card_send', 'detail_card_update', 'operation_card_send'];
const byteBuckets = [4096, 16384, 32768, 65536, 131072];

/** Fixed-cardinality aggregate metrics; no bodies, errors, paths, selectors or user IDs accepted. */
export class TurnDetailTelemetry implements DetailTelemetryPort {
  private readonly db: Database.Database;
  private readonly pending = new Map<string, { operation: DetailOperation; outcome: DetailOutcome; count: number; sum: number; max: number; buckets: number[] }>();
  private readonly cardBytes = new Map<string, { operation: CardOperation; outcome: string; count: number; sum: number; max: number; buckets: number[] }>();
  private readonly waiting = new Map<WaitingSample, number>();
  private readonly releaseSlo = new Map<'under_2000ms' | 'at_or_over_2000ms', number>();
  private readonly unmeasuredReleases = new Map<'missing_timestamp' | 'capacity', number>();
  constructor(path: string) {
    this.db = new Database(path);
    try { migrateSqliteSchema(this.db); } catch (error) { this.db.close(); throw error; }
    // Observation never waits behind a business write; unavailable telemetry is best effort.
    this.db.pragma('busy_timeout=0');
  }
  observe(operation: DetailOperation, outcome: DetailOutcome, elapsedMs: number): void {
    if (!['enqueue', 'record', 'query', 'download', 'cleanup', 'request_release', ...cardOperations].includes(operation) || !['ok', 'denied', 'expired', 'unavailable', 'truncated'].includes(outcome)
      || !Number.isFinite(elapsedMs) || elapsedMs < 0) return;
    const key = `${operation}:${outcome}`;
    const value = this.pending.get(key) ?? { operation, outcome, count: 0, sum: 0, max: 0, buckets: Array(8).fill(0) as number[] };
    value.count++; value.sum += elapsedMs; value.max = Math.max(value.max, elapsedMs);
    const bucket = buckets.findIndex((limit) => elapsedMs <= limit);
    value.buckets[bucket < 0 ? 7 : bucket]!++;
    this.pending.set(key, value);
  }
  observeCard(operation: CardOperation, outcome: 'ok' | 'unavailable', elapsedMs: number, payloadBytes: number): void {
    if (!cardOperations.includes(operation) || !['ok', 'unavailable'].includes(outcome) || !Number.isSafeInteger(payloadBytes)
      || payloadBytes < 0 || !Number.isFinite(elapsedMs) || elapsedMs < 0) return;
    this.observe(operation, outcome, elapsedMs);
    const key = `${operation}:${outcome}`;
    const value = this.cardBytes.get(key) ?? { operation, outcome, count: 0, sum: 0, max: 0, buckets: Array(6).fill(0) as number[] };
    value.count++; value.sum += payloadBytes; value.max = Math.max(value.max, payloadBytes);
    const bucket = byteBuckets.findIndex((limit) => payloadBytes <= limit);
    value.buckets[bucket < 0 ? 5 : bucket]!++;
    this.cardBytes.set(key, value);
  }
  observeWaiting(sample: WaitingSample): void {
    if (!['not_waiting', 'valid', 'false_wait', 'unknown'].includes(sample)) return;
    this.waiting.set(sample, (this.waiting.get(sample) ?? 0) + 1);
  }
  observeRelease(elapsedMs: number): void {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;
    this.observe('request_release', 'ok', elapsedMs);
    const result = elapsedMs < 2000 ? 'under_2000ms' : 'at_or_over_2000ms';
    this.releaseSlo.set(result, (this.releaseSlo.get(result) ?? 0) + 1);
  }
  observeReleaseUnavailable(reason: 'missing_timestamp' | 'capacity'): void {
    if (reason !== 'missing_timestamp' && reason !== 'capacity') return;
    this.unmeasuredReleases.set(reason, (this.unmeasuredReleases.get(reason) ?? 0) + 1);
  }
  flush(): void {
    try {
      this.db.transaction(() => {
        const add = (name: string, labels: Record<string, string>, value: number, maximum = false) => {
          this.db.prepare(`INSERT INTO metrics(name,labels,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(name,labels)
            DO UPDATE SET value=${maximum ? 'max(metrics.value,excluded.value)' : 'metrics.value+excluded.value'},updated_at=excluded.updated_at`)
            .run(name, JSON.stringify(labels), value, new Date().toISOString());
        };
        for (const value of this.pending.values()) {
          const labels = { operation: value.operation, outcome: value.outcome };
          add('link_bot_detail_operations_total', labels, value.count);
          add('link_bot_detail_duration_ms_sum', labels, value.sum);
          add('link_bot_detail_duration_ms_max', labels, value.max, true);
          // Disjoint fixed latency buckets, not raw per-request samples.
          value.buckets.forEach((count, index) => { if (count) add('link_bot_detail_latency_bucket_count', { ...labels, bucket: String(buckets[index] ?? 'inf') }, count); });
        }
        for (const value of this.cardBytes.values()) {
          const labels = { operation: value.operation, outcome: value.outcome };
          add('link_bot_card_payload_samples_total', labels, value.count);
          add('link_bot_card_payload_bytes_sum', labels, value.sum);
          add('link_bot_card_payload_bytes_max', labels, value.max, true);
          value.buckets.forEach((count, index) => { if (count) add('link_bot_card_payload_bucket_count', { ...labels, bucket: String(byteBuckets[index] ?? 'inf') }, count); });
        }
        for (const [sample, count] of this.waiting) add('link_bot_card_wait_samples_total', { sample }, count);
        for (const [result, count] of this.releaseSlo) add('link_bot_request_release_slo_samples_total', { result }, count);
        for (const [reason, count] of this.unmeasuredReleases) add('link_bot_request_release_unmeasured_total', { reason }, count);
      }).immediate();
      this.pending.clear();
      this.cardBytes.clear(); this.waiting.clear(); this.releaseSlo.clear(); this.unmeasuredReleases.clear();
    } catch { /* Keep bounded aggregates for the next tick, never fail execution. */ }
  }
  gauges(): void {
    try {
      const row = this.db.prepare(`SELECT coalesce(sum(retained_bytes),0) AS bytes,
        coalesce(sum(CASE WHEN availability='available' THEN 1 ELSE 0 END),0) AS available,
        coalesce(sum(CASE WHEN json_extract(payload,'$.truncated')=1 THEN 1 ELSE 0 END),0) AS truncated,
        coalesce(sum(CASE WHEN json_extract(payload,'$.incomplete')=1 THEN 1 ELSE 0 END),0) AS incomplete FROM detail_turns`)
        .get() as { bytes: number; available: number; truncated: number; incomplete: number };
      const pending = (this.db.prepare('SELECT count(*) AS n FROM detail_resource_deletions').get() as { n: number }).n;
      const releases = (this.db.prepare(`SELECT coalesce(sum(json_array_length(payload,'$.requestReleasePending')),0) AS n FROM live_cards`).get() as { n: number }).n;
      const oldest = (this.db.prepare(`SELECT min(json_extract(mark.value,'$.at')) AS at FROM live_cards c,
        json_each(c.payload,'$.requestReleasePending') mark`).get() as { at: string | null }).at;
      const oldestAge = oldest && Number.isFinite(Date.parse(oldest)) ? Math.max(0, Date.now() - Date.parse(oldest)) : 0;
      this.db.transaction(() => {
        for (const [name, value] of Object.entries({ logical_retained_bytes: row.bytes, available_turns: row.available,
          truncated_turns: row.truncated, incomplete_turns: row.incomplete, pending_resource_deletions: pending,
          pending_request_release_receipts: releases, oldest_pending_request_release_ms: oldestAge })) {
          this.db.prepare(`INSERT INTO metrics(name,labels,value,updated_at) VALUES(?,'{}',?,?)
            ON CONFLICT(name,labels) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
            .run(`link_bot_detail_${name}`, value, new Date().toISOString());
        }
      }).immediate();
    } catch { /* Best effort. Logical retention is not a physical-disk measurement. */ }
  }
  close(): void { this.flush(); this.db.close(); }
}
