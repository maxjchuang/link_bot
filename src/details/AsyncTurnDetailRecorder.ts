import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { TurnDetailRecorder } from './TurnDetailRecorder.js';
import type { DetailCandidate, DetailTurnIdentity } from './TurnDetailTypes.js';
import type { TurnDetailStore } from './TurnDetailStore.js';
import { detailTurnKey } from './DetailEventAdapter.js';
import type { DetailOutcome, DetailTelemetryPort } from './TurnDetailTelemetry.js';

/** A bounded, ordered display-copy channel. No execution events are replayed on failure. */
export class AsyncTurnDetailRecorder implements Pick<TurnDetailRecorder, 'record'> {
  private worker?: Worker;
  private failed = false;
  private closing = false;
  private bytes = 0;
  private sequence = 0;
  private readonly owner = randomUUID();
  private readonly pending = new Map<number, { bytes: number; identity: DetailTurnIdentity; terminal: boolean }>();
  private readonly active = new Map<string, DetailTurnIdentity>();
  private readonly rejected = new Set<string>();
  private readonly waiters = new Set<() => void>();
  constructor(private readonly path: string, private readonly store: TurnDetailStore,
    private readonly maxBytes = 8 * 1024 * 1024, private readonly maxEvents = 256,
    private readonly telemetry?: DetailTelemetryPort) {}

  get busy(): boolean { return this.pending.size > 0; }

  record(identity: DetailTurnIdentity, candidate: DetailCandidate, eventKey: string, receivedAt: string): boolean {
    try { return this.enqueue(identity, candidate, eventKey, receivedAt); }
    catch (error) {
      const key = detailTurnKey(identity);
      if (this.active.has(key)) this.rejected.add(key);
      try { this.store.markStreamGap(identity); } catch { /* Never persist a raw fallback. */ }
      throw error;
    }
  }

  private enqueue(identity: DetailTurnIdentity, candidate: DetailCandidate, eventKey: string, receivedAt: string): boolean {
    if (this.failed || this.closing || this.pending.size >= this.maxEvents) throw new Error('detail_queue_unavailable');
    const key = detailTurnKey(identity);
    if (this.rejected.has(key)) throw new Error('detail_queue_unavailable');
    if (!this.active.has(key) && this.active.size + this.rejected.size >= this.maxEvents) throw new Error('detail_queue_limit');
    // Limit traversal/string allocation before structured cloning, including a single oversized snapshot.
    let estimated = 0, fields = 0;
    const payload = JSON.stringify({ identity, candidate, eventKey, receivedAt }, (_key, value: unknown) => {
      if (++fields > 10000) throw new Error('detail_queue_limit');
      estimated += typeof value === 'string' ? Buffer.byteLength(value) : 16;
      if (estimated > this.maxBytes - this.bytes) throw new Error('detail_queue_limit');
      return value;
    });
    const bytes = Buffer.byteLength(payload);
    if (bytes > this.maxBytes - this.bytes) throw new Error('detail_queue_limit');
    if (!this.active.has(key)) this.store.claimWriter(identity, this.owner);
    try { this.start(); }
    catch { this.store.releaseWriter(identity, this.owner); throw new Error('detail_worker_unavailable'); }
    const sequence = ++this.sequence;
    this.active.set(key, identity);
    this.pending.set(sequence, { bytes, identity, terminal: candidate.kind === 'terminal' }); this.bytes += bytes;
    try { this.worker!.postMessage({ sequence, payload }); }
    catch { this.fail(); void this.worker?.terminate().catch(() => undefined); throw new Error('detail_queue_unavailable'); }
    return true; // Accepted into the queue, not a durable-write receipt.
  }

  async flush(): Promise<void> {
    if (this.busy) await new Promise<void>((resolve) => this.waiters.add(resolve));
    if (this.failed) throw new Error('detail_worker_unavailable');
  }

  async close(): Promise<void> {
    this.closing = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.flush(), new Promise<void>((resolve) => {
        timer = setTimeout(() => { this.fail(); resolve(); }, 5000);
      })]);
    } catch { /* Failed display copies remain explicitly incomplete. */ }
    finally {
      clearTimeout(timer);
      if (this.active.size) this.fail(); // Partial redaction streams cannot survive a worker restart.
      await this.worker?.terminate();
      if (this.active.size) this.fail(); // Fence any write that was in flight at termination.
      try { this.store.releaseWriters(this.owner); } catch { /* A remaining live-process guard is safer than early cleanup. */ }
      this.active.clear(); this.rejected.clear();
      this.worker = undefined;
    }
  }

  private start(): void {
    if (this.worker) return;
    const compiled = new URL('./TurnDetailRecordingWorker.js', import.meta.url);
    const source = new URL('./TurnDetailRecordingWorker.ts', import.meta.url);
    // tsx is used only for source-mode development; deployed builds load plain JavaScript.
    const bootstrap = existsSync(compiled)
      ? `import(${JSON.stringify(compiled.href)})`
      : `import('tsx/esm/api').then(({tsImport}) => tsImport(${JSON.stringify(source.href)}, ${JSON.stringify(import.meta.url)}))`;
    this.worker = new Worker(bootstrap, { eval: true, workerData: { path: this.path },
      resourceLimits: { maxOldGenerationSizeMb: 128 } });
    this.worker.on('message', (message: { sequence: number; ok: boolean; outcome: DetailOutcome; elapsedMs: number }) => {
      if (!message.ok) { this.fail(); void this.worker?.terminate().catch(() => undefined); return; }
      const pending = this.pending.get(message.sequence);
      if (!pending) return;
      this.bytes -= pending.bytes; this.pending.delete(message.sequence);
      if (this.rejected.has(detailTurnKey(pending.identity))) {
        try { this.store.markStreamGap(pending.identity); } catch { /* Fence entries created after overflow. */ }
      }
      if (pending.terminal || this.rejected.has(detailTurnKey(pending.identity))
        && ![...this.pending.values()].some((item) => detailTurnKey(item.identity) === detailTurnKey(pending.identity))) {
        try { this.store.releaseWriter(pending.identity, this.owner); this.active.delete(detailTurnKey(pending.identity)); }
        catch { /* Keep ownership protected until shutdown, never crash an event callback. */ }
      }
      try { this.telemetry?.observe('record', message.outcome, message.elapsedMs); } catch { /* Isolated metrics. */ }
      if (!this.busy) this.wake();
    });
    this.worker.on('error', () => this.fail());
    this.worker.on('exit', () => {
      if (this.active.size || this.busy || !this.closing) this.fail();
      try { this.store.releaseWriters(this.owner); this.active.clear(); this.rejected.clear(); }
      catch { /* Never release before the worker has actually stopped. */ }
    });
  }

  private fail(): void {
    this.failed = true;
    for (const identity of this.active.values()) {
      try { this.store.markStreamGap(identity); this.store.markIncomplete(identity); } catch { /* No raw fallback. */ }
    }
    this.pending.clear(); this.bytes = 0; this.wake();
  }
  private wake(): void { for (const resolve of this.waiters) resolve(); this.waiters.clear(); }
}
