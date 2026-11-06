import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveInlineTimelineLimit } from '../details/InlineTimelineLimits.js';
import type { BotConfig,ProjectConfig } from '../domain/types.js';
import { parseLogLevel } from '../logging/AppLogger.js';
import { DEFAULT_DISPLAY_TIME_ZONE,isValidDisplayTimeZone } from '../output/DisplayTimeFormatter.js';

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid config field: ${field}`);
  }
  return value;
}

function requireHttpsUrl(value: unknown, field: string): string {
  const raw = requireString(value, field);
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('unsafe URL');
    return parsed.toString();
  } catch {
    throw new Error(`Invalid config field: ${field}`);
  }
}

function requireProjectId(value: unknown): string {
  const id = requireString(value, 'projects[].id');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id)) throw new Error('Invalid config field: projects[].id');
  return id;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`Invalid config field: ${field}`);
  }
  return value;
}

function optionalStringArray(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }
  return requireStringArray(value, field);
}

function optionalString(value: unknown, defaultValue: string, field: string): string {
  if (value === undefined) {
    return defaultValue;
  }
  return requireString(value, field);
}

function requirePositiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid config field: ${field}`);
  }
  return value;
}

function optionalBoolean(value: unknown, defaultValue: boolean, field: string): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid config field: ${field}`);
  }
  return value;
}

function optionalPositiveNumber(value: unknown, defaultValue: number, field: string): number {
  if (value === undefined) {
    return defaultValue;
  }
  return requirePositiveNumber(value, field);
}

function optionalRefreshInterval(value: unknown, defaultValue: number, field: string): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1000) {
    throw new Error(`Invalid config field: ${field}`);
  }
  return value;
}

function optionalLogLevel(value: unknown, defaultValue: BotConfig['logLevel'], field: string): BotConfig['logLevel'] {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== 'string') {
    throw new Error(`Invalid config field: ${field}`);
  }
  const parsed = parseLogLevel(value);
  if (parsed !== value.trim().toLowerCase()) {
    throw new Error(`Invalid config field: ${field}`);
  }
  return parsed;
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid config field: ${field}`);
  }
  return value as Record<string, unknown>;
}

function normalizeProject(value: unknown, projectRoot: string): ProjectConfig {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid config field: projects');
  }
  const item = value as Record<string, unknown>;
  const access = item.access === undefined ? undefined : optionalRecord(item.access, 'projects[].access');
  return {
    id: requireProjectId(item.id),
    name: requireString(item.name, 'projects[].name'),
    path: resolve(projectRoot, requireString(item.path, 'projects[].path')),
    ...(item.repositoryPath === undefined ? {} : {
      repositoryPath: requireRepositoryPath(item.repositoryPath, 'projects[].repositoryPath'),
    }),
    ...(item.sandboxCloneUrl === undefined ? {} : {
      sandboxCloneUrl: requireSandboxCloneUrl(item.sandboxCloneUrl),
    }),
    codexArgs: item.codexArgs === undefined ? [] : requireStringArray(item.codexArgs, 'projects[].codexArgs'),
    baseRef: optionalString(item.baseRef, 'main', 'projects[].baseRef'),
    ...(item.description === undefined ? {} : { description: requireString(item.description, 'projects[].description') }),
    ...(item.instructions === undefined ? {} : { instructions: requireStringArray(item.instructions, 'projects[].instructions') }),
    ...(access ? { access: {
      allowedUsers: optionalStringArray(access.allowedUsers, 'projects[].access.allowedUsers'),
      allowedChats: optionalStringArray(access.allowedChats, 'projects[].access.allowedChats'),
      knowledgeApprovers: optionalStringArray(access.knowledgeApprovers, 'projects[].access.knowledgeApprovers'),
    } } : {}),
    ...(item.runtimeBackend === undefined
      ? {}
      : { runtimeBackend: optionalRuntimeBackend(item.runtimeBackend, 'app-server', 'projects[].runtimeBackend') }),
  };
}

function requireRepositoryPath(value: unknown, field: string): string {
  const path = requireString(value, field).replace(/^\/+|\/+$/g, '');
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/.test(path)) throw new Error(`Invalid config field: ${field}`);
  return path;
}

function requireSandboxCloneUrl(value: unknown): string {
  const url = requireString(value, 'projects[].sandboxCloneUrl');
  if (/^git@(?:github\.com):[A-Za-z0-9._/-]+(?:\.git)?$/.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password
      && ['github.com'].includes(parsed.hostname)
      && /^\/[A-Za-z0-9._/-]+(?:\.git)?$/.test(parsed.pathname) && !parsed.search && !parsed.hash) return url;
  } catch {}
  throw new Error('Invalid config field: projects[].sandboxCloneUrl');
}

