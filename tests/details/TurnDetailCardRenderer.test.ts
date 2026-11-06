import { describe, expect, it } from 'vitest';
import { renderTurnDetailCard } from '../../src/details/TurnDetailCardRenderer.js';
import type { DetailListEntry } from '../../src/details/TurnDetailService.js';

const action = { kind: 'turn_detail' as const, cardRef: 'a'.repeat(32), category: 'commands' as const };
const entry: DetailListEntry = { entryId: 'opaque', itemId: 'cmd', category: 'commands', receivedAt: '2026-10-18T03:46:00Z',
  metadata: { command: 'npm test', completed: true, exitCode: 1 }, preview: 'one failing test', previewHasMore: true };
function panels(card: ReturnType<typeof renderTurnDetailCard>) {
  return (card.body as any).elements[0].columns[0].elements;
}
describe('readable native detail cards', () => {
  it('shows command status and output inline without a directory-button round trip', () => {
    const card = renderTurnDetailCard(action, { entries: [entry, { ...entry, entryId: 'second' }] });
    const [first, second] = panels(card);
    expect(first.tag).toBe('collapsible_panel'); expect(first.expanded).toBe(true); expect(second.expanded).toBe(false);
    expect(first.header.title.content).toContain('退出码：1');
    expect(JSON.stringify(first)).toContain('one failing test');
    expect(JSON.stringify(first)).toContain('仅展示开头');
    expect(first.elements.at(-1).behaviors[0].value).toEqual({ ...action, itemRef: 'opaque' });
    expect(JSON.stringify(card)).toContain('主任务卡');
  });
  it('makes all process previews readable and preserves literal untrusted output inside a closed code fence', () => {
    const card = renderTurnDetailCard({ ...action, category: 'process' }, { entries: [{ ...entry, category: 'process',
      source: 'progress', metadata: {}, preview: '```\n<at id=all></at> [fake](https://example.com)\n```' }] });
    const panel = panels(card)[0];
    expect(panel.expanded).toBe(true);
    const text = panel.elements.find((element: any) => element.content?.startsWith('```')).content;
    expect(text.match(/```/g)).toHaveLength(2);
    expect(JSON.stringify(panel.elements.at(-1).behaviors)).not.toContain('example.com');
  });
  it('explains missing previews and keeps a bounded card under the platform message limit', () => {
    const card = renderTurnDetailCard(action, { entries: Array.from({ length: 8 }, (_, n) => ({ ...entry,
      entryId: String(n), preview: n ? '汉'.repeat(256) : undefined, previewMissing: !n })) }, true);
    expect(JSON.stringify(card)).toContain('正文尚未留存');
    expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThan(30000);
  });
});
