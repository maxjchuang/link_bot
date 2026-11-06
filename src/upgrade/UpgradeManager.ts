import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { promisify } from 'node:util';
import type { UpgradeConfig } from '../domain/types.js';

const execFileAsync = promisify(execFile);
const maxErrorChars = 500;

export interface UpgradeCommandRunner {
  run(command: string, args: string[], options: { cwd: string }): Promise<{ stdout: string; stderr: string }>;
}

export class NodeUpgradeCommandRunner implements UpgradeCommandRunner {
  async run(command: string, args: string[], options: { cwd: string }): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      maxBuffer: 1024 * 1024,
    });
    return { stdout: String(stdout), stderr: String(stderr) };
  }
}

export interface UpgradeStateStore {
  read(): Promise<{ deployedCommit?: string }>;
  write(state: { deployedCommit: string; deployedAt: string }): Promise<void>;
}

export class FileUpgradeStateStore implements UpgradeStateStore {
  private readonly path: string;

  constructor(projectRoot: string) {
    this.path = join(projectRoot, '.link-bot', 'upgrade-state.json');
  }

  async read(): Promise<{ deployedCommit?: string }> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || typeof parsed.deployedCommit !== 'string') {
        return {};
      }
      return { deployedCommit: parsed.deployedCommit };
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return {};
      }
      throw error;
    }
  }

  async write(state: { deployedCommit: string; deployedAt: string }): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }
}

export type UpgradeResult =
  | { status: 'disabled'; reply: string; event: Record<string, unknown> }
  | { status: 'unauthorized'; reply: string; event: Record<string, unknown> }
  | { status: 'dirty-worktree'; reply: string; event: Record<string, unknown> }
  | { status: 'already-current'; reply: string; oldCommit: string; newCommit: string; event: Record<string, unknown> }
  | {
      status: 'failed';
      reply: string;
      failedStep: string;
      error: string;
      oldCommit?: string;
      newCommit?: string;
      event: Record<string, unknown>;
    }
  | {
      status: 'restart-triggered';
      reply: string;
      oldCommit: string;
      newCommit: string;
      preRestartNotified?: boolean;
      event: Record<string, unknown>;
    };

export interface UpgradeManagerDeps {
  projectRoot: string;
  config: UpgradeConfig;
  runner?: UpgradeCommandRunner;
  state?: UpgradeStateStore;
  currentPmId?: string;
}

type StepResult = { ok: true; stdout: string; stderr: string } | { ok: false; error: string };
type RestartInput = {
  userId: string;
  beforePm2Restart?: () => Promise<void>;
  beforeRestart?: (message: string) => Promise<void>;
};
type Pm2Target = { ok: true; pmId: string } | { ok: false; error: string };
type RestartPm2Result =
  | { ok: true; pmId: string; preRestartNotified: boolean }
  | { ok: false; failedStep: 'pre-restart-commit' | 'pm2-target'; error: string };

export class UpgradeManager {
  private readonly runner: UpgradeCommandRunner;
  private readonly state: UpgradeStateStore;

  constructor(private readonly deps: UpgradeManagerDeps) {
    this.runner = deps.runner ?? new NodeUpgradeCommandRunner();
    this.state = deps.state ?? new FileUpgradeStateStore(deps.projectRoot);
  }

