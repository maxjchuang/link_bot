import { emptyInlineDetails, type InlineDetailsSnapshot, type InlineTimelineItem } from '../details/InlineTurnDetails.js';
import {createHash} from 'node:crypto';
import { markdown, safeCardText, section } from './TaskCardLayout.js';
import {sanitizeDetailText} from '../details/DetailSanitizer.js';
import {feishuMarkdownElements} from '../feishu/FeishuMessageRenderer.js';
import {resolveInlineTimelineLimit} from '../details/InlineTimelineLimits.js';

const maxBytes = 24_000;
const maxComponents = 180; // Leave headroom below the platform limit, including header text/icon nodes.
function componentCount(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return value.reduce((sum,item)=>sum+componentCount(item),0);
  const object=value as Record<string,unknown>;
  return (typeof object.tag==='string'?1:0)+Object.values(object).reduce<number>((sum,item)=>sum+componentCount(item),0);
}
function hasPrimaryContent(element: Record<string, any>): boolean {
  if (element.tag !== 'column_set') return true;
  return element.columns?.some((column: Record<string, any>) => column.elements?.some(hasPrimaryContent)) === true;
}
export function isTimelineTaskCard(card: Record<string, any>): boolean {
  return card.body?.elements?.some((element: Record<string, unknown>) => element.element_id === 'turn_timeline') === true;
}
export function timelineTaskShell(card: Record<string, any>): Record<string, any> | undefined {
  return card.body?.elements?.find((element: Record<string, unknown>)=>element.element_id==='turn_timeline');
}
function duration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '未上报';
  const seconds = Math.floor(ms / 1000), hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return `${hours ? `${hours}小时` : ''}${minutes ? `${minutes}分` : ''}${seconds % 60}秒`;
}
function processMarkdown(text: string): string {
  // Preserve Markdown whitespace, lists, emphasis and links. Escape raw card/HTML
  // tags so a quoted tool/document cannot inject mentions or card resources.
  const escaped = sanitizeDetailText(text).text.replace(/<\/?[A-Za-z][^>\n]*>/g, tag => tag.replace(/</g,'&lt;').replace(/>/g,'&gt;'));
  return (escaped.match(/^\s*```/gm)?.length ?? 0) % 2 ? `${escaped}\n\`\`\`` : escaped;
}
const code = (text: string) => markdown(`\`\`\`\n${text.replace(/```/g,'｀｀｀')}\n\`\`\``);
function foldHeader(title: Record<string, unknown>, position = 'follow_text'): Record<string, unknown> {
  return {title,icon:{tag:'standard_icon',token:'down-small-ccm_outlined',color:'grey',size:'16px 16px'},
    icon_position:position,icon_expanded_angle:-180};
}
function commandStatus(item: InlineTimelineItem) {
  return item.failed ? 'failed' : item.commandStatus ?? 'unknown';
}
function commandState(item: InlineTimelineItem): Record<string, unknown> {
  const status = commandStatus(item);
  const symbol = status === 'succeeded' ? '✓' : status === 'failed' ? '✗' : '◷';
  const colour = status === 'succeeded' ? 'green' : status === 'failed' ? 'red' : 'grey';
  const action = status === 'running' ? '正在运行' : status === 'unknown' ? '命令（状态未上报）' : '已运行';
  const elapsed = item.durationMs !== undefined && Number.isFinite(item.durationMs) && item.durationMs >= 0 ? ` · ${duration(item.durationMs)}` : '';
  const brief = safeCardText(item.command ?? item.title, 72);
  return foldHeader({tag:'markdown',content:`<font color='${colour}'>${symbol}</font> <font color='grey'>${action} ${brief}${elapsed}</font>`},'right');
}
const itemId = (key: string) => createHash('sha256').update(key).digest('hex').slice(0,16);
function identified(rows: Record<string, unknown>[], key: string): Record<string, unknown>[] {
  return rows.map((row,index)=>({...row,element_id:`tl_${itemId(`${key}:${index}`)}`}));
}
function entry(item: InlineTimelineItem, chars: number, cardRef?: string): Record<string, unknown>[] {
  const body = Array.from(item.text).slice(0, chars).join('');
  const limited = item.limited || Array.from(item.text).length > chars;
  if (item.category === 'commands') {
    const command = item.command ?? item.title;
    const commandPreview = Array.from(command).slice(0, chars).join('');
    const status = commandStatus(item);
    const colour = status === 'succeeded' ? 'green' : status === 'failed' ? 'red' : 'grey';
    const result = status === 'succeeded' ? '✓ 成功' : status === 'failed' ? '✗ 失败' : status === 'running' ? '◷ 执行中' : '◷ 状态未上报';
    const elements = [markdown('<font color="grey">Shell</font>'),
      code(`$ ${commandPreview || '命令原文未留存。'}\n\n${body || '暂无已留存的输出。'}`),
      {...markdown(`<font color='${colour}'>${result}</font>`),text_align:'right'}];
    if (limited || Array.from(command).length > chars) {
      elements.push(markdown('⚠️ 命令或输出仅展示预览，长内容已截断。'));
    }
    return elements;
  }
  if (item.category === 'files') {
    const rows = [markdown(`**${safeCardText(item.title,160)}**`),markdown(`<font color='grey'>${safeCardText(item.metadata,180)}</font>`),code(body || 'Diff 正文尚未留存。')];
    if (limited) {
      rows.push(markdown('⚠️ Diff 仅展示预览，长内容已截断。'));
    }
    return rows;
  }
  const rows: Record<string, unknown>[] = feishuMarkdownElements(processMarkdown(body || '公开进展正文未留存。')).map(row=>({...row,margin:'0px'}));
  if (limited && item.category === 'process') rows.push(markdown('<font color="grey">此条进展仅展示预览。</font>'));
  return rows;
}

