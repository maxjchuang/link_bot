#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseArgs(argv) {
  const options = { mode: argv[0] ?? 'build', image: 'link-bot-runtime:0.1' };
  if (!['build', 'verify'].includes(options.mode)) throw new Error('Expected build or verify.');
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] !== '--image' || !argv[i + 1]) throw new Error('Expected --image <name>.');
    options.image = argv[++i];
  }
  return options;
}

export async function runRuntimeImage({ args = process.argv.slice(2), projectRoot = process.cwd(), commandRunner = runCommand } = {}) {
  const options = parseArgs(args);
  if (options.mode === 'build') await commandRunner('docker', ['build', '--pull', '-t', options.image, 'runtime'], { cwd: projectRoot });
  const dockerfile = await readFile(resolve(projectRoot, 'runtime/Dockerfile'), 'utf8');
  const expected = dockerfile.match(/^ARG CODEX_CLI_VERSION=(\S+)$/m)?.[1];
  const actual = await commandRunner('docker', ['run', '--rm', '--entrypoint', 'codex', options.image, '--version'], { cwd: projectRoot });
  if (!actual.includes(expected)) throw new Error(`Unexpected Codex version: ${actual.trim()}`);
  for (const binary of ['gh', 'lark-cli', 'git', 'python3']) {
    await commandRunner('docker', ['run', '--rm', '--entrypoint', binary, options.image, '--version'], { cwd: projectRoot });
  }
  await commandRunner('docker', ['run', '--rm', '--entrypoint', 'sh', options.image, '-ec',
    'test -x /usr/local/bin/link-bot-sandbox-supervisor && test -x /usr/local/bin/link-bot-sandbox-repo-create'], { cwd: projectRoot });
  return { image: options.image, codexCliVersion: expected };
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}`)));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRuntimeImage().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
