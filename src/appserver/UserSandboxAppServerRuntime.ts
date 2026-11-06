import { createConnection } from 'node:net';
import type { StartTaskInput } from '../backends/CodexBackend.js';
import { SandboxSupervisorClient, type SupervisorTaskSnapshot } from '../runtime/SandboxSupervisorClient.js';
import { AppServerConnection } from './AppServerConnection.js';
import type { AppServerRuntime, AppServerRuntimeFactory } from './AppServerCodexBackend.js';

export interface UserSandboxTaskTarget {
  sandboxGeneration: number;
  supervisorSocketPath: string;
}

export interface SandboxSupervisorPort {
  startTask(input: {
    taskId: string;
    threadId?: string;
    cwd: string;
    sandboxGeneration: number;
    processGeneration: number;
  }): Promise<SupervisorTaskSnapshot>;
  stopTask(input: {
    taskId: string;
    sandboxGeneration: number;
    expectedProcessGeneration: number;
    reason: string;
  }): Promise<{ taskId: string; status: 'stopped'|'not_found' }>;
}

export function userSandboxAppServerRuntimeFactory(options: {
  resolveTarget(taskId: string): Promise<UserSandboxTaskTarget> | UserSandboxTaskTarget;
  recoverTarget?(taskId: string, error: unknown): Promise<UserSandboxTaskTarget>;
  createSupervisorClient?: (controlSocketPath: string) => SandboxSupervisorPort;
  connectTimeoutMs?: number;
  maxFrameBytes?: number;
}): AppServerRuntimeFactory {
  const createSupervisor = options.createSupervisorClient
    ?? ((controlSocketPath: string) => new SandboxSupervisorClient(controlSocketPath));
  return async (input: StartTaskInput, processGeneration: number): Promise<AppServerRuntime> => {
    let target = await options.resolveTarget(input.taskId);
    let supervisor = createSupervisor(target.supervisorSocketPath);
    const threadId = 'threadId' in input && typeof input.threadId === 'string' ? input.threadId : undefined;
    const start = () => startTaskWithSupervisorStartupRetry(supervisor, {
        taskId: input.taskId,
        ...(threadId ? { threadId } : {}),
        cwd: input.cwd,
        sandboxGeneration: target.sandboxGeneration,
        processGeneration,
      }, options.connectTimeoutMs ?? 10_000);
    let task: SupervisorTaskSnapshot;
    try {
      task = await start();
    } catch (error) {
      if (!options.recoverTarget || !isSupervisorTransportFailure(error)) throw error;
      target = await options.recoverTarget(input.taskId, error);
      supervisor = createSupervisor(target.supervisorSocketPath);
      task = await start();
    }
    let socket;
    try {
      socket = await connectTaskSocket(task.hostSocketPath, options.connectTimeoutMs ?? 10_000);
    } catch (error) {
      await supervisor.stopTask({
        taskId: input.taskId,
        sandboxGeneration: target.sandboxGeneration,
        expectedProcessGeneration: processGeneration,
        reason: 'host_connect_failed',
      }).catch(() => undefined);
      throw error;
    }
    const connection = new AppServerConnection({
      readable: socket,
      writable: socket,
      generation: processGeneration,
      maxBufferedBytes: options.maxFrameBytes,
      disconnectReason: () => `User Sandbox App Server disconnected (sandboxGeneration=${target.sandboxGeneration}, processGeneration=${processGeneration}).`,
    });
    return {
      connection,
      close: async () => {
        await connection.close().catch(() => undefined);
        await supervisor.stopTask({
          taskId: input.taskId,
          sandboxGeneration: target.sandboxGeneration,
          expectedProcessGeneration: processGeneration,
          reason: 'host_close',
        }).catch(() => undefined);
      },
    };
  };
}

function isSupervisorTransportFailure(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  if (['ENOENT', 'ECONNREFUSED', 'EPIPE'].includes(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /^Supervisor \w+ (?:timed out|closed without a response)\.?$/i.test(message);
}

async function startTaskWithSupervisorStartupRetry(
  supervisor: SandboxSupervisorPort,
  input: Parameters<SandboxSupervisorPort['startTask']>[0],
  timeoutMs: number,
): Promise<SupervisorTaskSnapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await supervisor.startTask(input);
    } catch (error) {
      if (Date.now() >= deadline || !isSupervisorTransportFailure(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function connectTaskSocket(path: string, timeoutMs: number): Promise<ReturnType<typeof createConnection>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to User Sandbox task socket: ${path}`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timeout);
      socket.off('error', onError);
      resolve(socket);
    });
    const onError = (error: Error) => {
      clearTimeout(timeout);
      socket.destroy();
      reject(error);
    };
    socket.once('error', onError);
  });
}
