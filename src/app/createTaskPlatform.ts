import { DockerDaemonResourceSampler } from '../runtime/DockerDaemonResourceSampler.js';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServerRequestService } from '../approvals/AppServerRequestService.js';
import type { AppServerRuntimeFactory } from '../appserver/AppServerCodexBackend.js';
import { AppServerCodexBackend } from '../appserver/AppServerCodexBackend.js';
import { dockerAttachRuntimeFactory } from '../appserver/AppServerDockerRuntime.js';
import { userSandboxAppServerRuntimeFactory } from '../appserver/UserSandboxAppServerRuntime.js';
import { AuthBroker } from '../auth/AuthBroker.js';
import { createToolAuthorizationCardRenderer } from '../auth/ToolAuthorizationCardRenderer.js';
import { TaskContextService } from '../contexts/TaskContextService.js';
import { continuationInputAuthorizer } from '../conversation/ContinuationInputAuthorizer.js';
import { FeishuConversationContextProvider,type ConversationContextProvider } from '../conversation/ConversationContextProvider.js';
import { conversationDynamicTools } from '../conversation/ConversationHistoryCapability.js';
import { LarkFeishuHistoryClient } from '../conversation/LarkFeishuHistoryClient.js';
import { FeishuTurnDetailController } from '../details/FeishuTurnDetailController.js';
import { InlineTurnDetailPublisher } from '../details/InlineTurnDetails.js';
import { SensitiveReplyDelivery } from '../details/SensitiveReplyDelivery.js';
import { artifactAccessPolicy,TurnDetailArtifactService } from '../details/TurnDetailArtifactService.js';
import { createTurnDetailRuntime } from '../details/TurnDetailRuntime.js';
import type { BotConfig,CodexHomePaths } from '../domain/types.js';
import { AmbientTopicAuthorizer } from '../feishu/AmbientChatPolicy.js';
import { LarkFeishuChatInfoClient } from '../feishu/FeishuChatInfoClient.js';
import type { FeishuGateway,FeishuIncomingMessage } from '../feishu/FeishuGateway.js';
import { FeishuApprovalOutboxRenderer,FeishuGatewayOutboxTransport,FeishuOutbox } from '../feishu/FeishuOutbox.js';
import { FeishuTaskController,type TaskActorContext } from '../feishu/FeishuTaskController.js';
import { SourceReferenceService } from '../feishu/SourceReferenceService.js';
import { renderToolAuthResumeFailureCard } from '../feishu/TaskPlatformCards.js';
import { DockerTaskPublishBroker } from '../git/DockerTaskPublishBroker.js';
import { GitIdentityResolver } from '../git/GitIdentityResolver.js';
import type { MergeRequestBroker } from '../git/GitPublishService.js';
import { GitPublishService,RemoteAwareMergeRequestBroker } from '../git/GitPublishService.js';
import { SqliteAppServerTurnCardStore } from '../livecards/AppServerTurnCardStore.js';
import { FeishuAppServerTurnExperience } from '../livecards/AppServerTurnExperience.js';
import { mediaDynamicTools } from '../media/MediaCapability.js';
import { MediaService } from '../media/MediaService.js';
import { AppServerDreamModel } from '../memory/AppServerDreamModel.js';
import { BotMemoryApprovalService } from '../memory/BotMemoryApprovalService.js';
import { DockerMemoryProjectionSink } from '../memory/DockerMemoryProjectionSink.js';
import { DreamConsolidator,SqliteDreamAdmissionController } from '../memory/DreamConsolidator.js';
import { DreamScheduler } from '../memory/DreamScheduler.js';
import { MemoryCheckpointWriter } from '../memory/MemoryCheckpointWriter.js';
import { MemoryProjectionService } from '../memory/MemoryProjectionService.js';
import { MemoryService } from '../memory/MemoryService.js';
import { memoryDynamicTools } from '../memory/TaskMemoryCapability.js';
import { readCodexModelCatalog } from '../models/CodexModelCatalog.js';
import { TaskPlatformDiagnostics } from '../observability/TaskPlatformDiagnostics.js';
import { DynamicProjectCatalog } from '../projects/DynamicProjectCatalog.js';
import { ProjectAccessPolicy } from '../projects/ProjectAccessPolicy.js';
import { ProjectCreationService } from '../projects/ProjectCreationService.js';
import { ProjectKnowledgeService } from '../projects/ProjectKnowledgeService.js';
import { projectBindingDynamicTools,projectCreationDynamicTools,projectDynamicTools,projectSwitchDynamicTools } from '../projects/ProjectWorkspaceCapability.js';
import { TaskRepositoryService } from '../repositories/TaskRepositoryService.js';
import { AdminDiskOperatorService } from '../runtime/AdminDiskOperatorService.js';
import { DiskLifecycleController,type DiskUsageSample,type DiskUsageSampler } from '../runtime/DiskLifecycleController.js';
import { DockerReadySlotRuntime } from '../runtime/DockerReadySlotRuntime.js';
import type { DockerCommandRunner } from '../runtime/DockerRuntime.js';
import { DockerRuntime,ExecDockerCommandRunner } from '../runtime/DockerRuntime.js';
import { DockerSourceReferenceInspector,sourceWorkspaceRoot } from '../runtime/DockerSourceReferenceInspector.js';
import { DockerTaskProvisioner,ExecManagerGitRunner,type ManagerGitRunner } from '../runtime/DockerTaskProvisioner.js';
import { ReadyPoolController } from '../runtime/ReadyPoolController.js';
import type { HostResourceSampler } from '../runtime/ResourceController.js';
import { ResourceController } from '../runtime/ResourceController.js';
import { SystemDiskUsageSampler } from '../runtime/SystemDiskUsageSampler.js';
import { SystemHostResourceSampler } from '../runtime/SystemHostResourceSampler.js';
import { TaskCredentialManager } from '../runtime/TaskCredentialManager.js';
import { TaskDiskCleanupController } from '../runtime/TaskDiskCleanupController.js';
import { UserSandboxDockerRuntime } from '../runtime/UserSandboxDockerRuntime.js';
import { UserSandboxManager } from '../runtime/UserSandboxManager.js';
import { UserSandboxReclaimer } from '../runtime/UserSandboxReclaimer.js';
import { modeAwareTaskProvisioner,UserSandboxTaskProvisioner } from '../runtime/UserSandboxTaskProvisioner.js';
import { SqliteStateStore } from '../state/SqliteStateStore.js';
import { conversationTaskIdentity,legacyConversationTaskIdentity } from '../tasks/ConversationTaskService.js';
import { completeExecutionProfile,taskExecutionProfile } from '../tasks/ExecutionProfile.js';
import { taskBindingId } from '../tasks/TaskBindingService.js';
import { TaskPlatformService } from '../tasks/TaskPlatformService.js';
import { taskMode,type TaskRecord } from '../tasks/TaskTypes.js';
import { taskPlatformEnabledFor,taskPlatformProjectEnabled } from './TaskPlatformRollout.js';

