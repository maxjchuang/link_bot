import type { DestructiveCommandRequest } from '../domain/types.js';
import type { RenderedFeishuMessage } from './FeishuMessageRenderer.js';

export type DestructiveCommandCardView = 'pending' | 'executing' | 'cancelled' | 'failed';

export function renderDestructiveCommandCard(input: {
  request: DestructiveCommandRequest;
  view: DestructiveCommandCardView;
  failure?: string;
}): { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage } {
  const failure = input.failure?.slice(0, 500);
  const title = cardTitle(input.request.command, input.view);
  const summary = cardSummary(input.request, input.view, failure);
  const elements: Array<Record<string, unknown>> = [{ tag: 'markdown', content: summary }];
  if (input.view === 'pending') {
    elements.push({
      tag: 'column_set',
      horizontal_spacing: '8px',
      columns: [
        actionColumn(input.request, 'confirm', `Confirm ${input.request.command}`, 'primary'),
        actionColumn(input.request, 'cancel', 'Cancel', 'default'),
      ],
    });
  }

  const text = summary.replace(/\*\*/g, '');
  return {
    preferred: {
      kind: 'card',
      payload: {
        schema: '2.0',
        header: { title: { tag: 'plain_text', content: title } },
        body: { elements },
      },
    },
    fallback: { kind: 'text', text },
  };
}

function cardTitle(command: DestructiveCommandRequest['command'], view: DestructiveCommandCardView): string {
  if (view === 'pending') return `Confirm ${command}`;
  if (view === 'executing') return `Executing ${command}`;
  if (view === 'cancelled') return `${command} cancelled`;
  return `${command} failed`;
}

function cardSummary(
  request: DestructiveCommandRequest,
  view: DestructiveCommandCardView,
  failure?: string,
): string {
  if (view === 'pending') {
    return [`**Command**: \`/${request.command}\``, `**Expires**: ${request.expiresAt}`, '', 'Confirm this service operation?'].join('\n');
  }
  if (view === 'executing') return `Executing \`/${request.command}\`. The service may restart shortly.`;
  if (view === 'cancelled') return `Cancelled \`/${request.command}\`.`;
  return `\`/${request.command}\` failed${failure ? `: ${failure}` : '.'}`;
}

function actionColumn(
  request: DestructiveCommandRequest,
  decision: 'confirm' | 'cancel',
  label: string,
  type: 'primary' | 'default',
): Record<string, unknown> {
  return {
    tag: 'column',
    width: 'auto',
    elements: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: label },
        type,
        behaviors: [
          {
            type: 'callback',
            value: {
              kind: 'destructive_command_decision',
              chatId: request.chatId,
              chatType: 'private',
              requestId: request.id,
              decision,
            },
          },
        ],
      },
    ],
  };
}
