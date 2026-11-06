import { describe, expect, it } from 'vitest';
import { renderStructuredTurnCard } from '../../src/livecards/StructuredTurnCardRenderer.js';

describe('structured App Server card', () => {
  const now = Date.parse('2026-10-16T00:00:00Z');
  const base = { label: 'repo', cardRef: 'a'.repeat(32), elapsedMs: 1000, nowMs: now, footer: [] };
  const snapshot = { taskId: 'task', phase: 'running' as const, commentary: '', commandOutput: '', fileChangeOutput: '',
    compacting: false, items: [], revision: 1 };
  it('restores the blue status header, independent summary/activity/stats/navigation/footer blocks', () => {
    const card = renderStructuredTurnCard({ ...base, snapshot: { ...snapshot,
      processPreviews: [{ itemId: 'progress', source: 'progress', text: '检查消息发送路径\nextra text' }],
      summary: { commands: 5, completedCommands: 4, failedCommands: 1, files: 3, added: 42, removed: 12,
        incomplete: false, recentResult: '命令完成，退出码 0', activities: [{ id: 'cmd', title: 'npm_test', status: 'running' }] } } }) as any;
    expect(card.header.template).toBe('blue'); expect(card.header.title.content).toBe('Codex 正在工作');
    expect(card.header.subtitle.content).toContain('不需要你操作');
    expect(card.body.elements).toHaveLength(4);
    expect(JSON.stringify(card)).toContain('当前：检查消息发送路径');
    expect(JSON.stringify(card)).toContain('变更 3 文件');
    const activity = card.body.elements[0].columns[0].elements.find((node: any) => node.tag === 'div');
    expect(activity.text.content).toContain('npm_test'); expect(activity.text.content).not.toContain('&#95;');
    const footerRows = card.body.elements.at(-1).columns[0].elements.filter((node: any) => node.tag === 'column_set');
    expect(footerRows).toHaveLength(3);
    expect(footerRows.flatMap((row: any) => row.columns.flatMap((column: any) => column.elements))).toHaveLength(6);
    for (const label of ['模型', '思考强度', '模式', '上下文', '任务累计', '已运行']) expect(JSON.stringify(footerRows)).toContain(label);
    expect(card.body.elements[2].columns.every((col: any) => col.elements[0].type === 'primary_text')).toBe(true);
  });
  it.each(['preparing', 'submitting', 'preparation_failed'] as const)('never offers approval before a usable request is delivered (%s)', (status) => {
    const card = renderStructuredTurnCard({ ...base, snapshot: { ...snapshot, pendingActions: [{ requestRef: 'ref', generation: 1,
      handlerUserId: 'ou_owner', expiresAt: new Date(now + 1000).toISOString(), status }] } }) as any;
    expect(card.header.template).toBe('blue'); expect(JSON.stringify(card)).not.toContain('去确认');
  });
  it('offers only navigation to a real delivered operation, never direct approval, and removes expired actions', () => {
    const request = { requestRef: 'ref', generation: 1, handlerUserId: 'ou_owner', messageId: 'om_real',
      messageAppLink: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_example&position=42',
      expiresAt: new Date(now + 1000).toISOString(), status: 'delivered' as const, title: '命令执行审批', impact: '运行受控操作' };
    const card = renderStructuredTurnCard({ ...base, snapshot: { ...snapshot, pendingActions: [request] } }) as any;
    const json = JSON.stringify(card);
    expect(card.header.template).toBe('yellow'); expect(json).toContain('去确认'); expect(json).toContain('person id=');
    expect(json).toContain('"type":"open_url"'); expect(json).not.toContain('app_server_request_decision');
    const expired = renderStructuredTurnCard({ ...base, nowMs: now + 2000, snapshot: { ...snapshot, pendingActions: [request] } }) as any;
    expect(expired.header.template).toBe('blue'); expect(JSON.stringify(expired)).not.toContain('去确认');
    const missing = renderStructuredTurnCard({ ...base, snapshot: { ...snapshot, pendingActions: [{ ...request, messageAppLink: 'https://evil.test/exfil' }] } });
    expect(JSON.stringify(missing)).toContain('定位链接尚不可用'); expect(JSON.stringify(missing)).not.toContain('evil.test');
  });
  it('keeps a distinct six-field footer and emits only opaque detail selectors', () => {
    const ref = 'a'.repeat(32);
    const card = renderStructuredTurnCard({ label: 'repo', cardRef: ref, elapsedMs: 15000,
      footer: ['模型：m', '思考强度：high', '模式：标准', '上下文：等待上报', '任务累计：等待上报', '已运行：15 秒'],
      snapshot: { taskId: 'task', phase: 'running', commentary: '', commandOutput: 'PRIVATE RAW OUTPUT', fileChangeOutput: '',
        compacting: false, items: [], revision: 1, processPreviews: [{ source: 'plan', itemId: 'item', text: 'plan' }] } });
    const text = JSON.stringify(card);
    expect(text).not.toContain('PRIVATE RAW OUTPUT');
    expect(text).toContain('app_server_footer');
    expect(text).toContain('turn_detail');
    expect(text).not.toContain('"taskId"');
    for (const category of ['process', 'commands', 'files']) expect(text).toContain(`"category":"${category}"`);
  });
});
