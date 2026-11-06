import { NoActiveTurnError } from '../../src/backends/CodexBackend.js';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { AppServerConnection } from '../../src/appserver/AppServerConnection.js';
import {
  AppServerCodexBackend,
  type AppServerRuntime,
  type AppServerRuntimeFactory,
} from '../../src/appserver/AppServerCodexBackend.js';

describe('AppServerCodexBackend', () => {
  it('rejects a missing or changed steer target before sending any RPC', async () => {
    const harness = new RuntimeHarness();
    const backend = harness.backend();
    await backend.startTask({ taskId: 'task_1', cwd: '/workspace', args: [] });
    expect(() => backend.assertSteerTarget('task_1')).toThrow(NoActiveTurnError);
    await expect(backend.steerTurn({ taskId: 'task_1', prompt: 'follow' })).rejects.toBeInstanceOf(NoActiveTurnError);
    expect(harness.requestsFor('turn/steer')).toHaveLength(0);
    await backend.startTurn({ taskId: 'task_1', prompt: 'work' });
    await expect(backend.steerTurn({ taskId: 'task_1', prompt: 'follow', expectedTurnId: 'another' })).rejects.toThrow('changed');
    expect(harness.requestsFor('turn/steer')).toHaveLength(0);
    await backend.stopTask('task_1');
  });

  it('preserves public summary boundaries separately from internal reasoning and repeated deltas', async () => {
    const harness = new RuntimeHarness();
    const backend = harness.backend();
    await backend.startTask({ taskId: 'task_1', cwd: '/workspace', args: [] });
    const events = backend.events('task_1')[Symbol.asyncIterator]();
    const base = { threadId: 'thread_1', turnId: 'turn_1', itemId: 'reason_1' };
    harness.send('task_1', [
      { method: 'unknown/futureNotification', params: base },
      { method: 'item/reasoning/summaryPartAdded', params: { ...base, summaryIndex: 2 } },
      { method: 'item/reasoning/summaryTextDelta', params: { ...base, summaryIndex: 2, delta: 'same\n' } },
      { method: 'item/reasoning/summaryTextDelta', params: { ...base, summaryIndex: 2, delta: 'same\n' } },
      { method: 'item/reasoning/textDelta', params: { ...base, contentIndex: 0, delta: 'private reasoning' } },
      { method: 'item/commandExecution/outputDelta', params: { ...base, itemId: 'cmd_1', delta: 'output' } },
    ]);
    await expect(nextValues(events, 5)).resolves.toEqual([
      { type: 'item.summary_part', taskId: 'task_1', ...base, summaryIndex: 2 },
      { type: 'item.delta', taskId: 'task_1', ...base, channel: 'reasoning', reasoningSource: 'public_summary', summaryIndex: 2, delta: 'same\n' },
      { type: 'item.delta', taskId: 'task_1', ...base, channel: 'reasoning', reasoningSource: 'public_summary', summaryIndex: 2, delta: 'same\n' },
      { type: 'item.delta', taskId: 'task_1', ...base, channel: 'reasoning', reasoningSource: 'internal_reasoning', contentIndex: 0, delta: 'private reasoning' },
      { type: 'item.delta', taskId: 'task_1', ...base, itemId: 'cmd_1', channel: 'command', outputStream: 'combined', delta: 'output' },
    ]);
  });

  it('preserves request resolution identity and upstream item times without inventing missing fields', async () => {
    const harness = new RuntimeHarness();
    const backend = harness.backend();
    await backend.startTask({ taskId: 'task_1', cwd: '/workspace', args: [] });
    const events = backend.events('task_1')[Symbol.asyncIterator]();
    harness.send('task_1', [
      { method: 'serverRequest/resolved', params: { threadId: 'other', requestId: 4 } },
      { method: 'serverRequest/resolved', params: { threadId: 'thread_1', requestId: 4 } },
      { method: 'item/started', params: { threadId: 'thread_1', turnId: 'turn_old', item: { id: 'cmd_1', type: 'commandExecution' } } },
      { method: 'item/completed', params: { threadId: 'thread_1', turnId: 'turn_old', completedAtMs: 42, item: { id: 'cmd_1', type: 'commandExecution', exitCode: 1 } } },
    ]);
    await expect(nextValues(events, 3)).resolves.toEqual([
      { type: 'backend.server_request_resolved', taskId: 'task_1', threadId: 'thread_1', generation: 1, requestId: 4 },
      { type: 'item.started', taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_old', item: { id: 'cmd_1', type: 'commandExecution' } },
      { type: 'item.completed', taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_old', completedAtMs: 42, item: { id: 'cmd_1', type: 'commandExecution', exitCode: 1 } },
    ]);
  });

  it('starts a thread with translated options and projects structured turn events', async () => {
    const harness = new RuntimeHarness();
    const backend = harness.backend();
    await expect(backend.startTask({
      taskId: 'task_1', cwd: '/workspace', codexHome: '/codex-home',
      args: ['--model', 'gpt-5.5', '--sandbox=workspace-write', '--ask-for-approval', 'on-request'],
    })).resolves.toEqual({
      taskId: 'task_1', threadId: 'thread_1', generation: 1,
      model: 'gpt-5.6-sol', reasoningEffort: 'high',
    });
    expect(harness.requestsFor('initialize')[0]?.params).toMatchObject({ capabilities: { experimentalApi: true } });
    expect(harness.requestsFor('thread/start')[0]?.params).toEqual({
      cwd: '/workspace', model: 'gpt-5.5', sandbox: 'workspace-write', approvalPolicy: 'on-request',
    });
    expect(harness.generations).toEqual([1]);

    const events = backend.events('task_1')[Symbol.asyncIterator]();
    harness.send('task_1', [
      { method: 'turn/started', params: { threadId: 'thread_1', turn: { id: 'turn_1', items: [], status: 'inProgress' } } },
      { method: 'item/started', params: { threadId: 'thread_1', turnId: 'turn_1', startedAtMs: 1, item: { id: 'item_1', type: 'agentMessage' } } },
      { method: 'item/agentMessage/delta', params: { threadId: 'thread_1', turnId: 'turn_1', itemId: 'item_1', delta: 'hello' } },
      { method: 'turn/diff/updated', params: { threadId: 'thread_1', turnId: 'turn_1', diff: 'diff text' } },
      { method: 'thread/tokenUsage/updated', params: { threadId: 'thread_1', turnId: 'turn_1', tokenUsage: { total: 42 } } },
      { method: 'item/completed', params: { threadId: 'thread_1', turnId: 'turn_1', completedAtMs: 2, item: { id: 'item_1', type: 'agentMessage', text: 'hello' } } },
      { method: 'turn/completed', params: { threadId: 'thread_1', turn: { id: 'turn_1', items: [], status: 'completed' } } },
    ]);

    await expect(nextValues(events, 7)).resolves.toEqual([
      { type: 'turn.started', taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_1' },
      { type: 'item.started', taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_1', startedAtMs: 1, item: { id: 'item_1', type: 'agentMessage' } },
      { type: 'item.delta', taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_1', itemId: 'item_1', channel: 'agent_message', delta: 'hello' },
      { type: 'turn.diff', taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_1', diff: 'diff text' },
      { type: 'usage.updated', taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_1', usage: { total: 42 } },
      { type: 'item.completed', taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_1', completedAtMs: 2, item: { id: 'item_1', type: 'agentMessage', text: 'hello' } },
      expect.objectContaining({
        type: 'turn.completed', taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_1', status: 'completed',
        turn: expect.objectContaining({
          itemsView: 'loaded',
          items: [{ id: 'item_1', type: 'agentMessage', text: 'hello' }],
        }),
      }),
    ]);
    expect(backend.readObservedTurn!('task_1', 'turn_1')).toEqual({
      id: 'turn_1', status: 'completed',
      raw: { id: 'turn_1', items: [], status: 'completed' },
    });
    expect(harness.requestsFor('thread/read')).toHaveLength(0);
  });

  it('does not send start-only dynamic tools to thread/resume', async () => {
    const harness = new RuntimeHarness();
    const dynamicTools = [{ name: 'artifacts', tools: [{ name: 'artifact_publish' }] }];
    const backend = harness.backend(undefined, { dynamicTools });
    await backend.startTask({ taskId: 'new_task', cwd: '/workspace', args: [] });
    expect(harness.requestsFor('thread/start')[0]?.params).toMatchObject({ dynamicTools });
    await backend.resumeContext!({ taskId: 'new_task', threadId: 'old_thread' });
    expect(harness.requestsFor('thread/resume')[0]?.params).not.toHaveProperty('dynamicTools');
    await backend.resumeTask({ taskId: 'old_task', threadId: 'old_thread', cwd: '/workspace', args: [] });
    expect(harness.requestsFor('thread/resume')[1]?.params).not.toHaveProperty('dynamicTools');
    await backend.createContext!({ taskId: 'old_task' });
    expect(harness.requestsFor('thread/start').at(-1)?.params).toMatchObject({ dynamicTools });
  });

  it('translates a complete execution profile and preserves requested values omitted by the server', async () => {
    const harness = new RuntimeHarness();
    harness.threadStartResult = { thread: { id: 'thread_profile' } };
    const backend = harness.backend();
    await expect(backend.startTask({
      taskId: 'task_profile', cwd: '/workspace', args: [],
      executionProfile: { model: 'gpt-5.6-terra', reasoningEffort: 'medium', serviceTier: 'fast' },
    })).resolves.toMatchObject({
      model: 'gpt-5.6-terra', reasoningEffort: 'medium', serviceTier: 'fast',
    });
    expect(harness.requestsFor('thread/start')[0]?.params).toMatchObject({
      model: 'gpt-5.6-terra', serviceTier: 'fast',
    });
    expect(harness.requestsFor('thread/start')[0]?.params).not.toHaveProperty('reasoningEffort');
    await backend.startTurn({
      taskId: 'task_profile', prompt: 'inspect',
      executionProfile: { model: 'gpt-5.6-terra', reasoningEffort: 'medium', serviceTier: 'fast' },
    });
    expect(harness.requestsFor('turn/start')[0]?.params).toMatchObject({
      model: 'gpt-5.6-terra', effort: 'medium', serviceTier: 'fast',
    });
  });

  it('starts, steers, and interrupts the active turn with protocol preconditions', async () => {
    const harness = new RuntimeHarness();
    const backend = harness.backend();
    await backend.startTask({ taskId: 'task_1', cwd: '/workspace', args: [] });

    await expect(backend.startTurn({ taskId: 'task_1', prompt: 'inspect' })).resolves.toEqual({ turnId: 'turn_1' });
    expect(harness.requestsFor('turn/start')[0]?.params).toEqual({
      threadId: 'thread_1', input: [{ type: 'text', text: 'inspect' }],
    });
    await backend.steerTurn({
      taskId: 'task_1', prompt: 'focus tests', images: [{ url: 'data:image/png;base64,AQ==', detail: 'low' }],
    });
    expect(harness.requestsFor('turn/steer')[0]?.params).toEqual({
      threadId: 'thread_1', expectedTurnId: 'turn_1', input: [
        { type: 'text', text: 'focus tests' },
        { type: 'image', url: 'data:image/png;base64,AQ==', detail: 'low' },
      ],
    });
    await backend.interruptTurn({ taskId: 'task_1' });
    await backend.startTurn({ taskId: 'task_1', prompt: 'inspect screenshot', images: [
      { url: 'data:image/png;base64,AQ==', detail: 'high' },
    ] });
    expect(harness.requestsFor('turn/start')[1]?.params).toEqual({
      threadId: 'thread_1', input: [
        { type: 'text', text: 'inspect screenshot' },
        { type: 'image', url: 'data:image/png;base64,AQ==', detail: 'high' },
      ],
    });
    await backend.interruptTurn({ taskId: 'task_1' });
    expect(harness.requestsFor('turn/interrupt')[0]?.params).toEqual({ threadId: 'thread_1', turnId: 'turn_1' });
  });

  it('tolerates empty and structured turn diffs without disconnecting the task', async () => {
    const harness = new RuntimeHarness();
    const warnings: unknown[] = [];
    const backend = harness.backend((warning) => warnings.push(warning));
    await backend.startTask({ taskId: 'task_1', cwd: '/workspace', args: [] });
    const events = backend.events('task_1')[Symbol.asyncIterator]();

    harness.send('task_1', [
      { method: 'turn/diff/updated', params: { threadId: 'thread_1', turnId: 'turn_1', diff: '' } },
      { method: 'turn/diff/updated', params: { threadId: 'thread_1', turnId: 'turn_1', diff: [
        { path: 'src/a.ts', kind: 'update', diff: '+const value = 1;' },
      ] } },
      { method: 'turn/completed', params: { threadId: 'thread_1', turn: { id: 'turn_1', status: 'completed' } } },
    ]);

    await expect(events.next()).resolves.toEqual({
      done: false,
      value: { type: 'turn.diff', taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_1', diff: '--- src/a.ts\n+const value = 1;' },
    });
    await expect(events.next()).resolves.toEqual({
      done: false,
      value: expect.objectContaining({ type: 'turn.completed', status: 'completed' }),
    });
    expect(warnings).toEqual([
      expect.objectContaining({
        method: 'turn/diff/updated', reason: 'Empty or unsupported turn diff ignored.',
        params: expect.objectContaining({ diffType: 'string', diffLength: 0 }),
      }),
    ]);
  });

  it('isolates malformed non-critical notifications and continues to turn completion', async () => {
    const harness = new RuntimeHarness();
    const warnings: unknown[] = [];
    const backend = harness.backend((warning) => warnings.push(warning));
    await backend.startTask({ taskId: 'task_1', cwd: '/workspace', args: [] });
    const events = backend.events('task_1')[Symbol.asyncIterator]();

    harness.send('task_1', [
      { method: 'thread/tokenUsage/updated', params: { threadId: 'thread_1', tokenUsage: { total: 42 } } },
      { method: 'item/agentMessage/delta', params: { threadId: 'thread_1', turnId: 'turn_1', itemId: 'item_1', delta: null } },
      { method: 'turn/completed', params: { threadId: 'thread_1', turn: { id: 'turn_1', status: 'completed' } } },
    ]);

    await expect(events.next()).resolves.toEqual({
      done: false,
      value: expect.objectContaining({ type: 'turn.completed', status: 'completed' }),
    });
    expect(warnings).toHaveLength(2);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'thread/tokenUsage/updated' }),
      expect.objectContaining({ method: 'item/agentMessage/delta' }),
    ]));
  });

  it('keeps the task alive when protocol-warning persistence fails', async () => {
    const harness = new RuntimeHarness();
    const backend = harness.backend(() => { throw new Error('database is locked'); });
    await backend.startTask({ taskId: 'task_1', cwd: '/workspace', args: [] });
    const events = backend.events('task_1')[Symbol.asyncIterator]();

    harness.send('task_1', [
      { method: 'turn/diff/updated', params: { threadId: 'thread_1', turnId: 'turn_1', diff: '' } },
      { method: 'turn/completed', params: { threadId: 'thread_1', turn: { id: 'turn_1', status: 'completed' } } },
    ]);

    await expect(events.next()).resolves.toEqual({
      done: false,
      value: expect.objectContaining({ type: 'turn.completed', status: 'completed' }),
    });
  });

  it('resumes and reads a thread while flattening persisted items', async () => {
    const harness = new RuntimeHarness();
    harness.threadReadResult = {
      thread: {
        id: 'thread_existing',
        turns: [
          { id: 'turn_a', items: [{ id: 'item_a' }] },
          { id: 'turn_b', items: [{ id: 'item_b' }, { id: 'item_c' }] },
        ],
      },
    };
    const backend = harness.backend();
    await expect(backend.resumeTask({
      taskId: 'task_resume', threadId: 'thread_existing', cwd: '/workspace', args: [],
    })).resolves.toEqual({
      taskId: 'task_resume', threadId: 'thread_existing', generation: 1,
      model: 'gpt-5.6-sol', reasoningEffort: 'high',
    });
    expect(harness.requestsFor('thread/resume')[0]?.params).toMatchObject({ threadId: 'thread_existing', cwd: '/workspace' });

    await expect(backend.readThread('task_resume')).resolves.toEqual({
      taskId: 'task_resume', threadId: 'thread_existing', items: [{ id: 'item_a' }, { id: 'item_b' }, { id: 'item_c' }],
      turns: [
        { id: 'turn_a', items: [{ id: 'item_a' }] },
        { id: 'turn_b', items: [{ id: 'item_b' }, { id: 'item_c' }] },
      ],
    });
  });

  it('clears the in-memory active turn when thread/read observes a terminal status', async () => {
    const harness = new RuntimeHarness();
    const backend = harness.backend();
    await backend.startTask({ taskId: 'task_1', cwd: '/workspace', args: [] });
    await backend.startTurn({ taskId: 'task_1', prompt: 'finish without a completion notification' });
    harness.threadReadResult = {
      thread: { id: 'thread_1', turns: [{ id: 'turn_1', status: 'completed', items: [] }] },
    };

    await backend.readThread('task_1');

    await expect(backend.interruptTurn({ taskId: 'task_1' })).rejects.toThrow('Codex task has no active turn');
  });

  it('creates, compacts, resumes, and archives contexts on one long-lived task runtime', async () => {
    const harness = new RuntimeHarness();
    const backend = harness.backend();
    await backend.startTask({ taskId: 'task_1', cwd: '/workspace', args: ['--model', 'gpt-5.5'] });

    await expect(backend.createContext!({ taskId: 'task_1' })).resolves.toEqual({ taskId: 'task_1', threadId: 'thread_2' });
    expect(harness.requestsFor('thread/start')[1]?.params).toEqual({ cwd: '/workspace', model: 'gpt-5.5' });
    await backend.compactContext!({ taskId: 'task_1' });
    expect(harness.requestsFor('thread/compact/start')[0]?.params).toEqual({ threadId: 'thread_2' });
    await expect(backend.resumeContext!({ taskId: 'task_1', threadId: 'thread_1' }))
      .resolves.toEqual({ taskId: 'task_1', threadId: 'thread_1' });
    await backend.archiveContext!({ taskId: 'task_1', threadId: 'thread_2' });
    expect(harness.requestsFor('thread/archive')[0]?.params).toEqual({ threadId: 'thread_2' });

    await backend.startTurn({ taskId: 'task_1', prompt: 'busy' });
    await expect(backend.createContext!({ taskId: 'task_1' })).rejects.toThrow('active turn');
  });

  it('runs Dream work in a separate ephemeral no-tool thread and rejects server requests fail-closed', async () => {
    const harness = new RuntimeHarness();
    const backend = harness.backend();
    await backend.startTask({ taskId: 'task_1', cwd: '/workspace', args: ['--model', 'gpt-5.5'] });
    const result = backend.runMaintenanceTurn!({
      taskId: 'task_1', prompt: 'consolidate untrusted data', outputSchema: { type: 'object' },
    });
    await eventually(() => harness.requestsFor('turn/start').length === 1);
    expect(harness.requestsFor('thread/start')[1]?.params).toMatchObject({
      cwd: '/tmp', sandbox: 'read-only', approvalPolicy: 'never', dynamicTools: [], environments: [],
      runtimeWorkspaceRoots: [], selectedCapabilityRoots: [], ephemeral: true,
      config: { features: { shell_tool: false }, web_search: 'disabled', agents: { enabled: false }, tools: { view_image: false } },
    });
    expect(harness.requestsFor('turn/start')[0]?.params).toMatchObject({
      threadId: 'thread_2', cwd: '/tmp', approvalPolicy: 'never', environments: [], runtimeWorkspaceRoots: [],
      outputSchema: { type: 'object' },
    });
    harness.send('task_1', [{
      id: 'forbidden_tool', method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread_2', turnId: 'turn_1' },
    }]);
    await eventually(() => harness.responsesFor('forbidden_tool').length === 1);
    expect(harness.responsesFor('forbidden_tool')[0]).toMatchObject({
      id: 'forbidden_tool', error: { code: -32_000 },
    });
    harness.send('task_1', [
      { method: 'item/completed', params: { threadId: 'thread_2', turnId: 'turn_1', item: { id: 'answer', type: 'agentMessage', text: '{"candidates":[]}' } } },
      { method: 'turn/completed', params: { threadId: 'thread_2', turn: { id: 'turn_1', status: 'completed' } } },
    ]);
    await expect(result).resolves.toEqual({ candidates: [] });
    await eventually(() => harness.requestsFor('thread/archive').length === 1);
  });

  it('interrupts a maintenance turn when interactive work returns', async () => {
    const harness = new RuntimeHarness();
    const backend = harness.backend();
    await backend.startTask({ taskId: 'task_1', cwd: '/workspace', args: [] });
    const result = backend.runMaintenanceTurn!({ taskId: 'task_1', prompt: 'dream', outputSchema: {} });
    await eventually(() => harness.requestsFor('turn/start').length === 1);
    await backend.interruptMaintenance!('task_1');
    await expect(result).rejects.toThrow('maintenance_interrupted');
    expect(harness.requestsFor('turn/interrupt')[0]?.params).toEqual({ threadId: 'thread_2', turnId: 'turn_1' });
  });

  it('preserves the App Server error message when a structured turn fails', async () => {
    const harness = new RuntimeHarness();
    const backend = harness.backend();
    await backend.startTask({ taskId: 'task_1', cwd: '/workspace', args: [] });
    const result = backend.runMaintenanceTurn!({ taskId: 'task_1', prompt: 'dream', outputSchema: {} });
    await eventually(() => harness.requestsFor('turn/start').length === 1);
    harness.send('task_1', [{
      method: 'turn/completed', params: {
        threadId: 'thread_2',
        turn: { id: 'turn_1', status: 'failed', error: { message: 'invalid_json_schema: missing paths' } },
      },
    }]);
    await expect(result).rejects.toThrow('maintenance_turn_failed: invalid_json_schema: missing paths');
  });

  it('enables local shell access for a structured workspace review', async () => {
    const harness = new RuntimeHarness();
    const backend = harness.backend();
    await backend.startTask({ taskId: 'task_1', cwd: '/workspace', args: [] });
    const result = backend.runStructuredWorkspaceTurn!({ taskId: 'task_1', cwd: '/workspace/review', prompt: 'review', outputSchema: {} });
    await eventually(() => harness.requestsFor('turn/start').length === 1);
    expect(harness.requestsFor('thread/start')[1]?.params).toMatchObject({
      cwd: '/workspace/review', sandbox: 'danger-full-access', approvalPolicy: 'never',
      config: { features: { shell_tool: true }, web_search: 'disabled', agents: { enabled: false } },
    });
    expect(harness.requestsFor('thread/start')[1]?.params).not.toHaveProperty('selectedCapabilityRoots');
    expect(harness.requestsFor('thread/start')[1]?.params).not.toHaveProperty('dynamicTools');
    expect(harness.requestsFor('turn/start')[0]?.params).not.toHaveProperty('runtimeWorkspaceRoots');
    harness.send('task_1', [
      { method: 'item/completed', params: { threadId: 'thread_2', turnId: 'turn_1', item: { id: 'answer', type: 'agentMessage', text: '{}' } } },
      { method: 'turn/completed', params: { threadId: 'thread_2', turn: { id: 'turn_1', status: 'completed' } } },
    ]);
    await expect(result).resolves.toEqual({});
  });

  it('allows edits and safe source-branch pushes for a remediation workspace', async () => {
    const harness = new RuntimeHarness();
    const backend = harness.backend();
    await backend.startTask({ taskId: 'task_1', cwd: '/workspace', args: [] });
    const result = backend.runStructuredWorkspaceTurn!({ taskId: 'task_1', cwd: '/workspace/remediation', intent: 'remediation', prompt: 'fix', outputSchema: {} });
    await eventually(() => harness.requestsFor('turn/start').length === 1);
    const params = harness.requestsFor('thread/start')[1]?.params as Record<string, unknown>;
    expect(params.baseInstructions).toContain('edit files');
    expect(params.baseInstructions).toContain('explicit user confirmation before any non-fast-forward update');
    expect(params.baseInstructions).not.toContain('Do not edit files');
    harness.send('task_1', [
      { method: 'item/completed', params: { threadId: 'thread_2', turnId: 'turn_1', item: { id: 'answer', type: 'agentMessage', text: '{}' } } },
      { method: 'turn/completed', params: { threadId: 'thread_2', turn: { id: 'turn_1', status: 'completed' } } },
    ]);
    await expect(result).resolves.toEqual({});
  });

  it('responds only on the generation that received the server request', async () => {
    const harness = new RuntimeHarness();
    const backend = harness.backend();
    await backend.startTask({ taskId: 'task_1', cwd: '/workspace', args: [] });

    await backend.respondToServerRequest({ taskId: 'task_1', generation: 1, requestId: 'approval_1', result: { decision: 'accept' } });
    expect(harness.responsesFor('approval_1')).toEqual([{ id: 'approval_1', result: { decision: 'accept' } }]);
    await expect(backend.respondToServerRequest({
      taskId: 'task_1', generation: 0, requestId: 'approval_old', result: { decision: 'decline' },
    })).rejects.toThrow('Stale app-server request generation');
  });

  it('forwards server requests with the connection generation', async () => {
    const harness = new RuntimeHarness();
    const backend = harness.backend();
    await backend.startTask({ taskId: 'task_1', cwd: '/workspace', args: [] });
    const events = backend.events('task_1')[Symbol.asyncIterator]();
    harness.send('task_1', [{
      id: 'approval_1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread_1', turnId: 'turn_1' },
    }]);

    await expect(events.next()).resolves.toEqual({
      done: false,
      value: {
        type: 'backend.server_request', taskId: 'task_1', generation: 1,
        requestId: 'approval_1', method: 'item/commandExecution/requestApproval',
        params: { threadId: 'thread_1', turnId: 'turn_1' },
      },
    });
  });

  it('ignores notifications for another thread and reports one disconnect generation', async () => {
    const harness = new RuntimeHarness();
    const backend = harness.backend();
    await backend.startTask({ taskId: 'task_1', cwd: '/workspace', args: [] });
    const events = backend.events('task_1')[Symbol.asyncIterator]();
    harness.send('task_1', [
      { method: 'turn/started', params: { threadId: 'thread_other', turn: { id: 'other' } } },
    ]);
    harness.sendRaw('task_1', '{invalid}\n');

    const first = await events.next();
    expect(first).toEqual({
      done: false,
      value: expect.objectContaining({ type: 'backend.disconnected', taskId: 'task_1', generation: 1 }),
    });
    await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
    expect(() => backend.events('task_1')).toThrow('not running');
  });

  it('preserves runtime disconnect diagnostics in the backend event', async () => {
    const harness = new RuntimeHarness();
    const backend = harness.backend();
    await backend.startTask({ taskId: 'task_1', cwd: '/workspace', args: [] });
    const events = backend.events('task_1')[Symbol.asyncIterator]();

    harness.disconnect('task_1', new Error('Codex App Server exited (code=137, signal=SIGKILL): fatal runtime error'));

    await expect(events.next()).resolves.toEqual({
      done: false,
      value: {
        type: 'backend.disconnected', taskId: 'task_1', generation: 1,
        reason: 'Codex App Server exited (code=137, signal=SIGKILL): fatal runtime error',
      },
    });
    await expect(backend.stopTask('task_1')).resolves.toBeUndefined();
  });

  it('allows stopping durable tasks that have no process after a manager restart', async () => {
    const harness = new RuntimeHarness();
    const backend = harness.backend();
    await expect(backend.stopTask('historical_task')).resolves.toBeUndefined();
    expect(harness.closedTasks).toEqual([]);
    expect(() => backend.events('historical_task')).toThrow('not running');
  });

  it('stops a task and closes its event stream', async () => {
    const harness = new RuntimeHarness();
    const backend = harness.backend();
    await backend.startTask({ taskId: 'task_1', cwd: '/workspace', args: [] });
    const events = backend.events('task_1')[Symbol.asyncIterator]();

    await backend.stopTask('task_1');
    await backend.stopTask('task_1');
    expect(harness.closedTasks).toEqual(['task_1']);
    await expect(events.next()).resolves.toEqual({
      done: false, value: { type: 'task.exited', taskId: 'task_1' },
    });
    await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
  });
});

class RuntimeHarness {
  readonly generations: number[] = [];
  readonly closedTasks: string[] = [];
  threadReadResult: unknown = { thread: { id: 'thread_1', turns: [] } };
  threadStartResult?: unknown;
  private readonly peers = new Map<string, RuntimePeer>();
  private readonly requests: Array<Record<string, unknown>> = [];
  private threadSequence = 0;

  backend(
    protocolWarning?: (warning: import('../../src/appserver/AppServerCodexBackend.js').AppServerProtocolWarning) => void,
    threadDefaults?: Record<string, unknown>,
  ): AppServerCodexBackend {
    return new AppServerCodexBackend({ command: 'codex-test', runtimeFactory: this.factory, protocolWarning, threadDefaults });
  }

  requestsFor(method: string): Array<Record<string, unknown>> {
    return this.requests.filter((request) => request.method === method);
  }

  responsesFor(id: string | number): Array<Record<string, unknown>> {
    return this.requests.filter((request) => request.id === id && request.method === undefined);
  }

  send(taskId: string, messages: unknown[]): void {
    this.peers.get(taskId)!.serverToClient.write(messages.map((message) => JSON.stringify(message)).join('\n') + '\n');
  }

  sendRaw(taskId: string, frame: string): void {
    this.peers.get(taskId)!.serverToClient.write(frame);
  }

  disconnect(taskId: string, error: Error): void {
    this.peers.get(taskId)!.serverToClient.destroy(error);
  }

  private readonly factory: AppServerRuntimeFactory = async (input, generation) => {
    this.generations.push(generation);
    const serverToClient = new PassThrough();
    const clientToServer = new PassThrough();
    const peer: RuntimePeer = { serverToClient, clientToServer };
    this.peers.set(input.taskId, peer);
    clientToServer.setEncoding('utf8');
    let buffered = '';
    clientToServer.on('data', (chunk: string) => {
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        const request = JSON.parse(line) as Record<string, unknown>;
        this.requests.push(request);
        if (request.id !== undefined && request.method !== undefined) queueMicrotask(() => this.respond(input.taskId, request));
      }
    });
    const connection = new AppServerConnection({ readable: serverToClient, writable: clientToServer, generation });
    return {
      connection,
      close: async () => {
        this.closedTasks.push(input.taskId);
        await connection.close();
      },
    } satisfies AppServerRuntime;
  };

  private respond(taskId: string, request: Record<string, unknown>): void {
    const method = request.method;
    let result: unknown = {};
    if (method === 'initialize') result = { serverVersion: '0.145.0' };
    if (method === 'thread/start') result = this.threadStartResult ?? {
      thread: { id: `thread_${++this.threadSequence}`, turns: [] }, model: 'gpt-5.6-sol', reasoningEffort: 'high',
    };
    if (method === 'thread/resume') result = {
      thread: { id: (request.params as Record<string, unknown>).threadId, turns: [] }, model: 'gpt-5.6-sol', reasoningEffort: 'high',
    };
    if (method === 'turn/start') result = { turn: { id: 'turn_1', items: [], status: 'inProgress' } };
    if (method === 'turn/steer') result = { turnId: 'turn_1' };
    if (method === 'thread/read') result = this.threadReadResult;
    this.send(taskId, [{ id: request.id, result }]);
  }
}

interface RuntimePeer {
  serverToClient: PassThrough;
  clientToServer: PassThrough;
}

async function nextValues<T>(iterator: AsyncIterator<T>, count: number): Promise<T[]> {
  const values: T[] = [];
  for (let index = 0; index < count; index += 1) {
    const next = await iterator.next();
    if (next.done) throw new Error(`Event stream ended after ${index} events.`);
    values.push(next.value);
  }
  return values;
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Condition was not reached.');
}
