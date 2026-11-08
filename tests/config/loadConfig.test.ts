import { mkdir,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe,expect,it } from 'vitest';
import { loadConfig,runtimeBackendForProject } from '../../src/config/loadConfig.js';
import { createTmpDir } from '../helpers/tmp.js';

async function writeConfig(root: string, config: unknown): Promise<void> {
  await mkdir(join(root, '.link-bot'), { recursive: true });
  await writeFile(join(root, '.link-bot/config.json'), JSON.stringify(config), 'utf8');
}

function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    feishu: { appId: 'cli', appSecret: 'secret' },
    allowedUsers: ['ou_1'],
    allowedChatIds: ['oc_1'],
    restrictUsers: true,
    restrictChatIds: true,
    projects: [{ id: 'repo', name: 'Repo', path: '.', codexArgs: [] }],
    output: { directMaxChars: 1800, chunkSize: 1500 },
    codex: { command: 'codex', defaultArgs: [] },
    ...overrides,
  };
}

describe('loadConfig', () => {
  it('defaults continuation input handoff on and validates its fail-closed rollback flag',async()=>{
    const root=await createTmpDir();await writeConfig(root,validConfig());
    expect((await loadConfig(root)).taskPlatformRollout.projectContinuationInputHandoffEnabled).toBe(true);
    await writeConfig(root,validConfig({taskPlatformRollout:{projectContinuationInputHandoffEnabled:false}}));
    expect((await loadConfig(root)).taskPlatformRollout.projectContinuationInputHandoffEnabled).toBe(false);
    await writeConfig(root,validConfig({taskPlatformRollout:{projectContinuationInputHandoffEnabled:'false'}}));
    await expect(loadConfig(root)).rejects.toThrow('projectContinuationInputHandoffEnabled');
  });
  it('defaults timeline capacity to 50 and bounds the configurable candidate window',async()=>{
    const root=await createTmpDir();await writeConfig(root,validConfig());
    expect((await loadConfig(root)).liveCards.inlineTimelineMaxItems).toBe(50);
    for(const limit of [1,15,50,100]){
      await writeConfig(root,validConfig({liveCards:{inlineTimelineMaxItems:limit}}));
      expect((await loadConfig(root)).liveCards.inlineTimelineMaxItems).toBe(limit);
    }
    for(const limit of [0,-1,101,1.5,'50',null,true]){
      await writeConfig(root,validConfig({liveCards:{inlineTimelineMaxItems:limit}}));
      await expect(loadConfig(root)).rejects.toThrow('liveCards.inlineTimelineMaxItems');
    }
  });
  it('defaults project switching off and validates its independent rollback flag',async()=>{
    const root=await createTmpDir();await writeConfig(root,validConfig());
    expect((await loadConfig(root)).taskPlatformRollout.projectSwitchingEnabled).toBe(false);
    await writeConfig(root,validConfig({taskPlatformRollout:{projectSwitchingEnabled:true}}));
    expect((await loadConfig(root)).taskPlatformRollout.projectSwitchingEnabled).toBe(true);
    await writeConfig(root,validConfig({taskPlatformRollout:{projectSwitchingEnabled:'true'}}));
    await expect(loadConfig(root)).rejects.toThrow('projectSwitchingEnabled');
  });
  it('defaults private sensitive delivery on and validates its independent kill switch', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig());
    expect((await loadConfig(root)).sensitiveReplyDeliveryEnabled).toBe(true);
    await writeConfig(root, validConfig({ sensitiveReplyDeliveryEnabled: false }));
    expect((await loadConfig(root)).sensitiveReplyDeliveryEnabled).toBe(false);
    await writeConfig(root, validConfig({ sensitiveReplyDeliveryEnabled: 'false' }));
    await expect(loadConfig(root)).rejects.toThrow('sensitiveReplyDeliveryEnabled');
  });
  it('accepts an explicit sandbox clone URL without embedded credentials', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ projects: [{ id: 'repo', name: 'Repo', path: '.',
      sandboxCloneUrl: 'https://github.com/team/repo.git' }] }));
    await expect(loadConfig(root)).resolves.toMatchObject({ projects: [
      { sandboxCloneUrl: 'https://github.com/team/repo.git' },
    ] });
    await writeConfig(root, validConfig({ projects: [{ id: 'repo', name: 'Repo', path: '.',
      sandboxCloneUrl: 'https://token@github.com/team/repo.git' }] }));
    await expect(loadConfig(root)).rejects.toThrow('projects[].sandboxCloneUrl');
  });
  it('loads bounded media defaults and resolves the storage root', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ media: { enabled: true, maxImagesPerTurn: 4 } }));

    await expect(loadConfig(root)).resolves.toMatchObject({ media: {
      enabled: true, storageRoot: join(root, '.link-bot/media-store'), maxImagesPerTurn: 4,
      maxFilesPerTurn: 10, maxImageBytes: 10_485_760, maxFileBytes: 52_428_800,
      maxTotalBytesPerTurn: 104_857_600, pendingGroupAttachmentTtlMs: 300_000, retentionHours: 24,
    } });
  });
  it('loads separate host and worker execution profiles with role defaults', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ codex: {
      command: 'codex', defaultArgs: [], executionProfiles: {
        host: { model: 'host-model', reasoningEffort: 'high' },
        worker: { model: 'worker-model', reasoningEffort: 'low', serviceTier: 'fast' },
      },
    } }));

    await expect(loadConfig(root)).resolves.toMatchObject({ codex: { executionProfiles: {
      host: { model: 'host-model', reasoningEffort: 'high', serviceTier: 'default' },
      worker: { model: 'worker-model', reasoningEffort: 'low', serviceTier: 'fast' },
    } } });
  });

  it('defaults host and worker tasks to GPT-6.1 Sol', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig());
    await expect(loadConfig(root)).resolves.toMatchObject({ codex: { executionProfiles: {
      host: { model: 'gpt-6.1-sol', reasoningEffort: 'medium' },
      worker: { model: 'gpt-6.1-sol', reasoningEffort: 'medium' },
    } } });
  });

  it('loads per-user Git identities', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({
      gitIdentities: { ou_1: { name: 'Owner Name', email: 'owner@example.com' } },
    }));

    await expect(loadConfig(root)).resolves.toMatchObject({
      gitIdentities: { ou_1: { name: 'Owner Name', email: 'owner@example.com' } },
    });
  });

  it('rejects incomplete Git identities', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ gitIdentities: { ou_1: { name: 'Owner Name' } } }));
    await expect(loadConfig(root)).rejects.toThrow('gitIdentities.ou_1.email');
  });

  it('loads host control configuration for administrator private chats', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({
      projects: [{ id: 'link-bot', name: 'Link Bot', path: root }],
      upgrade: { adminUsers: ['ou_admin'] },
      hostControl: { enabled: true, adminUsers: ['ou_admin'], projectId: 'link-bot' },
    }));

    const loaded = await loadConfig(root);

    expect(loaded.hostControl).toEqual({
      enabled: true, adminUsers: ['ou_admin'], projectId: 'link-bot',
      socketPath: join(root, '.link-bot/host-control.sock'), managerProcessName: 'link-bot-host-manager',
    });
  });
  it('defaults to App Server', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig());

    await expect(loadConfig(root)).resolves.toMatchObject({ runtime: { backend: 'app-server' } });
  });

  it('loads the app-server runtime backend', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ runtime: { backend: 'app-server' } }));

    await expect(loadConfig(root)).resolves.toMatchObject({
      runtime: {
        backend: 'app-server', image: 'link-bot-runtime:0.1', codexCliVersion: '0.161.0',
        taskCpuLimit: 4, taskMemoryLimitBytes: 8_589_934_592, taskPidLimit: 512,
        taskTmpfsLimitBytes: 2_147_483_648,
        appServerMaxFrameBytes: 67_108_864,
        isolationVerified: false, sharedAuthRiskAccepted: false,
        nativeGitExecution: false, managerGitToolFallback: true,
      },
    });
  });

  it('normalizes the per-user sandbox rollout and bounded concurrency defaults', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ userSandboxes: { enabled: true, enabledOwners: ['ou_1'] } }));

    await expect(loadConfig(root)).resolves.toMatchObject({
      userSandboxes: {
        enabled: true, enabledOwners: ['ou_1'], legacyFallbackEnabled: false,
        maxAppServersPerUser: 8, maxActiveTurnsPerUser: 4,
        processIdleTimeoutMinutes: 120, containerIdleTimeoutMinutes: 1_440,
        containerWrapperRetentionHours: 24,
      },
    });
  });

  it('accepts unlimited container PIDs and validates per-owner resource overrides', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({
      runtime: { taskPidLimit: -1 },
      userSandboxes: { resourceOverrides: { ou_owner: { cpuLimit: 8, memoryLimitBytes: 17_179_869_184 } } },
    }));
    await expect(loadConfig(root)).resolves.toMatchObject({
      runtime: { taskPidLimit: -1 },
      userSandboxes: { resourceOverrides: { ou_owner: { cpuLimit: 8, memoryLimitBytes: 17_179_869_184 } } },
    });

    await writeConfig(root, validConfig({ runtime: { taskPidLimit: 0 } }));
    await expect(loadConfig(root)).rejects.toThrow('runtime.taskPidLimit');
    await writeConfig(root, validConfig({ userSandboxes: { resourceOverrides: { ou_owner: { cpuLimit: 0 } } } }));
    await expect(loadConfig(root)).rejects.toThrow('userSandboxes.resourceOverrides.ou_owner.cpuLimit');
  });

  it('rejects an unsupported runtime backend', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ runtime: { backend: 'remote' } }));

    await expect(loadConfig(root)).rejects.toThrow('Invalid config field: runtime.backend');
  });

  it('allows a project backend override for gradual rollout', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({
      runtime: { backend: 'app-server' },
      projects: [{ id: 'repo', name: 'Repo', path: '.', codexArgs: [], runtimeBackend: 'app-server' }],
    }));

    const config = await loadConfig(root);
    expect(config.projects[0]?.runtimeBackend).toBe('app-server');
    expect(runtimeBackendForProject(config, config.projects[0]!)).toBe('app-server');
  });

  it('loads project descriptions, instructions, ACLs, and projectless rollout', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({
      projects: [{
        id: 'repo', name: 'Repo', path: '.', repositoryPath: 'acme/repo', codexArgs: [], description: 'Primary service',
        instructions: ['Run npm test'],
        access: { allowedUsers: ['ou_1'], allowedChats: ['oc_1'], knowledgeApprovers: ['ou_admin'] },
      }],
      taskPlatformRollout: {
        projectlessWorkspaces: true, conversationScopedTasks: true, multiRepositoryTasks: true,
      },
    }));

    await expect(loadConfig(root)).resolves.toMatchObject({
      projects: [{
        repositoryPath: 'acme/repo', description: 'Primary service', instructions: ['Run npm test'],
        access: { allowedUsers: ['ou_1'], allowedChats: ['oc_1'], knowledgeApprovers: ['ou_admin'] },
      }],
      taskPlatformRollout: { projectlessWorkspaces: true },
    });
  });

  it('rejects malformed project repository identities', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({
      projects: [{ id: 'repo', name: 'Repo', path: '.', repositoryPath: 'repo-only' }],
    }));
    await expect(loadConfig(root)).rejects.toThrow('projects[].repositoryPath');
  });

  it('rejects project ids that cannot be stable workspace directory names', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ projects: [{ id: '../unsafe', name: 'Unsafe', path: '.' }] }));
    await expect(loadConfig(root)).rejects.toThrow('projects[].id');
  });

  it('requires conversation-scoped multi-repository support for projectless workspaces', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ taskPlatformRollout: { projectlessWorkspaces: true } }));
    await expect(loadConfig(root)).rejects.toThrow('projectlessWorkspaces requires conversationScopedTasks and multiRepositoryTasks');
  });

  it('rejects an unsupported project backend override', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({
      projects: [{ id: 'repo', name: 'Repo', path: '.', codexArgs: [], runtimeBackend: 'remote' }],
    }));

    await expect(loadConfig(root)).rejects.toThrow('Invalid config field: projects[].runtimeBackend');
  });

  it('loads task-pool defaults with the per-task ready pool disabled', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig());

    await expect(loadConfig(root)).resolves.toMatchObject({
      taskPool: {
        maxHotTasks: 6, maxActiveTurns: 4, memoryHighWatermark: 0.8, memoryLowWatermark: 0.65,
        safetyReserveBytes: 2_147_483_648, idleMemorySampleWindowDays: 7,
      },
      readyPool: { enabled: false, defaultMinReady: 1, defaultMaxReady: 2 },
      diskPolicy: {
        enabled: false, filesystemPath: '/var/lib/docker', scanIntervalMs: 900_000, inventoryIntervalMs: 21_600_000,
        inventoryTimeoutMs: 300_000,
        warningWatermark: 0.7, highWatermark: 0.8, lowWatermark: 0.65,
        minimumFreeBytes: 21_474_836_480,
        attributionEnabled: false, cleanupEnabled: false,
        taskSoftLimitBytes: 21_474_836_480, userSoftLimitBytes: 107_374_182_400,
        warmRetentionDays: 7, warmRetentionWarningDays: 3, autoDeleteWarmTasks: false,
        maxCleanupTasksPerPass: 5, maxCleanupCandidatesScannedPerPass: 100, orphanGraceHours: 24,
      },
    });
  });

  it('loads and validates disk-policy overrides', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({
      diskPolicy: {
        enabled: true, filesystemPath: '.', scanIntervalMs: 30_000, inventoryIntervalMs: 120_000, inventoryTimeoutMs: 60_000,
        warningWatermark: 0.6, highWatermark: 0.75, lowWatermark: 0.5,
        minimumFreeBytes: 1_073_741_824,
        attributionEnabled: false, cleanupEnabled: false,
        taskSoftLimitBytes: 21_474_836_480, userSoftLimitBytes: 107_374_182_400,
        warmRetentionDays: 30, warmRetentionWarningDays: 3, autoDeleteWarmTasks: false,
        maxCleanupTasksPerPass: 5, orphanGraceHours: 24,
      },
    }));

    await expect(loadConfig(root)).resolves.toMatchObject({
      diskPolicy: {
        enabled: true, filesystemPath: root, scanIntervalMs: 30_000, inventoryIntervalMs: 120_000, inventoryTimeoutMs: 60_000,
        warningWatermark: 0.6, highWatermark: 0.75, lowWatermark: 0.5,
        minimumFreeBytes: 1_073_741_824,
      },
    });
  });

  it('rejects invalid disk-policy watermark ordering', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({
      diskPolicy: { lowWatermark: 0.7, warningWatermark: 0.6, highWatermark: 0.8 },
    }));

    await expect(loadConfig(root)).rejects.toThrow(
      'diskPolicy requires lowWatermark < warningWatermark < highWatermark',
    );
  });

  it('rejects detailed inventory intervals shorter than cheap sampling', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({
      diskPolicy: { scanIntervalMs: 60_000, inventoryIntervalMs: 30_000 },
    }));

    await expect(loadConfig(root)).rejects.toThrow(
      'diskPolicy.inventoryIntervalMs must be at least scanIntervalMs',
    );
  });

  it('loads cleanup and retention policy and rejects warning windows beyond retention', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({
      diskPolicy: {
        attributionEnabled: true, cleanupEnabled: true,
        taskSoftLimitBytes: 1000, userSoftLimitBytes: 5000,
        warmRetentionDays: 14, warmRetentionWarningDays: 2, autoDeleteWarmTasks: true,
        maxCleanupTasksPerPass: 3, maxCleanupCandidatesScannedPerPass: 20, orphanGraceHours: 48,
      },
    }));
    await expect(loadConfig(root)).resolves.toMatchObject({ diskPolicy: {
      attributionEnabled: true, cleanupEnabled: true,
      taskSoftLimitBytes: 1000, userSoftLimitBytes: 5000,
      warmRetentionDays: 14, warmRetentionWarningDays: 2, autoDeleteWarmTasks: true,
      maxCleanupTasksPerPass: 3, maxCleanupCandidatesScannedPerPass: 20, orphanGraceHours: 48,
    } });

    await writeConfig(root, validConfig({ diskPolicy: { warmRetentionDays: 3, warmRetentionWarningDays: 3 } }));
    await expect(loadConfig(root)).rejects.toThrow('warmRetentionWarningDays must be below warmRetentionDays');

    await writeConfig(root, validConfig({ diskPolicy: {
      maxCleanupTasksPerPass: 5, maxCleanupCandidatesScannedPerPass: 4,
    } }));
    await expect(loadConfig(root)).rejects.toThrow('maxCleanupCandidatesScannedPerPass cannot be below maxCleanupTasksPerPass');
  });

  it('loads bounded conversation-context defaults and overrides', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({
      conversationContext: {
        enabled: true,
        group: { maxMessages: 25, lookbackHours: 12, maxChars: 8_000 },
        topic: { maxMessages: 75, maxChars: 18_000 },
        requestTimeoutMs: 3_000,
        incremental: false,
        includeMediaPlaceholders: false,
      },
    }));

    await expect(loadConfig(root)).resolves.toMatchObject({
      conversationContext: {
        enabled: true,
        group: { maxMessages: 25, lookbackHours: 12, maxChars: 8_000 },
        topic: { maxMessages: 75, maxChars: 18_000 },
        requestTimeoutMs: 3_000,
        incremental: false,
        includeMediaPlaceholders: false,
      },
    });
  });

  it('rejects invalid conversation-context bounds', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ conversationContext: { group: { maxMessages: 0 } } }));
    await expect(loadConfig(root)).rejects.toThrow('conversationContext.group.maxMessages');
  });

  it('loads ambient topic-group routing', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ conversationRouting: { ambientChats: [{
      chatId: 'oc_ambient', name: 'Chatbot 开发广场',
    }] } }));

    await expect(loadConfig(root)).resolves.toMatchObject({ conversationRouting: { ambientChats: [{
      chatId: 'oc_ambient', name: 'Chatbot 开发广场',
    }] } });
  });

  it('loads the project-free-chat flag explicitly', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ taskPlatformRollout: { projectFreeChat: true } }));
    await expect(loadConfig(root)).resolves.toMatchObject({ taskPlatformRollout: { projectFreeChat: true } });
  });

  it('loads bounded memory and Dream defaults', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig());
    await expect(loadConfig(root)).resolves.toMatchObject({
      memory: { catalogMaxTokens: 1_000, automaticRecallMaxTokens: 1_500, singleReadMaxTokens: 1_500, totalContextRatio: 0.1 },
      dream: {
        enabled: false, timezone: 'Asia/Shanghai', startAfter: '02:00', maxConcurrency: 1,
        maxInteractiveActiveTurns: 2, batchMaxEvents: 100, batchMaxChars: 24_000, administratorIds: [],
      },
    });
  });

  it('rejects unsafe memory budgets, Dream scheduling, and rollout dependencies', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ memory: { totalContextRatio: 0.2 } }));
    await expect(loadConfig(root)).rejects.toThrow('totalContextRatio cannot exceed');

    await writeConfig(root, validConfig({ dream: { timezone: 'Mars/Olympus' } }));
    await expect(loadConfig(root)).rejects.toThrow('dream.timezone');

    await writeConfig(root, validConfig({ dream: { maxConcurrency: 2 } }));
    await expect(loadConfig(root)).rejects.toThrow('maxConcurrency must be 1');

    await writeConfig(root, validConfig({
      taskPool: { maxHotTasks: 6, maxActiveTurns: 2 }, dream: { maxInteractiveActiveTurns: 2 },
    }));
    await expect(loadConfig(root)).rejects.toThrow('preserve interactive ACTIVE-turn capacity');

    await writeConfig(root, validConfig({ taskPlatformRollout: { nightlyDream: true }, dream: { enabled: true } }));
    await expect(loadConfig(root)).rejects.toThrow('nightlyDream requires managedMemory');

    await writeConfig(root, validConfig({
      taskPlatformRollout: { managedMemory: true, nightlyDream: true, botGlobalMemory: true }, dream: { enabled: true },
    }));
    await expect(loadConfig(root)).rejects.toThrow('at least one administrator');

    await writeConfig(root, validConfig({
      taskPlatformRollout: { managedMemory: true, botGlobalMemory: true }, dream: { administratorIds: ['ou_admin'] },
    }));
    await expect(loadConfig(root)).resolves.toMatchObject({ taskPlatformRollout: { botGlobalMemory: true, nightlyDream: false } });
  });

  it('rejects impossible task-pool watermarks and count limits', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ taskPool: { memoryLowWatermark: 0.8, memoryHighWatermark: 0.8 } }));
    await expect(loadConfig(root)).rejects.toThrow('low watermark must be below high watermark');

    await writeConfig(root, validConfig({ taskPool: { maxHotTasks: 3, maxActiveTurns: 4 } }));
    await expect(loadConfig(root)).rejects.toThrow('maxActiveTurns cannot exceed');
  });

  it('rejects a READY minimum above its maximum', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ readyPool: { defaultMinReady: 3, defaultMaxReady: 2 } }));

    await expect(loadConfig(root)).rejects.toThrow('defaultMinReady cannot exceed');
  });

  it('defaults Codex session isolation to enabled', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig());

    await expect(loadConfig(root)).resolves.toMatchObject({
      codex: { command: 'codex', defaultArgs: [], isolateSessions: true },
    });
  });

  it('loads disabled Codex session isolation', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({
      codex: { command: 'codex', defaultArgs: [], isolateSessions: false },
    }));

    await expect(loadConfig(root)).resolves.toMatchObject({ codex: { isolateSessions: false } });
  });

  it('rejects a non-boolean Codex session isolation value', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({
      codex: { command: 'codex', defaultArgs: [], isolateSessions: 'false' },
    }));

    await expect(loadConfig(root)).rejects.toThrow('Invalid config field: codex.isolateSessions');
  });

  it('loads a valid bot config', async () => {
    const root = await createTmpDir();
    await mkdir(join(root, '.link-bot'), { recursive: true });
    await writeFile(
      join(root, '.link-bot/config.json'),
      JSON.stringify({
        feishu: { appId: 'cli_xxx', appSecret: 'secret' },
        allowedUsers: ['ou_user_1'],
        allowedChatIds: ['oc_group_1'],
        projects: [
          { id: 'repo', name: 'Repo', path: root, codexArgs: ['--ask-for-approval', 'on-request'] }
        ],
        output: { directMaxChars: 1800, chunkSize: 1500 },
        codex: { command: 'codex', defaultArgs: [] }
      }),
      'utf8',
    );

    const config = await loadConfig(root);

    expect(config.projects[0].id).toBe('repo');
    expect(config.output.directMaxChars).toBe(1800);
  });

  it('resolves relative project paths from projectRoot', async () => {
    const root = await createTmpDir();
    await mkdir(join(root, '.link-bot'), { recursive: true });
    await writeFile(
      join(root, '.link-bot/config.json'),
      JSON.stringify({
        feishu: { appId: 'cli_xxx', appSecret: 'secret' },
        allowedUsers: ['ou_user_1'],
        allowedChatIds: ['oc_group_1'],
        projects: [
          { id: 'repo', name: 'Repo', path: 'repo', codexArgs: [] }
        ],
        output: { directMaxChars: 1800, chunkSize: 1500 },
        codex: { command: 'codex', defaultArgs: [] }
      }),
      'utf8',
    );

    const config = await loadConfig(root);

    expect(config.projects[0].path).toBe(join(root, 'repo'));
  });

  it('rejects duplicate project ids', async () => {
    const root = await createTmpDir();
    await mkdir(join(root, '.link-bot'), { recursive: true });
    await writeFile(
      join(root, '.link-bot/config.json'),
      JSON.stringify({
        feishu: { appId: 'cli_xxx', appSecret: 'secret' },
        allowedUsers: ['ou_user_1'],
        allowedChatIds: [],
        projects: [
          { id: 'repo', name: 'Repo A', path: root },
          { id: 'repo', name: 'Repo B', path: root }
        ],
        output: { directMaxChars: 1800, chunkSize: 1500 },
        codex: { command: 'codex', defaultArgs: [] }
      }),
      'utf8',
    );

    await expect(loadConfig(root)).rejects.toThrow('Duplicate project id: repo');
  });

  it('rejects malformed top-level null config', async () => {
    const root = await createTmpDir();
    await mkdir(join(root, '.link-bot'), { recursive: true });
    await writeFile(join(root, '.link-bot/config.json'), 'null', 'utf8');

    await expect(loadConfig(root)).rejects.toThrow('Invalid config structure');
  });

  it('defaults notification config when omitted', async () => {
    const root = await createTmpDir();
    await writeConfig(root, {
      feishu: { appId: 'cli', appSecret: 'secret' },
      allowedUsers: ['ou_1'],
      allowedChatIds: ['oc_1'],
      projects: [{ id: 'repo', name: 'Repo', path: '.', codexArgs: [] }],
      output: { directMaxChars: 1800, chunkSize: 1500 },
      codex: { command: 'codex', defaultArgs: [] },
    });

    await expect(loadConfig(root)).resolves.toMatchObject({
      ui: {
        verbosity: 'normal',
        currentRenderMode: 'code',
        timeZone: 'Asia/Shanghai',
      },
      notifications: {
        enabled: true,
        idleMs: 3000,
        maxFinalChars: 8000,
        failureTailChars: 2000,
      },
    });
  });

  it('defaults live cards to enabled with a one-second refresh interval', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig());

    await expect(loadConfig(root)).resolves.toMatchObject({
      liveCards: { enabled: true, refreshIntervalMs: 1000, detailsEnabled: false, inlineDetailsEnabled: false },
    });
  });

  it('loads explicit live card configuration', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({
      liveCards: { enabled: false, refreshIntervalMs: 2500, detailsEnabled: true, inlineDetailsEnabled: true },
    }));

    await expect(loadConfig(root)).resolves.toMatchObject({
      liveCards: { enabled: false, refreshIntervalMs: 2500, detailsEnabled: true, inlineDetailsEnabled: true },
    });
  });

  it.each([999, 1000.5, 0, Number.NaN])(
    'rejects invalid live card refresh interval %s',
    async (refreshIntervalMs) => {
      const root = await createTmpDir();
      await writeConfig(root, validConfig({ liveCards: { refreshIntervalMs } }));

      await expect(loadConfig(root)).rejects.toThrow('Invalid config field: liveCards.refreshIntervalMs');
    },
  );

  it('defaults upgrade config to disabled with safe defaults', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig());

    await expect(loadConfig(root)).resolves.toMatchObject({
      upgrade: {
        enabled: false,
        adminUsers: [],
        pm2ProcessName: 'link-bot',
        remote: 'origin',
        branch: 'main',
      },
    });
  });

  it('defaults codex hook config to disabled with safe defaults', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig());

    await expect(loadConfig(root)).resolves.toMatchObject({
      codexHooks: {
        enabled: false,
        autoRepair: false,
        socketPath: '.link-bot/codex-hooks.sock',
        permissionTimeoutMs: 300000,
        adminUsers: [],
      },
    });
  });

  it('loads explicit codex hook config', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({
      codexHooks: {
        enabled: true,
        autoRepair: true,
        socketPath: '/tmp/link-bot-hooks.sock',
        permissionTimeoutMs: 1000,
        adminUsers: ['ou_admin_1'],
      },
    }));

    await expect(loadConfig(root)).resolves.toMatchObject({
      codexHooks: {
        enabled: true,
        autoRepair: true,
        socketPath: '/tmp/link-bot-hooks.sock',
        permissionTimeoutMs: 1000,
        adminUsers: ['ou_admin_1'],
      },
    });
  });

  it('rejects malformed codex hook config values', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ codexHooks: { permissionTimeoutMs: 0 } }));

    await expect(loadConfig(root)).rejects.toThrow('Invalid config field: codexHooks.permissionTimeoutMs');
  });

  it('loads explicit upgrade config', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({
      upgrade: {
        enabled: true,
        adminUsers: ['ou_admin_1'],
        pm2ProcessName: 'link-bot-prod',
        remote: 'upstream',
        branch: 'develop',
      },
    }));

    await expect(loadConfig(root)).resolves.toMatchObject({
      upgrade: {
        enabled: true,
        adminUsers: ['ou_admin_1'],
        pm2ProcessName: 'link-bot-prod',
        remote: 'upstream',
        branch: 'develop',
      },
    });
  });

  it('rejects enabled upgrade config without admin users', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ upgrade: { enabled: true } }));

    await expect(loadConfig(root)).rejects.toThrow('Invalid config field: upgrade.adminUsers');
  });

  it('rejects malformed upgrade container', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ upgrade: true }));

    await expect(loadConfig(root)).rejects.toThrow('Invalid config field: upgrade');
  });

  it('defaults user and chat restrictions to disabled when omitted', async () => {
    const root = await createTmpDir();
    await writeConfig(root, {
      feishu: { appId: 'cli', appSecret: 'secret' },
      projects: [{ id: 'repo', name: 'Repo', path: '.', codexArgs: [] }],
      output: { directMaxChars: 1800, chunkSize: 1500 },
      codex: { command: 'codex', defaultArgs: [] },
    });

    await expect(loadConfig(root)).resolves.toMatchObject({
      restrictUsers: false,
      allowUnlistedGroupUsers: false,
      restrictChatIds: false,
      allowedUsers: [],
      allowedChatIds: [],
    });
  });

  it('loads explicit user and chat restriction switches', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({
      restrictUsers: true, allowUnlistedGroupUsers: true, restrictChatIds: false,
    }));

    await expect(loadConfig(root)).resolves.toMatchObject({
      restrictUsers: true,
      allowUnlistedGroupUsers: true,
      restrictChatIds: false,
      allowedUsers: ['ou_1'],
      allowedChatIds: ['oc_1'],
    });
  });

  it('loads custom notification config', async () => {
    const root = await createTmpDir();
    await writeConfig(root, {
      feishu: { appId: 'cli', appSecret: 'secret' },
      allowedUsers: ['ou_1'],
      allowedChatIds: ['oc_1'],
      projects: [{ id: 'repo', name: 'Repo', path: '.', codexArgs: [] }],
      output: { directMaxChars: 1800, chunkSize: 1500 },
      codex: { command: 'codex', defaultArgs: [] },
      logLevel: 'debug',
      notifications: { enabled: false, idleMs: 50, maxFinalChars: 1000, failureTailChars: 500 },
      ui: { verbosity: 'debug', currentRenderMode: 'code', timeZone: 'UTC' },
    });

    await expect(loadConfig(root)).resolves.toMatchObject({
      logLevel: 'debug',
      ui: { verbosity: 'debug', currentRenderMode: 'code', timeZone: 'UTC' },
      notifications: { enabled: false, idleMs: 50, maxFinalChars: 1000, failureTailChars: 500 },
    });
  });

  it('defaults log level to info when omitted', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig());

    await expect(loadConfig(root)).resolves.toMatchObject({
      logLevel: 'info',
    });
  });

  it('loads log level from config', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ logLevel: 'error' }));

    await expect(loadConfig(root)).resolves.toMatchObject({
      logLevel: 'error',
    });
  });

  it('rejects malformed notification config container', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ notifications: true }));

    await expect(loadConfig(root)).rejects.toThrow('Invalid config field: notifications');
  });

  it('rejects malformed notification enabled field', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ notifications: { enabled: 'yes' } }));

    await expect(loadConfig(root)).rejects.toThrow('Invalid config field: notifications.enabled');
  });

  it('rejects malformed notification idleMs field', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ notifications: { idleMs: 0 } }));

    await expect(loadConfig(root)).rejects.toThrow('Invalid config field: notifications.idleMs');
  });

  it('rejects malformed restrictUsers field', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ restrictUsers: 'yes' }));

    await expect(loadConfig(root)).rejects.toThrow('Invalid config field: restrictUsers');
  });

  it('rejects malformed logLevel field', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ logLevel: 'verbose' }));

    await expect(loadConfig(root)).rejects.toThrow('Invalid config field: logLevel');
  });
});


it('ships an internally consistent User Sandbox example configuration', async () => {
  const root = await createTmpDir();
  const example = JSON.parse(await (await import('node:fs/promises')).readFile('config.example.json', 'utf8'));
  await writeConfig(root, example);
  const loaded = await loadConfig(root);
  expect(loaded.userSandboxes).toMatchObject({ enabled: true, enabledOwners: [], legacyFallbackEnabled: false, transport: 'auto' });
  expect(loaded.readyPool.enabled).toBe(false);
  expect(loaded.taskPlatformRollout).toMatchObject({ projectlessWorkspaces: true, multiRepositoryTasks: true, conversationScopedTasks: true });
});

it('rejects an unsupported User Sandbox transport', async () => {
  const root = await createTmpDir(); await writeConfig(root, validConfig({ userSandboxes: { transport: 'public-tcp' } }));
  await expect(loadConfig(root)).rejects.toThrow('userSandboxes.transport');
});
