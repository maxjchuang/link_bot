import { describe, expect, it } from 'vitest';
import type { CodexBackendEvent } from '../../src/backends/CodexBackend.js';
import { adaptDetailEvent, detailTurnKey } from '../../src/details/DetailEventAdapter.js';

const binding = { ownerKind: 'task_platform' as const, taskId: 'task', localTurnId: 'local', threadId: 'thread', codexTurnId: 'turn' };
const base = { type: 'item.delta' as const, taskId: 'task', threadId: 'thread', turnId: 'turn', itemId: 'item', delta: 'a\nb' };

describe('detail event adapter', () => {
  it('retains only an allowlisted final-answer marker, not arbitrary message properties', () => {
    const result = adaptDetailEvent(binding,{type:'item.completed',taskId:'task',threadId:'thread',turnId:'turn',
      item:{id:'final',type:'agentMessage',phase:'final_answer',text:'public answer',opaquePrivateField:'do-not-copy'}});
    expect(result).toMatchObject({kind:'process_item',finalAnswer:true});
    expect(JSON.stringify(result)).not.toContain('do-not-copy');
  });
  it('keeps owners and arbitrary identifiers collision-free', () => {
    expect(detailTurnKey(binding)).not.toBe(detailTurnKey({ ...binding, ownerKind: 'host_manager' }));
    expect(detailTurnKey({ ...binding, taskId: 'a:b', localTurnId: 'c' }))
      .not.toBe(detailTurnKey({ ...binding, taskId: 'a', localTurnId: 'b:c' }));
  });

  it('rejects mismatched tasks, threads, turns and unbound turn events', () => {
    for (const change of [{ taskId: 'other' }, { threadId: 'other' }, { turnId: 'other' }]) {
      expect(adaptDetailEvent(binding, { ...base, channel: 'agent_message', ...change })).toBeUndefined();
    }
    expect(adaptDetailEvent({ ...binding, codexTurnId: undefined }, { ...base, channel: 'plan' })).toBeUndefined();
  });

  it('excludes raw and legacy mixed reasoning, preserving public summary boundaries', () => {
    expect(adaptDetailEvent(binding, { ...base, channel: 'reasoning' })).toBeUndefined();
    expect(adaptDetailEvent(binding, { ...base, channel: 'reasoning', reasoningSource: 'internal_reasoning' })).toBeUndefined();
    expect(adaptDetailEvent(binding, { ...base, channel: 'reasoning', reasoningSource: 'public_summary', summaryIndex: 3 }))
      .toMatchObject({ kind: 'process_delta', source: 'summary', partIndex: 3, text: 'a\nb' });
    expect(adaptDetailEvent(binding, { ...base, channel: 'plan' })).toMatchObject({ source: 'plan' });
    expect(adaptDetailEvent(binding, { ...base, channel: 'agent_message' })).toMatchObject({ source: 'progress' });
  });

  it('keeps combined output and missing command metadata honest without mutating input', () => {
    expect(adaptDetailEvent(binding, { ...base, channel: 'command' })).toMatchObject({ kind: 'command_delta', stream: 'combined' });
    const event: CodexBackendEvent = { type: 'item.completed', taskId: 'task', threadId: 'thread', turnId: 'turn',
      item: { id: 'cmd', type: 'commandExecution', command: 'pwd', exitCode: 0, aggregatedOutput: 'ignored large body' } };
    const before = JSON.stringify(event);
    expect(adaptDetailEvent(binding, event)).toEqual({ kind: 'command_item', itemId: 'cmd', completed: true, command: 'pwd', exitCode: 0,
      aggregatedOutput: 'ignored large body' });
    expect(JSON.stringify(event)).toBe(before);
  });
});
