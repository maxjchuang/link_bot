import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

export interface HostRestartRequest {
  managerName: string;
  requestedAt: string;
  requestedBy: string;
  state: 'requested' | 'ready' | 'executing' | 'completed' | 'failed';
  updatedAt: string;
  lastError?: string;
}

export class HostRestartCoordinator {
  constructor(
    private readonly requestPath: string,
    private readonly managerName: string,
    private readonly projectRoot: string,
    private readonly clock: () => Date = () => new Date(),
    private readonly restartProcess: (managerName: string, projectRoot: string) => void = spawnRestart,
  ) {}

  async reconcileStartup(): Promise<void> {
    const request = await this.read();
    if (!request || request.managerName !== this.managerName) return;
    // Reaching startup means a replacement manager is now healthy enough to
    // reconcile persisted intent. A request can still be in `requested` when
    // the old event pump crashed before its normal completion handoff; keeping
    // it draining would reject every future private message forever.
    if (request.state === 'requested' || request.state === 'executing' || request.state === 'ready') {
      await this.write({ ...request, state: 'completed', updatedAt: this.clock().toISOString() });
    }
  }

  async isDraining(): Promise<boolean> {
    const request = await this.read();
    return Boolean(request && request.managerName === this.managerName
      && ['requested', 'ready', 'executing'].includes(request.state));
  }

  async handoffAfterTurn(): Promise<boolean> {
    const request = await this.read();
    if (!request) return false;
    if (request.managerName !== this.managerName) throw new Error('Deferred host-manager restart target does not match configuration.');
    if (request.state !== 'requested') return false;
    const ready = { ...request, state: 'ready' as const, updatedAt: this.clock().toISOString() };
    await this.write(ready);
    try {
      await this.write({ ...ready, state: 'executing', updatedAt: this.clock().toISOString() });
      this.restartProcess(this.managerName, this.projectRoot);
      return true;
    } catch (error) {
      await this.write({
        ...ready, state: 'failed', updatedAt: this.clock().toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async read(): Promise<HostRestartRequest | undefined> {
    return readFile(this.requestPath, 'utf8').then(
      (value) => {
        const parsed = JSON.parse(value) as Partial<HostRestartRequest>;
        if (!parsed.managerName || !parsed.requestedAt || !parsed.requestedBy) return undefined;
        return {
          managerName: parsed.managerName, requestedAt: parsed.requestedAt, requestedBy: parsed.requestedBy,
          state: parsed.state ?? 'requested', updatedAt: parsed.updatedAt ?? parsed.requestedAt,
          ...(parsed.lastError ? { lastError: parsed.lastError } : {}),
        };
      },
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error),
    );
  }

  private async write(request: HostRestartRequest): Promise<void> {
    await writeFile(this.requestPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}

function spawnRestart(managerName: string, projectRoot: string): void {
  const child = spawn('pm2', ['restart', managerName, '--update-env'], {
    cwd: projectRoot, detached: true, stdio: 'ignore', env: process.env,
  });
  child.unref();
}