export function runtimeBackendForProject(config: BotConfig, project: ProjectConfig): 'app-server' {
  return project.runtimeBackend ?? config.runtime?.backend ?? 'app-server';
}


export async function loadConfig(projectRoot: string): Promise<BotConfig> {
  const raw = JSON.parse(await readFile(resolve(projectRoot, '.link-bot/config.json'), 'utf8')) as unknown;
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Invalid config structure');
  }
  const record = raw as Record<string, unknown>;
  const feishu = record.feishu as Record<string, unknown> | undefined;
  const output = record.output as Record<string, unknown> | undefined;
  const codex = record.codex as Record<string, unknown> | undefined;
  const ui = optionalRecord(record.ui, 'ui');
  const notifications = optionalRecord(record.notifications, 'notifications');
  const liveCards = optionalRecord(record.liveCards, 'liveCards');
  const runtime = optionalRecord(record.runtime, 'runtime');
  const taskPool = optionalRecord(record.taskPool, 'taskPool');
  const readyPool = optionalRecord(record.readyPool, 'readyPool');
  const diskPolicy = optionalRecord(record.diskPolicy, 'diskPolicy');
  const memory = optionalRecord(record.memory, 'memory');
  const conversationContext = optionalRecord(record.conversationContext, 'conversationContext');
  const conversationRouting = optionalRecord(record.conversationRouting, 'conversationRouting');
  const linkApprovalAutomation = optionalRecord(record.linkApprovalAutomation, 'linkApprovalAutomation');
  const dream = optionalRecord(record.dream, 'dream');
  const taskPlatformRollout = optionalRecord(record.taskPlatformRollout, 'taskPlatformRollout');
  const userSandboxes = optionalRecord(record.userSandboxes, 'userSandboxes');
  const upgrade = optionalRecord(record.upgrade, 'upgrade');
  const codexHooks = optionalRecord(record.codexHooks, 'codexHooks');
  const hostControl = optionalRecord(record.hostControl, 'hostControl');
  const media = optionalRecord(record.media, 'media');
  const executionProfiles = optionalRecord(codex?.executionProfiles, 'codex.executionProfiles');
  if (!feishu || !output || !codex || !Array.isArray(record.projects)) {
    throw new Error('Invalid config structure');
  }

  const projects = record.projects.map((project) => normalizeProject(project, projectRoot));
  const ids = new Set<string>();
  for (const project of projects) {
    if (ids.has(project.id)) {
      throw new Error(`Duplicate project id: ${project.id}`);
    }
    ids.add(project.id);
  }

  const normalizedTaskPool = normalizeTaskPool(taskPool);
  const normalizedMemory = normalizeMemory(memory);
  const normalizedDream = normalizeDream(dream);
  const normalizedRollout = normalizeTaskPlatformRollout(taskPlatformRollout);
  const normalizedUpgrade = normalizeUpgrade(upgrade);
  const normalizedHostControl = {
    enabled: optionalBoolean(hostControl.enabled, false, 'hostControl.enabled'),
    adminUsers: optionalStringArray(hostControl.adminUsers, 'hostControl.adminUsers'),
    projectId: optionalString(hostControl.projectId, 'link-bot', 'hostControl.projectId'),
    socketPath: resolve(projectRoot, optionalString(hostControl.socketPath, '.link-bot/host-control.sock', 'hostControl.socketPath')),
    managerProcessName: optionalString(hostControl.managerProcessName, 'link-bot-host-manager', 'hostControl.managerProcessName'),
  };
  if (normalizedHostControl.enabled && !projects.some((project) => project.id === normalizedHostControl.projectId)) {
    throw new Error(`Invalid config field: hostControl.projectId: project not found: ${normalizedHostControl.projectId}`);
  }
  if (normalizedHostControl.adminUsers.some((userId) => !normalizedUpgrade.adminUsers.includes(userId))) {
    throw new Error('Invalid config field: hostControl.adminUsers must be a subset of upgrade.adminUsers');
  }
  if (normalizedRollout.projectlessWorkspaces
    && (!normalizedRollout.conversationScopedTasks || !normalizedRollout.multiRepositoryTasks)) {
    throw new Error('Invalid config field: projectlessWorkspaces requires conversationScopedTasks and multiRepositoryTasks');
  }
  if (normalizedDream.maxInteractiveActiveTurns + normalizedDream.maxConcurrency > normalizedTaskPool.maxActiveTurns) {
    throw new Error('Invalid config field: Dream capacity must preserve interactive ACTIVE-turn capacity');
  }
  if (normalizedRollout.nightlyDream && (!normalizedRollout.managedMemory || !normalizedDream.enabled)) {
    throw new Error('Invalid config field: nightlyDream requires managedMemory and dream.enabled');
  }
  if (normalizedRollout.botGlobalMemory && (!normalizedRollout.managedMemory
    || new Set([...normalizedDream.administratorIds, ...normalizedUpgrade.adminUsers]).size === 0)) {
    throw new Error('Invalid config field: botGlobalMemory requires managedMemory and at least one administrator');
  }
  return {
    feishu: {
      appId: requireString(feishu.appId, 'feishu.appId'),
      appSecret: requireString(feishu.appSecret, 'feishu.appSecret'),
    },
    restrictUsers: optionalBoolean(record.restrictUsers, false, 'restrictUsers'),
    allowUnlistedGroupUsers: optionalBoolean(
      record.allowUnlistedGroupUsers, false, 'allowUnlistedGroupUsers',
    ),
    restrictChatIds: optionalBoolean(record.restrictChatIds, false, 'restrictChatIds'),
    allowedUsers: optionalStringArray(record.allowedUsers, 'allowedUsers'),
    allowedChatIds: optionalStringArray(record.allowedChatIds, 'allowedChatIds'),
    gitIdentities: normalizeGitIdentities(record.gitIdentities),
    hostControl: normalizedHostControl,
    projects,
    output: {
      directMaxChars: requirePositiveNumber(output.directMaxChars, 'output.directMaxChars'),
      chunkSize: requirePositiveNumber(output.chunkSize, 'output.chunkSize'),
    },
    codex: {
      command: requireString(codex.command, 'codex.command'),
      defaultArgs: codex.defaultArgs === undefined ? [] : requireStringArray(codex.defaultArgs, 'codex.defaultArgs'),
      isolateSessions: optionalBoolean(codex.isolateSessions, true, 'codex.isolateSessions'),
      executionProfiles: {
        host: normalizeExecutionProfile(executionProfiles.host, {
          model: 'gpt-6.1-sol', reasoningEffort: 'medium', serviceTier: 'default',
        }, 'codex.executionProfiles.host'),
        worker: normalizeExecutionProfile(executionProfiles.worker, {
          model: 'gpt-6.1-sol', reasoningEffort: 'medium', serviceTier: 'default',
        }, 'codex.executionProfiles.worker'),
      },
    },
    logLevel: optionalLogLevel(record.logLevel, 'info', 'logLevel'),
    ui: {
      verbosity: ui.verbosity === undefined ? 'normal' : requireUiVerbosity(ui.verbosity, 'ui.verbosity'),
      currentRenderMode:
        ui.currentRenderMode === undefined
          ? 'code'
          : requireCurrentRenderMode(ui.currentRenderMode, 'ui.currentRenderMode'),
      timeZone:
        ui.timeZone === undefined ? DEFAULT_DISPLAY_TIME_ZONE : requireDisplayTimeZone(ui.timeZone, 'ui.timeZone'),
    },
    notifications: {
      enabled: optionalBoolean(notifications.enabled, true, 'notifications.enabled'),
      idleMs: optionalPositiveNumber(notifications.idleMs, 3000, 'notifications.idleMs'),
      maxFinalChars: optionalPositiveNumber(notifications.maxFinalChars, 8000, 'notifications.maxFinalChars'),
      failureTailChars: optionalPositiveNumber(notifications.failureTailChars, 2000, 'notifications.failureTailChars'),
    },
    liveCards: {
      inlineDetailsEnabled: optionalBoolean(liveCards.inlineDetailsEnabled, false, 'liveCards.inlineDetailsEnabled'),
      inlineTimelineMaxItems: resolveInlineTimelineLimit(liveCards.inlineTimelineMaxItems),
      detailsEnabled: optionalBoolean(liveCards.detailsEnabled, false, 'liveCards.detailsEnabled'),
      enabled: optionalBoolean(liveCards.enabled, true, 'liveCards.enabled'),
      refreshIntervalMs: optionalRefreshInterval(liveCards.refreshIntervalMs, 1000, 'liveCards.refreshIntervalMs'),
    },
    sensitiveReplyDeliveryEnabled: optionalBoolean(record.sensitiveReplyDeliveryEnabled, true, 'sensitiveReplyDeliveryEnabled'),
    runtime: normalizeRuntime(runtime, projectRoot),
    userSandboxes: normalizeUserSandboxes(userSandboxes),
    taskPool: normalizedTaskPool,
    readyPool: normalizeReadyPool(readyPool),
    diskPolicy: normalizeDiskPolicy(diskPolicy, projectRoot),
    memory: normalizedMemory,
    conversationContext: normalizeConversationContext(conversationContext),
    conversationRouting: normalizeConversationRouting(conversationRouting),
    dream: normalizedDream,
    taskPlatformRollout: normalizedRollout,
    upgrade: normalizedUpgrade,
    codexHooks: {
      enabled: optionalBoolean(codexHooks.enabled, false, 'codexHooks.enabled'),
      autoRepair: optionalBoolean(codexHooks.autoRepair, false, 'codexHooks.autoRepair'),
      socketPath: optionalString(codexHooks.socketPath, '.link-bot/codex-hooks.sock', 'codexHooks.socketPath'),
      permissionTimeoutMs: optionalPositiveNumber(codexHooks.permissionTimeoutMs, 300000, 'codexHooks.permissionTimeoutMs'),
      adminUsers: optionalStringArray(codexHooks.adminUsers, 'codexHooks.adminUsers'),
    },
    media: {
      enabled: optionalBoolean(media.enabled, false, 'media.enabled'),
      storageRoot: resolve(projectRoot, optionalString(media.storageRoot, '.link-bot/media-store', 'media.storageRoot')),
      maxImagesPerTurn: optionalPositiveInteger(media.maxImagesPerTurn, 8, 'media.maxImagesPerTurn'),
      maxFilesPerTurn: optionalPositiveInteger(media.maxFilesPerTurn, 10, 'media.maxFilesPerTurn'),
      maxImageBytes: optionalPositiveInteger(media.maxImageBytes, 10_485_760, 'media.maxImageBytes'),
      maxFileBytes: optionalPositiveInteger(media.maxFileBytes, 52_428_800, 'media.maxFileBytes'),
      maxTotalBytesPerTurn: optionalPositiveInteger(media.maxTotalBytesPerTurn, 104_857_600, 'media.maxTotalBytesPerTurn'),
      pendingGroupAttachmentTtlMs: optionalPositiveInteger(
        media.pendingGroupAttachmentTtlMs, 300_000, 'media.pendingGroupAttachmentTtlMs',
      ),
      retentionHours: optionalPositiveInteger(media.retentionHours, 24, 'media.retentionHours'),
    },
  };
}

