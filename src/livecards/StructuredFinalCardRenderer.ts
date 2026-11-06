import { cardConfig, detailEntrances, header, markdown, runtimeFooter, safePlainCardText, section } from './TaskCardLayout.js';
import { withTimelineTaskDetails } from './TimelineTaskCardLayout.js';
import type { InlineDetailsSnapshot } from '../details/InlineTurnDetails.js';
import {feishuMarkdownElements} from '../feishu/FeishuMessageRenderer.js';

/** hasMore denotes actual card-capacity overflow, not a result-store browser page. */
export function renderStructuredFinalCard(input: {
  label: string; cardRef?: string; phase: 'completed' | 'failed' | 'interrupted';
  answer: string; hasMore: boolean; footer: string[]; elapsedMs?: number; finalAnswer?: string;
  inlineDetails?: InlineDetailsSnapshot;
}): Record<string, unknown> {
  const titles = { completed: '已完成', failed: '执行失败', interrupted: '已中断' };
  const elements: Record<string, unknown>[] = [
    ...(input.inlineDetails && input.phase !== 'completed' ? [markdown(input.phase === 'failed' ? '⚠️ 执行失败' : '⚠️ 已中断')] : []),
    section(feishuMarkdownElements(input.answer)),
  ];
  if (input.cardRef && /^[a-f0-9]{32}$/.test(input.cardRef)) {
    if (input.hasMore) elements.push(markdown('⚠️ 答复超出单张卡片容量，此处仅展示部分内容；完整内容请下载。'),
      { tag: 'button', type: 'primary_text',
      text: { tag: 'plain_text', content: '下载完整答复' },
      behaviors: [{ type: 'callback', value: { kind: 'turn_detail', cardRef: input.cardRef, category: 'result', download: true } }] });
  }
  elements.push(...(input.inlineDetails ? [] : detailEntrances(input.cardRef, true)), runtimeFooter(input.footer, true));
  const card = { schema: '2.0', config: cardConfig,
    header: header(titles[input.phase], safePlainCardText(input.label, 80), input.phase === 'completed' ? 'green' : input.phase === 'failed' ? 'red' : 'grey',
      input.phase === 'completed' ? 'done_outlined' : 'warning_outlined'),
    body: { direction: 'vertical', padding: '16px 20px 20px 20px', vertical_spacing: '12px', elements } };
  return input.inlineDetails ? withTimelineTaskDetails(card, input.inlineDetails, input.cardRef, { terminal: true, elapsedMs: input.elapsedMs, finalAnswer: input.finalAnswer ?? input.answer }) : card;
}
