import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  configurePm2LogRotation, detectHostManagerAncestor, launchPm2 as realLaunchPm2, normalizePm2LogRotation, parseArgs, verifyHostControlReady,
} from '../../scripts/launch-pm2-linux.mjs';

const launchPm2 = (options) => realLaunchPm2({ verifyHostReady: async () => undefined, ...options });

describe('launch-pm2-linux', () => {
  it('checks the default socket even when the local config omits socketPath', async () => {
    const root = await configuredRoot({ hostControl: { enabled: true } });
    const verify = vi.fn(async () => undefined);
    await launchPm2({ projectRoot: root, platform: 'linux', commandRunner: async () => undefined,
      invokedByHostManager: false, verifyHostReady: verify });
    expect(verify).toHaveBeenCalledWith(join(root, '.link-bot/host-control.sock'));
  });
  it('validates the configured host Codex before touching PM2', async () => {
    const root = await configuredRoot({ codex: { command: '/global/codex' } });
    const globalCommand = '/global/codex';
    const runner = vi.fn(async () => undefined);
    const prepare = vi.fn(async () => {
      expect(runner).toHaveBeenCalledTimes(1); // build only
      return globalCommand;
    });
    await launchPm2({ projectRoot: root, platform: 'linux', commandRunner: runner, prepareHostCodex: prepare });
    expect(JSON.parse(await readFile(join(root, '.link-bot/config.json'), 'utf8')).codex.command).toBe(globalCommand);
  });

  it('keeps the running services and configuration intact when Codex preflight fails', async () => {
    const root = await configuredRoot({ codex: { command: '/previous/codex' } });
    const calls = [];
    const runner = vi.fn(async (cmd) => { calls.push(cmd); });
    await expect(launchPm2({ projectRoot: root, platform: 'linux', commandRunner: runner,
      prepareHostCodex: async () => { throw new Error('schema mismatch'); },
    })).rejects.toThrow('schema mismatch');
    expect(calls).toEqual(['npm']);
    expect(JSON.parse(await readFile(join(root, '.link-bot/config.json'), 'utf8')).codex.command).toBe('/previous/codex');
  });

  it('checks Host Manager readiness after restart instead of relying on PM2 online status', async () => {
    const root = await configuredRoot({ hostControl: { enabled: true, socketPath: '/host-control.sock' } });
    const calls = [];
    const runner = vi.fn(async (cmd, args) => { calls.push(`${cmd} ${args.join(' ')}`); });
    await expect(launchPm2({ projectRoot: root, platform: 'linux', commandRunner: runner, invokedByHostManager: false,
      verifyHostReady: async (path) => {
        expect(path).toBe('/host-control.sock');
        expect(calls).toContain('pm2 restart link-bot-host-manager --update-env');
        throw new Error('manager not ready');
      },
    })).rejects.toThrow('manager not ready');
  });

  it('requires a working status RPC for Host Manager readiness', async () => {
    const root = await mkdtemp(join(tmpdir(), 'link-bot-pm2-'));
    const socket = join(root, 'host.sock');
    const server = createServer((peer) => peer.once('data', (data) => {
      expect(JSON.parse(data.toString()).message.text).toBe('/status');
      peer.end(JSON.stringify({ ok: true, result: { reply: 'Host App Server\nActive: false' } }));
    }));
    await new Promise((resolve) => server.listen(socket, resolve));
    try { await verifyHostControlReady(socket, 500); } finally { await new Promise((resolve) => server.close(resolve)); }
    await expect(verifyHostControlReady(socket, 10)).rejects.toThrow('did not become ready');
  });
  it('parses process name and entry overrides', () => {
    expect(parseArgs(['--process-name', 'link-bot-prod', '--entry', 'dist/app.js'])).toEqual({
      entry: 'dist/app.js', processName: 'link-bot-prod', skipBuild: false,
    });
  });

  it('restarts from a prebuilt entry without rebuilding the dirty checkout', async () => {
    const root = await configuredRoot();
    await mkdir(join(root, 'dist/src'), { recursive: true });
    await writeFile(join(root, 'dist/src/index.js'), '');
    const calls = [];
    const runner = vi.fn(async (command, args) => calls.push(`${command} ${args.join(' ')}`));
    await launchPm2({ args: ['--skip-build'], commandRunner: runner, platform: 'linux', projectRoot: root });
    expect(calls).not.toContain('npm run build');
    expect(calls).toContain('pm2 restart link-bot --update-env');
  });

  it('rejects skip-build before touching PM2 when the prebuilt entry is missing', async () => {
    const root = await configuredRoot();
    const runner = vi.fn();
    await expect(launchPm2({ args: ['--skip-build'], commandRunner: runner, platform: 'linux', projectRoot: root }))
      .rejects.toThrow('Missing prebuilt entry');
    expect(runner).not.toHaveBeenCalled();
  });

  it('builds, starts a missing process, and saves the PM2 list', async () => {
    const root = await configuredRoot();
    const calls = [];
    const runner = vi.fn(async (command, args) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (args[0] === 'describe') throw new Error('missing');
    });
    await launchPm2({ commandRunner: runner, platform: 'linux', projectRoot: root });
    expect(calls).toEqual([
      'npm run build',
      'pm2 describe pm2-logrotate',
      'pm2 install pm2-logrotate',
      'pm2 set pm2-logrotate:max_size 100M',
      'pm2 set pm2-logrotate:retain 7',
      'pm2 set pm2-logrotate:compress true',
      'pm2 set pm2-logrotate:dateFormat YYYY-MM-DD_HH-mm-ss',
      'pm2 set pm2-logrotate:workerInterval 30',
      'pm2 set pm2-logrotate:rotateInterval 0 0 * * *',
      'pm2 set pm2-logrotate:rotateModule true',
      'pm2 describe link-bot',
      `pm2 start ${join(root, 'dist/src/index.js')} --name link-bot`,
      'pm2 save',
    ]);
  });

  it('restarts an existing process with updated environment', async () => {
    const root = await configuredRoot();
    const calls = [];
    const runner = vi.fn(async (command, args) => calls.push(`${command} ${args.join(' ')}`));
    await launchPm2({ commandRunner: runner, platform: 'linux', projectRoot: root });
    expect(calls).toContain('pm2 restart link-bot --update-env');
    expect(calls).not.toContain(expect.stringContaining('pm2 start'));
  });

  it('defers host-manager restart when invoked by a host-control Codex child', async () => {
    const root = await configuredRoot({
      hostControl: { enabled: true, managerProcessName: 'link-bot-host-manager' },
    });
    const calls = [];
    const runner = vi.fn(async (command, args) => calls.push(`${command} ${args.join(' ')}`));

    await launchPm2({
      commandRunner: runner, platform: 'linux', projectRoot: root,
      env: { ...process.env, LINK_BOT_HOST_MANAGER: '1' },
    });

    expect(calls).not.toContain('pm2 restart link-bot-host-manager --update-env');
    expect(calls).toContain('pm2 restart link-bot --update-env');
    await expect(readFile(join(root, '.link-bot/host-manager-restart-request.json'), 'utf8'))
      .resolves.toContain('link-bot-host-manager');
  });

  it('still defers restart when a child clears the marker from its own environment', async () => {
    const root = await configuredRoot({
      hostControl: { enabled: true, managerProcessName: 'link-bot-host-manager' },
    });
    const calls = [];
    const runner = vi.fn(async (command, args) => calls.push(`${command} ${args.join(' ')}`));

    await launchPm2({
      commandRunner: runner, platform: 'linux', projectRoot: root,
      env: {}, invokedByHostManager: true,
    });

    expect(calls).not.toContain('pm2 restart link-bot-host-manager --update-env');
    await expect(readFile(join(root, '.link-bot/host-manager-restart-request.json'), 'utf8'))
      .resolves.toContain('"state":"requested"');
  });

  it('detects the protected context from an ancestor after the child marker is removed', () => {
    const files = new Map([
      ['/proc/20/environ', Buffer.from('PATH=/bin\0')],
      ['/proc/20/status', Buffer.from('Name:\tsh\nPPid:\t10\n')],
      ['/proc/10/environ', Buffer.from('LINK_BOT_HOST_MANAGER=1\0PATH=/bin\0')],
    ]);
    const read = (path) => {
      const value = files.get(path);
      if (!value) throw new Error('not found');
      return value;
    };

    expect(detectHostManagerAncestor({}, 20, read)).toBe(true);
  });

  it('does not bypass an existing deferred restart request', async () => {
    const root = await configuredRoot({
      hostControl: { enabled: true, managerProcessName: 'link-bot-host-manager' },
    });
    await writeFile(join(root, '.link-bot/host-manager-restart-request.json'), JSON.stringify({
      managerName: 'link-bot-host-manager', requestedAt: '2026-08-11T00:00:00Z',
      requestedBy: 'host-control', state: 'requested', updatedAt: '2026-08-11T00:00:00Z',
    }));
    const calls = [];
    const runner = vi.fn(async (command, args) => calls.push(`${command} ${args.join(' ')}`));

    await launchPm2({
      commandRunner: runner, platform: 'linux', projectRoot: root,
      env: {}, invokedByHostManager: false,
    });

    expect(calls).not.toContain('pm2 restart link-bot-host-manager --update-env');
  });

  it('fails before running commands when config is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'link-bot-pm2-'));
    const runner = vi.fn();
    await expect(launchPm2({ commandRunner: runner, platform: 'linux', projectRoot: root }))
      .rejects.toThrow('Missing required config');
    expect(runner).not.toHaveBeenCalled();
  });

  it('allows log rotation to be disabled without inspecting or mutating PM2 modules', async () => {
    const calls = [];
    const runner = vi.fn(async (command, args) => calls.push(`${command} ${args.join(' ')}`));
    await configurePm2LogRotation(runner, '/project', { enabled: false });
    expect(calls).toEqual([]);
  });

  it('validates bounded log rotation settings before invoking PM2', async () => {
    expect(() => normalizePm2LogRotation({ maxSize: '100 megabytes' })).toThrow(/K, M, or G/);
    expect(() => normalizePm2LogRotation({ retain: 0 })).toThrow(/between 1 and 90/);
    expect(normalizePm2LogRotation({ maxSize: '250M', retain: 14 })).toMatchObject({
      enabled: true, maxSize: '250M', retain: 14, compress: true,
    });
  });
});

async function configuredRoot(config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'link-bot-pm2-'));
  await mkdir(join(root, '.link-bot'));
  await writeFile(join(root, '.link-bot/config.json'), JSON.stringify(config));
  return root;
}
