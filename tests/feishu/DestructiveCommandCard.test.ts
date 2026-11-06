import { describe, expect, it } from 'vitest';
import type { DestructiveCommandRequest } from '../../src/domain/types.js';
import { renderDestructiveCommandCard } from '../../src/feishu/DestructiveCommandCard.js';

const request: DestructiveCommandRequest = {
  id: 'dcr_1',
  sourceEventId: 'evt_1',
  userId: 'ou_1',
  chatId: 'oc_1',
  command: 'restart',
  status: 'pending',
  createdAt: '2026-07-13T02:00:00.000Z',
  expiresAt: '2026-07-13T02:10:00.000Z',
};

describe('renderDestructiveCommandCard', () => {
  it('renders confirm and cancel actions only for a pending request', () => {
    const pending = renderDestructiveCommandCard({ request, view: 'pending' });
    expect(pending.preferred.kind).toBe('card');
    expect(JSON.stringify(pending.preferred)).toContain('Confirm restart');
    expect(JSON.stringify(pending.preferred)).toContain('destructive_command_decision');
    expect(JSON.stringify(pending.preferred)).toContain('dcr_1');
    expect(JSON.stringify(pending.preferred)).toContain('confirm');
    expect(JSON.stringify(pending.preferred)).toContain('cancel');

    for (const view of ['executing', 'cancelled', 'failed'] as const) {
      const rendered = renderDestructiveCommandCard({
        request,
        view,
        failure: view === 'failed' ? 'build failed' : undefined,
      });
      expect(JSON.stringify(rendered.preferred)).not.toContain('destructive_command_decision');
    }
  });

  it('bounds failure text rendered in a terminal card', () => {
    const rendered = renderDestructiveCommandCard({ request, view: 'failed', failure: 'x'.repeat(600) });
    const payload = JSON.stringify(rendered.preferred);
    expect(payload).toContain('x'.repeat(500));
    expect(payload).not.toContain('x'.repeat(501));
  });
});
