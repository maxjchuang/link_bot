import { describe, expect, it, vi } from 'vitest';
import type { UpgradeConfig } from '../../src/domain/types.js';
import { UpgradeManager, type UpgradeCommandRunner, type UpgradeStateStore } from '../../src/upgrade/UpgradeManager.js';

interface RecordedCommand {
  command: string;
  args: string[];
  cwd: string;
}

function config(overrides: Partial<UpgradeConfig> = {}): UpgradeConfig {
  return {
    enabled: true,
    adminUsers: ['ou_admin'],
    pm2ProcessName: 'link-bot',
    remote: 'origin',
    branch: 'main',
    ...overrides,
  };
}

function runner(outputs: Record<string, string | Error> = {}): UpgradeCommandRunner & { calls: RecordedCommand[] } {
  const calls: RecordedCommand[] = [];
  return {
    calls,
    run: vi.fn(async (command: string, args: string[], options: { cwd: string }) => {
      calls.push({ command, args, cwd: options.cwd });
      const key = `${command} ${args.join(' ')}`;
      const output = outputs[key] ?? '';
      if (output instanceof Error) {
        throw output;
      }
      return { stdout: output, stderr: '' };
    }),
  };
}

function stateStore(deployedCommit?: string): UpgradeStateStore & { writes: Array<{ deployedCommit: string; deployedAt: string }> } {
  const writes: Array<{ deployedCommit: string; deployedAt: string }> = [];
  return {
    writes,
    async read() {
      return { deployedCommit };
    },
    async write(state) {
      writes.push(state);
      deployedCommit = state.deployedCommit;
    },
  };
}

function pm2Process(input: {
  pm_id: number;
  name?: string;
  cwd?: string;
  execPath?: string;
}): Record<string, unknown> {
  return {
    pm_id: input.pm_id,
    name: input.name ?? 'link-bot',
    pm2_env: {
      pm_cwd: input.cwd,
      cwd: input.cwd,
      pm_exec_path: input.execPath,
    },
  };
}

function pm2Jlist(processes: Array<Record<string, unknown>>): string {
  return `${JSON.stringify(processes)}\n`;
}

function commandLines(calls: RecordedCommand[]): string[] {
  return calls.map((call) => `${call.command} ${call.args.join(' ')}`);
}

