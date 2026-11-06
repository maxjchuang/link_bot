/** CardKit structural edits: never replace a surviving native fold or send its
 * expanded property. Only freshly inserted folds receive the default state. */
type Element = Record<string, any>;
export type TimelineRegionAction =
  | {action:'update_element';params:{element_id:string;element:Element}}
  | {action:'partial_update_element';params:{element_id:string;partial_element:Element}}
  | {action:'add_elements';params:{type:'append'|'insert_before';target_element_id:string;elements:Element[]}}
  | {action:'delete_elements';params:{element_ids:string[]}};

export function timelineRegionUpdates(before: Element, after: Element): TimelineRegionAction[] {
  const actions: TimelineRegionAction[] = [];
  const list = (oldRows: Element[], newRows: Element[], parent: string) => {
    const old = new Map(oldRows.map(row=>[row.element_id,row]));
    const nextIds = new Set(newRows.map(row=>row.element_id));
    // Existing rows are immutable in chronological order. If this invariant is
    // violated, fail instead of silently moving/replacing user-controlled folds.
    const retained = oldRows.filter(row=>nextIds.has(row.element_id)).map(row=>row.element_id);
    if (JSON.stringify(retained) !== JSON.stringify(newRows.filter(row=>old.has(row.element_id)).map(row=>row.element_id))) {
      throw new Error('timeline_order_changed');
    }
    const removed = oldRows.filter(row=>!nextIds.has(row.element_id)).map(row=>row.element_id);
    if (removed.length) actions.push({action:'delete_elements',params:{element_ids:removed}});
    for (let index=0;index<newRows.length;index++) {
      const row = newRows[index]!, previous = old.get(row.element_id);
      if (!row.element_id) throw new Error('timeline_element_id_missing');
      if (!previous) {
        const following = newRows.slice(index+1).find(candidate=>old.has(candidate.element_id));
        actions.push({action:'add_elements',params:{type:following?'insert_before':'append',
          target_element_id:following?.element_id ?? parent,elements:[row]}});
      } else if (row.tag === 'collapsible_panel' && previous.tag === row.tag) {
        if (JSON.stringify(row.header)!==JSON.stringify(previous.header)) actions.push({action:'partial_update_element',
          params:{element_id:row.element_id,partial_element:{header:row.header}}});
        list(previous.elements ?? [],row.elements ?? [],row.element_id);
      } else if (JSON.stringify(row)!==JSON.stringify(previous)) {
        actions.push({action:'update_element',params:{element_id:row.element_id,element:row}});
      }
    }
  };
  if (before.element_id!=='timeline_content' || after.element_id!=='timeline_content'
    || before.columns?.[0]?.element_id!=='timeline_items' || after.columns?.[0]?.element_id!=='timeline_items') {
    throw new Error('invalid_timeline_region');
  }
  list(before.columns[0].elements,after.columns[0].elements,'timeline_items');
  return actions;
}
