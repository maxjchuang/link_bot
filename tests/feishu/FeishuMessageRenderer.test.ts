import { describe, expect, it } from 'vitest';
import { renderFeishuMessage } from '../../src/feishu/FeishuMessageRenderer.js';

describe('renderFeishuMessage', () => {
  it('renders a normal-mode completion as a markdown card without debug metadata', () => {
    const rendered = renderFeishuMessage(
      {
        kind: 'completion',
        bodyMarkdown: '最终答案\n\n- 第一项\n- 第二项',
        fallbackText: '最终答案\n\n- 第一项\n- 第二项',
      },
      { verbosity: 'normal' },
    );

    expect(rendered.preferred.kind).toBe('card');
    expect(rendered.fallback.kind).toBe('text');
    if (rendered.preferred.kind !== 'card') {
      throw new Error('expected a card payload');
    }
    expect(JSON.stringify(rendered.preferred.payload)).toContain('最终答案');
    expect(JSON.stringify(rendered.preferred.payload)).not.toContain('sessionId');
  });

  it('renders a debug-mode reply with an additional debug section', () => {
    const rendered = renderFeishuMessage(
      {
        kind: 'reply',
        bodyMarkdown: '已发送请求。',
        fallbackText: '已发送请求。',
        debug: { sessionId: 'sess_123', projectId: 'repo', source: 'observation' },
      },
      { verbosity: 'debug' },
    );

    expect(rendered.preferred.kind).toBe('card');
    if (rendered.preferred.kind !== 'card') {
      throw new Error('expected a card payload');
    }
    expect(JSON.stringify(rendered.preferred.payload)).toContain('sess_123');
    expect(JSON.stringify(rendered.preferred.payload)).toContain('observation');
  });

  it('normalizes markdown into a safe subset for card rendering', () => {
    const rendered = renderFeishuMessage(
      {
        kind: 'reply',
        bodyMarkdown: '```ts\nconst x = 1\n```',
        fallbackText: 'const x = 1',
      },
      { verbosity: 'normal' },
    );

    if (rendered.preferred.kind !== 'card') {
      throw new Error('expected a card payload');
    }
    expect(JSON.stringify(rendered.preferred.payload)).toContain('const x = 1');
  });

  it('never renders a task-container path as a clickable Feishu link', () => {
    const rendered = renderFeishuMessage({
      kind: 'completion',
      bodyMarkdown: '[通知代码](/workspace/projects/repo/a.go:210)',
      fallbackText: '[通知代码](/workspace/projects/repo/a.go:210)',
    }, { verbosity: 'normal' });
    expect(JSON.stringify(rendered)).not.toContain('](/workspace/');
    expect(JSON.stringify(rendered)).toContain('a.go:210');
    const bare = renderFeishuMessage({
      kind: 'reply', bodyMarkdown: 'http://workspace/projects/repo/a.go:210', fallbackText: '',
    }, { verbosity: 'normal' });
    expect(JSON.stringify(bare)).not.toContain('http://workspace/');
    const angled = renderFeishuMessage({
      kind: 'completion',
      bodyMarkdown: '[挂载前缀的构造](</workspace/example-api/infra/vefaas_sandbox/sandbox.go:1187>)',
      fallbackText: '[挂载前缀的构造](</workspace/example-api/infra/vefaas_sandbox/sandbox.go:1187>)',
    }, { verbosity: 'normal' });
    expect(JSON.stringify(angled)).not.toContain('](</workspace/');
    const titled = renderFeishuMessage({
      kind: 'completion', bodyMarkdown: '[源码](/workspace/repo/a.go:10 "source")',
      fallbackText: 'file:///workspace/repo/a.go:10',
    }, { verbosity: 'normal' });
    expect(JSON.stringify(titled)).not.toContain('](/workspace/');
    expect(JSON.stringify(titled)).not.toContain('file:///workspace/');
  });

  it('isolates leading bold text from adjacent body text in a Feishu card', () => {
    const rendered = renderFeishuMessage({
      kind: 'completion',
      bodyMarkdown: '**有这个可能性，而且你指出的是风险。**沙箱实例按 session 隔离。',
      fallbackText: '有这个可能性，而且你指出的是风险。沙箱实例按 session 隔离。',
    }, { verbosity: 'normal' });
    if (rendered.preferred.kind !== 'card') throw new Error('expected card');
    expect(rendered.preferred.payload).toMatchObject({
      body: { elements: [
        { tag: 'markdown', content: '**有这个可能性，而且你指出的是风险。**' },
        { tag: 'markdown', content: '沙箱实例按 session 隔离。' },
      ] },
    });
  });

  it('moves whitespace outside inline bold markers without changing code examples', () => {
    const rendered = renderFeishuMessage({
      kind: 'completion',
      bodyMarkdown: '两个**不同实例**，**没有记录 **`example-cli`** 实际读取的字符**。\n\n```md\n** keep literal **\n```',
      fallbackText: '两个不同实例，没有记录实际读取的字符。',
    }, { verbosity: 'normal' });
    if (rendered.preferred.kind !== 'card') throw new Error('expected card');
    expect(rendered.preferred.payload).toMatchObject({ body: { elements: [{
      content: '两个 **不同实例**，**没有记录** `example-cli` **实际读取的字符**。\n\n```md\n** keep literal **\n```',
    }] } });
  });

  it('does not normalize bold examples inside a mixed-marker code fence', () => {
    const rendered = renderFeishuMessage({
      kind: 'completion', bodyMarkdown: '```md\n~~~\n** keep literal **\n```\n正文**强调**', fallbackText: '',
    }, { verbosity: 'normal' });
    if (rendered.preferred.kind !== 'card') throw new Error('expected card');
    expect(rendered.preferred.payload).toMatchObject({ body: { elements: [{
      content: '```md\n~~~\n** keep literal **\n```\n正文 **强调**',
    }] } });
  });
});
