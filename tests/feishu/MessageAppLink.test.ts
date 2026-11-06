import { describe, expect, it } from 'vitest';
import { platformMessageAppLink } from '../../src/feishu/MessageAppLink.js';
describe('platform-position message links', () => {
  it('uses actual chat positions or thread positions with both PC/mobile keys', () => {
    expect(platformMessageAppLink({ chat_id: 'oc_chat', message_position: '42' })).toBe('https://applink.feishu.cn/client/chat/open?openChatId=oc_chat&position=42');
    const url = new URL(platformMessageAppLink({ chat_id: 'oc_chat', thread_id: 'omt_thread', thread_message_position: '0' })!);
    expect(url.pathname).toBe('/client/thread/open'); expect(url.searchParams.get('thread_position')).toBe('0');
    expect(url.searchParams.get('openthreadid')).toBe('omt_thread'); expect(url.searchParams.get('open_thread_id')).toBe('omt_thread');
  });
  it('does not invent a precise jump from a message ID alone or invalid positions', () => {
    for (const value of [undefined, -1, Infinity, 'not-a-number', '42&evil=1']) {
      expect(platformMessageAppLink({ chat_id: 'oc_chat', message_id: 'om_msg', message_position: value })).toBeUndefined();
    }
  });
});
