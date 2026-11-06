import { randomBytes } from 'node:crypto';
import type { DetailAccessPolicy, DetailReadContext } from './DetailAccessPolicy.js';
import type { DetailResourceStore } from './DetailResourceStore.js';
import type { TurnDetailStore } from './TurnDetailStore.js';
import type { DetailViewStore } from './DetailViewStore.js';
import { detailTurnKey } from './DetailEventAdapter.js';
import { TURN_DETAIL_SCHEMA_VERSION, TURN_DETAIL_RETENTION_MS, type DetailCategory, type DetailEntry, type DetailTurnIdentity } from './TurnDetailTypes.js';

interface BodyCursor {
  kind?: 'body';
  identityKey: string; viewerId: string; entry: DetailEntry; offset: number; expiresAt: number;
  nextRef?: string;
}

export interface DetailBodyPage { entry: DetailEntry; text: string; nextCursorRef?: string; truncated: boolean; missing: boolean }
export interface DetailListEntry extends DetailEntry { preview?: string; previewMissing?: boolean; previewHasMore?: boolean }

/** Read-only query foundation. Cursor persistence and card/browser publishing belong to the UI adapter. */
export class TurnDetailService {
  private readonly cursors = new Map<string, BodyCursor>();
  constructor(private readonly store: TurnDetailStore, private readonly files: DetailResourceStore,
    private readonly access: DetailAccessPolicy, private readonly clock: () => Date = () => new Date(), private readonly views?: DetailViewStore) {}

  async requireRead(identity: DetailTurnIdentity, actor: DetailReadContext): Promise<void> {
    let turn = this.store.getTurn(identity);
    if (!turn) throw new Error('not_found');
    if (turn.schemaVersion !== TURN_DETAIL_SCHEMA_VERSION) throw new Error('temporarily_unavailable');
    await this.access.requireRead(turn.scope, actor);
    turn = this.store.getTurn(identity);
    if (!turn) throw new Error('not_found');
    if (!['running', 'completed', 'failed', 'interrupted'].includes(turn.lifecycle)
      || !Number.isFinite(this.clock().getTime())) throw new Error('temporarily_unavailable');
    if (turn.availability === 'cleared') throw new Error('cleared');
    if (turn.availability !== 'available' || (turn.lifecycle !== 'running' && (!turn.endedAt || !Number.isFinite(Date.parse(turn.endedAt))
      || this.clock().getTime() >= Date.parse(turn.endedAt) + TURN_DETAIL_RETENTION_MS))) throw new Error('expired');
  }

  async list(identity: DetailTurnIdentity, category: DetailCategory, actor: DetailReadContext, cursorRef?: string): Promise<{ entries: DetailListEntry[]; nextCursorRef?: string }> {
    await this.requireRead(identity, actor);
    if (!['process', 'commands', 'files'].includes(category)) throw new Error('invalid_cursor');
    const now = this.clock().getTime();
    let state = { kind: 'list', category, after: 0, through: this.store.categorySequence(identity, category) };
    if (cursorRef) {
      const loaded = this.views?.getCursor(cursorRef, identity, actor.userId, new Date(now).toISOString()) as typeof state | undefined;
      if (!loaded || loaded.kind !== 'list' || loaded.category !== category) throw new Error('invalid_cursor');
      state = loaded;
      if (category === 'files' && state.through !== this.store.categorySequence(identity, category)) throw new Error('snapshot_changed');
    }
    const rows = this.store.categoryPage(identity, category, state.after, state.through, 9);
    const selected = rows.slice(0, 8);
    if (rows.length > 8 && !this.views) throw new Error('temporarily_unavailable');
    const nextCursorRef = rows.length > 8 && this.views ? this.views.saveCursor(identity, actor.userId,
      { ...state, after: selected.at(-1)!.sequence }, new Date(now + 10 * 60 * 1000).toISOString()) : undefined;
    return { entries: selected.map((row) => this.preview(row.entry)), nextCursorRef };
  }

