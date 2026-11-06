import type { BotConfig } from '../../src/domain/types.js';
import type { LiveTurnRecord } from '../../src/livecards/LiveTurnCardTypes.js';
import type { CodexModelCatalog } from '../../src/models/CodexModelCatalog.js';

export function sampleConfig(projectPath: string): BotConfig {
  return {
    feishu: { appId: 'cli', appSecret: 'secret' },
    restrictUsers: true,
    allowUnlistedGroupUsers: false,
    restrictChatIds: true,
    allowedUsers: ['ou_1'],
    gitIdentities: {
      ou_1: { name: 'Test User', email: 'test.user@example.com' },
      ou_owner: { name: 'Owner Name', email: 'owner@example.com' },
    },
    allowedChatIds: ['oc_1'],
    projects: [
      { id: 'repo', name: 'Repo', path: projectPath, codexArgs: [] },
      { id: 'repo2', name: 'Repo 2', path: projectPath, codexArgs: [] },
    ],
    output: {
      directMaxChars: 1800,
      chunkSize: 1500,

    },
    codex: { command: 'codex', defaultArgs: [], isolateSessions: true, executionProfiles: {
      host: { model: 'gpt-6-sol', reasoningEffort: 'medium', serviceTier: 'default' },
      worker: { model: 'gpt-6-luna', reasoningEffort: 'medium', serviceTier: 'default' },
    } },
    logLevel: 'info',
    ui: { verbosity: 'normal', currentRenderMode: 'markdown', timeZone: 'Asia/Shanghai' },
    notifications: { enabled: true, idleMs: 10, maxFinalChars: 8000, failureTailChars: 2000 },
    liveCards: { enabled: true, refreshIntervalMs: 1000 },
    runtime: { backend: 'app-server' },
    taskPool: {
      maxHotTasks: 6, maxActiveTurns: 4, memoryHighWatermark: 0.8, memoryLowWatermark: 0.65,
      safetyReserveBytes: 2_147_483_648, idleMemorySampleWindowDays: 7,
    },
    readyPool: { enabled: true, defaultMinReady: 1, defaultMaxReady: 2 },
    diskPolicy: {
      enabled: false, filesystemPath: '/var/lib/docker', scanIntervalMs: 900_000, inventoryIntervalMs: 21_600_000,
      inventoryTimeoutMs: 300_000,
      warningWatermark: 0.7, highWatermark: 0.8, lowWatermark: 0.65, minimumFreeBytes: 21_474_836_480,
      attributionEnabled: false, cleanupEnabled: false,
      taskSoftLimitBytes: 21_474_836_480, userSoftLimitBytes: 107_374_182_400,
      warmRetentionDays: 30, warmRetentionWarningDays: 3, autoDeleteWarmTasks: false,
      maxCleanupTasksPerPass: 5, orphanGraceHours: 24,
    },
    conversationContext: {
      enabled: false,
      group: { maxMessages: 50, lookbackHours: 24, maxChars: 16_000 },
      topic: { maxMessages: 100, maxChars: 20_000 },
      requestTimeoutMs: 5_000,
      incremental: true,
      includeMediaPlaceholders: true,
    },
    conversationRouting: { ambientChats: [] },
    taskPlatformRollout: {
      enabled: false, enabledOwners: [], enabledProjects: [], appServerDefault: false, multiUserEnabled: false,
    },
    upgrade: {
      enabled: false,
      adminUsers: [],
      pm2ProcessName: 'link-bot',
      remote: 'origin',
      branch: 'main',
    },
    codexHooks: {
      enabled: false,
      autoRepair: false,
      socketPath: '.link-bot/codex-hooks.sock',
      permissionTimeoutMs: 300000,
      adminUsers: [],
    },
  };
}

export function sampleLiveTurnRecord(overrides: Partial<LiveTurnRecord> = {}): LiveTurnRecord {
  return {
    turnId: 'turn_1',
    sourceSessionId: 'sess_1',
    activeSessionId: 'sess_1',
    chatId: 'oc_1',
    projectId: 'repo',
    prompt: 'inspect repository',
    startedAt: '2026-07-13T08:00:00.000Z',
    outputStartOffset: 0,
    replyTarget: { chatId: 'oc_1', replyToMessageId: 'om_user_1' },
    state: 'creating',
    sendUuid: 'send_uuid_1',
    nextSequence: 1,
    recoveryAttempt: 0,
    ...overrides,
  };
}

export const sampleModelCatalog: CodexModelCatalog = {
  kind: 'available',
  fetchedAt: '2026-06-03T13:43:32.128077Z',
  clientVersion: '0.136.0',
  models: [
    {
      slug: 'gpt-5.5',
      displayName: 'GPT 5.5',
      description: 'Most capable model',
      priority: 10,
      defaultReasoningLevel: 'medium',
      supportedReasoningLevels: ['low', 'medium', 'high'],
    },
    {
      slug: 'gpt-5.5-mini',
      displayName: 'GPT 5.5 Mini',
      description: 'Fast model',
      priority: 20,
      defaultReasoningLevel: 'low',
      supportedReasoningLevels: ['low', 'medium'],
    },
  ],
};