export interface TaskPlatformApplication {
  controller: Pick<FeishuTaskController, 'handleMessage' | 'handleCardAction'> & Partial<Pick<FeishuTaskController, 'handleTopicClosed'>>;
  store: SqliteStateStore;
  diskMaintenance: Pick<TaskDiskCleanupController, 'inventory'>;
  shouldHandleMessage(message: FeishuIncomingMessage): boolean;
  observeAmbientMessage?(message: FeishuIncomingMessage): Promise<void>;
  allowsAmbientMessage?(message: FeishuIncomingMessage): boolean;
  retrySensitiveReply?(message: FeishuIncomingMessage): Promise<{ text: string } | undefined>;
  healthCheck(): Promise<{ ok: true } | { ok: false; reason: string }>;
  recoverStartup(): Promise<void>;
  close(): Promise<void>;
}

export interface CreateTaskPlatformInput {
  projectRoot: string;
  config: BotConfig;
  codexHomes: CodexHomePaths;
  gateway: FeishuGateway;
  dependencies?: {
    dockerRunner?: DockerCommandRunner;
    managerGit?: ManagerGitRunner;
    waitForSocket?: (path: string) => Promise<void>;
    mergeRequests?: MergeRequestBroker;
    hostSampler?: HostResourceSampler;
    diskSampler?: DiskUsageSampler;
    clock?: () => Date;
    runtimeFactory?: AppServerRuntimeFactory;
    conversationContextProvider?: ConversationContextProvider;
    chatInfoClient?: import('../feishu/FeishuChatInfoClient.js').FeishuChatInfoClient;
  };
}

export async function ensureReviewTaskReady(
  store: Pick<SqliteStateStore, 'getTask'>,
  service: Pick<TaskPlatformService, 'createTask' | 'resume'>,
  actor: TaskActorContext,
  taskId: string,
): Promise<TaskRecord> {
  let task = store.getTask(taskId);
  if (!task) throw new Error(`Review task not found: ${taskId}`);
  if (!task.codexThreadId) {
    await service.createTask({ ...actor, projectId: task.projectId });
    task = store.getTask(taskId);
    if (!task) throw new Error(`Review task not found after initialization: ${taskId}`);
  }
  if (task.runtimeState === 'warm' || task.runtimeState === 'failed') {
    await service.resume(actor);
    task = store.getTask(taskId)!;
  }
  if (task.runtimeState !== 'hot') throw new Error(`Review task is not hot: ${taskId}`);
  if (!task.codexThreadId) throw new Error(`Review task has no Codex thread after initialization: ${taskId}`);
  return task;
}

