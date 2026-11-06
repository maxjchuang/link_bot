import { describe,expect,it } from 'vitest';
import type { BotConfig } from '../../src/domain/types.js';
import { isAuthorizedMessage,resolveProject } from '../../src/security/guards.js';

const config: BotConfig = {
  feishu: { appId: 'cli', appSecret: 'secret' },
  allowedUsers: ['ou_1'],
  allowedChatIds: ['oc_1'],
  restrictUsers: true,
  allowUnlistedGroupUsers: false,
  restrictChatIds: true,
  projects: [{ id: 'repo', name: 'Repo', path: '/tmp/repo', codexArgs: [] }],
  output: {
    directMaxChars: 1800,
    chunkSize: 1500,
  },
  codex: { command: 'codex', defaultArgs: [], isolateSessions: true, executionProfiles: {
    host: { model: 'gpt-5.6-sol', reasoningEffort: 'medium', serviceTier: 'default' },
    worker: { model: 'gpt-5.6-luna', reasoningEffort: 'medium', serviceTier: 'default' },
  } },
  logLevel: 'info',
  ui: { verbosity: 'normal', currentRenderMode: 'markdown', timeZone: 'Asia/Shanghai' },
  notifications: { enabled: true, idleMs: 3000, maxFinalChars: 8000, failureTailChars: 2000 },
  liveCards: { enabled: true, refreshIntervalMs: 1000 },
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
    enabled: false, group: { maxMessages: 50, lookbackHours: 24, maxChars: 16_000 },
    topic: { maxMessages: 100, maxChars: 20_000 }, requestTimeoutMs: 5_000,
    incremental: true, includeMediaPlaceholders: true,
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

describe('security guards', () => {
  it('allows private messages from allowlisted users', () => {
    expect(isAuthorizedMessage(config, { userId: 'ou_1', chatId: 'ou_1', chatType: 'private' })).toBe(true);
  });

  it('denies private messages from non-allowlisted users', () => {
    expect(isAuthorizedMessage(config, { userId: 'ou_not_allowed', chatId: 'ou_not_allowed', chatType: 'private' })).toBe(false);
  });

  it('denies group messages from allowlisted chat when user is non-allowlisted', () => {
    expect(isAuthorizedMessage(config, { userId: 'ou_not_allowed', chatId: 'oc_1', chatType: 'group' })).toBe(false);
  });

  it('can allow unlisted group users without opening private messages', () => {
    const groupOnly = { ...config, allowUnlistedGroupUsers: true, restrictChatIds: false };
    expect(isAuthorizedMessage(groupOnly, {
      userId: 'ou_not_allowed', chatId: 'oc_any', chatType: 'group',
    })).toBe(true);
    expect(isAuthorizedMessage(groupOnly, {
      userId: 'ou_not_allowed', chatId: 'ou_not_allowed', chatType: 'private',
    })).toBe(false);
  });

  it('allows group messages from allowlisted users in allowlisted chats', () => {
    expect(isAuthorizedMessage(config, { userId: 'ou_1', chatId: 'oc_1', chatType: 'group' })).toBe(true);
  });

  it('blocks group messages outside the chat allowlist', () => {
    expect(isAuthorizedMessage(config, { userId: 'ou_1', chatId: 'oc_other', chatType: 'group' })).toBe(false);
  });

  it('allows all users and chats when restriction switches are disabled', () => {
    const unrestricted: BotConfig = {
      ...config,
      restrictUsers: false,
      restrictChatIds: false,
      allowedUsers: [],
      allowedChatIds: [],
    };

    expect(isAuthorizedMessage(unrestricted, { userId: 'ou_any', chatId: 'ou_any', chatType: 'private' })).toBe(true);
    expect(isAuthorizedMessage(unrestricted, { userId: 'ou_any', chatId: 'oc_any', chatType: 'group' })).toBe(true);
  });

  it('only applies chat allowlist when chat restriction is enabled', () => {
    const groupRestricted: BotConfig = {
      ...config,
      restrictUsers: false,
      restrictChatIds: true,
      allowedUsers: [],
      allowedChatIds: ['oc_1'],
    };

    expect(isAuthorizedMessage(groupRestricted, { userId: 'ou_any', chatId: 'oc_1', chatType: 'group' })).toBe(true);
    expect(isAuthorizedMessage(groupRestricted, { userId: 'ou_any', chatId: 'oc_2', chatType: 'group' })).toBe(false);
  });

  it('resolves projects by id only', () => {
    expect(resolveProject(config, 'repo')?.path).toBe('/tmp/repo');
    expect(resolveProject(config, '/tmp/repo')).toBeUndefined();
  });
});
