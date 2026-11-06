import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HostRestartCoordinator } from '../../src/host/HostRestartCoordinator.js';

describe('HostRestartCoordinator', () => {
  it('persists the ready/executing handoff before spawning the protected restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'host-restart-'));
    const path = join(root, 'request.json');
    await writeFile(path, JSON.stringify({
      managerName: 'link-bot-host-manager', requestedAt: '2026-08-08T00:00:00Z',
      requestedBy: 'host-control', state: 'requested', updatedAt: '2026-08-08T00:00:00Z',
    }));
    const restart = vi.fn();
    const coordinator = new HostRestartCoordinator(
      path, 'link-bot-host-manager', root, () => new Date('2026-08-08T00:01:00Z'), restart,
    );

    await expect(coordinator.isDraining()).resolves.toBe(true);
    await expect(coordinator.handoffAfterTurn()).resolves.toBe(true);
    expect(restart).toHaveBeenCalledWith('link-bot-host-manager', root);
    await expect(readFile(path, 'utf8')).resolves.toContain('"state": "executing"');
  });

  it('marks an executing request completed when the replacement manager becomes healthy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'host-restart-reconcile-'));
    const path = join(root, 'request.json');
    await writeFile(path, JSON.stringify({
      managerName: 'link-bot-host-manager', requestedAt: '2026-08-08T00:00:00Z',
      requestedBy: 'host-control', state: 'executing', updatedAt: '2026-08-08T00:01:00Z',
    }));
    const coordinator = new HostRestartCoordinator(path, 'link-bot-host-manager', root);

    await coordinator.reconcileStartup();

    await expect(coordinator.isDraining()).resolves.toBe(false);
    await expect(readFile(path, 'utf8')).resolves.toContain('"state": "completed"');
  });

  it('clears a requested drain when the old event pump died before handoff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'host-restart-requested-reconcile-'));
    const path = join(root, 'request.json');
    await writeFile(path, JSON.stringify({
      managerName: 'link-bot-host-manager', requestedAt: '2026-08-08T00:00:00Z',
      requestedBy: 'host-control', state: 'requested', updatedAt: '2026-08-08T00:00:00Z',
    }));
    const coordinator = new HostRestartCoordinator(path, 'link-bot-host-manager', root);

    await coordinator.reconcileStartup();

    await expect(coordinator.isDraining()).resolves.toBe(false);
    await expect(readFile(path, 'utf8')).resolves.toContain('"state": "completed"');
  });
});