function normalizeUserSandboxes(record: Record<string, unknown>): NonNullable<BotConfig['userSandboxes']> {
  return {
    enabled: optionalBoolean(record.enabled, false, 'userSandboxes.enabled'),
    enabledOwners: optionalStringArray(record.enabledOwners, 'userSandboxes.enabledOwners'),
    legacyFallbackEnabled: optionalBoolean(record.legacyFallbackEnabled, true, 'userSandboxes.legacyFallbackEnabled'),
    maxAppServersPerUser: optionalPositiveInteger(record.maxAppServersPerUser, 8, 'userSandboxes.maxAppServersPerUser'),
    maxActiveTurnsPerUser: optionalPositiveInteger(record.maxActiveTurnsPerUser, 4, 'userSandboxes.maxActiveTurnsPerUser'),
    processIdleTimeoutMinutes: optionalPositiveInteger(record.processIdleTimeoutMinutes, 120, 'userSandboxes.processIdleTimeoutMinutes'),
    containerIdleTimeoutMinutes: optionalPositiveInteger(record.containerIdleTimeoutMinutes, 1_440, 'userSandboxes.containerIdleTimeoutMinutes'),
    containerWrapperRetentionHours: optionalPositiveInteger(record.containerWrapperRetentionHours, 24, 'userSandboxes.containerWrapperRetentionHours'),
    resourceOverrides: normalizeUserSandboxResourceOverrides(record.resourceOverrides),
  };
}

