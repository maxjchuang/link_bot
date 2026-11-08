#!/usr/bin/env node
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { startLocalService } from './local-service.mjs';
import { inspectLocalSetup, localEnvironment, ensureLocalState } from './local-setup.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (Number(process.versions.node.split('.')[0]) !== 22) {
  console.error('Link Bot requires Node 22. Run nvm use in the project directory.'); process.exit(1);
}
const env = localEnvironment();
const serviceMode = process.argv.some(arg => arg.startsWith('--service='));
const build = serviceMode ? { status: 0 } : spawnSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc')], { cwd: root, env, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
const report = await inspectLocalSetup(root, env);
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes('--check')) process.exit(report.ok ? 0 : 1);
if (!report.ok) process.exit(1);
await ensureLocalState(root);
if (process.argv.includes('--background')) {
  console.log(JSON.stringify(await startLocalService(root, env))); process.exit(0);
}
const child = spawn(process.execPath, [resolve(root, 'dist/src/index.js')], { cwd: root, env, stdio: 'inherit' });
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('error', () => { console.error('Unable to start Link Bot.'); process.exitCode = 1; });
child.once('close', code => { process.exitCode = code ?? 1; });
