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
  let lifecycleHandler: Parameters<FeishuGateway['start']>[3];
  const gateway = {
    start: vi.fn(async (messages: Parameters<FeishuGateway['start']>[0], cards: Parameters<FeishuGateway['start']>[1],
      _topic: Parameters<FeishuGateway['start']>[2], lifecycle: Parameters<FeishuGateway['start']>[3]) => {
      messageHandler = messages; cardHandler = cards; lifecycleHandler = lifecycle;
    }),
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
    lifecycle: (event: Parameters<NonNullable<Parameters<FeishuGateway['start']>[3]>>[0]) => lifecycleHandler!(event),
  };
}

describe('App Server-only startup', () => {
  it('rechecks the original group grant before returning a direct personal-agent reply', async () => {
    const h = await harness();
    h.config.personalAgent = {enabled: true, ownerUserId: 'ou_1'};
    let version = 1;
    h.platform.admitPersonalMessage = async message => ({...message, groupServiceVersion: version});
    h.controller.handleMessage.mockImplementation(async () => {version = 2; return {text: 'must not leave the server'};});
    await bootstrap(h.dependencies);
    await expect(h.message({chatId: 'oc_test', chatType: 'group', userId: 'ou_other', messageId: 'reply-race',
      wasMentioned: true, text: '@bot ordinary work'})).rejects.toThrow('Group service changed');
  });
  it('allows verified member details without granting approval or management callbacks', async () => {
    const h = await harness();
    h.config.personalAgent = {enabled: true, ownerUserId: 'ou_1'};
    h.platform.allowsPersonalDetailAction = async () => true;
    await bootstrap(h.dependencies);
    expect(await h.card({chatId: 'oc_test', chatType: 'group', userId: 'ou_other', messageId: 'detail-card',
      action: {kind: 'turn_detail', cardRef: 'reference', category: 'process'}})).toMatchObject({text: 'card handled'});
    expect(await h.card({chatId: 'oc_test', chatType: 'group', userId: 'ou_other', messageId: 'approval-card',
      action: {kind: 'app_server_request_decision', requestId: 'approval', generation: 1, decision: 'allow'}}))
      .toMatchObject({text: 'You are not allowed to control this bot.'});
    expect(h.controller.handleCardAction).toHaveBeenCalledTimes(1);
  });
  it('audits real lifecycle delivery while group admission remains disabled', async () => {
    const h = await harness(); h.config.personalAgent = {enabled: false};
    const store = new FileStateStore(await createTmpDir());
    const append = vi.spyOn(store, 'appendEvent');
    h.platform.handleGroupLifecycle = vi.fn(async () => undefined);
    await bootstrap({...h.dependencies, createStore: () => store});
    const event = {kind: 'removed' as const, chatId: 'oc_test', eventId: 'event_remove', occurredAt: 1000, operatorUserId: 'ou_1'};
    await h.lifecycle(event);
    expect(append).toHaveBeenCalledWith({type: 'group.lifecycle_observed', at: expect.any(String), data: event});
    expect(h.platform.handleGroupLifecycle).toHaveBeenCalledWith(event);
    expect(h.config.personalAgent.enabled).toBe(false);
    expect(h.config.allowUnlistedGroupUsers).toBe(false);
  });
  it('admits only server-qualified personal-agent group messages without widening the user list', async () => {
    const h = await harness();
    h.config.personalAgent = {enabled: true, ownerUserId: 'ou_1'};
    h.config.allowUnlistedGroupUsers = false;
    h.platform.admitPersonalMessage = async message => message.chatId === 'oc_test'
      ? {...message, groupServiceVersion: 7} : undefined;
    const users = [...h.config.allowedUsers];
    await bootstrap(h.dependencies);
    const request = {chatId: 'oc_test', chatType: 'group' as const, userId: 'ou_nonadmin',
      messageId: 'create_doc', text: '@bot 写一篇规划文档', wasMentioned: true};
    expect(await h.message(request)).toMatchObject({text: 'handled by App Server'});
    expect(h.controller.handleMessage).toHaveBeenCalledWith({...request, groupServiceVersion: 7});
    expect(await h.message({...request, chatId: 'oc_other', messageId: 'wrong_group', groupServiceVersion: 7}))
      .toMatchObject({text: 'You are not allowed to control this bot.'});
    expect(await h.message({...request, text: '/restart', messageId: 'admin_command'}))
      .toMatchObject({text: expect.stringContaining('所有者')});
    expect(h.controller.handleMessage).toHaveBeenCalledTimes(1);
    expect(h.config.allowedUsers).toEqual(users);
    expect(h.config.allowUnlistedGroupUsers).toBe(false);
  });
  it('fails closed for nonowner messages when a personal admission integration is missing', async () => {
    const h = await harness(); h.config.personalAgent = {enabled: true, ownerUserId: 'ou_1'};
    h.config.allowUnlistedGroupUsers = true; // The legacy bypass cannot grant new-mode access.
    await bootstrap(h.dependencies);
    expect(await h.message({chatId: 'oc_test', chatType: 'group', userId: 'ou_other',
      messageId: 'not_admitted', text: '@bot hello', wasMentioned: true})).toMatchObject({text: 'You are not allowed to control this bot.'});
    expect(h.controller.handleMessage).not.toHaveBeenCalled();
  });
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
