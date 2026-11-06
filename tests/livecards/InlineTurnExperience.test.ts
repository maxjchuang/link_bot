import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTmpDir } from '../helpers/tmp.js';
import { FeishuAppServerTurnExperience } from '../../src/livecards/AppServerTurnExperience.js';
import { newAppServerCardRecord, SqliteAppServerTurnCardStore } from '../../src/livecards/AppServerTurnCardStore.js';
import { emptyInlineDetails } from '../../src/details/InlineTurnDetails.js';
import type { InlineCardRegion } from '../../src/livecards/InlineTaskCardLayout.js';
import { withInlineTaskDetails } from '../../src/livecards/InlineTaskCardLayout.js';
import { renderStructuredFinalCard } from '../../src/livecards/StructuredFinalCardRenderer.js';
import { section, markdown } from '../../src/livecards/TaskCardLayout.js';
import type { AppServerRequestRecord } from '../../src/approvals/AppServerRequestTypes.js';

afterEach(() => vi.useRealTimers());
describe('inline card update ownership', () => {
  it('passes the last acknowledged tree for structural updates and safely resyncs after an uncertain failure',async()=>{
    vi.useFakeTimers();
    const details=emptyInlineDetails('available');details.timeline={total:1,items:[{
      entryId:'b'.repeat(32),category:'commands',receivedAt:new Date().toISOString(),failed:false,
      title:'check',command:'check',commandStatus:'running',metadata:'',text:'first output',limited:false}]};
    let denied=false;
    const capture=vi.fn(async()=>denied?emptyInlineDetails('unavailable'):structuredClone(details));
    const regions=vi.fn(async(_input:{regions:Array<{elementId:string;element:Record<string,unknown>;previousElement?:Record<string,unknown>}>;sequence:number})=>undefined);
    const gateway={createCardKitEntity:vi.fn(async()=>({cardId:'card'})),sendCardKitEntityToTarget:vi.fn(async()=>({messageId:'message'})),
      updateCardKitElement:vi.fn(),updateCardKitRegions:regions,replaceCardKitEntity:vi.fn()};
    const experience=new FeishuAppServerTurnExperience(gateway,1000,()=>new Date(),undefined,'task_platform',undefined,
      {enabled:true,inlineEnabled:true,registerCard:()=> 'a'.repeat(32),readInline:capture});
    try{
      await experience.accepted({taskId:'task',turnId:'local',target:{chatId:'chat'}});
      await experience.event({type:'turn.started',taskId:'task',turnId:'remote',threadId:'thread'});
      await vi.advanceTimersByTimeAsync(1000);
      const first=regions.mock.calls.at(-1)![0].regions.find(region=>region.elementId==='turn_timeline')!;
      expect(first.previousElement).toBeUndefined();
      const old=structuredClone((first.element as any).elements[0]);
      details.timeline.items[0]!.text='second output';
      regions.mockRejectedValueOnce(new Error('timeout after possible remote mutation'));
      await vi.advanceTimersByTimeAsync(15000);
      const failed=regions.mock.calls.at(-1)![0];
      expect(failed.regions.find(region=>region.elementId==='timeline_content')!.previousElement).toEqual(old);
      denied=true;const reads=capture.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1000);
      const resync=regions.mock.calls.at(-1)![0];
      expect(resync.sequence).toBeGreaterThan(failed.sequence);
      expect(capture.mock.calls.length).toBeGreaterThan(reads);
      expect(resync.regions.find(region=>region.elementId==='timeline_content')!.previousElement).toBeUndefined();
      expect(JSON.stringify(resync)).not.toContain('output');
      expect(gateway.replaceCardKitEntity).not.toHaveBeenCalled();
    }finally{experience.dispose();}
  });
  it('replaces the initial thinking shell once, then appends records using only inner regions', async () => {
    vi.useFakeTimers();
    const details = emptyInlineDetails('available'); details.timeline = {total:0,items:[]};
    const capture = vi.fn(async()=>structuredClone(details));
    const gateway = {createCardKitEntity:vi.fn(),sendCardKitEntityToTarget:vi.fn(async()=>({messageId:'message'})),updateCardKitElement:vi.fn(),
      updateCardKitRegions:vi.fn(),replaceCardKitEntity:vi.fn()};
    gateway.createCardKitEntity.mockResolvedValue({cardId:'card'});
    const experience = new FeishuAppServerTurnExperience(gateway,1000,()=>new Date(),undefined,'task_platform',undefined,
      {enabled:true,inlineEnabled:true,registerCard:()=> 'a'.repeat(32),readInline:capture});
    try {
      await experience.accepted({taskId:'task',turnId:'local',target:{chatId:'chat'}});
      await experience.event({type:'turn.started',taskId:'task',turnId:'remote',threadId:'thread'});
      await vi.advanceTimersByTimeAsync(6000);
      details.timeline.items.push({entryId:'b'.repeat(32),category:'process',receivedAt:new Date().toISOString(),failed:false,
        title:'进展',metadata:'',text:'第二条公开进展',limited:false});details.timeline.total=1;
      await experience.event({type:'item.completed',taskId:'task',turnId:'remote',threadId:'thread',item:{type:'commandExecution',id:'command',command:'check',status:'completed',exitCode:0}});
      await vi.advanceTimersByTimeAsync(1000);
      const mutations = JSON.stringify(gateway.updateCardKitRegions.mock.calls);
      expect(mutations).toContain('第二条公开进展');
      expect(mutations).toContain('timeline_content');
      const shellUpdates=gateway.updateCardKitRegions.mock.calls.flatMap(([input]:any)=>input.regions).filter((region:any)=>region.elementId==='turn_timeline');
      expect(shellUpdates).toHaveLength(1);
      expect(shellUpdates[0].element.expanded).toBe(true);
      gateway.updateCardKitRegions.mockClear();
      details.timeline.items.push({...details.timeline.items[0]!,entryId:'c'.repeat(32),text:'third progress'});details.timeline.total++;
      await vi.advanceTimersByTimeAsync(15000);
      expect(JSON.stringify(gateway.updateCardKitRegions.mock.calls)).not.toMatch(/expanded|collapsible_panel|turn_timeline/);
      expect(gateway.replaceCardKitEntity).not.toHaveBeenCalled();
    } finally {experience.dispose();}
  });
  it.each([false,true])('uses actual card capacity instead of the result browser page size (overflow=%s)', async overflow => {
    const answer = 'ordinary '.repeat(overflow ? 5000 : 500) + '\nhttps://example.com/final-important-link'
      + '\n[文档](https://example.com/file_(stable)?view=detail)';
    const gateway = {createCardKitEntity:vi.fn(async()=>({cardId:'card'})),sendCardKitEntityToTarget:vi.fn(async()=>({messageId:'message'})),
      updateCardKitElement:vi.fn(),updateCardKitRegions:vi.fn(),replaceCardKitEntity:vi.fn()};
    const experience = new FeishuAppServerTurnExperience(gateway,1000,undefined,undefined,'task_platform',undefined,
      {enabled:true,inlineEnabled:true,registerCard:()=> 'a'.repeat(32),readInline:async()=>emptyInlineDetails('available'),
        saveResult:(_identity,text,endedAt)=>({text:Array.from(text).slice(0,2000).join(''),hasMore:text.length>2000,endedAt})});
    try {
      await experience.accepted({taskId:'task',turnId:'local',target:{chatId:'chat'}});
      await experience.event({type:'turn.started',taskId:'task',turnId:'remote',threadId:'thread'});
      await experience.event({type:'turn.completed',taskId:'task',turnId:'remote',threadId:'thread',status:'completed',turn:{items:[{type:'agentMessage',text:answer}]}});
      const card = gateway.replaceCardKitEntity.mock.calls[0]![0].card;
      const text = JSON.stringify(card);
      expect(text).toContain('https://example.com/final-important-link');
      expect(text).toContain('[文档](https://example.com/file_(stable)?view=detail)');
      expect(text).not.toContain('下一页');
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(24000);
      if (overflow) {expect(text).toContain('超出单张卡片容量');expect(text).toContain('"download":true');}
      else {expect(text).toContain(JSON.stringify(answer).slice(1,-1));expect(text).not.toContain('完整答复');}
    } finally {experience.dispose();}
  });
  it('updates confirmation states locally without replacing the running process panel', async () => {
    vi.useFakeTimers();
    const capture = vi.fn(async () => emptyInlineDetails('available'));
    const gateway = { createCardKitEntity: vi.fn(async () => ({ cardId: 'card' })),
      sendCardKitEntityToTarget: vi.fn(async () => ({ messageId: 'message' })), updateCardKitElement: vi.fn(),
      updateCardKitRegions: vi.fn(async () => undefined), replaceCardKitEntity: vi.fn(async () => undefined) };
    const experience = new FeishuAppServerTurnExperience(gateway, 1000, () => new Date(), undefined, 'task_platform', undefined,
      { enabled: true, inlineEnabled: true, registerCard: () => 'a'.repeat(32), readInline: capture });
    try {
      await experience.accepted({ taskId: 'task', turnId: 'local', target: { chatId: 'chat' } });
      await experience.event({ type: 'turn.started', taskId: 'task', turnId: 'remote', threadId: 'thread' });
      await vi.advanceTimersByTimeAsync(1000);
      const reads = capture.mock.calls.length;
      expect(gateway.replaceCardKitEntity).not.toHaveBeenCalled();
      const request: AppServerRequestRecord = { id: 'ref', kind: 'approval', ownerUserId: 'ou_owner', taskId: 'task',
        threadId: 'thread', turnId: 'remote', localTurnId: 'local', generation: 1, serverRequestId: 1,
        method: 'item/commandExecution/requestApproval', riskSummary: 'Run command', payload: {}, status: 'pending',
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
        operationCard: { status: 'sent', messageId: 'om_request', at: new Date().toISOString() } };
      await experience.requestChanged(request);
      await vi.advanceTimersByTimeAsync(1);
      expect(capture).toHaveBeenCalledTimes(reads);
      expect(gateway.replaceCardKitEntity).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(15000);
      expect(gateway.replaceCardKitEntity).not.toHaveBeenCalled();
      await experience.requestChanged({ ...request, status: 'delivered', deliveredAt: new Date().toISOString() });
      await vi.advanceTimersByTimeAsync(1);
      expect(gateway.replaceCardKitEntity).not.toHaveBeenCalled();
      const afterInitial = gateway.updateCardKitRegions.mock.calls.slice(1);
      expect(JSON.stringify(afterInitial)).not.toContain('expanded');
    } finally { experience.dispose(); }
  });
  it('replays a frozen pre-native-header final intent using its original seven regions', async () => {
    const store = new SqliteAppServerTurnCardStore(join(await createTmpDir(), 'state.sqlite'));
    const gateway = { createCardKitEntity: vi.fn(), sendCardKitEntityToTarget: vi.fn(), updateCardKitElement: vi.fn(),
      updateCardKitRegions: vi.fn(async (_input: { cardId: string; regions: InlineCardRegion[]; sequence: number; uuid: string }) => undefined), replaceCardKitEntity: vi.fn() };
    const card = withInlineTaskDetails(renderStructuredFinalCard({ label: 'old', phase: 'completed', answer: 'retained result', footer: [], hasMore: false }), emptyInlineDetails()) as any;
    delete card.header;
    card.body.elements.unshift(section([markdown('已完成')], 'green-50', 'turn_status'));
    const record = newAppServerCardRecord({ownerKind:'task_platform', taskId:'task', localTurnId:'old', target:{chatId:'chat'}, now:new Date().toISOString()});
    Object.assign(record, {structuredView:true, inlineDetails:true, state:'finalizing', cardId:'card', cardMessageId:'message', nextSequence:8,
      finalizationIntent:{card,sequence:7,uuid:'frozen-operation',terminalState:'finalized'}});
    store.save(record);
    const experience = new FeishuAppServerTurnExperience(gateway, 1000, undefined, store);
    try {
      await experience.recoverFinalizations('task_platform');
      expect(gateway.updateCardKitRegions).toHaveBeenCalledWith(expect.objectContaining({sequence:7,uuid:'frozen-operation',regions:expect.arrayContaining([expect.objectContaining({elementId:'turn_status'})])}));
      expect(gateway.updateCardKitRegions.mock.calls[0]![0].regions).toHaveLength(7);
      expect(gateway.replaceCardKitEntity).not.toHaveBeenCalled();
      expect(store.get(record.id)?.state).toBe('finalized');
    } finally { experience.dispose(); store.close(); }
  });
  it('updates only dirty inner regions during progress, then replaces the card to finalize its native header', async () => {
    vi.useFakeTimers();
    const store = new SqliteAppServerTurnCardStore(join(await createTmpDir(), 'state.sqlite'));
    const capture = vi.fn(async () => emptyInlineDetails('available')), flush = vi.fn(async () => undefined);
    const regions = vi.fn(async (_input: { cardId: string; regions: InlineCardRegion[]; sequence: number; uuid: string }) => undefined);
    const gateway = { createCardKitEntity: vi.fn(async (_card: Record<string, unknown>) => ({ cardId: 'card' })),
      sendCardKitEntityToTarget: vi.fn(async () => ({ messageId: 'message' })), updateCardKitElement: vi.fn(),
      updateCardKitRegions: regions, replaceCardKitEntity: vi.fn() };
    const experience = new FeishuAppServerTurnExperience(gateway, 1000, () => new Date(), store, 'task_platform', undefined,
      { enabled: true, inlineEnabled: true, registerCard: () => 'a'.repeat(32), readInline: capture, flush });
    try {
      await experience.accepted({ taskId: 'task', turnId: 'local', target: { chatId: 'chat' }, messageId: 'source', requesterUserId: 'owner' });
      expect(JSON.stringify(gateway.createCardKitEntity.mock.calls[0])).toContain('正在思考…');
      await experience.event({ type: 'turn.started', taskId: 'task', turnId: 'remote', threadId: 'thread' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(capture).toHaveBeenCalledOnce();
      expect(regions).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(15000); // Include the heartbeat's following zero-delay scheduling tick.
      expect(regions).toHaveBeenCalledTimes(2);
      expect(regions.mock.calls.at(-1)![0].regions.map((region) => region.elementId)).toEqual(['app_server_footer']);
      const count = regions.mock.calls.length;
      await experience.event({ type: 'turn.completed', taskId: 'task', turnId: 'remote', threadId: 'thread', status: 'completed',
        turn: { items: [{ type: 'agentMessage', text: 'Final important https://example.com/result' }] } });
      expect(regions.mock.calls.length).toBe(count); expect(flush).toHaveBeenCalledOnce();
      expect(JSON.stringify(regions.mock.calls.slice(1))).not.toContain('"expanded"');
      expect(gateway.replaceCardKitEntity).toHaveBeenCalledOnce();
      const final = gateway.replaceCardKitEntity.mock.calls[0]![0].card as any;
      expect(final.header).toBeUndefined();
      expect(final.body.elements[1]).toMatchObject({ element_id:'turn_timeline', expanded:false });
      expect(JSON.stringify(final)).not.toContain('app_server_footer');
      expect(JSON.stringify(gateway.replaceCardKitEntity.mock.calls)).toContain('https://example.com/result');
      expect(gateway.updateCardKitElement).not.toHaveBeenCalled();
      expect(store.get('app-server:task_platform:local')?.state).toBe('finalized');
    } finally { experience.dispose(); store.close(); }
  });
  it('replays exactly the persisted native-header final card after restart even when the new-turn feature flag is off', async () => {
    vi.useFakeTimers();
    const store = new SqliteAppServerTurnCardStore(join(await createTmpDir(), 'state.sqlite'));
    const regions = vi.fn(async (_input: { cardId: string; regions: InlineCardRegion[]; sequence: number; uuid: string }) => undefined);
    const gateway = { createCardKitEntity: vi.fn(async () => ({ cardId: 'card' })),
      sendCardKitEntityToTarget: vi.fn(async () => ({ messageId: 'message' })), updateCardKitElement: vi.fn(),
      updateCardKitRegions: regions, replaceCardKitEntity: vi.fn() };
    let experience = new FeishuAppServerTurnExperience(gateway, 1000, () => new Date(), store, 'task_platform', undefined,
      { enabled: true, inlineEnabled: true, registerCard: () => 'a'.repeat(32), readInline: async () => emptyInlineDetails('available') });
    try {
      await experience.accepted({ taskId: 'task', turnId: 'local', target: { chatId: 'chat' } });
      await experience.event({ type: 'turn.started', taskId: 'task', turnId: 'remote', threadId: 'thread' });
      gateway.replaceCardKitEntity.mockRejectedValueOnce(new Error('network unavailable'));
      await experience.event({ type: 'turn.completed', taskId: 'task', turnId: 'remote', threadId: 'thread', status: 'completed', turn: {} });
      const original = structuredClone(gateway.replaceCardKitEntity.mock.calls[0]);
      expect(store.get('app-server:task_platform:local')?.finalizationIntent).toBeDefined();
      experience.dispose(); vi.setSystemTime(Date.now() + 2000);
      const read = vi.fn(async () => { throw new Error('must not reauthorize/regenerate immutable delivery'); });
      experience = new FeishuAppServerTurnExperience(gateway, 1000, () => new Date(), store, 'task_platform', undefined,
        { enabled: true, inlineEnabled: false, registerCard: () => undefined, readInline: read });
      await experience.recoverFinalizations('task_platform');
      expect(gateway.replaceCardKitEntity.mock.calls.at(-1)).toEqual(original); expect(read).not.toHaveBeenCalled();
      expect(regions).not.toHaveBeenCalled();
      expect(store.get('app-server:task_platform:local')?.state).toBe('finalized');
    } finally { experience.dispose(); store.close(); }
  });
});
