import type { ProjectConfig } from '../domain/types.js';
import type { RenderedFeishuMessage } from './FeishuMessageRenderer.js';
import type { PendingProjectRoutingRecord } from '../projects/ProjectRoutingTypes.js';

export function renderProjectRoutingCard(
  request: PendingProjectRoutingRecord,
  projects: ProjectConfig[],
): { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage } {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const candidates = request.candidates.slice(0, 3).flatMap((candidate) => {
    const project = byId.get(candidate.projectId);
    if (!project) return [];
    return [{ candidate, project }];
  });
  const base = { kind: 'project_routing_select', routingId: request.id, chatId: request.chatId,
    chatType: request.chatType, ...(request.topicId ? { topicId: request.topicId } : {}) };
  const elements: Array<Record<string, unknown>> = [
    { tag: 'markdown', content: `无法高置信度确定任务项目，请选择后自动继续原任务。\n\n**任务：** ${escapeMarkdown(request.text).slice(0, 500)}` },
  ];
  if (request.workspacePlan?.repositories.length) elements.push({ tag: 'markdown', content: [
    '**识别到的工作区计划（确认前不会创建工作区）：**',
    ...request.workspacePlan.repositories.map((item) => `- \`${item.projectId}\` ← \`${item.baseRef}\`${item.role === 'primary' ? '（主仓库）' : ''}`),
  ].join('\n') });
  for (const { candidate, project } of candidates) {
    elements.push(
      { tag: 'markdown', content: `**${project.name}**  ·  ${Math.round(candidate.confidence * 100)}%\n${project.description ?? project.id}\n${candidate.evidence.join('；') || '授权项目候选'}` },
      button(`选择 ${project.name}`, candidate === candidates[0]?.candidate ? 'primary' : 'default', { ...base, projectId: project.id }),
    );
  }
  elements.push({
    tag: 'form', name: 'project_routing_more_form', elements: [
      { tag: 'select_static', name: 'projectId', placeholder: { tag: 'plain_text', content: '查看更多授权项目' },
        options: (request.workspacePlan?.repositories.length
          ? projects.filter((project) => request.workspacePlan!.repositories.some((item) => item.role === 'primary' && item.projectId === project.id))
          : projects).map((project) => ({ text: { tag: 'plain_text', content: `${project.name} (${project.id})` }, value: project.id })) },
      { tag: 'button', name: 'confirm_project_routing', text: { tag: 'plain_text', content: request.workspacePlan ? '确认工作区计划并启动' : '使用所选项目' }, type: 'default',
        form_action_type: 'submit', behaviors: [{ type: 'callback', value: base }] },
    ],
  });
  elements.push(button('取消', 'default', { ...base, cancel: true }));
  return {
    preferred: { kind: 'card', payload: { schema: '2.0', header: { title: { tag: 'plain_text', content: '请选择任务项目' } }, body: { elements } } },
    fallback: { kind: 'text', text: `请选择任务项目：${candidates.map(({ project }) => `${project.id} (${project.name})`).join('、')}` },
  };
}

export function renderProjectRoutingResultCard(text: string): { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage } {
  return { preferred: { kind: 'card', payload: { schema: '2.0', header: { title: { tag: 'plain_text', content: '项目路由' } }, body: { elements: [{ tag: 'markdown', content: text }] } } }, fallback: { kind: 'text', text } };
}

export function renderProjectRoutingRetryCard(
  request: PendingProjectRoutingRecord,
  project: ProjectConfig,
  error: string,
): { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage } {
  const value = { kind: 'project_routing_select', routingId: request.id, projectId: project.id,
    chatId: request.chatId, chatType: request.chatType, ...(request.topicId ? { topicId: request.topicId } : {}) };
  const text = `启动 **${project.name}** 任务失败：${escapeMarkdown(error).slice(0, 800)}`;
  return {
    preferred: { kind: 'card', payload: { schema: '2.0', header: { title: { tag: 'plain_text', content: '项目路由失败' } }, body: { elements: [
      { tag: 'markdown', content: text }, button('重试原任务', 'primary', value),
    ] } } },
    fallback: { kind: 'text', text },
  };
}

function button(text: string, type: string, value: Record<string, unknown>): Record<string, unknown> {
  return { tag: 'button', text: { tag: 'plain_text', content: text }, type, behaviors: [{ type: 'callback', value }] };
}
function escapeMarkdown(value: string): string { return value.replace(/[<>]/g, ''); }
