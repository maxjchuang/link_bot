import { describe, expect, it, vi } from 'vitest';
import { HostAppServerSession } from '../../src/host/HostAppServerSession.js';
import type { CodexBackendEvent, ThreadSnapshot } from '../../src/backends/CodexBackend.js';
import { join } from 'node:path';
import { createTmpDir } from '../helpers/tmp.js';
import { createTurnDetailRuntime } from '../../src/details/TurnDetailRuntime.js';
import { SqliteTurnDetailStore } from '../../src/details/SqliteTurnDetailStore.js';
import { DetailResourceStore } from '../../src/details/DetailResourceStore.js';
import { SensitiveReplyDelivery } from '../../src/details/SensitiveReplyDelivery.js';

describe('HostAppServerSession', () => {
  it('queues the next turn while private delivery finishes and keeps the original reply source', async () => {
    const backend = fakeBackend([{ type: 'turn.completed', taskId: 'host_task', threadId: 'thread_new', turnId: 'turn',
      status: 'completed', turn: { items: [{ type: 'agentMessage', text: 'answer' }] } }]);
    let release!: () => void;
    let preparing = false;
    const notify = vi.fn(async () => undefined);
    const session = new HostAppServerSession({ backend, cwd: '/real/link_bot', args: [], loadThreads: async () => ({}),
      saveThreads: async () => undefined, notify, prepareFinalText: async () => {
        preparing = true; await new Promise<void>((resolve) => { release = resolve; }); return '私聊已发送';
      } });
    try {
      await session.handleMessage(message('first'));
      await eventually(() => preparing);
      const next = session.handleMessage({ ...message('next'), messageId: 'second-source' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(backend.startTurn).toHaveBeenCalledOnce(); expect(backend.steerTurn).not.toHaveBeenCalled();
      release(); await next;
      expect(backend.startTurn).toHaveBeenCalledTimes(2);
      expect(notify).toHaveBeenCalledWith(message('first'), '私聊已发送', true);
    } finally { release?.(); await session.shutdown(); }
  });
  it('prepares private delivery before first-result persistence, even without live cards', async () => {
    const root = await createTmpDir(), runtime = createTurnDetailRuntime(join(root, 'state.sqlite'));
    const accepted = vi.spyOn(runtime.sink, 'accepted');
    const send = vi.fn(async () => ({ messageId: 'private-receipt' }));
    const verify = vi.fn(async () => true);
    const delivery = new SensitiveReplyDelivery(join(root, 'private'), { verifySensitiveReplySource: verify, sendSensitiveReplyPrivate: send });
    const backend = fakeBackend();
    backend.events.mockImplementation(() => ({ async *[Symbol.asyncIterator]() {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const taskId = backend.startTask.mock.calls[0]![0].taskId;
      yield { type: 'turn.started' as const, taskId, threadId: 'thread_new', turnId: 'turn' };
      yield { type: 'turn.completed' as const, taskId, threadId: 'thread_new', turnId: 'turn', status: 'completed',
        turn: { items: [{ type: 'agentMessage', text: 'https://example.test/authorize?state=fake-host-private-secret' }] } };
    } }));
    const notify = vi.fn(async () => undefined);
    const session = new HostAppServerSession({ backend, cwd: root, args: [], loadThreads: async () => ({}),
      saveThreads: async () => undefined, notify, turnDetails: runtime.sink,
      prepareFinalText: (input, text) => delivery.prepare({ requesterUserId: input.userId ?? '', ownerUserId: input.userId ?? '',
        chatId: input.chatId, sourceMessageId: input.messageId }, text) });
    try {
      await session.handleMessage(message('授权链接发我'));
      await eventually(() => notify.mock.calls.length > 0);
      expect(verify).toHaveBeenCalledWith('om_1', 'oc_admin', 'ou_admin');
      expect(send).toHaveBeenCalledOnce();
      const identity = accepted.mock.calls[0]![0];
      const result = runtime.results!.readPage(identity).text;
      expect(result).toContain('已通过 code bot 私聊发送');
      expect(result).not.toContain('fake-host-private-secret');
      expect(JSON.stringify(notify.mock.calls)).not.toContain('fake-host-private-secret');
    } finally { await session.shutdown(); await runtime.close(); }
  });
  it('records Host Manager private details even without a live-card renderer', async () => {
    const root = await createTmpDir();
    const path = join(root, 'state.sqlite');
    const runtime = createTurnDetailRuntime(path);
    const accepted = vi.spyOn(runtime.sink, 'accepted');
    const backend = fakeBackend();
    backend.events.mockImplementation(() => ({ async *[Symbol.asyncIterator]() {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const taskId = backend.startTask.mock.calls[0]![0].taskId;
      yield { type: 'turn.started' as const, taskId, threadId: 'thread_new', turnId: 'turn' };
      yield { type: 'item.completed' as const, taskId, threadId: 'thread_new', turnId: 'turn',
        item: { id: 'cmd', type: 'commandExecution', command: 'pwd', aggregatedOutput: 'host output', exitCode: 0 } };
      yield { type: 'turn.completed' as const, taskId, threadId: 'thread_new', turnId: 'turn', status: 'completed', turn: { items: [] } };
    } }));
    const notify = vi.fn(async () => undefined);
    const service = new HostAppServerSession({ backend, cwd: root, args: [], loadThreads: async () => ({}),
      saveThreads: async () => undefined, notify, turnDetails: runtime.sink });
    await service.handleMessage(message('record'));
    await eventually(() => notify.mock.calls.length > 0);
    await runtime.flush();
    const details = new SqliteTurnDetailStore(path);
    try {
      const input = accepted.mock.calls[0]![0];
      expect(details.getTurn(input)).toMatchObject({ lifecycle: 'completed', scope: { kind: 'private_user', chatId: 'oc_admin', userId: 'ou_admin' } });
      const ref = details.listEntries(input)[0]!.resource!;
      expect(new DetailResourceStore(`${path}.turn-details`).read(ref.resourceId, ref.committedBytes, 0, 100)).toBe('host output');
    } finally { details.close(); await service.shutdown(); await runtime.close(); }
  });
  it.each([true, false])('delivers Markdown before the final card or message (card=%s)', async (cardDelivered) => {
    const backend = fakeBackend([{
      type: 'turn.completed', taskId: 'host_task', threadId: 'thread_new', turnId: 'turn_1',
      status: 'completed', turn: { items: [{ type: 'agentMessage', text: '[设计](/real/link_bot/docs/design.md)' }] },
    }]);
    const order: string[] = [];
    const notify = vi.fn(async () => { order.push('notify'); });
    const eventHandler = vi.fn(async () => { order.push('card'); return cardDelivered; });
    const service = new HostAppServerSession({
      backend, cwd: '/real/link_bot', args: [], loadThreads: async () => ({}), saveThreads: async () => undefined,
      notify,
      prepareFinalText: vi.fn(async () => { order.push('attachment'); return '设计（已发送 Markdown 附件：design.md）'; }),
      turnExperience: { accepted: vi.fn(), event: eventHandler },
      afterTurnCompleted: async () => { order.push('restart'); },
    });
    await service.handleMessage(message('返回设计文档'));
    await eventually(() => order.includes('restart'));
    expect(order).toEqual(cardDelivered ? ['attachment', 'card', 'restart'] : ['attachment', 'card', 'notify', 'restart']);
    expect(eventHandler).toHaveBeenCalledWith(expect.objectContaining({
      turn: { items: [{ type: 'agentMessage', text: '设计（已发送 Markdown 附件：design.md）' }] },
    }));
    if (!cardDelivered) expect(notify).toHaveBeenCalledWith(message('返回设计文档'), '设计（已发送 Markdown 附件：design.md）', true);
  });
  it('renders a model selector card for the host-control /model command', async () => {
    const backend = fakeBackend();
    const service = new HostAppServerSession({
      backend, cwd: '/real/link_bot', args: [], loadThreads: async () => ({}), saveThreads: async () => undefined,
      notify: vi.fn(), readModelCatalog: async () => ({
        kind: 'available',
        models: [{ slug: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', priority: 1, supportedReasoningLevels: ['medium', 'high'] }],
      }),
    });

    const result = await service.handleMessage(message('/model'));

    expect(result.renderedReply?.preferred.kind).toBe('card');
    expect(backend.startTurn).not.toHaveBeenCalled();
  });

  it('applies a host model selection to the next turn without sending the command to Codex', async () => {
    const backend = fakeBackend();
    const service = new HostAppServerSession({
      backend, cwd: '/real/link_bot', args: [], loadThreads: async () => ({}), saveThreads: async () => undefined,
      notify: vi.fn(),
    });

    await expect(service.handleMessage(message('/model gpt-5.6-terra high fast'))).resolves.toEqual({
      reply: '执行配置已更新：gpt-5.6-terra / high / fast',
    });
    await service.handleMessage(message('分析问题'));

    expect(backend.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      prompt: '分析问题',
      executionProfile: { model: 'gpt-5.6-terra', reasoningEffort: 'high', serviceTier: 'fast' },
    }));
  });

  it('starts a host app-server task in the real project directory and starts a turn', async () => {
    const backend = fakeBackend();
    const service = new HostAppServerSession({
      backend, cwd: '/real/link_bot', codexHome: '/host/.codex', args: ['--sandbox', 'danger-full-access'],
      loadThreads: async () => ({}), saveThreads: async () => undefined, notify: vi.fn(),
    });

    await expect(service.handleMessage(message('修复问题'))).resolves.toMatchObject({ reply: '' });

    expect(backend.startTask).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/real/link_bot', codexHome: '/host/.codex' }));
    expect(backend.startTask).toHaveBeenCalledWith(expect.objectContaining({
      executionProfile: expect.objectContaining({ model: 'gpt-6.1-sol', reasoningEffort: 'medium' }),
    }));
    expect(backend.startTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: '修复问题' }));
  });

  it('passes hydrated private-chat images to the host App Server turn', async () => {
    const backend = fakeBackend();
    const service = new HostAppServerSession({
      backend, cwd: '/real/link_bot', args: [], loadThreads: async () => ({}), saveThreads: async () => undefined,
      notify: vi.fn(),
    });
    const images = [{ url: 'data:image/png;base64,AQ==', detail: 'auto' as const }];

    await service.handleMessage({ ...message('请分析这张图片。'), images });

    expect(backend.startTurn).toHaveBeenCalledWith(expect.objectContaining({ images }));
  });

  it('runs a bare four-digit time as an isolated read-only diagnostic task', async () => {
    const backend = fakeBackend();
    const service = new HostAppServerSession({
      backend, cwd: '/real/link_bot', codexHome: '/host/.codex', args: [],
      loadThreads: async () => ({}), saveThreads: async () => undefined, notify: vi.fn(),
      clock: () => new Date('2026-09-02T08:30:00.000Z'),
    });

    await expect(service.handleMessage(message('1626'))).resolves.toEqual({ reply: '' });

    expect(backend.startTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: expect.stringMatching(/^host_diag_/), cwd: '/real/link_bot', codexHome: '/host/.codex',
    }));
    expect(backend.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      taskId: expect.stringMatching(/^host_diag_/),
      prompt: expect.stringContaining('2026-09-02 16:26 (Asia/Shanghai)'),
    }));
    expect(backend.resumeTask).not.toHaveBeenCalled();
  });

  it('does not steer a time diagnostic into an active maintenance turn', async () => {
    const backend = fakeBackend();
    const service = new HostAppServerSession({
      backend, cwd: '/real/link_bot', args: [], loadThreads: async () => ({}), saveThreads: async () => undefined,
      notify: vi.fn(), clock: () => new Date('2026-09-02T08:30:00.000Z'),
    });

    await service.handleMessage(message('正在实施另一个修复'));
    await service.handleMessage({ ...message('1626'), messageId: 'om_diag' });

    expect(backend.startTask).toHaveBeenCalledTimes(2);
    expect(backend.startTurn).toHaveBeenCalledTimes(2);
    expect(backend.steerTurn).not.toHaveBeenCalled();
    const calls = backend.startTurn.mock.calls as unknown as Array<[{ taskId: string }]>;
    const taskIds = calls.map(([input]) => input.taskId);
    expect(taskIds[0]).toMatch(/^host_/);
    expect(taskIds[1]).toMatch(/^host_diag_/);
  });

  it('delivers and releases a completed isolated time diagnostic', async () => {
    const backend = fakeBackend([{
      type: 'turn.completed', taskId: 'host_diag_task', threadId: 'thread_diag', turnId: 'turn_diag',
      status: 'completed', turn: { items: [{ type: 'agentMessage', text: '诊断结论' }] },
    }]);
    const notify = vi.fn(async () => undefined);
    const afterTurnCompleted = vi.fn(async () => undefined);
    const service = new HostAppServerSession({
      backend, cwd: '/real/link_bot', args: [], loadThreads: async () => ({}), saveThreads: async () => undefined,
      notify, afterTurnCompleted, clock: () => new Date('2026-09-02T08:30:00.000Z'),
    });

    await service.handleMessage(message('1626'));
    await eventually(() => backend.stopTask.mock.calls.length === 1);

    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_1' }), '诊断结论', true);
    expect(backend.stopTask).toHaveBeenCalledWith(expect.stringMatching(/^host_diag_/));
    expect(afterTurnCompleted).not.toHaveBeenCalled();
  });

  it('returns guidance instead of starting Codex for invalid or future time shortcuts', async () => {
    const backend = fakeBackend();
    const service = new HostAppServerSession({
      backend, cwd: '/real/link_bot', args: [], loadThreads: async () => ({}), saveThreads: async () => undefined,
      notify: vi.fn(), clock: () => new Date('2026-09-02T08:30:00.000Z'),
    });

    await expect(service.handleMessage(message('2460'))).resolves.toMatchObject({
      reply: expect.stringContaining('0000–2359'),
    });
    await expect(service.handleMessage(message('2359'))).resolves.toEqual({
      reply: '今天 23:59 尚未到达。若要查询昨天，请发送 /diag yesterday 2359。',
    });
    expect(backend.startTask).not.toHaveBeenCalled();
  });

  it('uses the shared app-server turn card experience instead of returning a text acknowledgement', async () => {
    const backend = fakeBackend();
    const turnExperience = { accepted: vi.fn(async () => undefined), event: vi.fn(async () => true) };
    const service = new HostAppServerSession({
      backend, cwd: '/real/link_bot', args: [], loadThreads: async () => ({}), saveThreads: async () => undefined,
      notify: vi.fn(), turnExperience, projectId: 'link-bot',
    });

    const result = await service.handleMessage(message('修复问题'));

    expect(result.reply).toBe('');
    expect(turnExperience.accepted).toHaveBeenCalledWith(expect.objectContaining({
      taskId: expect.stringMatching(/^host_/), projectId: 'link-bot', messageId: 'om_1',
      target: expect.objectContaining({ chatId: 'oc_admin', replyToMessageId: 'om_1' }),
    }));
  });

  it('resumes a persisted app-server thread after manager restart', async () => {
    const backend = fakeBackend();
    const service = new HostAppServerSession({
      backend, cwd: '/real/link_bot', args: [], loadThreads: async () => ({ oc_admin: 'thread_saved' }),
      saveThreads: async () => undefined, notify: vi.fn(),
    });

    await service.handleMessage(message('继续'));

    expect(backend.resumeTask).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread_saved' }));
    expect(backend.startTask).not.toHaveBeenCalled();
  });

  it('runs deferred restart handoff only after the shared card handles completion', async () => {
    const completion = {
      type: 'turn.completed' as const, taskId: 'host_task', threadId: 'thread_new', turnId: 'turn_1',
      status: 'completed', turn: { items: [{ type: 'agentMessage', text: 'done' }] },
    };
    const backend = fakeBackend([completion]);
    const order: string[] = [];
    const service = new HostAppServerSession({
      backend, cwd: '/real/link_bot', args: [], loadThreads: async () => ({}), saveThreads: async () => undefined,
      notify: vi.fn(),
      turnExperience: {
        accepted: vi.fn(async () => undefined),
        event: vi.fn(async () => { order.push('card'); return true; }),
      },
      afterTurnCompleted: vi.fn(async () => { order.push('restart'); }),
    });

    await service.handleMessage(message('重启服务'));
    await eventually(() => order.includes('restart'));

    expect(order).toEqual(['card', 'restart']);
  });

  it('continues through card persistence failures and clears active state on completion', async () => {
    const events: CodexBackendEvent[] = [
      { type: 'turn.started', taskId: 'host_task', threadId: 'thread_new', turnId: 'turn_1' },
      { type: 'turn.completed', taskId: 'host_task', threadId: 'thread_new', turnId: 'turn_1',
        status: 'completed', turn: { items: [{ type: 'agentMessage', text: 'recovered final answer' }] } },
    ];
    const backend = fakeBackend(events);
    const notify = vi.fn(async () => undefined);
    const afterTurnCompleted = vi.fn(async () => undefined);
    const cardEvent = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY_SNAPSHOT' }))
      .mockRejectedValueOnce(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY_SNAPSHOT' }));
    const service = new HostAppServerSession({
      backend, cwd: '/real/link_bot', args: [], loadThreads: async () => ({}), saveThreads: async () => undefined,
      notify, afterTurnCompleted,
      turnExperience: { accepted: vi.fn(async () => undefined), event: cardEvent },
    });

    await service.handleMessage(message('继续任务'));
    await eventually(() => afterTurnCompleted.mock.calls.length === 1);

    expect(cardEvent).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(expect.any(Object), 'recovered final answer', true);
    await service.handleMessage(message('下一条任务'));
    expect(backend.startTurn).toHaveBeenCalledTimes(2);
    expect(backend.steerTurn).not.toHaveBeenCalled();
  });

  it('finalizes the active card, notifies the user, and allows retry after the app server disconnects', async () => {
    const backend = fakeBackend([{
      type: 'backend.disconnected', taskId: 'host_task', generation: 1,
      reason: 'Codex App Server exited (code=137, signal=SIGKILL): fatal runtime error',
    }]);
    const interruptTurn = vi.fn(async () => false);
    const notify = vi.fn(async () => undefined);
    const service = new HostAppServerSession({
      backend, cwd: '/real/link_bot', args: [], loadThreads: async () => ({}), saveThreads: async () => undefined,
      notify,
      turnExperience: { accepted: vi.fn(async () => undefined), event: vi.fn(async () => true), interruptTurn },
    });

    await service.handleMessage(message('诊断任务'));
    await eventually(() => interruptTurn.mock.calls.length === 1);

    expect(interruptTurn).toHaveBeenCalledWith(
      'host_manager', expect.stringMatching(/^host_turn_/),
      '任务执行中断：Codex App Server exited (code=137, signal=SIGKILL): fatal runtime error',
    );
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'om_1' }),
      '任务执行中断：Codex App Server exited (code=137, signal=SIGKILL): fatal runtime error',
      false,
    );

    await service.handleMessage(message('重试任务'));
    expect(backend.resumeTask).toHaveBeenCalledTimes(1);
    expect(backend.startTurn).toHaveBeenCalledTimes(2);
    expect(backend.steerTurn).not.toHaveBeenCalled();
  });

  it.each([false, true])('recovers the final answer with optional Markdown delivery (attachments=%s)', async (attachments) => {
    const backend = fakeBackend();
    backend.readThread.mockResolvedValue({
      taskId: 'host_task', threadId: 'thread_saved', items: [],
      turns: [{ id: 'codex_turn_1', status: 'completed', items: [{ type: 'agentMessage', text: 'Recovered answer.' }] }],
    });
    const recoverOpenCards = vi.fn(async (_owner, resolve) => {
      await expect(resolve({
        id: 'card', ownerKind: 'host_manager', taskId: 'host_task', localTurnId: 'host_turn_1',
        projectId: 'link-bot', target: { chatId: 'oc_admin' }, codexTurnId: 'codex_turn_1',
        state: 'live', nextSequence: 1, sendUuid: 'uuid', startedAt: 'now', updatedAt: 'now',
      })).resolves.toEqual({ status: 'completed', answer: attachments ? 'Document attached.' : 'Recovered answer.' });
    });
    const service = new HostAppServerSession({
      backend, cwd: '/real/link_bot', args: [], loadThreads: async () => ({ oc_admin: 'thread_saved' }),
      saveThreads: async () => undefined, notify: vi.fn(),
      ...(attachments ? { prepareFinalText: vi.fn(async () => 'Document attached.') } : {}),
      turnExperience: { accepted: vi.fn(), event: vi.fn(), recoverOpenCards },
    });

    await service.recover();

    expect(backend.resumeTask).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread_saved' }));
    expect(recoverOpenCards).toHaveBeenCalledWith('host_manager', expect.any(Function));
  });

  it('recovers a completed turn by its persisted prompt when Codex changes the exposed turn id', async () => {
    const backend = fakeBackend();
    backend.readThread.mockResolvedValue({
      taskId: 'host_task', threadId: 'thread_saved', items: [],
      turns: [{
        id: 'new_exposed_turn_id', status: 'completed',
        items: [
          { type: 'userMessage', content: [{ type: 'text', text: '继续任务' }] },
          { type: 'agentMessage', text: 'Recovered despite id mismatch.' },
        ],
      }],
    });
    const recoverOpenCards = vi.fn(async (_owner, resolve) => {
      await expect(resolve({
        id: 'card', ownerKind: 'host_manager', taskId: 'host_task', localTurnId: 'host_turn_1',
        projectId: 'link-bot', prompt: '继续任务', target: { chatId: 'oc_admin' }, codexTurnId: 'old_turn_id',
        state: 'live', nextSequence: 1, sendUuid: 'uuid', startedAt: 'now', updatedAt: 'now',
      })).resolves.toEqual({ status: 'completed', answer: 'Recovered despite id mismatch.' });
    });
    const service = new HostAppServerSession({
      backend, cwd: '/real/link_bot', args: [], loadThreads: async () => ({ oc_admin: 'thread_saved' }),
      saveThreads: async () => undefined, notify: vi.fn(),
      turnExperience: { accepted: vi.fn(), event: vi.fn(), recoverOpenCards },
    });

    await service.recover();
  });

  it('rejects new work while a safe restart is draining', async () => {
    const backend = fakeBackend();
    const service = new HostAppServerSession({
      backend, cwd: '/real/link_bot', args: [], loadThreads: async () => ({}), saveThreads: async () => undefined,
      notify: vi.fn(), isRestartPending: async () => true,
    });

    await expect(service.handleMessage(message('new work'))).resolves.toEqual({
      reply: 'Link Bot 正在安全重启，当前不接受新任务；服务恢复后请重新发送。',
    });
    expect(backend.startTurn).not.toHaveBeenCalled();
  });
});

