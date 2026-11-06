import { describe, expect, it, vi } from 'vitest';
import { cleanupRepositoryStaging } from '../../src/runtime/DockerTaskProvisioner.js';

describe('DockerTaskProvisioner repository staging cleanup', () => {
  it('retries transient non-empty directories through fs.rm options', async () => {
    const remove = vi.fn(async () => undefined);

    await cleanupRepositoryStaging('/tmp/repository-staging', undefined, remove);

    expect(remove).toHaveBeenCalledWith('/tmp/repository-staging', {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 250,
    });
  });

  it('preserves the repository error when staging cleanup also fails', async () => {
    const repositoryError = new Error('Manager Git clone failed');
    const cleanupError = Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' });
    const remove = vi.fn(async () => { throw cleanupError; });

    await expect(cleanupRepositoryStaging('/tmp/repository-staging', repositoryError, remove)).resolves.toBeUndefined();

    expect(repositoryError.message).toBe(
      'Manager Git clone failed; staging cleanup also failed: directory not empty',
    );
  });

  it('reports cleanup failure when the repository operation succeeded', async () => {
    const cleanupError = Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' });
    const remove = vi.fn(async () => { throw cleanupError; });

    await expect(cleanupRepositoryStaging('/tmp/repository-staging', undefined, remove)).rejects.toBe(cleanupError);
  });
});
