import { describe,expect,it,vi } from 'vitest';
import { FeishuTaskController,type TaskControlOperations } from '../../src/feishu/FeishuTaskController.js';

describe('FeishuTaskController', () => {
  it('routes runtime status and explicit upgrade only for the sending user', async () => {
    const operations = fakeOperations();
    operations.runtime = vi.fn(async () => 'runtime status');
    const controller = new FeishuTaskController(operations);
    await controller.handleMessage(message('/runtime'));
    expect(operations.runtime).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'ou_owner', upgrade: false }));
    await controller.handleMessage(message('/runtime upgrade'));
    expect(operations.runtime).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'ou_owner', upgrade: true }));
    const reply = await controller.handleMessage(message('/runtime upgrade ou_other'));
    expect(reply.text).toContain('用法');
    expect(operations.runtime).toHaveBeenCalledTimes(2);
    expect(operations.send).not.toHaveBeenCalled();
  });
  it('routes an exact repository-creation confirmation as plain text without starting a Codex turn or card', async () => {
    const operations = fakeOperations();
    operations.confirmProjectCreation = vi.fn(async (input) => input.text === '确认创建 owner/repo'
      ? { text: '已记录创建确认。' } : undefined);
    const controller = new FeishuTaskController(operations);

    const reply = await controller.handleMessage(message('@bot 确认创建 owner/repo', {
      chatType: 'group', chatId: 'oc_group', threadId: 'topic_1', messageId: 'om_confirm', wasMentioned: true,
    }));

    expect(reply).toEqual({ text: '已记录创建确认。' });
    expect(reply.rendered).toBeUndefined();
    expect(operations.confirmProjectCreation).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'oc_group', topicId: 'topic_1', userId: 'ou_owner', messageId: 'om_confirm',
      text: '确认创建 owner/repo',
    }));
    expect(operations.send).not.toHaveBeenCalled();
    expect(operations.prepareSend).not.toHaveBeenCalled();
  });
  it('renders the model selector card for a bare /model command', async () => {
    const operations = fakeOperations();
    const controller = new FeishuTaskController(operations, undefined, undefined, async () => ({
      kind: 'available',
      models: [{ slug: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', priority: 1, supportedReasoningLevels: ['medium', 'high'] }],
    }));

    const reply = await controller.handleMessage(message('/model'));

    expect(reply.rendered?.preferred.kind).toBe('card');
    expect(reply.rendered?.preferred.kind === 'card' && reply.rendered.preferred.payload).toMatchObject({
      header: { title: { content: 'Codex Model' } },
    });
    expect(operations.executionProfile).toHaveBeenCalledTimes(1);
  });

  it('binds a model selector card to the originating topic', async () => {
    const operations = fakeOperations();
    const controller = new FeishuTaskController(operations, undefined, undefined, async () => ({
      kind: 'available',
      models: [{ slug: 'gpt-5.6-luna', displayName: 'Luna', priority: 1, supportedReasoningLevels: ['medium'] }],
    }));

    const reply = await controller.handleMessage(message('@bot /model', {
      chatType: 'group', chatId: 'oc_group', threadId: 'omt_topic', wasMentioned: true,
    }));
    const payload = reply.rendered?.preferred.kind === 'card' ? JSON.stringify(reply.rendered.preferred.payload) : '';

    expect(payload).toContain('"topicId":"omt_topic"');
  });

  it('applies an execution profile submitted by a model card', async () => {
    const operations = fakeOperations();
    const controller = new FeishuTaskController(operations);
    await controller.handleCardAction({
      chatId: 'oc_1', chatType: 'private', userId: 'ou_owner', messageId: 'om_card',
      action: { kind: 'model_select', model: 'gpt-5.6-sol', reasoning: 'high', serviceTier: 'fast' },
    });
    expect(operations.model).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.6-sol', reasoningEffort: 'high', serviceTier: 'fast',
    }));
  });
  it('routes a repository migration confirmation card', async () => {
    const operations = fakeOperations();
    operations.decideRepositoryMigration = vi.fn(async () => 'confirmed');
    const controller = new FeishuTaskController(operations);
    await expect(controller.handleCardAction({
      chatId: 'oc_1', chatType: 'private', userId: 'ou_owner',
      action: { kind: 'repository_migration_decision', migrationId: 'repository_migration_1', decision: 'confirm' },
    })).resolves.toEqual({ text: 'confirmed' });
    expect(operations.decideRepositoryMigration).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'ou_owner', migrationId: 'repository_migration_1', decision: 'confirm',
    }));
  });
  it.each([
    ['/projects', 'projects'], ['/new repo', 'createTask'], ['/contexts', 'contexts'], ['/use-context context_1', 'useContext'],
    ['/repos', 'repositories'], ['/repo add repo2 main', 'addRepository'],
    ['/memory alpha', 'memory'], ['/remember task alpha', 'remember'], ['/forget memory_1', 'forget'],
    ['/dream status', 'dreamStatus'], ['/memory approve memory_bot', 'confirmBotMemory'],
    ['/tasks', 'tasks'], ['/use task_1', 'useTask'],
    ['/status', 'status'], ['/current', 'status'], ['/model gpt-5.5', 'model'], ['/usage month', 'usage'], ['/interrupt', 'interrupt'], ['/stop', 'stop'],
    ['/resume', 'resume'], ['/pin', 'pin'], ['/unpin', 'pin'], ['/publish', 'requestPublish'], ['/delete', 'requestDelete'],
  ])('routes %s through the Feishu task control surface', async (text, method) => {
    const operations = fakeOperations();
    const controller = new FeishuTaskController(operations);

    await controller.handleMessage(message(text));

    expect(operations[method as keyof TaskControlOperations]).toHaveBeenCalledTimes(1);
  });

  it('routes plain text with private/group/topic actor identity and ignores unmentioned groups', async () => {
    const operations = fakeOperations();
    const controller = new FeishuTaskController(operations);
    await controller.handleMessage(message('work', { chatType: 'group', chatId: 'oc_group', threadId: 'topic_1', wasMentioned: false }));
    expect(operations.send).not.toHaveBeenCalled();

    await controller.handleMessage(message('@bot work', { chatType: 'group', chatId: 'oc_group', threadId: 'topic_1', wasMentioned: true }));
    expect(operations.send).toHaveBeenCalledWith({
      chatId: 'oc_group', chatType: 'group', userId: 'ou_owner', topicId: 'topic_1', text: 'work',
    });
  });

  it('routes an attachment-only private message with a default analysis prompt', async () => {
    const operations = fakeOperations();
    const controller = new FeishuTaskController(operations);
    const resources = [{ kind: 'image' as const, resourceKey: 'img_1', resourceOwnerMessageId: 'om_1' }];

    await controller.handleMessage(message('', { messageId: 'om_1', resources }));

    expect(operations.send).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'om_1', text: '请分析这个附件。', resources,
    }));
  });

  it('routes an authorized ambient-chat message without requiring a bot mention', async () => {
    const operations = fakeOperations();
    const controller = new FeishuTaskController(operations, (input) =>
      input.chatId === 'oc_ambient' && input.userId === 'ou_owner');

    await controller.handleMessage(message('继续排查', {
      chatType: 'group', chatId: 'oc_ambient', threadId: 'topic_1', wasMentioned: false,
    }));
    await controller.handleMessage(message('其他成员发言', {
      chatType: 'group', chatId: 'oc_ambient', userId: 'ou_other', wasMentioned: false,
    }));

    expect(operations.send).toHaveBeenCalledTimes(1);
    expect(operations.send).toHaveBeenCalledWith({
      chatId: 'oc_ambient', chatType: 'group', userId: 'ou_owner', topicId: 'topic_1', text: '继续排查',
    });
  });

  it('leaves a mentioned MR link without a slash command in the ordinary message flow', async () => {
    const operations = fakeOperations();
    const controller = new FeishuTaskController(operations);
    await controller.handleMessage(message('帮我看看 https://github.com/example/repo/pull/7', {
      chatType: 'group', threadId: 'topic_1', wasMentioned: true,
    }));
    expect(operations.send).toHaveBeenCalledOnce();
  });

  it('routes publish, delete, and app-server approval cards with the callback actor', async () => {
    const operations = fakeOperations();
    const controller = new FeishuTaskController(operations);
    await controller.handleCardAction({
      chatId: 'oc_1', chatType: 'private', userId: 'ou_owner',
      action: { kind: 'task_publish_decision', requestId: 'pub_1', decision: 'confirm' },
    });
    await controller.handleCardAction({
      chatId: 'oc_1', chatType: 'private', userId: 'ou_owner',
      action: { kind: 'task_delete_decision', requestId: 'del_1', decision: 'reject' },
    });
    await controller.handleCardAction({
      chatId: 'oc_1', chatType: 'private', userId: 'ou_owner',
      action: { kind: 'app_server_request_decision', requestId: 'asr_1', generation: 2, decision: 'answer', answers: { scope: ['tests'] } },
    });

    expect(operations.decidePublish).toHaveBeenCalledWith(expect.objectContaining({ userId: 'ou_owner', requestId: 'pub_1', decision: 'confirm' }));
    expect(operations.decideDelete).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'del_1', decision: 'reject' }));
    expect(operations.decideAppServerRequest).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'asr_1', generation: 2, answers: { scope: ['tests'] } }));
  });

  it('returns actionable confirmation cards for publish and delete', async () => {
    const controller = new FeishuTaskController(fakeOperations());
    const publish = await controller.handleMessage(message('/publish'));
    const deletion = await controller.handleMessage(message('/delete'));
    expect(JSON.stringify(publish.rendered)).toContain('task_publish_decision');
    expect(JSON.stringify(deletion.rendered)).toContain('task_delete_decision');
  });

  it('keeps disk inventory read-only and requires a card confirmation for cleanup', async () => {
    const disk = {
      inventory: vi.fn(async () => 'read-only inventory'),
      requestCleanup: vi.fn(async () => ({ requestId: 'disk_1', summary: 'Exact tasks: task_1' })),
      decideCleanup: vi.fn(async () => 'cleanup completed'),
    };
    const controller = new FeishuTaskController(fakeOperations(), undefined, disk);

    await expect(controller.handleMessage(message('/disk inventory'))).resolves.toEqual({ text: 'read-only inventory' });
    const requested = await controller.handleMessage(message('/disk cleanup task_1'));
    expect(disk.requestCleanup).toHaveBeenCalledWith(expect.objectContaining({ taskIds: ['task_1'] }));
    expect(JSON.stringify(requested.rendered)).toContain('disk_cleanup_decision');
    await expect(controller.handleCardAction({
      chatId: 'oc_1', chatType: 'private', userId: 'ou_owner',
      action: { kind: 'disk_cleanup_decision', requestId: 'disk_1', decision: 'confirm' },
    })).resolves.toEqual({ text: 'cleanup completed' });
  });
});

