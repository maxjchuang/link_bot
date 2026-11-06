import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { InlineTurnDetailPublisher } from '../../src/details/InlineTurnDetails.js';
import { createTurnDetailRuntime } from '../../src/details/TurnDetailRuntime.js';
import { TurnDetailRecorder } from '../../src/details/TurnDetailRecorder.js';
import { createTmpDir } from '../helpers/tmp.js';

const identity = { ownerKind: 'host_manager' as const, taskId: 'task', localTurnId: 'turn' };
async function fixture(group = false, maxItems?: number) {
  const runtime = createTurnDetailRuntime(join(await createTmpDir(), 'state.sqlite'));
  runtime.store!.createTurn({ ...identity, schemaVersion: 1, threadId: 'thread', startedAt: new Date().toISOString(),
    scope: group ? { kind: 'shared_group_topic', chatId: 'chat', topicId: 'topic' } : { kind: 'private_user', chatId: 'chat', userId: 'owner' },
    lifecycle: 'running', availability: 'available', retainedBytes: 0, truncated: false });
  const recorder = new TurnDetailRecorder(runtime.store!, runtime.resources!);
  for (let n = 0; n < 7; n++) {
    recorder.record(identity, { kind: 'command_item', itemId: String(n), command: `command-${n}`, completed: true, exitCode: n ? 0 : 1,
      aggregatedOutput: '汉🙂'.repeat(400) }, `cmd-${n}`, new Date().toISOString());
  }
  const source = vi.fn(async () => ({ chatId: 'chat', chatType: group ? 'group' as const : 'private' as const, ...(group ? { topicId: 'topic' } : {}) }));
  const owner = vi.fn(async () => true), member = vi.fn(async () => true);
  const publisher = new InlineTurnDetailPublisher(runtime.store, runtime.resources,
    { verifySensitiveReplySource: owner, resolveDetailMessageScope: source, isDetailReaderMember: member }, undefined, runtime.audit, maxItems);
  const context = { target: { chatId: 'chat', ...(group ? { replyInThread: true, replyToMessageId: 'root' } : {}) },
    requesterUserId: 'owner', requestMessageId: 'source' };
  return { runtime, publisher, context, source, owner, member };
}
describe('current-conversation inline publication', () => {
  it.each([undefined,15,100])('uses the configured larger timeline window while preserving global order (max=%s)',async maxItems=>{
    const f=await fixture(false,maxItems);
    try{
      const recorder=new TurnDetailRecorder(f.runtime.store!,f.runtime.resources!);
      for(let i=0;i<60;i++)recorder.record(identity,{kind:'process_item',itemId:`progress-${i}`,completed:true,
        segments:[{source:'progress',text:`progress-${i}`}]},`progress-${i}`,new Date().toISOString());
      const value=await f.publisher.capture(identity,f.context),limit=maxItems??50;
      expect(value.timeline).toMatchObject({total:67,maxItems:limit});
      expect(value.timeline!.items).toHaveLength(Math.min(limit,67));
      expect(value.timeline!.items.at(-1)!.text).toBe('progress-59');
      if(limit===50)expect(value.timeline!.items[0]!.text).toBe('progress-10');
      if(limit===15)expect(value.timeline!.items[0]!.text).toBe('progress-45');
    }finally{f.runtime.close();}
  });
  it('uses recorded durations or paired timestamps, never receipt timestamps or guessed durations',async()=>{
    const f=await fixture();
    try{
      const recorder=new TurnDetailRecorder(f.runtime.store!,f.runtime.resources!);
      for(const [index,metadata] of [{durationMs:44000},{startedAtMs:1000,completedAtMs:4000},{durationMs:-1,startedAtMs:5000,completedAtMs:4000},{}].entries()){
        recorder.record(identity,{kind:'command_item',itemId:`timed-${index}`,command:`timed-${index}`,completed:true,exitCode:0,aggregatedOutput:'done',...metadata},`timed-${index}`,new Date().toISOString());
      }
      const value=await f.publisher.capture(identity,f.context);
      expect([0,1,2,3].map(i=>value.timeline!.items.find(item=>item.command===`timed-${i}`)!.durationMs)).toEqual([44000,3000,undefined,undefined]);
    }finally{f.runtime.close();}
  });
  it('includes bounded command/output bodies and the final-answer marker in the timeline', async () => {
    const f = await fixture();
    try {
      new TurnDetailRecorder(f.runtime.store!,f.runtime.resources!).record(identity,{kind:'process_item',itemId:'final',completed:true,
        finalAnswer:true,segments:[{source:'progress',text:'public final answer'}]},'final','2026-10-23T00:00:00Z');
      const value = await f.publisher.capture(identity,f.context);
      const command = value.timeline!.items.find(item=>item.category==='commands')!;
      expect(command.command).toBe('command-0');
      expect(command.commandStatus).toBe('failed');
      expect(value.timeline!.items.find(item=>item.command==='command-1')!.commandStatus).toBe('succeeded');
      expect(Buffer.byteLength(command.text)).toBeGreaterThan(768);
      expect(Buffer.byteLength(command.text)).toBeLessThanOrEqual(8192);
      expect(command.text).not.toContain('�');
      expect(value.timeline!.items.at(-1)).toMatchObject({finalAnswer:true,text:'public final answer'});
    } finally {f.runtime.close();}
  });
  it('keeps longer progress and file bodies for reading inside folds, with bounded UTF-8-safe previews',async()=>{
    const f=await fixture();
    try{
      const recorder=new TurnDetailRecorder(f.runtime.store!,f.runtime.resources!);
      recorder.record(identity,{kind:'process_item',itemId:'long-progress',completed:true,segments:[{source:'progress',text:'汉🙂\n'.repeat(2000)}]},'long-progress',new Date().toISOString());
      recorder.record(identity,{kind:'diff_snapshot',text:'diff --git a/test.ts b/test.ts\n--- a/test.ts\n+++ b/test.ts\n@@ -0,0 +1,2000 @@\n'+'+汉🙂\n'.repeat(2000)},'long-diff',new Date().toISOString());
      const value=await f.publisher.capture(identity,f.context);
      for(const category of ['process','files']){
        const record=value.timeline!.items.find(item=>item.category===category)!;
        expect(Buffer.byteLength(record.text)).toBeGreaterThan(768);
        expect(Buffer.byteLength(record.text)).toBeLessThanOrEqual(8192);
        expect(record.text).not.toContain('�');expect(record.limited).toBe(true);
      }
    }finally{f.runtime.close();}
  });
  it('reads one globally ordered mixed-category tail rather than merging category tails or sorting wall clocks', async () => {
    const f = await fixture();
    try {
      const recorder = new TurnDetailRecorder(f.runtime.store!, f.runtime.resources!);
      recorder.record(identity, {kind:'process_item', itemId:'progress',completed:true,segments:[{source:'progress',text:'public progress'}]}, 'progress', '2026-10-22T01:00:00Z');
      recorder.record(identity, {kind:'command_item',itemId:'later-command',completed:true,exitCode:1,command:'check-later',aggregatedOutput:'failed output'}, 'later', '2026-10-22T00:00:00Z');
      const snapshot = await f.publisher.capture(identity, f.context);
      expect(snapshot.timeline!.total).toBe(9);
      expect(snapshot.timeline!.items.slice(-2).map(i=>i.category)).toEqual(['process','commands']);
      expect(snapshot.timeline!.items.at(-1)).toMatchObject({title:'check-later',failed:true});
      expect(snapshot.timeline!.items.at(-2)!.text).toContain('public progress');
      expect(()=>f.runtime.store!.timelineTail(identity,101)).toThrow('invalid_limit');
    } finally { f.runtime.close(); }
  });
  it('fails closed before reading resources when publication auditing is unavailable', async () => {
    const f = await fixture(), read = vi.spyOn(f.runtime.resources!, 'readBytes');
    try {
      const publisher = new InlineTurnDetailPublisher(f.runtime.store, f.runtime.resources,
        { verifySensitiveReplySource: f.owner, resolveDetailMessageScope: f.source });
      expect((await publisher.capture(identity, f.context)).status).toBe('unavailable');
      expect(read).not.toHaveBeenCalled(); expect(f.owner).not.toHaveBeenCalled();
    } finally { f.runtime.close(); }
  });
  it('publishes only the latest five committed, UTF-8 bounded display copies with exact counts', async () => {
    const f = await fixture();
    try {
      const snapshot = await f.publisher.capture(identity, f.context);
      expect(snapshot.status).toBe('available');
      expect(snapshot.categories.commands.total).toBe(7);
      expect(snapshot.categories.commands.items.map((item) => item.title)).toEqual(['command-2', 'command-3', 'command-4', 'command-5', 'command-6']);
      for (const item of snapshot.categories.commands.items) {
        expect(item.text).not.toContain('�'); expect(Buffer.byteLength(item.text)).toBeLessThanOrEqual(768); expect(item.limited).toBe(true);
      }
      expect(f.owner).toHaveBeenCalledWith('source', 'chat', 'owner');
    } finally { f.runtime.close(); }
  });
  it('does not republish credential-file commands or their private output in original-card previews', async () => {
    const f = await fixture();
    try {
      new TurnDetailRecorder(f.runtime.store!, f.runtime.resources!).record(identity, { kind: 'command_item',
        itemId: 'private-operation', command: 'cat /codex/auth.json', completed: true, exitCode: 0,
        aggregatedOutput: '{"access_token":"fake-inline-secret"}' }, 'private-operation', new Date().toISOString());
      const snapshot = await f.publisher.capture(identity, f.context), text = JSON.stringify(snapshot);
      expect(snapshot.status).toBe('available'); expect(text).not.toContain('fake-inline-secret'); expect(text).not.toContain('/codex/auth.json');
    } finally { f.runtime.close(); }
  });
  it('refuses wrong owners, destinations, missing platform proof, and revocation during authorization before resource reads', async () => {
    const f = await fixture();
    const read = vi.spyOn(f.runtime.resources!, 'readBytes');
    try {
      expect((await f.publisher.capture(identity, { ...f.context, requesterUserId: 'other' })).status).toBe('unavailable');
      expect((await f.publisher.capture(identity, { ...f.context, target: { chatId: 'other' } })).status).toBe('unavailable');
      f.owner.mockResolvedValueOnce(false);
      expect((await f.publisher.capture(identity, f.context)).status).toBe('unavailable');
      const original = f.runtime.store!.getTurn(identity)!;
      vi.spyOn(f.runtime.store!, 'getTurn').mockReturnValueOnce(original).mockReturnValueOnce({ ...original, availability: 'cleared' });
      expect((await f.publisher.capture(identity, f.context)).status).toBe('expired');
      expect(read).not.toHaveBeenCalled();
    } finally { f.runtime.close(); }
  });
  it('checks both the source and actual destination topic and current membership', async () => {
    const f = await fixture(true), read = vi.spyOn(f.runtime.resources!, 'readBytes');
    try {
      f.source.mockResolvedValueOnce({ chatId: 'chat', chatType: 'group', topicId: 'topic' })
        .mockResolvedValueOnce({ chatId: 'chat', chatType: 'group', topicId: 'other' });
      expect((await f.publisher.capture(identity, f.context)).status).toBe('unavailable');
      f.member.mockResolvedValueOnce(false);
      expect((await f.publisher.capture(identity, f.context)).status).toBe('unavailable');
      expect(read).not.toHaveBeenCalled();
      expect((await f.publisher.capture(identity, f.context)).status).toBe('available');
    } finally { f.runtime.close(); }
  });
});
