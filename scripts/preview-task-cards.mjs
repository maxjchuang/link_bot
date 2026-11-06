import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const buildRoot = resolve(process.env.LINK_BOT_PREVIEW_DIST ?? 'dist');
const { renderStructuredTurnCard } = await import(pathToFileURL(join(buildRoot, 'src/livecards/StructuredTurnCardRenderer.js')));
const { renderStructuredFinalCard } = await import(pathToFileURL(join(buildRoot, 'src/livecards/StructuredFinalCardRenderer.js')));
const { emptyInlineDetails } = await import(pathToFileURL(join(buildRoot, 'src/details/InlineTurnDetails.js')));

// Read-only product fixtures, not real task/approval data. Never send these cards to Feishu.
const out = resolve(process.argv[2] ?? '.link-bot/card-ui-preview');
await mkdir(out, { recursive: true });
const now = Date.parse('2026-10-16T12:00:00Z');
const footer = ['模型：gpt-6.1-sol', '思考强度：medium', '模式：标准', '上下文：38.2%', '任务累计：24.6k tokens', '已运行：2 分 14 秒'];
const snapshot = { taskId: 'example', phase: 'running', commentary: '', commandOutput: '', fileChangeOutput: '', items: [], compacting: false, revision: 1,
  processPreviews: [{ itemId: 'progress', source: 'progress', text: '检查消息发送路径' }],
  summary: { commands: 5, completedCommands: 4, failedCommands: 1, files: 3, added: 42, removed: 12,
    recentResult: '定位 2 处调用 · 1 个失败测试', incomplete: false,
    activities: [
      { id: 'source', title: '读取相关源码与项目约束', status: 'completed' },
      { id: 'commands', title: '运行 5 条命令，1 条失败', status: 'completed' },
      { id: 'verify', title: '验证 3 个文件的变更', status: 'running' },
    ] } };
const inlineDetails = emptyInlineDetails('available');
inlineDetails.timeline = {total:3,items:[
  {category:'process',title:'公开进展',text:'已经定位消息发送路径，正在核对卡片更新方式。'},
  {category:'commands',title:'npm test',text:'Tests passed.'},
  {category:'files',title:'example.ts',text:'Synthetic diff.'},
].map((item,i)=>({...item,entryId:String(i+1).repeat(32),metadata:'演示记录 · 已完成',receivedAt:'2026-10-22T00:00:00Z',failed:false,limited:false}))};
const common = { label: 'Link Bot', cardRef: 'a'.repeat(32), elapsedMs: 134000, footer, nowMs: now, inlineDetails };
const fixtures = {
  running: renderStructuredTurnCard({ ...common, snapshot }),
  action: renderStructuredTurnCard({ ...common, snapshot: { ...snapshot, pendingActions: [{
    requestRef: 'example', generation: 1, handlerUserId: 'ou_example', status: 'delivered',
    title: '命令审批：运行发布脚本', impact: '将执行一次受控发布操作；请核对操作卡中的命令与影响范围。',
    expiresAt: new Date(now + 60000).toISOString(), messageId: 'om_example',
    messageAppLink: 'https://applink.feishu.cn/client/message/link?token=ui-example-only',
  }] } }),
  completed: renderStructuredFinalCard({ ...common, phase: 'completed', answer: '**修改与验证已完成。**\n\n以下是结果摘要；过程、命令和文件变更仍可按需查看。', hasMore: false }),
};
for (const [name, card] of Object.entries(fixtures)) await writeFile(join(out, `${name}.json`), `${JSON.stringify(card, null, 2)}\n`);

const esc = (text) => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const colors = { blue: '#3370ff', green: '#26a080', red: '#d83931', yellow: '#d28c16', grey: '#687487', white: '#fff',
  'grey-50': '#f5f7fa', 'grey-200': '#dce0e7', 'yellow-50': '#fff9eb', 'orange-600': '#db8b18', default: 'transparent' };
