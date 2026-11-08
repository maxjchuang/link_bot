#!/usr/bin/env node
import { createConnection } from 'node:net';
import { realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const root = resolve(process.env.LINK_BOT_BRIDGE_ROOT ?? '/run/link-bot/bridge');
const requested = process.argv[2];
let socket;
let timer;
function fail(code = 'EACCES') {
  if (timer) clearTimeout(timer);
  process.stderr.write(`LINK_BOT_BRIDGE_ERROR:${['ENOENT','ECONNREFUSED','EPIPE','EACCES','ENOTSOCK','ETIMEDOUT'].includes(code) ? code : 'EACCES'}\n`);
  socket?.destroy(); process.stdin.destroy(); process.exitCode = 1;
}
try {
  if (!requested || !requested.startsWith(root + sep) || requested.includes('..')) throw Object.assign(new Error(), { code: 'EACCES' });
  const actual = await realpath(requested);
  const actualRoot = await realpath(root);
  if (!actual.startsWith(actualRoot + sep) || !(await stat(actual)).isSocket()) throw Object.assign(new Error(), { code: 'ENOTSOCK' });
  socket = createConnection(actual);
  timer = setTimeout(() => fail('ETIMEDOUT'), 10_000);
  socket.once('connect', () => {
    clearTimeout(timer);
    process.stderr.write('LINK_BOT_BRIDGE_CONNECTED\n');
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
  });
  socket.once('error', error => fail(error.code));
  socket.once('close', () => { clearTimeout(timer); process.stdin.destroy(); });
  process.stdin.on('error', () => socket.destroy());
  process.stdout.on('error', () => socket.destroy());
  process.once('SIGTERM', () => { clearTimeout(timer); socket.destroy(); process.stdin.destroy(); });
} catch (error) { fail(error.code); }
