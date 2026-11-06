import { describe,expect,it } from 'vitest';
import {
renderAppServerRequestCard,
renderDiskCleanupConfirmationCard,
renderTaskConfirmationCard,
renderToolAuthResumeFailureCard,
renderToolAuthorizationCard,
} from '../../src/feishu/TaskPlatformCards.js';

describe('TaskPlatformCards', () => {
  it('renders an authorization link, uploaded QR image, and completion button', () => {
    const card = renderToolAuthorizationCard({
      id: 'auth_1', provider: 'lark', text: 'read doc', loginSessionId: 'session_1',
      authorizationUrl: 'https://auth.example/device', expiresAt: '2026-08-12T18:00:00Z',
      createdAt: '2026-08-12T17:45:00Z', chatId: 'oc_group', chatType: 'group', userId: 'ou_owner',
    }, 'img_valid_qr_key');
    const json = JSON.stringify(card.preferred);
    expect(json).toContain('img_valid_qr_key');
    expect(json).toContain('https://auth.example/device');
    expect(json).toContain('打开授权页面');
    expect(json).toContain('我已授权');
    expect(json).toContain('tool_auth_check');
  });

  it('renders a task-resume retry after authorization has already completed', () => {
    const card = renderToolAuthResumeFailureCard({
      id: 'auth_1', provider: 'lark', text: 'write Base', loginSessionId: 'session_1',
      authorizationUrl: 'https://auth.example/device', expiresAt: '2026-08-12T18:00:00Z',
      createdAt: '2026-08-12T17:45:00Z', chatId: 'oc_group', chatType: 'group',
      userId: 'ou_owner', topicId: 'topic_1', resumeState: 'resume_failed',
    }, 'turn start rejected');
    const json = JSON.stringify(card.preferred);
    expect(json).toContain('授权完成，任务恢复失败');
    expect(json).toContain('重试原任务');
    expect(json).toContain('tool_auth_check');
    expect(json).toContain('topic_1');
    expect(json).not.toContain('https://auth.example/device');
  });

  it('binds destructive confirmations to the originating chat and request', () => {
    const card = renderTaskConfirmationCard('delete', 'delete_1', {
      chatId: 'oc_group', chatType: 'group', userId: 'ou_owner', topicId: 'topic_1',
    });
    expect(JSON.stringify(card.preferred)).toContain('task_delete_decision');
    expect(JSON.stringify(card.preferred)).toContain('delete_1');
    expect(JSON.stringify(card.preferred)).toContain('oc_group');
  });

  it('renders a dangerous disk cleanup confirmation bound to its request and chat', () => {
    const card = renderDiskCleanupConfirmationCard('disk_1', 'Exact tasks: task_1', {
      chatId: 'oc_admin', chatType: 'private', userId: 'ou_admin',
    });
    const json = JSON.stringify(card.preferred);
    expect(json).toContain('disk_cleanup_decision');
    expect(json).toContain('disk_1');
    expect(json).toContain('oc_admin');
    expect(json).toContain('danger');
  });

  it('renders every user-input question into one submitted answer card', () => {
    const card = renderAppServerRequestCard({
      id: 'asr_1', kind: 'user_input', ownerUserId: 'ou_owner', taskId: 'task_1', threadId: 'thread_1',
      turnId: 'turn_1', generation: 2, serverRequestId: 7, method: 'item/tool/requestUserInput',
      riskSummary: 'Codex requires user input.', payload: {
        questions: [{ id: 'scope', question: 'Which scope?' }, { id: 'mode', header: 'Mode' }],
      }, status: 'pending', createdAt: '2026-07-28T00:00:00.000Z', expiresAt: '2026-07-28T00:05:00.000Z',
    }, 'ou_owner');
    const json = JSON.stringify(card.preferred);
    expect(json).toContain('"name":"scope"');
    expect(json).toContain('"name":"mode"');
    expect(json).toContain('"questionIds":["scope","mode"]');
  });

  it('preserves group and topic identity in app-server approval callbacks', () => {
    const card = renderAppServerRequestCard({
      id: 'asr_group', kind: 'approval', ownerUserId: 'ou_member', taskId: 'task_1', threadId: 'thread_1',
      turnId: 'turn_1', generation: 1, serverRequestId: 9, method: 'item/commandExecution/requestApproval',
      riskSummary: 'Run tests', payload: {}, status: 'pending', createdAt: '2026-07-28T00:00:00.000Z',
      expiresAt: '2026-07-28T00:05:00.000Z',
    }, { chatId: 'oc_group', chatType: 'group', topicId: 'topic_1' });

    expect(JSON.stringify(card.preferred)).toContain('"chatType":"group"');
    expect(JSON.stringify(card.preferred)).toContain('"topicId":"topic_1"');
  });
});
