import { describe,expect,it } from 'vitest';
import { parseCardActionValue } from '../../src/feishu/FeishuCardActions.js';

describe('task platform card actions', () => {
  it('allows only a boolean download selector with no paths, source or paging parameters', () => {
    const action = { kind: 'turn_detail', cardRef: 'a'.repeat(32), category: 'files', download: true };
    expect(parseCardActionValue(action)).toMatchObject({ action });
    for (const extra of [{ path: '/private/auth' }, { download: 'true' }, { cursorRef: 'b'.repeat(32) }, { itemRef: 'c'.repeat(32) }]) {
      expect(parseCardActionValue({ ...action, ...extra })).toBeUndefined();
    }
  });
  it('accepts result pagination selectors but rejects item and caller-supplied page positions', () => {
    const action = { kind: 'turn_detail', cardRef: 'a'.repeat(32), category: 'result', cursorRef: 'b'.repeat(32) };
    expect(parseCardActionValue(action)).toMatchObject({ action });
    expect(parseCardActionValue({ ...action, itemRef: 'c'.repeat(32) })).toBeUndefined();
    expect(parseCardActionValue({ ...action, offset: 2000 })).toBeUndefined();
    expect(parseCardActionValue({ ...action, chatId: 'other' })).toBeUndefined();
  });
  it('accepts only opaque selectors for readonly detail callbacks, without trusting conversation fields', () => {
    const ref = 'a'.repeat(32);
    expect(parseCardActionValue({ kind: 'turn_detail', cardRef: ref, category: 'commands' })).toMatchObject({ action: { kind: 'turn_detail', cardRef: ref, category: 'commands' } });
    expect(parseCardActionValue({ kind: 'turn_detail', cardRef: ref, category: 'commands', itemRef: '../auth.json' })).toBeUndefined();
    expect(parseCardActionValue({ kind: 'turn_detail', cardRef: ref, category: 'commands', taskId: 'other' })).toBeUndefined();
  });
  it('parses model, reasoning, and Fast mode from the execution profile form', () => {
    expect(parseCardActionValue({
      kind: 'model_select', chatId: 'oc_1', chatType: 'group',
    }, { model: 'gpt-5.6-sol', reasoning: 'high', serviceTier: 'fast' })).toEqual({
      chatId: 'oc_1', chatType: 'group',
      action: { kind: 'model_select', model: 'gpt-5.6-sol', reasoning: 'high', serviceTier: 'fast' },
    });
  });
  it('parses project routing selection and cancellation', () => {
    expect(parseCardActionValue({
      kind: 'project_routing_select', routingId: 'route_1', projectId: 'repo', chatId: 'oc_1', chatType: 'group',
    })).toMatchObject({ action: { kind: 'project_routing_select', routingId: 'route_1', projectId: 'repo' } });
    expect(parseCardActionValue({
      kind: 'project_routing_select', routingId: 'route_1', cancel: true, chatId: 'oc_1', chatType: 'group',
    })).toMatchObject({ action: { kind: 'project_routing_select', routingId: 'route_1', cancel: true } });
    expect(parseCardActionValue({
      kind: 'project_routing_select', routingId: 'route_1', chatId: 'oc_1', chatType: 'group',
    }, { projectId: 'repo_more' })).toMatchObject({
      action: { kind: 'project_routing_select', routingId: 'route_1', projectId: 'repo_more' },
    });
  });

  it('collects app-server user-input answers from Feishu form fields', () => {
    expect(parseCardActionValue({
      kind: 'app_server_request_decision', chatId: 'oc_1', requestId: 'asr_1',
      generation: 2, decision: 'answer', questionIds: ['scope', 'mode'],
    }, { scope: 'tests', mode: ['fast'] })).toMatchObject({
      action: { decision: 'answer', answers: { scope: ['tests'], mode: ['fast'] } },
    });
  });
});
