import type { CodexBackendEvent } from '../backends/CodexBackend.js';
import type { DetailCandidate, DetailTurnBinding, DetailTurnIdentity } from './TurnDetailTypes.js';

export function detailTurnKey(identity: DetailTurnIdentity): string {
  return JSON.stringify([identity.ownerKind, identity.taskId, identity.localTurnId]);
}

/** Field allowlist: never copy opaque item objects (which may contain raw reasoning). */
export function adaptDetailEvent(binding: DetailTurnBinding, event: CodexBackendEvent): DetailCandidate | undefined {
  if (event.taskId !== binding.taskId || !('threadId' in event) || event.threadId !== binding.threadId
    || !('turnId' in event) || !binding.codexTurnId || event.turnId !== binding.codexTurnId) return undefined;
  if (event.type === 'item.summary_part') return { kind: 'process_part', itemId: event.itemId, partIndex: event.summaryIndex };
  if (event.type === 'item.delta') {
    if (event.channel === 'reasoning' && event.reasoningSource !== 'public_summary') return undefined;
    if (event.channel === 'command') return { kind: 'command_delta', itemId: event.itemId,
      stream: event.outputStream ?? 'combined', text: event.delta };
    if (event.channel === 'file_change') return undefined; // Only cumulative turn.diff is a file snapshot.
    return { kind: 'process_delta', itemId: event.itemId,
      source: event.channel === 'reasoning' ? 'summary' : event.channel === 'plan' ? 'plan' : 'progress',
      ...(event.summaryIndex !== undefined ? { partIndex: event.summaryIndex } : {}), text: event.delta };
  }
  if (event.type === 'turn.diff') return { kind: 'diff_snapshot', text: event.diff };
  if (event.type === 'turn.completed') return { kind: 'terminal', lifecycle: event.status === 'completed' ? 'completed'
    : event.status === 'interrupted' ? 'interrupted' : 'failed' };
  if (event.type !== 'item.started' && event.type !== 'item.completed') return undefined;
  const item = event.item;
  if (!isRecord(item) || typeof item.id !== 'string') return undefined;
  if (item.type === 'agentMessage' || item.type === 'plan' || item.type === 'reasoning') {
    const segments: Extract<DetailCandidate, { kind: 'process_item' }>['segments'] = item.type === 'reasoning'
      ? (Array.isArray(item.summary) ? item.summary.flatMap((text, partIndex) => typeof text === 'string' ? [{ source: 'summary' as const, partIndex, text }] : []) : [])
      : typeof item.text === 'string' ? [{ source: item.type === 'plan' ? 'plan' : 'progress', text: item.text }] : [];
    return { kind: 'process_item', itemId: item.id, completed: event.type === 'item.completed', segments,
      ...(item.type === 'agentMessage' && item.phase === 'final_answer' ? {finalAnswer:true as const} : {}) };
  }
  if (item.type !== 'commandExecution') return undefined;
  return { kind: 'command_item', itemId: item.id, completed: event.type === 'item.completed',
    ...(typeof item.command === 'string' ? { command: item.command } : {}),
    ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}),
    ...(typeof item.status === 'string' ? { status: item.status } : {}),
    ...(typeof item.exitCode === 'number' && Number.isSafeInteger(item.exitCode) ? { exitCode: item.exitCode } : {}),
    ...(event.startedAtMs !== undefined ? { startedAtMs: event.startedAtMs } : {}),
    ...(event.completedAtMs !== undefined ? { completedAtMs: event.completedAtMs } : {}),
    ...(typeof item.durationMs === 'number' && Number.isSafeInteger(item.durationMs) && item.durationMs >= 0 ? { durationMs: item.durationMs } : {}),
    ...(event.type === 'item.completed' && typeof item.aggregatedOutput === 'string' ? { aggregatedOutput: item.aggregatedOutput } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
