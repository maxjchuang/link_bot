import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { userSandboxAppServerRuntimeFactory } from '../../src/appserver/UserSandboxAppServerRuntime.js';
import type { SupervisorTaskSnapshot } from '../../src/runtime/SandboxSupervisorClient.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('userSandboxAppServerRuntimeFactory', () => {
  it('starts a generation-fenced task through the Supervisor and connects its UDS', async () => {
    const root = await createTmpDir();
    const socketPath = join(root, 'task.sock');
    const server = createServer(() => undefined);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    const startTask = vi.fn(async (): Promise<SupervisorTaskSnapshot> => ({
      taskId: 'task_1', sandboxGeneration: 4, processGeneration: 9,
      socketPath: '/run/link-bot/bridge/tasks/task_1-9.sock', hostSocketPath: socketPath, status: 'running',
    }));
    const stopTask = vi.fn(async () => ({ taskId: 'task_1', status: 'stopped' as const }));
    const factory = userSandboxAppServerRuntimeFactory({
      resolveTarget: () => ({ sandboxGeneration: 4, supervisorSocketPath: join(root, 'supervisor.sock') }),
      createSupervisorClient: () => ({ startTask, stopTask }),
    });

    const runtime = await factory({ taskId: 'task_1', cwd: '/workspace', args: [] }, 9);

    expect(runtime.connection.generation).toBe(9);
    expect(startTask).toHaveBeenCalledWith({
      taskId: 'task_1', cwd: '/workspace', sandboxGeneration: 4, processGeneration: 9,
    });
    await runtime.close();
    expect(stopTask).toHaveBeenCalledWith({
      taskId: 'task_1', sandboxGeneration: 4, expectedProcessGeneration: 9, reason: 'host_close',
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('stops the App Server when the host cannot connect to its task socket', async () => {
    const root = await createTmpDir();
    const missing = join(root, 'missing.sock');
    const startTask = vi.fn(async (): Promise<SupervisorTaskSnapshot> => ({
      taskId: 'task_1', sandboxGeneration: 2, processGeneration: 3,
      socketPath: '/run/link-bot/bridge/tasks/task_1-3.sock', hostSocketPath: missing, status: 'running',
    }));
    const stopTask = vi.fn(async () => ({ taskId: 'task_1', status: 'stopped' as const }));
    const factory = userSandboxAppServerRuntimeFactory({
      resolveTarget: () => ({ sandboxGeneration: 2, supervisorSocketPath: join(root, 'supervisor.sock') }),
      createSupervisorClient: () => ({ startTask, stopTask }),
      connectTimeoutMs: 50,
    });

    await expect(factory({ taskId: 'task_1', cwd: '/workspace', args: [] }, 3)).rejects.toThrow();
    expect(stopTask).toHaveBeenCalledWith({
      taskId: 'task_1', sandboxGeneration: 2, expectedProcessGeneration: 3, reason: 'host_connect_failed',
    });
  });

  it('recycles one unhealthy sandbox generation before starting the first task process', async () => {
    const root = await createTmpDir();
    const socketPath = join(root, 'task.sock');
    const server = createServer(() => undefined);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    const unavailable = vi.fn(async () => {
      throw Object.assign(new Error('connect ENOENT supervisor.sock'), { code: 'ENOENT' });
    });
    const recovered = vi.fn(async (): Promise<SupervisorTaskSnapshot> => ({
      taskId: 'task_1', sandboxGeneration: 5, processGeneration: 9,
      socketPath: '/run/link-bot/bridge/tasks/task_1-9.sock', hostSocketPath: socketPath, status: 'running',
    }));
    const stopTask = vi.fn(async () => ({ taskId: 'task_1', status: 'stopped' as const }));
    const recoverTarget = vi.fn(async () => ({
      sandboxGeneration: 5, supervisorSocketPath: join(root, 'generation-5.sock'),
    }));
    const factory = userSandboxAppServerRuntimeFactory({
      resolveTarget: () => ({ sandboxGeneration: 4, supervisorSocketPath: join(root, 'generation-4.sock') }),
      recoverTarget,
      createSupervisorClient: (path) => ({
        startTask: path.endsWith('generation-4.sock') ? unavailable : recovered,
        stopTask,
      }),
      connectTimeoutMs: 5,
    });

    const runtime = await factory({ taskId: 'task_1', cwd: '/workspace/tasks/task_1', args: [] }, 9);
    expect(recoverTarget).toHaveBeenCalledOnce();
    expect(recovered).toHaveBeenCalledWith(expect.objectContaining({ sandboxGeneration: 5, processGeneration: 9 }));
    await runtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('does not recycle a healthy sandbox when the managed App Server executable cannot spawn', async () => {
    const root = await createTmpDir();
    const startTask = vi.fn(async (): Promise<SupervisorTaskSnapshot> => {
      throw new Error('Supervisor StartTask failed: spawn /host-only/codex ENOENT');
    });
    const recoverTarget = vi.fn();
    const factory = userSandboxAppServerRuntimeFactory({
      resolveTarget: () => ({ sandboxGeneration: 4, supervisorSocketPath: join(root, 'supervisor.sock') }),
      recoverTarget,
      createSupervisorClient: () => ({
        startTask,
        stopTask: vi.fn(async () => ({ taskId: 'task_1', status: 'not_found' as const })),
      }),
      connectTimeoutMs: 50,
    });

    await expect(factory({ taskId: 'task_1', cwd: '/workspace/tasks/task_1', args: [] }, 9))
      .rejects.toThrow('spawn /host-only/codex ENOENT');
    expect(startTask).toHaveBeenCalledOnce();
    expect(recoverTarget).not.toHaveBeenCalled();
  });
});
