/** Use real platform positions, following the official CLI's assembleMessageAppLink contract:
 * https://github.com/larksuite/cli/blob/main/shortcuts/im/convert_lib/content_convert.go
 * Never invent a message-ID-only deep link or silently fall back to opening the whole chat.
 */
export function platformMessageAppLink(item: Record<string, unknown>): string | undefined {
  if (typeof item.message_app_link === 'string' && item.message_app_link.trim()) return item.message_app_link;
  if (typeof item.chat_id !== 'string' || !/^oc_[\w-]+$/.test(item.chat_id)) return undefined;
  const position = (value: unknown): string | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? String(value) : typeof value === 'string' && /^\d+$/.test(value) ? value : undefined;
  const threadPosition = position(item.thread_message_position), messagePosition = position(item.message_position);
  const url = new URL('https://applink.feishu.cn/client/chat/open');
  if (typeof item.thread_id === 'string' && /^(?:om|omt)_[\w-]+$/.test(item.thread_id) && threadPosition !== undefined) {
    url.pathname = '/client/thread/open';
    for (const key of ['openthreadid', 'open_thread_id']) url.searchParams.set(key, item.thread_id);
    for (const key of ['openchatid', 'open_chat_id']) url.searchParams.set(key, item.chat_id);
    url.searchParams.set('thread_position', threadPosition);
  } else if (messagePosition !== undefined) {
    url.searchParams.set('openChatId', item.chat_id);
    url.searchParams.set('position', messagePosition);
  } else return undefined;
  return url.toString();
}
