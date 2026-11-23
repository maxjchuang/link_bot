import {describe,expect,it} from 'vitest';
import {LarkLongConnectionGateway} from '../../src/feishu/FeishuGateway.js';
import type {GroupLifecycleEvent} from '../../src/security/GroupServiceTypes.js';
import {normalizeGroupLifecycleEvent} from '../../src/feishu/GroupLifecycleEvent.js';

describe('audit-only lifecycle compatibility', () => {
  const event = {app_id:'app_test',event_type:'im.chat.member.bot.deleted_v1',event_id:'event_one',
    create_time:'1000',chat_id:'oc_test',operator_id:{open_id:'ou_owner'}};
  it('normalizes only matching application/type and requires platform event identity', () => {
    expect(normalizeGroupLifecycleEvent(event,'app_test','removed')).toEqual({kind:'removed',eventId:'event_one',occurredAt:1000,chatId:'oc_test',operatorUserId:'ou_owner'});
    expect(normalizeGroupLifecycleEvent({...event,app_id:'other'},'app_test','removed')).toBeUndefined();
    expect(normalizeGroupLifecycleEvent({...event,event_id:undefined},'app_test','removed')).toBeUndefined();
    expect(normalizeGroupLifecycleEvent({...event,create_time:'NaN'},'app_test','removed')).toBeUndefined();
  });
  it('observes both SDK lifecycle handlers without replacing the existing message handler', async () => {
    let handlers!: Record<string,(data:any)=>Promise<unknown>>;
    const observed: GroupLifecycleEvent[]=[];
    const gateway=new LarkLongConnectionGateway('app_test','not-real',{
      client:{request:async()=>({bot:{open_id:'ou_bot'}}),im:{v1:{message:{create:async()=>({})}}}},
      wsClient:{start:async()=>undefined},createEventDispatcher:()=>({register:value=>{handlers=value;return value;}}),
      logger:{error:()=>undefined},
    });
    await gateway.start(async()=>({text:''}),undefined,undefined,async value=>{observed.push(value);});
    expect(handlers['im.message.receive_v1']).toBeTypeOf('function');
    await handlers['im.chat.member.bot.deleted_v1'](event);
    await handlers['im.chat.member.bot.added_v1']({...event,event_id:'event_two',event_type:'im.chat.member.bot.added_v1'});
    expect(observed.map(value=>value.kind)).toEqual(['removed','added']);
    await handlers['im.chat.member.bot.added_v1']({...event,event_id:'wrong',event_type:'im.chat.member.bot.added_v1',app_id:'other'});
    expect(observed).toHaveLength(2);
  });
  it('handles official V2 envelopes through the real installed SDK dispatcher without a live socket', async () => {
    let dispatcher!: {invoke(data:unknown,options:{needCheck:boolean}):Promise<unknown>};
    const observed:GroupLifecycleEvent[]=[];
    const gateway=new LarkLongConnectionGateway('app_test','not-real',{
      client:{request:async()=>({bot:{open_id:'ou_bot'}}),im:{v1:{message:{create:async()=>({})}}}},
      wsClient:{start:async options=>{dispatcher=options.eventDispatcher as typeof dispatcher;}},
      logger:{error:()=>undefined},
    });
    await gateway.start(async()=>({text:''}),undefined,undefined,async value=>{observed.push(value);});
    await dispatcher.invoke({schema:'2.0',header:{app_id:'app_test',event_id:'sdk_remove',
      event_type:'im.chat.member.bot.deleted_v1',create_time:'1000'},event:{chat_id:'oc_test',operator_id:{open_id:'ou_owner'}}},{needCheck:false});
    expect(observed).toEqual([{kind:'removed',chatId:'oc_test',eventId:'sdk_remove',occurredAt:1000,operatorUserId:'ou_owner'}]);
  });
});
