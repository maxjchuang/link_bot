import { emptyInlineDetails, inlineCategories, type InlineDetailsSnapshot } from '../details/InlineTurnDetails.js';
import { markdown, safeCardText, section } from './TaskCardLayout.js';
import { isTimelineTaskCard } from './TimelineTaskCardLayout.js';

const labels = { process: '过程记录', commands: '命令与输出', files: '文件变更' };
const bodyIds = { process: 'inline_p_content', commands: 'inline_c_content', files: 'inline_f_content' };
const maxBytes = 24_000;

/** Keep the native header; ordinary body updates never replace outer panels. */
export function withInlineTaskDetails(base: Record<string, any>, snapshot = emptyInlineDetails(), cardRef?: string): Record<string, unknown> {
  const elements = base.body.elements as Array<Record<string, any>>;
  const footer = elements.find((element) => element.element_id === 'app_server_footer');
  const stats = elements.find((element) => element.element_id === 'turn_stats')
    ?? section([markdown('<font color="grey">回合已结束，以下为已留存的详情快照。</font>')], 'grey-50', 'turn_stats');
  const primary = elements.filter((element) => !['app_server_footer', 'turn_stats', 'detail_nav'].includes(element.element_id));
  let count = 5, chars = 300;
  for (;;) {
    const panels = inlineCategories.map((category) => {
      const page = snapshot.categories[category], selected = count ? page.items.slice(-count) : [];
      const contents: Record<string, unknown>[] = [];
      if (snapshot.status !== 'available') contents.push(markdown(snapshot.status === 'pending' ? '详情尚未记录，等待上报。'
        : snapshot.status === 'expired' ? '详情已过期或清理，不再重新加载。' : '详情暂不可用或无法核验当前会话的发布范围。'));
      else {
        contents.push(markdown(`<font color='grey'>已展示 ${selected.length}／${page.total} 条${snapshot.incomplete ? ' · 留存可能不完整' : ''}。仅包含可在当前会话发布的内容。</font>`));
        for (const item of selected) {
          const excerpt = Array.from(item.text).slice(0, chars).join('').replace(/`/g, '｀');
          contents.push(markdown(`**${safeCardText(item.title, 100)}**\n<font color='grey'>${safeCardText(item.metadata, 160)}</font>`),
            markdown(`\`\`\`\n${excerpt || '没有可展示的正文。'}\n\`\`\``));
          if (item.limited || Array.from(item.text).length > chars) contents.push(markdown('<font color="grey">仅展示预览；完整内容请使用下方入口。</font>'));
        }
        if (!page.total) contents.push(markdown('暂无已留存记录，不能据此判断未执行操作。'));
      }
      if (cardRef && /^[a-f0-9]{32}$/.test(cardRef)) contents.push({ tag: 'button', type: 'primary_text', size: 'small',
        text: { tag: 'plain_text', content: '查看完整内容／下载' },
        behaviors: [{ type: 'callback', value: { kind: 'turn_detail', cardRef, category } }] });
      else contents.push(markdown('<font color="grey">完整记录入口暂不可用；此处仅展示已留存预览。</font>'));
      return { tag: 'collapsible_panel', element_id: `inline_${category}`, expanded: false,
        header: { title: { tag: 'plain_text', content: labels[category] }, icon_position: 'right' },
        padding: '8px', elements: [section(contents, 'default', bodyIds[category])] };
    });
    const card = { ...base, body: { ...base.body,
      elements: [section(primary, 'default', 'turn_primary'), stats,
        section(panels, 'default', 'inline_details'), ...(footer ? [footer] : [])] } };
    if (Buffer.byteLength(JSON.stringify(card)) <= maxBytes) return card;
    if (chars > 80) chars = 80;
    else if (count > 0) count--;
    else throw new Error('inline_card_budget_exceeded'); // Never truncate the answer, footer, or operation links to fit previews.
  }
}

export interface InlineCardRegion { elementId: string; element: Record<string, unknown> }
export function inlineCardRegions(card: Record<string, any>): InlineCardRegion[] {
  // Frozen pre-native-header finalization intents still own their original seven
  // regions. Do not reinterpret or rewrite these historical delivery payloads.
  const wanted = isTimelineTaskCard(card)
    ? new Set(['turn_primary', 'timeline_content', ...(card.body.elements.some((element: any) => element.element_id === 'app_server_footer') ? ['app_server_footer'] : [])])
    : new Set([...(card.header ? [] : ['turn_status']), 'turn_primary', 'turn_stats', 'app_server_footer', ...Object.values(bodyIds)]);
  const result: InlineCardRegion[] = [];
  const walk = (value: any) => {
    if (!value || typeof value !== 'object') return;
    if (wanted.has(value.element_id)) { result.push({ elementId: value.element_id, element: value }); return; }
    for (const item of Object.values(value)) if (typeof item === 'object') Array.isArray(item) ? item.forEach(walk) : walk(item);
  };
  walk(card.body);
  if (result.length !== wanted.size || new Set(result.map((region) => region.elementId)).size !== wanted.size) throw new Error('inline_card_regions_invalid');
  return result;
}
