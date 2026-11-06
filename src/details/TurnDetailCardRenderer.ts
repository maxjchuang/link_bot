import type { TurnDetailCardAction } from '../feishu/FeishuCardActions.js';
import type { DetailEntry } from './TurnDetailTypes.js';
import type { DetailBodyPage, DetailListEntry } from './TurnDetailService.js';
import { cardConfig, header, markdown, safeCardText, safePlainCardText, section } from '../livecards/TaskCardLayout.js';

const code = (text: string) => markdown(`\`\`\`\n${text.replace(/`/g, '｀')}\n\`\`\``);
function title(entry: DetailEntry): string {
  return safePlainCardText(String(entry.metadata.command ?? entry.metadata.path
    ?? (entry.source === 'summary' ? '思考摘要' : entry.source === 'plan' ? '计划' : '进度')), 160);
}
function status(entry: DetailEntry): string {
  if (entry.category === 'commands') return `${entry.metadata.completed === true ? '已结束' : '执行中 / 状态未完整上报'} · 退出码：${entry.metadata.exitCode ?? '未上报'}`;
  if (entry.category === 'files') return `新增 ${entry.metadata.added ?? '未上报'} · 删除 ${entry.metadata.removed ?? '未上报'}`;
  return entry.metadata.completed === true ? '已记录完成' : '已记录进度';
}

export function renderTurnDetailCard(action: TurnDetailCardAction, page: { entries: DetailListEntry[]; nextCursorRef?: string } | DetailBodyPage, downloads = false): Record<string, unknown> {
  const labels = { process: '过程记录', commands: '命令与输出', files: '文件变更', result: '完整答复' };
  const button = (text: string, value: TurnDetailCardAction) => ({ tag: 'button', type: 'primary_text', size: 'small', text: { tag: 'plain_text', content: text.slice(0, 100) },
    behaviors: [{ type: 'callback', value }] });
  const base: TurnDetailCardAction = { kind: 'turn_detail', cardRef: action.cardRef, category: action.category };
  const elements: Record<string, unknown>[] = [];
  if ('entries' in page) {
    const content: Record<string, unknown>[] = [];
    if (!page.entries.length) content.push(markdown('暂无可展示记录；上游可能尚未上报，或详情未完整记录。'));
    for (const [index, entry] of page.entries.entries()) {
      const preview = entry.preview || (entry.previewMissing ? '正文尚未留存或暂时无法读取。' : '没有已留存的正文。');
      const notes = [status(entry), `记录时间：${entry.receivedAt}`, entry.resource?.redacted ? '敏感内容已隐藏' : '', entry.resource?.truncated ? '留存内容已截断' : '',
        entry.previewHasMore ? '仅展示开头，查看完整记录可继续阅读' : ''].filter(Boolean).join(' · ');
      // Native expansion is local, without another callback/network round trip.
      content.push({ tag: 'collapsible_panel', expanded: action.category === 'process' || index === 0,
        header: { title: { tag: 'plain_text', content: action.category === 'process' ? title(entry) : `${status(entry)}｜${title(entry)}` }, icon_position: 'right' },
        padding: '8px', vertical_spacing: '8px', border: { color: 'grey-200', corner_radius: '8px' },
        elements: [markdown(`<font color='grey'>${safeCardText(notes, 240)}</font>`), code(preview),
          button('查看完整记录', { ...base, itemRef: entry.entryId })] });
    }
    elements.push(section(content));
  } else {
    const entry = page.entry;
    elements.push(section([markdown(`**${safeCardText(title(entry), 160)}**`),
      markdown(`<font color='grey'>${safeCardText(status(entry), 240)}</font>`),
      ...(typeof entry.metadata.command === 'string' ? [code(entry.metadata.command.slice(0, 1000)),
        ...(entry.metadata.command.length > 1000 ? [markdown('<font color="grey">命令较长，此处仅展示前 1000 字符；完整内容可下载安全记录。</font>')] : [])] : []),
      ...(entry.metadata.cwd ? [code(`目录：${String(entry.metadata.cwd).slice(0, 500)}`)] : []),
      code(page.text || '没有留存的可展示正文。'),
      ...[page.truncated ? '详情已截断' : '', page.missing ? '详情未完整记录或未上报' : '', entry.resource?.redacted ? '敏感内容已隐藏' : '']
        .filter(Boolean).map((note) => markdown(`<font color='grey'>${note}</font>`))]));
  }
  const controls = [
    ...(!('entries' in page) ? [button('返回列表', base)] : []),
    ...(page.nextCursorRef ? [button('下一页', { ...base, ...(action.itemRef ? { itemRef: action.itemRef } : {}), cursorRef: page.nextCursorRef })] : []),
    button('刷新最新', { ...base, ...(action.itemRef ? { itemRef: action.itemRef } : {}) }),
    ...(downloads ? [button('下载本回合安全记录', { ...base, download: true })] : []),
  ];
  elements.push(section([{ tag: 'column_set', flex_mode: 'flow', columns: controls.map((control) => ({ tag: 'column', width: 'weighted', weight: 1, elements: [control] })) }]));
  elements.push(section([markdown('<font color="grey">这是按需读取的详情快照；展开不触发新请求，刷新获取最新记录。主任务卡及其运行信息保持不变。</font>')], 'grey-50'));
  return { schema: '2.0', config: cardConfig,
    header: header(labels[action.category], '摘要直接可读 · 长内容按需展开', 'blue', 'info_outlined'),
    body: { padding: '12px', vertical_spacing: '12px', elements } };
}
