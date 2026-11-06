import { describe, expect, it, vi } from 'vitest';
import { ensureHostCodexRuntime } from '../../scripts/host-codex-runtime.mjs';

describe('global host Codex runtime', () => {
  it('uses the configured global command without installing or pinning a package', async () => {
    const runner = vi.fn(async () => undefined);
    expect(await ensureHostCodexRuntime('/project', { commandRunner: runner, command: '/global/bin/codex' }))
      .toBe('/global/bin/codex');
    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0][0]).toBe(process.execPath);
    expect(runner.mock.calls[0][2].env.CODEX_COMMAND).toBe('/global/bin/codex');
  });
  it('does not reject a new global version because of a stale version pin', async () => {
    const runner = vi.fn(async () => undefined);
    await ensureHostCodexRuntime('/project', { commandRunner: runner, env: { EXPECTED_CODEX_VERSION: '0.161.0' } });
    expect(runner.mock.calls[0][2].env).toEqual({ CODEX_COMMAND: 'codex' });
  });
  it('leaves restart to the caller only after protocol validation passes', async () => {
    const runner = vi.fn(async () => { throw new Error('Missing turn/start protocol field'); });
    await expect(ensureHostCodexRuntime('/project', { commandRunner: runner })).rejects.toThrow('Missing turn/start');
    expect(runner).toHaveBeenCalledOnce();
  });
});
