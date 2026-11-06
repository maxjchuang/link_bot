import { createHash } from 'node:crypto';
import { detailTurnKey } from './DetailEventAdapter.js';
import { DetailSanitizer, isSensitiveDetailCommand, sanitizeDetailText } from './DetailSanitizer.js';
import { parseDiffSnapshot } from './DiffSnapshotParser.js';
import type { DetailResourceStore } from './DetailResourceStore.js';
import type { TurnDetailStore } from './TurnDetailStore.js';
import type { DetailCandidate, DetailEntry, DetailTurnIdentity } from './TurnDetailTypes.js';

/** Isolated display sink. Failures mark missing detail, never fail the Codex business event. */
export class TurnDetailRecorder {
  private readonly streams = new Map<string, DetailSanitizer>();
  private readonly unsafeTurns = new Set<string>();

  constructor(private readonly store: TurnDetailStore, private readonly files: DetailResourceStore) {}

  record(identity: DetailTurnIdentity, candidate: DetailCandidate, eventKey: string, receivedAt: string): boolean {
    if (candidate.kind === 'terminal') this.unsafeTurns.delete(detailTurnKey(identity));
    try {
      const turn = this.store.getTurn(identity);
      if (!turn || turn.availability !== 'available' || turn.lifecycle !== 'running') {
        if (candidate.kind === 'terminal') this.dropTurnStreams(identity, true);
        return false;
      }
      if (this.store.hasEvent(identity, eventKey)) return false;
      if (candidate.kind === 'terminal') {
        for (const entry of this.allEntries(identity)) this.finish(identity, entry, `${eventKey}:${entry.entryId}`);
        this.store.completeTurn(identity, candidate.lifecycle, receivedAt);
        this.dropTurnStreams(identity, true);
        return true;
      }
      if (candidate.kind === 'diff_snapshot') return this.recordDiff(identity, candidate.text, eventKey, receivedAt);
      if (candidate.kind === 'process_item') {
        for (const [index, segment] of candidate.segments.entries()) {
          const entryId = key('process', candidate.itemId, segment.source, segment.partIndex ?? null);
          const prior = this.store.getEntry(identity, entryId);
          if (!prior?.metadata.deltaSeen) this.record(identity, { kind: 'process_delta', itemId: candidate.itemId, ...segment }, `${eventKey}:segment:${index}`, receivedAt);
        }
        if (candidate.completed) for (const entry of this.allEntries(identity).filter((entry) => entry.category === 'process' && entry.itemId === candidate.itemId)) {
          this.finish(identity, entry, `${eventKey}:finish:${entry.entryId}`);
          const latest = this.store.getEntry(identity, entry.entryId) ?? entry;
          this.store.putEntry(identity, { ...latest, metadata: { ...latest.metadata, completed: true,
            ...(candidate.finalAnswer ? {finalAnswer:true} : {}) } }, `${eventKey}:completed:${entry.entryId}`);
        }
        return true;
      }
      const entryId = candidate.kind === 'command_item' || candidate.kind === 'command_delta'
        ? (candidate.kind === 'command_delta' && candidate.stream !== 'combined' ? key('command', candidate.itemId, candidate.stream) : key('command', candidate.itemId))
        : key('process', candidate.itemId, candidate.kind === 'process_delta' ? candidate.source : 'summary', candidate.partIndex ?? null);
      const prior = this.store.getEntry(identity, entryId);
      const commandBase = candidate.kind === 'command_delta' ? this.store.getEntry(identity, key('command', candidate.itemId)) : undefined;
      const entry: DetailEntry = prior ?? { entryId, itemId: candidate.itemId,
        category: candidate.kind.startsWith('command') ? 'commands' : 'process', receivedAt,
        metadata: commandBase ? { ...commandBase.metadata } : {} };
      if (candidate.kind === 'command_item') {
        const sensitive = candidate.command !== undefined ? isSensitiveDetailCommand(candidate.command) : entry.metadata.sensitiveOperation !== false;
        const metadata: DetailEntry['metadata'] = { ...entry.metadata, completed: candidate.completed, sensitiveOperation: sensitive };
        for (const field of ['command', 'cwd', 'status'] as const) {
          if (candidate[field] !== undefined) metadata[field] = sensitive ? '[敏感操作]' : sanitizeDetailText(candidate[field]).text;
        }
        for (const field of ['exitCode', 'startedAtMs', 'completedAtMs', 'durationMs'] as const) {
          if (candidate[field] !== undefined) metadata[field] = candidate[field];
        }
        // Persist safe operation metadata before processing a completion-only output.
        if (!this.store.putEntry(identity, { ...entry, metadata }, eventKey)) return false;
        if (candidate.completed && candidate.aggregatedOutput !== undefined && !entry.metadata.deltaSeen) {
          this.record(identity, { kind: 'command_delta', itemId: candidate.itemId, stream: 'combined', text: candidate.aggregatedOutput }, `${eventKey}:aggregate`, receivedAt);
        }
        if (candidate.completed) {
          for (const output of this.allEntries(identity).filter((value) => value.category === 'commands' && value.itemId === candidate.itemId)) {
            this.finish(identity, output, `${eventKey}:finish:${output.entryId}`);
          }
        }
        const latest = this.store.getEntry(identity, entryId) ?? entry;
        const missing = candidate.completed && candidate.aggregatedOutput === undefined && !latest.metadata.deltaSeen;
        return this.store.putEntry(identity, { ...latest, missing: latest.missing || missing,
          metadata: { ...latest.metadata, ...metadata } }, `${eventKey}:metadata`);
      }
      if (candidate.kind === 'process_part') return this.store.putEntry(identity, { ...entry, source: 'summary', partIndex: candidate.partIndex }, eventKey);
      const streamKey = `${detailTurnKey(identity)}:${entryId}`;
      let stream = this.streams.get(streamKey);
      const gap = !stream && (this.unsafeTurns.has(detailTurnKey(identity)) || this.store.hasStreamGap(identity, entryId)
        || Boolean(commandBase && this.store.hasStreamGap(identity, commandBase.entryId))
        || (candidate.kind === 'process_delta' && !prior && this.store.hasStreamGap(identity)));
      const resumed = !stream && Boolean(gap || entry.metadata.pendingLine || entry.metadata.privateKey || entry.metadata.sensitiveContinuation);
      if (!stream) {
        stream = new DetailSanitizer({ discardUntilNewline: gap || entry.metadata.pendingLine === true,
          privateKey: entry.metadata.privateKey === true,
          sensitiveContinuation: gap || entry.metadata.sensitiveContinuation === true,
          sensitiveOperation: candidate.kind === 'command_delta' && entry.metadata.sensitiveOperation !== false });
        this.streams.set(streamKey, stream);
      }
      const safe = stream.push(candidate.text);
      const next: DetailEntry = { ...entry, missing: entry.missing || resumed,
        metadata: { ...entry.metadata, ...stream.resumeState, deltaSeen: true,
          ...(candidate.kind === 'command_delta' ? { outputStream: candidate.stream } : {}) },
        ...(candidate.kind === 'process_delta' ? { source: candidate.source, partIndex: candidate.partIndex } : {}) };
      return this.persist(identity, next, safe.text, safe.redacted, eventKey);
    } catch {
      this.dropTurnStreams(identity, candidate.kind === 'terminal');
      try { this.store.markIncomplete(identity); } catch { /* UI storage failure must not stop execution. */ }
      return false;
    }
  }