function message(text: string) {
  return { chatId: 'oc_admin', chatType: 'private' as const, userId: 'ou_admin', messageId: 'om_1', text };
}

function fakeBackend(events: CodexBackendEvent[] = []) {
  return {
    healthCheck: vi.fn(async () => ({ ok: true as const })),
    startTask: vi.fn(async ({ taskId }: { taskId: string }) => ({ taskId, threadId: 'thread_new', generation: 1 })),
    resumeTask: vi.fn(async ({ taskId, threadId }: { taskId: string; threadId: string }) => ({ taskId, threadId, generation: 1 })),
    startTurn: vi.fn(async () => undefined), steerTurn: vi.fn(async () => undefined), interruptTurn: vi.fn(async () => undefined),
    respondToServerRequest: vi.fn(async () => undefined), stopTask: vi.fn(async () => undefined),
    readThread: vi.fn(async (): Promise<ThreadSnapshot> => ({ taskId: 'x', items: [] })),
    events: vi.fn(() => ({ async *[Symbol.asyncIterator]() {
      // Real backend events arrive asynchronously after the turn request. Keep
      // the fake from racing ahead of handleMessage's active-turn bookkeeping.
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const event of events) yield event;
    } })),
  };
}

async function eventually(assertion: () => boolean) {
  const deadline = Date.now() + 1_000;
  while (!assertion()) {
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
