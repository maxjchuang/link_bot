import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { UpgradeConfig } from '../../src/domain/types.js';
import { FileStateStore } from '../../src/state/FileStateStore.js';
import { DestructiveCommandCoordinator } from '../../src/upgrade/DestructiveCommandCoordinator.js';
import type { UpgradeResult } from '../../src/upgrade/UpgradeManager.js';
import { createTmpDir } from '../helpers/tmp.js';

const upgradeConfig: UpgradeConfig = {
  enabled: true,
  adminUsers: ['ou_admin'],
  pm2ProcessName: 'link-bot',
  remote: 'origin',
  branch: 'main',
};

function restarted(): UpgradeResult {
  return {
    status: 'restart-triggered',
    reply: '',
    oldCommit: 'abc1234',
    newCommit: 'abc1234',
    event: { status: 'restart-triggered' },
  };
}

async function readEventTypes(root: string): Promise<string[]> {
  const eventDir = join(root, '.link-bot/events');
  const files = await readdir(eventDir);
  const contents = await Promise.all(
    files.filter((file) => file.endsWith('.jsonl')).map((file) => readFile(join(eventDir, file), 'utf8')),
  );
  return contents
    .flatMap((content) => content.split('\n').filter(Boolean))
    .map((line) => (JSON.parse(line) as { type: string }).type);
}

async function harness(options: { now?: () => Date } = {}) {
  const root = await createTmpDir();
  const store = new FileStateStore(root, options.now);
  const notifier = {
    sendRenderedMessageToTarget: vi.fn().mockResolvedValue(undefined),
    updateMessageCard: vi.fn().mockResolvedValue(undefined),
    sendTextToTarget: vi.fn().mockResolvedValue(undefined),
  };
  const upgradeManager = {
    upgrade: vi.fn().mockResolvedValue(restarted()),
    restart: vi.fn().mockResolvedValue(restarted()),
  };
  const coordinator = new DestructiveCommandCoordinator({
    store,
    config: upgradeConfig,
    upgradeManager,
    notifier,
    createRequestId: () => 'dcr_1',
  });
  return { root, store, notifier, upgradeManager, coordinator };
}

function decision(decision: 'confirm' | 'cancel', userId = 'ou_admin', chatId = 'oc_1') {
  return {
    chatId,
    chatType: 'private' as const,
    userId,
    messageId: 'om_card_1',
    action: { kind: 'destructive_command_decision' as const, requestId: 'dcr_1', decision },
  };
}

