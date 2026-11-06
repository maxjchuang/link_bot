import type { AppServerRequestRecord } from '../approvals/AppServerRequestTypes.js';
import type { PendingAuthenticatedTurn } from '../auth/AuthTypes.js';
import type { ProjectKnowledgeRecord } from '../projects/ProjectKnowledgeService.js';
import type { RepositoryMigrationRecord } from '../tasks/TaskTypes.js';
import type { RenderedFeishuMessage } from './FeishuMessageRenderer.js';
import type { TaskActorContext } from './FeishuTaskController.js';

export function renderToolAuthorizationCard(
  pending: PendingAuthenticatedTurn,
  qrImageKey?: string,
): { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage } {
  const check = { kind: 'tool_auth_check', pendingId: pending.id, ...cardActor(pending) };
  const elements: Array<Record<string, unknown>> = [
    { tag: 'markdown', content: `当前任务需要使用 **${pending.provider}**。登录态只与您的飞书账号关联，不会共享给其他用户。` },
  ];
  if (qrImageKey) elements.push({ tag: 'img', img_key: qrImageKey, alt: { tag: 'plain_text', content: `${pending.provider} 授权二维码` } });
  elements.push(
    { tag: 'button', text: { tag: 'plain_text', content: '打开授权页面' }, type: 'primary',
      behaviors: [{ type: 'open_url', default_url: pending.authorizationUrl }] },
    decisionButton('我已授权', 'default', check),
    { tag: 'markdown', content: `授权请求将在 ${pending.expiresAt} 过期。` },
  );
  return {
    preferred: { kind: 'card', payload: {
      schema: '2.0',
      header: { title: { tag: 'plain_text', content: `授权 ${pending.provider}` } },
      body: { elements },
    } },
    fallback: { kind: 'text', text: `请打开链接完成 ${pending.provider} 授权：${pending.authorizationUrl}\n完成后点击卡片中的“我已授权”。` },
  };
}

export function renderToolAuthResumeFailureCard(
  pending: PendingAuthenticatedTurn,
  error: string,
): { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage } {
  const retry = { kind: 'tool_auth_check', pendingId: pending.id, ...cardActor(pending) };
  const detail = error.slice(0, 1_000);
  return {
    preferred: { kind: 'card', payload: {
      schema: '2.0',
      header: { title: { tag: 'plain_text', content: '授权完成，任务恢复失败' } },
      body: { elements: [
        { tag: 'markdown', content: `Lark CLI 授权已经完成，但原任务没有恢复成功。\n\n失败原因：${detail}` },
        decisionButton('重试原任务', 'primary', retry),
      ] },
    } },
    fallback: { kind: 'text', text: `授权已完成，但原任务恢复失败：${detail}。请重新发送原请求。` },
  };
}

export function renderProjectKnowledgeCard(
  knowledge: ProjectKnowledgeRecord,
  actor: Pick<TaskActorContext, 'chatId' | 'chatType' | 'topicId'>,
): { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage } {
  const base = { kind: 'project_knowledge_decision', knowledgeId: knowledge.id, ...cardActor(actor as TaskActorContext) };
  return {
    preferred: { kind: 'card', payload: {
      schema: '2.0', header: { title: { tag: 'plain_text', content: `Project knowledge: ${knowledge.title}` } },
      body: { elements: [
        { tag: 'markdown', content: `Project: **${knowledge.projectId}**\nKind: ${knowledge.kind}\n\n${knowledge.content}` },
        decisionButton('Approve', 'primary', { ...base, decision: 'approve' }),
        decisionButton('Reject', 'danger', { ...base, decision: 'reject' }),
      ] },
    } },
    fallback: { kind: 'text', text: `Project knowledge approval required: ${knowledge.id}\n${knowledge.content}` },
  };
}

export function renderTaskConfirmationCard(
  operation: 'publish' | 'delete',
  requestId: string,
  actor: TaskActorContext,
  detail?: { forceUpdate?: boolean; branchName?: string; previousHeadSha?: string; newHeadSha?: string },
): { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage } {
  const title = detail?.forceUpdate ? '批准强制更新非保护分支' : operation === 'publish' ? 'Publish task branch' : 'Delete task';
  const kind = operation === 'publish' ? 'task_publish_decision' : 'task_delete_decision';
  return {
    preferred: {
      kind: 'card',
      payload: {
        schema: '2.0', header: { title: { tag: 'plain_text', content: title } },
        body: { elements: [
          { tag: 'markdown', content: detail?.forceUpdate
            ? [`分支：\`${detail.branchName ?? 'unknown'}\``, `远端旧提交：\`${detail.previousHeadSha ?? 'unknown'}\``,
              `本地新提交：\`${detail.newHeadSha ?? 'unknown'}\``, '', '该操作会改写远端分支历史，执行前必须由任务用户明确批准。',
              `Request: \`${requestId}\``].join('\n')
            : `Request: \`${requestId}\`\nOnly the requesting owner can confirm.` },
          decisionButton('Confirm', 'primary', { kind, requestId, decision: 'confirm', ...cardActor(actor) }),
          decisionButton('Reject', 'default', { kind, requestId, decision: 'reject', ...cardActor(actor) }),
        ] },
      },
    },
    fallback: { kind: 'text', text: `${title} confirmation required: ${requestId}` },
  };
}

