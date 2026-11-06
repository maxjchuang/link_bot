import { describe, expect, it } from 'vitest';
import { emptyInlineDetails } from '../../src/details/InlineTurnDetails.js';
import { renderStructuredTurnCard } from '../../src/livecards/StructuredTurnCardRenderer.js';
import { renderStructuredFinalCard } from '../../src/livecards/StructuredFinalCardRenderer.js';
import { inlineCardRegions, withInlineTaskDetails } from '../../src/livecards/InlineTaskCardLayout.js';

const footer = ['模型：model', '思考强度：medium', '模式：标准', '上下文：38%', '任务累计：24k', '已运行：2分'];
const common = { label: 'private-project-name', cardRef: 'a'.repeat(32), footer };
function snapshot() {
  const value = emptyInlineDetails('available');
  value.timeline = { total: 3, items: (['process', 'commands', 'files'] as const).map((category, i) => ({
    category, entryId: String(i + 1).repeat(32), receivedAt: '2026-10-22T00:00:00Z', failed: false,
    title: `title-${category}`, metadata: '已完成', text: `body-${category}`, limited: false })) };
  return value;
}
describe('minimal timeline cards', () => {
  it.each([undefined,15,50,100])('honors the configured timeline cap instead of silently using 15 (max=%s)',maxItems=>{
    const details=snapshot(),seed=details.timeline!.items[0]!;
    details.timeline={total:60,...(maxItems!==undefined?{maxItems}:{}),items:Array.from({length:60},(_,i)=>({...seed,entryId:i.toString(16).padStart(32,'0'),text:`progress-${i}`}))};
    const card=renderStructuredTurnCard({...common,elapsedMs:0,inlineDetails:details}) as any;
    const rows=card.body.elements[1].elements[0].columns[0].elements.filter((r:any)=>r.content?.startsWith('progress-'));
    expect(rows).toHaveLength(Math.min(maxItems??50,60));
    expect(rows.at(-1).content).toBe('progress-59');
    expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThanOrEqual(24000);
  });
  it('shrinks a dense 100-command window to the component budget without changing the public answer',()=>{
    const details=snapshot(),seed=details.timeline!.items[1]!;
    details.timeline={total:100,maxItems:100,items:Array.from({length:100},(_,i)=>({...seed,entryId:i.toString(16).padStart(32,'0'),text:`output-${i}`,command:`command-${i}`}))};
    const card=renderStructuredFinalCard({...common,phase:'completed',answer:'Public https://example.com/result',hasMore:false,inlineDetails:details});
    const count=(v:any):number=>v&&typeof v==='object'?(Array.isArray(v)?v.reduce((n,x)=>n+count(x),0):(typeof v.tag==='string'?1:0)+Object.values(v).reduce<number>((n,x)=>n+count(x),0)):0;
    expect(count(card)).toBeLessThanOrEqual(180);
    expect(JSON.stringify(card)).toContain('Public https://example.com/result');
    expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThanOrEqual(24000);
  });
  it.each([false,true])('keeps limited progress inside the original process fold without a full-text button (terminal=%s)',terminal=>{
    const details=snapshot(),progress={...details.timeline!.items[0]!,text:'**公开进展**\n\n- 已完成核验',limited:true};
    details.timeline={total:1,items:[progress]};
    const card=(terminal?renderStructuredFinalCard({...common,phase:'completed',answer:'最终答复',hasMore:false,inlineDetails:details})
      :renderStructuredTurnCard({...common,elapsedMs:0,inlineDetails:details})) as any;
    const panel=card.body.elements[1];
    expect(panel).toMatchObject({tag:'collapsible_panel',element_id:'turn_timeline',expanded:!terminal});
    const text=JSON.stringify(panel);
    expect(text).toContain('**公开进展**');expect(text).toContain('此条进展仅展示预览');
    expect(text).not.toMatch(/查看这条进展全文|"tag":"button"|"itemRef"/);
  });
  it.each(['pending','available'] as const)('shows only a light thinking placeholder before the first record (%s)',status=>{
    const details=emptyInlineDetails(status);if(status==='available')details.timeline={total:0,items:[]};
    const card=renderStructuredTurnCard({...common,elapsedMs:0,inlineDetails:details}) as any;
    const shell=card.body.elements[1];
    expect(shell.tag).toBe('column_set');expect(shell.header).toBeUndefined();
    const text=JSON.stringify(shell);
    expect(text).toContain('正在思考…');
    expect(text).not.toMatch(/等待执行记录|暂无已留存记录|执行过程|standard_icon/);
    expect(inlineCardRegions(card).map(r=>r.elementId)).toEqual(['turn_primary','timeline_content','app_server_footer']);
  });
  it.each(['unavailable','expired'] as const)('does not mask lost access or expiration as normal thinking (%s)',status=>{
    const card=renderStructuredTurnCard({...common,elapsedMs:0,inlineDetails:emptyInlineDetails(status)}) as any;
    expect(card.body.elements[1].tag).toBe('collapsible_panel');
    expect(JSON.stringify(card.body.elements[1])).not.toContain('正在思考…');
    expect(JSON.stringify(card.body.elements[1])).toContain(status==='expired'?'已过期':'无法核验');
  });
  it('gives every actual fold an explicit rotating arrow and keeps all commands initially closed',()=>{
    const card=renderStructuredTurnCard({...common,elapsedMs:0,inlineDetails:snapshot()}) as any;
    const panels:any[]=[];
    const walk=(node:any)=>{if(node.tag==='collapsible_panel')panels.push(node);for(const children of [node.elements??[],node.columns??[]])children.forEach(walk);};
    card.body.elements.forEach(walk);
    expect(panels).toHaveLength(4);
    for(const panel of panels){
      expect(panel.header.icon).toEqual({tag:'standard_icon',token:'down-small-ccm_outlined',color:'grey',size:'16px 16px'});
      expect(panel.header.icon_expanded_angle).toBe(-180);
      if(panel.element_id!=='turn_timeline')expect(panel.expanded).toBe(false);
    }
  });
  it('uses compact gray command summaries with reliable duration and an inline result',()=>{
    const details=snapshot();Object.assign(details.timeline!.items[1]!,{command:'npm test',durationMs:44000,commandStatus:'succeeded'});
    const card=renderStructuredTurnCard({...common,elapsedMs:0,inlineDetails:details}) as any;
    const command=card.body.elements[1].elements[0].columns[0].elements[1].elements[0];
    expect(command.header.title.content).toContain("<font color='grey'>已运行 npm test · 44秒</font>");
    expect(command.header.title.content).not.toMatch(/第 \d+ 条/);
    const contents=command.elements;
    expect(contents[1].content).toBe('```\n$ npm test\n\nbody-commands\n```');
    expect(contents[2]).toMatchObject({content:"<font color='green'>✓ 成功</font>",text_align:'right'});
  });
  it('compacts footer row spacing without changing type size, column mapping or field count',()=>{
    const card=renderStructuredTurnCard({...common,elapsedMs:0,inlineDetails:snapshot()}) as any;
    const column=card.body.elements[2].columns[0];
    expect(column.vertical_spacing).toBe('4px');
    const rows=column.elements.filter((node:any)=>node.tag==='column_set');
    expect(rows).toHaveLength(3);
    expect(rows.map((row:any)=>row.columns.map((col:any)=>col.elements[0].content))).toEqual([
      ["<font color='grey'>模型：model</font>","<font color='grey'>思考强度：medium</font>"],
      ["<font color='grey'>模式：标准</font>","<font color='grey'>上下文：38%</font>"],
      ["<font color='grey'>任务累计：24k</font>","<font color='grey'>已运行：2分</font>"],
    ]);
    for(const row of rows)for(const col of row.columns)expect(col.elements[0].text_size).toBe('notation');
  });
  it('normalizes bold marker whitespace and adjacent Chinese text in answers and progress, but not code',()=>{
    const answer='**这个 LogID 对应的是 online 线上环境。 **我分别查询了线上和预发。\n\n```md\n** literal **\n```';
    const details=snapshot();details.timeline!.items[0]!.text=answer;
    const running=renderStructuredTurnCard({...common,elapsedMs:0,inlineDetails:details}) as any;
    const final=renderStructuredFinalCard({...common,phase:'completed',answer,hasMore:false,inlineDetails:details}) as any;
    const processRows=running.body.elements[1].elements[0].columns[0].elements;
    const answerRows=final.body.elements[0].columns[0].elements[0].columns[0].elements;
    for(const rows of [processRows,answerRows]){
      expect(rows[0].content).toBe('**这个 LogID 对应的是 online 线上环境。** ');
      expect(rows[1].content).toContain('我分别查询了线上和预发。');
      expect(rows[1].content).toContain('```md\n** literal **\n```');
    }
  });
  it('keeps an empty update anchor without a nested empty section or an automatic top gap', () => {
    const card = renderStructuredTurnCard({...common,elapsedMs:0,inlineDetails:snapshot()}) as any;
    expect(card.body.padding).toBe('16px 20px 20px 20px');
    expect(card.body.vertical_spacing).toBe('0px');
    expect(card.body.elements[0]).toMatchObject({element_id:'turn_primary',margin:'0px',columns:[{padding:'0px',elements:[]}]});
    expect(card.body.elements[2].margin).toBe('12px 0px 0px 0px');
    expect(inlineCardRegions(card).map(region=>region.elementId)).toEqual(['turn_primary','timeline_content','app_server_footer']);
  });
  it('adds a gap only while the primary region has content, then removes it without changing region IDs', () => {
    const render = (error?:string) => renderStructuredTurnCard({...common,elapsedMs:0,inlineDetails:snapshot(),snapshot:{
      taskId:'task',phase:'running',commentary:'',commandOutput:'',fileChangeOutput:'',items:[],compacting:false,revision:1,...(error?{error}:{})}}) as any;
    const before=render(),during=render('Actionable error'),after=render();
    expect(before.body.elements[0].margin).toBe('0px');
    expect(during.body.elements[0].margin).toBe('0px 0px 12px 0px');
    expect(JSON.stringify(during.body.elements[0])).toContain('Actionable error');
    expect(after.body.elements[0].columns[0].elements).toEqual([]);
    for(const card of [during,after]) expect(inlineCardRegions(card).map(region=>region.elementId)).toEqual(inlineCardRegions(before).map(region=>region.elementId));
  });
  it('uses green checks and red crosses for command results, never exit-code labels or false success', () => {
    const details=snapshot(),command=details.timeline!.items[1]!;
    details.timeline={total:4,items:(['succeeded','failed','running','unknown'] as const).map((commandStatus,index)=>({...command,
      entryId:index.toString(16).padStart(32,'0'),commandStatus,failed:commandStatus==='failed',metadata:'退出码：99'}))};
    const card=renderStructuredTurnCard({...common,elapsedMs:0,inlineDetails:details}) as any;
    const group=card.body.elements[1].elements[0].columns[0].elements[0];
    const states=group.elements.map((element:any)=>element.header.title.content);
    expect(states[0]).toContain("<font color='green'>✓</font>");
    expect(states[1]).toContain("<font color='red'>✗</font>");
    for (const state of states.slice(2)) expect(state).toContain("<font color='grey'>◷</font>");
    expect(JSON.stringify(card)).not.toContain('退出码');
    expect(JSON.stringify(group.elements)).toContain('执行中');
    expect(JSON.stringify(group.elements)).toContain('状态未上报');
  });
  it('groups file changes into a closed item with filenames and inline diffs', () => {
    const details=snapshot(),file=details.timeline!.items[2]!;
    details.timeline={total:2,items:[{...file,title:'first.ts',text:'+ first change'},{...file,entryId:'f'.repeat(32),title:'second.ts',text:'- second change'}]};
    const card=renderStructuredTurnCard({...common,elapsedMs:0,inlineDetails:details}) as any;
    const rows=card.body.elements[1].elements[0].columns[0].elements;
    expect(rows).toHaveLength(1);expect(rows[0].expanded).toBe(false);
    expect(rows[0].header.title.content).toBe('查看文件变更');
    for(const text of ['first.ts','second.ts','+ first change','- second change']) expect(JSON.stringify(rows[0].elements)).toContain(text);
    expect(JSON.stringify(rows[0].elements)).not.toContain('collapsible_panel');
  });
  it('groups consecutive commands into one closed item between public progress entries', () => {
    const details = snapshot(), process = details.timeline!.items[0]!, command = details.timeline!.items[1]!;
    const commands = Array.from({length:5},(_,index)=>({...command,entryId:(index+10).toString(16).padStart(32,'0'),
      command:`command-${index}`,text:`output-${index}`,failed:index===1,metadata:`退出码：${index===1?1:0}`}));
    details.timeline = {total:7,items:[process,...commands.slice(0,3),{...process,entryId:'f'.repeat(32),text:'next progress'},...commands.slice(3)]};
    const before = JSON.stringify(details);
    const card = renderStructuredTurnCard({...common,elapsedMs:0,inlineDetails:details}) as any;
    const rows = card.body.elements[1].elements[0].columns[0].elements;
    expect(rows.map((row:any)=>row.tag)).toEqual(['markdown','collapsible_panel','markdown','collapsible_panel']);
    const groups = rows.filter((row:any)=>row.tag==='collapsible_panel');
    for (const group of groups) {
      expect(group.expanded).toBe(false);
      expect(group.header.title.content).toContain('查看已运行命令');
      expect(group.elements.every((element:any)=>element.tag==='collapsible_panel' && element.expanded===false)).toBe(true);
      expect(group.elements.every((element:any)=>element.header.title.content.includes('command-'))).toBe(true);
      expect(JSON.stringify(group.elements)).not.toContain('查看输出');
    }
    const first = JSON.stringify(groups[0].elements), second = JSON.stringify(groups[1].elements);
    for(let index=0;index<3;index++){expect(first).toContain(`command-${index}`);expect(first).toContain(`output-${index}`);}
    for(let index=3;index<5;index++){expect(second).toContain(`command-${index}`);expect(second).toContain(`output-${index}`);}
    expect(groups[0].header.title.content).toContain('含失败操作');
    expect(first).not.toContain('退出码');
    expect(first).toContain("<font color='red'>✗</font>");
    expect(rows[2].content).toBe('next progress');
    expect(JSON.stringify(details)).toBe(before);
  });
  it('keeps a group identity when more adjacent commands arrive, and handles leading/trailing groups', () => {
    const details = snapshot(), command = details.timeline!.items[1]!;
    details.timeline = {total:1,items:[command]};
    const render = () => (renderStructuredTurnCard({...common,elapsedMs:0,inlineDetails:details}) as any).body.elements[1].elements[0].columns[0].elements;
    const first = render()[0];
    details.timeline.items.push({...command,entryId:'d'.repeat(32),text:'second output'});details.timeline.total++;
    const rows = render();
    expect(rows).toHaveLength(1);
    expect(rows[0].element_id).toBe(first.element_id);
    expect(rows[0].header.title.content).toBe('查看已运行命令');
    expect(JSON.stringify(rows[0].elements)).toContain('second output');
  });
  it('does not merge across a file change or move it out of timeline order', () => {
    const details = snapshot(), command = details.timeline!.items[1]!, file = details.timeline!.items[2]!;
    details.timeline = {total:3,items:[command,file,{...command,entryId:'e'.repeat(32)}]};
    const card = renderStructuredTurnCard({...common,elapsedMs:0,inlineDetails:details}) as any;
    const rows = card.body.elements[1].elements[0].columns[0].elements;
    expect(rows.map((row:any)=>row.tag)).toEqual(['collapsible_panel','collapsible_panel','collapsible_panel']);
    expect(rows[1].expanded).toBe(false);
    expect(rows[1].header.title.content).toBe('查看文件变更');
    expect(JSON.stringify(rows[1])).toContain('title-files');
    expect(rows[0].element_id).not.toBe(rows[2].element_id);
  });
  it('keeps grouped long command previews within budget without trimming the final answer', () => {
    const details = snapshot(), command = details.timeline!.items[1]!;
    details.timeline = {total:30,items:Array.from({length:15},(_,index)=>({...command,entryId:index.toString(16).padStart(32,'0'),
      command:`command-${index}`,text:'汉🙂'.repeat(1000),limited:true}))};
    details.categories.commands.total=30;
    const answer='Final https://example.com/important\n'+'汉🙂'.repeat(1000);
    const card = renderStructuredFinalCard({...common,phase:'completed',answer,hasMore:false,inlineDetails:details}) as any;
    expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThanOrEqual(24000);
    expect(JSON.stringify(card.body.elements[0])).toContain(JSON.stringify(answer).slice(1,-1));
    expect(JSON.stringify(card.body.elements[1])).toContain('长内容已截断');
    expect(JSON.stringify(card.body.elements[1])).toContain('查看已运行命令');
    expect(card.body.elements[1].expanded).toBe(false);
  });
  it('preserves process Markdown and line breaks without enabling raw mention tags', () => {
    const details = snapshot();
    details.timeline!.items[0]!.text = '**已定位问题**\n\n- 检查一\n- 检查二\n\n`example.ts`\n\n[报告](https://example.com/report)\n<at id=all></at>';
    const card = renderStructuredTurnCard({...common,elapsedMs:0,inlineDetails:details}) as any;
    const process = card.body.elements[1].elements[0].columns[0].elements[0];
    expect(process.tag).toBe('markdown');
    expect(process.content).toContain('**已定位问题**\n\n- 检查一\n- 检查二');
    expect(process.content).toContain('`example.ts`');
    expect(process.content).toContain('[报告](https://example.com/report)');
    expect(process.content).not.toContain('<at');
    expect(JSON.stringify(card.body.elements[0])).not.toContain('已定位问题');
  });
  it('shows command and output inline inside a default-closed command panel', () => {
    const details = snapshot();
    Object.assign(details.timeline!.items[1]!,{command:'echo `date`',text:'actual command output'});
    const card = renderStructuredTurnCard({...common,elapsedMs:0,inlineDetails:details}) as any;
    const command = card.body.elements[1].elements[0].columns[0].elements.find((e:any)=>e.element_id?.startsWith('cmd_'));
    expect(command.expanded).toBe(false);
    expect(JSON.stringify(command.header)).not.toContain('echo');
    const content = JSON.stringify(command.elements);
    expect(content).toContain('echo `date`');expect(content).toContain('actual command output');
    expect(content).toContain('Shell');expect(content).toContain('$ echo');
    expect(content).not.toContain('查看输出');expect(content).not.toContain('"type":"callback"');
  });
  it.each([false,true])('does not repeat the final answer in the process, without deleting the retained records (tagged=%s)', tagged => {
    const details = snapshot();
    const answer = '**最终结论**\n\n- 修改已完成\n- [链接](https://example.com/result)';
    details.timeline!.items.push({...details.timeline!.items[0]!,entryId:'f'.repeat(32),text:answer,...(tagged?{finalAnswer:true as const}:{})});
    details.timeline!.total++;
    const before = JSON.stringify(details);
    const card = renderStructuredFinalCard({...common,phase:'completed',answer,hasMore:false,inlineDetails:details}) as any;
    expect(card.body.elements[1].expanded).toBe(false);
    expect(JSON.stringify(card.body.elements[0])).toContain('最终结论');
    expect(JSON.stringify(card.body.elements[1])).not.toContain('最终结论');
    expect(JSON.stringify(card.body.elements[1])).toContain('body-process');
    expect(JSON.stringify(details)).toBe(before);
  });
  it('opens one process panel while running, with no title/project/statistics block and a six-field footer', () => {
    const card = renderStructuredTurnCard({ ...common, elapsedMs: 0, inlineDetails: snapshot() }) as any;
    expect(card.header).toBeUndefined();
    expect(JSON.stringify(card)).not.toContain('private-project-name');
    expect(card.body.elements.map((e: any) => e.element_id)).toEqual(['turn_primary', 'turn_timeline', 'app_server_footer']);
    expect(card.body.elements[1].expanded).toBe(true);
    expect(JSON.stringify(card).match(/"tag":"collapsible_panel"/g)).toHaveLength(4);
    expect(inlineCardRegions(card).map(r => r.elementId)).toEqual(['turn_primary', 'timeline_content', 'app_server_footer']);
    expect(JSON.stringify(inlineCardRegions(card))).not.toContain('"element_id":"turn_timeline"');
    expect(JSON.stringify(card.body.elements[0])).not.toContain('当前');
    for (const label of ['模型', '思考强度', '模式', '上下文', '任务累计', '已运行']) expect(JSON.stringify(card)).toContain(label);
    const content = JSON.stringify(card.body.elements[1]);
    expect(content.indexOf('body-process')).toBeLessThan(content.indexOf('title-commands'));
    expect(content.indexOf('title-commands')).toBeLessThan(content.indexOf('title-files'));
    const command = card.body.elements[1].elements[0].columns[0].elements.find((e:any)=>e.element_id?.startsWith('cmd_'));
    expect(command.expanded).toBe(false);
    expect(JSON.stringify(command.header)).not.toContain('title-commands');
    expect(JSON.stringify(command.elements)).toContain('title-commands');
    expect(JSON.stringify(command.elements)).toContain('body-commands');
    expect(JSON.stringify(command.elements)).toContain('```');
    expect(JSON.stringify(command.elements)).not.toContain('查看输出');
  });
  it.each(['completed', 'failed', 'interrupted'] as const)('collapses process below the answer and removes the terminal footer (%s)', phase => {
    const card = renderStructuredFinalCard({ ...common, phase, answer: 'answer https://example.com/important', hasMore: false,
      inlineDetails: snapshot(), elapsedMs: 1900000 }) as any;
    expect(card.header).toBeUndefined();
    expect(card.body.elements.map((e: any) => e.element_id)).toEqual(['turn_primary', 'turn_timeline']);
    expect(JSON.stringify(card.body.elements[0])).toContain('https://example.com/important');
    const panel = card.body.elements[1];
    expect(panel.expanded).toBe(false);
    expect(panel.header.title.content).toBe('用时 31分40秒 · 查看执行过程');
    expect(JSON.stringify(card)).not.toMatch(/app_server_footer|turn_stats|回合已结束|下一页|完整答复/);
    if (phase !== 'completed') expect(JSON.stringify(card.body.elements[0])).toContain(phase === 'failed' ? '执行失败' : '已中断');
  });
  it('keeps confirmation actions and their important link outside the process panel without replacing it', () => {
    const card = renderStructuredTurnCard({ ...common, elapsedMs: 0, nowMs: 0, inlineDetails: snapshot(),
      snapshot: { taskId: 'task', phase: 'running', commentary: '', commandOutput: '', fileChangeOutput: '', items: [], compacting: false, revision: 1,
        pendingActions: [{ requestRef: 'ref', generation: 1, handlerUserId: 'ou_owner', status: 'delivered', messageId: 'om_request',
          expiresAt: new Date(60000).toISOString(), messageAppLink: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_example&position=42' }] } }) as any;
    expect(JSON.stringify(card.body.elements[0])).toContain('position=42');
    expect(card.body.elements[0].margin).toBe('0px 0px 12px 0px');
    expect(JSON.stringify(card.body.elements[1])).not.toContain('position=42');
    expect(JSON.stringify(inlineCardRegions(card))).not.toContain('"element_id":"turn_timeline"');
  });
  it('shrinks process previews without trimming the answer or adding generic top-level warnings', () => {
    const details = snapshot(); details.incomplete = true;
    details.timeline = { total: 100, items: Array.from({length:15},(_, i) => ({ ...details.timeline!.items[0]!, entryId:i.toString(16).padStart(32,'0'),
      text:'汉🙂'.repeat(1000), failed:i===0 })) };
    details.categories.process.total = 100;
    const answer = 'Important answer https://example.com/keep-this\n' + '汉🙂'.repeat(1000);
    const card = renderStructuredFinalCard({ ...common, phase:'completed', answer, hasMore:false, inlineDetails:details }) as any;
    expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThanOrEqual(24000);
    expect(JSON.stringify(card)).toContain(JSON.stringify(answer).slice(1,-1));
    expect(JSON.stringify(card)).not.toContain('执行记录可能不完整');
    expect(JSON.stringify(card)).not.toContain('过程含失败操作');
    expect(details.incomplete).toBe(true);
    expect(JSON.stringify(card)).toContain('／100');
    expect(JSON.stringify(card)).not.toContain('"download":true');
    expect(JSON.stringify(card)).not.toContain('查看这条进展全文');
    for (const label of ['下载公开进展','下载命令记录','下载文件变更']) expect(JSON.stringify(card)).not.toContain(label);
  });
  it('removes only generic banners, preserving real task errors and command failures', () => {
    const details = snapshot();details.incomplete=true;
    Object.assign(details.timeline!.items[1]!,{failed:true,metadata:'已结束 · 退出码：1'});
    const card=renderStructuredFinalCard({...common,phase:'failed',answer:'具体任务失败原因',hasMore:false,inlineDetails:details}) as any;
    const text=JSON.stringify(card);
    expect(text).not.toContain('执行记录可能不完整');expect(text).not.toContain('过程含失败操作');
    expect(JSON.stringify(card.body.elements[0])).toContain('执行失败');
    expect(JSON.stringify(card.body.elements[0])).toContain('具体任务失败原因');
    expect(text).toContain('查看已运行命令（含失败操作）');expect(text).not.toContain('退出码');
    expect(text).toContain("<font color='red'>✗</font>");
    expect(details.incomplete).toBe(true);expect(details.timeline!.items[1]!.failed).toBe(true);
  });
  it('keeps the rollout-off layout and legacy region extraction available', () => {
    const card = renderStructuredTurnCard({ ...common, elapsedMs:0 });
    expect(JSON.stringify(card)).not.toContain('turn_timeline');
    expect(JSON.stringify(card)).toContain('detail_nav');
    const legacy = withInlineTaskDetails(card, emptyInlineDetails());
    expect(inlineCardRegions(legacy)).toHaveLength(6);
  });
});
