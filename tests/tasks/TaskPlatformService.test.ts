import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe,expect,it,vi } from 'vitest';
import { AppServerRequestService } from '../../src/approvals/AppServerRequestService.js';
import { AppServerCodexBackend } from '../../src/appserver/AppServerCodexBackend.js';
import { AppServerResponseError } from '../../src/appserver/AppServerConnection.js';
import { AuthBroker } from '../../src/auth/AuthBroker.js';
import type { ToolAuthProvider } from '../../src/auth/AuthTypes.js';
import type {
BackendTask,CodexBackend,CodexBackendEvent,RespondServerRequestInput,
ResumeTaskInput,StartTaskInput,StartTurnInput,ThreadSnapshot,
} from '../../src/backends/CodexBackend.js';
import { NoActiveTurnError } from '../../src/backends/CodexBackend.js';
import { TaskContextService } from '../../src/contexts/TaskContextService.js';
import { continuationInputAuthorizer } from '../../src/conversation/ContinuationInputAuthorizer.js';
import type { ConversationContextMessage,ConversationContextProvider,ConversationContextRequest } from '../../src/conversation/ConversationContextProvider.js';
import { DetailResourceStore } from '../../src/details/DetailResourceStore.js';
import { SensitiveReplyDelivery,type SensitiveReplyContext } from '../../src/details/SensitiveReplyDelivery.js';
import { SqliteTurnDetailStore } from '../../src/details/SqliteTurnDetailStore.js';
import { createTurnDetailRuntime } from '../../src/details/TurnDetailRuntime.js';
import { FeishuOutbox } from '../../src/feishu/FeishuOutbox.js';
import { FeishuTaskController } from '../../src/feishu/FeishuTaskController.js';
import type { AppServerTurnExperience } from '../../src/livecards/AppServerTurnExperience.js';
import { MediaService } from '../../src/media/MediaService.js';
import { MemoryService } from '../../src/memory/MemoryService.js';
import { DynamicProjectCatalog } from '../../src/projects/DynamicProjectCatalog.js';
import { ProjectCreationService } from '../../src/projects/ProjectCreationService.js';
import { TaskRepositoryService } from '../../src/repositories/TaskRepositoryService.js';
import { SandboxRuntimeUpgradeRequiredError } from '../../src/runtime/SandboxSupervisorClient.js';
import { UserSandboxDockerRuntime } from '../../src/runtime/UserSandboxDockerRuntime.js';
import { SqliteStateStore } from '../../src/state/SqliteStateStore.js';
import {
TaskPlatformService,
type TaskPublishBroker,type TaskRuntimeProvisioner
} from '../../src/tasks/TaskPlatformService.js';
import type { TaskRecord,TaskRepositoryRecord } from '../../src/tasks/TaskTypes.js';
import { sampleConfig } from '../helpers/fakes.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('TaskPlatformService', () => {
  it.each([true, false])('privately delivers hidden content before final publication without leaking to results/events/outbox (live card=%s)', async (liveCard) => {
    const root = await createTmpDir();
    const send = vi.fn(async () => ({ messageId: 'private-receipt' }));
    const verify = vi.fn(async () => true);
    const delivery = new SensitiveReplyDelivery(join(root, 'private'), { verifySensitiveReplySource: verify, sendSensitiveReplyPrivate: send });
    const event = vi.fn(async () => liveCard);
    const h = await createHarness(undefined, false, false, false, undefined, undefined, undefined, true,
      (context, text) => delivery.prepare(context, text), { accepted: vi.fn(), event });
    await h.controller.handleMessage(message('/new repo'));
    const taskId = h.store.listTasks()[0]!.id;
    await h.controller.handleMessage(message('授权链接发我', { messageId: 'sensitive-source' }));
    const turn = h.store.listTurnsByTask(taskId)[0]!;
    h.backend.emit(taskId, { type: 'turn.completed', taskId, threadId: 'thread_1', turnId: 'codex_turn_1', status: 'completed',
      turn: { items: [{ type: 'agentMessage', text: 'https://example.test/authorize?state=fake-private-integration-secret\n完成后回复已授权。' }] } });
    await waitFor(() => h.store.getTurn(turn.id)?.state === 'completed');
    await waitFor(() => (h.store.db.prepare('SELECT count(*) AS n FROM turn_results').get() as { n: number }).n > 0);
    expect(verify).toHaveBeenCalledWith('sensitive-source', 'oc_1', 'ou_owner');
    expect(send).toHaveBeenCalledOnce();
    const completed = event.mock.calls.find((call) => (call as unknown as [{ type: string }])[0]?.type === 'turn.completed');
    expect(JSON.stringify(completed)).not.toContain('fake-private-integration-secret');
    expect(JSON.stringify(completed)).toContain('已通过 code bot 私聊发送');
    const persisted = JSON.stringify({ events: h.store.listTurnEvents(taskId), outbox: h.outbox.pending(),
      results: h.store.db.prepare('SELECT * FROM turn_results').all() });
    expect(persisted).not.toContain('fake-private-integration-secret');
    expect(persisted).toContain('隐私说明');
    await h.stop(taskId);
  });
  it('rejects a user sandbox upgrade while a turn is active', async () => {
    const h = await createHarness();
    h.config.userSandboxes = { ...h.config.userSandboxes!, enabled: true, enabledOwners: [], };
    await h.controller.handleMessage(message('/new repo'));
    const task = h.store.listTasks()[0]!;
    const upgrade = vi.fn(async () => 'upgraded');
    h.service.setSandboxRuntimeControl({ status: async () => 'status', upgrade });
    await h.controller.handleMessage(message('continue task'));
    const reply = await h.controller.handleMessage(message('/runtime upgrade'));
    expect(reply.text).toContain('任务正在执行');
    expect(upgrade).not.toHaveBeenCalled();
    await h.stop(task.id);
  });

  it('upgrades only the sending owner and preserves the durable task thread', async () => {
    const h = await createHarness();
    h.config.userSandboxes = { ...h.config.userSandboxes!, enabled: true, enabledOwners: [], };
    await h.controller.handleMessage(message('/new repo'));
    const task = h.store.listTasks()[0]!;
    const upgrade = vi.fn(async () => 'upgraded');
    h.service.setSandboxRuntimeControl({ status: async () => 'status', upgrade });
    expect((await h.controller.handleMessage(message('/runtime upgrade'))).text).toBe('upgraded');
    expect(upgrade).toHaveBeenCalledWith('ou_owner');
    expect(h.store.getTask(task.id)).toMatchObject({ runtimeState: 'warm', codexThreadId: task.codexThreadId });
    await h.stop(task.id);
  });
  it('upgrades a sandbox with historical tasks missing from the restarted App Server backend', async () => {
    const h = await createHarness();
    h.config.userSandboxes = { ...h.config.userSandboxes!, enabled: true, enabledOwners: [], };
    await h.controller.handleMessage(message('/new repo'));
    const task = h.store.listTasks()[0]!;
    h.store.saveTask({ ...task, id: 'task_historical', runtimeState: 'failed', activeTurnId: undefined });
    const restarted = new AppServerCodexBackend({ command: 'unused' });
    const stop = h.backend.stopTask.bind(h.backend);
    vi.spyOn(h.backend, 'stopTask').mockImplementation(async (taskId) => {
      await restarted.stopTask(taskId);
      await stop(taskId);
    });
    const upgrade = vi.fn(async () => 'upgraded');
    h.service.setSandboxRuntimeControl({ status: async () => 'status', upgrade });

    expect((await h.controller.handleMessage(message('/runtime upgrade'))).text).toBe('upgraded');
    expect(upgrade).toHaveBeenCalledWith('ou_owner');
    expect(h.store.getTask('task_historical')).toMatchObject({ runtimeState: 'warm', codexThreadId: task.codexThreadId });
    await h.stop(task.id);
  });
  it('records topic details independently of live cards without duplicating large event bodies', async () => {
    const h = await createHarness(undefined, false, false, false, undefined, undefined, undefined, true);
    h.config.liveCards.enabled = false;
    const group = { chatType: 'group' as const, chatId: 'oc_group', threadId: 'topic_1', wasMentioned: true };
    const reply = await h.controller.handleMessage(message('/new repo', { ...group, messageId: 'create' }));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    await h.controller.handleMessage(message('@bot record', { ...group, messageId: 'prompt' }));
    const localTurnId = h.store.getTask(taskId)!.activeTurnId!;
    const delta = { type: 'item.delta' as const, taskId, threadId: 'thread_1', turnId: 'codex_turn_1', itemId: 'item', channel: 'agent_message' as const, delta: 'same\n' };
    h.backend.emit(taskId, delta); h.backend.emit(taskId, delta);
    h.backend.emit(taskId, { type: 'turn.completed', taskId, threadId: 'thread_1', turnId: 'codex_turn_1', status: 'completed', turn: { items: [] } });
    await waitFor(() => h.outbox.pending().length === 1);
    await h.flushDetails();
    const details = new SqliteTurnDetailStore(join(h.root, 'state.sqlite'));
    try {
      const identity = { ownerKind: 'task_platform' as const, taskId, localTurnId };
      expect(details.getTurn(identity)).toMatchObject({ lifecycle: 'completed', scope: { kind: 'shared_group_topic', chatId: 'oc_group', topicId: 'topic_1' } });
      const entry = details.listEntries(identity)[0]!;
      const resources = new DetailResourceStore(join(h.root, 'state.sqlite.turn-details'));
      expect(resources.read(entry.resource!.resourceId, entry.resource!.committedBytes, 0, 100)).toBe('same\nsame\n');
      const persisted = h.store.listTurnEvents(taskId).filter((event) => event.eventType === 'item.delta');
      expect(persisted).toHaveLength(2);
      expect(JSON.stringify(persisted)).not.toContain('same');
      expect(JSON.stringify(persisted)).toContain('detailRef');
    } finally { details.close(); await h.stop(taskId); }
  });

  it('creates a dynamic repository and binds the same requester topic without a host checkout path', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.userSandboxes = {
      enabled: true, enabledOwners: [], legacyFallbackEnabled: false,
      maxAppServersPerUser: 8, maxActiveTurnsPerUser: 4,
      processIdleTimeoutMinutes: 120, containerIdleTimeoutMinutes: 1_440,
      containerWrapperRetentionHours: 24,
    };
    const actor = { chatId: 'oc_group', chatType: 'group' as const, topicId: 'topic_dynamic', userId: 'ou_owner' };
    const created = await harness.service.createTask({ ...actor, mode: 'chat' });
    const originalThread = harness.store.getTask(created.taskId)!.codexThreadId;
    harness.service.setDynamicProjectCatalog(new DynamicProjectCatalog(harness.store, harness.config));
    harness.provisioner.prepareProjectBinding = vi.fn(async (_task, project) => {
      expect(project).toMatchObject({ id: expect.stringMatching(/^dyn_/),
        sandboxCloneUrl: 'git@github.com:owner/repo.git', baseRef: 'main' });
      expect(project.path).toBe('');
      return { cwd: '/workspace/new-repo', branchName: 'codex/ou_owner/dynamic' };
    });
    const startTask = vi.fn();
    harness.backend.startTaskHook = startTask;
    const creation = new ProjectCreationService(harness.store, async () => ({ status: 'ready' }));
    creation.setExecutionPorts({
      create: vi.fn(async () => ({ status: 'created' as const, providerRepoId: 'gh_123', canonicalPath: 'owner/repo',
        cloneUrl: 'git@github.com:owner/repo.git', defaultBranch: 'main' })),
      readback: vi.fn(),
      bind: (requester, projectId, onCheckoutReady) =>
        harness.service.bindExistingProject(requester, projectId, onCheckoutReady),
    });
    const prepared = await creation.prepare(actor, { provider: 'github', namespace: 'owner', name: 'repo' });
    harness.service.setProjectCreationService(creation);
    await harness.service.confirmProjectCreation({ ...actor, text: '确认创建 owner/repo', messageId: 'om_confirm' });
    await harness.service.waitForProjectCreations();
    const operation = harness.store.getProjectCreationOperation(prepared.operationId!)!;

    expect(operation.status).toBe('bound');
    expect(harness.store.listTasks()).toHaveLength(1);
    expect(harness.store.getTask(created.taskId)).toMatchObject({ mode: 'project', projectId: operation.projectId });
    expect(harness.store.getTaskScopeByKey('personal-topic:ou_owner:oc_group:topic_dynamic')?.taskId).toBe(created.taskId);
    expect(harness.store.getTask(created.taskId)?.codexThreadId).not.toBe(originalThread);
    expect(startTask).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/workspace/new-repo' }));
    expect(harness.provisioner.prepareProjectBinding).toHaveBeenCalledOnce();
    expect(await harness.service.status(actor)).toContain(operation.projectId!);
    await harness.service.send({ ...actor, text: '继续编码', messageId: 'om_next' });
    expect(harness.backend.startedTurns.at(-1)?.prompt).toContain('继续编码');
    expect((await harness.service.projects(actor.userId, actor)).map((project) => project.id)).toContain(operation.projectId);
    expect((await harness.service.projects(actor.userId, { ...actor, topicId: 'other' })).map((project) => project.id))
      .not.toContain(operation.projectId);
    const boundTask = harness.store.getTask(created.taskId)!;
    harness.backend.emit(boundTask.id, { type: 'backend.server_request', taskId: boundTask.id, generation: 2,
      requestId: 'dynamic_status', method: 'item/tool/call', params: {
        threadId: boundTask.codexThreadId, tool: 'project_status', arguments: { projectId: operation.projectId },
      } });
    await waitFor(() => harness.backend.responses.some((response) => response.requestId === 'dynamic_status'));
    expect(JSON.stringify(harness.backend.responses.find((response) => response.requestId === 'dynamic_status')?.result))
      .toContain('"success":true');
    const dynamic = harness.store.getDynamicProject(operation.projectId!)!;
    harness.store.saveDynamicProject({ ...dynamic, state: 'suspended' });
    expect(await harness.service.status(actor)).toContain('suspended');
    await expect(harness.service.send({ ...actor, text: 'git fetch', messageId: 'om_revoked' }))
      .rejects.toThrow('suspended');
    expect(harness.store.getTask(created.taskId)?.codexThreadId).toBeTruthy();
    await harness.stop(created.taskId);
  });

  it('retains a newly created dynamic remote and pending chat bind when checkout authentication fails', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.userSandboxes = {
      enabled: true, enabledOwners: [], legacyFallbackEnabled: false,
      maxAppServersPerUser: 8, maxActiveTurnsPerUser: 4,
      processIdleTimeoutMinutes: 120, containerIdleTimeoutMinutes: 1_440,
      containerWrapperRetentionHours: 24,
    };
    const actor = { chatId: 'oc_group', chatType: 'group' as const, topicId: 'topic_dynamic_auth', userId: 'ou_owner' };
    const created = await harness.service.createTask({ ...actor, mode: 'chat' });
    harness.service.setDynamicProjectCatalog(new DynamicProjectCatalog(harness.store, harness.config));
    harness.provisioner.prepareProjectBinding = vi.fn()
      .mockRejectedValueOnce(new Error('checkout auth required'))
      .mockResolvedValue({ cwd: '/workspace/new-repo', branchName: 'branch' });
    const create = vi.fn(async () => ({ status: 'created' as const, providerRepoId: 'gh_124',
      canonicalPath: 'owner/repo', cloneUrl: 'git@github.com:owner/repo.git', defaultBranch: 'main' }));
    const creation = new ProjectCreationService(harness.store, async () => ({ status: 'ready' }));
    creation.setExecutionPorts({ create, readback: vi.fn(),
      bind: (requester, projectId, onCheckoutReady) =>
        harness.service.bindExistingProject(requester, projectId, onCheckoutReady) });
    const prepared = await creation.prepare(actor, { provider: 'github', namespace: 'owner', name: 'repo' });
    await creation.confirm(actor, '确认创建 owner/repo', 'om_confirm');

    await expect(creation.executeConfirmed(prepared.operationId!)).rejects.toThrow('checkout auth required');
    const pending = harness.store.getProjectCreationOperation(prepared.operationId!)!;
    expect(pending).toMatchObject({ status: 'registered', cloneUrl: 'git@github.com:owner/repo.git' });
    expect(harness.store.getTask(created.taskId)).toMatchObject({ mode: 'chat',
      pendingProjectBind: { projectId: pending.projectId, status: 'failed' } });
    await creation.recoverOpenOperations();
    expect(harness.store.getProjectCreationOperation(prepared.operationId!)?.status).toBe('bound');
    expect(create).toHaveBeenCalledOnce();
    await harness.stop(created.taskId);
  });

  it('finishes a pending dynamic bind and creation operation after the active chat turn ends', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.userSandboxes = {
      enabled: true, enabledOwners: [], legacyFallbackEnabled: false,
      maxAppServersPerUser: 8, maxActiveTurnsPerUser: 4,
      processIdleTimeoutMinutes: 120, containerIdleTimeoutMinutes: 1_440,
      containerWrapperRetentionHours: 24,
    };
    const actor = { chatId: 'oc_group', chatType: 'group' as const, topicId: 'topic_dynamic_active', userId: 'ou_owner' };
    const created = await harness.service.createTask({ ...actor, mode: 'chat' });
    await harness.service.send({ ...actor, text: '先总结需求', messageId: 'om_active' });
    const oldThreadId = harness.store.getTask(created.taskId)!.codexThreadId!;
    harness.service.setDynamicProjectCatalog(new DynamicProjectCatalog(harness.store, harness.config));
    harness.provisioner.prepareProjectBinding = vi.fn(async () => ({ cwd: '/workspace/new-repo', branchName: 'branch' }));
    const creation = new ProjectCreationService(harness.store, async () => ({ status: 'ready' }));
    creation.setExecutionPorts({ create: vi.fn(async () => ({ status: 'created' as const, providerRepoId: 'gh_126',
      canonicalPath: 'owner/repo', cloneUrl: 'git@github.com:owner/repo.git', defaultBranch: 'main' })),
      readback: vi.fn(), bind: (requester, projectId, onCheckoutReady) =>
        harness.service.bindExistingProject(requester, projectId, onCheckoutReady) });
    harness.service.setProjectCreationService(creation);
    const prepared = await creation.prepare(actor, { provider: 'github', namespace: 'owner', name: 'repo' });
    await creation.confirm(actor, '确认创建 owner/repo', 'om_confirm');
    expect((await creation.executeConfirmed(prepared.operationId!)).status).toBe('registered');
    expect(harness.store.getTask(created.taskId)).toMatchObject({ mode: 'chat',
      pendingProjectBind: { status: 'requested' } });

    harness.backend.emit(created.taskId, { type: 'turn.completed', taskId: created.taskId,
      threadId: oldThreadId, turnId: 'codex_turn_1', status: 'completed',
      turn: { id: 'codex_turn_1', status: 'completed', items: [] } });
    await waitFor(() => harness.store.getTask(created.taskId)?.mode === 'project');
    await waitFor(() => harness.store.getProjectCreationOperation(prepared.operationId!)?.status === 'bound');
    expect(harness.store.getTaskScopeByKey('personal-topic:ou_owner:oc_group:topic_dynamic_active')?.taskId)
      .toBe(created.taskId);
    await harness.stop(created.taskId);
  });

  it('preserves the prior chat history when the new dynamic project thread cannot start', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.userSandboxes = {
      enabled: true, enabledOwners: [], legacyFallbackEnabled: false,
      maxAppServersPerUser: 8, maxActiveTurnsPerUser: 4,
      processIdleTimeoutMinutes: 120, containerIdleTimeoutMinutes: 1_440,
      containerWrapperRetentionHours: 24,
    };
    const actor = { chatId: 'oc_group', chatType: 'group' as const, topicId: 'topic_dynamic_thread', userId: 'ou_owner' };
    const created = await harness.service.createTask({ ...actor, mode: 'chat' });
    harness.store.saveTurn({ id: 'turn_chat_history', taskId: created.taskId, prompt: 'Earlier discussion',
      state: 'completed', createdBy: 'ou_owner', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    harness.service.setDynamicProjectCatalog(new DynamicProjectCatalog(harness.store, harness.config));
    harness.provisioner.prepareProjectBinding = vi.fn(async () => ({ cwd: '/workspace/new-repo', branchName: 'branch' }));
    harness.backend.startTaskError = new Error('new thread rejected');
    const create = vi.fn(async () => ({ status: 'created' as const, providerRepoId: 'gh_125',
      canonicalPath: 'owner/repo', cloneUrl: 'git@github.com:owner/repo.git', defaultBranch: 'main' }));
    const creation = new ProjectCreationService(harness.store, async () => ({ status: 'ready' }));
    creation.setExecutionPorts({ create, readback: vi.fn(),
      bind: (requester, projectId, onCheckoutReady) =>
        harness.service.bindExistingProject(requester, projectId, onCheckoutReady) });
    const prepared = await creation.prepare(actor, { provider: 'github', namespace: 'owner', name: 'repo' });
    await creation.confirm(actor, '确认创建 owner/repo', 'om_confirm');

    await expect(creation.executeConfirmed(prepared.operationId!)).rejects.toThrow('new thread rejected');
    expect(harness.store.getTask(created.taskId)?.mode).toBe('chat');
    expect(harness.store.listTurnsByTask(created.taskId).map((turn) => turn.prompt)).toContain('Earlier discussion');
    expect(harness.store.getProjectCreationOperation(prepared.operationId!)).toMatchObject({ status: 'checkout_ready' });
    harness.backend.startTaskError = undefined;
    await creation.recoverOpenOperations();
    expect(harness.store.getTask(created.taskId)).toMatchObject({ mode: 'project' });
    expect(harness.store.listTurnsByTask(created.taskId).map((turn) => turn.prompt)).toContain('Earlier discussion');
    expect(create).toHaveBeenCalledOnce();
    await harness.stop(created.taskId);
  });
  it('prepares a repository through the chat-only model tool but reserves creation for Feishu confirmation', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.userSandboxes = {
      enabled: true, enabledOwners: [], legacyFallbackEnabled: false,
      maxAppServersPerUser: 8, maxActiveTurnsPerUser: 4,
      processIdleTimeoutMinutes: 120, containerIdleTimeoutMinutes: 1_440,
      containerWrapperRetentionHours: 24,
    };
    const actor = { chatId: 'oc_group', chatType: 'group' as const, topicId: 'topic_creation', userId: 'ou_owner' };
    const created = await harness.service.createTask({ ...actor, mode: 'chat' });
    const validate = vi.fn(async () => ({ status: 'ready' as const }));
    harness.service.setProjectCreationService(new ProjectCreationService(harness.store, validate));
    await harness.service.send({ ...actor, text: '创建一个项目', messageId: 'om_request' });
    const task = harness.store.getTask(created.taskId)!;
    harness.backend.emit(task.id, { type: 'backend.server_request', taskId: task.id, generation: 1,
      requestId: 'prepare_1', method: 'item/tool/call', params: {
        threadId: task.codexThreadId, tool: 'project_creation_prepare',
        arguments: { provider: 'github', namespace: 'owner', name: 'repo' },
      } });
    await waitFor(() => harness.backend.responses.some((response) => response.requestId === 'prepare_1'));

    expect(harness.backend.responses.find((response) => response.requestId === 'prepare_1'))
      .toMatchObject({ result: { success: true } });
    const operation = harness.store.getOpenProjectCreationOperation('ou_owner', 'oc_group', 'topic_creation')!;
    expect(operation.status).toBe('awaiting_confirmation');
    expect(validate).toHaveBeenCalledOnce();
    await expect(harness.service.confirmProjectCreation({ ...actor, text: '确认创建 owner/repo', messageId: 'om_confirm' }))
      .resolves.toMatchObject({ text: expect.stringContaining('确认') });
    expect(harness.store.getProjectCreationOperation(operation.operationId)?.status).toBe('creating');
    expect(harness.store.listTasks()).toHaveLength(1);
    await harness.stop(task.id);
  });
  it('registers a task artifact through the Manager tool and queues it after turn completion', async () => {
    const harness = await createHarness(
      undefined, false, false, false, undefined, undefined,
      ({ root, store, provisioner }) => new MediaService({
        enabled: true, storageRoot: join(root, 'media'), maxImagesPerTurn: 8, maxFilesPerTurn: 10,
        maxImageBytes: 10_485_760, maxFileBytes: 52_428_800, maxTotalBytesPerTurn: 104_857_600,
        pendingGroupAttachmentTtlMs: 300_000, retentionHours: 24,
      }, store, {}, provisioner),
    );
    await harness.controller.handleMessage(message('/new repo'));
    await harness.controller.handleMessage(message('生成结果文件', { messageId: 'om_artifact' }));
    expect(harness.backend.startedTurns.at(-1)?.prompt).toContain('artifact_publish');
    expect(harness.backend.startedTurns.at(-1)?.prompt).toContain('/workspace/.linkbot/artifacts/');
    expect(harness.backend.startedTurns.at(-1)?.prompt).toContain('Markdown image link is not a Feishu attachment');
    const task = harness.store.listTasks()[0]!;
    expect(harness.store.getActiveTaskContext(task.id)?.mediaToolRevision).toBe(1);
    expect(harness.backend.startedTurns.at(-1)?.prompt).not.toContain('manager_context_handoff');
    const turn = harness.store.listTurnsByTask(task.id)[0]!;

    harness.backend.emit(task.id, {
      type: 'backend.server_request', taskId: task.id, generation: 1, requestId: 'artifact_1', method: 'item/tool/call',
      params: { threadId: task.codexThreadId, tool: 'artifact_publish', arguments: {
        path: '/workspace/.linkbot/outbox/result.txt', disposition: 'file', displayName: 'result.txt',
      } },
    });
    await waitFor(() => harness.backend.responses.some((response) => response.requestId === 'artifact_1'));
    expect(harness.backend.responses.find((response) => response.requestId === 'artifact_1'))
      .toMatchObject({ result: { success: true } });
    expect(harness.media?.outboundForTurn(task.id, turn.id)).toHaveLength(1);

    harness.backend.emit(task.id, {
      type: 'turn.completed', taskId: task.id, threadId: task.codexThreadId!, turnId: 'codex_turn_1',
      status: 'completed', turn: { id: 'codex_turn_1', status: 'completed', items: [] },
    });
    await waitFor(() => harness.outbox.pending().some((event) => event.eventType === 'media_send'));
    expect(harness.outbox.pending().find((event) => event.eventType === 'media_send'))
      .toMatchObject({ payload: { kind: 'media_send' } });
    await harness.stop(task.id);
  });

  it.each(['hot', 'warm'] as const)('replaces an old %s thread before a media turn so the tool can be injected', async (initialState) => {
    const harness = await createHarness(
      undefined, false, false, false, undefined, undefined,
      ({ root, store, provisioner }) => new MediaService({
        enabled: true, storageRoot: join(root, 'media'), maxImagesPerTurn: 8, maxFilesPerTurn: 10,
        maxImageBytes: 10_485_760, maxFileBytes: 52_428_800, maxTotalBytesPerTurn: 104_857_600,
        pendingGroupAttachmentTtlMs: 300_000, retentionHours: 24,
      }, store, {}, provisioner),
    );
    await harness.controller.handleMessage(message('/new repo'));
    const original = harness.store.listTasks()[0]!;
    const oldContext = harness.store.getActiveTaskContext(original.id)!;
    expect(oldContext.mediaToolRevision).toBe(1);
    harness.store.saveTaskContext({ ...oldContext, mediaToolRevision: undefined });
    if (initialState === 'warm') {
      await harness.backend.stopTask(original.id);
      await harness.service.waitForEvents(original.id);
      harness.store.updateTask(original.id, (task) => ({ ...task, runtimeState: 'warm' }));
    }

    await harness.controller.handleMessage(message('把现有截图作为飞书图片发给我'));

    const current = harness.store.getTask(original.id)!;
    expect(harness.backend.resumeInputs).toHaveLength(initialState === 'warm' ? 1 : 0);
    expect(current.codexThreadId).not.toBe(original.codexThreadId);
    expect(harness.store.getActiveTaskContext(original.id)?.mediaToolRevision).toBe(1);
    expect(harness.backend.archivedThreads).toContain(original.codexThreadId);
    expect(harness.backend.startedTurns.at(-1)?.prompt).toContain('<manager_context_handoff authority="manager">');
    expect(harness.backend.startedTurns.at(-1)?.prompt).toContain('artifact_publish');
    await harness.stop(original.id);
  });

  it('parks an idle review automation task without interrupting an active turn', async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.store.saveTask({
      id: 'task_review', ownerUserId: 'ou_1', projectId: 'repo', baseRef: 'develop',
      branchName: 'codex/ou_1/task_review', runtimeState: 'hot', activeTurnId: 'turn_running',
      pinned: false, lastUserInteractionAt: now, createdAt: now, updatedAt: now,
    });
    const stopTask = vi.spyOn(harness.backend, 'stopTask');

    await harness.service.releaseAutomationTaskIfIdle('task_review');
    expect(stopTask).not.toHaveBeenCalled();
    expect(harness.store.getTask('task_review')?.runtimeState).toBe('hot');

    harness.store.updateTask('task_review', (task) => ({ ...task, activeTurnId: undefined }));
    await harness.service.releaseAutomationTaskIfIdle('task_review');
    expect(stopTask).toHaveBeenCalledWith('task_review');
    expect(harness.provisioner.stop).toHaveBeenCalledOnce();
    expect(harness.store.getTask('task_review')?.runtimeState).toBe('warm');

    await harness.service.releaseAutomationTaskIfIdle('task_review');
    expect(harness.provisioner.stop).toHaveBeenCalledOnce();
    harness.store.close();
  });

  it('routes an explicit project before starting an allowlisted user sandbox', async () => {
    const harness = await createHarness(undefined, true);
    harness.config.userSandboxes = {
      enabled: true,
      enabledOwners: ['ou_1'],

      legacyFallbackEnabled: true,
      maxAppServersPerUser: 8,
      maxActiveTurnsPerUser: 4,
      processIdleTimeoutMinutes: 120,
      containerIdleTimeoutMinutes: 1_440,
      containerWrapperRetentionHours: 24,
    };
    harness.config.taskPlatformRollout.enabled = true;
    harness.config.taskPlatformRollout.enabledOwners = ['ou_1'];
    harness.config.taskPlatformRollout.appServerDefault = true;
    harness.config.upgrade.adminUsers = ['ou_1'];
    const text = '请在 repo 项目排查任务启动问题';
    const prepareAuth = vi.fn(async () => ({ text: 'host auth should not run' }));
    harness.service.setAuthBroker({ prepare: prepareAuth } as never);

    await expect(harness.service.prepareSend({
      chatId: 'ou_1', chatType: 'private', userId: 'ou_1', text,
    })).resolves.toBeUndefined();
    await harness.service.send({ chatId: 'ou_1', chatType: 'private', userId: 'ou_1', text });

    const task = harness.store.listTasks()[0];
    expect(task.runtimeMode).toBe('user-sandbox');
    expect(task.sandboxWorkspaceLayout).toBe('project');
    expect(harness.backend.startedTurns[0]?.prompt).toBe(text);
    expect(harness.provisioner.refreshWorkspaceFiles).not.toHaveBeenCalled();
    expect(prepareAuth).not.toHaveBeenCalled();
    await harness.stop(task.id);
  });

  it('routes every owner to a user sandbox when the owner rollout list is empty', async () => {
    const harness = await createHarness(undefined, true);
    harness.config.userSandboxes = {
      enabled: true,
      enabledOwners: [],

      legacyFallbackEnabled: false,
      maxAppServersPerUser: 8,
      maxActiveTurnsPerUser: 4,
      processIdleTimeoutMinutes: 120,
      containerIdleTimeoutMinutes: 1_440,
      containerWrapperRetentionHours: 24,
    };
    harness.config.taskPlatformRollout.enabled = true;
    harness.config.taskPlatformRollout.enabledOwners = [];
    harness.config.taskPlatformRollout.appServerDefault = true;
    harness.config.upgrade.adminUsers = ['ou_new'];

    await harness.service.send({
      chatId: 'ou_new', chatType: 'private', userId: 'ou_new', text: 'inspect the repo project',
    });

    const task = harness.store.listTasks()[0];
    expect(task.runtimeMode).toBe('user-sandbox');
    await harness.stop(task.id);
  });

  it('asks for a project before creating an ambiguous per-user sandbox task', async () => {
    const harness = await createHarness(undefined, true);
    harness.config.userSandboxes = {
      enabled: true, enabledOwners: [], legacyFallbackEnabled: false,
      maxAppServersPerUser: 8, maxActiveTurnsPerUser: 4,
      processIdleTimeoutMinutes: 120, containerIdleTimeoutMinutes: 1_440,
      containerWrapperRetentionHours: 24,
    };
    harness.config.taskPlatformRollout.enabled = true;
    harness.config.taskPlatformRollout.appServerDefault = true;
    harness.config.upgrade.adminUsers = ['ou_owner'];

    const reply = await harness.controller.handleMessage(message('继续排查', { messageId: 'om_sandbox_route' }));
    expect(reply.rendered?.preferred.kind).toBe('card');
    expect(harness.store.listTasks()).toEqual([]);
    expect(harness.provisioner.provision).not.toHaveBeenCalled();
    const routing = harness.store.getPendingProjectRoutingByMessage('om_sandbox_route')!;
    await harness.controller.handleCardAction({
      chatId: 'oc_1', chatType: 'private', userId: 'ou_owner', messageId: 'om_card',
      action: { kind: 'project_routing_select', routingId: routing.id, projectId: 'repo2' },
    });
    expect(harness.store.listTasks()[0]).toMatchObject({
      runtimeMode: 'user-sandbox', sandboxWorkspaceLayout: 'project', projectId: 'repo2',
    });
    await harness.stop(harness.store.listTasks()[0]!.id);
  });

  it('explicitly starts an unbound chat task without a project checkout', async () => {
    const harness = await createHarness(undefined, true);
    harness.config.userSandboxes = {
      enabled: true, enabledOwners: [], legacyFallbackEnabled: false,
      maxAppServersPerUser: 8, maxActiveTurnsPerUser: 4,
      processIdleTimeoutMinutes: 120, containerIdleTimeoutMinutes: 1_440,
      containerWrapperRetentionHours: 24,
    };
    harness.config.taskPlatformRollout.enabled = true;
    harness.config.taskPlatformRollout.appServerDefault = true;
    const actor = { chatId: 'oc_chat', chatType: 'group' as const, topicId: 'omt_chat', userId: 'ou_owner' };

    const created = await harness.service.createTask({ ...actor, mode: 'chat' });

    expect(harness.store.getTask(created.taskId)).toMatchObject({ mode: 'chat', runtimeMode: 'user-sandbox' });
    expect(harness.store.getTask(created.taskId)).not.toHaveProperty('projectId');
    expect('project' in vi.mocked(harness.provisioner.provision).mock.calls.at(-1)![0]).toBe(false);
    expect(harness.store.listTaskRepositories(created.taskId)).toEqual([]);
    await harness.stop(created.taskId);
  });

  it('starts an ordinary topic in tool-capable chat mode without inferring a project from chat context', async () => {
    const context: ConversationContextProvider = { collect: vi.fn(async () => ({
      scope: 'topic' as const, chatId: 'oc_group', threadId: 'topic_chat', truncated: false, fetchedAt: '',
      messages: [{ messageId: 'om_old', createdAt: '1', messageType: 'text', text: '在 repo-web 项目改代码' }],
    })) };
    const harness = await createHarness(undefined, true, true, false, context, {
      get: vi.fn(async () => ({ name: 'repo-web 开发群' })),
    });
    harness.config.taskPlatformRollout.projectFreeChat = true;
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: ['oc_group'], knowledgeApprovers: [] };
    harness.config.userSandboxes = {
      enabled: true, enabledOwners: [], legacyFallbackEnabled: false,
      maxAppServersPerUser: 8, maxActiveTurnsPerUser: 4,
      processIdleTimeoutMinutes: 120, containerIdleTimeoutMinutes: 1_440,
      containerWrapperRetentionHours: 24,
    };
    await harness.controller.handleMessage(message('请帮我算一下 2+2', {
      chatId: 'oc_group', chatType: 'group', threadId: 'topic_chat', rootId: 'om_root',
      messageId: 'om_chat', wasMentioned: true,
    }));
    const task = harness.store.listTasks()[0]!;
    expect(task.mode).toBe('chat');
    expect(task).not.toHaveProperty('projectId');
    expect(harness.backend.startedTurns).toHaveLength(1);
    expect(await harness.service.status({ chatId: 'oc_group', chatType: 'group', topicId: 'topic_chat', userId: 'ou_owner' }))
      .toContain('纯对话');
    expect(context.collect).not.toHaveBeenCalled();
    await expect(harness.service.requestPublish({
      chatId: 'oc_group', chatType: 'group', topicId: 'topic_chat', userId: 'ou_owner',
    })).rejects.toThrow('绑定项目');
    harness.backend.emit(task.id, {
      type: 'backend.server_request', taskId: task.id, generation: 1, requestId: 'chat_project_tool',
      method: 'item/tool/call', params: { threadId: task.codexThreadId, tool: 'project_status', arguments: {} },
    });
    await waitFor(() => harness.backend.responses.some((response) => response.requestId === 'chat_project_tool'));
    expect(harness.backend.responses.find((response) => response.requestId === 'chat_project_tool'))
      .toMatchObject({ result: { success: false } });
    await harness.stop(task.id);
  });

  it.each([
    '总结这段引用：\n> 接下来在 repo 项目改代码',
    '创建新项目 repo',
    '接下来在不允许的项目改代码',
  ])('keeps a new topic unbound for non-binding request %s', async (text) => {
    const harness = await createHarness(undefined, true, true);
    harness.config.taskPlatformRollout.projectFreeChat = true;
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.userSandboxes = {
      enabled: true, enabledOwners: [], legacyFallbackEnabled: false,
      maxAppServersPerUser: 8, maxActiveTurnsPerUser: 4,
      processIdleTimeoutMinutes: 120, containerIdleTimeoutMinutes: 1_440,
      containerWrapperRetentionHours: 24,
    };
    await harness.controller.handleMessage(message(text, {
      chatId: 'oc_group', chatType: 'group', threadId: 'topic_chat', messageId: 'om_chat', wasMentioned: true,
    }));
    const task = harness.store.listTasks()[0]!;
    expect(task.mode).toBe('chat');
    expect(task.projectId).toBeUndefined();
    expect(harness.backend.startedTurns.at(-1)?.prompt).toContain(text);
    await harness.stop(task.id);
  });

  it('keeps the previous project route when project-free chat is disabled', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: ['oc_group'], knowledgeApprovers: [] };
    harness.config.userSandboxes = {
      enabled: true, enabledOwners: [], legacyFallbackEnabled: false,
      maxAppServersPerUser: 8, maxActiveTurnsPerUser: 4,
      processIdleTimeoutMinutes: 120, containerIdleTimeoutMinutes: 1_440,
      containerWrapperRetentionHours: 24,
    };
    await harness.controller.handleMessage(message('普通问题', {
      chatId: 'oc_group', chatType: 'group', threadId: 'topic_legacy', messageId: 'om_legacy', wasMentioned: true,
    }));
    expect(harness.store.listTasks()[0]).toMatchObject({ projectId: 'repo', mode: 'project' });
    await harness.stop(harness.store.listTasks()[0]!.id);
  });

  it('lets the conversation model interpret project intent instead of binding from a fixed sentence pattern', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.taskPlatformRollout.projectFreeChat = true;
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: ['oc_group'], knowledgeApprovers: [] };
    harness.config.userSandboxes = {
      enabled: true, enabledOwners: [], legacyFallbackEnabled: false,
      maxAppServersPerUser: 8, maxActiveTurnsPerUser: 4,
      processIdleTimeoutMinutes: 120, containerIdleTimeoutMinutes: 1_440,
      containerWrapperRetentionHours: 24,
    };
    await harness.controller.handleMessage(message('使用 repo 项目，看一下这个问题', {
      chatId: 'oc_group', chatType: 'group', threadId: 'topic_project', messageId: 'om_project', wasMentioned: true,
    }));
    const task = harness.store.listTasks()[0]!;
    expect(task.mode).toBe('chat');
    expect(task.projectId).toBeUndefined();
    expect(harness.backend.startedTurns.at(-1)?.prompt).toContain('project_binding_catalog');
    await harness.stop(task.id);
  });

  it('keeps an ambiguous project name in chat and asks for clarification in the turn', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.taskPlatformRollout.projectFreeChat = true;
    harness.config.userSandboxes = {
      enabled: true, enabledOwners: [], legacyFallbackEnabled: false,
      maxAppServersPerUser: 8, maxActiveTurnsPerUser: 4,
      processIdleTimeoutMinutes: 120, containerIdleTimeoutMinutes: 1_440,
      containerWrapperRetentionHours: 24,
    };
    for (const project of harness.config.projects) {
      project.name = 'Shared';
      project.access = { allowedUsers: ['ou_owner'], allowedChats: ['oc_group'], knowledgeApprovers: [] };
    }
    await harness.controller.handleMessage(message('接下来在 Shared 项目改代码', {
      chatId: 'oc_group', chatType: 'group', threadId: 'topic_ambiguous', messageId: 'om_ambiguous', wasMentioned: true,
    }));
    const task = harness.store.listTasks()[0]!;
    expect(task.mode).toBe('chat');
    expect(harness.backend.startedTurns.at(-1)?.prompt).toContain('有歧义时先澄清');
    await harness.stop(task.id);
  });

  it.each([
    '你要切换到 repo 这个项目',
    '接下来按 Repo 的代码继续分析',
    'Please move this conversation to Repo so we can inspect the implementation.',
  ])('accepts a model-selected binding without sentence matching: %s', async (text) => {
    const { harness, scope, task } = await createSemanticBindingHarness(text);
    harness.backend.emit(task.id, {
      type: 'backend.server_request', taskId: task.id, generation: 1, requestId: 'catalog',
      method: 'item/tool/call', params: { threadId: task.codexThreadId, tool: 'project_binding_catalog', arguments: {} },
    });
    await waitFor(() => harness.backend.responses.some((response) => response.requestId === 'catalog'));
    const catalog = JSON.stringify(harness.backend.responses.find((response) => response.requestId === 'catalog'));
    expect(catalog).toContain('repo');
    expect(catalog).not.toContain(harness.config.projects[1]!.id);
    harness.backend.emit(task.id, {
      type: 'backend.server_request', taskId: task.id, generation: 1, requestId: 'bind',
      method: 'item/tool/call', params: { threadId: task.codexThreadId, tool: 'project_bind',
        arguments: { projectId: 'repo', requestText: text } },
    });
    await waitFor(() => harness.backend.responses.some((response) => response.requestId === 'bind'));
    expect(harness.backend.responses.find((response) => response.requestId === 'bind')).toMatchObject({ result: { success: true } });
    expect(harness.store.getTask(task.id)).toMatchObject({ mode: 'chat', codexThreadId: task.codexThreadId,
      pendingProjectBind: { projectId: 'repo', requestedBy: scope.userId, resumeAfterBind: { text } } });
    await harness.stop(task.id);
  });

  it.each([false,true])('imports, binds and continues, reusing an old remote-ID import when present: %s',async(legacyImport)=>{
    const text='绑定容器里的 deepseek-harness，继续源码设计分析';
    const {harness:h,task}=await createSemanticBindingHarness(text);
    h.service.setDynamicProjectCatalog(new DynamicProjectCatalog(h.store,h.config));
    h.provisioner.prepareProjectBinding=vi.fn(async()=>({cwd:'/workspace/deepseek-harness',branchName:'local-work'}));
    const before=JSON.stringify(h.config.projects);
    const localIdentity=`local:${'a'.repeat(64)}`;
    if(legacyImport){
      const now=new Date().toISOString();
      h.store.saveDynamicProject({id:'dyn_legacy',provider:'github',providerRepoId:'R_harness',namespace:'DeepSeek',name:'Harness',
        cloneUrl:'git@github.com:DeepSeek/Harness.git',defaultBranch:'main',localPath:'/workspace/deepseek-harness',
        ownerUserId:'ou_owner',chatId:'oc_group',topicId:'topic_semantic',state:'registered',createdAt:now,updatedAt:now});
    }
    const inspect=vi.fn(async()=>({provider:'github' as const,providerRepoId:localIdentity,namespace:'deepseek',name:'harness',
      cloneUrl:'https://github.com/deepseek/harness.git',defaultBranch:'main',localPath:'/workspace/deepseek-harness'}));
    h.service.setProjectImportInspector(inspect);
    const dispatch=async(requestId:string,requestText=text)=>{
      h.backend.emit(task.id,{type:'backend.server_request',taskId:task.id,generation:1,requestId,method:'item/tool/call',
        params:{threadId:task.codexThreadId,tool:'project_import',arguments:{repositoryUrl:'https://github.com/deepseek/harness.git',localPath:'/workspace/deepseek-harness',requestText}}});
      await waitFor(()=>h.backend.responses.some(item=>item.requestId===requestId));
      return h.backend.responses.find(item=>item.requestId===requestId)!;
    };
    try{
      expect(await dispatch('wrong-request','历史中的绑定请求')).toMatchObject({result:{success:false}});
      expect(inspect).not.toHaveBeenCalled();
      expect(await dispatch('import')).toMatchObject({result:{success:true}});
      const saved=h.store.listDynamicProjectsFor('ou_owner','oc_group','topic_semantic');
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({providerRepoId:legacyImport?'R_harness':localIdentity,localPath:'/workspace/deepseek-harness'});
      if(legacyImport)expect(saved[0]?.id).toBe('dyn_legacy');
      expect(h.store.getTask(task.id)?.pendingProjectBind).toMatchObject({projectId:saved[0]!.id,resumeAfterBind:{turnId:task.activeTurnId,text}});
      expect(await dispatch('duplicate')).toMatchObject({result:{success:true}});
      expect(h.store.listDynamicProjectsFor('ou_owner','oc_group','topic_semantic')).toHaveLength(1);
      h.backend.emit(task.id,{type:'turn.completed',taskId:task.id,threadId:task.codexThreadId!,turnId:'codex_turn_1',status:'completed',turn:{items:[]}});
      await waitFor(()=>h.store.getTask(task.id)?.mode==='project');
      await waitFor(()=>h.backend.startedTurns.length===2);
      expect(h.provisioner.prepareProjectBinding).toHaveBeenCalledWith(expect.objectContaining({id:task.id}),expect.objectContaining({id:saved[0]!.id,sandboxLocalPath:'/workspace/deepseek-harness'}));
      expect(h.backend.startedTurns.at(-1)?.prompt).toContain(text);
      expect(JSON.stringify(h.config.projects)).toBe(before);
    }finally{await h.stop(task.id);}
  });
  it.each(['origin','provider-rate-limit'])('handles local import without a remote dependency: %s',async(reason)=>{
    const text='绑定这个项目';
    const {harness:h,task}=await createSemanticBindingHarness(text);
    if(reason==='origin')h.service.setProjectImportInspector(async()=>{throw new Error('Project origin mismatch');});
    else{
      const runtime=new UserSandboxDockerRuntime({image:'unused',bridgeRoot:h.root,cpuLimit:1,memoryLimitBytes:1024,pidLimit:32,tmpfsLimitBytes:1024,network:'none',maxAppServersPerUser:2,hostUid:1001,hostGid:1001},
        {run:vi.fn(async(args)=>{
          if(args[4]==='gh')return {stdout:'',stderr:'gh not logged in',exitCode:4};
          if(args[4]==='curl')return {stdout:JSON.stringify({message:'API rate limit exceeded for shared egress'}),stderr:'HTTP 403',exitCode:22};
          return {stdout:args[4]==='realpath'||args.includes('--show-toplevel')?'/workspace/repo':args.includes('get-url')?'https://github.com/team/repo':args.includes('symbolic-ref')?'feature':'a'.repeat(40),stderr:'',exitCode:0};
        })});
      const container=runtime.describe({id:'fixture',ownerId:'ou_owner',generation:1});
      h.service.setProjectImportInspector((_owner,path,url)=>runtime.inspectExistingProject(container,path,url));
    }
    try{
      h.backend.emit(task.id,{type:'backend.server_request',taskId:task.id,generation:1,requestId:'failed-import',method:'item/tool/call',
        params:{threadId:task.codexThreadId,tool:'project_import',arguments:{repositoryUrl:'https://github.com/team/repo',localPath:'/workspace/repo',requestText:text}}});
      await waitFor(()=>h.backend.responses.some(item=>item.requestId==='failed-import'));
      expect(h.backend.responses.find(item=>item.requestId==='failed-import')).toMatchObject({result:{success:reason!=='origin'}});
      const projects=h.store.listDynamicProjectsFor('ou_owner','oc_group','topic_semantic');
      if(reason==='origin'){
        expect(projects).toEqual([]);
        expect(h.store.getTask(task.id)?.pendingProjectBind).toBeUndefined();
      }else{
        expect(projects).toHaveLength(1);
        expect(projects[0]?.providerRepoId).toMatch(/^local:[a-f0-9]{64}$/);
        expect(h.store.getTask(task.id)?.pendingProjectBind?.projectId).toBe(projects[0]?.id);
      }
    }finally{await h.stop(task.id);}
  });
  it('continues a completed first-round source analysis request when the next round only asks to bind this project',async()=>{
    const original='帮我拉 DeepSeek Harness，根据源码分析整体设计';
    const {harness:h,scope,task}=await createSemanticBindingHarness(original);
    h.service.setDynamicProjectCatalog(new DynamicProjectCatalog(h.store,h.config));
    h.provisioner.prepareProjectBinding=vi.fn(async()=>({cwd:'/workspace/deepseek-harness',branchName:'main'}));
    h.service.setProjectImportInspector(async()=>({provider:'github',providerRepoId:'R_harness',namespace:'deepseek',name:'harness',cloneUrl:'https://github.com/deepseek/harness',defaultBranch:'main',localPath:'/workspace/deepseek-harness'}));
    try{
      h.backend.emit(task.id,{type:'turn.completed',taskId:task.id,threadId:task.codexThreadId!,turnId:'codex_turn_1',status:'completed',turn:{items:[]}});
      await waitFor(()=>!h.store.getTask(task.id)?.activeTurnId);
      h.backend.emitTurnStarted=false;
      h.backend.startTurnResultId='codex_second';
      await h.service.send({...scope,text:'绑定这个项目',messageId:'om_bind_only'});
      const current=h.store.getTask(task.id)!,turn=h.store.getTurn(current.activeTurnId!)!;
      h.backend.emit(task.id,{type:'backend.server_request',taskId:task.id,generation:current.connectionGeneration!,requestId:'second-round-import',method:'item/tool/call',
        params:{threadId:current.codexThreadId,tool:'project_import',arguments:{repositoryUrl:'https://github.com/deepseek/harness',localPath:'/workspace/deepseek-harness',requestText:'绑定这个项目'}}});
      await waitFor(()=>h.backend.responses.some(item=>item.requestId==='second-round-import'));
      expect(h.store.getTask(task.id)?.pendingProjectBind?.resumeAfterBind?.text).toContain(original);
      h.backend.startTurnResultId='codex_continuation';
      h.backend.emit(task.id,{type:'turn.completed',taskId:task.id,threadId:current.codexThreadId!,turnId:turn.codexTurnId!,status:'completed',turn:{items:[]}});
      await waitFor(()=>h.backend.startedTurns.length===3);
      expect(h.store.getTask(task.id)?.mode).toBe('project');
      expect(h.backend.startedTurns.at(-1)?.prompt).toContain(original);
      expect(h.backend.startedTurns.at(-1)?.prompt).toContain('绑定这个项目');
    }finally{await h.stop(task.id);}
  });
  it('does not commit a verified import after the requester supersedes it during inspection',async()=>{
    const text='绑定这个 clone';
    const {harness:h,scope,task}=await createSemanticBindingHarness(text);
    let finish!:(value:{provider:'github';providerRepoId:string;namespace:string;name:string;cloneUrl:string;defaultBranch:string;localPath:string})=>void;
    const inspecting=vi.fn(()=>new Promise<Parameters<typeof finish>[0]>(resolve=>{finish=resolve;}));
    h.service.setProjectImportInspector(inspecting);
    try{
      h.backend.emit(task.id,{type:'backend.server_request',taskId:task.id,generation:1,requestId:'superseded-import',method:'item/tool/call',
        params:{threadId:task.codexThreadId,tool:'project_import',arguments:{repositoryUrl:'https://github.com/team/repo',localPath:'/workspace/repo',requestText:text}}});
      await waitFor(()=>inspecting.mock.calls.length===1);
      await h.service.send({...scope,text:'不要绑定，先停止',messageId:'om_superseding'});
      finish({provider:'github',providerRepoId:'R_repo',namespace:'team',name:'repo',cloneUrl:'https://github.com/team/repo',defaultBranch:'main',localPath:'/workspace/repo'});
      await waitFor(()=>h.backend.responses.some(item=>item.requestId==='superseded-import'));
      expect(h.backend.responses.find(item=>item.requestId==='superseded-import')).toMatchObject({result:{success:false}});
      expect(h.store.listDynamicProjectsFor(scope.userId,scope.chatId,scope.topicId)).toEqual([]);
      expect(h.store.getTask(task.id)?.pendingProjectBind).toBeUndefined();
    }finally{await h.stop(task.id);}
  });
  it('wakes an imported binding after a different logical project releases the same physical directory',async()=>{
    const text='绑定这个 clone 继续分析';
    const {harness:h,scope,task}=await createSemanticBindingHarness(text);
    h.service.setDynamicProjectCatalog(new DynamicProjectCatalog(h.store,h.config));
    h.provisioner.prepareProjectBinding=vi.fn(async()=>({cwd:'/workspace/repo',branchName:'keep-existing'}));
    h.service.setProjectImportInspector(async()=>({provider:'github',providerRepoId:'R_repo',namespace:'team',name:'repo',cloneUrl:'https://github.com/team/repo',defaultBranch:'main',localPath:'/workspace/repo'}));
    const writerScope={...scope,topicId:'writer-topic'};
    const writer=await h.service.createTask({...writerScope,mode:'project',projectId:'repo'});
    await h.service.send({...writerScope,text:'working',messageId:'om_writer'});
    try{
      h.backend.emit(task.id,{type:'backend.server_request',taskId:task.id,generation:1,requestId:'waiting-import',method:'item/tool/call',
        params:{threadId:task.codexThreadId,tool:'project_import',arguments:{repositoryUrl:'https://github.com/team/repo',localPath:'/workspace/repo',requestText:text}}});
      await waitFor(()=>h.backend.responses.some(item=>item.requestId==='waiting-import'));
      h.backend.emit(task.id,{type:'turn.completed',taskId:task.id,threadId:task.codexThreadId!,turnId:'codex_turn_1',status:'completed',turn:{items:[]}});
      await waitFor(()=>!h.store.getTask(task.id)?.activeTurnId);
      expect(h.store.getTask(task.id)?.mode).toBe('chat');
      expect(h.provisioner.prepareProjectBinding).not.toHaveBeenCalled();
      const writerTask=h.store.getTask(writer.taskId)!,writerTurn=h.store.getTurn(writerTask.activeTurnId!)!;
      h.backend.emit(writer.taskId,{type:'turn.completed',taskId:writer.taskId,threadId:writerTask.codexThreadId!,turnId:writerTurn.codexTurnId!,status:'completed',turn:{items:[]}});
      await waitFor(()=>h.store.getTask(task.id)?.mode==='project');
      expect(h.store.getTask(task.id)?.projectWorkspacePath).toBe('/workspace/repo');
    }finally{await h.stop(task.id);}
  });
  it('serializes simultaneous imports of one physical clone through continuation acceptance',async()=>{
    const text='绑定已有仓库，继续设计分析';
    const {harness:h,scope,task:first}=await createSemanticBindingHarness(text);
    h.service.setDynamicProjectCatalog(new DynamicProjectCatalog(h.store,h.config));
    const secondScope={...scope,topicId:'simultaneous-import'};
    const secondId=(await h.service.createTask({...secondScope,mode:'chat'})).taskId;
    await h.service.send({...secondScope,text,messageId:'om_second_import'});
    const second=h.store.getTask(secondId)!;
    h.service.setProjectImportInspector(async()=>({provider:'github',providerRepoId:'R_shared',namespace:'team',name:'shared',cloneUrl:'https://github.com/team/shared',defaultBranch:'main',localPath:'/workspace/shared'}));
    let releasePreparation!:()=>void,releaseSubmission!:()=>void;
    const preparing=new Promise<void>(resolve=>{releasePreparation=resolve;});
    h.backend.startTurnGate=new Promise<void>(resolve=>{releaseSubmission=resolve;});
    h.backend.emitTurnStarted=false;
    h.backend.startTurnResultId='codex_import_continuation';
    h.provisioner.prepareProjectBinding=vi.fn(async(current:TaskRecord)=>{
      if(current.id===first.id)await preparing;
      return {cwd:'/workspace/shared',branchName:'keep-local-branch'};
    });
    const locks=vi.spyOn(h.store,'withTaskLock');
    const workspaceKey=`project-bind-workspace:${scope.userId}:/workspace/shared`;
    try{
      for(const current of [first,second]){
        h.backend.emit(current.id,{type:'backend.server_request',taskId:current.id,generation:current.connectionGeneration!,requestId:`import-${current.id}`,method:'item/tool/call',
          params:{threadId:current.codexThreadId,tool:'project_import',arguments:{repositoryUrl:'https://github.com/team/shared',localPath:'/workspace/shared',requestText:text}}});
      }
      await waitFor(()=>h.backend.responses.filter(item=>String(item.requestId).startsWith('import-')).length===2);
      const finish=(current:TaskRecord,turnId:string)=>h.backend.emit(current.id,{type:'turn.completed',taskId:current.id,threadId:current.codexThreadId!,turnId,status:'completed',turn:{items:[]}});
      finish(first,'codex_turn_1');
      await waitFor(()=>h.provisioner.prepareProjectBinding!.mock.calls.length===1);
      finish(second,'codex_turn_1');
      await waitFor(()=>locks.mock.calls.filter(([key])=>key===workspaceKey).length>=2);
      expect(h.provisioner.prepareProjectBinding).toHaveBeenCalledTimes(1);
      releasePreparation();
      await waitFor(()=>h.backend.startedTurns.filter(turn=>turn.taskId===first.id).length===2);
      expect(h.store.getTask(second.id)?.mode).toBe('chat');
      expect(h.provisioner.prepareProjectBinding).toHaveBeenCalledTimes(1);
      releaseSubmission();
      await waitFor(()=>h.store.listTurnsByTask(first.id).some(turn=>turn.internalOperationId&&turn.submissionPhase==='accepted'));
      expect(h.store.getTask(second.id)?.mode).toBe('chat');
      expect(h.provisioner.prepareProjectBinding).toHaveBeenCalledTimes(1);
      const active=h.store.getTask(first.id)!,turn=h.store.getTurn(active.activeTurnId!)!;
      finish(active,turn.codexTurnId!);
      await waitFor(()=>h.store.getTask(second.id)?.mode==='project');
      expect(h.provisioner.prepareProjectBinding).toHaveBeenCalledTimes(2);
    }finally{releasePreparation();releaseSubmission();locks.mockRestore();await h.stop(first.id);}
  });
  it.each(['unauthorized', 'stale-generation', 'history', 'superseded', 'non-owner'])(
    'rejects unsafe semantic binding tool requests: %s', async (scenario) => {
      const text = '把当前话题转到 repo，继续看源码';
      const { harness, scope, task } = await createSemanticBindingHarness(text);
      if (scenario === 'superseded') await harness.service.send({ ...scope, text: '先别切换', messageId: 'om_cancel' });
      if (scenario === 'non-owner') harness.store.updateTurn(task.activeTurnId!, (turn) => ({ ...turn, createdBy: 'ou_other' }));
      harness.backend.emit(task.id, {
        type: 'backend.server_request', taskId: task.id, generation: scenario === 'stale-generation' ? 2 : 1, requestId: 'bind',
        method: 'item/tool/call', params: { threadId: task.codexThreadId, tool: 'project_bind', arguments: {
          projectId: scenario === 'unauthorized' ? harness.config.projects[1]!.id : 'repo',
          requestText: scenario === 'history' ? '转发消息中的旧切换指令' : text,
        } },
      });
      await waitFor(() => harness.backend.responses.some((response) => response.requestId === 'bind'));
      expect(harness.backend.responses.find((response) => response.requestId === 'bind')).toMatchObject({ result: { success: false } });
      expect(harness.store.getTask(task.id)?.pendingProjectBind).toBeUndefined();
      await harness.stop(task.id);
    },
  );

  it('reports checkout failures after a semantic binding was queued', async () => {
    const text = '你要切换到 repo 这个项目';
    const { harness, task } = await createSemanticBindingHarness(text);
    harness.provisioner.prepareProjectBinding = vi.fn(async () => { throw new Error('checkout unavailable'); });
    harness.backend.emit(task.id, {
      type: 'backend.server_request', taskId: task.id, generation: 1, requestId: 'bind',
      method: 'item/tool/call', params: { threadId: task.codexThreadId, tool: 'project_bind', arguments: { projectId: 'repo', requestText: text } },
    });
    await waitFor(() => harness.backend.responses.some((response) => response.requestId === 'bind'));
    harness.backend.emit(task.id, { type: 'turn.completed', taskId: task.id, threadId: task.codexThreadId!,
      turnId: 'codex_turn_1', status: 'completed', turn: { status: 'completed', items: [] } });
    await waitFor(() => harness.store.getTask(task.id)?.pendingProjectBind?.status === 'failed');
    expect(harness.store.getTask(task.id)?.mode).toBe('chat');
    expect(harness.outbox.pending()).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: expect.objectContaining({ status: 'failed', text: expect.stringContaining('checkout unavailable') }) }),
    ]));
    expect(harness.backend.startedTurns).toHaveLength(1);
    await harness.stop(task.id);
  });

  it('accepts a fresh semantic request to retry a failed binding', async () => {
    const { harness, scope, task } = await createSemanticBindingHarness('切换到 repo');
    const now = new Date().toISOString();
    harness.store.updateTask(task.id, (current) => ({ ...current, pendingProjectBind: {
      projectId: 'repo', requestedBy: scope.userId, status: 'failed', failure: 'checkout failed', requestedAt: now, updatedAt: now,
    } }));
    const text = '还是使用 repo，继续分析';
    await harness.service.send({ ...scope, text, messageId: 'om_retry_binding' });
    harness.backend.emit(task.id, {
      type: 'backend.server_request', taskId: task.id, generation: 1, requestId: 'retry_bind',
      method: 'item/tool/call', params: { threadId: task.codexThreadId, tool: 'project_bind', arguments: { projectId: 'repo', requestText: text } },
    });
    await waitFor(() => harness.backend.responses.some((response) => response.requestId === 'retry_bind'));
    expect(harness.backend.responses.find((response) => response.requestId === 'retry_bind')).toMatchObject({ result: { success: true } });
    expect(harness.store.getTask(task.id)?.pendingProjectBind).toMatchObject({ status: 'requested', resumeAfterBind: { turnId: task.activeTurnId } });
    await harness.stop(task.id);
  });

  it('recovers a durable continuation after binding completed before a Manager restart', async () => {
    const { harness, scope, task } = await createSemanticBindingHarness('讨论源码');
    harness.backend.emit(task.id, { type: 'turn.completed', taskId: task.id, threadId: task.codexThreadId!,
      turnId: 'codex_turn_1', status: 'completed', turn: { status: 'completed', items: [] } });
    await waitFor(() => !harness.store.getTask(task.id)?.activeTurnId);
    harness.provisioner.prepareProjectBinding = vi.fn(async () => ({ cwd: '/workspace/projects/repo', branchName: 'branch' }));
    await harness.service.bindExistingProject(scope, 'repo');
    const continuation = { requestedBy: scope.userId, turnId: task.activeTurnId!, text: '继续分析原来的问题' };
    harness.store.updateTask(task.id, (current) => ({ ...current, projectBindContinuation: continuation }));
    harness.backend.emitTurnStarted = false;
    harness.backend.startTurnResultId = 'continued_turn';
    await harness.backend.stopTask(task.id);
    await harness.service.waitForEvents(task.id);
    await harness.service.recoverStartup();
    expect(harness.backend.startedTurns).toHaveLength(2);
    expect(harness.backend.startedTurns.at(-1)?.prompt).toContain(continuation.text);
    expect(harness.store.getTask(task.id)?.projectBindContinuation).toBeUndefined();
    // Replaying a persisted continuation cannot submit its user request twice.
    harness.store.updateTask(task.id, (current) => ({ ...current, projectBindContinuation: continuation }));
    await harness.backend.stopTask(task.id);
    await harness.service.waitForEvents(task.id);
    await harness.service.recoverStartup();
    expect(harness.backend.startedTurns).toHaveLength(2);
    await harness.stop(task.id);
  });

  it('upgrades old idle chat threads to install semantic binding tools and carries bounded history', async () => {
    const { harness, scope, task } = await createSemanticBindingHarness('先讨论 repo 的问题');
    const old = harness.store.getActiveTaskContext(task.id)!;
    harness.backend.emit(task.id, { type: 'turn.completed', taskId: task.id, threadId: task.codexThreadId!,
      turnId: 'codex_turn_1', status: 'completed', turn: { status: 'completed', items: [] } });
    await waitFor(() => !harness.store.getTask(task.id)?.activeTurnId);
    harness.store.saveTaskContext({ ...old, projectBindingToolRevision: undefined });
    await harness.service.send({ ...scope, text: '你要切换到 repo 这个项目', messageId: 'om_upgrade_binding' });
    expect(harness.store.getTask(task.id)?.codexThreadId).not.toBe(old.codexThreadId);
    expect(harness.store.getActiveTaskContext(task.id)?.projectBindingToolRevision).toBe(4);
    expect(harness.store.getTaskContext(old.id)?.state).toBe('archived');
    expect(harness.backend.startedTurns.at(-1)?.prompt).toContain('先讨论 repo 的问题');
    await harness.stop(task.id);
  });

  it('binds an idle chat to an authorized project in the same topic and opens a fresh project thread', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: ['oc_group'], knowledgeApprovers: [] };
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.userSandboxes = {
      enabled: true, enabledOwners: [], legacyFallbackEnabled: false,
      maxAppServersPerUser: 8, maxActiveTurnsPerUser: 4,
      processIdleTimeoutMinutes: 120, containerIdleTimeoutMinutes: 1_440,
      containerWrapperRetentionHours: 24,
    };
    const scope = { chatId: 'oc_group', chatType: 'group' as const, topicId: 'topic_bind', userId: 'ou_owner' };
    const created = await harness.service.createTask({ ...scope, mode: 'chat' });
    const oldThreadId = harness.store.getTask(created.taskId)!.codexThreadId!;
    const startTaskHook = vi.fn();
    harness.backend.startTaskHook = startTaskHook;
    harness.provisioner.prepareProjectBinding = vi.fn(async () => ({
      cwd: '/workspace/projects/repo', branchName: `codex/ou_owner/${created.taskId}`, runtimeId: 'sandbox_1',
    }));

    expect(await harness.service.bindExistingProject(scope, 'repo')).toEqual({ taskId: created.taskId, projectId: 'repo' });

    const task = harness.store.getTask(created.taskId)!;
    expect(task).toMatchObject({ mode: 'project', projectId: 'repo', sandboxWorkspaceLayout: 'project' });
    expect(task.codexThreadId).not.toBe(oldThreadId);
    expect(startTaskHook).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/workspace/projects/repo' }));
    expect(harness.store.getTaskScopeByKey(`personal-topic:ou_owner:oc_group:topic_bind`)?.taskId).toBe(task.id);
    expect(harness.store.listTaskContexts(task.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ codexThreadId: oldThreadId, state: 'archived' }),
      expect.objectContaining({ codexThreadId: task.codexThreadId, state: 'active' }),
    ]));
    expect(harness.backend.archivedThreads).toContain(oldThreadId);
    await harness.stop(task.id);
  });

  it('records an active-turn project bind without switching the chat cwd or thread', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: ['oc_group'], knowledgeApprovers: [] };
    harness.config.userSandboxes = {
      enabled: true, enabledOwners: [], legacyFallbackEnabled: false,
      maxAppServersPerUser: 8, maxActiveTurnsPerUser: 4,
      processIdleTimeoutMinutes: 120, containerIdleTimeoutMinutes: 1_440,
      containerWrapperRetentionHours: 24,
    };
    const scope = { chatId: 'oc_group', chatType: 'group' as const, topicId: 'topic_pending', userId: 'ou_owner' };
    const created = await harness.service.createTask({ ...scope, mode: 'chat' });
    await harness.service.send({ ...scope, text: '先帮我总结现状', messageId: 'om_pending' });
    const oldThreadId = harness.store.getTask(created.taskId)!.codexThreadId;
    harness.provisioner.prepareProjectBinding = vi.fn(async () => ({ cwd: '/workspace/projects/repo', branchName: 'branch' }));

    await harness.service.bindExistingProject(scope, 'repo');

    expect(harness.store.getTask(created.taskId)).toMatchObject({
      mode: 'chat', pendingProjectBind: { projectId: 'repo', requestedBy: 'ou_owner', status: 'requested' },
      codexThreadId: oldThreadId,
    });
    expect(harness.provisioner.prepareProjectBinding).not.toHaveBeenCalled();
    harness.backend.emit(created.taskId, {
      type: 'turn.completed', taskId: created.taskId, threadId: oldThreadId!, turnId: 'codex_turn_1',
      status: 'completed', turn: { id: 'codex_turn_1', status: 'completed', items: [] },
    });
    await waitFor(() => harness.store.getTask(created.taskId)?.mode === 'project');
    expect(harness.store.getTask(created.taskId)?.projectId).toBe('repo');
    await harness.stop(created.taskId);
  });

  it('keeps a failed bind recoverable and retries the same target without changing the topic task', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: ['oc_group'], knowledgeApprovers: [] };
    harness.config.userSandboxes = {
      enabled: true, enabledOwners: [], legacyFallbackEnabled: false,
      maxAppServersPerUser: 8, maxActiveTurnsPerUser: 4,
      processIdleTimeoutMinutes: 120, containerIdleTimeoutMinutes: 1_440,
      containerWrapperRetentionHours: 24,
    };
    const scope = { chatId: 'oc_group', chatType: 'group' as const, topicId: 'topic_retry', userId: 'ou_owner' };
    const created = await harness.service.createTask({ ...scope, mode: 'chat' });
    harness.provisioner.prepareProjectBinding = vi.fn()
      .mockRejectedValueOnce(new Error('checkout auth required'))
      .mockResolvedValue({ cwd: '/workspace/projects/repo', branchName: 'branch' });
    await expect(harness.service.bindExistingProject(scope, 'repo')).rejects.toThrow('checkout auth required');
    expect(harness.store.getTask(created.taskId)).toMatchObject({
      mode: 'chat', pendingProjectBind: { status: 'failed', projectId: 'repo' },
    });
    await expect(harness.service.bindExistingProject(scope, 'repo')).resolves.toEqual({ taskId: created.taskId, projectId: 'repo' });
    expect(harness.store.getTask(created.taskId)).toMatchObject({ mode: 'project', projectId: 'repo' });
    await harness.stop(created.taskId);
  });

  it('keeps a failed project-thread startup pending and retryable', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: ['oc_group'], knowledgeApprovers: [] };
    harness.config.userSandboxes = {
      enabled: true, enabledOwners: [], legacyFallbackEnabled: false,
      maxAppServersPerUser: 8, maxActiveTurnsPerUser: 4,
      processIdleTimeoutMinutes: 120, containerIdleTimeoutMinutes: 1_440,
      containerWrapperRetentionHours: 24,
    };
    const scope = { chatId: 'oc_group', chatType: 'group' as const, topicId: 'topic_thread_fail', userId: 'ou_owner' };
    const created = await harness.service.createTask({ ...scope, mode: 'chat' });
    harness.provisioner.prepareProjectBinding = vi.fn(async () => ({ cwd: '/workspace/projects/repo', branchName: 'branch' }));
    harness.backend.startTaskError = new Error('new thread rejected');

    await expect(harness.service.bindExistingProject(scope, 'repo')).rejects.toThrow('new thread rejected');
    expect(harness.store.getTask(created.taskId)).toMatchObject({
      mode: 'chat', pendingProjectBind: { projectId: 'repo', status: 'failed' },
    });
    harness.backend.startTaskError = undefined;
    await expect(harness.service.bindExistingProject(scope, 'repo')).resolves.toEqual({ taskId: created.taskId, projectId: 'repo' });
    expect(harness.store.getTask(created.taskId)).toMatchObject({ mode: 'project', projectId: 'repo' });
    await harness.stop(created.taskId);
  });

  it('rejects a non-owner or unauthorized project bind', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: ['oc_group'], knowledgeApprovers: [] };
    harness.config.userSandboxes = {
      enabled: true, enabledOwners: [], legacyFallbackEnabled: false,
      maxAppServersPerUser: 8, maxActiveTurnsPerUser: 4,
      processIdleTimeoutMinutes: 120, containerIdleTimeoutMinutes: 1_440,
      containerWrapperRetentionHours: 24,
    };
    const scope = { chatId: 'oc_group', chatType: 'group' as const, topicId: 'topic_denied', userId: 'ou_owner' };
    const created = await harness.service.createTask({ ...scope, mode: 'chat' });
    await expect(harness.service.bindExistingProject({ ...scope, userId: 'ou_other' }, 'repo')).rejects.toThrow();
    await expect(harness.service.bindExistingProject(scope, 'repo2')).rejects.toThrow('not authorized');
    expect(harness.store.getTask(created.taskId)?.pendingProjectBind).toBeUndefined();
    await harness.stop(created.taskId);
  });

  it('resumes a warm project-free chat without inventing a project', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.userSandboxes = {
      enabled: true, enabledOwners: [], legacyFallbackEnabled: false,
      maxAppServersPerUser: 8, maxActiveTurnsPerUser: 4,
      processIdleTimeoutMinutes: 120, containerIdleTimeoutMinutes: 1_440,
      containerWrapperRetentionHours: 24,
    };
    const scope = { chatId: 'oc_group', chatType: 'group' as const, topicId: 'topic_resume', userId: 'ou_owner' };
    const created = await harness.service.createTask({ ...scope, mode: 'chat' });
    await harness.service.stop(scope);
    await harness.service.resume(scope);
    expect(harness.store.getTask(created.taskId)).toMatchObject({ mode: 'chat', runtimeState: 'hot' });
    expect(harness.store.getTask(created.taskId)?.projectId).toBeUndefined();
    await harness.stop(created.taskId);
  });

  it('binds an existing project named in a later chat message and carries bounded history into the new turn', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.taskPlatformRollout.projectFreeChat = true;
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: ['oc_group'], knowledgeApprovers: [] };
    harness.config.userSandboxes = {
      enabled: true, enabledOwners: [], legacyFallbackEnabled: false,
      maxAppServersPerUser: 8, maxActiveTurnsPerUser: 4,
      processIdleTimeoutMinutes: 120, containerIdleTimeoutMinutes: 1_440,
      containerWrapperRetentionHours: 24,
    };
    const scope = { chatId: 'oc_group', chatType: 'group' as const, threadId: 'topic_later', wasMentioned: true };
    await harness.controller.handleMessage(message('讨论一下需求', { ...scope, messageId: 'om_discuss' }));
    const task = harness.store.listTasks()[0]!;
    const topicScope = harness.store.getTaskScopeByKey('personal-topic:ou_owner:oc_group:topic_later')!;
    expect(await harness.service.status({
      chatId: 'oc_group', chatType: 'group', topicId: 'topic_later', userId: 'ou_owner',
    })).toContain('纯对话');
    const oldTurn = harness.store.listTurnsByTask(task.id)[0]!;
    harness.backend.emit(task.id, { type: 'turn.completed', taskId: task.id, threadId: task.codexThreadId!,
      turnId: 'codex_turn_1', status: 'completed', turn: { id: 'codex_turn_1', status: 'completed', items: [] } });
    await waitFor(() => harness.store.getTurn(oldTurn.id)?.state === 'completed');
    harness.provisioner.prepareProjectBinding = vi.fn(async () => ({ cwd: '/workspace/projects/repo', branchName: 'branch' }));

    harness.backend.emitTurnStarted = false;
    harness.backend.startTurnResultId = 'codex_bind_2';
    await harness.controller.handleMessage(message('接下来在 repo 项目改代码', { ...scope, messageId: 'om_bind' }));

    harness.backend.emit(task.id, {
      type: 'backend.server_request', taskId: task.id, generation: 1, requestId: 'semantic_bind',
      method: 'item/tool/call', params: { threadId: task.codexThreadId, tool: 'project_bind',
        arguments: { projectId: 'repo', requestText: '接下来在 repo 项目改代码' } },
    });
    await waitFor(() => harness.backend.responses.some((response) => response.requestId === 'semantic_bind'));
    expect(harness.store.getTask(task.id)).toMatchObject({ mode: 'chat', pendingProjectBind: { projectId: 'repo' } });
    harness.backend.emit(task.id, { type: 'turn.completed', taskId: task.id, threadId: task.codexThreadId!,
      turnId: 'codex_bind_2', status: 'completed', turn: { id: 'codex_bind_2', status: 'completed', items: [] } });
    await waitFor(() => harness.store.getTask(task.id)?.mode === 'project' && harness.backend.startedTurns.length === 3);

    expect(harness.store.listTasks()).toHaveLength(1);
    expect(harness.store.getTask(task.id)).toMatchObject({ mode: 'project', projectId: 'repo' });
    expect(harness.store.getTaskScopeByKey(topicScope.scopeKey)).toMatchObject({
      taskId: task.id, topicId: 'topic_later',
    });
    expect(await harness.service.status({
      chatId: 'oc_group', chatType: 'group', topicId: 'topic_later', userId: 'ou_owner',
    })).toContain('repo');
    expect(harness.backend.startedTurns.at(-1)?.prompt).toContain('讨论一下需求');
    expect(harness.backend.startedTurns.at(-1)?.prompt).toContain('接下来在 repo 项目改代码');
    expect(harness.backend.startedTurns.at(-1)?.prompt).toContain('Do not replay old tool calls');
    await harness.stop(task.id);
  });

  it.each(['requested', 'checkout_ready'] as const)(
    'recovers an idle %s bind after Manager restart without changing the topic identity', async (status) => {
    const harness = await createHarness(undefined, true, true);
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: ['oc_group'], knowledgeApprovers: [] };
    harness.config.userSandboxes = {
      enabled: true, enabledOwners: [], legacyFallbackEnabled: false,
      maxAppServersPerUser: 8, maxActiveTurnsPerUser: 4,
      processIdleTimeoutMinutes: 120, containerIdleTimeoutMinutes: 1_440,
      containerWrapperRetentionHours: 24,
    };
    const scope = { chatId: 'oc_group', chatType: 'group' as const, topicId: 'topic_recover', userId: 'ou_owner' };
    const created = await harness.service.createTask({ ...scope, mode: 'chat' });
    const now = new Date().toISOString();
    harness.store.updateTask(created.taskId, (task) => ({ ...task,
      pendingProjectBind: { projectId: 'repo', requestedBy: 'ou_owner', status, requestedAt: now, updatedAt: now },
    }));
    harness.provisioner.prepareProjectBinding = vi.fn(async () => ({ cwd: '/workspace/projects/repo', branchName: 'branch' }));
    await harness.backend.stopTask(created.taskId);
    await harness.service.waitForEvents(created.taskId);

    await harness.service.recoverStartup();

    expect(harness.store.getTask(created.taskId)).toMatchObject({ mode: 'project', projectId: 'repo' });
    expect(harness.store.getTaskScopeByKey('personal-topic:ou_owner:oc_group:topic_recover')?.taskId).toBe(created.taskId);
    await harness.stop(created.taskId);
  });

  it('adopts an already opened project thread after a restart without replaying the chat turn', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: ['oc_group'], knowledgeApprovers: [] };
    harness.config.userSandboxes = {
      enabled: true, enabledOwners: [], legacyFallbackEnabled: false,
      maxAppServersPerUser: 8, maxActiveTurnsPerUser: 4,
      processIdleTimeoutMinutes: 120, containerIdleTimeoutMinutes: 1_440,
      containerWrapperRetentionHours: 24,
    };
    const scope = { chatId: 'oc_group', chatType: 'group' as const, topicId: 'topic_opened', userId: 'ou_owner' };
    const created = await harness.service.createTask({ ...scope, mode: 'chat' });
    const oldThreadId = harness.store.getTask(created.taskId)!.codexThreadId!;
    const now = new Date().toISOString();
    harness.store.updateTask(created.taskId, (task) => ({ ...task,
      pendingProjectBind: {
        projectId: 'repo', requestedBy: 'ou_owner', status: 'thread_opened',
        openedThreadId: 'thread_2', requestedAt: now, updatedAt: now,
      },
    }));
    harness.provisioner.prepareProjectBinding = vi.fn(async () => ({ cwd: '/workspace/projects/repo', branchName: 'branch' }));
    await harness.backend.stopTask(created.taskId);
    await harness.service.waitForEvents(created.taskId);

    await harness.service.recoverStartup();

    expect(harness.backend.resumeInputs).toContainEqual(expect.objectContaining({
      threadId: 'thread_2', cwd: '/workspace/projects/repo',
    }));
    expect(harness.store.listTaskContexts(created.taskId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ codexThreadId: oldThreadId, state: 'archived' }),
      expect.objectContaining({ state: 'active' }),
    ]));
    expect(harness.store.getTask(created.taskId)).toMatchObject({ mode: 'project', projectId: 'repo' });
    expect(harness.backend.startedTurns).toHaveLength(0);
    await harness.stop(created.taskId);
  });

  it('locks every non-allowlisted task to GPT-6.1 Sol medium Standard', async () => {
    const harness = await createHarness(undefined, true);
    harness.config.allowedUsers = ['ou_allowlisted'];
    harness.config.taskPlatformRollout.enabled = true;
    harness.config.taskPlatformRollout.enabledOwners = [];
    harness.config.taskPlatformRollout.appServerDefault = true;
    harness.config.projects[0]!.access = {
      allowedUsers: [], allowedChats: ['oc_public'], knowledgeApprovers: [],
    };
    harness.config.codex.executionProfiles.worker = {
      model: 'gpt-5.6-terra', reasoningEffort: 'high', serviceTier: 'fast',
    };
    const actor = {
      chatId: 'oc_public', chatType: 'group' as const, userId: 'ou_unlisted', topicId: 'omt_public',
    };

    const created = await harness.service.createTask({ ...actor, projectId: 'repo' });

    expect(harness.store.getTask(created.taskId)).toMatchObject({
      executionProfile: {
        configured: { model: 'gpt-6.1-sol', reasoningEffort: 'medium', serviceTier: 'default', source: 'workflow-override' },
      },
    });
    await expect(harness.service.model({ ...actor, model: 'gpt-5.6-sol', reasoningEffort: 'high', serviceTier: 'fast' }))
      .rejects.toThrow('Execution profile is fixed for non-allowlisted users.');
    await harness.stop(created.taskId);
  });
  it('refreshes persisted workspace policy before every projectless task turn', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.runtime = { backend: 'app-server', nativeGitExecution: true, managerGitToolFallback: true };
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.upgrade.adminUsers = ['ou_owner'];
    await harness.controller.handleMessage(message('/new repo'));
    const created = harness.store.listTasks()[0]!;
    harness.store.updateTask(created.id, (task) => ({
      ...task,
      workspacePlan: {
        repositories: [{ projectId: 'repo', baseRef: 'develop', role: 'primary', reason: 'test' }],
        stages: [], explicit: true,
      },
    }));
    await harness.controller.handleMessage(message('重试 rebase'));

    expect(harness.provisioner.refreshWorkspaceFiles).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'repo' }),
      expect.objectContaining({
        agents: expect.stringContaining('Use native git fetch'),
      }),
    );
    expect(harness.backend.startedTurns.at(-1)?.prompt).toContain('authority="task-workspace-git"');
    expect(harness.backend.startedTurns.at(-1)?.prompt).toContain('Manager generations are historical metadata');
    await harness.stop(harness.store.listTasks()[0]!.id);
  });

  it('refreshes authentication and reconnects a durable background task', async () => {
    const harness = await createHarness();
    await harness.controller.handleMessage(message('/new repo'));
    const task = harness.store.listTasks()[0]!;

    await expect(harness.service.refreshTaskAuthentication({
      chatId: 'oc_group', chatType: 'group', userId: 'ou_owner', topicId: 'topic_1', messageId: 'om_refresh',
    }, task.id)).resolves.toMatchObject({ id: task.id, runtimeState: 'hot', codexThreadId: 'thread_2' });

    expect(harness.provisioner.refreshCodexAuth).toHaveBeenCalledOnce();
    expect(harness.provisioner.resume).toHaveBeenCalledOnce();
    expect(harness.backend.resumeInputs).toHaveLength(1);
    await harness.stop(task.id);
  });

  it.each([
    { code: 'refresh_token_reused', message: 'Your refresh token has already been used to generate a new access token.' },
    { code: 'token_expired', message: 'Provided authentication token is expired.' },
    { message: 'workspace routing discovery unauthorized (401)' },
    { message: 'Your access token could not be refreshed. Please log out and sign in again.' },
  ])('refreshes stale Codex credentials and retries an auth-failed turn once: %j', async (error) => {
    const harness = await createHarness();
    await harness.controller.handleMessage(message('/new repo'));
    const task = harness.store.listTasks()[0]!;
    await harness.controller.handleMessage(message('review modelhub observability'));
    harness.backend.emitTurnStarted = false;
    harness.backend.startTurnResultId = 'codex_retry_2';
    harness.backend.emit(task.id, {
      type: 'turn.completed', taskId: task.id, threadId: task.codexThreadId!, turnId: 'codex_turn_1', status: 'failed',
      turn: { status: 'failed', error },
    });

    await waitFor(() => harness.backend.startedTurns.length === 2);
    expect(harness.provisioner.refreshCodexAuth).toHaveBeenCalledOnce();
    expect(harness.backend.resumeInputs).toHaveLength(1);
    const turns = harness.store.listTurnsByTask(task.id);
    expect(turns[0]).toMatchObject({ state: 'interrupted', failure: 'codex_auth_refresh_required' });
    expect(turns[1]).toMatchObject({ retryCount: 1, retryOfTurnId: turns[0]!.id });

    harness.backend.emit(task.id, {
      type: 'turn.completed', taskId: task.id, threadId: task.codexThreadId!, turnId: 'codex_retry_2', status: 'failed',
      turn: { status: 'failed', error },
    });
    await waitFor(() => harness.store.listTurnsByTask(task.id)[1]?.state === 'failed');
    expect(harness.provisioner.refreshCodexAuth).toHaveBeenCalledOnce();
    await harness.stop(task.id);
  });

  it('reports an actionable sandbox upgrade instead of retrying an unsupported credential refresh', async () => {
    const harness = await createHarness();
    await harness.controller.handleMessage(message('/new repo'));
    const task = harness.store.listTasks()[0]!;
    await harness.controller.handleMessage(message('query the TEST error'));
    harness.provisioner.refreshCodexAuth.mockRejectedValueOnce(new SandboxRuntimeUpgradeRequiredError());
    harness.backend.emit(task.id, {
      type: 'turn.completed', taskId: task.id, threadId: task.codexThreadId!, turnId: 'codex_turn_1', status: 'failed',
      turn: { status: 'failed', error: { code: 'token_expired' } },
    });

    await waitFor(() => harness.store.getTask(task.id)?.runtimeState === 'failed');
    const turns = harness.store.listTurnsByTask(task.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ state: 'interrupted', failure: 'sandbox_runtime_upgrade_required' });
    expect(harness.provisioner.refreshCodexAuth).toHaveBeenCalledOnce();
    expect(harness.backend.resumeInputs).toHaveLength(0);
    expect(harness.backend.startedTurns).toHaveLength(1);
    expect(harness.store.getTask(task.id)?.codexThreadId).toBe(task.codexThreadId);
    const notification = harness.outbox.pending().find((event) => event.dedupeKey === `${turns[0]!.id}:backend-reconnect-failed`);
    expect(notification).toMatchObject({
      eventType: 'card', payload: { text: expect.stringContaining('/runtime upgrade') },
    });
    expect(JSON.stringify(notification)).not.toContain('请稍后继续任务');
    await harness.stop(task.id);
  });

  it('pauses a running turn and emits a scoped Lark authorization card on token_missing', async () => {
    const harness = await createHarness();
    const provider: ToolAuthProvider = {
      id: 'lark', requiresAuth: () => false, isAuthenticated: vi.fn(async () => false),
      begin: vi.fn(async () => ({
        sessionId: 'opaque_session', authorizationUrl: 'https://open.feishu.cn/oauth/v1/device/verify',
        expiresAt: '2099-01-01T00:00:00Z',
      })),
      complete: vi.fn(async (): Promise<'pending'> => 'pending'), project: vi.fn(async () => false),
    };
    harness.service.setAuthBroker(new AuthBroker([provider], harness.store, vi.fn()));
    await harness.controller.handleMessage(message('/new repo'));
    await harness.controller.handleMessage(message('读取示例记录'));
    const task = harness.store.listTasks()[0]!;
    const turn = harness.store.listTurnsByTask(task.id)[0]!;

    harness.backend.emit(task.id, {
      type: 'item.completed', taskId: task.id, threadId: task.codexThreadId!, turnId: 'codex_turn_1',
      item: { id: 'item_auth', type: 'commandExecution', command: ['lark-cli', 'base', 'record', 'list'],
        aggregatedOutput: JSON.stringify({ error: { subtype: 'token_missing', missing_scopes: ['base:record:read'] } }) },
    });

    await waitFor(() => harness.store.getTurn(turn.id)?.state === 'interrupted');
    expect(provider.begin).toHaveBeenCalledWith('ou_owner', { scopes: ['base:record:read'], domains: [] });
    expect(harness.backend.interruptTurn).toHaveBeenCalledWith({ taskId: task.id });
    expect(harness.store.listPendingAuth('ou_owner')[0]).toMatchObject({
      sourceTaskId: task.id, sourceTurnId: turn.id, requestedScopes: ['base:record:read'],
    });
    expect(harness.outbox.pending()).toContainEqual(expect.objectContaining({
      dedupeKey: `${turn.id}:lark-auth-required`, payload: expect.objectContaining({ kind: 'rendered_message' }),
    }));
    await harness.stop(task.id);
  });

  it('pauses a model-started Lark device flow and replaces it with broker-managed authorization', async () => {
    const harness = await createHarness();
    const provider: ToolAuthProvider = {
      id: 'lark', requiresAuth: () => false, isAuthenticated: vi.fn(async () => false),
      begin: vi.fn(async () => ({
        sessionId: 'broker_session', authorizationUrl: 'https://open.feishu.cn/oauth/v1/device/verify',
        expiresAt: '2099-01-01T00:00:00Z',
      })),
      complete: vi.fn(async (): Promise<'pending'> => 'pending'), project: vi.fn(async () => false),
    };
    harness.service.setAuthBroker(new AuthBroker([provider], harness.store, vi.fn()));
    await harness.controller.handleMessage(message('/new repo'));
    await harness.controller.handleMessage(message('重新授权 lark cli'));
    const task = harness.store.listTasks()[0]!;
    const turn = harness.store.listTurnsByTask(task.id)[0]!;

    harness.backend.emit(task.id, {
      type: 'item.completed', taskId: task.id, threadId: task.codexThreadId!, turnId: 'codex_turn_1',
      item: { id: 'item_auth', type: 'commandExecution',
        command: 'lark-cli auth login --domain base --no-wait --json',
        aggregatedOutput: JSON.stringify({ device_code: 'model_session', verification_url: 'https://auth.example' }) },
    });

    await waitFor(() => harness.store.getTurn(turn.id)?.state === 'interrupted');
    expect(provider.begin).toHaveBeenCalledWith('ou_owner', { scopes: [], domains: ['base'] });
    expect(harness.store.listPendingAuth('ou_owner')).toHaveLength(1);
    expect(harness.store.listPendingAuth('ou_owner')[0]).toMatchObject({
      loginSessionId: 'broker_session', sourceTaskId: task.id, sourceTurnId: turn.id,
    });
    await harness.stop(task.id);
  });

  it('leaves Lark device flow and credentials inside a per-user sandbox', async () => {
    const harness = await createHarness(undefined, true);
    harness.config.userSandboxes = {
      enabled: true,
      enabledOwners: [],

      legacyFallbackEnabled: false,
      maxAppServersPerUser: 8,
      maxActiveTurnsPerUser: 4,
      processIdleTimeoutMinutes: 120,
      containerIdleTimeoutMinutes: 1_440,
      containerWrapperRetentionHours: 24,
    };
    const provider: ToolAuthProvider = {
      id: 'lark', requiresAuth: () => false, isAuthenticated: vi.fn(async () => false),
      begin: vi.fn(async () => ({
        sessionId: 'host_broker_session', authorizationUrl: 'https://open.feishu.cn/oauth/v1/device/verify',
        expiresAt: '2099-01-01T00:00:00Z',
      })),
      complete: vi.fn(async (): Promise<'pending'> => 'pending'), project: vi.fn(async () => false),
    };
    harness.service.setAuthBroker(new AuthBroker([provider], harness.store, vi.fn()));
    await harness.controller.handleMessage(message('/new repo'));
    await harness.controller.handleMessage(message('重新授权 lark cli'));
    const task = harness.store.listTasks()[0]!;
    const turn = harness.store.listTurnsByTask(task.id)[0]!;
    expect(task.runtimeMode).toBe('user-sandbox');

    harness.backend.emit(task.id, {
      type: 'item.completed', taskId: task.id, threadId: task.codexThreadId!, turnId: 'codex_turn_1',
      item: { id: 'item_auth', type: 'commandExecution',
        command: 'lark-cli auth login --domain sheets --no-wait --json',
        aggregatedOutput: JSON.stringify({ device_code: 'sandbox_session', verification_url: 'https://auth.example' }) },
    });
    harness.backend.emit(task.id, {
      type: 'turn.completed', taskId: task.id, threadId: task.codexThreadId!, turnId: 'codex_turn_1',
      status: 'completed', turn: { status: 'completed' },
    });

    await waitFor(() => harness.store.getTurn(turn.id)?.state === 'completed');
    expect(provider.begin).not.toHaveBeenCalled();
    expect(harness.backend.interruptTurn).not.toHaveBeenCalled();
    expect(harness.store.listPendingAuth('ou_owner')).toHaveLength(0);
    expect(harness.outbox.pending()).not.toContainEqual(expect.objectContaining({
      dedupeKey: `${turn.id}:lark-auth-required`,
    }));
    await harness.stop(task.id);
  });

  it('resumes an authorized task with a dedicated idempotency key instead of dropping the original message', async () => {
    const harness = await createHarness();
    const provider: ToolAuthProvider = {
      id: 'lark', requiresAuth: () => false, isAuthenticated: vi.fn(async () => false),
      begin: vi.fn(async () => ({
        sessionId: 'broker_session', authorizationUrl: 'https://open.feishu.cn/oauth/v1/device/verify',
        expiresAt: '2099-01-01T00:00:00Z',
      })),
      complete: vi.fn(async (): Promise<'authenticated'> => 'authenticated'), project: vi.fn(async () => false),
    };
    const broker = new AuthBroker(
      [provider], harness.store,
      async (turn, context) => { await harness.service.resumeAfterToolAuth(turn, context); },
      () => new Date('2026-09-07T04:28:00Z'),
      (turn) => harness.service.refreshToolAuth(turn),
    );
    harness.service.setAuthBroker(broker);
    await harness.controller.handleMessage(message('/new repo'));
    const originalMessage = message('将运行成功的证据写入 Base', { messageId: 'om_original' });
    await harness.store.claimInboundMessage(originalMessage);
    await harness.controller.handleMessage(originalMessage);
    const task = harness.store.listTasks()[0]!;
    const originalTurn = harness.store.listTurnsByTask(task.id)[0]!;
    expect(harness.store.getInboundAdmissionByExternalMessageId('om_original')).toMatchObject({
      action: 'start', taskId: task.id, turnId: originalTurn.id,
    });

    harness.backend.emit(task.id, {
      type: 'item.completed', taskId: task.id, threadId: task.codexThreadId!, turnId: 'codex_turn_1',
      item: { id: 'item_auth', type: 'commandExecution',
        command: 'lark-cli auth login --domain base --no-wait --json',
        aggregatedOutput: JSON.stringify({ device_code: 'model_session', verification_url: 'https://auth.example' }) },
    });
    await waitFor(() => harness.store.getTurn(originalTurn.id)?.state === 'interrupted');
    const pending = harness.store.listPendingAuth('ou_owner')[0]!;

    await broker.check({ ...actor(), messageId: 'om_auth_card', pendingId: pending.id });
    await waitFor(() => harness.backend.startedTurns.length === 2
      || harness.store.getPendingAuth(pending.id)?.resumeState === 'resume_failed', 3_000);
    expect(harness.store.getPendingAuth(pending.id)?.lastResumeError).toBeUndefined();
    expect(harness.backend.startedTurns[1]?.prompt).toContain('将运行成功的证据写入 Base');
    expect(harness.backend.startedTurns[1]?.prompt).toContain('<manager_tool_auth_resume authority="manager">');
    expect(harness.backend.startedTurns[1]?.prompt).toContain('Do not start another authorization or login flow.');
    expect(harness.store.listTurnEvents(task.id)).toContainEqual(expect.objectContaining({
      eventKey: `tool-auth-resume:${pending.id}:1`, eventType: 'user.message',
      payload: expect.objectContaining({ text: '将运行成功的证据写入 Base' }),
    }));
    expect(harness.store.listTurnsByTask(task.id).filter((turn) => turn.prompt === '将运行成功的证据写入 Base'))
      .toHaveLength(2);
    expect(harness.store.getInboundAdmissionByExternalMessageId('om_original')).toMatchObject({
      action: 'start', taskId: task.id, turnId: originalTurn.id,
    });
    await waitFor(() => harness.store.getPendingAuth(pending.id) === undefined);
    await harness.stop(task.id);
  });

  it('passes images extracted from forwarded conversation context to the model as multimodal input', async () => {
    const context: ConversationContextProvider = { collect: vi.fn(async () => ({
      scope: 'topic' as const, chatId: 'oc_group', threadId: 'topic_images', truncated: false, fetchedAt: '',
      messages: [{ messageId: 'om_forward', createdAt: '1', messageType: 'merge_forward', text: '<forwarded_messages>pricing screenshot</forwarded_messages>' }],
      images: [{ messageId: 'om_child_image', imageKey: 'img_forwarded', dataUrl: 'data:image/png;base64,BAUG' }],
    })) };
    const harness = await createHarness(undefined, true, true, false, context);
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.conversationContext.enabled = true;
    harness.config.projects.splice(1);
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: ['oc_group'], knowledgeApprovers: [] };

    await harness.controller.handleMessage(message('@bot 分析转发内容和图片', {
      chatId: 'oc_group', chatType: 'group', threadId: 'topic_images', rootId: 'om_root',
      messageId: 'om_trigger_images', wasMentioned: true,
    }));

    expect(harness.backend.startedTurns.at(-1)?.images).toEqual([
      { url: 'data:image/png;base64,BAUG', detail: 'auto' },
    ]);
    await harness.stop(harness.store.listTasks()[0]!.id);
  });

  it('bypasses the incremental cursor when the requester refers to an earlier message by time', async () => {
    const collect = vi.fn(async () => ({
      scope: 'topic' as const, chatId: 'oc_group', threadId: 'topic_history', truncated: false, fetchedAt: '',
      messages: [{ messageId: 'om_forward', createdAt: '2026-08-13T19:38:00+08:00', messageType: 'merge_forward', text: 'pricing context' }],
    }));
    const harness = await createHarness(undefined, true, true, false, { collect });
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.conversationContext.enabled = true;
    harness.config.projects.splice(1);
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: ['oc_group'], knowledgeApprovers: [] };
    await harness.controller.handleMessage(message('/new repo', {
      chatId: 'oc_group', chatType: 'group', threadId: 'topic_history', rootId: 'om_root', wasMentioned: true,
    }));
    const task = harness.store.listTasks()[0]!;
    harness.store.saveConversationContextCursor({
      taskId: task.id, chatId: 'oc_group', threadId: 'topic_history', lastIncludedMessageId: 'om_newer',
      lastIncludedCreatedAt: '2026-08-13T20:21:00+08:00', updatedAt: new Date().toISOString(),
    });

    await harness.controller.handleMessage(message('上面 19:38 的转发消息这条内容，你能看到吗？', {
      chatId: 'oc_group', chatType: 'group', threadId: 'topic_history', rootId: 'om_root',
      messageId: 'om_history_trigger', wasMentioned: true,
    }));

    expect(collect).toHaveBeenLastCalledWith(expect.objectContaining({
      threadId: 'topic_history', referenceText: '上面 19:38 的转发消息这条内容，你能看到吗？',
    }));
    const lastCollectInput = (collect.mock.calls.at(-1) as unknown as Array<Record<string, unknown>>)?.[0];
    expect(lastCollectInput).not.toHaveProperty('afterCreatedAt');
    expect(harness.backend.startedTurns.at(-1)?.prompt).toContain('pricing context');
    await harness.stop(task.id);
  });

  it('infers an empty group mention from untrusted conversation context and commits its cursor', async () => {
    const collect = vi.fn(async () => ({
      scope: 'topic' as const, chatId: 'oc_group', threadId: 'topic_1', truncated: false,
      fetchedAt: '2026-08-03T10:00:00.000Z',
      messages: [
        { messageId: 'om_root', senderName: 'Alice', createdAt: '1722679000000', messageType: 'text', text: 'Please fix <the build>' },
        { messageId: 'om_reply', senderName: 'Bob', createdAt: '1722679100000', messageType: 'text', text: 'The failing target is api' },
      ],
      lastMessage: { messageId: 'om_reply', createdAt: '1722679100000' },
    }));
    const harness = await createHarness(undefined, true, true, false, { collect });
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.conversationContext.enabled = true;
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: ['oc_group'], knowledgeApprovers: [] };

    await expect(harness.controller.handleMessage(message('@bot', {
      chatId: 'oc_group', chatType: 'group', threadId: 'topic_1', rootId: 'om_root',
      messageId: 'om_trigger', createdAt: '1722679200000', wasMentioned: true,
    }))).resolves.toEqual({ text: '' });

    const task = harness.store.listTasks()[0]!;
    expect(collect).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'topic_1', rootId: 'om_root', triggerMessageId: 'om_trigger' }));
    expect(harness.backend.startedTurns[0]!.prompt).toContain('authority="background-only"');
    expect(harness.backend.startedTurns[0]!.prompt).toContain('Please fix &lt;the build&gt;');
    expect(harness.backend.startedTurns[0]!.prompt).toContain('Infer the concrete task');
    expect(harness.store.listTurnsByTask(task.id)[0]!.prompt).toBe('');
    expect(harness.store.getConversationContextCursor(task.id, 'oc_group', 'topic_1')).toMatchObject({
      lastIncludedMessageId: 'om_reply', lastIncludedCreatedAt: '1722679100000',
    });
    await harness.stop(task.id);
  });

  it('passes a shared-chat target to the model with requester identity and without expanding conversation_read access',async()=>{
    const provider:ConversationContextProvider={collect:vi.fn(async()=>({scope:'topic' as const,chatId:'oc_group',threadId:'topic_semantic',truncated:false,fetchedAt:new Date().toISOString(),
      messages:[{messageId:'om_card',createdAt:'1000',messageType:'share_chat',text:'[Shared chat card: chat_id=oc_target]',sharedChat:{chatId:'oc_target'}}]}))};
    const {harness:h,task}=await createSemanticBindingHarness('分析一下这个群里的消息，看看有哪些事情需要我处理的？',provider);
    try{
      const prompt=h.backend.startedTurns[0]!.prompt;
      expect(prompt).toContain('chat_id=oc_target');
      expect(prompt).toContain('shared-chat-guidance authority="manager" requester-id="ou_owner"');
      expect(prompt).toContain('verify the authorized user matches requester-id');
      expect(prompt).toContain('conversation_read remains limited to the current task conversation');
      expect(prompt).toContain('Do not ask for a chat ID that is already supplied');
      expect(h.store.getTurn(task.activeTurnId!)?.inputHandoff?.conversation?.messages[0]?.sharedChat).toEqual({chatId:'oc_target'});
    }finally{await h.stop(task.id);}
  });

  it('does not commit conversation cursor when Codex rejects the turn', async () => {
    const provider: ConversationContextProvider = { collect: vi.fn(async () => ({
      scope: 'group' as const, chatId: 'oc_group', truncated: false, fetchedAt: '2026-08-03T10:00:00.000Z',
      messages: [{ messageId: 'om_old', createdAt: '1722679000000', messageType: 'text', text: 'context' }],
      lastMessage: { messageId: 'om_old', createdAt: '1722679000000' },
    })) };
    const harness = await createHarness(undefined, true, true, false, provider);
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.conversationContext.enabled = true;
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: ['oc_group'], knowledgeApprovers: [] };
    harness.backend.startTurnError = new Error('turn rejected');

    await expect(harness.controller.handleMessage(message('fix it', {
      chatId: 'oc_group', chatType: 'group', messageId: 'om_trigger', wasMentioned: true,
    }))).rejects.toThrow('turn rejected');
    const task = harness.store.listTasks()[0]!;
    expect(harness.store.getConversationContextCursor(task.id, 'oc_group')).toBeUndefined();
    await harness.stop(task.id);
  });

  it('reloads bounded topic history after Codex natively compacts the task context', async () => {
    const collect = vi.fn(async () => ({
      scope: 'topic' as const, chatId: 'oc_group', threadId: 'topic_recovery', truncated: false, fetchedAt: '',
      messages: [
        { messageId: 'om_root', createdAt: '1000', messageType: 'text', text: 'root task' },
        { messageId: 'om_2246', createdAt: '2000', messageType: 'text', text: '22:46 instruction' },
        { messageId: 'om_2301', createdAt: '3000', messageType: 'text', text: '23:01 decision' },
      ],
      lastMessage: { messageId: 'om_2301', createdAt: '3000' },
    }));
    const harness = await createHarness(undefined, true, true, false, { collect });
    harness.config.conversationContext.enabled = true;
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.projects.splice(1);
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: ['oc_group'], knowledgeApprovers: [] };
    const topic = { chatId: 'oc_group', chatType: 'group' as const, threadId: 'topic_recovery', rootId: 'om_root', wasMentioned: true };
    await harness.controller.handleMessage(message('/new repo', topic));
    const task = harness.store.listTasks()[0]!;
    harness.store.saveConversationContextCursor({
      taskId: task.id, chatId: 'oc_group', threadId: 'topic_recovery',
      lastIncludedMessageId: 'om_before_compaction', lastIncludedCreatedAt: '9999', updatedAt: new Date().toISOString(),
    });

    harness.backend.emit(task.id, {
      type: 'item.completed', taskId: task.id, threadId: task.codexThreadId!, turnId: 'codex_turn_1',
      item: { id: 'compact_1', type: 'contextCompaction' },
    });
    await waitFor(() => harness.store.getConversationContextCursor(task.id, 'oc_group', 'topic_recovery')?.recoveryRequired === true);

    await harness.controller.handleMessage(message('继续处理', {
      ...topic, messageId: 'om_after_compaction', createdAt: '10000', wasMentioned: true,
    }));
    expect(collect).toHaveBeenLastCalledWith(expect.not.objectContaining({ afterCreatedAt: expect.anything() }));
    expect(harness.backend.startedTurns.at(-1)?.prompt).toContain('<context-recovery source="conversation-history"');
    expect(harness.backend.startedTurns.at(-1)?.prompt).toContain('22:46 instruction');
    expect(harness.store.getConversationContextCursor(task.id, 'oc_group', 'topic_recovery')).toMatchObject({
      recoveryRequired: false, compactionEpoch: 1, lastIncludedMessageId: 'om_2301',
    });
    await harness.stop(task.id);
  });

  it('reloads bounded ordinary-group history after Codex natively compacts the task context', async () => {
    const collect = vi.fn(async () => ({
      scope: 'group' as const, chatId: 'oc_group', truncated: false, fetchedAt: '',
      messages: [
        { messageId: 'om_earlier', createdAt: '2000', messageType: 'text', text: 'earlier group instruction' },
        { messageId: 'om_decision', createdAt: '3000', messageType: 'text', text: 'group decision' },
      ],
      lastMessage: { messageId: 'om_decision', createdAt: '3000' },
    }));
    const harness = await createHarness(undefined, true, true, false, { collect });
    harness.config.conversationContext.enabled = true;
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.projects.splice(1);
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: ['oc_group'], knowledgeApprovers: [] };
    const group = { chatId: 'oc_group', chatType: 'group' as const, wasMentioned: true };
    await harness.controller.handleMessage(message('/new repo', group));
    const task = harness.store.listTasks()[0]!;
    harness.store.saveConversationContextCursor({
      taskId: task.id, chatId: 'oc_group', lastIncludedMessageId: 'om_before_compaction',
      lastIncludedCreatedAt: '9999', updatedAt: new Date().toISOString(),
    });

    harness.backend.emit(task.id, {
      type: 'item.completed', taskId: task.id, threadId: task.codexThreadId!, turnId: 'codex_turn_1',
      item: { id: 'compact_group_1', type: 'contextCompaction' },
    });
    await waitFor(() => harness.store.getConversationContextCursor(task.id, 'oc_group')?.recoveryRequired === true);

    await harness.controller.handleMessage(message('继续处理', {
      ...group, messageId: 'om_after_compaction', createdAt: '10000', wasMentioned: true,
    }));
    expect(collect).toHaveBeenLastCalledWith(expect.not.objectContaining({
      afterCreatedAt: expect.anything(), threadId: expect.anything(),
    }));
    expect(harness.backend.startedTurns.at(-1)?.prompt).toContain('<context-recovery source="conversation-history"');
    expect(harness.backend.startedTurns.at(-1)?.prompt).toContain('earlier group instruction');
    expect(harness.store.getConversationContextCursor(task.id, 'oc_group')).toMatchObject({
      recoveryRequired: false, compactionEpoch: 1, lastIncludedMessageId: 'om_decision',
    });
    await harness.stop(task.id);
  });

  it('serves bounded history only from the active task topic through conversation_read', async () => {
    const collect = vi.fn(async () => ({
      scope: 'topic' as const, chatId: 'oc_group', threadId: 'topic_read', truncated: false, fetchedAt: '',
      messages: [{ messageId: 'om_2301', createdAt: '3000', messageType: 'text', text: '23:01 decision' }],
    }));
    const harness = await createHarness(undefined, true, true, false, { collect });
    harness.config.conversationContext.enabled = true;
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.projects.splice(1);
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: ['oc_group'], knowledgeApprovers: [] };
    const topic = { chatId: 'oc_group', chatType: 'group' as const, threadId: 'topic_read', rootId: 'om_root', wasMentioned: true };
    await harness.controller.handleMessage(message('/new repo', topic));
    const task = harness.store.listTasks()[0]!;
    await harness.controller.handleMessage(message('继续处理', { ...topic, messageId: 'om_trigger', createdAt: '4000', wasMentioned: true }));
    await waitFor(() => Boolean(harness.store.getTask(task.id)?.activeTurnId));
    harness.backend.emit(task.id, {
      type: 'backend.server_request', taskId: task.id, generation: 1, requestId: 'conversation_read_1', method: 'item/tool/call',
      params: { threadId: task.codexThreadId, turnId: 'codex_turn_1', callId: 'call_history', tool: 'conversation_read',
        arguments: { maxMessages: 10, afterCreatedAt: null, beforeCreatedAt: '3000', reference: '23:01' } },
    });
    await waitFor(() => harness.backend.responses.some((response) => response.requestId === 'conversation_read_1'));
    const response = harness.backend.responses.find((candidate) => candidate.requestId === 'conversation_read_1')!;
    expect(response.result).toMatchObject({ success: true });
    expect(JSON.stringify(response.result)).toContain('23:01 decision');
    expect(collect).toHaveBeenLastCalledWith(expect.objectContaining({
      threadId: 'topic_read', beforeCreatedAt: '3000', referenceText: '23:01', maxMessages: 10,
    }));
    await harness.stop(task.id);
  });

  it('serves bounded history from the active ordinary group through conversation_read', async () => {
    const collect = vi.fn(async () => ({
      scope: 'group' as const, chatId: 'oc_group', truncated: false, fetchedAt: '',
      messages: [{ messageId: 'om_decision', createdAt: '3000', messageType: 'text', text: 'ordinary group decision' }],
    }));
    const harness = await createHarness(undefined, true, true, false, { collect });
    harness.config.conversationContext.enabled = true;
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.projects.splice(1);
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: ['oc_group'], knowledgeApprovers: [] };
    const group = { chatId: 'oc_group', chatType: 'group' as const, wasMentioned: true };
    await harness.controller.handleMessage(message('/new repo', group));
    const task = harness.store.listTasks()[0]!;
    await harness.controller.handleMessage(message('继续处理', {
      ...group, messageId: 'om_trigger', createdAt: '4000', wasMentioned: true,
    }));
    await waitFor(() => Boolean(harness.store.getTask(task.id)?.activeTurnId));
    harness.backend.emit(task.id, {
      type: 'backend.server_request', taskId: task.id, generation: 1,
      requestId: 'conversation_read_group_1', method: 'item/tool/call',
      params: { threadId: task.codexThreadId, turnId: 'codex_turn_1', callId: 'call_group_history',
        tool: 'conversation_read', arguments: {
          maxMessages: 10, afterCreatedAt: null, beforeCreatedAt: '3000', reference: 'decision',
        } },
    });
    await waitFor(() => harness.backend.responses.some((response) => response.requestId === 'conversation_read_group_1'));
    const response = harness.backend.responses.find((candidate) => candidate.requestId === 'conversation_read_group_1')!;
    expect(response.result).toMatchObject({ success: true });
    expect(JSON.stringify(response.result)).toContain('ordinary group decision');
    expect(collect).toHaveBeenLastCalledWith(expect.objectContaining({
      chatId: 'oc_group', beforeCreatedAt: '3000', referenceText: 'decision', maxMessages: 10,
    }));
    const lastCollectInput = (collect.mock.calls.at(-1) as unknown as Array<Record<string, unknown>>)?.[0];
    expect(lastCollectInput).not.toHaveProperty('threadId');
    await harness.stop(task.id);
  });

  it('automatically creates a conversation workspace for the first ordinary message in projectless mode', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: [], knowledgeApprovers: [] };

    await expect(harness.controller.handleMessage(message('inspect the relevant repository'))).resolves.toEqual({ text: '' });

    const [task] = harness.store.listTasks();
    expect(task).toMatchObject({ ownerUserId: 'ou_owner', runtimeState: 'hot' });
    expect(harness.provisioner.provision).toHaveBeenCalledWith(expect.objectContaining({ genericWorkspace: true }));
    expect(harness.store.listTaskRepositories(task!.id)).toEqual([
      expect.objectContaining({ projectId: 'repo', checkoutPath: '/workspace/projects/repo', status: 'ready' }),
    ]);
    expect(harness.backend.startedTurns).toEqual([
      expect.objectContaining({ taskId: task!.id, prompt: 'inspect the relevant repository' }),
    ]);
    await harness.stop(task!.id);
  });

  it('continues the first turn when inferred repository preloading fails', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: [], knowledgeApprovers: [] };
    harness.provisioner.addRepository.mockRejectedValueOnce(new Error('ENOTEMPTY: directory not empty'));

    await expect(harness.controller.handleMessage(message('analyze the linked requirement'))).resolves.toEqual({ text: '' });

    const [task] = harness.store.listTasks();
    expect(task).toMatchObject({ ownerUserId: 'ou_owner', runtimeState: 'hot' });
    expect(harness.store.listTaskRepositories(task!.id)).toEqual([
      expect.objectContaining({ projectId: 'repo', status: 'failed', failure: 'ENOTEMPTY: directory not empty' }),
    ]);
    expect(harness.backend.startedTurns).toEqual([
      expect.objectContaining({ taskId: task!.id, prompt: 'analyze the linked requirement' }),
    ]);
    await harness.stop(task!.id);
  });

  it('infers the initial project from the group name and topic root before creating the task', async () => {
    const context: ConversationContextProvider = { collect: vi.fn(async () => ({
      scope: 'topic' as const, chatId: 'oc_group', threadId: 'topic_1', truncated: false, fetchedAt: '',
      messages: [{ messageId: 'om_root', createdAt: '1', messageType: 'text', text: 'example-api 服务运行失败' }],
    })) };
    const chatInfo = { get: vi.fn(async () => ({ name: 'Example Assistant 运行问题反馈群' })) };
    const harness = await createHarness(undefined, true, true, false, context, chatInfo);
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.conversationContext.enabled = true;
    harness.config.projects[0] = { ...harness.config.projects[0]!, id: 'link-bot', name: 'Link Bot' };
    harness.config.projects[1] = { ...harness.config.projects[1]!, id: 'example-api', name: 'Example Assistant', description: 'Go service runtime' };
    for (const project of harness.config.projects) project.access = { allowedUsers: ['ou_owner'], allowedChats: ['oc_group'], knowledgeApprovers: [] };

    await harness.controller.handleMessage(message('@bot 查运行日志', {
      chatId: 'oc_group', chatType: 'group', threadId: 'topic_1', rootId: 'om_root', messageId: 'om_trigger', wasMentioned: true,
    }));

    expect(harness.store.listTasks()[0]?.projectId).toBe('example-api');
    expect(context.collect).toHaveBeenCalledTimes(1);
    expect(harness.provisioner.provision).toHaveBeenCalledWith(expect.objectContaining({ project: expect.objectContaining({ id: 'example-api' }) }));
    await harness.stop(harness.store.listTasks()[0]!.id);
  });

  it('does not bind an ambiguous multi-project conversation to the first authorized project', async () => {
    const context: ConversationContextProvider = { collect: vi.fn(async () => ({
      scope: 'topic' as const, chatId: 'oc_group', threadId: 'topic_1', truncated: false, fetchedAt: '',
      messages: [{ messageId: 'om_root', createdAt: '1', messageType: 'text', text: '请分析这个问题' }],
    })) };
    const chatInfo = { get: vi.fn(async () => ({ name: '小型反馈 & Bugfix 快速处理工作室' })) };
    const harness = await createHarness(undefined, true, true, false, context, chatInfo);
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.conversationContext.enabled = true;
    harness.config.projects[0] = { ...harness.config.projects[0]!, id: 'link-bot', name: 'Link Bot' };
    harness.config.projects[1] = { ...harness.config.projects[1]!, id: 'example-sdk', name: 'Example SDK' };
    for (const project of harness.config.projects) {
      project.access = { allowedUsers: ['ou_owner'], allowedChats: ['oc_group'], knowledgeApprovers: [] };
    }

    const reply = await harness.controller.handleMessage(message('重试任务', {
      chatId: 'oc_group', chatType: 'group', threadId: 'topic_1', rootId: 'om_root',
      messageId: 'om_retry', wasMentioned: true,
    }));

    expect(reply.rendered?.preferred.kind).toBe('card');
    expect(harness.store.listTasks()).toEqual([]);
    expect(harness.provisioner.provision).not.toHaveBeenCalled();

    const routing = harness.store.getPendingProjectRoutingByMessage('om_retry')!;
    const selected = await harness.controller.handleCardAction({
      chatId: 'oc_group', chatType: 'group', userId: 'ou_owner', threadId: 'topic_1', messageId: 'om_card',
      action: { kind: 'project_routing_select', routingId: routing.id, projectId: 'example-sdk' },
    });
    expect(selected.delivery?.kind).toBe('update_origin_card');
    expect(harness.store.listTasks()[0]).toMatchObject({ projectId: 'example-sdk' });
    expect(harness.backend.startedTurns.at(-1)?.prompt).toContain('重试任务');
    await harness.stop(harness.store.listTasks()[0]!.id);
  });

  it('keeps the materialized base stable during ordinary turns on the same planned branch', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: ['oc_group'], knowledgeApprovers: [] };
    await harness.controller.handleMessage(message('/new repo', {
      chatId: 'oc_group', chatType: 'group', threadId: 'topic_remote_advance', rootId: 'om_root', wasMentioned: true,
    }));
    const task = harness.store.listTasks()[0]!;
    const repository = harness.store.listTaskRepositories(task.id)[0]!;
    harness.store.updateTask(task.id, (current) => ({
      ...current,
      workspacePlan: {
        repositories: [{ projectId: repository.projectId, baseRef: repository.baseRef, role: 'primary', reason: '用户指定基线' }],
        stages: [], explicit: true,
      },
    }));
    harness.provisioner.resolveRepositoryBaseCommit = vi.fn(async () => 'new_remote_commit');
    harness.provisioner.migrateRepository = vi.fn(async () => ({ status: 'completed' as const, baseCommit: 'new_remote_commit' }));

    await harness.controller.handleMessage(message('继续任务', {
      chatId: 'oc_group', chatType: 'group', threadId: 'topic_remote_advance', rootId: 'om_root', wasMentioned: true,
    }));

    expect(harness.provisioner.resolveRepositoryBaseCommit).not.toHaveBeenCalled();
    expect(harness.provisioner.migrateRepository).not.toHaveBeenCalled();
    expect(harness.store.getTaskRepository(repository.id)?.baseCommit).toBe(repository.baseCommit);
    await harness.stop(task.id);
  });

  it('explicitly synchronizes an advanced same-name base without recreating the workspace', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: ['oc_group'], knowledgeApprovers: [] };
    await harness.controller.handleMessage(message('开始任务', {
      chatId: 'oc_group', chatType: 'group', threadId: 'topic_explicit_sync', rootId: 'om_root', wasMentioned: true,
    }));
    const task = harness.store.listTasks()[0]!;
    const repository = harness.store.listTaskRepositories(task.id)[0]!;
    harness.store.saveTaskRepository({ ...repository, baseRef: 'develop', baseCommit: 'old_develop' });
    harness.provisioner.resolveRepositoryBaseCommit = vi.fn(async () => 'latest_develop');
    harness.provisioner.migrateRepository = vi.fn(async () => ({ status: 'completed' as const, baseCommit: 'latest_develop' }));

    harness.backend.emit(task.id, {
      type: 'backend.server_request', taskId: task.id, generation: 1, requestId: 'sync_base_1', method: 'item/tool/call',
      params: { threadId: task.codexThreadId, tool: 'project_sync_base', arguments: {
        projectId: 'repo', baseRef: 'develop', reason: '用户要求 rebase 最新 develop',
      } },
    });
    await waitFor(() => harness.backend.responses.some((response) => response.requestId === 'sync_base_1'));
    const response = harness.backend.responses.find((item) => item.requestId === 'sync_base_1')!;
    expect(response.result, JSON.stringify(response.result)).toMatchObject({ success: true });

    expect(harness.provisioner.migrateRepository).toHaveBeenCalledWith(
      expect.objectContaining({ id: task.id }), expect.objectContaining({ id: 'repo' }),
      expect.objectContaining({ baseRef: 'develop', baseCommit: 'old_develop' }),
      'develop', expect.stringMatching(/^repository_migration_/),
    );
    expect(harness.store.getTaskRepository(repository.id)).toMatchObject({ baseRef: 'develop', baseCommit: 'latest_develop' });
    expect(JSON.stringify(response.result)).toContain('status');
    expect(JSON.stringify(response.result)).toContain('completed');
    expect(JSON.stringify(response.result)).toContain('continue the user original request now');
    await harness.stop(task.id);
  });

  it('synchronizes an advanced base before the model handles an explicit rebase retry', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: ['oc_group'], knowledgeApprovers: [] };
    await harness.controller.handleMessage(message('开始任务', {
      chatId: 'oc_group', chatType: 'group', threadId: 'topic_pre_turn_sync', rootId: 'om_root', wasMentioned: true,
    }));
    const task = harness.store.listTasks()[0]!;
    harness.backend.emit(task.id, {
      type: 'turn.completed', taskId: task.id, threadId: task.codexThreadId!, turnId: 'codex_turn_1',
      status: 'completed', turn: { items: [] },
    });
    await waitFor(() => harness.store.listTurnsByTask(task.id)[0]?.state === 'completed');
    const repository = harness.store.listTaskRepositories(task.id)[0]!;
    harness.store.saveTaskRepository({ ...repository, baseRef: 'develop', baseCommit: 'old_develop' });
    harness.provisioner.resolveRepositoryBaseCommit = vi.fn(async () => 'latest_develop');
    harness.provisioner.migrateRepository = vi.fn(async () => ({ status: 'completed' as const, baseCommit: 'latest_develop' }));

    await harness.controller.handleMessage(message('重试 rebase', {
      chatId: 'oc_group', chatType: 'group', threadId: 'topic_pre_turn_sync', rootId: 'om_root', wasMentioned: true,
    }));

    expect(harness.provisioner.migrateRepository).toHaveBeenCalledWith(
      expect.objectContaining({ id: task.id }), expect.objectContaining({ id: 'repo' }),
      expect.objectContaining({ baseRef: 'develop', baseCommit: 'old_develop' }),
      'develop', expect.stringMatching(/^repository_migration_/),
    );
    expect(harness.store.getTaskRepository(repository.id)).toMatchObject({ baseRef: 'develop', baseCommit: 'latest_develop' });
    expect(harness.backend.startedTurns.at(-1)?.prompt).toContain('Manager 已在模型执行前将 repo/develop');
    expect(harness.backend.startedTurns.at(-1)?.prompt).toContain('latest_develop');
    await harness.stop(task.id);
  });

  it('routes an explicitly named frontend project within the authorized catalog', async () => {
    const context: ConversationContextProvider = { collect: vi.fn(async () => ({
      scope: 'topic' as const, chatId: 'oc_group', threadId: 'topic_ui', truncated: false, fetchedAt: '',
      messages: [{ messageId: 'om_root', createdAt: '1', messageType: 'text', text: '变量胶囊跟文字没有水平对齐' }],
    })) };
    const harness = await createHarness(undefined, true, true, false, context, { get: vi.fn(async () => ({ name: '小型反馈快速处理' })) });
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.conversationContext.enabled = true;
    harness.config.projects[0] = { ...harness.config.projects[0]!, id: 'example-web', name: 'Example Assistant Web', description: 'Chatbot frontend React web UI' };
    harness.config.projects[1] = { ...harness.config.projects[1]!, id: 'example-api', name: 'Example Assistant', description: 'Chatbot backend Go service' };
    for (const project of harness.config.projects) project.access = { allowedUsers: ['ou_owner'], allowedChats: ['oc_group'], knowledgeApprovers: [] };

    await harness.controller.handleMessage(message('@bot 看看如何修复这个问题，项目是 Example Assistant Web 前端仓库', {
      chatId: 'oc_group', chatType: 'group', threadId: 'topic_ui', rootId: 'om_root', messageId: 'om_ui', wasMentioned: true,
    }));

    expect(harness.store.listTasks()[0]).toMatchObject({ projectId: 'example-web' });
    expect(harness.backend.startedTurns.at(-1)?.prompt).toContain('Example Assistant Web 前端仓库');
    await harness.stop(harness.store.listTasks()[0]!.id);
  });

  it('reports workspace and loaded repositories without exposing a selected project in projectless status', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: [], knowledgeApprovers: [] };
    await harness.controller.handleMessage(message('inspect'));
    const task = harness.store.listTasks()[0]!;

    const status = await harness.service.status(actor());
    expect(status).toContain(`Workspace: ${task.id}`);
    expect(status).toContain('Repositories: repo');
    expect(status).not.toContain('Project:');
    await harness.stop(task.id);
  });

  it('answers project_catalog tool calls with the conversation-authorized catalog', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.projects[0]!.description = 'Primary repository';
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: [], knowledgeApprovers: [] };
    await harness.controller.handleMessage(message('find the relevant project'));
    const task = harness.store.listTasks()[0]!;

    harness.backend.emit(task.id, {
      type: 'backend.server_request', taskId: task.id, generation: 1, requestId: 'catalog_1',
      method: 'item/tool/call', params: { threadId: task.codexThreadId, tool: 'project_catalog', arguments: {} },
    });
    await waitFor(() => harness.backend.responses.length === 1);

    expect(harness.backend.responses[0]).toMatchObject({
      requestId: 'catalog_1', result: { success: true },
    });
    expect(JSON.stringify(harness.backend.responses[0]!.result)).toContain('Primary repository');
    expect(JSON.stringify(harness.backend.responses[0]!.result)).not.toContain(harness.config.projects[1]!.id);
    await harness.stop(task.id);
  });

  it('answers project_status with Manager-authoritative materialization facts', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: [], knowledgeApprovers: [] };
    await harness.controller.handleMessage(message('inspect the current repository state'));
    const task = harness.store.listTasks()[0]!;
    const repository = harness.store.listTaskRepositories(task.id)[0]!;

    harness.backend.emit(task.id, {
      type: 'backend.server_request', taskId: task.id, generation: 1, requestId: 'status_1',
      method: 'item/tool/call', params: { threadId: task.codexThreadId, tool: 'project_status', arguments: {} },
    });
    await waitFor(() => harness.backend.responses.length === 1);

    expect(harness.backend.responses[0]).toMatchObject({ requestId: 'status_1', result: { success: true } });
    const response = JSON.stringify(harness.backend.responses[0]!.result);
    expect(response).toContain('immutable_during_turn_publish_sync');
    expect(response).toContain(repository.baseRef);
    expect(response).toContain(repository.baseCommit);
    await harness.stop(task.id);
  });

  it('answers legacy project_status calls with native Git authority after rollout', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.runtime = { backend: 'app-server', nativeGitExecution: true, managerGitToolFallback: true };
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: [], knowledgeApprovers: [] };
    await harness.controller.handleMessage(message('inspect the current repository state'));
    const task = harness.store.listTasks()[0]!;

    harness.backend.emit(task.id, {
      type: 'backend.server_request', taskId: task.id, generation: 1, requestId: 'native_status_1',
      method: 'item/tool/call', params: { threadId: task.codexThreadId, tool: 'project_status', arguments: {} },
    });
    await waitFor(() => harness.backend.responses.length === 1);

    const response = JSON.stringify(harness.backend.responses[0]!.result);
    expect(response).toContain('task_workspace_git');
    expect(response).toContain('native_git_mutable');
    expect(response).toContain('recordedInitialBaseSha');
    expect(response).not.toContain('materializedBaseSha');
    await harness.stop(task.id);
  });

  it('loads an authorized repository during a turn through project_open', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    for (const project of harness.config.projects) {
      project.access = { allowedUsers: ['ou_owner'], allowedChats: [], knowledgeApprovers: [] };
    }
    await harness.controller.handleMessage(message('compare repo with the other authorized repository'));
    const task = harness.store.listTasks()[0]!;

    harness.backend.emit(task.id, {
      type: 'backend.server_request', taskId: task.id, generation: 1, requestId: 'open_1',
      method: 'item/tool/call', params: {
        threadId: task.codexThreadId, tool: 'project_open', arguments: { projectId: harness.config.projects[1]!.id },
      },
    });
    await waitFor(() => harness.backend.responses.length === 1);

    expect(harness.backend.responses[0]).toMatchObject({ requestId: 'open_1', result: { success: true } });
    expect(harness.store.listTaskRepositories(task.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectId: harness.config.projects[1]!.id, status: 'ready' }),
    ]));
    await harness.stop(task.id);
  });

  it('keeps serving project reads while a mutating project tool is blocked', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const requestExistingBranch = vi.fn(async () => { await gate; return { requestId: 'pub_existing_1', expiresAt: '2099-01-01T00:00:00.000Z' }; });
    const harness = await createHarness(() => ({
      request: vi.fn(async () => ({ requestId: 'unused' })), requestExistingBranch,
      decide: vi.fn(async () => 'published'),
    }), true, true);
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: [], knowledgeApprovers: [] };
    await harness.controller.handleMessage(message('publish the current branch'));
    const task = harness.store.listTasks()[0]!;

    harness.backend.emit(task.id, {
      type: 'backend.server_request', taskId: task.id, generation: 1, requestId: 'publish_blocked', method: 'item/tool/call',
      params: { threadId: task.codexThreadId, tool: 'project_publish_existing_branch', arguments: {
        projectId: 'repo', targetBranch: 'feature/existing', expectedHeadSha: 'abcdef1234567', reason: 'test',
      } },
    });
    await vi.waitFor(() => expect(requestExistingBranch).toHaveBeenCalledOnce());
    harness.backend.emit(task.id, {
      type: 'backend.server_request', taskId: task.id, generation: 1, requestId: 'catalog_while_blocked',
      method: 'item/tool/call', params: { threadId: task.codexThreadId, tool: 'project_catalog', arguments: {} },
    });

    await waitFor(() => harness.backend.responses.some((response) => response.requestId === 'catalog_while_blocked'));
    expect(harness.backend.responses.find((response) => response.requestId === 'catalog_while_blocked'))
      .toMatchObject({ result: { success: true } });
    release();
    await waitFor(() => harness.backend.responses.some((response) => response.requestId === 'publish_blocked'));
    await harness.stop(task.id);
  });

  it('routes new branch publication through the merge request broker capability', async () => {
    const requestMergeRequest = vi.fn(async () => ({ requestId: 'pub_mr_1', expiresAt: '2099-01-01T00:00:00.000Z' }));
    const harness = await createHarness(() => ({
      request: vi.fn(async () => ({ requestId: 'unused' })), requestMergeRequest,
      decide: vi.fn(async () => 'published'),
    }), true, true);
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: [], knowledgeApprovers: [] };
    await harness.controller.handleMessage(message('fix and open an MR'));
    const task = harness.store.listTasks()[0]!;

    harness.backend.emit(task.id, {
      type: 'backend.server_request', taskId: task.id, generation: 1, requestId: 'publish_mr_1', method: 'item/tool/call',
      params: { threadId: task.codexThreadId, tool: 'project_publish_merge_request', arguments: {
        projectId: 'repo', targetBranch: 'codex/fix-tracking-8.2', baseRef: 'release-2026.8.2',
        expectedHeadSha: 'abcdef1234567', reason: 'tracking fix',
      } },
    });
    await waitFor(() => harness.backend.responses.length === 1);

    expect(requestMergeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: task.id }), expect.objectContaining({ userId: 'ou_owner' }),
      expect.objectContaining({ projectId: 'repo' }), 'codex/fix-tracking-8.2', 'release-2026.8.2', 'abcdef1234567',
    );
    expect(harness.backend.responses[0]).toMatchObject({
      requestId: 'publish_mr_1', result: { success: true, contentItems: [{ text: expect.stringContaining('confirmation_required') }] },
    });
    expect(harness.store.db.prepare("SELECT dedupe_key FROM outbound_events WHERE event_type='card' ORDER BY created_at DESC LIMIT 1").get())
      .toEqual({ dedupe_key: 'pub_mr_1:publish-card:2099-01-01T00:00:00.000Z' });
    await harness.stop(task.id);
  });

  it('synchronizes an advanced MR target before creating a publish request', async () => {
    const requestMergeRequest = vi.fn(async () => ({ requestId: 'must_not_publish', expiresAt: '2099-01-01T00:00:00.000Z' }));
    const harness = await createHarness(() => ({
      request: vi.fn(async () => ({ requestId: 'unused' })), requestMergeRequest,
      decide: vi.fn(async () => 'published'),
    }), true, true);
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: [], knowledgeApprovers: [] };
    await harness.controller.handleMessage(message('fix and open an MR'));
    const task = harness.store.listTasks()[0]!;
    const repository = harness.store.listTaskRepositories(task.id)[0]!;
    harness.store.saveTaskRepository({ ...repository, baseRef: 'develop', baseCommit: 'old_base' });
    harness.provisioner.resolveRepositoryBaseCommit = vi.fn(async () => 'new_base');
    harness.provisioner.migrateRepository = vi.fn(async () => ({ status: 'completed' as const, baseCommit: 'new_base' }));

    harness.backend.emit(task.id, {
      type: 'backend.server_request', taskId: task.id, generation: 1, requestId: 'publish_sync_1', method: 'item/tool/call',
      params: { threadId: task.codexThreadId, tool: 'project_publish_merge_request', arguments: {
        projectId: 'repo', targetBranch: 'codex/fix', baseRef: 'develop', expectedHeadSha: 'abcdef1234567', reason: 'fix',
      } },
    });
    await waitFor(() => harness.backend.responses.length === 1);

    expect(requestMergeRequest).not.toHaveBeenCalled();
    expect(harness.provisioner.migrateRepository).toHaveBeenCalledOnce();
    expect(JSON.stringify(harness.backend.responses[0]!.result)).toContain('workspace_synchronized');
    expect(harness.store.getTaskRepository(repository.id)?.baseCommit).toBe('new_base');
    await harness.stop(task.id);
  });

  it('blocks later execution when access to a loaded repository is revoked', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: [], knowledgeApprovers: [] };
    await harness.controller.handleMessage(message('start'));
    const task = harness.store.listTasks()[0]!;
    expect(harness.store.listTaskRepositories(task.id)).toEqual([
      expect.objectContaining({ projectId: 'repo', status: 'ready' }),
    ]);
    harness.config.projects[0]!.access!.allowedUsers = [];
    harness.backend.emit(task.id, {
      type: 'turn.completed', taskId: task.id, threadId: task.codexThreadId!, turnId: 'codex_turn_1', status: 'completed', turn: {},
    });
    await waitFor(() => harness.store.listTurnsByTask(task.id)[0]?.state === 'completed');

    await expect(harness.controller.handleMessage(message('continue'))).rejects.toThrow('authorization was removed');
    await harness.stop(task.id);
  });

  it('keeps one conversation task and rotates only its Codex context on later /new commands', async () => {
    const harness = await createHarness(undefined, true);
    const first = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(first.text)![0];
    const branchName = harness.store.getTask(taskId)?.branchName;
    const initial = harness.store.getActiveTaskContext(taskId)!;

    const second = await harness.controller.handleMessage(message('/new --blank'));

    expect(second.text).toContain(`in task ${taskId}`);
    expect(harness.store.listTasks()).toHaveLength(1);
    expect(harness.provisioner.provision).toHaveBeenCalledTimes(1);
    expect(harness.store.getTask(taskId)).toMatchObject({ branchName, codexThreadId: 'thread_2', runtimeState: 'hot' });
    expect(harness.store.getTaskContext(initial.id)?.state).toBe('archived');
    expect(harness.store.listTaskContexts(taskId).filter((context) => context.state === 'active')).toHaveLength(1);
    expect(harness.backend.archivedThreads).toEqual(['thread_1']);
    await harness.stop(taskId);
  });

  it('creates a separate personal conversation task for each group member', async () => {
    const harness = await createHarness(undefined, true);
    const ownerMessage = message('@bot /new repo', { chatType: 'group', chatId: 'oc_group', wasMentioned: true });
    const reply = await harness.controller.handleMessage(ownerMessage);
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    const member = message('@bot inspect', { chatType: 'group', chatId: 'oc_group', userId: 'ou_member', wasMentioned: true });

    await harness.controller.handleMessage(message('@bot /new repo', {
      chatType: 'group', chatId: 'oc_group', userId: 'ou_member', wasMentioned: true,
    }));
    await expect(harness.controller.handleMessage(member)).resolves.toEqual({ text: '' });
    const memberTask = harness.store.listTasks().find((task) => task.ownerUserId === 'ou_member')!;
    expect(memberTask.id).not.toBe(taskId);
    expect(harness.store.listTurnsByTask(memberTask.id)[0]).toMatchObject({ createdBy: 'ou_member', prompt: 'inspect' });
    await expect(harness.service.requestDelete(actor('ou_member', { chatType: 'group', chatId: 'oc_group' })))
      .resolves.toMatchObject({ requestId: expect.stringMatching(/^delete_/) });
    expect(harness.store.getTaskMembership(memberTask.id, 'ou_member')).toMatchObject({ role: 'owner' });
    await harness.stop(taskId);
    await harness.stop(memberTask.id);
  });

  it('does not let a group member inherit the owner personal workspace or project authorization', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.upgrade.adminUsers = ['ou_owner'];
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: [], knowledgeApprovers: [] };
    const group = { chatType: 'group', chatId: 'oc_group', wasMentioned: true } as const;
    await harness.controller.handleMessage(message('@bot /new repo', group));
    const task = harness.store.listTasks()[0]!;
    expect(harness.store.listTaskRepositories(task.id)).toEqual([
      expect.objectContaining({ projectId: 'repo', status: 'ready' }),
    ]);

    await expect(harness.controller.handleMessage(message('@bot continue the analysis', {
      ...group, userId: 'ou_member',
    }))).rejects.toThrow('No projects are authorized');
    expect(harness.store.listTurnsByTask(task.id)).toHaveLength(0);
    await expect(harness.service.requestDelete(actor('ou_member', { chatType: 'group', chatId: 'oc_group' })))
      .rejects.toThrow('No task exists');
    await harness.stop(task.id);
  });

  it('lets the authenticated group member who started a turn answer its approval', async () => {
    const harness = await createHarness(undefined, true);
    const group = { chatType: 'group', chatId: 'oc_group', wasMentioned: true };
    const reply = await harness.controller.handleMessage(message('@bot /new repo', group));
    const ownerTaskId = /task_[\w-]+/.exec(reply.text)![0];
    await harness.controller.handleMessage(message('@bot /new repo', { ...group, userId: 'ou_member' }));
    await harness.controller.handleMessage(message('@bot run tests', { ...group, userId: 'ou_member' }));
    const memberTaskId = harness.store.listTasks().find((task) => task.ownerUserId === 'ou_member')!.id;
    await waitFor(() => Boolean(harness.store.listTurnsByTask(memberTaskId)[0]?.codexTurnId));
    harness.backend.emit(memberTaskId, {
      type: 'backend.server_request', taskId: memberTaskId, generation: 2, requestId: 17,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread_2', turnId: 'codex_turn_1', command: 'npm test' },
    });
    await waitFor(() => harness.rendered.length === 1);

    expect(harness.rendered[0]).toMatchObject({ ownerUserId: 'ou_member' });
    await expect(harness.controller.handleCardAction({
      chatId: 'oc_group', chatType: 'group', userId: 'ou_member',
      action: { kind: 'app_server_request_decision', requestId: harness.rendered[0]!.id, generation: 2, decision: 'allow' },
    })).resolves.toMatchObject({ text: 'Decision applied.' });
    await harness.stop(ownerTaskId);
    await harness.stop(memberTaskId);
  });

  it('records usage but never rotates context after a completed turn crosses the old hard threshold', async () => {
    const harness = await createHarness(undefined, true);
    harness.config.taskPlatformRollout.automaticContextRotation = true;
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    await harness.controller.handleMessage(message('large context turn'));
    await waitFor(() => Boolean(harness.store.listTurnsByTask(taskId)[0]?.codexTurnId));
    harness.backend.emit(taskId, {
      type: 'usage.updated', taskId, threadId: 'thread_1', turnId: 'codex_turn_1',
      usage: { total: { totalTokens: 90_000 }, last: { totalTokens: 9_000 }, modelContextWindow: 10_000 },
    });
    harness.backend.emit(taskId, {
      type: 'turn.completed', taskId, threadId: 'thread_1', turnId: 'codex_turn_1', status: 'completed', turn: { items: [] },
    });

    await waitFor(() => harness.store.listTurnsByTask(taskId)[0]?.state === 'completed');
    expect(harness.store.getTask(taskId)?.codexThreadId).toBe('thread_1');
    expect(harness.store.getActiveTaskContext(taskId)?.usage).toMatchObject({ currentTokens: 9_000 });
    await expect(harness.service.usage({ ...actor(), period: 'task' })).resolves.toContain('90K（90,000） tokens');
    expect(harness.backend.archivedThreads).toEqual([]);
    expect(harness.store.listTaskContexts(taskId)).toHaveLength(1);
    await harness.stop(taskId);
  });

  it('serializes /new with a prompt and submits the prompt once on the selected context', async () => {
    const harness = await createHarness(undefined, true);
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    let release!: () => void;
    harness.backend.createContextGate = new Promise<void>((resolve) => { release = resolve; });

    const rotation = harness.controller.handleMessage(message('/new'));
    await waitFor(() => harness.backend.createContextCalls === 1);
    const prompt = harness.controller.handleMessage(message('after rotation'));
    release();
    await rotation;
    await prompt;

    expect(harness.store.getTask(taskId)?.codexThreadId).toBe('thread_2');
    expect(harness.backend.startedTurns).toHaveLength(1);
    expect(harness.backend.startedTurns[0]).toMatchObject({ taskId, prompt: 'after rotation' });
    await harness.stop(taskId);
  });

  it('rejects an approval card copied into a sibling topic even for the same user', async () => {
    const harness = await createHarness(undefined, true);
    const topic = { chatType: 'group', chatId: 'oc_group', threadId: 'topic_1', wasMentioned: true };
    const reply = await harness.controller.handleMessage(message('@bot /new repo', topic));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    await harness.controller.handleMessage(message('@bot run command', topic));
    await waitFor(() => Boolean(harness.store.listTurnsByTask(taskId)[0]?.codexTurnId));
    harness.backend.emit(taskId, {
      type: 'backend.server_request', taskId, generation: 1, requestId: 9,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread_1', turnId: 'codex_turn_1', command: 'npm test' },
    });
    await waitFor(() => harness.rendered.length === 1);

    await expect(harness.controller.handleCardAction({
      chatId: 'oc_group', chatType: 'group', userId: 'ou_owner', threadId: 'topic_2',
      action: { kind: 'app_server_request_decision', requestId: harness.rendered[0]!.id, generation: 1, decision: 'allow' },
    })).rejects.toThrow('acting conversation');
    expect(harness.backend.responses).toHaveLength(0);
    await harness.stop(taskId);
  });

  it('adds multiple repositories inside one task without replacing its runtime or context', async () => {
    const harness = await createHarness(undefined, true, true);
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    const contextId = harness.store.getActiveTaskContext(taskId)?.id;
    const branchName = harness.store.getTask(taskId)?.branchName;

    const added = await harness.controller.handleMessage(message('/repo add repo2 develop'));
    const listed = await harness.controller.handleMessage(message('/repos'));

    expect(added.text).toContain('/workspace/repositories/repo2-');
    expect(listed.text).toContain('repo ready primary /workspace');
    expect(listed.text).toContain('repo2 ready');
    expect(harness.store.getTask(taskId)).toMatchObject({ branchName, codexThreadId: 'thread_1' });
    expect(harness.store.getActiveTaskContext(taskId)?.id).toBe(contextId);
    expect(harness.provisioner.addRepository).toHaveBeenCalledTimes(1);
    expect(harness.provisioner.addRepository.mock.calls[0]?.[2]).toMatchObject({ baseRef: 'develop', isPrimary: false });
    await harness.stop(taskId);
  });

  it('binds publish confirmation to the explicitly selected repository', async () => {
    let selectedRepository: TaskRepositoryRecord | undefined;
    const harness = await createHarness((store) => ({
      request: vi.fn(async (task, _actor, repository) => {
        selectedRepository = repository;
        store.db.prepare(`
          INSERT INTO publish_requests(id, task_id, owner_user_id, status, idempotency_key, payload, created_at, updated_at)
          VALUES ('pub_repo2', ?, ?, 'pending', 'repo2-key', '{}', ?, ?)
        `).run(task.id, task.ownerUserId, task.createdAt, task.updatedAt);
        return { requestId: 'pub_repo2' };
      }),
      decide: vi.fn(async () => 'Published.'),
    }), true, true);
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    await harness.controller.handleMessage(message('/repo add repo2'));

    await harness.controller.handleMessage(message('/publish repo2'));

    expect(selectedRepository).toMatchObject({ taskId, projectId: 'repo2', isPrimary: false, status: 'ready' });
    await harness.stop(taskId);
  });

  it('creates one aggregate confirmation and publishes every loaded repository after approval', async () => {
    const requested: string[] = [];
    const decided: string[] = [];
    let sequence = 0;
    const harness = await createHarness(() => ({
      request: vi.fn(async (_task, _actor, repository) => {
        requested.push(repository!.projectId);
        sequence += 1;
        return { requestId: `pub_child_${sequence}` };
      }),
      decide: vi.fn(async (requestId) => { decided.push(requestId); return `Published ${requestId}.`; }),
    }), true, true);
    await harness.controller.handleMessage(message('/new repo'));
    await harness.controller.handleMessage(message('/repo add repo2'));
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.upgrade.adminUsers = ['ou_owner'];

    const confirmation = await harness.controller.handleMessage(message('/publish'));
    const aggregateId = /publish_[\w-]+/.exec(JSON.stringify(confirmation.rendered))![0];
    expect(requested).toEqual(['repo', 'repo2']);

    await harness.controller.handleCardAction(card({ kind: 'task_publish_decision', requestId: aggregateId, decision: 'confirm' }));
    expect(decided).toEqual(['pub_child_1', 'pub_child_2']);
    await harness.stop(harness.store.listTasks()[0]!.id);
  });

  it('injects bounded progressive memory after historical warnings without changing the stored user prompt', async () => {
    const harness = await createHarness(undefined, true, false, true);
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    const remembered = await harness.controller.handleMessage(message('/remember task Alpha uses SQLite'));
    const memoryId = /memory_[\w-]+/.exec(remembered.text)![0];

    await harness.controller.handleMessage(message('What does Alpha use?'));
    expect(harness.store.listTurnsByTask(taskId)[0]?.prompt).toBe('What does Alpha use?');
    expect(harness.backend.startedTurns[0]?.prompt).toContain('Historical memory data');
    expect(harness.backend.startedTurns[0]?.prompt).toContain('<current-user-request>\nWhat does Alpha use?');
    harness.backend.emit(taskId, {
      type: 'turn.completed', taskId, threadId: 'thread_1', turnId: 'codex_turn_1', status: 'completed', turn: { items: [] },
    });
    await waitFor(() => harness.store.listTurnsByTask(taskId)[0]?.state === 'completed');

    await harness.controller.handleMessage(message('/forget ' + memoryId));
    expect((await harness.controller.handleMessage(message('/memory Alpha'))).text).toBe('No matching memory.');
    await harness.stop(taskId);
  });

  it('reports durable Dream status through the Feishu-only control surface', async () => {
    const harness = await createHarness(undefined, true);
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    expect((await harness.controller.handleMessage(message('/dream status'))).text).toBe('Nightly Dream is disabled.');
    harness.config.taskPlatformRollout.nightlyDream = true;
    expect((await harness.controller.handleMessage(message('/dream status'))).text).toContain('no jobs');
    const now = new Date().toISOString();
    harness.store.createDreamJob({
      id: `dream:task:${taskId}:2026-07-28`, scope: 'task', scopeId: taskId, businessDate: '2026-07-28',
      status: 'deferred', fromEventSequence: 2, watermarkSequence: 5, attemptCount: 1,
      lastErrorCode: 'admission_denied', createdAt: now, updatedAt: now,
    });
    expect((await harness.controller.handleMessage(message('/dream status'))).text)
      .toContain('2026-07-28 deferred attempts=1 watermark=5 reason=admission_denied');
    await harness.stop(taskId);
  });

  it('serves app-server memory tools from the authenticated active turn without accepting a caller task id', async () => {
    const harness = await createHarness(undefined, true, false, true);
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    const remembered = await harness.controller.handleMessage(message('/remember task Durable Alpha uses SQLite'));
    const memoryId = /memory_[\w-]+/.exec(remembered.text)![0];
    await harness.controller.handleMessage(message('Use memory tools when needed.'));
    await waitFor(() => Boolean(harness.store.getTask(taskId)?.activeTurnId));
    harness.backend.emit(taskId, {
      type: 'backend.server_request', taskId, generation: 1, requestId: 'memory_call_1', method: 'item/tool/call',
      params: {
        threadId: 'thread_1', turnId: 'codex_turn_1', callId: 'call_1', tool: 'memory_read',
        arguments: { memoryId, maxTokens: 200, taskId: 'task_forged' },
      },
    });
    await waitFor(() => harness.backend.responses.some((response) => response.requestId === 'memory_call_1'));
    const response = harness.backend.responses.find((candidate) => candidate.requestId === 'memory_call_1')!;
    expect(response.result).toMatchObject({ success: true, contentItems: [{ type: 'inputText' }] });
    expect(JSON.stringify(response.result)).toContain('Durable Alpha uses SQLite');
    expect(harness.store.listDreamJobs()).toEqual([]);
    await harness.stop(taskId);
  });

  it('accepts natural-language evidence notes for administrator bot memory without treating them as event keys', async () => {
    const harness = await createHarness(undefined, true, false, true);
    harness.config.taskPlatformRollout.botGlobalMemory = true;
    harness.config.upgrade.adminUsers = ['ou_owner'];
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    await harness.controller.handleMessage(message('Save the reusable reflux lesson.'));
    await waitFor(() => Boolean(harness.store.getTask(taskId)?.activeTurnId));
    harness.backend.emit(taskId, {
      type: 'backend.server_request', taskId, generation: 1, requestId: 'memory_propose_1', method: 'item/tool/call',
      params: {
        threadId: 'thread_1', turnId: 'codex_turn_1', callId: 'call_1', tool: 'memory_propose',
        arguments: {
          scope: 'bot', kind: 'lesson', title: 'Reflux semantics', description: 'Reusable merge guidance',
          content: 'Preserve target-branch semantics while carrying source history.', tags: ['git'],
          useWhen: 'Handling reflux conflicts.', doNotUseWhen: null,
          evidence: ['A prior reflux kept the develop dependency version.'],
        },
      },
    });
    await waitFor(() => harness.backend.responses.some((response) => response.requestId === 'memory_propose_1'));
    expect(harness.backend.responses.find((response) => response.requestId === 'memory_propose_1')?.result)
      .toMatchObject({ success: true });
    expect(harness.store.listMemoryEntries('bot', harness.config.feishu.appId)[0])
      .toMatchObject({ title: 'Reflux semantics', status: 'active' });
    expect(harness.store.listMemoryEntries('bot', harness.config.feishu.appId)[0]?.content)
      .toContain('Evidence notes');
    await harness.stop(taskId);
  });

  it('runs a Feishu-created task through approval and one durable final reply', async () => {
    const harness = await createHarness();
    const created = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(created.text)![0];

    await harness.controller.handleMessage(message('inspect repository'));
    await waitFor(() => Boolean(harness.store.listTurnsByTask(taskId)[0]?.codexTurnId));
    const localTurn = harness.store.listTurnsByTask(taskId)[0]!;
    harness.backend.emit(taskId, {
      type: 'backend.server_request', taskId, generation: 1, requestId: 7,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread_1', turnId: 'codex_turn_1', command: 'npm test' },
    });
    await waitFor(() => harness.rendered.length === 1);
    expect(harness.store.getTurn(localTurn.id)).toMatchObject({ state: 'waiting_approval', codexTurnId: 'codex_turn_1' });
    expect(harness.store.getTask(taskId)?.activeTurnId).toBe(localTurn.id);

    const request = harness.rendered[0]!;
    await expect(harness.controller.handleCardAction(card({
      kind: 'app_server_request_decision', requestId: request.id, generation: 1, decision: 'allow',
    }, 'ou_other'))).rejects.toThrow('identity_mismatch');
    await harness.controller.handleCardAction(card({
      kind: 'app_server_request_decision', requestId: request.id, generation: 1, decision: 'allow',
    }));
    expect(harness.backend.responses).toHaveLength(1);

    const completed: CodexBackendEvent = {
      type: 'turn.completed', taskId, threadId: 'thread_1', turnId: 'codex_turn_1', status: 'completed',
      turn: { id: 'codex_turn_1', status: 'completed', items: [] },
    };
    harness.backend.emit(taskId, completed);
    harness.backend.emit(taskId, completed);
    await waitFor(() => harness.outbox.pending().length === 1);
    expect(harness.store.getTurn(localTurn.id)?.state).toBe('completed');
    expect(await harness.outbox.flush()).toEqual({ sent: 1, failed: 0 });
    expect(harness.deliver).toHaveBeenCalledTimes(1);
    await harness.stop(taskId);
  });

  it('isolates private users and group topics while persisting bindings across restart', async () => {
    const harness = await createHarness();
    const group = message('/new repo', { chatType: 'group', chatId: 'oc_group', threadId: 'topic_1', wasMentioned: true });
    const reply = await harness.controller.handleMessage(group);
    const taskId = /task_[\w-]+/.exec(reply.text)![0];

    await expect(harness.controller.handleMessage(message('@bot /status', {
      chatType: 'group', chatId: 'oc_group', threadId: 'topic_2', wasMentioned: true,
    }))).rejects.toThrow('No task is selected');
    await expect(harness.controller.handleMessage(message(`/use ${taskId}`, { userId: 'ou_other' })))
      .rejects.toThrow('owner does not match');

    const restartedController = new FeishuTaskController(harness.service);
    await expect(restartedController.handleMessage(message('@bot /status', {
      chatType: 'group', chatId: 'oc_group', threadId: 'topic_1', wasMentioned: true,
    }))).resolves.toMatchObject({ text: expect.stringContaining(taskId) });
    await harness.stop(taskId);
  });

  it('requires an owner confirmation and makes delete callbacks idempotent', async () => {
    const harness = await createHarness();
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    const request = await harness.service.requestDelete(actor());

    await expect(harness.service.decideDelete({ ...actor('ou_other'), requestId: request.requestId, decision: 'confirm' }))
      .rejects.toThrow('owner does not match');
    await expect(harness.service.decideDelete({ ...actor(), requestId: request.requestId, decision: 'confirm' }))
      .resolves.toBe('Task deleted.');
    await expect(harness.service.decideDelete({ ...actor(), requestId: request.requestId, decision: 'confirm' }))
      .resolves.toBe('Delete request already completed.');
    expect(harness.provisioner.delete).toHaveBeenCalledTimes(1);
    expect(harness.store.getTask(taskId)?.runtimeState).toBe('archived');
    harness.store.close();
  });

  it('durably migrates a loaded repository to a later user-selected baseline', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: ['oc_group'], knowledgeApprovers: [] };
    await harness.controller.handleMessage(message('/new repo', {
      chatType: 'group', chatId: 'oc_group', threadId: 'topic_migrate', wasMentioned: true,
    }));
    const task = harness.store.listTasks()[0]!;
    const repository = harness.store.listTaskRepositories(task.id)[0]!;
    const migrateRepository = vi.fn(async () => ({ status: 'completed' as const, baseCommit: 'target_commit' }));
    harness.provisioner.migrateRepository = migrateRepository;

    await expect(harness.service.migrateRepository({
      chatType: 'group', chatId: 'oc_group', topicId: 'topic_migrate', userId: 'ou_owner',
      projectId: repository.projectId, targetBaseRef: 'release-2026.8.3',
    })).resolves.toContain('release-2026.8.3');

    expect(migrateRepository).toHaveBeenCalledOnce();
    expect(harness.store.getTaskRepository(repository.id)).toMatchObject({ baseRef: 'release-2026.8.3', baseCommit: 'target_commit' });
    expect(harness.store.listRepositoryMigrations(task.id)).toEqual([
      expect.objectContaining({ state: 'completed', targetBaseRef: 'release-2026.8.3', targetBaseCommit: 'target_commit' }),
    ]);
    harness.store.close();
  });

  it('requires explicit confirmation before adopting a resolved migration conflict', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: ['oc_group'], knowledgeApprovers: [] };
    await harness.controller.handleMessage(message('/new repo', {
      chatType: 'group', chatId: 'oc_group', threadId: 'topic_migrate_conflict', wasMentioned: true,
    }));
    const task = harness.store.listTasks()[0]!;
    const repository = harness.store.listTaskRepositories(task.id)[0]!;
    const targetBaseCommit = 'a'.repeat(40);
    harness.provisioner.migrateRepository = vi.fn(async (_task, _project, current, _target, migrationId) => ({
      status: 'conflict' as const, baseCommit: targetBaseCommit,
      conflictPath: `${current.checkoutPath}.migration-${migrationId.slice(-20)}`,
    }));
    harness.provisioner.finalizeRepositoryMigration = vi.fn(async () => ({ baseCommit: targetBaseCommit }));

    await expect(harness.service.migrateRepository({
      chatType: 'group', chatId: 'oc_group', topicId: 'topic_migrate_conflict', userId: 'ou_owner',
      projectId: repository.projectId, targetBaseRef: 'release-2026.9.2',
    })).resolves.toContain('conflicts at');

    const migration = harness.store.listRepositoryMigrations(task.id)[0]!;
    expect(migration).toMatchObject({ state: 'conflict_waiting', targetBaseCommit });
    expect(harness.store.getTaskRepository(repository.id)).toMatchObject({ baseRef: repository.baseRef });
    expect(harness.outbox.getByDedupeKey(`${migration.id}:confirmation-card`)?.payload).toMatchObject({
      kind: 'repository_migration_confirmation', migration: { id: migration.id, state: 'conflict_waiting' },
    });

    await expect(harness.controller.handleCardAction({
      chatType: 'group', chatId: 'oc_group', threadId: 'topic_migrate_conflict', userId: 'ou_owner',
      action: { kind: 'repository_migration_decision', migrationId: migration.id, decision: 'confirm' },
    })).resolves.toMatchObject({ text: expect.stringContaining('Confirmed migration') });
    expect(harness.provisioner.finalizeRepositoryMigration).toHaveBeenCalledOnce();
    expect(harness.store.getTaskRepository(repository.id)).toMatchObject({
      baseRef: 'release-2026.9.2', baseCommit: targetBaseCommit,
    });
    expect(harness.store.getRepositoryMigration(migration.id)?.state).toBe('completed');
    harness.store.close();
  });

  it('discards a conflicted migration without changing the original repository', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: ['oc_group'], knowledgeApprovers: [] };
    await harness.controller.handleMessage(message('/new repo', {
      chatType: 'group', chatId: 'oc_group', threadId: 'topic_migrate_reject', wasMentioned: true,
    }));
    const task = harness.store.listTasks()[0]!;
    const repository = harness.store.listTaskRepositories(task.id)[0]!;
    harness.provisioner.migrateRepository = vi.fn(async (_task, _project, current, _target, migrationId) => ({
      status: 'conflict' as const, baseCommit: 'b'.repeat(40),
      conflictPath: `${current.checkoutPath}.migration-${migrationId.slice(-20)}`,
    }));
    harness.provisioner.discardRepositoryMigration = vi.fn(async () => undefined);
    await harness.service.migrateRepository({
      chatType: 'group', chatId: 'oc_group', topicId: 'topic_migrate_reject', userId: 'ou_owner',
      projectId: repository.projectId, targetBaseRef: 'release-2026.9.2',
    });
    const migration = harness.store.listRepositoryMigrations(task.id)[0]!;

    await harness.controller.handleCardAction({
      chatType: 'group', chatId: 'oc_group', threadId: 'topic_migrate_reject', userId: 'ou_owner',
      action: { kind: 'repository_migration_decision', migrationId: migration.id, decision: 'reject' },
    });
    expect(harness.provisioner.discardRepositoryMigration).toHaveBeenCalledOnce();
    expect(harness.store.getTaskRepository(repository.id)?.baseRef).toBe(repository.baseRef);
    expect(harness.store.getTaskRepository(repository.id)?.baseCommit).toBe(repository.baseCommit);
    expect(harness.store.getRepositoryMigration(migration.id)?.state).toBe('rolled_back');
    harness.store.close();
  });

  it('deletes and archives a topic task when the topic is closed', async () => {
    const harness = await createHarness(undefined, true);
    const topic = {
      chatType: 'group', chatId: 'oc_group', threadId: 'topic_1', rootId: 'om_root', wasMentioned: true,
    };
    await harness.controller.handleMessage(message('@bot /new repo', topic));
    const task = harness.store.listTasks()[0]!;
    harness.store.applyAmbientTopicMessage({
      chatId: 'oc_group', topicId: 'topic_1', userId: 'ou_owner', messageId: 'om_floor',
      createdAt: '1000', wasMentioned: true,
    });

    await harness.controller.handleTopicClosed({
      chatId: 'oc_group', topicId: 'topic_1', operatorUserId: 'ou_operator',
    });
    await harness.controller.handleTopicClosed({
      chatId: 'oc_group', topicId: 'topic_1', operatorUserId: 'ou_operator',
    });

    expect(harness.provisioner.delete).toHaveBeenCalledOnce();
    expect(harness.store.getTask(task.id)?.runtimeState).toBe('archived');
    expect(harness.store.getTask(task.id)?.archiveReason).toBe('explicit');
    expect(harness.store.getAmbientTopicState('oc_group', 'topic_1')).toBeUndefined();
    harness.store.close();
  });

  it('reconnects a running container and interrupts a non-authoritative turn on manager restart', async () => {
    const harness = await createHarness();
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    await harness.controller.handleMessage(message('long-running work'));
    await waitFor(() => harness.store.listTurnsByTask(taskId)[0]?.state === 'running');
    await harness.backend.stopTask(taskId);
    await harness.service.waitForEvents(taskId);
    const now = new Date().toISOString();
    harness.store.beginLifecycleIntent({
      id: 'pending_stop', taskId, fromState: 'hot', toState: 'warming', status: 'pending', createdAt: now, updatedAt: now,
    });

    await expect(harness.service.recoverStartup()).resolves.toMatchObject({
      recoveredHotTaskIds: [taskId], warmedTaskIds: [], failedTaskIds: [], completedTurnIds: [],
      interruptedTurnIds: [expect.stringMatching(/^turn_/)],
    });
    expect(harness.store.getTask(taskId)).toMatchObject({ runtimeState: 'hot', pinned: false, connectionGeneration: 1 });
    expect(harness.store.listTurnsByTask(taskId)[0]?.state).toBe('interrupted');
    expect(harness.backend.resumeInputs).toHaveLength(1);
    expect(harness.store.listPendingLifecycleIntents()).toEqual([]);
    await harness.stop(taskId);
  });

  it('recovers a user-sandbox task using its isolated cwd', async () => {
    const harness = await createHarness();
    const taskId = 'task_sandbox_recovery';
    const now = new Date().toISOString();
    harness.store.saveTask({
      id: taskId, ownerUserId: 'ou_owner', runtimeMode: 'user-sandbox', projectId: 'repo',
      baseRef: 'main', branchName: 'task/sandbox-recovery', runtimeState: 'hot',
      codexThreadId: 'thread_sandbox', pinned: false, lastUserInteractionAt: now,
      createdAt: now, updatedAt: now,
    });
    vi.mocked(harness.provisioner.resume).mockResolvedValueOnce({
      cwd: `/workspace/tasks/${taskId}`, branchName: 'main', runtimeId: 'sandbox_1',
    });

    await expect(harness.service.recoverStartup()).resolves.toMatchObject({ recoveredHotTaskIds: [taskId] });
    expect(harness.backend.resumeInputs[0]?.cwd).toBe(`/workspace/tasks/${taskId}`);
    await harness.backend.stopTask(taskId);
    harness.store.close();
  });

  it('keeps a stopped container warm and interrupts ambiguous work after host restart', async () => {
    const harness = await createHarness();
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    await harness.controller.handleMessage(message('work during power loss'));
    await waitFor(() => harness.store.listTurnsByTask(taskId)[0]?.state === 'running');
    await harness.backend.stopTask(taskId);
    await harness.service.waitForEvents(taskId);
    vi.mocked(harness.provisioner.observeTaskState!).mockResolvedValueOnce('warm');

    await expect(harness.service.recoverStartup()).resolves.toMatchObject({
      recoveredHotTaskIds: [], warmedTaskIds: [taskId], interruptedTurnIds: [expect.stringMatching(/^turn_/)],
    });
    expect(harness.store.getTask(taskId)?.runtimeState).toBe('warm');
    expect(harness.store.listTurnsByTask(taskId)[0]?.state).toBe('interrupted');
    await harness.backend.stopTask(taskId);
    await harness.service.waitForEvents(taskId);
    harness.store.close();
  });

  it('notifies the bound conversation when an active runtime disconnects', async () => {
    const harness = await createHarness();
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    await harness.controller.handleMessage(message('long-running work'));
    await waitFor(() => harness.store.getTask(taskId)?.activeTurnId !== undefined);

    harness.backend.emit(taskId, {
      type: 'backend.disconnected', taskId, generation: 1,
      reason: 'Codex App Server exited (code=0, signal=none)',
    });

    await waitFor(() => harness.store.getTask(taskId)?.runtimeState === 'failed');
    expect(harness.store.listTurnsByTask(taskId).at(-1)?.state).toBe('interrupted');
    expect(harness.outbox.pending()).toEqual([
      expect.objectContaining({
        eventType: 'card',
        payload: expect.objectContaining({
          kind: 'task_turn_final', status: 'interrupted',
          text: expect.stringContaining('不会继续静默等待'),
        }),
      }),
    ]);
    harness.store.close();
  });

  it('recovers an authoritative remote completion once without resubmitting the turn', async () => {
    const harness = await createHarness();
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    await harness.controller.handleMessage(message('finish before manager restart'));
    await waitFor(() => harness.store.listTurnsByTask(taskId)[0]?.codexTurnId === 'codex_turn_1');
    await harness.backend.stopTask(taskId);
    await harness.service.waitForEvents(taskId);
    harness.backend.threadTurns = [{
      id: 'codex_turn_1', status: 'completed', items: [{ type: 'agentMessage', text: 'Recovered answer.' }],
    }];

    await expect(harness.service.recoverStartup()).resolves.toMatchObject({ completedTurnIds: [expect.stringMatching(/^turn_/)] });
    expect(harness.store.listTurnsByTask(taskId)[0]?.state).toBe('completed');
    expect(harness.outbox.pending()).toHaveLength(1);
    expect(harness.backend.startedTurns).toHaveLength(1);

    await harness.backend.stopTask(taskId);
    await harness.service.waitForEvents(taskId);
    await harness.service.recoverStartup();
    expect(harness.outbox.pending()).toHaveLength(1);
    expect(harness.backend.startedTurns).toHaveLength(1);
    await harness.stop(taskId);
  });

  it('reconciles a silent running turn from the authoritative failed state', async () => {
    const harness = await createHarness();
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    await harness.controller.handleMessage(message('update private Go dependencies'));
    await waitFor(() => harness.store.listTurnsByTask(taskId)[0]?.state === 'running');
    harness.backend.threadTurns = [{
      id: 'codex_turn_1', status: 'failed',
      error: { message: "fatal: could not read Username for 'https://github.com': terminal prompts disabled" },
    }];

    await expect(harness.service.reconcileStalledTurns(0)).resolves.toHaveLength(1);

    expect(harness.store.listTurnsByTask(taskId)[0]).toMatchObject({
      state: 'failed', failure: expect.stringContaining('credential_missing'),
    });
    expect(harness.store.getTask(taskId)?.activeTurnId).toBeUndefined();
    expect(harness.outbox.pending()).toEqual([expect.objectContaining({
      payload: expect.objectContaining({ status: 'failed', text: expect.stringContaining('credential_missing') }),
    })]);
    await harness.stop(taskId);
  });

  it('soft-probes a recently quiet turn and closes an authoritative completion without waiting for the stall deadline', async () => {
    const harness = await createHarness();
    const interrupt = vi.spyOn(harness.backend, 'interruptTurn');
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    await harness.controller.handleMessage(message('finish but lose the completion notification'));
    await waitFor(() => harness.store.listTurnsByTask(taskId)[0]?.state === 'running');
    harness.backend.threadTurns = [{
      id: 'codex_turn_1', status: 'completed', items: [{ type: 'agentMessage', text: 'Completed remotely.' }],
    }];
    harness.backend.useObservedTurnProbe = true;

    await expect(harness.service.reconcileStalledTurns(15 * 60_000, 0)).resolves.toHaveLength(1);

    expect(harness.store.listTurnsByTask(taskId)[0]?.state).toBe('completed');
    expect(harness.store.getTask(taskId)?.activeTurnId).toBeUndefined();
    expect(interrupt).not.toHaveBeenCalled();
    expect(harness.outbox.pending()).toHaveLength(1);
    expect(harness.backend.readThreadCalls).toBe(0);
    await harness.stop(taskId);
  });

  it('soft-probes a nonterminal turn without interrupting it before the hard stall deadline', async () => {
    const harness = await createHarness();
    const interrupt = vi.spyOn(harness.backend, 'interruptTurn');
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    await harness.controller.handleMessage(message('continue legitimate long-running work'));
    await waitFor(() => harness.store.listTurnsByTask(taskId)[0]?.state === 'running');
    harness.backend.threadTurns = [{ id: 'codex_turn_1', status: 'inProgress' }];

    await expect(harness.service.reconcileStalledTurns(15 * 60_000, 0)).resolves.toEqual([]);

    expect(harness.store.listTurnsByTask(taskId)[0]?.state).toBe('running');
    expect(harness.store.getTask(taskId)?.activeTurnId).toBe(harness.store.listTurnsByTask(taskId)[0]?.id);
    expect(interrupt).not.toHaveBeenCalled();
    await harness.stop(taskId);
  });

  it('persists the turn id returned by App Server before any started notification arrives', async () => {
    const harness = await createHarness();
    harness.backend.startTurnResultId = 'codex_response_turn';
    harness.backend.emitTurnStarted = false;
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];

    await harness.controller.handleMessage(message('analyze without notifications'));

    expect(harness.store.listTurnsByTask(taskId)[0]).toMatchObject({
      state: 'submitted', codexTurnId: 'codex_response_turn',
    });
    await harness.stop(taskId);
  });

  it('completes a submitted turn by polling its response id when notifications are missing', async () => {
    const harness = await createHarness();
    harness.backend.startTurnResultId = 'codex_response_turn';
    harness.backend.emitTurnStarted = false;
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    await harness.controller.handleMessage(message('analyze without notifications'));
    harness.backend.threadTurns = [{ id: 'codex_response_turn', status: 'completed', items: [] }];

    await expect(harness.service.reconcileSubmittedTurns(0)).resolves.toHaveLength(1);

    expect(harness.store.listTurnsByTask(taskId)[0]?.state).toBe('completed');
    expect(harness.provisioner.stop).not.toHaveBeenCalled();
    await harness.stop(taskId);
  });

  it('rebuilds the task runtime generation before retrying an unconfirmed submission', async () => {
    const harness = await createHarness();
    harness.backend.startTurnResultId = 'missing_remote_turn';
    harness.backend.emitTurnStarted = false;
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    await harness.controller.handleMessage(message('analyze without notifications'));

    await expect(harness.service.reconcileSubmittedTurns(0)).resolves.toHaveLength(1);

    const turns = harness.store.listTurnsByTask(taskId);
    expect(turns[0]).toMatchObject({ state: 'interrupted', failure: expect.stringContaining('unconfirmed') });
    expect(turns[1]).toMatchObject({ state: 'submitted', retryCount: 1, retryOfTurnId: turns[0]!.id });
    expect(harness.provisioner.stop).toHaveBeenCalledOnce();
    expect(harness.provisioner.resume).toHaveBeenCalledOnce();
    expect(harness.backend.resumeInputs).toHaveLength(1);
    expect(harness.store.getTask(taskId)).toMatchObject({ runtimeState: 'hot', connectionGeneration: 1 });
    await harness.stop(taskId);
  });

  it('interrupts and automatically resumes a silent turn on the same task', async () => {
    const harness = await createHarness();
    const refreshGitIdentity = vi.fn(async () => undefined);
    harness.provisioner.refreshGitIdentity = refreshGitIdentity;
    const interrupt = vi.spyOn(harness.backend, 'interruptTurn');
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    await harness.controller.handleMessage(message('long-running work'));
    await waitFor(() => harness.store.listTurnsByTask(taskId)[0]?.state === 'running');
    harness.backend.threadTurns = [{ id: 'codex_turn_1', status: 'inProgress' }];
    refreshGitIdentity.mockClear();

    await expect(harness.service.reconcileStalledTurns(0)).resolves.toHaveLength(1);

    expect(interrupt).toHaveBeenCalledWith({ taskId });
    expect(harness.store.listTurnsByTask(taskId)[0]).toMatchObject({
      state: 'interrupted', failure: expect.stringContaining('app_server_stalled'),
    });
    expect(harness.store.listTurnsByTask(taskId)[1]).toMatchObject({
      state: 'running', retryCount: 1, retryOfTurnId: harness.store.listTurnsByTask(taskId)[0]!.id,
    });
    expect(harness.store.getTask(taskId)?.activeTurnId).toBe(harness.store.listTurnsByTask(taskId)[1]!.id);
    expect(harness.backend.startedTurns.at(-1)?.prompt).toContain('自动恢复尝试 1/3');
    expect(refreshGitIdentity).toHaveBeenCalledOnce();
    expect(harness.outbox.pending()).toEqual([]);
    await harness.stop(taskId);
  });

  it('retries a stalled user-sandbox turn without legacy Git identity refresh', async () => {
    const harness = await createHarness(undefined, true);
    harness.config.userSandboxes = {
      enabled: true, enabledOwners: ['ou_owner'], legacyFallbackEnabled: false,
      maxAppServersPerUser: 8, maxActiveTurnsPerUser: 4,
      processIdleTimeoutMinutes: 120, containerIdleTimeoutMinutes: 1_440,
      containerWrapperRetentionHours: 24,
    };
    harness.config.taskPlatformRollout.enabled = true;
    harness.config.taskPlatformRollout.enabledOwners = ['ou_owner'];
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    expect(harness.store.getTask(taskId)?.runtimeMode).toBe('user-sandbox');
    const refreshGitIdentity = vi.fn(async () => {
      throw new Error('Operation refreshGitIdentity is not available on transparent user-sandbox tasks.');
    });
    harness.provisioner.refreshGitIdentity = refreshGitIdentity;
    await harness.controller.handleMessage(message('long-running sandbox work'));
    await waitFor(() => harness.store.listTurnsByTask(taskId)[0]?.state === 'running');
    harness.backend.threadTurns = [{ id: 'codex_turn_1', status: 'inProgress' }];

    await expect(harness.service.reconcileStalledTurns(0)).resolves.toHaveLength(1);

    const turns = harness.store.listTurnsByTask(taskId);
    expect(refreshGitIdentity).not.toHaveBeenCalled();
    expect(turns[1]).toMatchObject({ state: 'running', retryCount: 1, retryOfTurnId: turns[0]!.id });
    expect(harness.backend.startedTurns.at(-1)?.prompt).toContain('自动恢复尝试 1/3');
    await harness.stop(taskId);
  });

  it('reconnects a stalled unbound chat without passing a configured project', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.userSandboxes = { enabled: true, enabledOwners: ['ou_owner'],
      legacyFallbackEnabled: false, maxAppServersPerUser: 8, maxActiveTurnsPerUser: 4,
      processIdleTimeoutMinutes: 120, containerIdleTimeoutMinutes: 1_440, containerWrapperRetentionHours: 24 };
    const actor = { chatId: 'oc_group', chatType: 'group' as const, topicId: 'topic_chat_retry', userId: 'ou_owner' };
    const created = await harness.service.createTask({ ...actor, mode: 'chat' });
    await harness.service.send({ ...actor, text: 'long chat work', messageId: 'om_chat_retry' });
    await waitFor(() => harness.store.listTurnsByTask(created.taskId)[0]?.state === 'running');
    const resume = vi.spyOn(harness.provisioner, 'resume');
    harness.backend.threadTurns = [{ id: 'codex_turn_1', status: 'inProgress' }];
    await harness.service.reconcileStalledTurns(0);
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ mode: 'chat' }), undefined, undefined);
    expect(harness.store.listTurnsByTask(created.taskId)[1]).toMatchObject({ state: 'running', retryCount: 1 });
    expect(harness.store.getTask(created.taskId)).not.toHaveProperty('projectId');
    await harness.stop(created.taskId);
  });

  it('preserves repeated identical deltas and targets a group topic final reply', async () => {
    const harness = await createHarness();
    const group = message('/new repo', {
      chatType: 'group', chatId: 'oc_group', threadId: 'topic_1', messageId: 'om_create', wasMentioned: true,
    });
    const reply = await harness.controller.handleMessage(group);
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    await harness.controller.handleMessage(message('@bot repeat', {
      chatType: 'group', chatId: 'oc_group', threadId: 'topic_1', messageId: 'om_prompt', wasMentioned: true,
    }));
    const delta = {
      type: 'item.delta' as const, taskId, threadId: 'thread_1', turnId: 'codex_turn_1', itemId: 'item_1',
      channel: 'agent_message' as const, delta: 'same',
    };
    harness.backend.emit(taskId, delta);
    harness.backend.emit(taskId, delta);
    harness.backend.emit(taskId, {
      type: 'turn.completed', taskId, threadId: 'thread_1', turnId: 'codex_turn_1', status: 'completed', turn: { items: [] },
    });
    await waitFor(() => harness.outbox.pending().length === 1);

    expect(harness.store.listTurnEvents(taskId).filter((event) => event.eventType === 'item.delta')).toHaveLength(2);
    expect(harness.outbox.pending()[0]?.target).toEqual({
      chatId: 'oc_group', chatType: 'group', topicId: 'topic_1',
      replyToMessageId: 'om_prompt', replyInThread: true, mentionUserId: 'ou_owner',
    });
    await harness.stop(taskId);
  });

  it('stops a provisioned runtime when app-server startup fails', async () => {
    const harness = await createHarness();
    harness.backend.startTaskError = new Error('app-server initialize failed');

    await expect(harness.controller.handleMessage(message('/new repo'))).rejects.toThrow('initialize failed');
    expect(harness.provisioner.stop).toHaveBeenCalledOnce();
    expect(harness.store.listTasks()[0]).toMatchObject({ runtimeState: 'warm' });
    harness.store.close();
  });

  it('retries projectless initialization on the next ordinary message when the first thread start failed', async () => {
    const harness = await createHarness(undefined, true, true);
    harness.config.taskPlatformRollout.projectlessWorkspaces = true;
    harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: [], knowledgeApprovers: [] };
    harness.backend.startTaskError = new Error('invalid dynamic tools');
    await expect(harness.controller.handleMessage(message('first attempt'))).rejects.toThrow('invalid dynamic tools');
    const task = harness.store.listTasks()[0]!;
    expect(task).toMatchObject({ runtimeState: 'warm' });
    expect(task.codexThreadId).toBeUndefined();

    harness.backend.startTaskError = undefined;
    await expect(harness.controller.handleMessage(message('retry this task'))).resolves.toEqual({ text: '' });

    expect(harness.provisioner.provision).toHaveBeenCalledTimes(2);
    expect(harness.backend.startedTurns).toEqual([
      expect.objectContaining({ taskId: task.id, prompt: 'retry this task' }),
    ]);
    await harness.stop(task.id);
  });

  it('persists a claimed READY runtime before resolving the app-server socket', async () => {
    const harness = await createHarness();
    vi.mocked(harness.provisioner.provision).mockImplementationOnce(async ({ taskId }) => ({
      cwd: '/workspace', branchName: `codex/ou_owner/${taskId}`, runtimeId: 'ready_1', startupType: 'ready',
    }));
    harness.backend.startTaskHook = (input) => {
      expect(harness.store.getTask(input.taskId)).toMatchObject({ runtimeId: 'ready_1' });
    };

    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    expect(harness.store.getTask(taskId)).toMatchObject({ runtimeId: 'ready_1', runtimeState: 'hot' });
    await harness.stop(taskId);
  });

  it('steers a concurrent prompt into the active turn instead of failing it', async () => {
    const harness = await createHarness();
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    let release!: () => void;
    harness.backend.startTurnGate = new Promise<void>((resolve) => { release = resolve; });

    const first = harness.controller.handleMessage(message('first'));
    await waitFor(() => harness.backend.startedTurns.length === 1);
    const second = harness.controller.handleMessage(message('second'));
    release();
    await first;
    await expect(second).resolves.toEqual({ text: '' });
    expect(harness.backend.startedTurns).toHaveLength(1);
    expect(harness.backend.steeredTurns).toEqual([{ taskId, prompt: 'second', expectedTurnId: 'codex_turn_1' }]);
    expect(harness.store.listTurnsByTask(taskId)).toHaveLength(1);
    expect(harness.store.listTurnEvents(taskId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'user.followup', payload: expect.objectContaining({ text: 'second' }) }),
    ]));
    await harness.stop(taskId);
  });

  it('retries an explicitly rejected steer while the App Server turn is starting', async () => {
    const harness = await createHarness();
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    let release!: () => void;
    harness.backend.startTurnGate = new Promise<void>((resolve) => { release = resolve; });
    harness.backend.steerTurnErrors.push(new AppServerResponseError('turn/steer', {
      code: -32600, message: 'turn is not running',
    }));

    const first = harness.controller.handleMessage(message('first'));
    await waitFor(() => harness.backend.startedTurns.length === 1);
    const second = harness.controller.handleMessage(message('second'));
    release();
    await first;
    await expect(second).resolves.toEqual({ text: '' });

    expect(harness.backend.steerTurnAttempts).toBe(2);
    expect(harness.backend.steeredTurns).toEqual([{ taskId, prompt: 'second', expectedTurnId: 'codex_turn_1' }]);
    expect(harness.store.listTurnEvents(taskId).filter((event) => event.eventType === 'user.followup')).toHaveLength(1);
    await harness.stop(taskId);
  });

  it('does not retry an ambiguous steer transport failure that may have been accepted', async () => {
    const harness = await createHarness();
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    await harness.controller.handleMessage(message('first'));
    harness.backend.steerTurnErrors.push(new Error('turn/steer response timed out'));

    await expect(harness.controller.handleMessage(message('second'))).rejects.toThrow('response timed out');
    expect(harness.backend.steerTurnAttempts).toBe(1);
    expect(harness.backend.steeredTurns).toEqual([]);
    await harness.stop(taskId);
  });

  it('ignores a redelivered Feishu message instead of steering it twice', async () => {
    const harness = await createHarness();
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];

    await harness.controller.handleMessage(message('first', { messageId: 'om_same' }));
    await expect(harness.controller.handleMessage(message('first', { messageId: 'om_same' })))
      .resolves.toEqual({ text: '' });

    expect(harness.backend.startedTurns).toHaveLength(1);
    expect(harness.backend.steeredTurns).toEqual([]);
    expect(harness.store.listTurnEvents(taskId).filter((event) => event.eventKey === 'user-message:om_same')).toHaveLength(1);
    await harness.stop(taskId);
  });

  it('clears the active turn reservation when app-server rejects turn/start', async () => {
    const harness = await createHarness();
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    harness.backend.startTurnError = new AppServerResponseError('turn/start', { code: -32603, message: 'turn/start unavailable' });

    await expect(harness.controller.handleMessage(message('first'))).rejects.toThrow('turn/start unavailable');
    expect(harness.store.getTask(taskId)?.activeTurnId).toBeUndefined();
    expect(harness.store.getTask(taskId)?.pinned).toBe(false);
    expect(harness.store.listTurnsByTask(taskId)[0]).toMatchObject({ state: 'failed' });
    await harness.stop(taskId);
  });

  it('resumes a failed task that still has a durable thread and runtime', async () => {
    const harness = await createHarness();
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    await harness.backend.stopTask(taskId);
    await harness.service.waitForEvents(taskId);
    harness.store.updateTask(taskId, (task) => ({ ...task, runtimeState: 'failed' }));

    await expect(harness.controller.handleMessage(message('/resume'))).resolves.toEqual({ text: 'Task resumed.' });
    expect(harness.store.getTask(taskId)?.runtimeState).toBe('hot');
    expect(harness.provisioner.resume).toHaveBeenCalledOnce();
    await harness.stop(taskId);
  });

  it('automatically resumes a warm task before submitting an ordinary message', async () => {
    const harness = await createHarness();
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    await harness.controller.handleMessage(message('/stop'));
    expect(harness.store.getTask(taskId)?.runtimeState).toBe('warm');

    await expect(harness.controller.handleMessage(message('continue after restart'))).resolves.toEqual({ text: '' });

    expect(harness.provisioner.resume).toHaveBeenCalledOnce();
    expect(harness.backend.resumeInputs).toHaveLength(1);
    expect(harness.backend.startedTurns).toHaveLength(1);
    expect(harness.backend.startedTurns[0]).toMatchObject({ taskId, prompt: 'continue after restart' });
    expect(harness.store.getTask(taskId)?.runtimeState).toBe('hot');
    expect(harness.store.listTurnsByTask(taskId)).toHaveLength(1);
    await harness.stop(taskId);
  });

  it('continues an expired user-sandbox task in its original topic and Codex thread', async () => {
    const harness = await createHarness(undefined, true);
    harness.config.userSandboxes = {
      enabled: true, enabledOwners: ['ou_owner'], legacyFallbackEnabled: false,
      maxAppServersPerUser: 8, maxActiveTurnsPerUser: 4,
      processIdleTimeoutMinutes: 120, containerIdleTimeoutMinutes: 1_440,
      containerWrapperRetentionHours: 24,
    };
    const topic = actor('ou_owner', { chatType: 'group', chatId: 'oc_group', topicId: 'omt_old' });
    const { taskId } = await harness.service.createTask({ ...topic, projectId: 'repo' });
    const originalThreadId = harness.store.getTask(taskId)?.codexThreadId;
    await harness.backend.stopTask(taskId);
    await harness.service.waitForEvents(taskId);
    harness.store.updateTask(taskId, (task) => ({ ...task, runtimeState: 'warm' }));
    const now = new Date().toISOString();
    harness.store.beginLifecycleIntent({
      id: 'disk_cleanup_expired_warm', taskId, fromState: 'warm', toState: 'archived',
      status: 'pending', createdAt: now, updatedAt: now,
    });
    harness.store.completeLifecycleIntent('disk_cleanup_expired_warm', 'archived');

    await expect(harness.service.send({ ...topic, messageId: 'om_continue', text: 'continue in this topic' }))
      .resolves.toBeUndefined();

    expect(harness.backend.resumeInputs.at(-1)).toMatchObject({ taskId, threadId: originalThreadId });
    expect(harness.backend.startedTurns.at(-1)).toMatchObject({ taskId, prompt: 'continue in this topic' });
    expect(harness.store.getTask(taskId)?.runtimeState).toBe('hot');
    expect(harness.store.listTasks()).toHaveLength(1);
    await harness.stop(taskId);
  });

  it('does not resume an explicitly archived task in its original topic', async () => {
    const harness = await createHarness(undefined, true);
    harness.config.userSandboxes = {
      enabled: true, enabledOwners: ['ou_owner'], legacyFallbackEnabled: false,
      maxAppServersPerUser: 8, maxActiveTurnsPerUser: 4,
      processIdleTimeoutMinutes: 120, containerIdleTimeoutMinutes: 1_440,
      containerWrapperRetentionHours: 24,
    };
    const topic = actor('ou_owner', { chatType: 'group', chatId: 'oc_group', topicId: 'omt_deleted' });
    const { taskId } = await harness.service.createTask({ ...topic, projectId: 'repo' });
    harness.store.updateTask(taskId, (task) => ({
      ...task, runtimeState: 'archived', archiveReason: 'explicit',
    }));

    await expect(harness.service.send({ ...topic, messageId: 'om_deleted', text: 'continue' }))
      .rejects.toThrow('Task is not hot');

    expect(harness.backend.resumeInputs).toHaveLength(0);
    await harness.stop(taskId);
  });

  it('keeps an expired topic closed when a close event arrives after disk cleanup', async () => {
    const harness = await createHarness(undefined, true);
    const topic = actor('ou_owner', { chatType: 'group', chatId: 'oc_group', topicId: 'omt_closed' });
    const { taskId } = await harness.service.createTask({ ...topic, projectId: 'repo' });
    harness.store.updateTask(taskId, (task) => ({
      ...task, runtimeState: 'archived', archiveReason: 'warm_retention_expired',
    }));

    await harness.service.closeTopic({ chatId: 'oc_group', topicId: 'omt_closed' });

    expect(harness.store.getTask(taskId)?.archiveReason).toBe('explicit');
    harness.store.close();
  });

  it.each(['topic', 'group'] as const)('continues a retention-archived legacy %s in a new personal sandbox task', async (scope) => {
    const context: ConversationContextProvider = { collect: vi.fn(async () => ({
      scope, chatId: 'oc_group', threadId: 'omt_legacy', truncated: false, fetchedAt: '',
      messages: [{ messageId: 'om_old', createdAt: '1000', messageType: 'text', text: 'previous topic decision' }],
    })) };
    const harness = await createHarness(undefined, true, false, false, context);
    harness.config.conversationContext.enabled = true;
    const topic = actor('ou_owner', { chatType: 'group', chatId: 'oc_group',
      ...(scope === 'topic' ? { topicId: 'omt_legacy' } : {}) });
    const now = new Date().toISOString();
    harness.store.saveTask({
      id: 'task_legacy', ownerUserId: 'ou_owner', projectId: 'repo', baseRef: 'main',
      branchName: 'legacy', runtimeState: 'warm', codexThreadId: 'old_thread', pinned: false,
      lastUserInteractionAt: now, createdAt: now, updatedAt: now,
    });
    harness.store.saveTaskScope({
      taskId: 'task_legacy', scope, scopeKey: scope === 'topic' ? 'topic:oc_group:omt_legacy' : 'group:oc_group',
      chatId: 'oc_group', ...(scope === 'topic' ? { topicId: 'omt_legacy' } : {}), status: 'canonical', createdAt: now, updatedAt: now,
    });
    const intent = { id: 'disk_cleanup_legacy', taskId: 'task_legacy', fromState: 'warm' as const,
      toState: 'archived' as const, status: 'pending' as const, createdAt: now, updatedAt: now };
    harness.store.beginLifecycleIntent(intent);
    harness.store.completeLifecycleIntent(intent.id, 'archived');
    harness.config.userSandboxes = {
      enabled: true, enabledOwners: ['ou_owner'], legacyFallbackEnabled: false,
      maxAppServersPerUser: 8, maxActiveTurnsPerUser: 4,
      processIdleTimeoutMinutes: 120, containerIdleTimeoutMinutes: 1_440,
      containerWrapperRetentionHours: 24,
    };

    await harness.service.send({ ...topic, text: 'continue in the original topic', messageId: 'om_retry' });

    const successor = harness.store.listTasks().find((task) => task.id !== 'task_legacy');
    expect(successor).toMatchObject({ projectId: 'repo', runtimeMode: 'user-sandbox', runtimeState: 'hot' });
    expect(harness.backend.startedTurns.at(-1)).toMatchObject({ taskId: successor?.id });
    expect(harness.backend.startedTurns.at(-1)?.prompt).toContain('previous topic decision');
    expect(harness.backend.startedTurns.at(-1)?.prompt).toContain('continue in the original topic');
    expect(harness.store.getTask('task_legacy')?.runtimeState).toBe('archived');
    await harness.stop(successor!.id);
  });

  it('starts a replacement thread when the durable thread can no longer be resumed', async () => {
    const harness = await createHarness();
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    await harness.controller.handleMessage(message('/stop'));
    harness.backend.resumeTaskError = new Error(
      'App-server frame buffer exceeded its configured limit (bufferedBytes=16842752, maxBufferedBytes=16777216, pendingMethods=thread/resume).',
    );

    await expect(harness.controller.handleMessage(message('continue with a replacement thread'))).resolves.toEqual({ text: '' });

    expect(harness.backend.resumeInputs).toHaveLength(1);
    expect(harness.provisioner.resume).toHaveBeenCalledTimes(2);
    expect(harness.provisioner.stop).toHaveBeenCalledTimes(2);
    expect(harness.store.getTask(taskId)).toMatchObject({ runtimeState: 'hot', codexThreadId: 'thread_2' });
    expect(harness.store.getActiveTaskContext(taskId)).toMatchObject({
      codexThreadId: 'thread_2', createdBy: 'system:thread-resume-fallback',
    });
    expect(harness.store.listTaskContexts(taskId)).toHaveLength(2);
    expect(harness.backend.archivedThreads).toEqual(['thread_1']);
    expect(harness.backend.startedTurns).toHaveLength(1);
    await harness.stop(taskId);
  });

  it('does not create or submit a turn when automatic resume fails', async () => {
    const harness = await createHarness();
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    await harness.controller.handleMessage(message('/stop'));
    vi.mocked(harness.provisioner.resume).mockRejectedValueOnce(new Error('container start failed'));

    await expect(harness.controller.handleMessage(message('do not lose this'))).rejects.toThrow('container start failed');

    expect(harness.backend.startedTurns).toHaveLength(0);
    expect(harness.store.listTurnsByTask(taskId)).toHaveLength(0);
    expect(harness.store.getTask(taskId)?.runtimeState).toBe('warm');
    await harness.stop(taskId);
  });

  it('applies an idle execution profile without reconnecting the App Server thread', async () => {
    const harness = await createHarness();
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];

    await expect(harness.controller.handleMessage(message('/model gpt-5.5 high fast'))).resolves.toEqual({
      text: 'Execution profile set to gpt-5.5 · high · Fast.',
    });
    expect(harness.store.getTask(taskId)).toMatchObject({ runtimeState: 'hot', model: 'gpt-5.5' });
    expect(harness.store.getTask(taskId)?.executionProfile?.configured).toMatchObject({
      model: 'gpt-5.5', reasoningEffort: 'high', serviceTier: 'fast',
    });
    expect(harness.backend.resumeInputs).toHaveLength(0);
    await harness.controller.handleMessage(message('use the new profile'));
    expect(harness.backend.startedTurns.at(-1)?.executionProfile).toMatchObject({
      model: 'gpt-5.5', reasoningEffort: 'high', serviceTier: 'fast',
    });
    await harness.stop(taskId);
  });

  it('uses the configured worker execution profile for a new container task', async () => {
    const harness = await createHarness();
    let startInput: StartTaskInput | undefined;
    harness.backend.startTaskHook = (input) => { startInput = input; };

    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];

    expect(startInput?.executionProfile).toMatchObject({
      model: 'gpt-6-luna', reasoningEffort: 'medium', serviceTier: 'default', source: 'worker-default',
    });
    expect(harness.store.getTask(taskId)?.executionProfile?.configured).toMatchObject({
      model: 'gpt-6-luna', source: 'worker-default',
    });
    await harness.stop(taskId);
  });

  it('stages a model selection before a conversation task exists and consumes it on creation', async () => {
    const harness = await createHarness(undefined, true);
    const topic = actor('ou_owner', { chatType: 'group', chatId: 'oc_group', topicId: 'omt_new' });
    let startInput: StartTaskInput | undefined;
    harness.backend.startTaskHook = (input) => { startInput = input; };

    await expect(harness.service.executionProfile(topic)).resolves.toMatchObject({
      model: 'gpt-6-luna', reasoningEffort: 'medium', serviceTier: 'default',
    });
    await expect(harness.service.model({
      ...topic, model: 'gpt-5.6-terra', reasoningEffort: 'high', serviceTier: 'fast',
    })).resolves.toContain('saved for the next task');
    expect(harness.store.getConversationExecutionProfile('personal-topic:ou_owner:oc_group:omt_new')).toMatchObject({
      status: 'pending', model: 'gpt-5.6-terra', reasoningEffort: 'high', serviceTier: 'fast',
    });

    const created = await harness.service.createTask({ ...topic, projectId: 'repo' });

    expect(startInput?.executionProfile).toMatchObject({
      model: 'gpt-5.6-terra', reasoningEffort: 'high', serviceTier: 'fast', source: 'task-temporary',
    });
    expect(harness.store.getConversationExecutionProfile('personal-topic:ou_owner:oc_group:omt_new')).toMatchObject({
      status: 'consumed', consumedTaskId: created.taskId,
    });
    await harness.stop(created.taskId);
  });

  it('retargets an uninitialized conversation task after project inference was corrected', async () => {
    const harness = await createHarness(undefined, true);
    const topic = actor('ou_owner', { chatType: 'group', chatId: 'oc_group', topicId: 'omt_retarget' });
    vi.mocked(harness.provisioner.provision).mockRejectedValueOnce(new Error('capacity unavailable'));

    await expect(harness.service.createTask({ ...topic, projectId: 'repo' })).rejects.toThrow('capacity unavailable');
    const failed = harness.store.listTasks()[0]!;
    expect(failed).toMatchObject({ projectId: 'repo', runtimeState: 'failed' });

    const retried = await harness.service.createTask({ ...topic, projectId: 'repo2' });

    expect(retried.taskId).toBe(failed.id);
    expect(harness.store.getTask(failed.id)).toMatchObject({ projectId: 'repo2', runtimeState: 'hot' });
    expect(harness.provisioner.provision).toHaveBeenLastCalledWith(expect.objectContaining({
      project: expect.objectContaining({ id: 'repo2' }),
    }));
    await harness.stop(failed.id);
  });

  it('reactivates an archived conversation task that never created a runtime or Codex thread', async () => {
    const harness = await createHarness(undefined, true);
    const topic = actor('ou_owner', { chatType: 'group', chatId: 'oc_group', topicId: 'omt_retry' });
    vi.mocked(harness.provisioner.provision).mockRejectedValueOnce(new Error('capacity unavailable'));

    await expect(harness.service.createTask({ ...topic, projectId: 'repo' })).rejects.toThrow('capacity unavailable');
    const failed = harness.store.listTasks()[0]!;
    harness.store.updateTask(failed.id, (task) => {
      const { runtimeId: _runtimeId, ...withoutRuntime } = task;
      return { ...withoutRuntime, runtimeState: 'archived' };
    });

    const retried = await harness.service.createTask({ ...topic, projectId: 'repo' });

    expect(retried.taskId).toBe(failed.id);
    expect(harness.store.getTask(failed.id)).toMatchObject({ projectId: 'repo', runtimeState: 'hot' });
    expect(harness.provisioner.provision).toHaveBeenLastCalledWith(expect.objectContaining({
      taskId: failed.id, project: expect.objectContaining({ id: 'repo' }),
    }));
    await harness.stop(failed.id);
  });

  it('queues an execution profile change while a turn is active', async () => {
    const harness = await createHarness();
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    await harness.controller.handleMessage(message('keep working'));

    await expect(harness.controller.handleMessage(message('/model gpt-5.6-terra low fast'))).resolves.toEqual({
      text: 'Execution profile queued for the next turn: gpt-5.6-terra · low · Fast.',
    });
    expect(harness.store.getTask(taskId)?.executionProfile?.pending).toMatchObject({
      model: 'gpt-5.6-terra', reasoningEffort: 'low', serviceTier: 'fast', applyFromNextTurn: true,
    });
    expect(harness.backend.resumeInputs).toHaveLength(0);
    harness.backend.emit(taskId, {
      type: 'turn.completed', taskId, threadId: 'thread_1', turnId: 'codex_turn_1',
      status: 'completed', turn: { items: [] },
    });
    await waitFor(() => harness.store.listTurnsByTask(taskId).every((turn) => turn.state === 'completed'));
    await harness.controller.handleMessage(message('next turn'));
    expect(harness.backend.startedTurns.at(-1)?.executionProfile).toMatchObject({
      model: 'gpt-5.6-terra', reasoningEffort: 'low', serviceTier: 'fast',
    });
    expect(harness.store.getTask(taskId)?.executionProfile?.pending).toBeUndefined();
    await harness.stop(taskId);
  });

  it('preserves an explicit user pin across publish confirmation', async () => {
    const harness = await createHarness((store) => ({
      request: vi.fn(async (task) => {
        store.db.prepare(`
          INSERT INTO publish_requests(id, task_id, owner_user_id, status, idempotency_key, payload, created_at, updated_at)
          VALUES ('pub_1', ?, ?, 'pending', 'key_1', '{}', ?, ?)
        `).run(task.id, task.ownerUserId, task.createdAt, task.updatedAt);
        return { requestId: 'pub_1' };
      }),
      decide: vi.fn(async () => {
        store.db.prepare("UPDATE publish_requests SET status='published' WHERE id='pub_1'").run();
        return 'Published.';
      }),
    }));
    const reply = await harness.controller.handleMessage(message('/new repo'));
    const taskId = /task_[\w-]+/.exec(reply.text)![0];
    await harness.controller.handleMessage(message('/pin'));
    await harness.controller.handleMessage(message('/publish'));
    expect(harness.store.getTask(taskId)?.pinned).toBe(true);
    await harness.controller.handleCardAction(card({ kind: 'task_publish_decision', requestId: 'pub_1', decision: 'confirm' }));
    expect(harness.store.getTask(taskId)?.pinned).toBe(true);
    await harness.stop(taskId);
  });

  it('atomically claims concurrent delete confirmations', async () => {
    const harness = await createHarness();
    await harness.controller.handleMessage(message('/new repo'));
    const request = await harness.service.requestDelete(actor());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    harness.provisioner.delete.mockImplementationOnce(async () => gate);

    const first = harness.service.decideDelete({ ...actor(), requestId: request.requestId, decision: 'confirm' });
    await vi.waitFor(() => expect(harness.provisioner.delete).toHaveBeenCalledOnce());
    await expect(harness.service.decideDelete({ ...actor(), requestId: request.requestId, decision: 'confirm' }))
      .resolves.toBe('Delete request already executing.');
    release();
    await expect(first).resolves.toBe('Task deleted.');
    expect(harness.provisioner.delete).toHaveBeenCalledTimes(1);
    harness.store.close();
  });
});

