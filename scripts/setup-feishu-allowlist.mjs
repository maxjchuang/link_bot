#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';

// This setup listener receives only matching challenge messages. It never sends replies or starts agents.
const root = process.cwd();
const config = JSON.parse(await readFile(resolve(root, '.link-bot/config.json'), 'utf8'));
const challenge = `link-bot-setup-${randomBytes(4).toString('hex')}`;
const file = resolve(root, '.link-bot/setup-candidates.json');
const candidates = [];
const quiet = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
await writeFile(file, JSON.stringify({ challenge, candidates }, null, 2), { mode: 0o600 });
const dispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': async event => {
    const message = event.message, sender = event.sender;
    if (!message || sender?.sender_type !== 'user') return;
    let content; try { content = JSON.parse(message.content); } catch { return; }
    if (typeof content?.text !== 'string' || !content.text.includes(challenge)) return;
    const openId = sender.sender_id?.open_id;
    if (!/^ou_[A-Za-z0-9_-]+$/.test(openId ?? '') || !/^oc_[A-Za-z0-9_-]+$/.test(message.chat_id ?? '')) return;
    if (!candidates.some(c => c.openId === openId && c.chatId === message.chat_id)) {
      candidates.push({ openId, chatId: message.chat_id, chatType: message.chat_type, receivedAt: new Date().toISOString() });
      await writeFile(file, JSON.stringify({ challenge, candidates }, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ event: 'setup.candidate_received', chatType: message.chat_type, count: candidates.length }));
    }
  },
});
const client = new lark.WSClient({ appId: config.feishu.appId, appSecret: config.feishu.appSecret, logger: quiet });
await client.start({ eventDispatcher: dispatcher });
console.log(JSON.stringify({ event: 'setup.listener.ready', challenge, sendsMessages: false }));
const stop = () => { console.log(JSON.stringify({ event: 'setup.listener.stopped' })); process.exit(0); };
process.once('SIGTERM', stop); process.once('SIGINT', stop); setTimeout(stop, 15 * 60_000);
