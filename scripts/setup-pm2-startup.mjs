#!/usr/bin/env node
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_PROCESS_NAME = 'link-bot';
const DEFAULT_ENTRY = 'dist/src/index.js';

export function parseArgs(argv) {
  const options = {
    dryRun: false,
    entry: DEFAULT_ENTRY,
    mode: 'install',
    processName: DEFAULT_PROCESS_NAME,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--uninstall') {
      options.mode = 'uninstall';
    } else if (arg === '--process-name') {
      options.processName = readValue(argv, ++index, arg);
    } else if (arg === '--entry') {
      options.entry = readValue(argv, ++index, arg);
    } else if (arg === '--label') {
      options.label = readValue(argv, ++index, arg);
    } else if (arg === '--plist-path') {
      options.plistPath = readValue(argv, ++index, arg);
    } else if (arg === '--pm2-path') {
      options.pm2Path = readValue(argv, ++index, arg);
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

export function buildLaunchAgentPlist({ home, label, path, pm2Home, pm2Path }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(pm2Path)}</string>
    <string>resurrect</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${escapeXml(home)}</string>
    <key>PM2_HOME</key>
    <string>${escapeXml(pm2Home)}</string>
    <key>PATH</key>
    <string>${escapeXml(path)}</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${escapeXml(join(pm2Home, 'launchd.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(pm2Home, 'launchd.err.log'))}</string>
</dict>
</plist>
`;
}

export async function runSetup({
  args = process.argv.slice(2),
  commandRunner = runCommand,
  env = process.env,
  platform = process.platform,
  projectRoot = process.cwd(),
  uid = process.getuid?.(),
  user = userInfo().username,
} = {}) {
  const options = parseArgs(args);
  if (options.help) {
    return { help: usage(), plannedCommands: [] };
  }
  if (platform !== 'darwin') {
    throw new Error('This script installs a macOS launchd LaunchAgent and only supports darwin.');
  }
  if (uid === undefined) {
    throw new Error('Unable to determine current uid for launchctl gui domain.');
  }

  const home = env.HOME || homedir();
  const pm2Home = env.PM2_HOME || join(home, '.pm2');
  const label = options.label || `com.link-bot.pm2.${user}`;
  const plistPath = options.plistPath || join(home, 'Library/LaunchAgents', `${label}.plist`);
  const path = buildPath(env.PATH);
  const pm2Path = options.pm2Path || (await findPm2(commandRunner, projectRoot));
  const plist = buildLaunchAgentPlist({ home, label, path, pm2Home, pm2Path });
  const entry = normalizeEntry(projectRoot, options.entry);

  if (options.mode === 'uninstall') {
    const plannedCommands = [
      `launchctl bootout gui/${uid} ${plistPath}`,
      `rm ${plistPath}`,
    ];
    if (!options.dryRun) {
      await ignoreFailure(() => commandRunner('launchctl', ['bootout', `gui/${uid}`, plistPath], { cwd: projectRoot, env }));
      await rm(plistPath, { force: true });
    }
    return { label, plistPath, plannedCommands };
  }

  const plannedCommands = [
    'npm run build',
    `pm2 start ${options.entry} --name ${options.processName}`,
    'pm2 save',
    `write ${plistPath}`,
    `launchctl bootout gui/${uid} ${plistPath}`,
    `launchctl bootstrap gui/${uid} ${plistPath}`,
    `launchctl enable gui/${uid}/${label}`,
  ];

  if (options.dryRun) {
    return { label, plist, plistPath, plannedCommands };
  }

  await commandRunner('npm', ['run', 'build'], { cwd: projectRoot, env });
  if (await pm2ProcessExists(commandRunner, projectRoot, env, options.processName)) {
    await commandRunner('pm2', ['restart', options.processName, '--update-env'], { cwd: projectRoot, env });
  } else {
    await commandRunner('pm2', ['start', entry, '--name', options.processName], { cwd: projectRoot, env });
  }
  await commandRunner('pm2', ['save'], { cwd: projectRoot, env });
  await mkdir(dirname(plistPath), { recursive: true });
  await writeFile(plistPath, plist, 'utf8');
  await ignoreFailure(() => commandRunner('launchctl', ['bootout', `gui/${uid}`, plistPath], { cwd: projectRoot, env }));
  await commandRunner('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { cwd: projectRoot, env });
  await commandRunner('launchctl', ['enable', `gui/${uid}/${label}`], { cwd: projectRoot, env });

  return { label, plistPath, plannedCommands };
}

function readValue(argv, index, option) {
  const value = argv[index];
  if (!value) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function buildPath(currentPath = '') {
  const required = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const entries = currentPath.split(':').filter(Boolean);
  for (const entry of required) {
    if (!entries.includes(entry)) {
      entries.push(entry);
    }
  }
  return entries.join(':');
}

function normalizeEntry(projectRoot, entry) {
  return entry.startsWith('/') ? entry : resolve(projectRoot, entry);
}

async function findPm2(commandRunner, cwd) {
  const stdout = await commandRunner('which', ['pm2'], { cwd, env: process.env, silent: true });
  const pm2Path = stdout.trim().split('\n')[0];
  if (!pm2Path) {
    throw new Error('pm2 was not found on PATH. Install pm2 or pass --pm2-path.');
  }
  return pm2Path;
}

async function pm2ProcessExists(commandRunner, cwd, env, processName) {
  try {
    await commandRunner('pm2', ['describe', processName], { cwd, env });
    return true;
  } catch {
    return false;
  }
}

async function ignoreFailure(fn) {
  try {
    await fn();
  } catch {
    // bootout fails when the LaunchAgent is not loaded yet; that is fine.
  }
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function runCommand(command, args, options) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!options.silent) {
        process.stdout.write(chunk);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (!options.silent) {
        process.stderr.write(chunk);
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolveCommand(stdout);
      } else {
        reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}: ${stderr.trim()}`));
      }
    });
  });
}

function usage() {
  return `Usage: node scripts/setup-pm2-startup.mjs [options]

Options:
  --dry-run                 Print the planned setup without writing files.
  --uninstall               Remove the LaunchAgent without stopping pm2.
  --process-name <name>     PM2 process name. Default: link-bot.
  --entry <path>            App entrypoint. Default: dist/src/index.js.
  --label <label>           LaunchAgent label. Default: com.link-bot.pm2.<user>.
  --plist-path <path>       LaunchAgent plist path.
  --pm2-path <path>         Absolute pm2 binary path.
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSetup()
    .then((result) => {
      if (result.help) {
        console.log(result.help);
        return;
      }
      console.log(`LaunchAgent: ${result.plistPath}`);
      console.log('Planned commands:');
      for (const command of result.plannedCommands) {
        console.log(`- ${command}`);
      }
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
