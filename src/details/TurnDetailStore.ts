import type { DetailCategory, DetailEntry, DetailTurnIdentity, DetailTurnRecord } from './TurnDetailTypes.js';

/** Only sanitized display copies belong here, never execution payloads. */
export interface TurnDetailStore {
  claimWriter(identity: DetailTurnIdentity, owner: string): void;
  releaseWriter(identity: DetailTurnIdentity, owner: string): void;
  releaseWriters(owner: string): void;
  createTurn(record: DetailTurnRecord): DetailTurnRecord;
  getTurn(identity: DetailTurnIdentity): DetailTurnRecord | undefined;
  getEntry(identity: DetailTurnIdentity, entryId: string): DetailEntry | undefined;
  hasEvent(identity: DetailTurnIdentity, eventKey: string): boolean;
  markIncomplete(identity: DetailTurnIdentity, safeTail?: string): void;
  markStreamGap(identity: DetailTurnIdentity): void;
  hasStreamGap(identity: DetailTurnIdentity, entryId?: string): boolean;
  markTruncated(identity: DetailTurnIdentity): void;
  bodyBudget(identity: DetailTurnIdentity, entryId: string): number;
  registerResource(id: string, ownerKey?: string): void;
  reserveResource(identity: DetailTurnIdentity, id: string, bytes: number): boolean;
  confirmResourceSize(identity: DetailTurnIdentity, id: string, bytes: number): void;
  retireResource(identity: DetailTurnIdentity, id: string): void;
  forgetResource(id: string): void;
  replaceFileEntries(identity: DetailTurnIdentity, entries: DetailEntry[], eventKey: string): boolean;
  putEntry(identity: DetailTurnIdentity, entry: DetailEntry, eventKey: string): boolean;
  listEntries(identity: DetailTurnIdentity, afterEntryId?: string, limit?: number): DetailEntry[];
  categorySequence(identity: DetailTurnIdentity, category: DetailCategory): number;
  categoryTail?(identity: DetailTurnIdentity, category: DetailCategory, limit: number): { total: number; entries: DetailEntry[] };
  timelineTail?(identity: DetailTurnIdentity, limit: number): { total: number; entries: DetailEntry[] };
  categoryPage(identity: DetailTurnIdentity, category: DetailCategory, after: number, through: number, limit: number): Array<{ entry: DetailEntry; sequence: number }>;
  completeTurn(identity: DetailTurnIdentity, lifecycle: 'completed' | 'failed' | 'interrupted', endedAt: string): void;
  close?(): void;
}
