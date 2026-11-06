import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getFeishuOpenId, parseArgs, readOpenIds } from '../../scripts/get-feishu-openid.mjs';

describe('get-feishu-openid', () => {
  it('parses wait timeout and list mode', () => {
    expect(parseArgs(['--timeout', '30'])).toMatchObject({ mode: 'wait', timeoutSeconds: 30 });
    expect(parseArgs(['--all'])).toMatchObject({ mode: 'all' });
  });

  it('reads the latest command receipt for each Feishu open ID', async () => {
    const eventsDir = await fixture([
      event('ou_one', '2026-07-30T10:00:00.000Z'),
      event('ou_two', '2026-07-30T10:01:00.000Z'),
      event('ou_one', '2026-07-30T10:02:00.000Z'),
      JSON.stringify({ type: 'other', at: '2026-07-30T10:03:00.000Z', data: { userId: 'ou_ignored' } }),
    ]);
    await expect(readOpenIds(eventsDir)).resolves.toEqual([
      { openId: 'ou_one', receivedAt: '2026-07-30T10:02:00.000Z', receivedAtMs: Date.parse('2026-07-30T10:02:00.000Z') },
      { openId: 'ou_two', receivedAt: '2026-07-30T10:01:00.000Z', receivedAtMs: Date.parse('2026-07-30T10:01:00.000Z') },
    ]);
  });

  it('returns a newly received open ID in wait mode', async () => {
    const eventsDir = await fixture([event('ou_admin', '2026-07-30T10:00:01.000Z')]);
    await expect(getFeishuOpenId({
      args: ['--timeout', '1'], eventsDir, now: () => Date.parse('2026-07-30T10:00:00.000Z'), wait: async () => {},
    })).resolves.toMatchObject({ entries: [{ openId: 'ou_admin' }] });
  });
});

function event(userId, at) {
  return JSON.stringify({ type: 'command.received', at, data: { userId } });
}

async function fixture(lines) {
  const root = await mkdtemp(join(tmpdir(), 'link-bot-openid-'));
  const eventsDir = join(root, 'events');
  await mkdir(eventsDir);
  await writeFile(join(eventsDir, '2026-07-30.jsonl'), `${lines.join('\n')}\n`);
  return eventsDir;
}
