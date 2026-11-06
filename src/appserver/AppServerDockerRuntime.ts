import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { StartTaskInput } from '../backends/CodexBackend.js';
import { AppServerConnection } from './AppServerConnection.js';
import type { AppServerRuntime, AppServerRuntimeFactory } from './AppServerCodexBackend.js';

export function dockerAttachRuntimeFactory(
  containerNameForTask: (taskId: string) => string,
  spawnProxy: (containerName: string) => ChildProcessWithoutNullStreams = defaultSpawnProxy,
  maxFrameBytes?: number,
): AppServerRuntimeFactory {
  return async (input: StartTaskInput, generation: number): Promise<AppServerRuntime> => {
    const child = spawnProxy(containerNameForTask(input.taskId));
    const connection = new AppServerConnection({
      readable: child.stdout, writable: child.stdin, generation, maxBufferedBytes: maxFrameBytes,
    });
    return {
      connection,
      close: async () => {
        await connection.close().catch(() => undefined);
        if (!child.killed) child.kill('SIGTERM');
      },
    };
  };
}

function defaultSpawnProxy(containerName: string): ChildProcessWithoutNullStreams {
  return spawn('docker', ['attach', containerName], { stdio: ['pipe', 'pipe', 'pipe'] });
}