function normalizeUserSandboxResourceOverrides(value: unknown): NonNullable<NonNullable<BotConfig['userSandboxes']>['resourceOverrides']> {
  if (value === undefined) return {};
  const entries = optionalRecord(value, 'userSandboxes.resourceOverrides');
  const result: NonNullable<NonNullable<BotConfig['userSandboxes']>['resourceOverrides']> = {};
  for (const [ownerId, raw] of Object.entries(entries)) {
    if (!/^ou_[A-Za-z0-9]{1,128}$/.test(ownerId)) {
      throw new Error(`Invalid config field: userSandboxes.resourceOverrides.${ownerId}`);
    }
    const override = optionalRecord(raw, `userSandboxes.resourceOverrides.${ownerId}`);
    result[ownerId] = {
      ...(override.cpuLimit !== undefined ? { cpuLimit: optionalPositiveNumber(override.cpuLimit, 4, `userSandboxes.resourceOverrides.${ownerId}.cpuLimit`) } : {}),
      ...(override.memoryLimitBytes !== undefined ? { memoryLimitBytes: optionalPositiveInteger(override.memoryLimitBytes, 8_589_934_592, `userSandboxes.resourceOverrides.${ownerId}.memoryLimitBytes`) } : {}),
    };
  }
  return result;
}

function normalizeExecutionProfile(
  value: unknown,
  defaults: { model: string; reasoningEffort: string; serviceTier: 'default' | 'fast' },
  field: string,
): { model: string; reasoningEffort: string; serviceTier: 'default' | 'fast' } {
  const profile = optionalRecord(value, field);
  const serviceTier = profile.serviceTier === undefined ? defaults.serviceTier : profile.serviceTier;
  if (serviceTier !== 'default' && serviceTier !== 'fast') throw new Error(`Invalid config field: ${field}.serviceTier`);
  return {
    model: optionalString(profile.model, defaults.model, `${field}.model`),
    reasoningEffort: optionalString(profile.reasoningEffort, defaults.reasoningEffort, `${field}.reasoningEffort`),
    serviceTier,
  };
}

