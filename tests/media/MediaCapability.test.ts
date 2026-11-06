import { describe, expect, it } from 'vitest';
import { mediaDeliveryGuidance, mediaDynamicTools } from '../../src/media/MediaCapability.js';

describe('mediaDynamicTools', () => {
  it('advertises one bounded publish tool without accepting a target conversation', () => {
    const tools = mediaDynamicTools();
    expect(tools).toHaveLength(1);
    expect(JSON.stringify(tools)).toContain('artifact_publish');
    expect(JSON.stringify(tools)).toContain('current Feishu conversation');
    expect(JSON.stringify(tools)).not.toContain('chatId');
  });

  it('tells the model how to deliver arbitrary workspace artifacts in either runtime', () => {
    expect(mediaDeliveryGuidance('task_1', 'user-sandbox'))
      .toContain('/workspace/tasks/task_1/.linkbot/outbox/');
    expect(mediaDeliveryGuidance('task_1', 'user-sandbox', 'project'))
      .toContain('/workspace/.linkbot/tasks/task_1/outbox/');
    expect(mediaDeliveryGuidance('task_1', 'legacy-task-container'))
      .toContain('/workspace/.linkbot/outbox/');
    expect(mediaDeliveryGuidance('task_1', 'user-sandbox'))
      .toContain('/workspace/.linkbot/artifacts/');
    expect(mediaDeliveryGuidance('task_1', 'user-sandbox'))
      .toContain('Markdown image link is not a Feishu attachment');
  });
});
