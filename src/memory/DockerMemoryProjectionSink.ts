import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DockerRuntime } from '../runtime/DockerRuntime.js';
import type { SqliteStateStore } from '../state/SqliteStateStore.js';
import type { MemoryProjectionSink } from './MemoryProjectionService.js';

export class DockerMemoryProjectionSink implements MemoryProjectionSink {
  constructor(
    private readonly store: SqliteStateStore,
    private readonly docker: DockerRuntime,
    private readonly stagingRoot: string,
  ) {}

  async replace(taskId: string, files: ReadonlyMap<string, string>): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(this.stagingRoot, 'memory-projection-'));
    try {
      for (const [path, content] of files) {
        if (!isSafeProjectionPath(path)) throw new Error(`Unsafe memory projection path: ${path}`);
        const destination = join(staging, path);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, content, { encoding: 'utf8', mode: 0o600 });
      }
      const projectionId = staging.slice(staging.lastIndexOf('-') + 1);
      await this.docker.installMemoryProjection(
        this.docker.describe(task.runtimeId ?? task.id), staging, projectionId,
      );
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

function isSafeProjectionPath(path: string): boolean {
  return /^(?:INDEX|CURRENT|MEMORY|DECISIONS|TODO|PROJECTS|LAST_DREAM)\.md$/.test(path)
    || /^capsules\/[A-Za-z0-9._-]+\.md$/.test(path)
    || /^journal\/[A-Za-z0-9._-]+\.md$/.test(path);
}