describe('project switching commands and semantic tools',()=>{
  it('allows a natural-language cancellation message through while waiting for another project task',async()=>{
    const {h,scope,taskId}=await fixture();let otherId:string|undefined;
    try{
      const otherScope={...scope,topicId:'target-busy'};
      otherId=(await h.service.createTask({...otherScope,projectId:'repo2'})).taskId;
      await h.service.send({...otherScope,text:'busy',messageId:'target-busy'});
      await h.service.switchProject({...scope,project:'repo2',messageId:'request-switch'});
      await h.controller.handleMessage(message('取消切换',{chatId:scope.chatId,chatType:'group',threadId:scope.topicId,messageId:'cancel-natural',wasMentioned:true}));
      const task=h.store.getTask(taskId)!;
      h.backend.emit(taskId,{type:'backend.server_request',taskId,generation:task.connectionGeneration!,requestId:'cancel-tool',method:'item/tool/call',
        params:{threadId:task.codexThreadId,tool:'project_switch_cancel',arguments:{requestText:'取消切换'}}});
      await waitFor(()=>h.store.getTask(taskId)!.lastProjectSwitch?.status==='cancelled');
      expect(h.store.getTask(taskId)!.projectId).toBe('repo');
    }finally{if(otherId){await h.backend.stopTask(otherId);await h.service.waitForEvents(otherId);}await h.stop(taskId);}
  });
  it('waits for another task using the target project and resumes when that task finishes',async()=>{
    const {h,scope,taskId}=await fixture();let otherId:string|undefined;
    try{
      const otherScope={...scope,topicId:'other-project-topic'};
      otherId=(await h.service.createTask({...otherScope,projectId:'repo2'})).taskId;
      await h.service.send({...otherScope,text:'work on target',messageId:'target-work'});
      const other=h.store.getTask(otherId)!;
      expect(await h.service.switchProject({...scope,project:'repo2',messageId:'wait-target'})).toContain('运行任务结束');
      expect(h.provisioner.prepareProjectBinding).not.toHaveBeenCalled();
      h.backend.emit(otherId,{type:'turn.completed',taskId:otherId,threadId:other.codexThreadId!,turnId:'codex_turn_1',status:'completed',turn:{items:[]}});
      await waitFor(()=>h.store.getTask(taskId)!.projectId==='repo2');
    }finally{if(otherId){await h.backend.stopTask(otherId);await h.service.waitForEvents(otherId);}await h.stop(taskId);}
  });
  it('recovers a prepared target after restart and does not apply the same operation twice',async()=>{
    const {h,scope,taskId}=await fixture();
    try{
      await h.service.send({...scope,text:'work',messageId:'work'});
      let task=h.store.getTask(taskId)!;
      await h.service.switchProject({...scope,project:'repo2',messageId:'queued-recovery'});
      h.store.updateTurn(task.activeTurnId!,turn=>({...turn,state:'completed'}));
      h.store.updateTask(taskId,current=>({...current,activeTurnId:undefined,pendingProjectBind:{...current.pendingProjectBind!,status:'thread_opened',openedThreadId:'prepared_target'}}));
      await h.backend.stopTask(taskId);await h.service.waitForEvents(taskId);
      vi.spyOn(h.backend,'resumeTask').mockImplementation(async input=>({...await h.backend.startTask(input),threadId:input.threadId}));
      await h.service.recoverStartup();
      task=h.store.getTask(taskId)!;
      expect(task).toMatchObject({projectId:'repo2',codexThreadId:'prepared_target'});
      expect(task.pendingProjectBind).toBeUndefined();
      const count=h.provisioner.prepareProjectBinding!.mock.calls.length;
      await h.backend.stopTask(taskId);await h.service.waitForEvents(taskId);
      await h.service.recoverStartup();expect(h.provisioner.prepareProjectBinding).toHaveBeenCalledTimes(count);
    }finally{await h.stop(taskId);}
  });
  it('upgrades old project contexts before natural-language routing without changing the project',async()=>{
    const {h,scope,taskId}=await fixture();
    try{
      const old=h.store.getActiveTaskContext(taskId)!;
      h.store.saveTaskContext({...old,projectBindingToolRevision:1});
      await h.service.send({...scope,text:'比较两个项目，不要切换',messageId:'upgrade'});
      expect(h.store.getTask(taskId)!.projectId).toBe('repo');
      expect(h.store.getActiveTaskContext(taskId)!.projectBindingToolRevision).toBe(5);
      expect(h.store.getTaskContext(old.id)?.state).toBe('archived');
      expect(h.backend.startedTurns.at(-1)?.prompt).toContain('project_switch_catalog');
    }finally{await h.stop(taskId);}
  });
  it('opens a replacement context only after target preparation and restores binding on thread-start failure',async()=>{
    const {h,scope,taskId}=await fixture();
    try{
      const old=h.store.getTask(taskId)!;
      const start=vi.spyOn(h.backend,'startTask').mockRejectedValueOnce(new Error('new thread rejected'));
      await expect(h.service.switchProject({...scope,project:'repo2',messageId:'start-fail'})).rejects.toThrow('new thread rejected');
      expect(h.store.getTask(taskId)!.projectId).toBe(old.projectId);
      expect(h.store.getTask(taskId)!.lastProjectSwitch?.status).toBe('failed');
      start.mockRestore();
      await h.service.switchProject({...scope,project:'repo2',messageId:'start-retry'});
      expect(h.store.getTask(taskId)!.projectId).toBe('repo2');
    }finally{await h.stop(taskId);}
  });
  it('rolls back all local start writes when admission binding fails', async () => {
    const { h, scope, taskId } = await fixture();
    try {
      h.store.claimInboundMessage({ ...scope, text: 'work', messageId: 'conflict' });
      h.store.bindInboundAdmission({ externalMessageId: 'conflict', taskId, turnId: 'previous', action: 'start' });
      await expect(h.service.send({ ...scope, text: 'work', messageId: 'conflict' })).rejects.toThrow('immutable');
      expect(h.store.listTurnsByTask(taskId)).toHaveLength(0);
      expect(h.store.getTask(taskId)?.activeTurnId).toBeUndefined();
      expect(h.store.listTurnEvents(taskId).filter(event => event.eventType === 'user.message')).toHaveLength(0);
      expect(h.backend.startedTurns).toHaveLength(0);
    } finally { await h.stop(taskId); }
  });

  it('reconciles an orphan queued turn before accepting a new message', async () => {
    const { h, scope, taskId } = await fixture();
    try {
      const now = new Date().toISOString();
      h.store.saveTurn({ id: 'orphan', taskId, state: 'queued', submissionPhase: 'prepared', prompt: 'old', createdBy: scope.userId, createdAt: now, updatedAt: now });
      await h.service.send({ ...scope, text: '汇报一下当前状态', messageId: 'after-orphan' });
      expect(h.store.getTurn('orphan')?.state).toBe('failed');
      expect(h.backend.steeredTurns).toHaveLength(0);
      expect(h.backend.startedTurns).toHaveLength(1);
    } finally { await h.stop(taskId); }
  });

  async function runContinuation(h: Awaited<ReturnType<typeof createHarness>>, taskId: string) {
    return (h.service as unknown as { resumePendingProjectBind(taskId: string): Promise<void> }).resumePendingProjectBind(taskId);
  }

  it('retries a continuation that failed before submission without rebinding ingress', async () => {
    const { h, scope, taskId } = await fixture();
    try {
      const actor = { ...scope, messageId: 'source' };
      h.store.claimInboundMessage({ ...actor, text: 'continue' });
      h.store.bindInboundAdmission({ externalMessageId: 'source', taskId, turnId: 'original', action: 'start' });
      h.store.saveTurn({ id: 'original', taskId, state: 'completed', prompt: 'continue', createdBy: scope.userId,
        sourceMessageId: 'source', sourceChatId: scope.chatId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      h.store.updateTask(taskId, task => ({ ...task, projectBindContinuation: { requestedBy: scope.userId, turnId: 'original', text: 'continue', actor } }));
      h.backend.interruptMaintenance = vi.fn().mockRejectedValueOnce(new Error('card preparation failed')).mockResolvedValue(undefined);
      await expect(runContinuation(h, taskId)).rejects.toThrow('card preparation failed');
      expect(h.backend.startedTurns).toHaveLength(0);
      const failed = h.store.listTurnsByTask(taskId).find(turn=>turn.internalOperationId)!;
      expect(failed).toMatchObject({ state: 'failed', submissionPhase: 'prepared' });
      expect(h.store.getTask(taskId)?.activeTurnId).toBeUndefined();
      await runContinuation(h, taskId);
      expect(h.backend.startedTurns).toHaveLength(1);
      expect(h.store.listTurnsByTask(taskId).filter(turn=>turn.internalOperationId)).toHaveLength(1);
      expect(h.store.getInboundAdmissionByExternalMessageId('source')?.turnId).toBe('original');
      expect(h.store.getTask(taskId)?.projectBindContinuation).toBeUndefined();
    } finally { await h.stop(taskId); }
  });

  it('fences uncertain continuation submissions across retries and startup recovery', async () => {
    const { h, scope, taskId } = await fixture();
    try {
      h.store.saveTurn({ id: 'original', taskId, state: 'completed', prompt: 'continue', createdBy: scope.userId,
        sourceChatId: scope.chatId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      h.store.updateTask(taskId, task => ({ ...task, projectBindContinuation: {
        requestedBy: scope.userId, turnId: 'original', text: 'continue', actor: scope,
      } }));
      h.backend.startTurnError = new Error('response lost');
      await expect(runContinuation(h, taskId)).rejects.toThrow('response lost');
      expect(h.store.listTurnsByTask(taskId).find(turn=>turn.internalOperationId)).toMatchObject({ state: 'queued', submissionPhase: 'unknown' });
      h.backend.startTurnError = undefined;
      await expect(runContinuation(h, taskId)).rejects.toThrow('outcome is unknown');
      await h.backend.stopTask(taskId); await h.service.waitForEvents(taskId);
      await h.service.recoverStartup();
      expect(h.backend.startedTurns).toHaveLength(1);
      expect(h.store.getTask(taskId)?.projectBindContinuation).toBeDefined();
      expect(h.store.listTurnsByTask(taskId).find(turn=>turn.internalOperationId)?.submissionPhase).toBe('unknown');
      await expect(h.service.send({ ...scope, text: 'status', messageId: 'later' })).rejects.toThrow('pending reconciliation');
      expect(h.backend.steeredTurns).toHaveLength(0);
    } finally { await h.stop(taskId); }
  });

  it('does not replay a continuation accepted before its marker could be cleared', async () => {
    const { h, scope, taskId } = await fixture();
    try {
      const now = new Date().toISOString();
      h.store.saveTurn({ id: 'accepted', taskId, state: 'completed', submissionPhase: 'accepted',
        internalOperationId: 'project-bind-continuation:original', prompt: 'continue', createdBy: scope.userId, createdAt: now, updatedAt: now });
      h.store.updateTask(taskId, task => ({ ...task, projectBindContinuation: {
        requestedBy: scope.userId, turnId: 'original', localTurnId: 'accepted', text: 'continue', actor: scope,
      } }));
      await runContinuation(h, taskId);
      await runContinuation(h, taskId);
      expect(h.backend.startedTurns).toHaveLength(0);
      expect(h.store.getTask(taskId)?.projectBindContinuation).toBeUndefined();
    } finally { await h.stop(taskId); }
  });

  it('keeps a remotely running continuation attached during startup instead of resubmitting it', async () => {
    const { h, scope, taskId } = await fixture();
    try {
      const now = new Date().toISOString();
      h.store.saveTurn({ id: 'continued', taskId, codexTurnId: 'remote', state: 'running', submissionPhase: 'accepted',
        internalOperationId: 'project-bind-continuation:original', prompt: 'continue', createdBy: scope.userId, createdAt: now, updatedAt: now });
      h.store.updateTask(taskId, task => ({ ...task, activeTurnId: 'continued', projectBindContinuation: {
        requestedBy: scope.userId, turnId: 'original', localTurnId: 'continued', text: 'continue', actor: scope,
      } }));
      h.backend.threadTurns = [{ id: 'remote', status: 'inProgress', items: [] }];
      await h.backend.stopTask(taskId); await h.service.waitForEvents(taskId);
      await h.service.recoverStartup();
      expect(h.backend.startedTurns).toHaveLength(0);
      expect(h.store.getTask(taskId)?.activeTurnId).toBe('continued');
      expect(h.store.getTurn('continued')?.state).toBe('running');
      expect(h.store.getTask(taskId)?.projectBindContinuation).toBeUndefined();
    } finally { await h.stop(taskId); }
  });

  it('starts a followup after confirming that the backend activity already ended', async () => {
    const { h, scope, taskId } = await fixture();
    try {
      await h.service.send({ ...scope, text: 'work', messageId: 'first' });
      const first = h.store.getTask(taskId)!.activeTurnId!;
      h.backend.threadTurns = [{ id: 'codex_turn_1', status: 'completed', items: [] }];
      const guard = vi.fn().mockImplementationOnce(() => { throw new NoActiveTurnError(taskId); });
      h.backend.assertSteerTarget = guard;
      h.store.claimInboundMessage({ ...scope, text: 'status', messageId: 'follow' });
      await h.service.send({ ...scope, text: 'status', messageId: 'follow' });
      expect(h.store.getTurn(first)?.state).toBe('completed');
      expect(h.backend.startedTurns).toHaveLength(2);
      expect(h.backend.steeredTurns).toHaveLength(0);
      expect(h.store.getInboundAdmissionByExternalMessageId('follow')?.action).toBe('start');
    } finally { await h.stop(taskId); }
  });

  it('retains a followup without submitting when remote reconciliation fails', async () => {
    const { h, scope, taskId } = await fixture();
    try {
      await h.service.send({ ...scope, text: 'work', messageId: 'first' });
      h.backend.assertSteerTarget = () => { throw new NoActiveTurnError(taskId); };
      vi.spyOn(h.backend, 'readThread').mockRejectedValueOnce(new Error('probe timeout'));
      h.store.claimInboundMessage({ ...scope, text: 'status', messageId: 'follow' });
      await expect(h.service.send({ ...scope, text: 'status', messageId: 'follow' })).rejects.toThrow('probe timeout');
      expect(h.store.getInboundAdmissionByExternalMessageId('follow')).toMatchObject({ status: 'pending', rawPayload: { text: 'status' } });
      expect(h.backend.startedTurns).toHaveLength(1);
      expect(h.backend.steeredTurns).toHaveLength(0);
    } finally { await h.stop(taskId); }
  });

  it('recovers a proven undelivered status followup once while preserving its ingress binding', async () => {
    const { h, scope, taskId } = await fixture();
    try {
      const now = new Date().toISOString();
      h.store.saveTurn({ id: 'orphan', taskId, state: 'interrupted', prompt: 'old', createdBy: scope.userId, createdAt: now, updatedAt: now });
      h.store.claimInboundMessage({ ...scope, threadId: scope.topicId, text: '汇报一下当前状态', messageId: 'undelivered' });
      h.store.bindInboundAdmission({ externalMessageId: 'undelivered', taskId, turnId: 'orphan', action: 'steer' });
      h.store.transitionInboundAdmission({ externalMessageId: 'undelivered', expectedStatuses: ['pending'], status: 'unknown', error: `Codex task has no active turn: ${taskId}` });
      h.store.appendTurnEvent({ eventKey: 'user-message:undelivered', taskId, turnId: 'orphan', eventType: 'user.followup', payload: { text: '汇报一下当前状态', messageId: 'undelivered' } });
      const recover = () => (h.service as unknown as { resumeUndeliveredFollowups(id: string): Promise<void> }).resumeUndeliveredFollowups(taskId);
      await recover(); await recover();
      expect(h.backend.startedTurns).toHaveLength(1);
      expect(h.backend.startedTurns[0]?.prompt).toContain('汇报一下当前状态');
      expect(h.store.getInboundAdmissionByExternalMessageId('undelivered')).toMatchObject({ status: 'completed', turnId: 'orphan', action: 'steer' });
      expect(h.store.listTurnsByTask(taskId).at(-1)?.internalOperationId).toBe('undelivered-followup:undelivered');
    } finally { await h.stop(taskId); }
  });

  it('does not replay a followup whose steer RPC outcome is uncertain', async () => {
    const { h, scope, taskId } = await fixture();
    try {
      h.store.claimInboundMessage({ ...scope, threadId: scope.topicId, text: 'status', messageId: 'uncertain' });
      h.store.bindInboundAdmission({ externalMessageId: 'uncertain', taskId, turnId: 'old', action: 'steer' });
      h.store.transitionInboundAdmission({ externalMessageId: 'uncertain', expectedStatuses: ['pending'], status: 'unknown', error: 'turn/steer response timed out' });
      await (h.service as unknown as { resumeUndeliveredFollowups(id: string): Promise<void> }).resumeUndeliveredFollowups(taskId);
      expect(h.backend.startedTurns).toHaveLength(0);
      expect(h.store.getInboundAdmissionByExternalMessageId('uncertain')?.status).toBe('unknown');
    } finally { await h.stop(taskId); }
  });

  async function fixture(privateChat=false){
    const h=await createHarness(undefined,true,true);
    h.config.userSandboxes={...h.config.userSandboxes!,enabled:true,enabledOwners:[],};
    h.config.taskPlatformRollout.projectSwitchingEnabled=true;
    for(const project of h.config.projects)project.access={allowedUsers:['ou_owner'],allowedChats:['oc_group'],knowledgeApprovers:[]};
    const scope={chatId:privateChat?'oc_private':'oc_group',chatType:privateChat?'private' as const:'group' as const,
      ...(privateChat?{}:{topicId:'topic_switch'}),userId:'ou_owner'};
    const {taskId}=await h.service.createTask({...scope,projectId:'repo'});
    h.provisioner.prepareProjectBinding=vi.fn(async(_task,project)=>({cwd:`/workspace/${project.id}`,branchName:`existing-${project.id}`}));
    return {h,scope,taskId};
  }
  it('switches both ways through slash commands, preserving task/scope, old contexts, and repeated-message idempotency',async()=>{
    const {h,scope,taskId}=await fixture();
    try{
      const old=h.store.getTask(taskId)!.codexThreadId;
      const input=message('/project switch repo2',{chatId:scope.chatId,chatType:'group',threadId:scope.topicId,messageId:'switch-1',wasMentioned:true});
      const reply=await h.controller.handleMessage(input);
      expect(reply.text).toContain('已切换到 repo2');expect(h.store.getTask(taskId)!.projectId).toBe('repo2');
      expect(h.store.listTaskContexts(taskId).find(c=>c.codexThreadId===old)?.state).toBe('archived');
      await h.controller.handleMessage(input);expect(h.provisioner.prepareProjectBinding).toHaveBeenCalledTimes(1);
      await h.service.switchProject({...scope,project:'repo',messageId:'switch-2'});
      expect(h.store.getTask(taskId)!.projectId).toBe('repo');
      expect((await h.service.projectSwitchStatus(scope))).toContain('existing-repo');
      expect(h.provisioner.delete).not.toHaveBeenCalled();
    }finally{await h.stop(taskId);}
  });
  it('queues without interruption, permits cancellation, and rejects conflicting queued targets',async()=>{
    const {h,scope,taskId}=await fixture();
    try{
      await h.service.send({...scope,text:'work',messageId:'work-1'});
      const task=h.store.getTask(taskId)!;
      const reply=await h.service.switchProject({...scope,project:'repo2',messageId:'queued-switch'});
      expect(reply).toContain('当前任务结束后');expect(h.provisioner.prepareProjectBinding).not.toHaveBeenCalled();
      await expect(h.service.switchProject({...scope,project:'repo'})).rejects.toThrow('不同目标');
      await h.service.cancelProjectSwitch(scope);
      h.backend.emit(taskId,{type:'turn.completed',taskId,threadId:task.codexThreadId!,turnId:'codex_turn_1',status:'completed',turn:{items:[]}});
      await waitFor(()=>!h.store.getTask(taskId)?.activeTurnId);
      expect(h.store.getTask(taskId)!.projectId).toBe('repo');expect(h.provisioner.prepareProjectBinding).not.toHaveBeenCalled();
    }finally{await h.stop(taskId);}
  });
  it('uses semantic switching in an existing project and continues work once in the new directory',async()=>{
    const {h,scope,taskId}=await fixture();
    try{
      const text='切到 repo2，继续核对测试';
      h.store.claimInboundMessage({ ...scope, text, messageId: 'semantic-switch' });
      await h.service.send({...scope,text,messageId:'semantic-switch'});
      const originalAdmission = h.store.getInboundAdmissionByExternalMessageId('semantic-switch')!;
      const task=h.store.getTask(taskId)!;
      h.backend.emit(taskId,{type:'backend.server_request',taskId,generation:task.connectionGeneration!,requestId:'switch-tool',method:'item/tool/call',
        params:{threadId:task.codexThreadId,tool:'project_switch',arguments:{projectId:'repo2',requestText:text,continueRequest:true}}});
      await waitFor(()=>Boolean(h.store.getTask(taskId)!.pendingProjectBind));
      expect(h.store.getTask(taskId)!.projectId).toBe('repo');
      h.backend.emit(taskId,{type:'turn.completed',taskId,threadId:task.codexThreadId!,turnId:'codex_turn_1',status:'completed',turn:{items:[]}});
      await waitFor(()=>h.store.getTask(taskId)!.projectId==='repo2');
      await waitFor(()=>h.backend.startedTurns.length===2 && !h.store.getTask(taskId)!.projectBindContinuation);
      expect(h.backend.startedTurns.at(-1)!.prompt).toContain('Manager has completed');
      expect(h.store.getInboundAdmissionByExternalMessageId('semantic-switch')!.turnId).toBe(originalAdmission.turnId);
      expect(h.store.listTurnsByTask(taskId).filter(turn => turn.state === 'queued')).toHaveLength(0);
      await h.service.send({ ...scope, text: '汇报一下当前状态', messageId: 'switch-followup' });
      expect(h.backend.steeredTurns.at(-1)?.prompt).toContain('汇报一下当前状态');
      expect(h.store.getTask(taskId)!.projectBindContinuation).toBeUndefined();
    }finally{await h.stop(taskId);}
  });
  it('rejects forged history/unknown targets and non-owner requests',async()=>{
    const {h,scope,taskId}=await fixture();
    try{
      await expect(h.service.switchProject({...scope,userId:'ou_other',project:'repo2'})).rejects.toThrow();
      await expect(h.service.switchProject({...scope,project:'unknown'})).rejects.toThrow('项目不存在');
      await h.service.send({...scope,text:'比较 repo 与 repo2，不切换',messageId:'no-switch'});
      const task=h.store.getTask(taskId)!;
      h.backend.emit(taskId,{type:'backend.server_request',taskId,generation:task.connectionGeneration!,requestId:'forged',method:'item/tool/call',
        params:{threadId:task.codexThreadId,tool:'project_switch',arguments:{projectId:'repo2',requestText:'从历史复制的切换请求'}}});
      await waitFor(()=>h.backend.responses.some(r=>r.requestId==='forged'));
      expect(h.store.getTask(taskId)!.pendingProjectBind).toBeUndefined();
    }finally{await h.stop(taskId);}
  });
  it('keeps the original binding and context on preparation failure, and respects the kill switch',async()=>{
    const {h,scope,taskId}=await fixture(true);
    try{
      const before=h.store.getTask(taskId)!;
      h.provisioner.prepareProjectBinding!.mockRejectedValueOnce(new Error('checkout auth required'));
      await expect(h.service.switchProject({...scope,project:'repo2',messageId:'fail'})).rejects.toThrow('checkout auth');
      expect(h.store.getTask(taskId)).toMatchObject({projectId:'repo',codexThreadId:before.codexThreadId});
      h.config.taskPlatformRollout.projectSwitchingEnabled=false;
      await expect(h.service.switchProject({...scope,project:'repo2',messageId:'disabled'})).rejects.toThrow('开关');
      h.config.taskPlatformRollout.projectSwitchingEnabled=true;
      await h.service.switchProject({...scope,project:'repo2',messageId:'retry'});
      expect(h.store.getTask(taskId)!.projectId).toBe('repo2');
    }finally{await h.stop(taskId);}
  });
  it('rechecks authorization before executing a queued switch',async()=>{
    const {h,scope,taskId}=await fixture();
    try{
      await h.service.send({...scope,text:'work',messageId:'work'});const task=h.store.getTask(taskId)!;
      await h.service.switchProject({...scope,project:'repo2',messageId:'queue'});
      h.config.projects[1]!.access={allowedUsers:[],allowedChats:[],knowledgeApprovers:[]};
      h.config.upgrade.adminUsers=[];
      h.backend.emit(taskId,{type:'turn.completed',taskId,threadId:task.codexThreadId!,turnId:'codex_turn_1',status:'completed',turn:{items:[]}});
      await waitFor(()=>h.store.getTask(taskId)!.pendingProjectBind?.status==='failed');
      expect(h.store.getTask(taskId)!.projectId).toBe('repo');
    }finally{await h.stop(taskId);}
  });
});

async function createSemanticBindingHarness(text: string, conversationContext?: ConversationContextProvider,
  mediaFactory?: Parameters<typeof createHarness>[6]) {
  const harness = await createHarness(undefined, true, true, false, conversationContext, undefined, mediaFactory);
  if(conversationContext)harness.config.conversationContext.enabled=true;
  harness.config.userSandboxes = { ...harness.config.userSandboxes!, enabled: true, enabledOwners: [], };
  harness.config.projects[0]!.access = { allowedUsers: ['ou_owner'], allowedChats: ['oc_group'], knowledgeApprovers: [] };
  const scope = { chatId: 'oc_group', chatType: 'group' as const, topicId: 'topic_semantic', userId: 'ou_owner' };
  const created = await harness.service.createTask({ ...scope, mode: 'chat' });
  await harness.service.send({ ...scope, text, messageId: 'om_semantic' });
  return { harness, scope, task: harness.store.getTask(created.taskId)! };
}

describe('project continuation input handoff',()=>{
  const png=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00]);
  const mediaFactory:NonNullable<Parameters<typeof createHarness>[6]>=({root,store,provisioner})=>new MediaService({
    enabled:true,storageRoot:join(root,'media'),maxImagesPerTurn:8,maxFilesPerTurn:10,
    maxImageBytes:10_485_760,maxFileBytes:52_428_800,maxTotalBytesPerTurn:104_857_600,pendingGroupAttachmentTtlMs:300_000,retentionHours:24,
  },store,{downloadMessageResource:vi.fn(async({kind})=>({data:kind==='image'?png:Buffer.from('file body')}))},provisioner);
  function provider(count:number){
    return {collect:vi.fn(async(_input:ConversationContextRequest)=>({scope:'topic' as const,chatId:'oc_group',threadId:'topic_semantic',truncated:false,
      unavailableReason:count===4?'timeout':undefined,fetchedAt:new Date().toISOString(),
      messages:[{messageId:'om_background',createdAt:'2026-10-26T14:30:00.000Z',messageType:'text',text:'用户 A 与用户 B 的权限身份问题，LogID: handoff-logid'}] as ConversationContextMessage[],
      lastMessage:{messageId:'om_background',createdAt:'2026-10-26T14:30:00.000Z'},
      images:Array.from({length:count},(_,index)=>({messageId:`om_image_${index}`,imageKey:`img_${index}`,dataUrl:`data:image/png;base64,${png.toString('base64')}`})),
    }))};
  }
  async function bind(h:Awaited<ReturnType<typeof createHarness>>,task:TaskRecord,text:string){
    h.provisioner.prepareProjectBinding=vi.fn(async()=>({cwd:'/workspace/projects/repo',branchName:'branch'}));
    h.backend.emit(task.id,{type:'backend.server_request',taskId:task.id,generation:1,requestId:'handoff-bind',method:'item/tool/call',
      params:{threadId:task.codexThreadId,tool:'project_bind',arguments:{projectId:'repo',requestText:text}}});
    await waitFor(()=>h.backend.responses.some(response=>response.requestId==='handoff-bind'));
    expect(h.backend.responses.find(response=>response.requestId==='handoff-bind')?.result).toMatchObject({success:true});
    h.backend.emit(task.id,{type:'turn.completed',taskId:task.id,threadId:task.codexThreadId!,turnId:'codex_turn_1',status:'completed',turn:{status:'completed',items:[]}});
  }
  it.each(['current','legacy','deleted-envelope','removed-user','wrong-topic','unproven-association'] as const)(
    'uses the production authorizer for three forwarded images without access to the original chat: %s',async(scenario)=>{
    const context=provider(3), original=await context.collect({} as ConversationContextRequest);
    const images=original.images.map(image=>({...image,messageId:'om_original_private',forwardedEnvelopeMessageId:'om_background'}));
    context.collect.mockResolvedValue({...original,images,messages:[{...original.messages[0]!,messageType:'merge_forward',images,
      text:'<forwarded_messages>原问题 LogID: forwarded-logid，三张截图</forwarded_messages>'}]});
    const text='使用 repo 项目，分析这个问题';
    const {harness:h,task}=await createSemanticBindingHarness(text,context,mediaFactory);
    const resolve=vi.fn(async(messageId:string)=>{
      if(messageId==='om_original_private')throw new Error('Bot/User can NOT be out of the chat.');
      if(scenario==='deleted-envelope'&&messageId==='om_background')return undefined;
      return {chatId:'oc_group',chatType:'group' as const,topicId:scenario==='wrong-topic'&&messageId==='om_background'?'another-topic':'topic_semantic'};
    });
    h.service.setHandoffInputAuthorizer(continuationInputAuthorizer({
      verifySensitiveReplySource:vi.fn(async(messageId,chatId,userId)=>messageId==='om_semantic'&&chatId==='oc_group'&&userId==='ou_owner'),
      isDetailReaderMember:vi.fn(async()=>scenario!=='removed-user'),resolveDetailMessageScope:resolve,
    }));
    try{
      if(scenario==='legacy'){
        h.store.updateTurn(task.activeTurnId!,turn=>{
          const snapshot=turn.inputHandoff!,strip=({forwardedEnvelopeMessageId:_,...image}:typeof images[number])=>image;
          for(const id of snapshot.attachmentIds){const record=h.media!.getAttachment(id)!;h.media!.saveAttachment({...record,forwardedEnvelopeMessageId:undefined});}
          return {...turn,inputHandoff:{...snapshot,images:snapshot.images.map(image=>({...image,forwardedEnvelopeMessageId:undefined})),
            conversation:{...snapshot.conversation!,images:images.map(strip),messages:snapshot.conversation!.messages.map(message=>({...message,images:images.map(strip)}))}}};
        });
      }
      if(scenario==='unproven-association')h.store.updateTurn(task.activeTurnId!,turn=>({...turn,inputHandoff:{...turn.inputHandoff!,
        conversation:{...turn.inputHandoff!.conversation!,messages:turn.inputHandoff!.conversation!.messages.map(message=>({...message,images:[]}))}}}));
      await bind(h,task,text);
      if(['current','legacy'].includes(scenario)){
        await waitFor(()=>h.backend.startedTurns.length===2&&!h.store.getTask(task.id)?.projectBindContinuation);
        expect(h.backend.startedTurns[1]?.images).toHaveLength(3);
        expect(h.backend.startedTurns[1]?.prompt).toContain('forwarded-logid');
        expect(resolve).toHaveBeenCalledWith('om_background');
      }else{
        await waitFor(()=>!!h.store.getTask(task.id)?.projectBindContinuation?.recoveryFailure);
        expect(h.backend.startedTurns).toHaveLength(1);
      }
      expect(resolve.mock.calls.some(([id])=>id==='om_original_private')).toBe(false);
    }finally{await h.stop(task.id);}
  });
  it('bootstraps a new context instead of consuming an old cursor, then resumes incremental reads',async()=>{
    const context=provider(0);
    const {harness:h,scope,task}=await createSemanticBindingHarness('先讨论问题',context);
    try{
      const complete=async()=>{
        const current=h.store.getTask(task.id)!;
        const active=h.store.getTurn(current.activeTurnId!)!;
        h.backend.emit(task.id,{type:'turn.completed',taskId:task.id,threadId:current.codexThreadId!,turnId:active.codexTurnId!,status:'completed',turn:{items:[]}});
        await waitFor(()=>!h.store.getTask(task.id)?.activeTurnId);
      };
      await complete();
      h.backend.emitTurnStarted=false;h.backend.startTurnResultId='remote-second';
      await h.service.send({...scope,text:'继续',messageId:'same-context'});
      expect(context.collect.mock.calls.at(-1)?.[0]).toMatchObject({afterCreatedAt:'2026-10-26T14:30:00.000Z'});
      await complete();
      const old=h.store.getActiveTaskContext(task.id)!;
      h.store.saveTaskContext({...old,projectBindingToolRevision:undefined});
      h.backend.startTurnResultId='remote-third';
      await h.service.send({...scope,text:'继续分析',messageId:'new-context'});
      expect(h.store.getActiveTaskContext(task.id)?.id).not.toBe(old.id);
      expect(context.collect.mock.calls.at(-1)?.[0]).not.toHaveProperty('afterCreatedAt');
      await complete();
      h.backend.startTurnResultId='remote-fourth';
      await h.service.send({...scope,text:'接着分析',messageId:'same-new-context'});
      expect(context.collect.mock.calls.at(-1)?.[0]).toMatchObject({afterCreatedAt:'2026-10-26T14:30:00.000Z'});
    }finally{await h.stop(task.id);}
  });
  it.each([false,true])('recovers durable image inputs during startup without requiring a new user message (legacy=%s)',async(legacy)=>{
    const context=provider(2),text='使用 repo 项目，查一下这个问题';
    const {harness:h,scope,task}=await createSemanticBindingHarness(text,context,mediaFactory);
    h.service.setHandoffInputAuthorizer(async()=>true);
    try{
      h.backend.emit(task.id,{type:'turn.completed',taskId:task.id,threadId:task.codexThreadId!,turnId:'codex_turn_1',status:'completed',turn:{items:[]}});
      await waitFor(()=>!h.store.getTask(task.id)?.activeTurnId);
      h.provisioner.prepareProjectBinding=vi.fn(async()=>({cwd:'/workspace/projects/repo',branchName:'branch'}));
      await h.service.bindExistingProject(scope,'repo');
      if(legacy)h.store.updateTurn(task.activeTurnId!,turn=>({...turn,inputHandoff:undefined}));
      else context.collect.mockRejectedValue(new Error('history now unavailable'));
      const marker={requestedBy:scope.userId,turnId:task.activeTurnId!,text};
      h.store.updateTask(task.id,current=>({...current,projectBindContinuation:marker}));
      await h.backend.stopTask(task.id);await h.service.waitForEvents(task.id);
      await h.service.recoverStartup();
      expect(h.backend.startedTurns).toHaveLength(2);
      expect(h.backend.startedTurns[1]?.images).toHaveLength(2);
      expect(h.backend.startedTurns[1]?.prompt).toContain('handoff-logid');
      expect(h.store.getTask(task.id)?.projectBindContinuation).toBeUndefined();
      h.store.updateTask(task.id,current=>({...current,projectBindContinuation:marker}));
      await h.backend.stopTask(task.id);await h.service.waitForEvents(task.id);
      await h.service.recoverStartup();
      expect(h.backend.startedTurns).toHaveLength(2);
    }finally{await h.stop(task.id);}
  });
  it.each([2,4])('preserves %i historical screenshots and background across a new bound context, including partial timeout',async(count)=>{
    const context=provider(count),text='使用 repo 项目，查一下这个问题';
    const {harness:h,task}=await createSemanticBindingHarness(text,context,mediaFactory);
    h.service.setHandoffInputAuthorizer(vi.fn(async()=>true));
    try{
      const source=h.store.getTurn(task.activeTurnId!)!;
      expect(source.inputHandoff?.images).toHaveLength(count);
      expect(JSON.stringify(source.inputHandoff)).not.toContain('base64');
      expect(h.backend.startedTurns[0]?.images).toHaveLength(count);
      await bind(h,task,text);
      await waitFor(()=>h.backend.startedTurns.length===2&&!h.store.getTask(task.id)?.projectBindContinuation);
      expect(h.backend.startedTurns[1]?.images).toHaveLength(count);
      expect(h.backend.startedTurns[1]?.prompt).toContain('handoff-logid');
      expect(h.backend.startedTurns[1]?.prompt).toContain('NOT the original business request');
      const continued=h.store.listTurnsByTask(task.id).find(turn=>turn.internalOperationId)!;
      expect(continued.sourceMessageId).toBe('om_semantic');
      expect(continued.submissionPhase).toBe('accepted');
      expect(h.store.getTurn(source.id)?.inputHandoff).toBeUndefined();
      expect(context.collect).toHaveBeenCalledTimes(1);
    }finally{await h.stop(task.id);}
  });
  it('merges followup direct images and files without losing historical images or duplicating images',async()=>{
    const text='使用 repo 项目，查一下这个问题',context=provider(2);
    const {harness:h,scope,task}=await createSemanticBindingHarness(text,context,mediaFactory);
    h.service.setHandoffInputAuthorizer(async()=>true);
    try{
      const followup='使用 repo 项目，并参考补充附件';
      await h.service.send({...scope,text:followup,messageId:'om_followup',resources:[
        {kind:'image',resourceKey:'img_direct',resourceOwnerMessageId:'om_followup'},
        {kind:'image',resourceKey:'img_0',resourceOwnerMessageId:'om_image_0'},
        {kind:'file',resourceKey:'file_direct',resourceOwnerMessageId:'om_followup',fileName:'report.txt'},
      ]});
      expect(h.store.getTurn(task.activeTurnId!)?.inputHandoff?.images).toHaveLength(3);
      await bind(h,task,followup);
      await waitFor(()=>{
        const failure=h.store.getTask(task.id)?.projectBindContinuation?.recoveryFailure;
        if(failure)throw new Error(failure);
        return h.backend.startedTurns.length===2&&!h.store.getTask(task.id)?.projectBindContinuation;
      });
      expect(h.backend.startedTurns[1]?.images).toHaveLength(3);
      expect(h.backend.startedTurns[1]?.prompt).toContain(followup);
      expect(h.backend.startedTurns[1]?.prompt).toContain('report.txt');
      expect(h.backend.startedTurns[1]?.prompt).toContain('handoff-logid');
    }finally{await h.stop(task.id);}
  });
  it.each(['revoked','expired','disabled'] as const)('pauses with durable recovery state instead of asking for already supplied input: %s',async(reason)=>{
    const text='使用 repo 项目，查一下这个问题';
    const {harness:h,task}=await createSemanticBindingHarness(text,provider(2),mediaFactory);
    h.service.setHandoffInputAuthorizer(async()=>reason!=='revoked');
    if(reason==='expired')h.store.updateTurn(task.activeTurnId!,turn=>({...turn,inputHandoff:{...turn.inputHandoff!,expiresAt:'2020-01-01T00:00:00.000Z'}}));
    if(reason==='disabled')h.config.taskPlatformRollout.projectContinuationInputHandoffEnabled=false;
    try{
      await bind(h,task,text);
      await waitFor(()=>!!h.store.getTask(task.id)?.projectBindContinuation?.recoveryFailure);
      expect(h.store.getTask(task.id)?.mode).toBe('project');
      expect(h.store.getTask(task.id)?.projectBindContinuation?.recoveryAttempts).toBe(1);
      expect(h.backend.startedTurns).toHaveLength(1);
      expect(h.store.getTurn(task.activeTurnId!)?.inputHandoff).toBeDefined();
    }finally{await h.stop(task.id);}
  });
  it('retries the preserved original request on an explicit continue after permission recovery',async()=>{
    const text='使用 repo 项目，查一下这个问题';
    const {harness:h,scope,task}=await createSemanticBindingHarness(text,provider(2),mediaFactory);
    h.service.setHandoffInputAuthorizer(async()=>false);
    try{
      await bind(h,task,text);
      await waitFor(()=>!!h.store.getTask(task.id)?.projectBindContinuation?.recoveryFailure);
      h.service.setHandoffInputAuthorizer(async()=>true);
      const reply=await h.service.send({...scope,text:'继续',messageId:'om_resume'});
      expect(reply?.text).toContain('已恢复原请求');
      expect(h.backend.startedTurns).toHaveLength(2);
      expect(h.backend.startedTurns[1]?.images).toHaveLength(2);
      expect(h.backend.startedTurns[1]?.prompt).toContain('handoff-logid');
      expect(h.store.getTask(task.id)?.projectBindContinuation).toBeUndefined();
    }finally{await h.stop(task.id);}
  });
});

async function createHarness(
  publishBrokerFactory?: (store: SqliteStateStore) => TaskPublishBroker,
  conversationScopedTasks = false,
  multiRepositoryTasks = false,
  managedMemory = false,
  conversationContext?: ConversationContextProvider,
  chatInfo?: { get(chatId: string): Promise<{ name: string }> },
  mediaFactory?: (input: {
    root: string; store: SqliteStateStore; provisioner: TaskRuntimeProvisioner;
  }) => MediaService,
  recordDetails = false,
  prepareSensitiveReply?: (context: SensitiveReplyContext, text: string) => Promise<string>,
  turnExperience?: AppServerTurnExperience,
) {
  const root = await createTmpDir();
  const store = new SqliteStateStore(join(root, 'state.sqlite'));
  const backend = new FakeBackend();
  const rendered: Array<{ id: string }> = [];
  const approvals = new AppServerRequestService(store, backend, { render: async (request) => { rendered.push(request); } });
  const deliver = vi.fn(async () => undefined);
  const outbox = new FeishuOutbox(store, { deliver });
  const provisioner: TaskRuntimeProvisioner & {
    delete: ReturnType<typeof vi.fn<(...args: any[]) => any>>; stop: ReturnType<typeof vi.fn<(...args: any[]) => any>>; addRepository: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
    refreshCodexAuth: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
    prepareProjectBinding?: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
    refreshWorkspaceFiles: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
    migrateRepository?: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
    finalizeRepositoryMigration?: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
    discardRepositoryMigration?: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
    resolveRepositoryBaseCommit?: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
    verifyExecutionRef: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
    exportArtifact: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
    stageInboundAttachment: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
  } = {
    provision: vi.fn(async ({ taskId }) => ({ cwd: root, branchName: `codex/ou_owner/${taskId}` })),
    resume: vi.fn(async (task: TaskRecord) => ({ cwd: root, branchName: task.branchName })),
    stop: vi.fn(async () => undefined), delete: vi.fn(async () => undefined),
    refreshCodexAuth: vi.fn(async () => undefined),
    refreshWorkspaceFiles: vi.fn(async () => undefined),
    addRepository: vi.fn(async () => ({ baseCommit: 'base_repo_2' })),
    observeTaskState: vi.fn(async () => 'hot' as const),
    verifyExecutionRef: vi.fn(async (_project, ref: string) => ({ commit: /^[a-f0-9]{40}$/i.test(ref) ? ref : 'e2e_commit' })),
    exportArtifact: vi.fn(async (_task, _source, destination) => { await writeFile(destination, 'artifact'); }),
    stageInboundAttachment: vi.fn(async (_task, turnId, _source, fileName) =>
      `/workspace/.linkbot/inbox/${turnId}/${fileName}`),
  };
  const config = sampleConfig(root);
  config.allowedUsers.push('ou_owner');
  config.runtime = { backend: 'app-server' };
  config.taskPlatformRollout.conversationScopedTasks = conversationScopedTasks;
  config.taskPlatformRollout.multiRepositoryTasks = multiRepositoryTasks;
  config.taskPlatformRollout.managedMemory = managedMemory;
  const contexts = new TaskContextService(store, backend);
  const repositories = new TaskRepositoryService(store, provisioner, () => undefined);
  const memory = new MemoryService(store);
  const media = mediaFactory?.({ root, store, provisioner });
  const details = recordDetails ? createTurnDetailRuntime(join(root, 'state.sqlite')) : undefined;
  const service = new TaskPlatformService(config, store, backend, provisioner, approvals, outbox, publishBrokerFactory?.(store), undefined, undefined, undefined, contexts, repositories, memory, undefined, undefined, turnExperience, undefined, conversationContext, chatInfo, media, details?.sink, prepareSensitiveReply
  );
  return {
    root, store, backend, rendered, deliver, outbox, provisioner, service, config, media,
    flushDetails: async () => { await details?.flush(); },
    controller: new FeishuTaskController(service),
    stop: async (taskId: string) => { await backend.stopTask(taskId); await service.waitForEvents(taskId); await details?.close(); store.close(); },
  };
}

class FakeBackend implements CodexBackend {
  readonly responses: RespondServerRequestInput[] = [];
  readonly startedTurns: StartTurnInput[] = [];
  readonly steeredTurns: StartTurnInput[] = [];
  interruptMaintenance?: (taskId: string) => Promise<void>;
  assertSteerTarget?: (taskId: string, expectedTurnId?: string) => void;
  readonly steerTurnErrors: Error[] = [];
  steerTurnAttempts = 0;
  readonly resumeInputs: ResumeTaskInput[] = [];
  resumeTaskError?: Error;
  startTaskError?: Error;
  startTaskHook?: (input: StartTaskInput) => void;
  startTurnGate?: Promise<void>;
  startTurnError?: Error;
  startTurnResultId?: string;
  emitTurnStarted = true;
  threadTurns: unknown[] = [];
  useObservedTurnProbe = false;
  readThreadCalls = 0;
  readonly archivedThreads: string[] = [];
  createContextGate?: Promise<void>;
  createContextCalls = 0;
  private threadSequence = 0;
  private readonly streams = new Map<string, EventStream>();
  async healthCheck(): Promise<{ ok: true }> { return { ok: true }; }
  async startTask(input: StartTaskInput): Promise<BackendTask> {
    if (this.startTaskError) throw this.startTaskError;
    this.startTaskHook?.(input);
    this.streams.set(input.taskId, new EventStream());
    this.threadSequence += 1;
    return { taskId: input.taskId, threadId: `thread_${this.threadSequence}`, generation: 1 };
  }
  async resumeTask(input: ResumeTaskInput): Promise<BackendTask> {
    this.resumeInputs.push(input);
    if (this.resumeTaskError) {
      const error = this.resumeTaskError;
      this.resumeTaskError = undefined;
      throw error;
    }
    return this.startTask(input);
  }
  async startTurn(input: StartTurnInput): Promise<void | { turnId: string }> {
    this.startedTurns.push(input);
    if (this.startTurnError) throw this.startTurnError;
    await this.startTurnGate;
    if (this.emitTurnStarted) this.emit(input.taskId, { type: 'turn.started', taskId: input.taskId, threadId: 'thread_1', turnId: 'codex_turn_1' });
    if (this.startTurnResultId) return { turnId: this.startTurnResultId };
  }
  async createContext(input: { taskId: string }): Promise<BackendTask & { threadId: string }> {
    this.createContextCalls += 1;
    await this.createContextGate;
    this.threadSequence += 1;
    return { taskId: input.taskId, threadId: `thread_${this.threadSequence}` };
  }
  async resumeContext(input: { taskId: string; threadId: string }): Promise<BackendTask & { threadId: string }> {
    return input;
  }
  async archiveContext(input: { threadId: string }): Promise<void> { this.archivedThreads.push(input.threadId); }
  async compactContext(): Promise<void> {}
  async steerTurn(input: StartTurnInput): Promise<void> {
    this.steerTurnAttempts += 1;
    const error = this.steerTurnErrors.shift();
    if (error) throw error;
    this.steeredTurns.push(input);
  }
  readonly interruptTurn = vi.fn(async (): Promise<void> => undefined);
  async respondToServerRequest(input: RespondServerRequestInput): Promise<void> { this.responses.push(input); }
  async stopTask(taskId: string): Promise<void> { this.streams.get(taskId)?.close(); }
  readObservedTurn(_taskId: string, turnId: string): import('../../src/backends/CodexBackend.js').ObservedTurnSnapshot | undefined {
    if (!this.useObservedTurnProbe) return undefined;
    const turn = this.threadTurns.find((candidate) => candidate && typeof candidate === 'object' && (candidate as { id?: string }).id === turnId);
    if (!turn || typeof turn !== 'object') return undefined;
    return { id: turnId, status: String((turn as { status?: unknown }).status ?? 'unknown'), raw: turn };
  }
  async readThread(taskId: string): Promise<ThreadSnapshot> {
    this.readThreadCalls += 1;
    return { taskId, threadId: 'thread_1', items: [], turns: this.threadTurns };
  }
  events(taskId: string): AsyncIterable<CodexBackendEvent> { return this.streams.get(taskId)!; }
  emit(taskId: string, event: CodexBackendEvent): void { this.streams.get(taskId)!.push(event); }
}

class EventStream implements AsyncIterable<CodexBackendEvent> {
  private readonly values: CodexBackendEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<CodexBackendEvent>) => void> = [];
  private ended = false;
  push(value: CodexBackendEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value }); else this.values.push(value);
  }
  close(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }
  [Symbol.asyncIterator](): AsyncIterator<CodexBackendEvent> {
    return { next: async () => {
      const value = this.values.shift();
      if (value) return { done: false, value };
      if (this.ended) return { done: true, value: undefined };
      return new Promise((resolve) => this.waiters.push(resolve));
    } };
  }
}

function actor(userId = 'ou_owner', overrides: Record<string, unknown> = {}) {
  return { chatId: 'oc_1', chatType: 'private' as const, userId, ...overrides };
}

function message(text: string, overrides: Record<string, unknown> = {}) {
  return { ...actor(), text, wasMentioned: false, ...overrides };
}

function card(action: Parameters<FeishuTaskController['handleCardAction']>[0]['action'], userId = 'ou_owner') {
  return { ...actor(userId), action };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for task platform state.');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
