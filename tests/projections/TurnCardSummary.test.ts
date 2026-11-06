import { describe, expect, it } from 'vitest';
import { LiveTurnProjection } from '../../src/projections/LiveTurnProjection.js';

const context = { taskId: 'task', turnId: 'turn', threadId: 'thread' };
function fixture() { const p = new LiveTurnProjection(); p.append({ type: 'turn.started', ...context }); return p; }
describe('running-card fact summary', () => {
  it('counts an observed command-output identity even when its start metadata was missed, without retaining output', () => {
    const p = fixture();
    const event = { type: 'item.delta' as const, ...context, itemId: 'cmd', channel: 'command' as const, delta: 'fake-private-output' };
    p.append(event); p.append(event);
    expect(p.get('task')?.summary).toMatchObject({ commands: 1, completedCommands: 0 });
    expect(JSON.stringify(p.get('task')?.summary)).not.toContain('fake-private-output');
    expect(JSON.stringify(p.get('task')?.summary)).toContain('名称未上报');
  });
  it('counts commands by identity, handles late starts and duplicate completions, and never infers tests passed', () => {
    const p = fixture();
    const event = { type: 'item.completed' as const, ...context, item: { id: 'one', type: 'commandExecution', command: 'npm test', exitCode: 1 } };
    p.append({ ...event, type: 'item.started' }); p.append(event); p.append(event); p.append({ ...event, type: 'item.started' });
    p.append({ ...event, item: { ...event.item, id: 'two', exitCode: 0 } });
    expect(p.get('task')?.summary).toMatchObject({ commands: 2, completedCommands: 2, failedCommands: 1, incomplete: false });
    const before = p.get('task')!.summary;
    p.append(event);
    expect(p.get('task')!.summary).toEqual(before);
    expect(JSON.stringify(before)).not.toContain('验证通过');
    p.append({ type: 'turn.started', ...context, turnId: 'next' });
    expect(p.get('task')?.summary).toMatchObject({ commands: 0, failedCommands: 0, activities: [] });
  });
  it('replaces cumulative diff counts rather than adding the same snapshot repeatedly', () => {
    const p = fixture();
    const diff = 'diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1,2 @@\n-old\n+new\n+more\n';
    p.append({ type: 'turn.diff', ...context, diff }); p.append({ type: 'turn.diff', ...context, diff });
    expect(p.get('task')?.summary).toMatchObject({ files: 1, added: 2, removed: 1, incomplete: false });
    p.append({ type: 'turn.diff', ...context, diff: '' });
    expect(p.get('task')?.summary).toMatchObject({ files: 0, added: 0, removed: 0, incomplete: false });
  });
  it('keeps only three recent activities, marks incomplete identity/budget data and protects sensitive commands', () => {
    const p = fixture();
    for (let n = 0; n < 2050; n++) p.append({ type: 'item.completed', ...context,
      item: { type: 'commandExecution', id: String(n), command: 'cat /codex/auth.json', aggregatedOutput: 'fake-private-value', exitCode: 0 } });
    const summary = p.get('task')!.summary!;
    expect(summary.commands).toBe(2048); expect(summary.activities).toHaveLength(3); expect(summary.incomplete).toBe(true);
    expect(JSON.stringify(summary)).not.toContain('auth.json'); expect(JSON.stringify(summary)).not.toContain('fake-private-value');
    expect(JSON.stringify(summary).length).toBeLessThan(1000);
  });
});
