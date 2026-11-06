import { describe, expect, it } from 'vitest';
import { renderModelSelectorCard } from '../../src/feishu/ModelSelectorCard.js';

describe('ModelSelectorCard', () => {
  it('renders Standard and Fast modes and preserves the current mode', () => {
    const rendered = renderModelSelectorCard({
      chatId: 'oc_1', chatType: 'group', projectId: 'repo',
      current: { model: 'gpt-5.6-sol', reasoningEffort: 'medium', serviceTier: 'fast' },
      models: [{
        slug: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: '',
        supportedReasoningLevels: ['low', 'medium', 'high'], defaultReasoningLevel: 'medium', priority: 1,
      }],
      fallbackText: 'fallback',
    });
    const payload = rendered.preferred.kind === 'card' ? JSON.stringify(rendered.preferred.payload) : '';
    expect(payload).toContain('serviceTier');
    expect(payload).toContain('Fast');
    expect(payload).toContain('Current mode');
  });

  it('formats the model catalog timestamp for human-readable display', () => {
    const rendered = renderModelSelectorCard({
      chatId: 'oc_1', chatType: 'private', fetchedAt: '2026-09-01T10:00:00.000Z',
      models: [{ slug: 'gpt-5.6-sol', displayName: 'Sol', priority: 1, supportedReasoningLevels: ['medium'] }],
      fallbackText: 'fallback',
    });
    const payload = rendered.preferred.kind === 'card' ? JSON.stringify(rendered.preferred.payload) : '';
    expect(payload).toContain('模型目录更新时间');
    expect(payload).toContain('2026-09-01 18:00:00 Asia/Shanghai');
    expect(payload).not.toContain('2026-09-01T10:00:00.000Z');
  });
});
