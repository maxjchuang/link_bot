import type { CodexBackendEvent } from '../backends/CodexBackend.js';
import { isSensitiveDetailCommand, sanitizeDetailText } from '../details/DetailSanitizer.js';
import { parseDiffSnapshot } from '../details/DiffSnapshotParser.js';

export interface TurnCardActivity {
  id: string;
  title: string;
  status: 'running' | 'completed' | 'failed';
}
export interface TurnCardSummary {
  activities: TurnCardActivity[];
  commands: number;
  completedCommands: number;
  failedCommands: number;
  recentResult?: string;
  files?: number;
  added?: number;
  removed?: number;
  incomplete: boolean;
}

/** Bounded, replay-idempotent facts. Never infer test success or file counts from model prose. */
export class TurnCardSummaryProjection {
  private readonly commands = new Map<string, { completed: boolean; failed: boolean; title: string }>();
  private readonly activities = new Map<string, TurnCardActivity>();
  private fileStats: Pick<TurnCardSummary, 'files' | 'added' | 'removed'> = {};
  private recentResult?: string;
  private incomplete = false;
  private diffIncomplete = false;
  private completedCommands = 0;
  private failedCommands = 0;

  reset(): void {
    this.commands.clear(); this.activities.clear(); this.fileStats = {};
    this.recentResult = undefined; this.incomplete = false; this.diffIncomplete = false;
    this.completedCommands = 0; this.failedCommands = 0;
  }
  append(event: CodexBackendEvent): void {
    if (event.type === 'turn.started') { this.reset(); return; }
    if (event.type === 'item.delta' && event.channel === 'command' && !this.commands.has(event.itemId)) {
      this.item({ id: event.itemId, type: 'commandExecution' }, false);
    }
    if (event.type === 'turn.diff') {
      const safe = sanitizeDetailText(event.diff.slice(0, 256 * 1024));
      const diff = parseDiffSnapshot(safe.text);
      this.diffIncomplete = event.diff.trim() !== '' && (!diff.complete || safe.redacted || event.diff.length > 256 * 1024);
      this.fileStats = diff.files.length || event.diff.trim() === ''
        ? { files: diff.files.length, added: diff.files.reduce((n, file) => n + file.added, 0),
          removed: diff.files.reduce((n, file) => n + file.removed, 0) } : {};
      if (diff.files.length) this.activity({ id: 'diff', title: `已记录 ${diff.files.length} 个文件的变更`, status: 'completed' });
    }
    if (event.type === 'item.started' || event.type === 'item.completed') this.item(event.item, event.type === 'item.completed');
    if (event.type === 'turn.completed' && event.turn && typeof event.turn === 'object'
      && 'items' in event.turn && Array.isArray(event.turn.items)) {
      for (const item of event.turn.items) this.item(item, true);
    }
  }
  get(): TurnCardSummary {
    return { activities: [...this.activities.values()].map((activity) => ({ ...activity })),
      commands: this.commands.size, completedCommands: this.completedCommands, failedCommands: this.failedCommands, recentResult: this.recentResult,
      ...this.fileStats, incomplete: this.incomplete || this.diffIncomplete };
  }
  private item(raw: unknown, completed: boolean): void {
    if (!raw || typeof raw !== 'object') return;
    const item = raw as Record<string, unknown>;
    if (item.type !== 'commandExecution' && item.type !== 'fileChange' && item.type !== 'mcpToolCall') return;
    if (typeof item.id !== 'string' || item.id.length > 128) { this.incomplete = true; return; }
    const id = `${item.type}:${item.id}`;
    if (item.type === 'commandExecution') {
      const previous = this.commands.get(item.id);
      if (previous?.completed && !completed) return; // A late start cannot resurrect an ended command.
      if (!previous && this.commands.size >= 2048) { this.incomplete = true; return; }
      const failed = item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0);
      const title = typeof item.command === 'string'
        ? isSensitiveDetailCommand(item.command) ? '执行敏感操作（详情已保护）' : `执行 ${shortText(item.command)}`
        : '执行命令（名称未上报）';
      if (previous?.completed === completed && previous.failed === (completed && failed) && previous.title === title) return;
      this.completedCommands += Number(completed) - Number(previous?.completed ?? false);
      this.failedCommands += Number(completed && failed) - Number(previous?.failed ?? false);
      this.commands.set(item.id, { completed, failed: completed && failed, title });
      this.activity({ id, title, status: completed ? failed ? 'failed' : 'completed' : 'running' });
      if (completed) this.recentResult = failed ? `命令失败${typeof item.exitCode === 'number' ? `，退出码 ${item.exitCode}` : ''}`
        : `命令已完成${typeof item.exitCode === 'number' ? `，退出码 ${item.exitCode}` : '，退出码未上报'}`;
    } else {
      const prior = this.activities.get(id);
      if (prior && prior.status !== 'running' && !completed) return;
      this.activity({ id, title: item.type === 'fileChange' ? '处理文件变更' : '调用工具',
        status: item.status === 'failed' ? 'failed' : completed ? 'completed' : 'running' });
    }
  }
  private activity(activity: TurnCardActivity): void {
    this.activities.delete(activity.id); this.activities.set(activity.id, activity);
    while (this.activities.size > 3) this.activities.delete(this.activities.keys().next().value!);
  }
}

function shortText(text: string): string {
  return sanitizeDetailText(text).text.replace(/\s+/g, ' ').slice(0, 100);
}
