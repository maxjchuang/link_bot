import { advanceMarkdownFence, sanitizeUnresolvedSourceLinks, type MarkdownFence } from './SourceReferenceService.js';

export type BotMessage = {
  kind: 'reply' | 'completion' | 'error';
  bodyMarkdown: string;
  fallbackText: string;
  debug?: {
    sessionId?: string;
    projectId?: string;
    source?: string;
    reason?: string;
    chunkInfo?: string;
  };
};

export type RenderedFeishuMessage =
  | { kind: 'text'; text: string }
  | { kind: 'card'; payload: Record<string, unknown> };

export function renderFeishuMessage(
  message: BotMessage,
  options: { verbosity: 'normal' | 'debug' },
): { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage } {
  const body = normalizeMarkdown(message.bodyMarkdown);
  const elements = feishuMarkdownElements(body);

  if (options.verbosity === 'debug' && message.debug) {
    const debugLines = Object.entries(message.debug)
      .filter(([, value]) => value)
      .map(([key, value]) => `- **${key}**: \`${value}\``);

    if (debugLines.length > 0) {
      elements.push({
        tag: 'markdown',
        content: `---\n**Debug**\n${debugLines.join('\n')}`,
      });
    }
  }

  return {
    preferred: {
      kind: 'card',
      payload: {
        schema: '2.0',
        body: {
          elements,
        },
      },
    },
    fallback: {
      kind: 'text',
      text: sanitizeUnresolvedSourceLinks(message.fallbackText),
    },
  };
}

/** Shared client-compatibility handling for ordinary replies and live cards. */
export function feishuMarkdownElements(body: string): Array<Record<string, unknown>> {
  const leadingBold = /^(\*\*[^*\n]+?\*\*)(?=\S)/u.exec(body);
  return leadingBold
    ? [
      { tag: 'markdown', content: normalizeBoldSyntax(leadingBold[1]!) },
      { tag: 'markdown', content: normalizeBoldSyntax(body.slice(leadingBold[1]!.length)) },
    ]
    : [{ tag: 'markdown', content: normalizeBoldSyntax(body) }];
}

function normalizeMarkdown(markdown: string): string {
  return sanitizeUnresolvedSourceLinks(markdown.replace(/\r\n/g, '\n').trim());
}

function normalizeBoldSyntax(markdown: string): string {
  let fence: MarkdownFence | undefined;
  return markdown.split('\n').map((line) => {
    const nextFence = advanceMarkdownFence(line, fence);
    if (nextFence !== fence) {
      fence = nextFence;
      return line;
    }
    if (fence) return line;
    return line.split(/(`[^`\n]*`)/g).map((segment) => {
      if (segment.startsWith('`')) return segment;
      return segment.replace(/\*\*([^*\n]+?)\*\*/gu, (_full, inner: string, offset: number, source: string) => {
        const content = inner.trim();
        if (!content) return _full;
        const before = /^\s/.test(inner) || (offset > 0 && /[\p{L}\p{N}]/u.test(source[offset - 1]!)) ? ' ' : '';
        const end = offset + _full.length;
        const after = /\s$/.test(inner) || (end < source.length && /[\p{L}\p{N}]/u.test(source[end]!)) ? ' ' : '';
        return `${before}**${content}**${after}`;
      });
    }).join('');
  }).join('\n');
}