function message(text: string, overrides = {}) {
  return { chatId: 'oc_1', chatType: 'private' as const, userId: 'ou_owner', text, wasMentioned: false, ...overrides };
}

function fakeOperations(): TaskControlOperations & Record<string, ReturnType<typeof vi.fn>> {
  return {
    projects: vi.fn(async () => [{ id: 'repo', name: 'Repo', path: '/repo', codexArgs: [] }]),
    createTask: vi.fn(async () => ({ taskId: 'task_1' })),
    contexts: vi.fn(async () => [{ id: 'context_1', state: 'active', threadId: 'thread_1' }]),
    useContext: vi.fn(async () => undefined),
    repositories: vi.fn(async () => [{ id: 'repository_1', projectId: 'repo', path: '/workspace', primary: true, status: 'ready' }]),
    addRepository: vi.fn(async () => ({ id: 'repository_2', path: '/workspace/repositories/repo2' })),
    memory: vi.fn(async () => 'memory'), remember: vi.fn(async () => ({ id: 'memory_1' })),
    forget: vi.fn(async () => undefined),
    dreamStatus: vi.fn(async () => 'dream status'), confirmBotMemory: vi.fn(async () => 'confirmed'),
    tasks: vi.fn(async () => [{ id: 'task_1', projectId: 'repo', state: 'hot', pinned: false }]),
    prepareSend: vi.fn(async () => undefined),
    useTask: vi.fn(async () => undefined), status: vi.fn(async () => 'status'), model: vi.fn(async () => 'model'),
    executionProfile: vi.fn(async () => ({ model: 'gpt-5.6-sol', reasoningEffort: 'medium', serviceTier: 'default' as const })),
    usage: vi.fn(async () => 'usage'),
    send: vi.fn(async () => undefined), interrupt: vi.fn(async () => undefined), stop: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined), pin: vi.fn(async () => undefined),
    requestPublish: vi.fn(async () => ({ requestId: 'pub_1' })), decidePublish: vi.fn(async () => 'published'),
    requestDelete: vi.fn(async () => ({ requestId: 'del_1' })), decideDelete: vi.fn(async () => 'deleted'),
    decideAppServerRequest: vi.fn(async () => 'decided'),
    decideProjectKnowledge: vi.fn(async () => 'Project knowledge approved.'),
  };
}