function normalizeGitIdentities(value: unknown): BotConfig['gitIdentities'] {
  if (value === undefined) return {};
  const record = optionalRecord(value, 'gitIdentities');
  return Object.fromEntries(Object.entries(record).map(([userId, rawIdentity]) => {
    const identity = optionalRecord(rawIdentity, `gitIdentities.${userId}`);
    return [userId, {
      name: requireString(identity.name, `gitIdentities.${userId}.name`),
      email: requireString(identity.email, `gitIdentities.${userId}.email`),
    }];
  }));
}

function requireNumericId(value: unknown, field: string): string {
  const id = requireString(value, field);
  if (!/^\d+$/.test(id)) throw new Error(`Invalid config field: ${field}`);
  return id;
}

function normalizeConversationContext(record: Record<string, unknown>): BotConfig['conversationContext'] {
  const group = optionalRecord(record.group, 'conversationContext.group');
  const topic = optionalRecord(record.topic, 'conversationContext.topic');
  return {
    enabled: optionalBoolean(record.enabled, false, 'conversationContext.enabled'),
    group: {
      maxMessages: optionalPositiveInteger(group.maxMessages, 50, 'conversationContext.group.maxMessages'),
      lookbackHours: optionalPositiveNumber(group.lookbackHours, 24, 'conversationContext.group.lookbackHours'),
      maxChars: optionalPositiveInteger(group.maxChars, 16_000, 'conversationContext.group.maxChars'),
    },
    topic: {
      maxMessages: optionalPositiveInteger(topic.maxMessages, 100, 'conversationContext.topic.maxMessages'),
      maxChars: optionalPositiveInteger(topic.maxChars, 20_000, 'conversationContext.topic.maxChars'),
    },
    requestTimeoutMs: optionalPositiveInteger(record.requestTimeoutMs, 5_000, 'conversationContext.requestTimeoutMs'),
    incremental: optionalBoolean(record.incremental, true, 'conversationContext.incremental'),
    includeMediaPlaceholders: optionalBoolean(
      record.includeMediaPlaceholders, true, 'conversationContext.includeMediaPlaceholders',
    ),
  };
}

function normalizeConversationRouting(record: Record<string, unknown>): BotConfig['conversationRouting'] {
  const values = record.ambientChats === undefined ? [] : record.ambientChats;
  if (!Array.isArray(values)) throw new Error('Invalid config field: conversationRouting.ambientChats');
  const seen = new Set<string>();
  return {
    ambientChats: values.map((value, index) => {
      const field = `conversationRouting.ambientChats[${index}]`;
      const entry = optionalRecord(value, field);
      const chatId = requireString(entry.chatId, `${field}.chatId`);
      if (seen.has(chatId)) throw new Error(`Duplicate ambient chat id: ${chatId}`);
      seen.add(chatId);
      return {
        chatId,
        ...(entry.name === undefined ? {} : { name: requireString(entry.name, `${field}.name`) }),
      };
    }),
  };
}

function normalizeMemory(record: Record<string, unknown>): NonNullable<BotConfig['memory']> {
  const config = {
    catalogMaxTokens: optionalPositiveInteger(record.catalogMaxTokens, 1_000, 'memory.catalogMaxTokens'),
    automaticRecallMaxTokens: optionalPositiveInteger(record.automaticRecallMaxTokens, 1_500, 'memory.automaticRecallMaxTokens'),
    singleReadMaxTokens: optionalPositiveInteger(record.singleReadMaxTokens, 1_500, 'memory.singleReadMaxTokens'),
    totalContextRatio: optionalRatio(record.totalContextRatio, 0.1, 'memory.totalContextRatio'),
  };
  if (config.totalContextRatio > 0.1) throw new Error('Invalid config field: memory.totalContextRatio cannot exceed 0.10');
  if (Math.max(config.catalogMaxTokens, config.automaticRecallMaxTokens, config.singleReadMaxTokens) > 8_000) {
    throw new Error('Invalid config field: memory token budgets cannot exceed 8000');
  }
  return config;
}