  private persist(identity: DetailTurnIdentity, entry: DetailEntry, text: string, redacted: boolean, eventKey: string): boolean {
    const old = entry.resource;
    if ((old?.committedBytes ?? 0) + Buffer.byteLength(text) > this.store.bodyBudget(identity, entry.entryId)) {
      this.store.markTruncated(identity);
      this.store.markIncomplete(identity, text.slice(-512));
      this.dropTurnStreams(identity);
      return false;
    }
    const resourceId = old?.resourceId ?? this.files.create(detailTurnKey(identity), (id) => this.store.registerResource(id, detailTurnKey(identity)));
    let committedBytes = old?.committedBytes ?? 0;
    try {
      if (!this.store.reserveResource(identity, resourceId, committedBytes + Buffer.byteLength(text))) {
        if (!old) this.releaseResource(identity, resourceId);
        this.store.markTruncated(identity); this.dropTurnStreams(identity); return false;
      }
      // At most 32 KiB UTF-8 per append; do not split a surrogate pair at a chunk boundary.
      for (let offset = 0; offset < text.length;) {
        let end = Math.min(offset + 8192, text.length);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
        committedBytes = this.files.append(resourceId, committedBytes, text.slice(offset, end));
        offset = end;
      }
      this.store.confirmResourceSize(identity, resourceId, committedBytes);
      const accepted = this.store.putEntry(identity, { ...entry, resource: { resourceId, committedBytes,
        revision: (old?.revision ?? 0) + 1, redacted: redacted || (old?.redacted ?? false), truncated: old?.truncated ?? false } }, eventKey);
      if (!accepted) {
        if (old) { this.files.append(resourceId, old.committedBytes, ''); this.store.confirmResourceSize(identity, resourceId, old.committedBytes); }
        else this.releaseResource(identity, resourceId);
        this.store.markIncomplete(identity, text.slice(-512));
        this.dropTurnStreams(identity);
      }
      return accepted;
    } catch (error) {
      if (old) { this.files.append(resourceId, old.committedBytes, ''); this.store.confirmResourceSize(identity, resourceId, old.committedBytes); }
      else this.releaseResource(identity, resourceId);
      throw error;
    }
  }

