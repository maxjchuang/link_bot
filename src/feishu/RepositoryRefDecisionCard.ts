import type { RenderedFeishuMessage } from './FeishuMessageRenderer.js';

export function renderRepositoryRefDecisionCard(input: {
  chatId: string; chatType: 'private'|'group'; projectId: string; targetRef: string; originalText: string;
}): { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage } {
  const base = { kind: 'repository_ref_decision', chatId: input.chatId, chatType: input.chatType,
    projectId: input.projectId, targetRef: input.targetRef, originalText: input.originalText.slice(0, 2000) };
  const text = `检测到要切换 \`${input.projectId}\` 到 \`${input.targetRef}\`，请选择本次操作的作用域。`;
  const button = (label: string, decision: 'inspect'|'migrate'|'cancel', type = 'default') => ({
    tag: 'button', type, text: { tag: 'plain_text', content: label },
    behaviors: [{ type: 'callback', value: { ...base, decision } }],
  });
  return {
    preferred: { kind: 'card', payload: { schema: '2.0', header: { title: { tag: 'plain_text', content: '选择分支使用方式' } }, body: { elements: [
      { tag: 'markdown', content: `${text}\n\n- **只读查看**：生成临时快照，不改变当前开发基线\n- **迁移基线**：将当前工作区持久迁移，后续修改基于该分支` },
      { tag: 'column_set', columns: [{ tag: 'column', width: 'auto', elements: [button('只读查看', 'inspect', 'primary')] },
        { tag: 'column', width: 'auto', elements: [button('迁移基线', 'migrate')] },
        { tag: 'column', width: 'auto', elements: [button('取消', 'cancel')] }] },
    ] } } },
    fallback: { kind: 'text', text: `${text} 请回复“只读查看”或“迁移基线”。` },
  };
}
