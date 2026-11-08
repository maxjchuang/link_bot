import { expect, it, vi } from 'vitest';
import { runRuntimeImage } from '../../scripts/runtime-image.mjs';

it.each(['linux/aarch64','linux/x86_64'])('builds and checks for the Docker daemon architecture %s', async daemon => {
  const runner = vi.fn(async (_command, args) => {
    if (args[0] === 'info') return daemon;
    if (args.includes('codex')) return 'codex-cli 0.161.0';
    return '';
  });
  const result = await runRuntimeImage({ args: ['build'], commandRunner: runner, env: { DOCKER_DEFAULT_PLATFORM: 'linux/amd64' } });
  const platform = daemon.includes('aarch64') ? 'linux/arm64' : 'linux/amd64';
  expect(result.platform).toBe(platform);
  expect(runner.mock.calls.find(([,args]) => args[0] === 'build')[1]).toEqual(expect.arrayContaining(['--platform', platform]));
  expect(runner.mock.calls.filter(([,args]) => args[0] === 'run').every(([,args]) => args[1] === '--platform' && args[2] === platform)).toBe(true);
});

it('permits the official public Node mirror without silently using a private registry', async () => {
  const runner = vi.fn(async (_command, args) => args[0] === 'info' ? 'linux/aarch64' : args.includes('codex') ? 'codex-cli 0.161.0' : '');
  await runRuntimeImage({ args: ['build'], commandRunner: runner, env: { LINK_BOT_NODE_BASE_IMAGE: 'public.ecr.aws/docker/library/node:22.21.1-bookworm-slim' } });
  expect(runner.mock.calls.find(([,args]) => args[0] === 'build')[1]).toContain('NODE_BASE_IMAGE=public.ecr.aws/docker/library/node:22.21.1-bookworm-slim');
  await expect(runRuntimeImage({ args: ['build'], commandRunner: runner, env: { LINK_BOT_NODE_BASE_IMAGE: 'untrusted.example/node:latest' } })).rejects.toThrow('official public Node');
});
