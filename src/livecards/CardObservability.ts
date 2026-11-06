import type { LiveTurnSnapshot } from '../projections/LiveTurnProjection.js';
import type { AppServerTurnCardRecord, RequestReleaseMark } from './AppServerTurnCardStore.js';

export type CardOperation = 'card_create' | 'card_send' | 'card_update' | 'card_final' | 'legacy_card_final' | 'card_fallback_send' | 'detail_card_send' | 'detail_card_update' | 'operation_card_send';
export type WaitingSample = 'not_waiting' | 'valid' | 'false_wait' | 'unknown';
export interface CardTelemetryPort {
  observeCard(operation: CardOperation, outcome: 'ok' | 'unavailable', elapsedMs: number, payloadBytes: number): void;
  observeWaiting(sample: WaitingSample): void;
  observeRelease(elapsedMs: number): void;
  observeReleaseUnavailable(reason: 'missing_timestamp' | 'capacity'): void;
}
export type CardTelemetry = Partial<CardTelemetryPort> | undefined;

/** Only numeric size/timing and fixed enums leave this boundary; never card content or identifiers. */
export async function observeCardDelivery<T>(telemetry: CardTelemetry, operation: CardOperation, payload: unknown,
  deliver: () => Promise<T>): Promise<T> {
  const start = performance.now(); let bytes = 0, outcome: 'ok' | 'unavailable' = 'unavailable';
  try { bytes = Buffer.byteLength(JSON.stringify(payload) ?? ''); } catch { /* Measurement cannot prevent delivery. */ }
  try { const result = await deliver(); outcome = 'ok'; return result; }
  finally { try { telemetry?.observeCard?.(operation, outcome, performance.now() - start, bytes); } catch { /* Isolated metrics. */ } }
}

export function shownWaiting(snapshot: LiveTurnSnapshot | undefined, structured: boolean): string[] {
  return (structured ? snapshot?.pendingActions?.slice(0, 3) : snapshot?.pendingActions)?.filter((action) => action.status === 'delivered')
    .map((action) => action.requestRef) ?? [];
}

export function waitingSample(shown: string[], current: LiveTurnSnapshot | undefined, now: number): WaitingSample {
  if (!shown.length) return 'not_waiting';
  if (!current?.pendingActions) return 'unknown';
  const valid = new Set(current.phase === 'running' ? current.pendingActions.filter((action) => action.status === 'delivered'
    && Boolean(action.messageId && action.handlerUserId) && Date.parse(action.expiresAt) > now).map((action) => action.requestRef) : []);
  return shown.every((ref) => valid.has(ref)) ? 'valid' : 'false_wait';
}

/** Settle only release facts captured before rendering a version that no longer shows that request. */
export function settleReleaseMarks(record: AppServerTurnCardRecord, captured: RequestReleaseMark[], shown: string[], now: number): {
  remaining: RequestReleaseMark[]; elapsed: number[];
} {
  const elapsed: number[] = [];
  const remaining = (record.requestReleasePending ?? []).filter((mark) => {
    const delay = now - Date.parse(mark.at);
    if (!captured.some((item) => item.requestRef === mark.requestRef && item.at === mark.at) || shown.includes(mark.requestRef)
      || !Number.isFinite(delay) || delay < 0) return true;
    elapsed.push(delay); return false;
  });
  return { remaining, elapsed };
}
