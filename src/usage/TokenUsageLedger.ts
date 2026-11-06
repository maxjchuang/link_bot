import type { SqliteStateStore } from '../state/SqliteStateStore.js';
import type { TaskRecord } from '../tasks/TaskTypes.js';

export interface TokenBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export class TokenUsageLedger {
  constructor(private readonly store: SqliteStateStore, private readonly clock: () => Date = () => new Date()) {}

  record(input: {
    task: TaskRecord; threadId: string; turnId: string; usage: unknown; occurredAt?: string; returnTaskTotal?: boolean;
  }): TokenBreakdown | undefined {
    const cumulative = parseCumulative(input.usage);
    if (!cumulative) return undefined;
    const binding = this.store.getLatestTaskBinding(input.task.id);
    const context = this.store.getActiveTaskContext(input.task.id);
    const occurredAt = input.occurredAt ?? this.clock().toISOString();
    const transaction = this.store.db.transaction(() => {
      const previous = this.store.db.prepare(`
        SELECT input_tokens AS inputTokens, cached_input_tokens AS cachedInputTokens,
          output_tokens AS outputTokens, reasoning_tokens AS reasoningTokens, total_tokens AS totalTokens
        FROM token_usage_watermarks WHERE thread_id=?
      `).get(input.threadId) as TokenBreakdown | undefined;
      // App Server may replay an older or identical cumulative snapshot after
      // reconnect. A single Codex thread is monotonic, so never move backwards.
      if (previous && cumulative.totalTokens <= previous.totalTokens) {
        return input.returnTaskTotal === false ? undefined : this.totalForTask(input.task.id);
      }
      const delta = subtract(cumulative, previous);
      const sampleKey = `${input.threadId}:${cumulative.inputTokens}:${cumulative.cachedInputTokens}:${cumulative.outputTokens}:${cumulative.reasoningTokens}:${cumulative.totalTokens}`;
      this.store.db.prepare(`
        INSERT OR IGNORE INTO token_usage_ledger(
          sample_key, task_id, context_id, thread_id, turn_id, user_id, project_id, chat_id, topic_id, model,
          input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, total_tokens, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(sampleKey, input.task.id, context?.id ?? null, input.threadId, input.turnId,
        input.task.ownerUserId, input.task.projectId, binding?.chatId ?? null, binding?.topicId ?? null, input.task.model ?? null,
        delta.inputTokens, delta.cachedInputTokens, delta.outputTokens, delta.reasoningTokens, delta.totalTokens, occurredAt);
      this.store.db.prepare(`
        INSERT INTO token_usage_watermarks(thread_id, task_id, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, total_tokens, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET task_id=excluded.task_id, input_tokens=excluded.input_tokens,
          cached_input_tokens=excluded.cached_input_tokens, output_tokens=excluded.output_tokens,
          reasoning_tokens=excluded.reasoning_tokens, total_tokens=excluded.total_tokens, updated_at=excluded.updated_at
      `).run(input.threadId, input.task.id, cumulative.inputTokens, cumulative.cachedInputTokens,
        cumulative.outputTokens, cumulative.reasoningTokens, cumulative.totalTokens, occurredAt);
      return input.returnTaskTotal === false ? undefined : this.totalForTask(input.task.id);
    });
    return transaction.immediate();
  }

  backfill(): number {
    const rows = this.store.db.prepare(`
      SELECT payload, created_at AS occurredAt FROM turn_events
      WHERE event_type='usage.updated' ORDER BY sequence
    `).all() as Array<{ payload: string; occurredAt: string }>;
    let processed = 0;
    for (const row of rows) {
      let event: Record<string, unknown>;
      try { event = JSON.parse(row.payload) as Record<string, unknown>; } catch { continue; }
      if (typeof event.taskId !== 'string' || typeof event.threadId !== 'string' || typeof event.turnId !== 'string') continue;
      const task = this.store.getTask(event.taskId);
      if (!task) continue;
      this.record({
        task, threadId: event.threadId, turnId: event.turnId, usage: event.usage,
        occurredAt: row.occurredAt, returnTaskTotal: false,
      });
      processed += 1;
    }
    return processed;
  }

  totalForTask(taskId: string): TokenBreakdown {
    return aggregate(this.store, 'task_id=?', [taskId]);
  }

  totalForUser(userId: string, from?: string): TokenBreakdown {
    return aggregate(this.store, `user_id=?${from ? ' AND occurred_at>=?' : ''}`, from ? [userId, from] : [userId]);
  }

  totalForTaskSince(taskId: string, from: string): TokenBreakdown {
    return aggregate(this.store, 'task_id=? AND occurred_at>=?', [taskId, from]);
  }
}

function parseCumulative(value: unknown): TokenBreakdown | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const total = (value as Record<string, unknown>).total;
  if (!total || typeof total !== 'object' || Array.isArray(total)) return undefined;
  const record = total as Record<string, unknown>;
  const totalTokens = token(record.totalTokens);
  if (totalTokens === undefined) return undefined;
  return {
    inputTokens: token(record.inputTokens) ?? 0,
    cachedInputTokens: token(record.cachedInputTokens) ?? 0,
    outputTokens: token(record.outputTokens) ?? 0,
    reasoningTokens: token(record.reasoningOutputTokens) ?? 0,
    totalTokens,
  };
}

function token(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function subtract(current: TokenBreakdown, previous?: TokenBreakdown): TokenBreakdown {
  const delta = (key: keyof TokenBreakdown) => Math.max(0, current[key] - (previous?.[key] ?? 0));
  return {
    inputTokens: delta('inputTokens'), cachedInputTokens: delta('cachedInputTokens'),
    outputTokens: delta('outputTokens'), reasoningTokens: delta('reasoningTokens'), totalTokens: delta('totalTokens'),
  };
}

function aggregate(store: SqliteStateStore, where: string, params: unknown[]): TokenBreakdown {
  return store.db.prepare(`
    SELECT COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(cached_input_tokens), 0) AS cachedInputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens,
      COALESCE(SUM(reasoning_tokens), 0) AS reasoningTokens,
      COALESCE(SUM(total_tokens), 0) AS totalTokens
    FROM token_usage_ledger WHERE ${where}
  `).get(...params) as TokenBreakdown;
}

export function formatCompactTokens(value: number): string {
  if (value < 1_000) return String(value);
  const units = [[1_000_000_000, 'B'], [1_000_000, 'M'], [1_000, 'K']] as const;
  const [divisor, suffix] = units.find(([divisor]) => value >= divisor)!;
  const precision = suffix === 'K' ? 1 : 2;
  return `${(value / divisor).toFixed(precision).replace(/\.0+$|(?<=\.[0-9])0$/, '')}${suffix}`;
}

export function formatExactTokens(value: number): string {
  return value.toLocaleString('en-US');
}