function md(text) {
  return esc(text).replace(/&lt;person\b[^>]*?&gt;.*?&lt;\/person&gt;/g, '任务发起者')
    .replace(/&lt;font color=(?:'|&quot;)([^'&]+)(?:'|&quot;)&gt;/g, (_, color) => `<span style="color:${colors[color] ?? '#687487'}">`)
    .replaceAll('&lt;/font&gt;', '</span>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replaceAll('\n', '<br>').replace(/&amp;#(\d+);/g, '&#$1;');
}
function component(node) {
  if (node.tag === 'collapsible_panel') return `<details ${node.expanded ? 'open' : ''}><summary>${esc(node.header.title.content)}</summary><div class="process">${(node.elements??[]).map(component).join('')}</div></details>`;
  if (node.tag === 'column_set') return `<div class="columns ${node.flex_mode ?? ''}" style="gap:${node.horizontal_spacing ?? '8px'}">${node.columns.map(component).join('')}</div>`;
  if (node.tag === 'column') return `<div class="column" style="background:${colors[node.background_style] ?? 'transparent'};padding:${node.padding ?? '0px'};gap:${node.vertical_spacing ?? '8px'}">${(node.elements ?? []).map(component).join('')}</div>`;
  if (node.tag === 'markdown') return `<div class="markdown" style="text-align:${node.text_align ?? 'left'}">${md(node.content)}</div>`;
  if (node.tag === 'hr') return '<hr>';
  if (node.tag === 'interactive_container') return `<button disabled class="primary" style="background:${colors[node.background_style] ?? '#db8b18'};padding:${node.padding ?? '12px'}">${(node.elements ?? []).map(component).join('')}</button>`;
  if (node.tag === 'button') return `<button disabled class="${node.type === 'primary_text' ? 'link' : node.type === 'primary_filled' ? 'primary' : 'secondary'}">${esc(node.text?.content ?? '')}</button>`;
  if (node.tag === 'div' && node.fields) return `<div class="footer">${node.fields.map((field) => `<div>${md(field.text.content)}</div>`).join('')}</div>`;
  if (node.tag === 'div') return `<div class="activity"><span class="dot" style="color:${colors[node.icon?.color] ?? '#3370ff'}">●</span><span>${esc(node.text?.content ?? '')}</span></div>`;
  return '';
}
function card(value) {
  const h = value.header, theme = h?.template;
  const heading = h ? `<header class="${theme}" style="padding:${h.padding}"><span class="status-icon">${theme === 'yellow' || theme === 'red' ? '!' : '✓'}</span><div><h2>${esc(h.title.content)}</h2><p>${esc(h.subtitle.content)}</p></div></header>` : '';
  return `<article>${heading}<div class="body" style="padding:${value.body.padding};gap:${value.body.vertical_spacing}">${value.body.elements.map(component).join('')}</div></article>`;
}
const css = `@font-face{font-family:PreviewCJK;src:url('./preview-cjk.otf')}*{box-sizing:border-box}body{font-family:PreviewCJK,'Noto Sans CJK SC','Microsoft YaHei',sans-serif;background:#eef1f7;color:#203249;margin:0;padding:32px}h1{font-size:25px;margin:0 0 8px}.notice{font-size:14px;color:#67758a;margin-bottom:24px}.gallery{display:grid;grid-template-columns:repeat(2,minmax(0,600px));gap:24px;align-items:start}.caption{color:#607086;font-size:14px;margin:0 0 8px}article{background:white;border:1px solid #dbe2ed;border-radius:14px;overflow:hidden}header{display:flex;gap:14px;align-items:center;padding:20px 24px;background:#e8f0ff}.yellow{background:#fff2d7}.green{background:#e8f6ef}.red{background:#fff0ee}header h2{font-size:22px;line-height:1.4;margin:0}header p{margin:2px 0 0;font-size:14px;color:#5b769c}.yellow p{color:#9b7b37}.status-icon{display:grid;place-items:center;flex:none;background:#3370d2;color:white;width:32px;height:32px;border-radius:50%;font-weight:bold;font-size:23px}.yellow .status-icon{background:#de961c}.green .status-icon{background:#26a080}.body{display:flex;flex-direction:column;gap:12px;padding:20px 24px 24px}.columns{display:flex;width:100%;min-width:0}.column{flex:1;min-width:0;display:flex;flex-direction:column;border-radius:8px}.markdown{line-height:1.65;font-size:15px;overflow-wrap:anywhere}.activity{display:flex;gap:14px;font-size:15px;line-height:1.6;align-items:flex-start}.dot{font-size:20px;line-height:1.2}hr{border:0;border-top:1px solid #e5e9f0;width:100%;margin:4px 0}button{font-family:inherit;cursor:default;border:0;opacity:1;font-size:15px;min-height:42px;width:100%;border-radius:8px}.primary{padding:10px;background:#db8b18;color:white;font-weight:bold}.secondary{padding:10px;background:#f6f7fa;border:1px solid #dce1e9;color:#526176}.link{padding:4px;background:transparent;color:#2b68bc;text-align:left;font-weight:bold;white-space:nowrap}.footer{display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;border-top:1px solid #e6eaf0;padding-top:10px;font-size:12px;line-height:1.7;overflow-wrap:anywhere}.mobile .gallery{grid-template-columns:minmax(0,360px)}.mobile{padding:12px}.mobile .body{padding:12px}.mobile header{padding:16px 12px}.mobile header h2{font-size:19px}.mobile .markdown,.mobile .activity{font-size:14px}.mobile .link{font-size:13px}.mobile h1{font-size:21px}@media(max-width:760px){.gallery{grid-template-columns:minmax(0,600px)}}`;
const faithfulStyles = '.footer{border-top:0;padding-top:0}summary{cursor:pointer;color:#737982;font-size:14px}details .process{padding-top:12px}.link{min-height:24px;font-weight:normal}.column{border-radius:0}.columns .column:has(>.link){flex:0 0 auto}';
for (const mobile of [false, true]) {
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>运行卡片样例 · 本地结构模拟</title><style>${css}${faithfulStyles}</style><body class="${mobile ? 'mobile' : ''}"><h1>运行卡片 · 布局确认样例</h1><div class="notice">由产品渲染器的真实 Card 2.0 JSON 生成的本地模拟，不是飞书客户端截图。全部为演示数据，按钮不执行任何操作。</div><main class="gallery">${Object.entries(fixtures).map(([name, value]) => `<section><p class="caption">${name === 'running' ? '正常运行态' : name === 'action' ? '待操作态' : '完成态'}</p>${card(value)}</section>`).join('')}</main></body></html>`;
  await writeFile(join(out, mobile ? 'mobile.html' : 'desktop.html'), html);
}
console.log(JSON.stringify({ output: out, examples: Object.keys(fixtures), externalWrites: 0 }));
