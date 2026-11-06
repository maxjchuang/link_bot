import { sanitizeDetailText } from '../details/DetailSanitizer.js';

export const cardConfig = { update_multi: true, width_mode: 'default' };
export function safePlainCardText(value: string, limit = 120): string {
  const text = sanitizeDetailText(value).text.replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
export function safeCardText(value: string, limit = 120): string {
  return safePlainCardText(value, limit)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\[\]*_`~]/g, (char) => `&#${char.charCodeAt(0)};`);
}
export function markdown(content: string, elementId?: string): Record<string, unknown> {
  return { tag: 'markdown', content, margin: '0px', ...(elementId ? { element_id: elementId } : {}) };
}
export function section(elements: Record<string, unknown>[], background = 'default', id?: string): Record<string, unknown> {
  return { tag: 'column_set', flex_mode: 'none', ...(id ? { element_id: id } : {}), columns: [
    { tag: 'column', width: 'weighted', weight: 1, background_style: background,
      padding: background === 'default' ? '0px' : '8px', vertical_spacing: '8px', elements },
  ] };
}
export function detailEntrances(cardRef: string | undefined, final = false): Record<string, unknown>[] {
  if (!cardRef || !/^[a-f0-9]{32}$/.test(cardRef)) return [markdown('<font color="grey">详情入口暂不可用，任务执行不受影响。</font>')];
  return [{ tag: 'column_set', element_id: 'detail_nav', flex_mode: 'trisect', horizontal_spacing: '4px', columns:
    (['process', 'commands', 'files'] as const).map((category, index) => ({ tag: 'column', width: 'weighted', weight: 1,
      elements: [{ tag: 'button', type: 'primary_text', size: 'small', width: 'fill',
        text: { tag: 'plain_text', content: (final ? ['过程记录', '命令与输出', '文件变更'] : ['查看过程', '查看命令', '查看 Diff'])[index] },
        behaviors: [{ type: 'callback', value: { kind: 'turn_detail', cardRef, category } }] }] })) }];
}
export function runtimeFooter(lines: string[], terminal = false): Record<string, unknown> {
  const labels = ['模型', '思考强度', '模式', '上下文', '任务累计', '已运行'];
  const fields = labels.map((label) => {
    const line = lines.find((value) => value.includes(`${label}：`))
      ?.replace(/^>\s*/, '').replace(/<\/?font\b[^>]*>/g, '') ?? `${label}：${terminal ? '未上报' : '等待上报'}`;
    return { ...markdown(`<font color='grey'>${safeCardText(line, 160)}</font>`), text_size: 'notation' };
  });
  // Card 2.0 accepts but drops the legacy div.fields payload. Use native columns
  // with markdown leaves so server round-trips and clients retain all six values.
  const rows = [0, 2, 4].map((offset) => ({ tag: 'column_set', flex_mode: 'none', horizontal_spacing: '8px',
    columns: fields.slice(offset, offset + 2).map((field) => ({ tag: 'column', width: 'weighted', weight: 1,
      padding:'0px',vertical_spacing:'0px',elements: [field] })) }));
  const footer = section([{ tag: 'hr' }, ...rows], 'default', 'app_server_footer');
  (footer.columns as Array<Record<string, unknown>>)[0]!.vertical_spacing = '4px';
  return footer;
}
export function header(title: string, subtitle: string, template: string, icon = 'done_outlined'): Record<string, unknown> {
  return { title: { tag: 'plain_text', content: title }, subtitle: { tag: 'plain_text', content: subtitle },
    template, padding: '16px 20px 16px 20px', icon: { tag: 'standard_icon', token: icon, color: template } };
}
export function safeOperationLink(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password
      && ['applink.feishu.cn', 'applink.larksuite.com'].includes(url.hostname) && url.pathname.startsWith('/client/') ? raw : undefined;
  } catch { return undefined; }
}
