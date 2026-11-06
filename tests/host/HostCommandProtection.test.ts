import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installHostCodexCommandPolicy, installHostCommandProtection } from '../../src/host/HostCommandProtection.js';

describe('installHostCommandProtection', () => {
  it('captures the real PM2 path and prepends the protected wrapper directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'host-command-protection-'));
    const realBin = join(root, 'real-bin');
    const protectedBin = join(root, 'scripts/protected-bin');
    await mkdir(realBin, { recursive: true });
    await mkdir(protectedBin, { recursive: true });
    await writeFile(join(realBin, 'pm2'), '#!/bin/sh\nexit 0\n');
    await chmod(join(realBin, 'pm2'), 0o755);
    await writeFile(join(protectedBin, 'pm2'), '#!/bin/sh\nexit 64\n');
    const env = { PATH: realBin } as NodeJS.ProcessEnv;

    expect(installHostCommandProtection(root, env)).toBe(join(realBin, 'pm2'));
    expect(env.LINK_BOT_REAL_PM2).toBe(join(realBin, 'pm2'));
    expect(env.PATH?.split(delimiter)[0]).toBe(protectedBin);
  });
});

describe('installHostCodexCommandPolicy', () => {
  it('writes forbidden rules for PATH and absolute PM2 lifecycle commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'host-command-policy-'));
    const rulesPath = installHostCodexCommandPolicy(root, '/opt/pm2/bin/pm2');
    const rules = await readFile(rulesPath, 'utf8');

    expect(rules).toContain('pattern = ["pm2", ["restart", "reload", "stop", "delete", "kill"]]');
    expect(rules).toContain('pattern = ["/opt/pm2/bin/pm2", ["restart", "reload", "stop", "delete", "kill"]]');
    expect(rules).toContain('decision = "forbidden"');
    expect(rules).toContain('npm run pm2:launch:linux');
  });
});
