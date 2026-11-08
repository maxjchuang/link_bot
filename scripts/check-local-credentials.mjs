#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export async function checkFeishuCredentials(projectRoot = process.cwd()) {
  const config = JSON.parse(await readFile(resolve(projectRoot, '.link-bot/config.json'), 'utf8'));
  const lark = await import('@larksuiteoapi/node-sdk');
  const quiet = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
  const client = new lark.Client({ appId: config.feishu.appId, appSecret: config.feishu.appSecret, logger: quiet });
  try {
    const result = await client.request({ url: '/open-apis/bot/v3/info', method: 'GET' });
    if (result.code !== 0 || !result.bot?.open_id) throw new Error('credentials_or_bot_unavailable');
    return { ok: true, botIdentityAvailable: true };
  } catch { return { ok: false, reason: 'Feishu app credentials, bot availability, or network check failed. No credential values are logged.' }; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await checkFeishuCredentials(); console.log(JSON.stringify(result)); process.exitCode = result.ok ? 0 : 1;
}
