import { expect, it, vi } from 'vitest';
import { DockerDaemonResourceSampler } from '../../src/runtime/DockerDaemonResourceSampler.js';

it('admits an empty Docker VM regardless of macOS page-cache pressure', async () => {
  const run = vi.fn(async args => ({ stdout: args[0] === 'info' ? String(6 * 1024 ** 3) : '', stderr: '', exitCode: 0 }));
  const sample = await new DockerDaemonResourceSampler({ run }).sample();
  expect(sample.totalBytes).toBe(6 * 1024 ** 3);
  expect(sample.usedBytes / sample.totalBytes).toBeLessThan(0.8);
  expect(sample.managerAndInfrastructureBytes).toBe(512 * 1024 ** 2);
});

it('accounts for every container on the Docker daemon plus infrastructure headroom', async () => {
  const run = vi.fn(async args => ({ stdout: args[0] === 'info' ? String(6 * 1024 ** 3)
    : '128MiB / 2GiB\n1.5GiB / 2GiB\n', stderr: '', exitCode: 0 }));
  const sample = await new DockerDaemonResourceSampler({ run }).sample();
  expect(sample.usedBytes).toBe((128 + 1536 + 512) * 1024 ** 2);
});

it('fails closed on an invalid memory response instead of inventing available capacity', async () => {
  const run = vi.fn(async args => ({ stdout: args[0] === 'info' ? 'invalid' : '', stderr: '', exitCode: 0 }));
  await expect(new DockerDaemonResourceSampler({ run }).sample()).rejects.toThrow('memory budget');
});