export function renderRepositoryMigrationConfirmationCard(
  migration: RepositoryMigrationRecord,
  actor: Pick<TaskActorContext, 'chatId' | 'chatType' | 'topicId'>,
): { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage } {
  const base = {
    kind: 'repository_migration_decision', migrationId: migration.id,
    ...cardActor(actor as TaskActorContext),
  };
  const detail = [
    `项目：**${migration.projectId}**`,
    `原基线：\`${migration.sourceBaseRef}\``,
    `目标基线：\`${migration.targetBaseRef}\``,
    `冲突副本：\`${migration.conflictPath ?? 'unknown'}\``,
    '',
    '原工作区尚未变更。请先在冲突副本中解决所有冲突并完成必要测试；确认后会用该副本替换原工作区。',
    `Migration：\`${migration.id}\``,
    '仅本次迁移的发起人可以确认或放弃。',
  ].join('\n');
  return {
    preferred: { kind: 'card', payload: {
      schema: '2.0', header: { title: { tag: 'plain_text', content: '仓库迁移冲突待确认' } },
      body: { elements: [
        { tag: 'markdown', content: detail },
        decisionButton('确认采用冲突副本', 'primary', { ...base, decision: 'confirm' }),
        decisionButton('放弃迁移', 'default', { ...base, decision: 'reject' }),
      ] },
    } },
    fallback: { kind: 'text', text: `仓库迁移 ${migration.id} 发生冲突。请在 ${migration.conflictPath ?? '冲突副本'} 解决后确认，或放弃迁移。` },
  };
}

export function renderDiskCleanupConfirmationCard(
  requestId: string,
  summary: string,
  actor: TaskActorContext,
): { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage } {
  const base = { kind: 'disk_cleanup_decision', requestId, ...cardActor(actor) };
  return {
    preferred: {
      kind: 'card',
      payload: {
        schema: '2.0', header: { title: { tag: 'plain_text', content: 'Confirm Docker task cleanup' } },
        body: { elements: [
          { tag: 'markdown', content: `${summary}\n\nRequest: \`${requestId}\`\nExpires in 10 minutes. Only the requesting administrator can confirm in this chat.` },
          decisionButton('Confirm cleanup', 'danger', { ...base, decision: 'confirm' }),
          decisionButton('Reject', 'default', { ...base, decision: 'reject' }),
        ] },
      },
    },
    fallback: { kind: 'text', text: `Docker task cleanup confirmation required: ${requestId}\n${summary}` },
  };
}

export function renderAppServerRequestCard(
  request: AppServerRequestRecord,
  context: string | { chatId: string; chatType: 'private' | 'group'; topicId?: string },
): { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage } {
  const actor = typeof context === 'string'
    ? { chatId: context, chatType: 'private' as const }
    : context;
  const baseValue = {
    kind: 'app_server_request_decision', chatId: actor.chatId, chatType: actor.chatType,
    ...(actor.topicId ? { topicId: actor.topicId } : {}),
    requestId: request.id, generation: request.generation,
  };
  const elements: Array<Record<string, unknown>> = [
    { tag: 'markdown', content: `**${request.kind === 'approval' ? 'Approval required' : 'Input required'}**\n${request.riskSummary}\nExpires: ${request.expiresAt}` },
  ];
  if (request.kind === 'approval') {
    elements.push(
      decisionButton('Allow', 'primary', { ...baseValue, decision: 'allow' }),
      decisionButton('Deny', 'danger', { ...baseValue, decision: 'deny' }),
    );
  } else {
    const questions = requestQuestions(request.payload);
    elements.push({
      tag: 'form', name: `request_${request.id}`,
      elements: [
        ...questions.map((question) => ({
          tag: 'input', name: question.id, label: { tag: 'plain_text', content: question.label },
          placeholder: { tag: 'plain_text', content: 'Enter an answer' },
        })),
        {
          tag: 'button', text: { tag: 'plain_text', content: 'Submit' }, type: 'primary', form_action_type: 'submit',
          behaviors: [{ type: 'callback', value: { ...baseValue, decision: 'answer', questionIds: questions.map((question) => question.id) } }],
        },
      ],
    });
  }
  return {
    preferred: { kind: 'card', payload: { schema: '2.0', body: { elements } } },
    fallback: { kind: 'text', text: `${request.riskSummary}\nRequest: ${request.id}\nExpires: ${request.expiresAt}` },
  };
}

function decisionButton(label: string, type: string, value: Record<string, unknown>): Record<string, unknown> {
  return {
    tag: 'button', text: { tag: 'plain_text', content: label }, type,
    behaviors: [{ type: 'callback', value }],
  };
}

function cardActor(actor: TaskActorContext): Record<string, unknown> {
  return { chatId: actor.chatId, chatType: actor.chatType, ...(actor.topicId ? { topicId: actor.topicId } : {}) };
}

function requestQuestions(payload: unknown): Array<{ id: string; label: string }> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const questions = (payload as Record<string, unknown>).questions;
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((question) => {
    if (!question || typeof question !== 'object' || Array.isArray(question)) return [];
    const record = question as Record<string, unknown>;
    if (typeof record.id !== 'string' || !record.id) return [];
    const label = typeof record.question === 'string' ? record.question
      : typeof record.header === 'string' ? record.header : record.id;
    return [{ id: record.id, label: label.slice(0, 200) }];
  });
}
