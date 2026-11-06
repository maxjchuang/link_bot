import type { ChatType, SavedModelSelection } from '../domain/types.js';
import type { RenderedFeishuMessage } from './FeishuMessageRenderer.js';
import type { CodexModelInfo } from '../models/CodexModelCatalog.js';
import { formatDisplayTime } from '../output/DisplayTimeFormatter.js';

interface ModelSelectorSnapshot {
  model?: string;
  reasoningEffort?: string;
  serviceTier?: 'default' | 'fast';
}

export interface RenderModelSelectorCardInput {
  chatId: string;
  chatType: ChatType;
  topicId?: string;
  projectId?: string;
  current?: ModelSelectorSnapshot;
  saved?: SavedModelSelection;
  clientVersion?: string;
  fetchedAt?: string;
  models: CodexModelInfo[];
  fallbackText: string;
}

export function renderModelSelectorCard(
  input: RenderModelSelectorCardInput,
): { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage } {
  const selectedModel = selectModel(input.models, input.current?.model, input.saved?.model);
  const reasoningOptions = allReasoningOptions(input.models);
  const selectedReasoning = selectReasoning(selectedModel?.supportedReasoningLevels ?? [], [
    input.current?.reasoningEffort,
    input.saved?.reasoningEffort,
    selectedModel?.defaultReasoningLevel,
  ]);

  const summaryLines = [
    reasoningOptions.length > 0 ? 'Choose a Codex model and reasoning level.' : 'Choose a Codex model.',
  ];
  if (input.projectId) {
    summaryLines.push(`- **Project**: \`${input.projectId}\``);
  }
  if (input.current?.model) {
    summaryLines.push(`- **Current**: \`${input.current.model}\``);
  }
  if (input.current?.reasoningEffort) {
    summaryLines.push(`- **Current reasoning**: \`${input.current.reasoningEffort}\``);
  }
  summaryLines.push(`- **Current mode**: \`${input.current?.serviceTier === 'fast' ? 'Fast' : 'Standard'}\``);
  if (input.saved?.model) {
    summaryLines.push(`- **Saved default**: \`${input.saved.model}\``);
  }
  if (input.saved?.reasoningEffort) {
    summaryLines.push(`- **Saved reasoning**: \`${input.saved.reasoningEffort}\``);
  }
  if (input.clientVersion) {
    summaryLines.push(`- **Client**: \`${input.clientVersion}\``);
  }
  if (input.fetchedAt) {
    summaryLines.push(`- **模型目录更新时间**: \`${formatDisplayTime(input.fetchedAt)}\``);
  }

  const modelOptions = input.models.map((model) => ({
    text: {
      tag: 'plain_text',
      content: `${model.slug} (${model.displayName})`,
    },
    value: model.slug,
  }));
  const formElements: Array<Record<string, unknown>> = [
    {
      tag: 'select_static',
      name: 'model',
      placeholder: {
        tag: 'plain_text',
        content: 'Select model',
      },
      initial_option: selectedModel?.slug,
      options: modelOptions,
    },
  ];

  if (reasoningOptions.length > 0) {
    formElements.push({
      tag: 'select_static',
      name: 'reasoning',
      placeholder: {
        tag: 'plain_text',
        content: 'Select reasoning',
      },
      initial_option: selectedReasoning,
      options: reasoningOptions.map((level) => ({
        text: {
          tag: 'plain_text',
          content: level,
        },
        value: level,
      })),
    });
  }

  formElements.push({
    tag: 'select_static',
    name: 'serviceTier',
    placeholder: { tag: 'plain_text', content: 'Select mode' },
    initial_option: input.current?.serviceTier ?? 'default',
    options: [
      { text: { tag: 'plain_text', content: 'Standard' }, value: 'default' },
      { text: { tag: 'plain_text', content: 'Fast' }, value: 'fast' },
    ],
  });

  formElements.push({
    tag: 'button',
    name: 'confirm_model_select',
    text: {
      tag: 'plain_text',
      content: 'Apply model',
    },
    type: 'primary',
    form_action_type: 'submit',
    behaviors: [
      {
        type: 'callback',
        value: {
          kind: 'model_select',
          chatId: input.chatId,
          chatType: input.chatType,
          ...(input.topicId ? { topicId: input.topicId } : {}),
        },
      },
    ],
  });

  const payload = {
    schema: '2.0',
    header: {
      title: {
        tag: 'plain_text',
        content: 'Codex Model',
      },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: summaryLines.join('\n'),
        },
        {
          tag: 'form',
          name: 'model_select_form',
          elements: formElements,
        },
      ],
    },
  };

  return {
    preferred: { kind: 'card', payload },
    fallback: { kind: 'text', text: input.fallbackText },
  };
}

function selectModel(models: CodexModelInfo[], currentModel?: string, savedModel?: string): CodexModelInfo | undefined {
  return (
    models.find((model) => model.slug === currentModel) ??
    models.find((model) => model.slug === savedModel) ??
    models[0]
  );
}

function allReasoningOptions(models: CodexModelInfo[]): string[] {
  const options: string[] = [];
  for (const model of models) {
    for (const level of model.supportedReasoningLevels) {
      if (!options.includes(level)) {
        options.push(level);
      }
    }
  }
  return options;
}

function selectReasoning(options: string[], preferredValues: Array<string | undefined>): string | undefined {
  for (const value of preferredValues) {
    if (value && options.includes(value)) {
      return value;
    }
  }
  return options[0];
}
