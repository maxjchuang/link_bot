import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { createTmpDir } from '../helpers/tmp.js';
import { SensitiveReplyDelivery } from '../../src/details/SensitiveReplyDelivery.js';

const context = { requesterUserId: 'ou_owner', ownerUserId: 'ou_owner', chatId: 'group', sourceMessageId: 'original' };
const providerDirectory = Buffer.from('reply').toString('base64url');
const raw = '请先授权：\nhttps://auth.example.test/authorize?client_id=example&state=fake-private-authorization\n完成后回复已授权。';
async function fixture() {
  const root = await createTmpDir();
  const verify = vi.fn(async () => true);
  const send = vi.fn(async (_user: string, _text: string, _uuid: string) => ({ messageId: 'private-receipt' }));
  let now = new Date('2026-10-16T00:00:00Z');
  const gateway = { verifySensitiveReplySource: verify, sendSensitiveReplyPrivate: send };
  return { root, gateway, verify, send, clock: () => now, advance: (ms: number) => { now = new Date(now.getTime() + ms); },
    delivery: new SensitiveReplyDelivery(root, gateway, () => now) };
}

describe('sensitive reply private delivery', () => {
  it('can disable private delivery and retries without exposing secrets or touching the transport', async () => {
    const f = await fixture();
    const disabled = new SensitiveReplyDelivery(f.root, f.gateway, f.clock, false);
    const reply = await disabled.prepare(context, raw);
    expect(reply).toContain('开关已关闭'); expect(reply).not.toContain('fake-private-authorization');
    expect(await disabled.retry('a'.repeat(32), 'ou_owner')).toContain('开关已关闭');
    expect(f.send).not.toHaveBeenCalled(); expect(f.verify).not.toHaveBeenCalled();
  });
  it('keeps public replies redacted and explanatory, delivers exact URLs only to verified requester, and deduplicates concurrent/restarted completion', async () => {
    const f = await fixture();
    const replies = await Promise.all([f.delivery.prepare(context, raw), f.delivery.prepare(context, raw)]);
    for (const reply of replies) {
      expect(reply).not.toContain('fake-private-authorization');
      expect(reply.startsWith('隐私说明：')).toBe(true);
      expect(reply).toContain('隐私说明'); expect(reply).toContain('授权或带敏感参数的链接'); expect(reply).toContain('已通过 code bot 私聊发送');
    }
    expect(f.verify).toHaveBeenCalledWith('original', 'group', 'ou_owner');
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.send.mock.calls[0]![0]).toBe('ou_owner');
    expect(f.send.mock.calls[0]![1]).toContain('https://auth.example.test/authorize?client_id=example&state=fake-private-authorization');
    const restarted = new SensitiveReplyDelivery(f.root, f.gateway, f.clock);
    expect(await restarted.prepare(context, raw)).toContain('已通过 code bot 私聊发送');
    expect(f.send).toHaveBeenCalledOnce();
    const names = await readdir(join(f.root, providerDirectory));
    for (const name of names) expect((await readFile(join(f.root, providerDirectory, name))).includes(Buffer.from('fake-private-authorization'))).toBe(false);
  });
  it('keeps failed payload encrypted, reports failure truthfully, retries with the same UUID and rejects other users', async () => {
    const f = await fixture();
    f.send.mockRejectedValueOnce(new Error('upstream leaked fake-private-authorization'));
    const publicReply = await f.delivery.prepare(context, raw);
    expect(publicReply).toContain('私聊投递未完成'); expect(publicReply).not.toContain('已通过 code bot 私聊发送');
    expect(publicReply).not.toContain('fake-private-authorization');
    const ref = publicReply.match(/\/retry-sensitive ([a-f0-9]{32})/)![1]!;
    expect(await f.delivery.retry(ref, 'ou_other')).toContain('不是原请求者');
    expect(f.send).toHaveBeenCalledOnce();
    const names = await readdir(join(f.root, providerDirectory));
    expect((await readFile(join(f.root, providerDirectory, names[0]!))).includes(Buffer.from('fake-private-authorization'))).toBe(false);
    const restarted = new SensitiveReplyDelivery(f.root, f.gateway, f.clock);
    expect(await restarted.retry(ref, 'ou_owner')).toContain('已通过 code bot 私聊发送');
    expect(f.send.mock.calls[0]).toEqual(f.send.mock.calls[1]);
  });
  it('does not forward contents from a different runtime owner or a mismatching platform source', async () => {
    const f = await fixture();
    expect(await f.delivery.prepare({ ...context, ownerUserId: 'ou_other' }, raw)).toContain('无法确认其归属');
    expect(f.verify).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
    f.verify.mockResolvedValue(false);
    expect(await f.delivery.prepare(context, raw)).toContain('无法核验原消息');
    expect(f.send).not.toHaveBeenCalled();
  });
  it('expires failed content and clears it through independent cleanup', async () => {
    const f = await fixture(); f.send.mockRejectedValue(new Error('unavailable'));
    const reply = await f.delivery.prepare(context, raw), ref = reply.match(/\/retry-sensitive ([a-f0-9]{32})/)![1]!;
    f.advance(16 * 60_000); await f.delivery.cleanup();
    expect(await f.delivery.retry(ref, 'ou_owner')).toContain('无可重试');
    expect(await readdir(join(f.root, providerDirectory))).toEqual([]);
    expect(f.send).toHaveBeenCalledOnce();
  });
  it('never splits a URL across private messages and resumes only the unacknowledged parts', async () => {
    const f = await fixture(); let index = 0;
    f.send.mockImplementation(async () => { if (++index === 2) throw new Error('temporary'); return { messageId: `part-${index}` }; });
    const text = Array.from({ length: 8 }, (_, n) => `https://example.test/authorize?state=${n}-${'x'.repeat(4000)}`).join('\n');
    const reply = await f.delivery.prepare(context, text), ref = reply.match(/\/retry-sensitive ([a-f0-9]{32})/)![1]!;
    expect(reply).not.toContain('已通过 code bot 私聊发送');
    expect(await f.delivery.retry(ref, 'ou_owner')).toContain('已通过 code bot 私聊发送');
    expect(f.send.mock.calls[1]).toEqual(f.send.mock.calls[2]);
    expect(f.send.mock.calls.filter((call) => call[2] === f.send.mock.calls[0]![2])).toHaveLength(1);
    for (const call of f.send.mock.calls) expect(call[1]).not.toMatch(/state=\d-x{1,3999}(?:\n|$)/);
  });
  it('bounds delivery size, retries, and does nothing to ordinary replies', async () => {
    const f = await fixture(); expect(await f.delivery.prepare(context, 'ordinary answer')).toBe('ordinary answer');
    expect(await f.delivery.prepare(context, `token=${'x'.repeat(13000)}`)).toContain('超过安全投递上限');
    expect(f.send).not.toHaveBeenCalled();
    f.send.mockRejectedValue(new Error('unavailable'));
    const reply = await f.delivery.prepare(context, raw), ref = reply.match(/\/retry-sensitive ([a-f0-9]{32})/)![1]!;
    for (let n = 0; n < 6; n++) await f.delivery.retry(ref, 'ou_owner');
    expect(f.send).toHaveBeenCalledTimes(5);
  });
});
