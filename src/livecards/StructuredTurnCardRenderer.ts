import type { LiveTurnSnapshot } from '../projections/LiveTurnProjection.js';
import { cardConfig, detailEntrances, header, markdown, runtimeFooter, safeCardText, safeOperationLink, safePlainCardText, section } from './TaskCardLayout.js';
import { withTimelineTaskDetails } from './TimelineTaskCardLayout.js';
import type { InlineDetailsSnapshot } from '../details/InlineTurnDetails.js';

export function renderStructuredTurnCard(input: {
  label: string; cardRef?: string; elapsedMs: number; footer: string[]; snapshot?: LiveTurnSnapshot; nowMs?: number;
  inlineDetails?: InlineDetailsSnapshot;
}): Record<string, unknown> {
  const snapshot = input.snapshot, now = input.nowMs ?? Date.now();
  const running = !snapshot || ['running', 'waiting_approval'].includes(snapshot.phase);
  const pending = running ? (snapshot?.pendingActions ?? []).filter((action) => Date.parse(action.expiresAt) > now) : [];
  const actionable = pending.filter((action) => ['delivered', 'submission_failed'].includes(action.status) && action.messageId);
  const action = actionable[0] ?? pending[0];
  const needsAction = actionable.length > 0;
  const theme = needsAction ? 'yellow' : snapshot?.phase === 'failed' ? 'red' : snapshot?.phase === 'completed' ? 'green'
    : snapshot?.phase === 'interrupted' ? 'grey' : 'blue';
  const title = !running ? snapshot?.phase === 'completed' ? '已完成' : snapshot?.phase === 'failed' ? '执行失败' : '已中断'
    : needsAction ? `有 ${actionable.length} 项操作需要确认` : 'Codex 正在工作';
  const subtitle = !running ? '回合已结束，详情仍可按需查看' : needsAction ? `运行中 · ${actionable.length} 项待处理`
    : pending.some((item) => item.status === 'submitting') ? '运行中 · 正在提交操作，无需重复确认'
    : pending.length ? '运行中 · 正在准备操作请求，暂不需要你操作' : '正常运行 · 不需要你操作';
  const summary = snapshot?.summary;
  const activities = summary?.activities ?? [];
  const preview = snapshot?.processPreviews?.at(-1);
  const current = snapshot?.compacting ? '正在压缩上下文'
    : preview?.text.split('\n').find((line) => line.trim())
      ?? [...activities].reverse().find((item) => item.status === 'running')?.title ?? '正在准备任务，等待上游活动上报';
  const primary: Record<string, unknown>[] = [];
  if (action) {
    primary.push(markdown(`**${safeCardText(action.title ?? '待处理操作')}**`, 'app_server_progress'));
    const handler = /^ou_[\w-]+$/.test(action.handlerUserId)
      ? `<person id='${action.handlerUserId}' show_name=true show_avatar=false style='normal'></person>` : '原请求处理人';
    primary.push(markdown(`由 ${handler} 处理 · ${action.status === 'delivered' ? '操作卡已送达，尚未决定'
      : action.status === 'submission_failed' ? '回传失败，请由原处理人重试'
      : action.status === 'submitting' ? '决定已提交，正在回传' : action.status === 'preparation_failed' ? '操作卡投递失败，正在重试' : '操作卡尚未送达'}`));
    primary.push(section([markdown(`**影响**\n${safeCardText(action.impact || '请求影响尚未上报，请核对操作卡后决定。', 240)}`),
      markdown('<font color="grey">请求解除、过期或处理完成后，本提示会自动撤下。</font>')], 'yellow-50'));
    if (needsAction) {
      const link = safeOperationLink(action.messageAppLink);
      const behaviors = link ? [{ type: 'open_url', default_url: link }] : [];
      const disabled_tips = { tag: 'plain_text', content: '定位链接尚不可用，请在原会话的操作卡处理。' };
      primary.push({ tag: 'column_set', flex_mode: 'bisect', horizontal_spacing: '8px', columns: [
        { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'interactive_container', element_id: 'primary_action',
          width: 'fill', background_style: link ? 'orange-600' : 'grey-200', corner_radius: '8px', padding: '12px',
          disabled: !link, disabled_tips, behaviors, elements: [{ ...markdown(`**<font color='${link ? 'white' : 'grey'}'>${action.status === 'submission_failed' ? '去重试' : '去确认'}</font>**`), text_align: 'center' }] }] },
        { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'button', type: 'default', width: 'fill', size: 'large',
          text: { tag: 'plain_text', content: '查看请求详情' }, disabled: !link, disabled_tips, behaviors }] },
      ] });
      if (!link) primary.push(markdown('<font color="grey">操作卡已送达，但定位链接尚不可用；请在原会话找到操作卡处理。</font>'));
    }
    if (pending.length > 1) primary.push(markdown(`<font color='grey'>另有 ${pending.length - 1} 项请求，逐项处理后会自动更新。</font>`));
  } else {
    if (!input.inlineDetails) {
    primary.push(markdown(`**当前：${safeCardText(current, 100)}**`, 'app_server_progress'));
    primary.push(markdown(`<font color='grey'>最近完成：${safeCardText(summary?.recentResult ?? '暂无已上报的完成结果', 120)}</font>`));
    primary.push({ tag: 'hr' });
    if (activities.length) {
      for (const item of activities.slice(-3)) primary.push({ tag: 'div',
        icon: { tag: 'standard_icon', token: item.status === 'failed' ? 'warning_outlined' : item.status === 'running' ? 'time_outlined' : 'done_outlined',
          color: item.status === 'failed' ? 'red' : item.status === 'running' ? 'blue' : 'green' },
        text: { tag: 'plain_text', content: `${item.status === 'running' ? '进行中' : item.status === 'failed' ? '失败' : '已完成'} · ${safePlainCardText(item.title, 100)}`, lines: 2 } });
    } else primary.push(markdown('<font color="grey">工具动作尚未上报，可通过“查看过程”浏览公开进度。</font>'));
    }
  }
  if (snapshot?.error) primary.push(markdown(`**需关注：**${safeCardText(snapshot.error, 240)}`));
  const stats = summary
    ? `命令 ${summary.commands} 条 · 已完成 ${summary.completedCommands} 条 · 失败 ${summary.failedCommands} 条\n`
      + (summary.files === undefined ? '文件变更：未上报' : `变更 ${summary.files} 文件 · +${summary.added ?? 0} / −${summary.removed ?? 0}`)
      + (summary.incomplete ? ' · 统计可能不完整，以已留存记录为准' : '')
    : '命令统计：等待上报 · 文件变更：等待上报';
  const card = { schema: '2.0', config: cardConfig,
    header: header(title, subtitle, theme, needsAction ? 'warning_outlined' : 'done_outlined'),
    body: { direction: 'vertical', padding: '16px 20px 20px 20px', vertical_spacing: '12px', elements: [
      section(primary), section([markdown(`<font color='grey'>${safeCardText(input.label, 60)}</font>\n${stats}`)], 'grey-50', 'turn_stats'),
      ...(input.inlineDetails ? [] : detailEntrances(input.cardRef)), runtimeFooter(input.footer, !running),
    ] } };
  return input.inlineDetails ? withTimelineTaskDetails(card, input.inlineDetails, input.cardRef, { elapsedMs: input.elapsedMs }) : card;
}