  private finish(identity: DetailTurnIdentity, entry: DetailEntry, eventKey: string): void {
    const streamKey = `${detailTurnKey(identity)}:${entry.entryId}`;
    const stream = this.streams.get(streamKey);
    if (!stream) {
      if (entry.metadata.pendingLine || entry.metadata.privateKey || entry.metadata.sensitiveContinuation) this.store.markIncomplete(identity);
      return;
    }
    const safe = stream.finish();
    this.persist(identity, { ...entry, metadata: { ...entry.metadata, ...stream.resumeState } }, safe.text, safe.redacted, eventKey);
    this.streams.delete(streamKey);
  }

  private recordDiff(identity: DetailTurnIdentity, raw: string, eventKey: string, receivedAt: string): boolean {
    const safe = sanitizeDetailText(raw);
    const parsed = parseDiffSnapshot(safe.text);
    if (!parsed.files.length) this.store.markIncomplete(identity);
    // Include unsupported snapshots as explicit review text rather than silently dropping the body.
    const sources = parsed.files.length ? parsed.files : [{ path: '[未解析Diff]', text: safe.text, added: 0, removed: 0, binary: false }];
    const oldFiles = this.allEntries(identity).filter((entry) => entry.category === 'files');
    const snapshotBudget = this.store.bodyBudget(identity, '');
    if (Buffer.byteLength(safe.text) > snapshotBudget) {
      this.store.markTruncated(identity);
      this.store.markIncomplete(identity, safe.text.slice(-512));
      return false;
    }
    const created: DetailEntry[] = [];
    const resources: string[] = [];
    try {
      for (const file of sources) {
        const entryId = key('file', file.path);
        if (Buffer.byteLength(file.text) > this.store.bodyBudget(identity, '')) {
          this.store.markTruncated(identity);
          this.store.markIncomplete(identity, safe.text.slice(-512));
          return false;
        }
        const resourceId = this.files.create(detailTurnKey(identity), (id) => this.store.registerResource(id, detailTurnKey(identity)));
        resources.push(resourceId);
        if (!this.store.reserveResource(identity, resourceId, Buffer.byteLength(file.text))) {
          this.store.markTruncated(identity); return false;
        }
        let committedBytes = 0;
        for (let offset = 0; offset < file.text.length;) {
          let end = Math.min(offset + 8192, file.text.length);
          if (end < file.text.length && /[\uD800-\uDBFF]/.test(file.text[end - 1]!)) end--;
          committedBytes = this.files.append(resourceId, committedBytes, file.text.slice(offset, end));
          offset = end;
        }
        this.store.confirmResourceSize(identity, resourceId, committedBytes);
        created.push({ entryId, category: 'files', itemId: entryId, receivedAt,
          metadata: { path: file.path, added: file.added, removed: file.removed, binary: file.binary,
            complete: parsed.complete && !safe.redacted },
          resource: { resourceId, committedBytes, revision: (this.store.getEntry(identity, entryId)?.resource?.revision ?? 0) + 1,
            redacted: safe.redacted, truncated: false } });
      }
      const accepted = this.store.replaceFileEntries(identity, created, eventKey);
      if (!accepted) return false;
      resources.length = 0; // Newly committed resources now belong to the store.
      for (const entry of oldFiles) if (entry.resource) this.releaseResource(identity, entry.resource.resourceId);
      return true;
    } finally {
      for (const resource of resources) this.releaseResource(identity, resource);
    }
  }

  private releaseResource(identity: DetailTurnIdentity, id: string): void {
    try {
      this.store.retireResource(identity, id);
      this.files.remove(id);
      this.store.forgetResource(id);
    } catch { /* The retired resource remains charged and queued until unlink is confirmed. */ }
  }

  private dropTurnStreams(identity: DetailTurnIdentity, terminal = false): void {
    const prefix = `${detailTurnKey(identity)}:`;
    if (!terminal && [...this.streams.keys()].some((key) => key.startsWith(prefix))) {
      try { this.store.markStreamGap(identity); }
      catch { this.unsafeTurns.add(detailTurnKey(identity)); } // Fail closed in memory if the gap cannot be persisted.
    }
    if (terminal) this.unsafeTurns.delete(detailTurnKey(identity));
    for (const streamKey of this.streams.keys()) if (streamKey.startsWith(prefix)) this.streams.delete(streamKey);
  }

  private allEntries(identity: DetailTurnIdentity): DetailEntry[] {
    const entries: DetailEntry[] = [];
    let after: string | undefined;
    for (;;) {
      const page = this.store.listEntries(identity, after);
      entries.push(...page);
      if (page.length < 100) return entries;
      after = page.at(-1)!.entryId;
    }
  }
}

function key(...parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}