describe('UpgradeManager', () => {
  it('rejects disabled upgrades before running shell commands', async () => {
    const commandRunner = runner();
    const manager = new UpgradeManager({ projectRoot: '/repo', config: config({ enabled: false }), runner: commandRunner });

    await expect(manager.upgrade({ userId: 'ou_admin' })).resolves.toMatchObject({
      status: 'disabled',
      reply: 'Self-upgrade is disabled.',
      event: { status: 'disabled' },
    });
    expect(commandRunner.calls).toEqual([]);
  });

  it('rejects unauthorized users before running shell commands', async () => {
    const commandRunner = runner();
    const manager = new UpgradeManager({ projectRoot: '/repo', config: config(), runner: commandRunner });

    await expect(manager.upgrade({ userId: 'ou_other' })).resolves.toMatchObject({
      status: 'unauthorized',
      reply: 'You are not allowed to run /upgrade.',
      event: { status: 'unauthorized' },
    });
    expect(commandRunner.calls).toEqual([]);
  });

  it('restarts local worktree without checking cleanliness or fetching remote state', async () => {
    const commandRunner = runner({
      'git rev-parse HEAD': 'local123\n',
    });
    const state = stateStore();
    const manager = new UpgradeManager({ projectRoot: '/repo', config: config(), runner: commandRunner, state, currentPmId: '7' });

    await expect(manager.restart({ userId: 'ou_admin' })).resolves.toMatchObject({
      status: 'restart-triggered',
      oldCommit: 'local123',
      newCommit: 'local123',
      reply: 'Restarted local code at local12. Restarting link-bot with pm2.',
      event: { status: 'restart-triggered', oldCommit: 'local123', newCommit: 'local123', pm2ProcessName: 'link-bot' },
    });
    expect(commandLines(commandRunner.calls)).toEqual([
      'git rev-parse HEAD',
      'npm install',
      'npm run build',
      'pm2 restart 7',
    ]);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].deployedCommit).toBe('local123');
  });

  it('notifies before restarting so successful self-restarts can be observed', async () => {
    const beforeRestart = vi.fn().mockResolvedValue(undefined);
    const commandRunner = runner({
      'git rev-parse HEAD': 'local123\n',
    });
    const manager = new UpgradeManager({
      projectRoot: '/repo',
      config: config(),
      runner: commandRunner,
      state: stateStore(),
      currentPmId: '7',
    });

    await expect(manager.restart({ userId: 'ou_admin', beforeRestart })).resolves.toMatchObject({
      status: 'restart-triggered',
      reply: '',
      preRestartNotified: true,
    });
    expect(beforeRestart).toHaveBeenCalledWith('Restarted local code at local12. Restarting link-bot with pm2.');
    const restartCall = vi.mocked(commandRunner.run).mock.calls.findIndex((call) => call[0] === 'pm2' && call[1].join(' ') === 'restart 7');
    expect(restartCall).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(beforeRestart).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(commandRunner.run).mock.invocationCallOrder[restartCall],
    );
  });

  it('commits destructive state before notification and pm2 restart', async () => {
    const beforePm2Restart = vi.fn().mockResolvedValue(undefined);
    const beforeRestart = vi.fn().mockResolvedValue(undefined);
    const commandRunner = runner({
      'git rev-parse HEAD': 'local123\n',
    });
    const manager = new UpgradeManager({
      projectRoot: '/repo',
      config: config(),
      runner: commandRunner,
      state: stateStore(),
      currentPmId: '7',
    });

    await manager.restart({ userId: 'ou_admin', beforePm2Restart, beforeRestart });

    expect(beforePm2Restart).toHaveBeenCalledTimes(1);
    expect(vi.mocked(beforePm2Restart).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(beforeRestart).mock.invocationCallOrder[0],
    );
    const restartCall = vi.mocked(commandRunner.run).mock.calls.findIndex(
      ([command, args]) => command === 'pm2' && args.join(' ') === 'restart 7',
    );
    expect(vi.mocked(beforeRestart).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(commandRunner.run).mock.invocationCallOrder[restartCall],
    );
  });

  it('aborts restart when the durable commit hook fails', async () => {
    const commandRunner = runner({
      'git rev-parse HEAD': 'local123\n',
    });
    const manager = new UpgradeManager({
      projectRoot: '/repo',
      config: config(),
      runner: commandRunner,
      state: stateStore(),
      currentPmId: '7',
    });

    await expect(
      manager.restart({
        userId: 'ou_admin',
        beforePm2Restart: vi.fn().mockRejectedValue(new Error('disk full')),
      }),
    ).resolves.toMatchObject({ status: 'failed', failedStep: 'pre-restart-commit' });
    expect(commandLines(commandRunner.calls)).not.toContain('pm2 restart 7');
  });

  it('aborts upgrade when the durable commit hook fails', async () => {
    const commandRunner = runner({
      'git status --porcelain': '',
      'git rev-parse HEAD': 'old1234\n',
      'git rev-parse origin/main': 'new5678\n',
    });
    const manager = new UpgradeManager({
      projectRoot: '/repo',
      config: config(),
      runner: commandRunner,
      state: stateStore(),
      currentPmId: '7',
    });

    await expect(
      manager.upgrade({
        userId: 'ou_admin',
        beforePm2Restart: vi.fn().mockRejectedValue(new Error('disk full')),
      }),
    ).resolves.toMatchObject({ status: 'failed', failedStep: 'pre-restart-commit' });
    expect(commandLines(commandRunner.calls)).not.toContain('pm2 restart 7');
  });

  it('uses pm2 jlist path matching when current pm_id is unavailable', async () => {
    const commandRunner = runner({
      'git rev-parse HEAD': 'local123\n',
      'pm2 jlist': pm2Jlist([
        pm2Process({ pm_id: 3, cwd: '/other/repo', execPath: '/other/repo/dist/src/index.js' }),
        pm2Process({ pm_id: 9, cwd: '/repo', execPath: '/repo/dist/src/index.js' }),
      ]),
    });
    const manager = new UpgradeManager({ projectRoot: '/repo', config: config(), runner: commandRunner, state: stateStore(), currentPmId: '' });

    await expect(manager.restart({ userId: 'ou_admin' })).resolves.toMatchObject({
      status: 'restart-triggered',
      oldCommit: 'local123',
      newCommit: 'local123',
    });
    expect(commandLines(commandRunner.calls)).toContain('pm2 jlist');
    expect(commandLines(commandRunner.calls)).toContain('pm2 restart 9');
    expect(commandLines(commandRunner.calls)).not.toContain('pm2 restart link-bot');
  });

  it('fails instead of restarting by name when pm2 target matching is ambiguous', async () => {
    const commandRunner = runner({
      'git rev-parse HEAD': 'local123\n',
      'pm2 jlist': pm2Jlist([
        pm2Process({ pm_id: 3, cwd: '/repo', execPath: '/repo/dist/src/index.js' }),
        pm2Process({ pm_id: 9, cwd: '/repo', execPath: '/repo/dist/src/index.js' }),
      ]),
    });
    const state = stateStore();
    const manager = new UpgradeManager({ projectRoot: '/repo', config: config(), runner: commandRunner, state, currentPmId: '' });

    await expect(manager.restart({ userId: 'ou_admin' })).resolves.toMatchObject({
      status: 'failed',
      failedStep: 'pm2-target',
      error: 'Multiple PM2 processes match link-bot at /repo.',
    });
    expect(commandLines(commandRunner.calls)).not.toContain('pm2 restart link-bot');
    expect(state.writes).toEqual([]);
  });

  it('fails instead of restarting by name when no pm2 target matches the project path', async () => {
    const commandRunner = runner({
      'git rev-parse HEAD': 'local123\n',
      'pm2 jlist': pm2Jlist([pm2Process({ pm_id: 3, cwd: '/other/repo', execPath: '/other/repo/dist/src/index.js' })]),
    });
    const state = stateStore();
    const manager = new UpgradeManager({ projectRoot: '/repo', config: config(), runner: commandRunner, state, currentPmId: '' });

    await expect(manager.restart({ userId: 'ou_admin' })).resolves.toMatchObject({
      status: 'failed',
      failedStep: 'pm2-target',
      error: 'No PM2 process matches link-bot at /repo.',
    });
    expect(commandLines(commandRunner.calls)).not.toContain('pm2 restart link-bot');
    expect(state.writes).toEqual([]);
  });

  it('uses the same restart authorization and disabled checks as upgrade', async () => {
    const disabledRunner = runner();
    const disabled = new UpgradeManager({ projectRoot: '/repo', config: config({ enabled: false }), runner: disabledRunner });

    await expect(disabled.restart({ userId: 'ou_admin' })).resolves.toMatchObject({
      status: 'disabled',
      reply: 'Self-upgrade is disabled.',
    });
    expect(disabledRunner.calls).toEqual([]);

    const unauthorizedRunner = runner();
    const unauthorized = new UpgradeManager({ projectRoot: '/repo', config: config(), runner: unauthorizedRunner });

    await expect(unauthorized.restart({ userId: 'ou_other' })).resolves.toMatchObject({
      status: 'unauthorized',
      reply: 'You are not allowed to run /restart.',
    });
    expect(unauthorizedRunner.calls).toEqual([]);
  });

  it('stops local restart before pm2 restart when build fails', async () => {
    const commandRunner = runner({
      'git rev-parse HEAD': 'local123\n',
      'npm run build': new Error('build failed'),
    });
    const state = stateStore();
    const manager = new UpgradeManager({ projectRoot: '/repo', config: config(), runner: commandRunner, state, currentPmId: '7' });

    await expect(manager.restart({ userId: 'ou_admin' })).resolves.toMatchObject({
      status: 'failed',
      failedStep: 'npm-build',
      error: 'build failed',
      oldCommit: 'local123',
      newCommit: 'local123',
    });
    expect(commandLines(commandRunner.calls)).not.toContain('pm2 restart link-bot');
    expect(state.writes).toEqual([]);
  });

  it('rejects dirty worktrees before fetch', async () => {
    const commandRunner = runner({ 'git status --porcelain': ' M src/index.ts\n' });
    const manager = new UpgradeManager({ projectRoot: '/repo', config: config(), runner: commandRunner });

    await expect(manager.upgrade({ userId: 'ou_admin' })).resolves.toMatchObject({
      status: 'dirty-worktree',
      reply: 'Cannot upgrade: repository worktree is not clean.',
      event: { status: 'dirty-worktree', dirtyPreview: ' M src/index.ts\n' },
    });
    expect(commandLines(commandRunner.calls)).toEqual(['git status --porcelain']);
  });

  it('returns already-current only when HEAD equals remote branch and deployed state matches', async () => {
    const commandRunner = runner({
      'git rev-parse HEAD': 'abc123\n',
      'git rev-parse origin/main': 'abc123\n',
    });
    const state = stateStore('abc123');
    const manager = new UpgradeManager({ projectRoot: '/repo', config: config(), runner: commandRunner, state, currentPmId: '7' });

    await expect(manager.upgrade({ userId: 'ou_admin' })).resolves.toMatchObject({
      status: 'already-current',
      oldCommit: 'abc123',
      newCommit: 'abc123',
      event: { status: 'already-current', oldCommit: 'abc123', newCommit: 'abc123' },
    });
    expect(commandLines(commandRunner.calls)).toEqual([
      'git status --porcelain',
      'git fetch origin main',
      'git rev-parse HEAD',
      'git rev-parse origin/main',
    ]);
    expect(state.writes).toEqual([]);
  });

  it('retries deployment without checkout or merge when HEAD equals remote but deployed state is missing', async () => {
    const commandRunner = runner({
      'git rev-parse HEAD': 'abc123\n',
      'git rev-parse origin/main': 'abc123\n',
    });
    const state = stateStore();
    const manager = new UpgradeManager({ projectRoot: '/repo', config: config(), runner: commandRunner, state, currentPmId: '7' });

    await expect(manager.upgrade({ userId: 'ou_admin' })).resolves.toMatchObject({
      status: 'restart-triggered',
      oldCommit: 'abc123',
      newCommit: 'abc123',
    });
    expect(commandLines(commandRunner.calls)).toEqual([
      'git status --porcelain',
      'git fetch origin main',
      'git rev-parse HEAD',
      'git rev-parse origin/main',
      'npm install',
      'npm run build',
      'pm2 restart 7',
    ]);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].deployedCommit).toBe('abc123');
  });

  it('retries deployment without checkout or merge when HEAD equals remote but deployed state differs', async () => {
    const commandRunner = runner({
      'git rev-parse HEAD': 'abc123\n',
      'git rev-parse origin/main': 'abc123\n',
    });
    const state = stateStore('old123');
    const manager = new UpgradeManager({ projectRoot: '/repo', config: config(), runner: commandRunner, state, currentPmId: '7' });

    await expect(manager.upgrade({ userId: 'ou_admin' })).resolves.toMatchObject({
      status: 'restart-triggered',
      oldCommit: 'abc123',
      newCommit: 'abc123',
    });
    expect(commandLines(commandRunner.calls)).not.toContain('git checkout main');
    expect(commandLines(commandRunner.calls)).not.toContain('git merge --ff-only origin/main');
    expect(state.writes[0].deployedCommit).toBe('abc123');
  });

  it('stops before build when npm install fails', async () => {
    const commandRunner = runner({
      'git rev-parse HEAD': 'old\n',
      'git rev-parse origin/main': 'new\n',
      'npm install': new Error('install failed'),
    });
    const state = stateStore();
    const manager = new UpgradeManager({ projectRoot: '/repo', config: config(), runner: commandRunner, state, currentPmId: '7' });

    await expect(manager.upgrade({ userId: 'ou_admin' })).resolves.toMatchObject({
      status: 'failed',
      failedStep: 'npm-install',
      error: 'install failed',
      oldCommit: 'old',
      newCommit: 'new',
    });
    expect(commandLines(commandRunner.calls)).not.toContain('npm run build');
    expect(state.writes).toEqual([]);
  });

  it('stops before pm2 restart when build fails', async () => {
    const commandRunner = runner({
      'git rev-parse HEAD': 'old\n',
      'git rev-parse origin/main': 'new\n',
      'npm run build': new Error('build failed'),
    });
    const state = stateStore();
    const manager = new UpgradeManager({ projectRoot: '/repo', config: config(), runner: commandRunner, state });

    await expect(manager.upgrade({ userId: 'ou_admin' })).resolves.toMatchObject({
      status: 'failed',
      failedStep: 'npm-build',
      error: 'build failed',
      oldCommit: 'old',
      newCommit: 'new',
    });
    expect(commandLines(commandRunner.calls)).not.toContain('pm2 restart 7');
    expect(state.writes).toEqual([]);
  });

  it('truncates long failure messages in replies and events', async () => {
    const longError = `build failed: ${'x'.repeat(1000)}`;
    const commandRunner = runner({
      'git rev-parse HEAD': 'old\n',
      'git rev-parse origin/main': 'new\n',
      'npm run build': new Error(longError),
    });
    const manager = new UpgradeManager({ projectRoot: '/repo', config: config(), runner: commandRunner, state: stateStore() });

    const result = await manager.upgrade({ userId: 'ou_admin' });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toHaveLength(500);
      expect(result.reply).toHaveLength('Upgrade failed at npm-build: '.length + 500);
      expect(result.event.error).toHaveLength(500);
    }
  });

  it('runs fast-forward, install, build, and pm2 restart on success', async () => {
    const commandRunner = runner({
      'git rev-parse HEAD': 'old\n',
      'git rev-parse origin/main': 'new\n',
    });
    const state = stateStore();
    const manager = new UpgradeManager({ projectRoot: '/repo', config: config(), runner: commandRunner, state, currentPmId: '7' });

    await expect(manager.upgrade({ userId: 'ou_admin' })).resolves.toMatchObject({
      status: 'restart-triggered',
      oldCommit: 'old',
      newCommit: 'new',
      event: { status: 'restart-triggered', oldCommit: 'old', newCommit: 'new', pm2ProcessName: 'link-bot' },
    });
    expect(commandLines(commandRunner.calls)).toEqual([
      'git status --porcelain',
      'git fetch origin main',
      'git rev-parse HEAD',
      'git rev-parse origin/main',
      'git checkout main',
      'git merge --ff-only origin/main',
      'npm install',
      'npm run build',
      'pm2 restart 7',
    ]);
    expect(commandRunner.calls.every((call) => call.cwd === '/repo')).toBe(true);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].deployedCommit).toBe('new');
  });
});
