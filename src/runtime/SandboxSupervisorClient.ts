import { randomUUID } from 'node:crypto';
import { createSandboxConnection, dockerSandboxEndpoint, parseDockerSandboxEndpoint, type SandboxSocketConnector } from './SandboxSocketTransport.js';
import { basename, dirname, join } from 'node:path';
import type { SandboxRepoRequest, SandboxRepoResult } from '../projects/SandboxRepositoryCreationTypes.js';

type SupervisorRepoRequest = SandboxRepoRequest & { ownerUserId: string; sandboxGeneration: number };

export class SandboxRuntimeUpgradeRequiredError extends Error {
  constructor() {
    super('当前沙箱运行环境不支持自动更新 Codex 登录凭证。请由任务所属用户发送 /runtime upgrade，升级完成后重新发送原请求。工作区和会话会保留。');
    this.name = 'SandboxRuntimeUpgradeRequiredError';
  }
}

export interface SupervisorTaskSnapshot {
  taskId: string;
  threadId?: string;
  sandboxGeneration: number;
  processGeneration: number;
  socketPath: string;
  hostSocketPath: string;
  status: 'starting'|'running'|'stopping'|'exited'|'failed'|'not_found';
  pid?: number;
  startedAt?: string;
  outputGap?: boolean;
  failure?: string;
}

export interface SupervisorProjectWorkspace {
  branchName?: string;
  projectId: string;
  cwd: string;
  status: 'ready' | 'auth_required';
}

export class SandboxSupervisorClient {
  constructor(
    private readonly controlSocketPath: string,
    private readonly timeoutMs = 10_000,
    private readonly connect: SandboxSocketConnector = createSandboxConnection,
  ) {}

  async startTask(input: {
    taskId: string;
    threadId?: string;
    cwd: string;
    sandboxGeneration: number;
    processGeneration: number;
  }): Promise<SupervisorTaskSnapshot> {
    return this.withHostSocket(await this.request('StartTask', input));
  }

  async stopTask(input: {
    taskId: string;
    sandboxGeneration: number;
    expectedProcessGeneration: number;
    reason: string;
  }): Promise<{ taskId: string; status: 'stopped'|'not_found' }> {
    return this.request('StopTask', input);
  }

  async inspectTask(taskId: string): Promise<SupervisorTaskSnapshot | { taskId: string; status: 'not_found' }> {
    const result = await this.request<Record<string, unknown>>('InspectTask', { taskId });
    return result.status === 'not_found'
      ? result as { taskId: string; status: 'not_found' }
      : this.withHostSocket(result);
  }

  async listTasks(): Promise<SupervisorTaskSnapshot[]> {
    const result = await this.request<{ tasks: Array<Record<string, unknown>> }>('ListTasks', {});
    return result.tasks.map((task) => this.withHostSocket(task));
  }

  async health(): Promise<{ status: 'ready'|'stopping'; taskCount: number; maxAppServers: number; capabilities?: string[] }> {
    return this.request('Health', {});
  }

  async refreshCodexAuth(input: { ownerId: string; sandboxGeneration: number; contents: string }): Promise<{ updated: boolean }> {
    const health = await this.health();
    if (health.capabilities !== undefined && !health.capabilities.includes('RefreshCodexAuth')) {
      throw new SandboxRuntimeUpgradeRequiredError();
    }
    try {
      // Older supervisors do not advertise capabilities. Preserve compatibility
      // with versions that already support refresh but predate discovery.
      return await this.request('RefreshCodexAuth', input);
    } catch (error) {
      if (error instanceof Error && error.message === 'Supervisor RefreshCodexAuth failed: unsupported supervisor method: RefreshCodexAuth') {
        throw new SandboxRuntimeUpgradeRequiredError();
      }
      throw error;
    }
  }

  async ensureProject(input: { projectId: string; cloneUrl: string; baseRef: string }): Promise<SupervisorProjectWorkspace> {
    return this.request<SupervisorProjectWorkspace>('EnsureProject', input);
  }

  async validateRepositoryCreation(input: SupervisorRepoRequest): Promise<SandboxRepoResult> {
    return this.repositoryRequest('ValidateRepositoryCreation', input, 'validate');
  }

  async createRepository(input: SupervisorRepoRequest): Promise<SandboxRepoResult> {
    return this.repositoryRequest('CreateRepository', input, 'create');
  }

  async readRepositoryCreation(input: SupervisorRepoRequest): Promise<SandboxRepoResult> {
    return this.repositoryRequest('ReadRepositoryCreation', input, 'readback');
  }