/** Group adjacent tools of the same category without reordering public progress. */
function timelineEntries(items: InlineTimelineItem[], chars: number, cardRef?: string): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  let commands: InlineTimelineItem[] = [];
  const flush = () => {
    if (!commands.length) return;
    const category = commands[0]!.category;
    const id = createHash('sha256').update(commands[0]!.entryId).digest('hex').slice(0,category === 'files' ? 15 : 16);
    const failed = commands.some(item => item.failed);
    const elements = commands.flatMap(item => category === 'commands' ? [{
      tag:'collapsible_panel',element_id:`run_${itemId(item.entryId)}`,expanded:false,padding:'0px',
      header:commandState(item),elements:identified(entry(item,chars,cardRef),item.entryId),
    }] : identified(entry(item,chars,cardRef),item.entryId));
    result.push({tag:'collapsible_panel',element_id:`${category === 'commands' ? 'cmd' : 'file'}_${id}`,expanded:false,padding:'0px',
      header:foldHeader({tag:'plain_text',content:category === 'files' ? '查看文件变更' : `查看已运行命令${failed ? '（含失败操作）' : ''}`}), elements});
    commands = [];
  };
  for (const item of items) {
    if (item.category !== 'process') {
      if (commands.length && commands[0]!.category !== item.category) flush();
      commands.push(item);
    }
    else { flush(); result.push(...identified(entry(item, chars, cardRef),item.entryId)); }
  }
  flush();
  return result;
}

/** Only inner regions change while running. Terminal delivery removes the footer
 * and collapses the process. Command groups always default to collapsed. */
