import { describe, expect, it, vi } from 'vitest';
import { bootstrap } from '../../src/index.js';
import type { FeishuGateway } from '../../src/feishu/FeishuGateway.js';
import type { TaskPlatformApplication } from '../../src/app/createTaskPlatform.js';
import { FileStateStore } from '../../src/state/FileStateStore.js';
import { sampleConfig } from '../helpers/fakes.js';
import { createTmpDir } from '../helpers/tmp.js';

vi.mock('../../src/codex/CodexHome.js', () => ({
  initializeProjectCodexHome: vi.fn(async ({ projectRoot }: { projectRoot: string }) => ({ codexHome: `${projectRoot}/auth`, configToml: 'existing' })),
  resolveCodexHomePaths: (root: string) => ({ project: `${root}/auth`, global: `${root}/auth` }),
}));

async function harness() {
  const root = await createTmpDir();
  const config = sampleConfig(root);
  config.taskPlatformRollout.enabled = true;
  config.readyPool.enabled = false;
  config.userSandboxes = { enabled: true, enabledOwners: [], legacyFallbackEnabled: false,
    maxAppServersPerUser: 8, maxActiveTurnsPerUser: 1, processIdleTimeoutMinutes: 120,
    containerIdleTimeoutMinutes: 1440, containerWrapperRetentionHours: 24 };
  let messageHandler: Parameters<FeishuGateway['start']>[0];
  let cardHandler: Parameters<FeishuGateway['start']>[1];
  const gateway = {
    start: vi.fn(async (messages: Parameters<FeishuGateway['start']>[0], cards: Parameters<FeishuGateway['start']>[1]) => { messageHandler = messages; cardHandler = cards; }),
    sendRenderedMessageToTarget: vi.fn(), updateMessageCard: vi.fn(),
  } as unknown as FeishuGateway;
  const controller = { handleMessage: vi.fn(async () => ({ text: 'handled by App Server' })), handleCardAction: vi.fn(async () => ({ text: 'card handled' })) };
  const platform = {
    controller, store: new FileStateStore(root),
    healthCheck: vi.fn(async () => ({ ok: true as const })),
    recoverStartup: vi.fn(), close: vi.fn(), shouldHandleMessage: () => true,
  } as unknown as TaskPlatformApplication;
  const dependencies = {
    projectRoot: root, loadConfig: async () => config, createGateway: () => gateway,
    createTaskPlatform: () => platform, logger: { info: vi.fn(), error: vi.fn() },
  };
  return { config, gateway, controller, platform, dependencies,
    message: (...args: Parameters<Parameters<FeishuGateway['start']>[0]>) => messageHandler(...args),
    card: (action: Parameters<NonNullable<Parameters<FeishuGateway['start']>[1]>>[0]) => cardHandler!(action),
  };
}

describe('App Server-only startup', () => {
  it('checks and recovers the task platform before accepting messages', async () => {
    const h = await harness();
    await bootstrap(h.dependencies);
    expect(h.platform.healthCheck).toHaveBeenCalledOnce();
    expect(h.platform.recoverStartup).toHaveBeenCalledOnce();
    expect(await h.message({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', messageId: 'om_1', text: '@bot hello', wasMentioned: true }))
      .toMatchObject({ text: 'handled by App Server' });
    expect(h.controller.handleMessage).toHaveBeenCalledOnce();
  });
  it('does not start a fallback execution path when the task platform is disabled', async () => {
    const h = await harness(); h.config.taskPlatformRollout.enabled = false;
    await expect(bootstrap(h.dependencies)).rejects.toThrow('App Server task platform must be enabled');
    expect(h.gateway.start).not.toHaveBeenCalled();
  });
  it('refuses a per-task container fallback before starting the gateway', async () => {
    const h = await harness(); h.config.userSandboxes!.legacyFallbackEnabled = true;
    await expect(bootstrap(h.dependencies)).rejects.toThrow('User Sandbox must be enabled');
    expect(h.gateway.start).not.toHaveBeenCalled();
  });
  it('checks the current allowlist before routing any card action', async () => {
    const h = await harness(); await bootstrap(h.dependencies);
    expect(await h.card({ chatId: 'oc_1', chatType: 'group', userId: 'ou_outsider', messageId: 'om_card',
      action: { kind: 'tool_auth_check', pendingId: 'auth_1', ownerUserId: 'ou_outsider' } } as Parameters<NonNullable<Parameters<FeishuGateway['start']>[1]>>[0]))
      .toMatchObject({ text: 'You are not allowed to control this bot.' });
    expect(h.controller.handleCardAction).not.toHaveBeenCalled();
  });
});