function normalizeDream(record: Record<string, unknown>): NonNullable<BotConfig['dream']> {
  const timezone = optionalString(record.timezone, 'Asia/Shanghai', 'dream.timezone');
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  } catch {
    throw new Error('Invalid config field: dream.timezone');
  }
  const startAfter = optionalString(record.startAfter, '02:00', 'dream.startAfter');
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(startAfter)) throw new Error('Invalid config field: dream.startAfter');
  const config = {
    enabled: optionalBoolean(record.enabled, false, 'dream.enabled'), timezone, startAfter,
    maxConcurrency: optionalPositiveInteger(record.maxConcurrency, 1, 'dream.maxConcurrency'),
    maxInteractiveActiveTurns: optionalNonnegativeInteger(record.maxInteractiveActiveTurns, 2, 'dream.maxInteractiveActiveTurns'),
    batchMaxEvents: optionalPositiveInteger(record.batchMaxEvents, 100, 'dream.batchMaxEvents'),
    batchMaxChars: optionalPositiveInteger(record.batchMaxChars, 24_000, 'dream.batchMaxChars'),
    administratorIds: optionalStringArray(record.administratorIds, 'dream.administratorIds'),
  };
  if (config.maxConcurrency !== 1) throw new Error('Invalid config field: dream.maxConcurrency must be 1');
  if (config.batchMaxChars < 1_000) throw new Error('Invalid config field: dream.batchMaxChars must be at least 1000');
  return config;
}

function normalizeRuntime(record: Record<string, unknown>, projectRoot: string): BotConfig['runtime'] {
  return {
    backend: optionalRuntimeBackend(record.backend, 'app-server', 'runtime.backend'),
    image: optionalString(record.image, 'link-bot-runtime:0.1', 'runtime.image'),
    codexCliVersion: optionalString(record.codexCliVersion, '0.161.0', 'runtime.codexCliVersion'),
    socketRoot: resolve(projectRoot, optionalString(record.socketRoot, '.link-bot/task-sockets', 'runtime.socketRoot')),
    statePath: resolve(projectRoot, optionalString(record.statePath, '.link-bot/task-platform.sqlite', 'runtime.statePath')),
    stagingRoot: resolve(projectRoot, optionalString(record.stagingRoot, '.link-bot/task-staging', 'runtime.stagingRoot')),
    taskCpuLimit: optionalPositiveNumber(record.taskCpuLimit, 4, 'runtime.taskCpuLimit'),
    taskMemoryLimitBytes: optionalPositiveInteger(record.taskMemoryLimitBytes, 8_589_934_592, 'runtime.taskMemoryLimitBytes'),
    taskPidLimit: optionalPidLimit(record.taskPidLimit, 512, 'runtime.taskPidLimit'),
    taskTmpfsLimitBytes: optionalPositiveInteger(record.taskTmpfsLimitBytes, 2_147_483_648, 'runtime.taskTmpfsLimitBytes'),
    appServerMaxFrameBytes: optionalPositiveInteger(record.appServerMaxFrameBytes, 67_108_864, 'runtime.appServerMaxFrameBytes'),
    taskNetwork: optionalString(record.taskNetwork, 'bridge', 'runtime.taskNetwork'),
    isolationVerified: optionalBoolean(record.isolationVerified, false, 'runtime.isolationVerified'),
    sharedAuthRiskAccepted: optionalBoolean(record.sharedAuthRiskAccepted, false, 'runtime.sharedAuthRiskAccepted'),
    nativeGitExecution: optionalBoolean(record.nativeGitExecution, false, 'runtime.nativeGitExecution'),
    managerGitToolFallback: optionalBoolean(record.managerGitToolFallback, true, 'runtime.managerGitToolFallback'),
  };
}

function normalizeTaskPlatformRollout(record: Record<string, unknown>): BotConfig['taskPlatformRollout'] {
  return {
    enabled: optionalBoolean(record.enabled, true, 'taskPlatformRollout.enabled'),
    enabledOwners: optionalStringArray(record.enabledOwners, 'taskPlatformRollout.enabledOwners'),
    enabledProjects: optionalStringArray(record.enabledProjects, 'taskPlatformRollout.enabledProjects'),
    appServerDefault: optionalBoolean(record.appServerDefault, true, 'taskPlatformRollout.appServerDefault'),
    multiUserEnabled: optionalBoolean(record.multiUserEnabled, false, 'taskPlatformRollout.multiUserEnabled'),
    conversationScopedTasks: optionalBoolean(record.conversationScopedTasks, false, 'taskPlatformRollout.conversationScopedTasks'),
    multiRepositoryTasks: optionalBoolean(record.multiRepositoryTasks, false, 'taskPlatformRollout.multiRepositoryTasks'),
    managedMemory: optionalBoolean(record.managedMemory, false, 'taskPlatformRollout.managedMemory'),
    // Kept as a read-compatible no-op. Context compaction belongs to Codex;
    // link_bot must never rotate a thread based on token accounting.
    automaticContextRotation: optionalBoolean(record.automaticContextRotation, false, 'taskPlatformRollout.automaticContextRotation'),
    nightlyDream: optionalBoolean(record.nightlyDream, false, 'taskPlatformRollout.nightlyDream'),
    botGlobalMemory: optionalBoolean(record.botGlobalMemory, false, 'taskPlatformRollout.botGlobalMemory'),
    projectlessWorkspaces: optionalBoolean(record.projectlessWorkspaces, false, 'taskPlatformRollout.projectlessWorkspaces'),
    projectFreeChat: optionalBoolean(record.projectFreeChat, false, 'taskPlatformRollout.projectFreeChat'),
    projectSwitchingEnabled: optionalBoolean(record.projectSwitchingEnabled, false, 'taskPlatformRollout.projectSwitchingEnabled'),
    projectContinuationInputHandoffEnabled: optionalBoolean(record.projectContinuationInputHandoffEnabled, true, 'taskPlatformRollout.projectContinuationInputHandoffEnabled'),
  };
}

function requireIsoDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`Invalid config field: ${field}`);
  return value;
}

function normalizeTaskPool(record: Record<string, unknown>): BotConfig['taskPool'] {
  const config: BotConfig['taskPool'] = {
    maxHotTasks: optionalPositiveInteger(record.maxHotTasks, 6, 'taskPool.maxHotTasks'),
    maxActiveTurns: optionalPositiveInteger(record.maxActiveTurns, 4, 'taskPool.maxActiveTurns'),
    memoryHighWatermark: optionalRatio(record.memoryHighWatermark, 0.8, 'taskPool.memoryHighWatermark'),
    memoryLowWatermark: optionalRatio(record.memoryLowWatermark, 0.65, 'taskPool.memoryLowWatermark'),
    safetyReserveBytes: optionalPositiveInteger(record.safetyReserveBytes, 2_147_483_648, 'taskPool.safetyReserveBytes'),
    idleMemorySampleWindowDays: optionalPositiveInteger(record.idleMemorySampleWindowDays, 7, 'taskPool.idleMemorySampleWindowDays'),
  };
  if (config.memoryLowWatermark >= config.memoryHighWatermark) {
    throw new Error('Invalid config field: taskPool memory low watermark must be below high watermark');
  }
  if (config.maxActiveTurns > config.maxHotTasks) {
    throw new Error('Invalid config field: taskPool.maxActiveTurns cannot exceed taskPool.maxHotTasks');
  }
  return config;
}

function normalizeReadyPool(record: Record<string, unknown>): BotConfig['readyPool'] {
  const config: BotConfig['readyPool'] = {
    enabled: optionalBoolean(record.enabled, true, 'readyPool.enabled'),
    defaultMinReady: optionalNonnegativeInteger(record.defaultMinReady, 1, 'readyPool.defaultMinReady'),
    defaultMaxReady: optionalNonnegativeInteger(record.defaultMaxReady, 2, 'readyPool.defaultMaxReady'),
  };
  if (config.defaultMinReady > config.defaultMaxReady) {
    throw new Error('Invalid config field: readyPool.defaultMinReady cannot exceed readyPool.defaultMaxReady');
  }
  return config;
}