export function createTaskPlatform(input: CreateTaskPlatformInput): TaskPlatformApplication {
  const runtimeConfig = input.config.runtime ?? { backend: 'app-server' as const };
  const mediaConfig = input.config.media ?? {
    enabled: false,
    storageRoot: join(input.projectRoot, '.link-bot/media-store'),
    maxImagesPerTurn: 8,
    maxFilesPerTurn: 10,
    maxImageBytes: 10_485_760,
    maxFileBytes: 52_428_800,
    maxTotalBytesPerTurn: 104_857_600,
    pendingGroupAttachmentTtlMs: 300_000,
    retentionHours: 24,
  };
  if (input.config.taskPlatformRollout.multiUserEnabled
    && (!runtimeConfig.isolationVerified || !runtimeConfig.sharedAuthRiskAccepted)) {
    throw new Error('Multi-user task platform requires verified Docker isolation and explicit shared-auth risk acceptance.');
  }
  const clock = input.dependencies?.clock ?? (() => new Date());
  const sensitiveReplies = new SensitiveReplyDelivery(join(input.projectRoot, '.link-bot/sensitive-replies'), input.gateway, clock,
    input.config.sensitiveReplyDeliveryEnabled !== false);
  void sensitiveReplies.cleanup().catch(() => undefined);
  const projectAccess = new ProjectAccessPolicy(input.config);
  const statePath = runtimeConfig.statePath ?? join(input.projectRoot, '.link-bot/task-platform.sqlite');
  const store = new SqliteStateStore(statePath, clock);
  migrateWorkerExecutionDefaults(store, input.config, clock);
  const appServerCardStore = new SqliteAppServerTurnCardStore(statePath, clock);
  // The flag controls presentation only; rollback must not restore raw persistence or stop retention.
  const turnDetails = createTurnDetailRuntime(statePath, clock);
  const inlinePublisher = new InlineTurnDetailPublisher(turnDetails.store, turnDetails.resources, input.gateway, clock, turnDetails.audit,
    input.config.liveCards.inlineTimelineMaxItems);
  const diagnostics = new TaskPlatformDiagnostics(store, clock);
  const diskLifecycle = new DiskLifecycleController(
    input.config.diskPolicy,
    input.dependencies?.diskSampler ?? new SystemDiskUsageSampler(),
    diagnostics,
    clock,
  );
  // Unix-domain socket paths are limited to roughly 108 bytes on Linux. Keep
  // this host-only bridge root short regardless of the repository location.
  const dockerRunner = input.dependencies?.dockerRunner ?? new ExecDockerCommandRunner();
  const docker = new DockerRuntime({
    image: runtimeConfig.image ?? 'link-bot-runtime:0.1',
    socketRoot: runtimeConfig.socketRoot ?? join(input.projectRoot, '.link-bot/task-sockets'),
    cpuLimit: runtimeConfig.taskCpuLimit ?? 4,
    memoryLimitBytes: runtimeConfig.taskMemoryLimitBytes ?? 8_589_934_592,
    pidLimit: runtimeConfig.taskPidLimit ?? 512,
    tmpfsLimitBytes: runtimeConfig.taskTmpfsLimitBytes ?? 2_147_483_648,
    network: runtimeConfig.taskNetwork ?? 'bridge',
    codexCliVersion: runtimeConfig.codexCliVersion ?? '0.161.0',
    environment: runtimeProxyEnvironment(process.env),
  }, dockerRunner);
  const stagingRoot = runtimeConfig.stagingRoot ?? join(input.projectRoot, '.link-bot/task-staging');
  const managerGit = input.dependencies?.managerGit ?? new ExecManagerGitRunner();
  const readyRuntime = new DockerReadySlotRuntime(
    docker, join(stagingRoot, 'ready'), managerGit,
    runtimeConfig.image ?? 'link-bot-runtime:0.1', runtimeConfig.codexCliVersion ?? '0.161.0', clock,
    input.config.diskPolicy.enabled ? diskLifecycle : undefined,
  );
  const readyPool = new ReadyPoolController(store, readyRuntime, input.config.readyPool);
  const credentialManager = new TaskCredentialManager(input.codexHomes.global);
  const legacyProvisioner = new DockerTaskProvisioner(docker, credentialManager, stagingRoot, managerGit, input.dependencies?.waitForSocket, input.config.readyPool.enabled ? readyPool : undefined, input.config.readyPool.enabled ? readyRuntime : undefined, input.config.diskPolicy.enabled ? diskLifecycle : undefined, new GitIdentityResolver(input.config.gitIdentities), runtimeConfig.nativeGitExecution ?? false, input.config.projects
  );
  const userSandboxConfig = input.config.userSandboxes ?? {
    enabled: true, enabledOwners: [], legacyFallbackEnabled: false, transport: 'auto' as const,
    maxAppServersPerUser: 8, maxActiveTurnsPerUser: 4, processIdleTimeoutMinutes: 120,
    containerIdleTimeoutMinutes: 1_440, containerWrapperRetentionHours: 24,
  };
  const userSandboxDocker = new UserSandboxDockerRuntime({
    transport: userSandboxConfig.transport,
    image: runtimeConfig.image ?? 'link-bot-runtime:0.1',
    bridgeRoot: join(tmpdir(), `cb-user-${process.getuid?.() ?? 'service'}`),
    cpuLimit: runtimeConfig.taskCpuLimit ?? 4,
    memoryLimitBytes: runtimeConfig.taskMemoryLimitBytes ?? 8_589_934_592,
    pidLimit: runtimeConfig.taskPidLimit ?? 512,
    tmpfsLimitBytes: runtimeConfig.taskTmpfsLimitBytes ?? 2_147_483_648,
    network: runtimeConfig.taskNetwork ?? 'bridge',
    maxAppServersPerUser: userSandboxConfig.maxAppServersPerUser,
    resourceOverrides: userSandboxConfig.resourceOverrides,
    hostUid: process.getuid?.() ?? 0,
    hostGid: process.getgid?.() ?? 0,
    authFile: resolveOptionalAuthFile(input.codexHomes.global),
    environment: {
      ...runtimeProxyEnvironment(process.env),
    },
  }, dockerRunner, input.dependencies?.waitForSocket);
  const userSandboxManager = new UserSandboxManager(store, userSandboxDocker, { clock });
  const provisioner = modeAwareTaskProvisioner(
    store, legacyProvisioner, new UserSandboxTaskProvisioner(store, userSandboxManager),
    userSandboxConfig.legacyFallbackEnabled,
  );
  const legacyRuntimeFactory = input.dependencies?.runtimeFactory ?? dockerAttachRuntimeFactory((taskId) => {
    const task = store.getTask(taskId);
    return docker.describe(task?.runtimeId ?? taskId).containerName;
  }, undefined, runtimeConfig.appServerMaxFrameBytes);
  const sandboxRuntimeFactory = userSandboxAppServerRuntimeFactory({
    resolveTarget: async (taskId) => {
      const task = store.getTask(taskId);
      if (!task || task.runtimeMode !== 'user-sandbox') throw new Error(`User sandbox task not found: ${taskId}`);
      const ensured = await userSandboxManager.ensure(task.ownerUserId);
      return {
        sandboxGeneration: ensured.sandbox.generation,
        supervisorSocketPath: ensured.runtime.supervisorSocketPath,
      };
    },
    recoverTarget: async (taskId) => {
      const task = store.getTask(taskId);
      if (!task || task.runtimeMode !== 'user-sandbox') throw new Error(`User sandbox task not found: ${taskId}`);
      const recycled = await userSandboxManager.recycle(task.ownerUserId);
      store.updateTask(task.id, (current) => ({
        ...current, sandboxId: recycled.sandbox.id, sandboxGeneration: recycled.sandbox.generation,
        updatedAt: clock().toISOString(),
      }));
      return {
        sandboxGeneration: recycled.sandbox.generation,
        supervisorSocketPath: recycled.runtime.supervisorSocketPath,
      };
    },
    maxFrameBytes: runtimeConfig.appServerMaxFrameBytes,
  });
  let legacyProcessGeneration = 0;
  const backend = new AppServerCodexBackend({
    command: input.config.codex.command,
    maxFrameBytes: runtimeConfig.appServerMaxFrameBytes,
    protocolWarning: (warning) => diagnostics.audit('app_server.notification_ignored', { ...warning }),
    threadDefaults: (start) => store.getTask(start.taskId)?.runtimeMode === 'user-sandbox'
      ? { dynamicTools: [
        ...(input.config.taskPlatformRollout.projectSwitchingEnabled ? projectSwitchDynamicTools() : []),
        ...(store.getTask(start.taskId)?.mode === 'chat'
          && (!store.getTask(start.taskId)?.pendingProjectBind || store.getTask(start.taskId)?.pendingProjectBind?.status === 'failed')
          ? [...projectCreationDynamicTools(), ...projectBindingDynamicTools()] : []),
        ...((store.getTask(start.taskId)?.pendingProjectBind?.projectId ?? store.getTask(start.taskId)?.projectId)
          && store.getDynamicProject((store.getTask(start.taskId)?.pendingProjectBind?.projectId ?? store.getTask(start.taskId)?.projectId)!)
          ? projectDynamicTools({ nativeGitExecution: true, managerGitToolFallback: false }) : []),
        ...(mediaConfig.enabled ? mediaDynamicTools() : []),
      ] }
      : { dynamicTools: [
        ...(input.config.taskPlatformRollout.projectlessWorkspaces
          ? projectDynamicTools({
            nativeGitExecution: runtimeConfig.nativeGitExecution,
            managerGitToolFallback: runtimeConfig.managerGitToolFallback,
          }) : []),
        ...(input.config.taskPlatformRollout.managedMemory ? memoryDynamicTools() : []),
        ...(input.config.conversationContext.enabled ? conversationDynamicTools() : []),
        ...(mediaConfig.enabled ? mediaDynamicTools() : []),
      ] },
    runtimeFactory: (start, generation) => store.getTask(start.taskId)?.runtimeMode === 'user-sandbox'
      ? sandboxRuntimeFactory(start, generation)
      : legacyRuntimeFactory(start, generation),
    generationAllocator: async (start) => {
      const task = store.getTask(start.taskId);
      if (task?.runtimeMode !== 'user-sandbox') return ++legacyProcessGeneration;
      const ensured = await userSandboxManager.ensure(task.ownerUserId);
      const allocated = store.allocateUserSandboxTaskProcessGeneration({
        taskId: task.id, expectedSandboxGeneration: ensured.sandbox.generation,
      });
      if (!allocated) throw new Error(`Unable to allocate user sandbox process generation: ${task.id}`);
      return allocated.processGeneration;
    },
  });
  const media = new MediaService(mediaConfig, store, input.gateway, provisioner, clock);
  const sourceReferences = new SourceReferenceService(new DockerSourceReferenceInspector(dockerRunner, (taskId) => {
    const task = store.getTask(taskId);
    if (!task) return undefined;
    if (task.runtimeMode === 'user-sandbox') {
      const sandbox = store.getUserSandboxByOwner(task.ownerUserId);
      if (!sandbox || sandbox.status !== 'running') return undefined;
      const workspaceRoot = sourceWorkspaceRoot(task);
      return workspaceRoot
        ? { containerName: userSandboxDocker.describe(sandbox).containerName, workspaceRoot }
        : undefined;
    }
    return { containerName: docker.describe(task.runtimeId ?? task.id).containerName, workspaceRoot: sourceWorkspaceRoot(task)! };
  }));
  const resolveSourceReferences = (taskId: string, markdown: string) => sourceReferences.resolveMarkdown(taskId, markdown);
  const turnArtifacts = mediaConfig.enabled && mediaConfig.maxFileBytes >= 256 && turnDetails?.store && turnDetails.resources && turnDetails.results
    && input.gateway.uploadFile && input.gateway.sendDetailFileToTarget
    ? new TurnDetailArtifactService(turnDetails.store, turnDetails.resources, turnDetails.results,
      (actor) => artifactAccessPolicy(input.gateway, actor), input.gateway, media, clock,
      Math.min(mediaConfig.maxFileBytes, 50 * 1024 * 1024), turnDetails.telemetry, turnDetails.audit) : undefined;
  const outbox = new FeishuOutbox(store, new FeishuGatewayOutboxTransport(input.gateway, store, media, resolveSourceReferences, turnArtifacts, turnDetails.telemetry, clock), clock);
  const taskDiskCleanup = new TaskDiskCleanupController(
    input.config.diskPolicy, store, docker, diagnostics, clock,
  );
  const approvals = new AppServerRequestService(store, backend, new FeishuApprovalOutboxRenderer(outbox, (request) => {
    const binding = store.getLatestTaskBinding(request.taskId);
    if (!binding) return { chatId: request.ownerUserId, receiveIdType: 'open_id' as const, mentionUserId: request.ownerUserId };
    return {
      chatId: binding.chatId ?? binding.userId,
      ...(binding.lastMessageId ? { replyToMessageId: binding.lastMessageId } : {}),
      chatType: binding.chatType,
      ...(binding.chatType === 'group' && binding.topicId
        ? { replyInThread: true, mentionUserId: request.ownerUserId, topicId: binding.topicId }
        : binding.chatType === 'group' ? { mentionUserId: request.ownerUserId } : {}),
    };
  }), 300_000, clock);
  const resources = new ResourceController(
    store,
    input.dependencies?.hostSampler ?? (process.platform === 'darwin'
      ? new DockerDaemonResourceSampler(dockerRunner) : new SystemHostResourceSampler()),
    {
      gracefulStop: async (task) => {
        await backend.stopTask(task.id).catch(() => undefined);
        await provisioner.stop(task);
      },
    },
    readyPool,
    input.config.taskPool,
  );
  const publisher = new DockerTaskPublishBroker(
    input.config,
    legacyProvisioner,
    new GitPublishService(store, input.dependencies?.mergeRequests ?? new RemoteAwareMergeRequestBroker(), undefined, clock),
  );
  const contexts = new TaskContextService(store, backend, new MemoryCheckpointWriter(store, clock), clock);
  const memoryConfig = input.config.memory ?? {
    catalogMaxTokens: 1_000, automaticRecallMaxTokens: 1_500, singleReadMaxTokens: 1_500, totalContextRatio: 0.1,
  };
  const dreamConfig = input.config.dream ?? {
    enabled: false, timezone: 'Asia/Shanghai', startAfter: '02:00', maxConcurrency: 1,
    maxInteractiveActiveTurns: 2, batchMaxEvents: 100, batchMaxChars: 24_000, administratorIds: [],
  };
  if (input.config.taskPlatformRollout.nightlyDream && (!input.config.taskPlatformRollout.managedMemory || !dreamConfig.enabled)) {
    throw new Error('Nightly Dream requires managed memory and dream.enabled.');
  }
  const memoryAdministratorIds = [...new Set([...dreamConfig.administratorIds, ...input.config.upgrade.adminUsers])];
  if (input.config.taskPlatformRollout.botGlobalMemory
    && (!input.config.taskPlatformRollout.managedMemory || memoryAdministratorIds.length === 0)) {
    throw new Error('Bot-global memory requires managed memory and at least one administrator.');
  }
  const memory = new MemoryService(store, clock, memoryConfig);
  const memoryProjections = new MemoryProjectionService(
    store, new DockerMemoryProjectionSink(store, docker, join(stagingRoot, 'memory-projections')), clock,
  );
  const repositories = new TaskRepositoryService(store, legacyProvisioner, ({ task, project, userId }) => {
    const configured = input.config.projects.find((candidate) => candidate.id === project.id);
    if (!configured || configured.path !== project.path) throw new Error(`Project is not configured: ${project.id}`);
    if (input.config.taskPlatformRollout.projectlessWorkspaces) {
      const scope = store.getTaskScope(task.id);
      const actor = scope?.scope === 'private'
        ? { chatType: 'private' as const, chatId: scope.chatId ?? userId, userId }
        : { chatType: 'group' as const, chatId: scope?.chatId ?? '', userId };
      if (!projectAccess.canAccess(project, actor)) throw new Error('Project is not authorized for this conversation.');
    } else {
      const membership = store.getTaskMembership(task.id, userId);
      const privileged = membership
        ? membership.status === 'active' && (membership.role === 'owner' || membership.role === 'administrator')
        : task.ownerUserId === userId;
      if (!privileged) throw new Error('Repository changes require the task owner or an administrator.');
    }
    const enabled = input.config.taskPlatformRollout.enabledProjects;
    if ((enabled.length > 0 && !enabled.includes(project.id)) || !taskPlatformEnabledFor(input.config, userId, project)) {
      throw new Error(`Task platform is not enabled for project ${project.id}.`);
    }
  }, clock);
  const botMemoryApprovals = new BotMemoryApprovalService(
    store, memory, memoryAdministratorIds, Boolean(input.config.taskPlatformRollout.botGlobalMemory),
  );
  const projectKnowledge = new ProjectKnowledgeService(store, input.config, clock);
  const conversationContext = input.config.conversationContext.enabled
    ? input.dependencies?.conversationContextProvider ?? new FeishuConversationContextProvider(
      new LarkFeishuHistoryClient(input.config.feishu.appId, input.config.feishu.appSecret),
      input.config.conversationContext,
      clock,
    )
    : undefined;
  const chatInfo = input.dependencies?.chatInfoClient
    ?? new LarkFeishuChatInfoClient(input.config.feishu.appId, input.config.feishu.appSecret);
  const cardRecovery = new FeishuAppServerTurnExperience(
      input.gateway, input.config.liveCards.refreshIntervalMs, clock, appServerCardStore, 'task_platform', resolveSourceReferences,
      turnDetails ? {
        enabled: input.config.liveCards.detailsEnabled === true,
        inlineEnabled: input.config.liveCards.inlineDetailsEnabled === true,
        flush: () => turnDetails.flush(),
        readInline: (identity, context) => inlinePublisher.capture(identity, context),
        registerCard: (identity) => turnDetails.views?.registerCard(identity),
        saveResult: (identity, answer, endedAt) => {
          const scope = turnDetails.store?.getTurn(identity)?.scope;
          if (scope) turnDetails.results?.save(identity, scope, answer, endedAt);
          const metadata = turnDetails.results?.metadata(identity);
          if (!metadata) return;
          const page = turnDetails.results!.readPage(identity);
          return { text: page.text, hasMore: page.nextOffset !== undefined, endedAt: metadata.endedAt };
        },
      } : undefined,
      turnDetails.telemetry,
    );
  const turnExperience = input.config.liveCards.enabled ? cardRecovery : undefined;
  const unsubscribeApprovalState = approvals.subscribe(async (request) => { await turnExperience?.requestChanged(request); });
  const unsubscribeApprovalDelivery = outbox.subscribeApproval(async (request) => { await turnExperience?.requestChanged(request); });
  const dreamScheduler = new DreamScheduler(store, {
    timezone: dreamConfig.timezone, startAfter: dreamConfig.startAfter,
  }, clock);
  const dreamConsolidator = new DreamConsolidator(
    store, new AppServerDreamModel(backend),
    new SqliteDreamAdmissionController(
      store, input.config.taskPool.maxActiveTurns, dreamConfig.maxInteractiveActiveTurns,
      () => resources.underMemoryPressure(),
    ),
    memoryProjections, diagnostics,
    {
      batchMaxEvents: dreamConfig.batchMaxEvents, batchMaxChars: dreamConfig.batchMaxChars,
      botId: input.config.feishu.appId,
      allowGlobalCandidates: Boolean(input.config.taskPlatformRollout.botGlobalMemory),
    },
    clock,
  );
  const service = new TaskPlatformService(input.config, store, backend, provisioner, approvals, outbox, publisher, resources, clock, diagnostics, contexts, repositories, memory, memoryProjections, botMemoryApprovals, turnExperience, projectKnowledge, conversationContext, chatInfo, media, turnDetails?.sink, (context, text) => sensitiveReplies.prepare(context, text)
  );
  const dynamicCatalog = new DynamicProjectCatalog(store, input.config);
  service.setHandoffInputAuthorizer(continuationInputAuthorizer(input.gateway));
  service.setSandboxRuntimeControl({
    status: (ownerId) => userSandboxManager.runtimeStatus(ownerId),
    upgrade: (ownerId) => userSandboxManager.upgradeRuntime(ownerId),
  });
  service.setDynamicProjectCatalog(dynamicCatalog);
  service.setProjectImportInspector((ownerId,localPath,repositoryUrl)=>userSandboxManager.inspectExistingProject(ownerId,localPath,repositoryUrl));
  const creation = new ProjectCreationService(store, async (actor, request) => {
    const ensured = await userSandboxManager.ensure(actor.userId);
    return userSandboxManager.validateRepositoryCreation({
      ...request, ownerUserId: actor.userId, sandboxGeneration: ensured.sandbox.generation,
    });
  }, clock);
  creation.setExecutionPorts({
    create: async (actor, request) => {
      const ensured = await userSandboxManager.ensure(actor.userId);
      return userSandboxManager.createRepository({ ...request, ownerUserId: actor.userId,
        sandboxGeneration: ensured.sandbox.generation });
    },
    readback: async (actor, request) => {
      const ensured = await userSandboxManager.ensure(actor.userId);
      return userSandboxManager.readRepositoryCreation({ ...request, ownerUserId: actor.userId,
        sandboxGeneration: ensured.sandbox.generation });
    },
    bind: (actor, projectId, onCheckoutReady) => service.bindExistingProject(actor, projectId, onCheckoutReady),
    isProjectIdTaken: (id) => input.config.projects.some((project) => project.id === id),
  });
  service.setProjectCreationService(creation);
  const userSandboxReclaimer = new UserSandboxReclaimer(store, {
    stopTaskProcess: async (task) => {
      await backend.stopTask(task.id);
      await service.waitForEvents(task.id);
      await provisioner.stop(task);
    },
    reclaimSandbox: (ownerId) => userSandboxManager.reclaim(ownerId),
  }, {
    processIdleMs: userSandboxConfig.processIdleTimeoutMinutes * 60_000,
    wrapperIdleMs: Math.max(
      userSandboxConfig.containerIdleTimeoutMinutes * 60_000,
      userSandboxConfig.containerWrapperRetentionHours * 3_600_000,
    ),
  }, clock);
  const authBroker = new AuthBroker(
    [], store,
    async (turn, context) => { await service.resumeAfterToolAuth(turn, context); },
    clock, (turn) => service.refreshToolAuth(turn),
    async (turn, error) => {
      const detail = safeToolAuthResumeError(error);
      diagnostics.audit('tool_auth.resume_failed', {
        pendingId: turn.id, provider: turn.provider, taskId: turn.sourceTaskId,
        turnId: turn.sourceTurnId, error: detail,
      });
      await input.gateway.sendRenderedMessageToTarget({
        chatId: turn.chatId,
        ...(turn.messageId ? { replyToMessageId: turn.messageId } : {}),
        ...(turn.chatType === 'group' && turn.topicId ? { replyInThread: true, topicId: turn.topicId } : {}),
        ...(turn.chatType === 'group' ? { mentionUserId: turn.userId } : {}),
      }, renderToolAuthResumeFailureCard(turn, detail));
    },
    createToolAuthorizationCardRenderer(input.gateway, (pending, error) => {
      diagnostics.audit('tool_auth.qr_fallback', {
        provider: pending.provider,
        reason: error instanceof Error ? error.message : String(error),
      });
    }),
  );
  service.setAuthBroker(authBroker);
  const timer = setInterval(() => {
    try {
      diagnostics.refreshMetrics();
    } catch (error) {
      // Metrics are best effort and must never abort message/task recovery.
      try {
        diagnostics.audit('metrics.refresh_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // The same transient SQLite writer contention may also reject auditing.
      }
    }
    void outbox.flush();
  }, 1_000);
  timer.unref();
  const mediaCleanupTimer = setInterval(() => {
    void media.cleanupExpired().catch((error) => diagnostics.audit('media.cleanup_failed', {
      error: error instanceof Error ? error.message : String(error),
    }));
  }, 300_000);
  mediaCleanupTimer.unref();
  const detailMaintenanceTimer = setInterval(() => {
    try { turnDetails.maintain(); } catch { /* Housekeeping cannot fail task execution. */ }
    void sensitiveReplies.cleanup().catch(() => undefined);
  }, 60_000);
  detailMaintenanceTimer.unref();
  let stalledTurnTickActive = false;
  const stalledTurnTimer = setInterval(() => {
    if (stalledTurnTickActive) return;
    stalledTurnTickActive = true;
    void service.reconcileStalledTurns().catch((error) => diagnostics.audit('turn.stall_reconcile_failed', {
      error: error instanceof Error ? error.message : String(error),
    })).finally(() => { stalledTurnTickActive = false; });
  }, 60_000);
  stalledTurnTimer.unref();
  let submittedTurnTickActive = false;
  const submittedTurnTimer = setInterval(() => {
    if (submittedTurnTickActive) return;
    submittedTurnTickActive = true;
    void service.reconcileSubmittedTurns().catch((error) => diagnostics.audit('turn.submission_reconcile_failed', {
      error: error instanceof Error ? error.message : String(error),
    })).finally(() => { submittedTurnTickActive = false; });
  }, 5_000);
  submittedTurnTimer.unref();
  const sampleIdleMemory = async () => {
    for (const task of store.listTasks().filter((candidate) =>
      (candidate.runtimeMode ?? 'legacy-task-container') === 'legacy-task-container'
      && candidate.runtimeState === 'hot'
      && !candidate.activeTurnId)) {
      try {
        const bytes = await docker.memoryUsageBytes(docker.describe(task.runtimeId ?? task.id));
        store.recordResourceSample({ taskId: task.id, sampleType: 'idle_task_rss', bytes });
      } catch (error) {
        diagnostics.audit('runtime.memory_sample_failed', {
          taskId: task.id, error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  const memoryTimer = setInterval(() => { void sampleIdleMemory(); }, 30_000);
  memoryTimer.unref();
  let activeUserSandboxReclaim: Promise<void> | undefined;
  const scheduleUserSandboxReclaim = (): Promise<void> => {
    if (!userSandboxConfig.enabled) return Promise.resolve();
    if (activeUserSandboxReclaim) return activeUserSandboxReclaim;
    activeUserSandboxReclaim = userSandboxReclaimer.run().then((result) => {
      for (const failure of result.failures) diagnostics.audit('user_sandbox.reclaim_failed', failure);
      if (result.stoppedTaskIds.length || result.reclaimedOwnerIds.length) {
        diagnostics.audit('user_sandbox.reclaimed', {
          stoppedTaskIds: result.stoppedTaskIds,
          reclaimedOwnerIds: result.reclaimedOwnerIds,
        });
      }
    }).finally(() => { activeUserSandboxReclaim = undefined; });
    return activeUserSandboxReclaim;
  };
  const userSandboxReclaimTimer = setInterval(() => { void scheduleUserSandboxReclaim(); }, 60_000);
  userSandboxReclaimTimer.unref();
  const runDreamTick = async (startup = false) => {
    if (!input.config.taskPlatformRollout.nightlyDream || !dreamConfig.enabled) return;
    try {
      if (startup) dreamScheduler.reconcileStartup(); else dreamScheduler.reconcile();
      await dreamConsolidator.runNext();
    } catch (error) {
      diagnostics.audit('dream.tick_failed', { error: error instanceof Error ? error.message : String(error) });
    }
  };
  let activeDreamTick: Promise<void> | undefined;
  const scheduleDreamTick = (startup = false): Promise<void> => {
    if (activeDreamTick) return activeDreamTick;
    activeDreamTick = runDreamTick(startup).finally(() => { activeDreamTick = undefined; });
    return activeDreamTick;
  };
  const dreamTimer = setInterval(() => { void scheduleDreamTick(); }, 60_000);
  dreamTimer.unref();
  let activeDiskSampleTick: Promise<DiskUsageSample | undefined> | undefined;
  let activeDiskMaintenance: Promise<void> | undefined;
  let activeDiskMaintenanceAbort: AbortController | undefined;
  const scheduleDiskMaintenance = (mode: 'inventory' | 'routine' | 'pressure'): Promise<void> => {
    if (!input.config.diskPolicy.enabled) return Promise.resolve();
    if (activeDiskMaintenance) return activeDiskMaintenance;
    const abort = new AbortController();
    activeDiskMaintenanceAbort = abort;
    const timeout = setTimeout(() => {
      abort.abort(new Error(`Docker disk inventory exceeded ${input.config.diskPolicy.inventoryTimeoutMs}ms.`));
    }, input.config.diskPolicy.inventoryTimeoutMs);
    timeout.unref();
    const operation = mode === 'inventory'
      ? taskDiskCleanup.inventory(abort.signal)
      : taskDiskCleanup.run(mode === 'pressure' ? {
        mode: 'pressure', signal: abort.signal,
        continueCleanup: async () => {
          const sample = await diskLifecycle.sample();
          return sample ? !diskLifecycle.recoverySatisfied(sample) : true;
        },
      } : { mode: 'routine', signal: abort.signal });
    activeDiskMaintenance = operation
      .then(() => undefined)
      .catch((error) => diagnostics.audit('runtime.disk_maintenance_failed', {
        mode,
        error: error instanceof Error ? error.message : String(error),
      }))
      .then(() => undefined)
      .finally(() => {
        clearTimeout(timeout);
        if (activeDiskMaintenanceAbort === abort) activeDiskMaintenanceAbort = undefined;
        activeDiskMaintenance = undefined;
      });
    return activeDiskMaintenance;
  };
  const scheduleDiskSampleTick = (triggerDetailed = true): Promise<DiskUsageSample | undefined> => {
    if (!input.config.diskPolicy.enabled) return Promise.resolve(undefined);
    if (activeDiskSampleTick) return activeDiskSampleTick;
    activeDiskSampleTick = diskLifecycle.sample()
      .then(async (sample) => {
        if (!sample || !triggerDetailed) return sample;
        const level = diskLifecycle.pressureLevel(sample);
        if (level === 'warning') await scheduleDiskMaintenance('inventory');
        if (level === 'high') {
          await activeDiskMaintenance;
          const latest = await diskLifecycle.sample();
          if (latest && diskLifecycle.pressureLevel(latest) === 'high') {
            await scheduleDiskMaintenance('pressure');
          }
        }
        return sample;
      })
      .catch((error) => {
        diagnostics.audit('runtime.disk_tick_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      })
      .finally(() => { activeDiskSampleTick = undefined; });
    return activeDiskSampleTick;
  };
  const diskSampleTimer = setInterval(() => { void scheduleDiskSampleTick(); }, input.config.diskPolicy.scanIntervalMs);
  diskSampleTimer.unref();
  const diskInventoryTimer = setInterval(() => {
    void scheduleDiskMaintenance('routine');
  }, input.config.diskPolicy.inventoryIntervalMs);
  diskInventoryTimer.unref();
  if (input.config.diskPolicy.cleanupEnabled) {
    diskLifecycle.setPressureReliefHandler(async () => {
      await activeDiskMaintenance;
      const latest = await diskLifecycle.sample();
      if (latest && diskLifecycle.pressureLevel(latest) === 'high') {
        await scheduleDiskMaintenance('pressure');
      }
    });
  }

  const ambientTopicAuthorizer = new AmbientTopicAuthorizer(
    input.config,
    store,
    {
      audit: (type, data) => diagnostics.audit(type, data),
      clock,
    },
  );
  const diskOperator = new AdminDiskOperatorService(
    input.config.diskPolicy,
    input.config.upgrade.adminUsers,
    store,
    diskLifecycle,
    docker,
    taskDiskCleanup,
    diagnostics,
    clock,
  );
  return {
    retrySensitiveReply: async (message) => {
      const match = message.text.trim().match(/^\/retry-sensitive\s+([a-f0-9]{32})$/);
      return match ? { text: await sensitiveReplies.retry(match[1]!, message.userId) } : undefined;
    },
    controller: new FeishuTaskController(
      service,
      (message) => ambientTopicAuthorizer.allows(message),
      diskOperator,
      () => readCodexModelCatalog({ codexHome: input.codexHomes.project }),
      turnDetails?.store && turnDetails.resources && turnDetails.views
        ? new FeishuTurnDetailController(turnDetails.store, turnDetails.resources, turnDetails.views, input.gateway, clock, turnDetails.results,
          turnArtifacts ? { service: turnArtifacts, enqueue: (request) => {
            outbox.enqueue({ dedupeKey: `detail-artifact:${createHash('sha256').update(JSON.stringify(request)).digest('hex')}`,
              target: { chatId: request.actor.userId, receiveIdType: 'open_id' }, eventType: 'media_send',
              payload: { kind: 'turn_detail_artifact', request } });
          } } : undefined, turnDetails.telemetry, turnDetails.audit) : undefined,
    ),
    store,
    diskMaintenance: taskDiskCleanup,
    observeAmbientMessage: async (message) => {
      await ambientTopicAuthorizer.observe(message);
      if (mediaConfig.enabled && message.chatType === 'group' && !message.wasMentioned
        && message.messageId && message.resources?.length) {
        await media.capturePending({
          chatId: message.chatId, userId: message.userId, externalMessageId: message.messageId,
          ...(message.threadId ? { topicId: message.threadId } : {}), resources: message.resources,
        });
      }
    },
    allowsAmbientMessage: (message) => ambientTopicAuthorizer.allows(message),
    shouldHandleMessage: (message) => {
      const text = message.text.replace(/^(?:@\S+(?:\s+|$))*/, '').trim();
      if (/^\/disk(?:\s|$)/i.test(text) && input.config.upgrade.adminUsers.includes(message.userId)) return true;
      if (message.chatType === 'group' && !message.wasMentioned
        && !ambientTopicAuthorizer.allows(message)) return false;
      const newProject = /^\/new(?:\s+(\S+))?/i.exec(text)?.[1];
      if (/^\/new(?:\s|$)/i.test(text)) {
        const project = newProject ? input.config.projects.find((candidate) => candidate.id === newProject) : undefined;
        return taskPlatformEnabledFor(input.config, message.userId, project);
      }
      if (text === '/projects' || text === '/tasks') {
        return input.config.projects.some((project) => taskPlatformEnabledFor(input.config, message.userId, project));
      }
      if (input.config.taskPlatformRollout.conversationScopedTasks) {
        const identity = conversationTaskIdentity({
          chatId: message.chatId, chatType: message.chatType, userId: message.userId,
          ...(message.threadId ? { topicId: message.threadId } : {}),
        });
        const scope = store.getTaskScopeByKey(identity.scopeKey)
          ?? (message.chatType === 'group'
            ? store.getTaskScopeByKey(legacyConversationTaskIdentity({
              chatId: message.chatId, chatType: message.chatType, userId: message.userId,
              ...(message.threadId ? { topicId: message.threadId } : {}),
            }).scopeKey)
            : undefined);
        const task = scope ? store.getTask(scope.taskId) : undefined;
        if (task && taskMode(task) === 'chat') return taskPlatformEnabledFor(input.config, message.userId);
        if (task?.projectId && store.getDynamicProject(task.projectId)) {
          return Boolean(dynamicCatalog.resolveFor({ chatId: message.chatId, chatType: message.chatType,
            userId: message.userId, topicId: message.threadId }, task.projectId))
            && taskPlatformEnabledFor(input.config, message.userId);
        }
        const project = task ? input.config.projects.find((candidate) => candidate.id === task.projectId) : undefined;
        if (task && project) return taskPlatformProjectEnabled(input.config, project);
        if (!task && input.config.taskPlatformRollout.projectFreeChat
          && message.chatType === 'group' && message.threadId && text
          && userSandboxEnabledFor(input.config, message.userId)) {
          return taskPlatformEnabledFor(input.config, message.userId);
        }
      }
      if (userSandboxEnabledFor(input.config, message.userId) && text) {
        const actor = { chatId: message.chatId, chatType: message.chatType, userId: message.userId };
        return projectAccess.list(actor).some((project) => taskPlatformEnabledFor(input.config, message.userId, project))
          || taskPlatformEnabledFor(input.config, message.userId);
      }
      if (input.config.taskPlatformRollout.projectlessWorkspaces
        && (text || (input.config.conversationContext.enabled && message.chatType === 'group' && Boolean(message.messageId)))) {
        const actor = { chatId: message.chatId, chatType: message.chatType, userId: message.userId };
        return projectAccess.list(actor).some((project) => taskPlatformEnabledFor(input.config, message.userId, project))
          || taskPlatformEnabledFor(input.config, message.userId);
      }
      const bindingId = message.chatType === 'private'
        ? taskBindingId({ chatType: 'private', userId: message.userId })
        : taskBindingId({
          chatType: 'group', chatId: message.chatId, userId: message.userId,
          ...(message.threadId ? { topicId: message.threadId } : {}),
        });
      const binding = store.getTaskBinding(bindingId);
      const task = binding ? store.getTask(binding.taskId) : undefined;
      const project = task ? input.config.projects.find((candidate) => candidate.id === task.projectId) : undefined;
      return taskPlatformEnabledFor(input.config, message.userId, project);
    },
    healthCheck: async () => {
      const dockerHealth = await docker.healthCheck();
      if (!dockerHealth.ok) return dockerHealth;
      const health = diagnostics.health(Boolean(input.config.taskPlatformRollout.managedMemory));
      return health.ok ? { ok: true } : { ok: false, reason: 'Task-platform SQLite or managed-memory integrity check failed.' };
    },
    recoverStartup: async () => {
      if (!input.config.liveCards.enabled) await cardRecovery.recoverFinalizations();
      console.info('startup.task_recovery.phase=tasks');
      await service.recoverStartup();
      await service.recoverProjectCreations();
      console.info('startup.task_recovery.phase=auth');
      await authBroker.recoverPendingResumes();
      console.info('startup.task_recovery.phase=cards');
      await turnExperience?.recoverOpenCards('task_platform', async (record) => {
        const turn = store.getTurn(record.localTurnId);
        if (!turn) return { status: 'interrupted' };
        if (turn.state === 'completed') return {
          status: 'completed',
          answer: record.snapshot?.finalAnswer ?? '任务已完成，最终结果已通过任务消息送达。',
        };
        if (turn.state === 'failed') return { status: 'failed', answer: turn.failure };
        return { status: 'interrupted' };
      });
      if (input.config.readyPool.enabled) {
        console.info('startup.task_recovery.phase=ready_pool');
        await Promise.all(input.config.projects
          .filter((project) => taskPlatformEnabledFor(input.config, input.config.taskPlatformRollout.enabledOwners[0] ?? '', project))
          .map(async (project) => {
            const versionKey = await readyRuntime.registerProject(project);
            await readyPool.replenish(versionKey);
          }));
      }
      console.info('startup.task_recovery.phase=dream');
      await scheduleDreamTick(true);
      console.info('startup.task_recovery.phase=disk_sample');
      const startupDiskSample = await scheduleDiskSampleTick(false);
      if (input.config.diskPolicy.enabled) {
        const mode = startupDiskSample && diskLifecycle.pressureLevel(startupDiskSample) === 'high'
          ? 'pressure' as const : 'routine' as const;
        void scheduleDiskMaintenance(mode);
      }
      console.info('startup.task_recovery.phase=outbox');
      await approvals.recover();
      try { turnDetails.maintain(); } catch { /* Keep startup independent of detail cleanup. */ }
      await outbox.flush();
      diagnostics.refreshMetrics();
      await sampleIdleMemory();
      await scheduleUserSandboxReclaim();
    },
    close: async () => {
      await service.waitForProjectCreations();
      clearInterval(timer);
      clearInterval(mediaCleanupTimer);
      clearInterval(detailMaintenanceTimer);
      clearInterval(stalledTurnTimer);
      clearInterval(submittedTurnTimer);
      clearInterval(memoryTimer);
      clearInterval(userSandboxReclaimTimer);
      clearInterval(dreamTimer);
      clearInterval(diskSampleTimer);
      clearInterval(diskInventoryTimer);
      cardRecovery.dispose();
      unsubscribeApprovalState();
      unsubscribeApprovalDelivery();
      approvals.dispose();
      appServerCardStore.close();
      await turnDetails?.close();
      await activeDreamTick;
      activeDiskMaintenanceAbort?.abort(new Error('Task platform is shutting down.'));
      await activeDiskSampleTick;
      await activeDiskMaintenance;
      await activeUserSandboxReclaim;
      store.close();
    },
  };
}

function resolveOptionalAuthFile(codexHome: string): string | undefined {
  try {
    return realpathSync(join(codexHome, 'auth.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function safeToolAuthResumeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]')
    .replace(/("(?:access_token|refresh_token|device_code|app_secret)"\s*:\s*")[^"]+/gi, '$1[redacted]')
    .slice(0, 1_000);
}

function userSandboxEnabledFor(config: BotConfig, ownerUserId: string): boolean {
  const rollout = config.userSandboxes;
  return Boolean(
    rollout?.enabled
    && (rollout.enabledOwners.length === 0 || rollout.enabledOwners.includes(ownerUserId))
,
  );
}

function migrateWorkerExecutionDefaults(store: SqliteStateStore, config: BotConfig, clock: () => Date): void {
  const worker = completeExecutionProfile(config.codex.executionProfiles.worker, undefined, 'worker-default');
  for (const task of store.listTasks()) {
    const state = task.executionProfile;
    const legacySystemDefault = state?.configured.source === 'global'
      || (state?.configured.model === 'gpt-5.6-luna'
        && (state.configured.source === 'worker-default' || state.configured.source === 'workflow-override'))
      || (!state && (!task.model || task.model === 'gpt-5.6-sol' || task.model === 'gpt-5.6-luna')
        && (!task.reasoningEffort || task.reasoningEffort === 'medium'));
    if (!legacySystemDefault) continue;
    const now = clock().toISOString();
    const prior = taskExecutionProfile(task, now);
    store.updateTask(task.id, (current) => ({
      ...current,
      model: worker.model,
      reasoningEffort: worker.reasoningEffort,
      executionProfile: current.activeTurnId ? {
        configured: worker,
        effective: prior.effective,
        pending: { ...worker, applyFromNextTurn: true, requestedAt: now },
      } : {
        configured: worker,
        effective: { ...worker, confirmedAt: now },
      },
      updatedAt: now,
    }));
  }
}

export function runtimeProxyEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of [
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
    'GOPROXY', 'GOPRIVATE', 'GONOPROXY', 'GONOSUMDB', 'GOSUMDB',
  ] as const) {
    const value = env[name] ?? env[name.toLowerCase()];
    if (value) result[name] = value;
  }
  return result;
}