  private async repositoryRequest(
    method: string, input: SupervisorRepoRequest, action: SandboxRepoRequest['action'],
  ): Promise<SandboxRepoResult> {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(input.operationId)) throw new Error('Invalid operationId.');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.ownerUserId)) throw new Error('Invalid ownerUserId.');
    const params = {
      action, operationId: input.operationId, provider: input.provider,
      namespace: input.namespace, name: input.name, private: input.private,
      ...(input.description ? { description: input.description } : {}),
      ownerUserId: input.ownerUserId, sandboxGeneration: input.sandboxGeneration,
    };
    const result = await this.request<Record<string, unknown>>(method, params, Math.max(this.timeoutMs, 300_000));
    return normalizedRepositoryResult(result);
  }

  private withHostSocket(value: Record<string, unknown>): SupervisorTaskSnapshot {
    const socketPath = requireString(value.socketPath, 'task socket path');
    const dockerTarget = parseDockerSandboxEndpoint(this.controlSocketPath);
    const hostTaskRoot = join(dirname(dockerTarget?.socketPath ?? this.controlSocketPath), 'tasks');
    if (!socketPath.startsWith('/run/link-bot/bridge/tasks/') && dirname(socketPath) !== hostTaskRoot) {
      throw new Error('Supervisor returned a task socket outside the bridge root.');
    }
    return {
      ...value,
      taskId: requireString(value.taskId, 'task id'),
      sandboxGeneration: requireGeneration(value.sandboxGeneration, 'sandbox generation'),
      processGeneration: requireGeneration(value.processGeneration, 'process generation'),
      socketPath,
      hostSocketPath: dockerTarget ? dockerSandboxEndpoint(dockerTarget.containerName, socketPath) : join(hostTaskRoot, basename(socketPath)),
      status: requireTaskStatus(value.status),
    } as SupervisorTaskSnapshot;
  }

  private request<T extends object>(method: string, params: Record<string, unknown>, timeoutMs = this.timeoutMs): Promise<T> {
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const socket = this.connect(this.controlSocketPath);
      let response = '';
      let settled = false;
      const finish = (operation: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        operation();
      };
      const timeout = setTimeout(() => finish(() => reject(new Error(`Supervisor ${method} timed out.`))), timeoutMs);
      socket.setEncoding('utf8');
      socket.once('connect', () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
      socket.on('data', (chunk) => {
        response += chunk;
        if (response.length > 1_048_576) {
          finish(() => reject(new Error('Supervisor response exceeds 1 MiB.')));
          return;
        }
        const newline = response.indexOf('\n');
        if (newline < 0) return;
        try {
          const parsed = JSON.parse(response.slice(0, newline)) as {
            id?: unknown; ok?: unknown; result?: unknown; error?: unknown;
          };
          if (parsed.id !== id) throw new Error('Supervisor response id mismatch.');
          if (parsed.ok !== true) throw new Error(`Supervisor ${method} failed: ${String(parsed.error ?? 'unknown error')}`);
          if (!parsed.result || typeof parsed.result !== 'object' || Array.isArray(parsed.result)) {
            throw new Error(`Supervisor ${method} returned an invalid result.`);
          }
          finish(() => resolve(parsed.result as T));
        } catch (error) {
          finish(() => reject(error));
        }
      });
      socket.once('error', (error) => finish(() => reject(error)));
      socket.once('end', () => {
        if (!settled) finish(() => reject(new Error(`Supervisor ${method} closed without a response.`)));
      });
    });
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid supervisor ${field}.`);
  return value;
}

function requireGeneration(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`Invalid supervisor ${field}.`);
  return value as number;
}

function requireTaskStatus(value: unknown): SupervisorTaskSnapshot['status'] {
  if (!['starting', 'running', 'stopping', 'exited', 'failed', 'not_found'].includes(String(value))) {
    throw new Error('Invalid supervisor task status.');
  }
  return value as SupervisorTaskSnapshot['status'];
}

function normalizedRepositoryResult(value: Record<string, unknown>): SandboxRepoResult {
  const status = value.status;
  if (!['ready', 'auth_required', 'created', 'not_found', 'exists_foreign', 'failed'].includes(String(status))) {
    return { status: 'failed', reason: 'invalid_helper_result' };
  }
  const reason = typeof value.reason === 'string' && /^[a-z][a-z0-9_]{0,100}$/.test(value.reason)
    ? value.reason : undefined;
  if (status !== 'created') return { status: status as SandboxRepoResult['status'], ...(reason ? { reason } : {}) };
  const providerRepoId = value.providerRepoId;
  const canonicalPath = value.canonicalPath;
  const cloneUrl = value.cloneUrl;
  const defaultBranch = value.defaultBranch;
  if (typeof providerRepoId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(providerRepoId)
    || /gh[pousr]_[A-Za-z0-9]{20,}/i.test(providerRepoId)
    || typeof canonicalPath !== 'string' || !/^[A-Za-z0-9._/-]{3,200}$/.test(canonicalPath)
    || typeof cloneUrl !== 'string' || !/^git@(github\.com):[A-Za-z0-9._/-]+\.git$/.test(cloneUrl)
    || typeof defaultBranch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(defaultBranch)
    || /gh[pousr]_[A-Za-z0-9]{20,}/i.test(defaultBranch)) {
    return { status: 'failed', reason: 'invalid_helper_result' };
  }
  return { status: 'created', providerRepoId, canonicalPath, cloneUrl, defaultBranch };
}
