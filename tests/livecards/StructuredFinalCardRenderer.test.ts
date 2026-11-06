import { describe, expect, it } from 'vitest';
import { renderStructuredFinalCard } from '../../src/livecards/StructuredFinalCardRenderer.js';

describe('structured final card', () => {
  it.each(['completed', 'failed', 'interrupted'] as const)('preserves all detail entrances and frozen footer (%s)', (phase) => {
    const card = renderStructuredFinalCard({ label: 'task', cardRef: 'a'.repeat(32), phase, answer: 'complete answer',
      hasMore: true, footer: ['模型：m', '思考强度：high', '模式：标准', '上下文：未上报', '任务累计：123', '已运行：12 秒'] });
    const text = JSON.stringify(card);
    for (const value of ['complete answer', '完整答复', '过程记录', '命令与输出', '文件变更', 'app_server_footer']) expect(text).toContain(value);
    expect(text).toContain('"category":"result"');
    expect(text).not.toContain('等待你的确认');
  });
});