  private preview(entry: DetailEntry): DetailListEntry {
    // Read only sanitized committed prefixes, after authorization. No cursor writes per preview.
    if (!entry.resource) return { ...entry, previewMissing: true };
    try {
      const bytes = this.files.readBytes(entry.resource.resourceId, entry.resource.committedBytes, 0, 772);
      let length = Math.min(768, bytes.length);
      while (length < bytes.length && length > 0 && (bytes[length]! & 0xc0) === 0x80) length--;
      return { ...entry, preview: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)),
        previewHasMore: entry.resource.committedBytes > length };
    } catch { return { ...entry, previewMissing: true }; }
  }

  async readEntry(identity: DetailTurnIdentity, entryId: string, actor: DetailReadContext, cursorRef?: string): Promise<DetailBodyPage> {
    try { return await this.readEntryFromStore(identity, entryId, actor, cursorRef); }
    catch (error) {
      const allowed = new Set(['not_found', 'access_denied', 'cleared', 'expired', 'invalid_cursor', 'snapshot_changed', 'temporarily_unavailable']);
      throw new Error(error instanceof Error && allowed.has(error.message) ? error.message : 'temporarily_unavailable');
    }
  }

  dispose(): void { this.cursors.clear(); }

  private async readEntryFromStore(identity: DetailTurnIdentity, entryId: string, actor: DetailReadContext, cursorRef?: string): Promise<DetailBodyPage> {
    let turn = this.store.getTurn(identity);
    if (!turn) throw new Error('not_found');
    if (turn.schemaVersion !== TURN_DETAIL_SCHEMA_VERSION) throw new Error('temporarily_unavailable');
    await this.access.requireRead(turn.scope, actor);
    turn = this.store.getTurn(identity);
    if (!turn) throw new Error('not_found');
    const now = this.clock().getTime();
    if (!Number.isFinite(now) || !['running', 'completed', 'failed', 'interrupted'].includes(turn.lifecycle)
      || !['available', 'expired', 'cleared'].includes(turn.availability)) throw new Error('temporarily_unavailable');
    if (turn.lifecycle !== 'running' && (!turn.endedAt || !Number.isFinite(Date.parse(turn.endedAt)))) throw new Error('temporarily_unavailable');
    if (turn.availability === 'cleared') throw new Error('cleared');
    if (turn.availability === 'expired' || (turn.lifecycle !== 'running' && turn.endedAt
      && now >= Date.parse(turn.endedAt) + TURN_DETAIL_RETENTION_MS)) throw new Error('expired');
    for (const [ref, state] of this.cursors) if (state.expiresAt <= now) this.cursors.delete(ref);
    const current = this.store.getEntry(identity, entryId);
    if (!current) throw new Error('not_found');
    let cursor: BodyCursor;
    if (cursorRef) {
      const existing = (this.views?.getCursor(cursorRef, identity, actor.userId, new Date(now).toISOString()) as BodyCursor | undefined) ?? this.cursors.get(cursorRef);
      if (!existing || existing.kind !== 'body' || !existing.entry || existing.identityKey !== detailTurnKey(identity) || existing.viewerId !== actor.userId || existing.entry.entryId !== entryId) {
        throw new Error('invalid_cursor');
      }
      cursor = existing;
      if (current.resource?.resourceId !== cursor.entry.resource?.resourceId) throw new Error('snapshot_changed');
    } else cursor = { kind: 'body', identityKey: detailTurnKey(identity), viewerId: actor.userId,
      entry: structuredClone(current), offset: 0, expiresAt: now + 10 * 60 * 1000 };
    const resource = cursor.entry.resource;
    if (!resource) return { entry: structuredClone(cursor.entry), text: '', truncated: turn.truncated, missing: true };
    if (resource.committedBytes > (current.resource?.committedBytes ?? 0)) throw new Error('snapshot_changed');
    let text: string, count: number;
    try {
      const bytes = this.files.readBytes(resource.resourceId, resource.committedBytes, cursor.offset, 4100);
      count = Math.min(4096, bytes.length);
      // Four extra bytes let us back up to a whole UTF-8 character at the page boundary.
      while (count < bytes.length && count > 0 && (bytes[count]! & 0xc0) === 0x80) count--;
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count));
    } catch { throw new Error('temporarily_unavailable'); }
    const offset = cursor.offset + count;
    let nextCursorRef: string | undefined;
    if (offset < resource.committedBytes) {
      if (this.views) {
        nextCursorRef = this.views.saveCursor(identity, actor.userId, { ...cursor, offset, nextRef: undefined }, new Date(cursor.expiresAt).toISOString());
      } else if (!cursor.nextRef || !this.cursors.has(cursor.nextRef)) {
        const nextRef = randomBytes(16).toString('hex');
        if (this.cursors.size >= 128) this.cursors.delete(this.cursors.keys().next().value!);
        this.cursors.set(nextRef, { ...cursor, offset, nextRef: undefined });
        cursor.nextRef = nextRef;
      }
      if (!this.views) nextCursorRef = cursor.nextRef;
    }
    return { entry: structuredClone(cursor.entry), text, nextCursorRef, truncated: turn.truncated || resource.truncated,
      missing: turn.incomplete === true || cursor.entry.missing === true };
  }
}
