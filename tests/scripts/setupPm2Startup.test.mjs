import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildLaunchAgentPlist,
  parseArgs,
  runSetup,
} from '../../scripts/setup-pm2-startup.mjs';

describe('setup-pm2-startup', () => {
  it('builds a user launch agent that resurrects saved pm2 processes', () => {
    const plist = buildLaunchAgentPlist({
      home: '/Users/alice',
      label: 'com.link-bot.pm2.alice',
      pm2Home: '/Users/alice/.pm2',
      pm2Path: '/Users/alice/.nvm/versions/node/v22/bin/pm2',
      path: '/Users/alice/.nvm/versions/node/v22/bin:/usr/bin:/bin',
    });

    expect(plist).toContain('<string>com.link-bot.pm2.alice</string>');
    expect(plist).toContain('<string>/Users/alice/.nvm/versions/node/v22/bin/pm2</string>');
    expect(plist).toContain('<string>resurrect</string>');
    expect(plist).toContain('<string>/Users/alice/.pm2</string>');
    expect(plist).toContain('<key>RunAtLoad</key>');
  });

  it('supports overriding process name and entrypoint from CLI args', () => {
    expect(parseArgs(['--process-name', 'bot-prod', '--entry', 'dist/custom.js'])).toMatchObject({
      processName: 'bot-prod',
      entry: 'dist/custom.js',
      mode: 'install',
    });
  });

  it('does not write files or run commands in dry-run mode', async () => {
    const home = await mkdtemp(join(tmpdir(), 'link-bot-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'link-bot-project-'));
    const calls = [];
    try {
      const result = await runSetup({
        args: ['--dry-run'],
        env: {
          HOME: home,
          PATH: '/custom/bin:/usr/bin:/bin',
          PM2_HOME: join(home, '.pm2'),
        },
        platform: 'darwin',
        projectRoot,
        uid: 501,
        user: 'alice',
        commandRunner: async (command, args) => {
          calls.push([command, ...args].join(' '));
          if (command === 'which') {
            return '/custom/bin/pm2\n';
          }
          return '';
        },
      });

      expect(result.plistPath).toBe(join(home, 'Library/LaunchAgents/com.link-bot.pm2.alice.plist'));
      expect(result.plannedCommands).toContain('npm run build');
      expect(result.plannedCommands).toContain('pm2 start dist/src/index.js --name link-bot');
      expect(result.plannedCommands).toContain('pm2 save');
      await expect(readFile(result.plistPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(calls).toEqual(['which pm2']);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