export function withTimelineTaskDetails(base: Record<string, any>, snapshot = emptyInlineDetails(), cardRef?: string,
  options: { terminal?: boolean; elapsedMs?: number; finalAnswer?: string } = {}): Record<string, unknown> {
  const terminal = options.terminal === true;
  const elements = base.body.elements as Array<Record<string, any>>;
  const footer = elements.find((element) => element.element_id === 'app_server_footer');
  const primary = elements.filter((element) => !['app_server_footer', 'turn_stats', 'detail_nav'].includes(element.element_id)
    && hasPrimaryContent(element));
  // Keep the update anchor, but never let an empty nested section or an automatic
  // sibling gap reserve space above the process. Visible regions own their gaps.
  const primaryRegion = { ...section(primary, 'default', 'turn_primary'), margin: primary.length ? '0px 0px 12px 0px' : '0px' };
  const { header: _header, ...shell } = base;
  let count = resolveInlineTimelineLimit(snapshot.timeline?.maxItems), chars = 8000;
  for (;;) {
    const content: Record<string, unknown>[] = [];
    const timeline = snapshot.timeline;
    const normalized = (text: string) => text.replace(/\s+/g,' ').trim();
    const answer = normalized(options.finalAnswer ?? '');
    const finalIndex = timeline?.items.map(item => item.finalAnswer === true).lastIndexOf(true) ?? -1;
    const duplicate = (item: InlineTimelineItem, index: number) => terminal && item.category === 'process'
      && (item.finalAnswer && index === finalIndex || answer && index === (timeline?.items.length ?? 0) - 1 && normalized(item.text)
      && (normalized(item.text) === answer || item.limited && normalized(item.text).length >= 80 && answer.startsWith(normalized(item.text))));
    // Hide only the final duplicate display copy; retained records are unchanged.
    const visible = timeline?.items.filter((item,index) => !duplicate(item,index)) ?? [];
    const hidden = (timeline?.items.length ?? 0) - visible.length;
    const total = (timeline?.total ?? 0) - hidden;
    const selected = count ? visible.slice(-count) : [];
    const thinking = !terminal && (snapshot.status === 'pending' || snapshot.status === 'available' && timeline !== undefined && total === 0);
    if (thinking) content.push(markdown('<font color="grey">正在思考…</font>'));
    else if (snapshot.status !== 'available') content.push(markdown(snapshot.status === 'pending' ? '等待执行记录。'
      : snapshot.status === 'expired' ? '执行记录已过期或清理。' : '执行记录暂不可用或无法核验当前会话的发布范围。'));
    else if (!timeline) content.push(markdown('有序执行记录暂不可用。'));
    else {
      if (selected.length < total) content.push(markdown(`<font color='grey'>展示最近 ${selected.length}／${total} 条记录；更早内容未在本卡展示。</font>`));
      content.push(...timelineEntries(selected, chars, cardRef));
      if (!total && !hidden) content.push(markdown('暂无已留存记录，不能据此判断未执行操作。'));
    }
    const timelineRegion = section(content.map((row,index)=>row.element_id ? row :
      {...row,element_id:`nt_${itemId(`${row.tag}:${index}`)}`}), 'default', 'timeline_content') as Record<string, any>;
    timelineRegion.columns[0].element_id = 'timeline_items';
    const panel = thinking ? section([timelineRegion], 'default', 'turn_timeline') : { tag: 'collapsible_panel', element_id: 'turn_timeline', expanded: !terminal,
      header: foldHeader({ tag: 'plain_text', content: terminal ? `用时 ${duration(options.elapsedMs)} · 查看执行过程` : '执行过程' }),
      padding: '0px', elements: [timelineRegion] };
    const card = { ...shell, body: { ...base.body, vertical_spacing: '0px', elements: [primaryRegion, panel,
      ...(!terminal && footer ? [{...footer, margin:'12px 0px 0px 0px'}] : [])] } };
    const components = componentCount(card);
    if (components <= maxComponents && Buffer.byteLength(JSON.stringify(card)) <= maxBytes) return card;
    if (components > maxComponents && count > 0) count--;
    else if (chars > 1000) chars = 1000;
    else if (chars > 100) chars = 100;
    else if (count > 0) count--;
    else throw new Error('inline_card_budget_exceeded'); // Never trim answers or operation links to fit process previews.
  }
}