describe('DestructiveCommandCoordinator', () => {
  it('creates one confirmation and silently drops event retries and duplicate pending requests', async () => {
    const h = await harness();

    await h.coordinator.handleMenu({ eventId: 'evt_1', chatId: 'oc_1', userId: 'ou_admin', command: 'restart' });
    await h.coordinator.handleMenu({ eventId: 'evt_1', chatId: 'oc_1', userId: 'ou_admin', command: 'restart' });
    await h.coordinator.handleMenu({ eventId: 'evt_2', chatId: 'oc_1', userId: 'ou_admin', command: 'restart' });

    expect(h.notifier.sendRenderedMessageToTarget).toHaveBeenCalledTimes(1);
    expect(h.upgradeManager.restart).not.toHaveBeenCalled();
    await expect(readEventTypes(h.root)).resolves.toEqual(expect.arrayContaining([
      'destructive_command.request_created',
      'destructive_command.menu_retry_dropped',
      'destructive_command.pending_duplicate_dropped',
    ]));
  });

  it('silently drops missing event IDs and unauthorized users', async () => {
    const h = await harness();
    await h.coordinator.handleMenu({ chatId: 'oc_1', userId: 'ou_admin', command: 'upgrade' });
    await h.coordinator.handleMenu({ eventId: 'evt_2', chatId: 'oc_1', userId: 'ou_other', command: 'upgrade' });

    expect(h.notifier.sendRenderedMessageToTarget).not.toHaveBeenCalled();
    await expect(readEventTypes(h.root)).resolves.toEqual(expect.arrayContaining([
      'destructive_command.missing_event_id_dropped',
      'destructive_command.unauthorized_dropped',
    ]));
  });

  it('executes a confirmed command once and commits durable state before restart', async () => {
    const h = await harness();
    h.upgradeManager.restart.mockImplementation(async (input) => {
      await input.beforePm2Restart?.();
      await input.beforeRestart?.('restarting');
      return restarted();
    });
    await h.coordinator.handleMenu({ eventId: 'evt_1', chatId: 'oc_1', userId: 'ou_admin', command: 'restart' });

    await h.coordinator.handleDecision(decision('confirm'));
    await h.coordinator.handleDecision(decision('confirm'));

    expect(h.upgradeManager.restart).toHaveBeenCalledTimes(1);
    expect(h.notifier.updateMessageCard).toHaveBeenCalledWith('om_card_1', expect.objectContaining({ preferred: expect.any(Object) }));
    await expect(h.store.getDestructiveCommandRequest('dcr_1')).resolves.toMatchObject({ status: 'restart_committed' });
    await expect(readEventTypes(h.root)).resolves.toContain('destructive_command.restart_committed');
  });

  it('silently rejects a decision from another user or chat', async () => {
    const h = await harness();
    await h.coordinator.handleMenu({ eventId: 'evt_1', chatId: 'oc_1', userId: 'ou_admin', command: 'restart' });
    h.notifier.updateMessageCard.mockClear();

    await h.coordinator.handleDecision(decision('confirm', 'ou_other'));
    await h.coordinator.handleDecision(decision('confirm', 'ou_admin', 'oc_other'));

    expect(h.upgradeManager.restart).not.toHaveBeenCalled();
    expect(h.notifier.updateMessageCard).not.toHaveBeenCalled();
  });

  it('cancels once, disables the card, and silently drops later confirmation', async () => {
    const h = await harness();
    await h.coordinator.handleMenu({ eventId: 'evt_1', chatId: 'oc_1', userId: 'ou_admin', command: 'restart' });
    h.notifier.updateMessageCard.mockClear();

    await h.coordinator.handleDecision(decision('cancel'));
    await h.coordinator.handleDecision(decision('confirm'));

    expect(h.upgradeManager.restart).not.toHaveBeenCalled();
    expect(h.notifier.updateMessageCard).toHaveBeenCalledTimes(1);
    await expect(h.store.getDestructiveCommandRequest('dcr_1')).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('silently expires a confirmation at the exact deadline', async () => {
    let now = new Date('2026-07-13T02:00:00.000Z');
    const h = await harness({ now: () => now });
    await h.coordinator.handleMenu({ eventId: 'evt_1', chatId: 'oc_1', userId: 'ou_admin', command: 'restart' });
    h.notifier.updateMessageCard.mockClear();
    now = new Date('2026-07-13T02:10:00.000Z');

    await h.coordinator.handleDecision(decision('confirm'));

    expect(h.upgradeManager.restart).not.toHaveBeenCalled();
    expect(h.notifier.updateMessageCard).not.toHaveBeenCalled();
    await expect(readEventTypes(h.root)).resolves.toContain('destructive_command.expired_dropped');
  });

  it('marks an execution failure and updates the original card', async () => {
    const h = await harness();
    h.upgradeManager.upgrade.mockResolvedValue({
      status: 'failed',
      reply: 'Upgrade failed at npm-build: nope',
      failedStep: 'npm-build',
      error: 'nope',
      event: { status: 'failed' },
    });
    await h.coordinator.handleMenu({ eventId: 'evt_1', chatId: 'oc_1', userId: 'ou_admin', command: 'upgrade' });
    h.notifier.updateMessageCard.mockClear();

    await h.coordinator.handleDecision(decision('confirm'));

    await expect(h.store.getDestructiveCommandRequest('dcr_1')).resolves.toMatchObject({ status: 'failed', failure: 'nope' });
    expect(JSON.stringify(h.notifier.updateMessageCard.mock.calls.at(-1))).toContain('upgrade failed');
  });

  it('continues execution when the executing-card update fails', async () => {
    const h = await harness();
    h.notifier.updateMessageCard.mockRejectedValueOnce(new Error('card gone'));
    await h.coordinator.handleMenu({ eventId: 'evt_1', chatId: 'oc_1', userId: 'ou_admin', command: 'restart' });

    await h.coordinator.handleDecision(decision('confirm'));

    expect(h.upgradeManager.restart).toHaveBeenCalledTimes(1);
  });
});