function normalizeDiskPolicy(record: Record<string, unknown>, projectRoot: string): BotConfig['diskPolicy'] {
  const config: BotConfig['diskPolicy'] = {
    enabled: optionalBoolean(record.enabled, false, 'diskPolicy.enabled'),
    filesystemPath: resolve(projectRoot, optionalString(record.filesystemPath, '/var/lib/docker', 'diskPolicy.filesystemPath')),
    scanIntervalMs: optionalPositiveInteger(record.scanIntervalMs, 900_000, 'diskPolicy.scanIntervalMs'),
    inventoryIntervalMs: optionalPositiveInteger(record.inventoryIntervalMs, 21_600_000, 'diskPolicy.inventoryIntervalMs'),
    inventoryTimeoutMs: optionalPositiveInteger(record.inventoryTimeoutMs, 300_000, 'diskPolicy.inventoryTimeoutMs'),
    warningWatermark: optionalRatio(record.warningWatermark, 0.70, 'diskPolicy.warningWatermark'),
    highWatermark: optionalRatio(record.highWatermark, 0.80, 'diskPolicy.highWatermark'),
    lowWatermark: optionalRatio(record.lowWatermark, 0.65, 'diskPolicy.lowWatermark'),
    minimumFreeBytes: optionalPositiveInteger(record.minimumFreeBytes, 21_474_836_480, 'diskPolicy.minimumFreeBytes'),
    attributionEnabled: optionalBoolean(record.attributionEnabled, false, 'diskPolicy.attributionEnabled'),
    cleanupEnabled: optionalBoolean(record.cleanupEnabled, false, 'diskPolicy.cleanupEnabled'),
    taskSoftLimitBytes: optionalPositiveInteger(record.taskSoftLimitBytes, 21_474_836_480, 'diskPolicy.taskSoftLimitBytes'),
    userSoftLimitBytes: optionalPositiveInteger(record.userSoftLimitBytes, 107_374_182_400, 'diskPolicy.userSoftLimitBytes'),
    warmRetentionDays: optionalPositiveInteger(record.warmRetentionDays, 7, 'diskPolicy.warmRetentionDays'),
    warmRetentionWarningDays: optionalPositiveInteger(record.warmRetentionWarningDays, 3, 'diskPolicy.warmRetentionWarningDays'),
    autoDeleteWarmTasks: optionalBoolean(record.autoDeleteWarmTasks, false, 'diskPolicy.autoDeleteWarmTasks'),
    maxCleanupTasksPerPass: optionalPositiveInteger(record.maxCleanupTasksPerPass, 5, 'diskPolicy.maxCleanupTasksPerPass'),
    maxCleanupCandidatesScannedPerPass: optionalPositiveInteger(
      record.maxCleanupCandidatesScannedPerPass, 100, 'diskPolicy.maxCleanupCandidatesScannedPerPass',
    ),
    orphanGraceHours: optionalPositiveInteger(record.orphanGraceHours, 24, 'diskPolicy.orphanGraceHours'),
  };
  if (!(config.lowWatermark < config.warningWatermark && config.warningWatermark < config.highWatermark)) {
    throw new Error('Invalid config field: diskPolicy requires lowWatermark < warningWatermark < highWatermark');
  }
  if (config.inventoryIntervalMs < config.scanIntervalMs) {
    throw new Error('Invalid config field: diskPolicy.inventoryIntervalMs must be at least scanIntervalMs');
  }
  if (config.warmRetentionWarningDays >= config.warmRetentionDays) {
    throw new Error('Invalid config field: diskPolicy.warmRetentionWarningDays must be below warmRetentionDays');
  }
  if (config.maxCleanupCandidatesScannedPerPass! < config.maxCleanupTasksPerPass) {
    throw new Error('Invalid config field: diskPolicy.maxCleanupCandidatesScannedPerPass cannot be below maxCleanupTasksPerPass');
  }
  return config;
}

function optionalPositiveInteger(value: unknown, defaultValue: number, field: string): number {
  const result = value === undefined ? defaultValue : value;
  if (typeof result !== 'number' || !Number.isInteger(result) || result <= 0) throw new Error(`Invalid config field: ${field}`);
  return result;
}

function optionalPidLimit(value: unknown, defaultValue: number, field: string): number {
  if (value === -1) return -1;
  return optionalPositiveInteger(value, defaultValue, field);
}

function optionalNonnegativeInteger(value: unknown, defaultValue: number, field: string): number {
  const result = value === undefined ? defaultValue : value;
  if (typeof result !== 'number' || !Number.isInteger(result) || result < 0) throw new Error(`Invalid config field: ${field}`);
  return result;
}

function optionalRatio(value: unknown, defaultValue: number, field: string): number {
  const result = value === undefined ? defaultValue : value;
  if (typeof result !== 'number' || !Number.isFinite(result) || result <= 0 || result >= 1) throw new Error(`Invalid config field: ${field}`);
  return result;
}

function optionalRuntimeBackend(
  value: unknown,
  defaultValue: 'app-server',
  field: string,
): 'app-server' {
  if (value === undefined) {
    return defaultValue;
  }
  if (value === 'app-server') {
    return value;
  }
  throw new Error(`Invalid config field: ${field}`);
}

function requireUiVerbosity(value: unknown, field: string): 'normal' | 'debug' {
  if (value === 'normal' || value === 'debug') {
    return value;
  }
  throw new Error(`Invalid config field: ${field}`);
}

function requireCurrentRenderMode(value: unknown, field: string): 'markdown' | 'code' {
  if (value === 'markdown' || value === 'code') {
    return value;
  }
  throw new Error(`Invalid config field: ${field}`);
}

function requireDisplayTimeZone(value: unknown, field: string): string {
  const timeZone = requireString(value, field);
  if (!isValidDisplayTimeZone(timeZone)) {
    throw new Error(`Invalid config field: ${field}`);
  }
  return timeZone;
}

function normalizeUpgrade(value: Record<string, unknown>): BotConfig['upgrade'] {
  const upgrade = {
    enabled: optionalBoolean(value.enabled, false, 'upgrade.enabled'),
    adminUsers: optionalStringArray(value.adminUsers, 'upgrade.adminUsers'),
    pm2ProcessName: optionalString(value.pm2ProcessName, 'link-bot', 'upgrade.pm2ProcessName'),
    remote: optionalString(value.remote, 'origin', 'upgrade.remote'),
    branch: optionalString(value.branch, 'main', 'upgrade.branch'),
  };
  if (upgrade.enabled && upgrade.adminUsers.length === 0) {
    throw new Error('Invalid config field: upgrade.adminUsers');
  }
  return upgrade;
}
