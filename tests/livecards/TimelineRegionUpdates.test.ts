import {describe,it,expect} from 'vitest';
import {emptyInlineDetails, type InlineTimelineItem} from '../../src/details/InlineTurnDetails.js';
import {renderStructuredTurnCard} from '../../src/livecards/StructuredTurnCardRenderer.js';
import {inlineCardRegions} from '../../src/livecards/InlineTaskCardLayout.js';
import {timelineRegionUpdates, type TimelineRegionAction} from '../../src/livecards/TimelineRegionUpdates.js';

const item=(id:number,category:InlineTimelineItem['category']='commands'):InlineTimelineItem=>({
  entryId:id.toString(16).padStart(32,'0'),category,receivedAt:'2026-10-23T00:00:00Z',failed:false,
  command:`command-${id}`,commandStatus:'running',title:'tool',metadata:'',text:`output-${id}`,limited:false,
});
function region(items:InlineTimelineItem[],status:'available'|'unavailable'='available'):any {
  const details=emptyInlineDetails(status);details.timeline={total:items.length,items};
  const card=renderStructuredTurnCard({label:'test',elapsedMs:0,footer:[],inlineDetails:details});
  return inlineCardRegions(card).find(r=>r.elementId==='timeline_content')!.element;
}
function find(root:any,id:string):any {
  if(root.element_id===id)return root;
  for(const child of [...(root.elements??[]),...(root.columns??[])]) {const result=find(child,id);if(result)return result;}
}
/** Models local client state on native panels: replacing a panel would lose it. */
function apply(root:any,actions:TimelineRegionAction[]):void {
  function childrenWith(id:string,node=root):any[]|undefined {
    for(const children of [node.elements??[],node.columns??[]]) {
      if(children.some((child:any)=>child.element_id===id)) return children;
      for(const child of children){const result=childrenWith(id,child);if(result)return result;}
    }
  }
  for(const {action,params} of actions) {
    if(action==='partial_update_element')Object.assign(find(root,params.element_id),structuredClone(params.partial_element));
    else if(action==='update_element') {
      const siblings=childrenWith(params.element_id)!;
      siblings.splice(siblings.findIndex(child=>child.element_id===params.element_id),1,structuredClone(params.element));
    } else if(action==='delete_elements')for(const id of params.element_ids){const siblings=childrenWith(id)!;siblings.splice(siblings.findIndex(child=>child.element_id===id),1);}
    else if(action==='add_elements') {
      if(params.type==='append')find(root,params.target_element_id).elements.push(...structuredClone(params.elements));
      else {const siblings=childrenWith(params.target_element_id)!;siblings.splice(siblings.findIndex(child=>child.element_id===params.target_element_id),0,...structuredClone(params.elements));}
    }
  }
}
describe('state-preserving timeline edits',()=>{
  it('preserves both open panels when command status/output, new commands and progress arrive',()=>{
    const first=item(1),before=region([first]);
    const group=before.columns[0].elements[0],command=group.elements[0];
    const client=structuredClone(before);
    find(client,group.element_id).expanded=true;find(client,command.element_id).expanded=true;
    const after=region([{...first,commandStatus:'succeeded',text:'new output'},item(2),item(3,'process'),item(4)]);
    const actions=timelineRegionUpdates(before,after);
    expect(actions.some(a=>a.action==='partial_update_element')).toBe(true);
    expect(actions.filter(a=>a.action!=='add_elements').map(a=>JSON.stringify(a)).join('')).not.toContain('"expanded"');
    apply(client,actions);
    expect(find(client,group.element_id).expanded).toBe(true);
    expect(find(client,command.element_id).expanded).toBe(true);
    const newCommand=after.columns[0].elements[0].elements[1];
    expect(find(client,newCommand.element_id).expanded).toBe(false);
    expect(JSON.stringify(client)).toContain('new output');
    find(client,group.element_id).expanded=false;find(client,command.element_id).expanded=false;
    expect(client).toEqual(after);
  });
  it('retains unaffected folds when older records leave the window and clears all bodies on lost scope',()=>{
    const before=region([item(1),item(2,'process'),item(3)]),after=region([item(2,'process'),item(3),item(4)]);
    const client=structuredClone(before),group=before.columns[0].elements[2];
    find(client,group.element_id).expanded=true;
    apply(client,timelineRegionUpdates(before,after));
    expect(find(client,group.element_id).expanded).toBe(true);
    find(client,group.element_id).expanded=false;expect(client).toEqual(after);
    const denied=region([],'unavailable');apply(client,timelineRegionUpdates(after,denied));
    expect(client).toEqual(denied);expect(JSON.stringify(client)).not.toContain('command-');
  });
  it('handles preview shrink/expansion without replacing surviving command panels',()=>{
    const first=item(1),before=region([first]),after=region([{...first,limited:true,text:'a'.repeat(6000)}]);
    const group=before.columns[0].elements[0],command=group.elements[0],client=structuredClone(before);
    find(client,command.element_id).expanded=true;
    apply(client,timelineRegionUpdates(before,after));
    expect(find(client,command.element_id).expanded).toBe(true);
    apply(client,timelineRegionUpdates(after,before));
    find(client,command.element_id).expanded=false;expect(client).toEqual(before);
  });
  it('rejects unknown anchors and reordered retained siblings',()=>{
    expect(()=>timelineRegionUpdates({},region([]))).toThrow('invalid_timeline_region');
    const before=region([item(1,'process'),item(2,'process')]),after=region([item(2,'process'),item(1,'process')]);
    expect(()=>timelineRegionUpdates(before,after)).toThrow('timeline_order_changed');
  });
});