  async upgrade(input: RestartInput): Promise<UpgradeResult> {
    const config = this.deps.config;
    if (!config.enabled) {
      return simpleResult('disabled', 'Self-upgrade is disabled.', { enabled: false });
    }
    if (!config.adminUsers.includes(input.userId)) {
      return simpleResult('unauthorized', 'You are not allowed to run /upgrade.', { userId: input.userId });
    }

    const dirty = await this.runStep('git-status', 'git', ['status', '--porcelain']);
    if (!dirty.ok) {
      return failedResult('git-status', dirty.error);
    }
    if (dirty.stdout.trim() !== '') {
      return {
        status: 'dirty-worktree',
        reply: 'Cannot upgrade: repository worktree is not clean.',
        event: { status: 'dirty-worktree', dirtyPreview: preview(dirty.stdout) },
      };
    }

    const fetched = await this.runStep('git-fetch', 'git', ['fetch', config.remote, config.branch]);
    if (!fetched.ok) {
      return failedResult('git-fetch', fetched.error);
    }

    const head = await this.runStep('git-head', 'git', ['rev-parse', 'HEAD']);
    if (!head.ok) {
      return failedResult('git-head', head.error);
    }

    const remoteRef = `${config.remote}/${config.branch}`;
    const remote = await this.runStep('git-remote-head', 'git', ['rev-parse', remoteRef]);
    if (!remote.ok) {
      return failedResult('git-remote-head', remote.error);
    }

    const oldCommit = head.stdout.trim();
    const newCommit = remote.stdout.trim();
    const deployedState = await this.readState();
    if (!deployedState.ok) {
      return failedResult('deployment-state-read', deployedState.error, { oldCommit, newCommit });
    }
    if (oldCommit === newCommit) {
      if (deployedState.state.deployedCommit === newCommit) {
        return {
          status: 'already-current',
          reply: `Already up to date at ${shortSha(oldCommit)}.`,
          oldCommit,
          newCommit,
          event: { status: 'already-current', oldCommit, newCommit },
        };
      }
    }

    const steps: Array<{ step: string; command: string; args: string[] }> = [
      { step: 'npm-install', command: 'npm', args: ['install'] },
      { step: 'npm-build', command: 'npm', args: ['run', 'build'] },
    ];
    if (oldCommit !== newCommit) {
      steps.unshift(
        { step: 'git-checkout', command: 'git', args: ['checkout', config.branch] },
        { step: 'git-fast-forward', command: 'git', args: ['merge', '--ff-only', remoteRef] },
      );
    }

    for (const { step, command, args } of steps) {
      const result = await this.runStep(step, command, args);
      if (!result.ok) {
        return failedResult(step, result.error, { oldCommit, newCommit });
      }
    }

    const restartMessage = `Upgrade installed ${shortSha(newCommit)}. Restarting ${config.pm2ProcessName} with pm2.`;
    const restarted = await this.restartPm2Process(restartMessage, input.beforePm2Restart, input.beforeRestart);
    if (!restarted.ok) {
      return failedResult(restarted.failedStep, restarted.error, { oldCommit, newCommit });
    }

    const stateWrite = await this.writeState(newCommit);
    if (!stateWrite.ok) {
      return failedResult('deployment-state-write', stateWrite.error, { oldCommit, newCommit });
    }

    return {
      status: 'restart-triggered',
      reply: restarted.preRestartNotified ? '' : restartMessage,
      oldCommit,
      newCommit,
      preRestartNotified: restarted.preRestartNotified,
      event: {
        status: 'restart-triggered',
        oldCommit,
        newCommit,
        pm2ProcessName: config.pm2ProcessName,
        pm2Target: restarted.pmId,
        preRestartNotified: restarted.preRestartNotified,
      },
    };
  }

  async restart(input: RestartInput): Promise<UpgradeResult> {
    const config = this.deps.config;
    if (!config.enabled) {
      return simpleResult('disabled', 'Self-upgrade is disabled.', { enabled: false });
    }
    if (!config.adminUsers.includes(input.userId)) {
      return simpleResult('unauthorized', 'You are not allowed to run /restart.', { userId: input.userId });
    }

    const head = await this.runStep('git-head', 'git', ['rev-parse', 'HEAD']);
    if (!head.ok) {
      return failedResult('git-head', head.error);
    }

    const currentCommit = head.stdout.trim();
    const steps: Array<{ step: string; command: string; args: string[] }> = [
      { step: 'npm-install', command: 'npm', args: ['install'] },
      { step: 'npm-build', command: 'npm', args: ['run', 'build'] },
    ];

    for (const { step, command, args } of steps) {
      const result = await this.runStep(step, command, args);
      if (!result.ok) {
        return failedResult(step, result.error, { oldCommit: currentCommit, newCommit: currentCommit });
      }
    }

    const restartMessage = `Restarted local code at ${shortSha(currentCommit)}. Restarting ${config.pm2ProcessName} with pm2.`;
    const restarted = await this.restartPm2Process(restartMessage, input.beforePm2Restart, input.beforeRestart);
    if (!restarted.ok) {
      return failedResult(restarted.failedStep, restarted.error, { oldCommit: currentCommit, newCommit: currentCommit });
    }

    const stateWrite = await this.writeState(currentCommit);
    if (!stateWrite.ok) {
      return failedResult('deployment-state-write', stateWrite.error, { oldCommit: currentCommit, newCommit: currentCommit });
    }

    return {
      status: 'restart-triggered',
      reply: restarted.preRestartNotified ? '' : restartMessage,
      oldCommit: currentCommit,
      newCommit: currentCommit,
      preRestartNotified: restarted.preRestartNotified,
      event: {
        status: 'restart-triggered',
        oldCommit: currentCommit,
        newCommit: currentCommit,
        pm2ProcessName: config.pm2ProcessName,
        pm2Target: restarted.pmId,
        preRestartNotified: restarted.preRestartNotified,
      },
    };
  }

  private async restartPm2Process(
    message: string,
    beforePm2Restart?: () => Promise<void>,
    beforeRestart?: (message: string) => Promise<void>,
  ): Promise<RestartPm2Result> {
    const target = await this.resolvePm2Target();
    if (!target.ok) {
      return { ok: false, failedStep: 'pm2-target', error: target.error };
    }

    if (beforePm2Restart) {
      try {
        await beforePm2Restart();
      } catch (error) {
        return { ok: false, failedStep: 'pre-restart-commit', error: formatError(error) };
      }
    }

    let preRestartNotified = false;
    if (beforeRestart) {
      try {
        await beforeRestart(message);
        preRestartNotified = true;
      } catch {
        preRestartNotified = false;
      }
    }

    const restarted = await this.runStep('pm2-restart', 'pm2', ['restart', target.pmId]);
    if (!restarted.ok) {
      return { ok: false, failedStep: 'pm2-target', error: restarted.error };
    }
    return { ok: true, pmId: target.pmId, preRestartNotified };
  }

  private async resolvePm2Target(): Promise<Pm2Target> {
    const currentPmId = this.deps.currentPmId ?? process.env.pm_id;
    if (currentPmId?.trim()) {
      return { ok: true, pmId: currentPmId.trim() };
    }

    const listed = await this.runStep('pm2-jlist', 'pm2', ['jlist']);
    if (!listed.ok) {
      return { ok: false, error: listed.error };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(listed.stdout);
    } catch {
      return { ok: false, error: 'Unable to parse pm2 jlist output.' };
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, error: 'Unable to parse pm2 jlist output.' };
    }

    const projectRoot = normalizePath(this.deps.projectRoot);
    const expectedExecPath = normalizePath(join(this.deps.projectRoot, 'dist/src/index.js'));
    const matches = parsed.filter((entry) => this.matchesPm2Process(entry, projectRoot, expectedExecPath));
    if (matches.length === 0) {
      return { ok: false, error: `No PM2 process matches ${this.deps.config.pm2ProcessName} at ${this.deps.projectRoot}.` };
    }
    if (matches.length > 1) {
      return { ok: false, error: `Multiple PM2 processes match ${this.deps.config.pm2ProcessName} at ${this.deps.projectRoot}.` };
    }

    const pmId = readPmId(matches[0]);
    if (!pmId) {
      return { ok: false, error: `Matched PM2 process for ${this.deps.config.pm2ProcessName} does not have a pm_id.` };
    }
    return { ok: true, pmId };
  }

  private matchesPm2Process(entry: unknown, projectRoot: string, expectedExecPath: string): boolean {
    if (!isRecord(entry) || entry.name !== this.deps.config.pm2ProcessName || !isRecord(entry.pm2_env)) {
      return false;
    }
    const env = entry.pm2_env;
    const cwd = typeof env.pm_cwd === 'string' ? env.pm_cwd : typeof env.cwd === 'string' ? env.cwd : undefined;
    if (!cwd || normalizePath(cwd) !== projectRoot) {
      return false;
    }
    if (typeof env.pm_exec_path === 'string' && normalizePath(env.pm_exec_path) !== expectedExecPath) {
      return false;
    }
    return true;
  }

  private async runStep(step: string, command: string, args: string[]): Promise<StepResult> {
    try {
      const result = await this.runner.run(command, args, { cwd: this.deps.projectRoot });
      return { ok: true, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async readState(): Promise<{ ok: true; state: { deployedCommit?: string } } | { ok: false; error: string }> {
    try {
      return { ok: true, state: await this.state.read() };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }

  private async writeState(deployedCommit: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.state.write({ deployedCommit, deployedAt: new Date().toISOString() });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }
}

function simpleResult<TStatus extends 'disabled' | 'unauthorized'>(
  status: TStatus,
  reply: string,
  event: Record<string, unknown>,
): Extract<UpgradeResult, { status: TStatus }> {
  return { status, reply, event: { status, ...event } } as Extract<UpgradeResult, { status: TStatus }>;
}

function failedResult(
  failedStep: string,
  error: string,
  data: { oldCommit?: string; newCommit?: string } = {},
): Extract<UpgradeResult, { status: 'failed' }> {
  const safeError = truncate(error, maxErrorChars);
  return {
    status: 'failed',
    failedStep,
    error: safeError,
    reply: `Upgrade failed at ${failedStep}: ${safeError}`,
    oldCommit: data.oldCommit,
    newCommit: data.newCommit,
    event: { status: 'failed', failedStep, error: safeError, ...data },
  };
}

function formatError(error: unknown): string {
  return truncate(error instanceof Error ? error.message : String(error), maxErrorChars);
}

function shortSha(value: string): string {
  return value.slice(0, 7);
}

function readPmId(entry: unknown): string | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  if (typeof entry.pm_id === 'number' && Number.isFinite(entry.pm_id)) {
    return String(entry.pm_id);
  }
  if (typeof entry.pm_id === 'string' && entry.pm_id.trim()) {
    return entry.pm_id.trim();
  }
  return undefined;
}

function normalizePath(value: string): string {
  return normalize(value).replace(/[\\/]+$/, '');
}

function preview(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 497)}...`;
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
