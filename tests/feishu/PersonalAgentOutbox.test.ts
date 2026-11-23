import {describe, expect, it, vi} from 'vitest';
import {FeishuOutbox} from '../../src/feishu/FeishuOutbox.js';
import {SqliteStateStore} from '../../src/state/SqliteStateStore.js';

describe('personal-agent output revocation', () => {
  it('stops a revoked delivery without claiming it was sent or reviving it after re-enable', async () => {
    const store = new SqliteStateStore(':memory:'); try {
      let allowed = false;
      const deliver = vi.fn(async () => undefined);
      const outbox = new FeishuOutbox(store, {deliver}, undefined, async () => allowed);
      outbox.enqueue({dedupeKey: 'old-result', eventType: 'text', target: {chatId: 'oc_group'}, payload: {taskId: 'task', turnId: 'turn'}});
      expect(await outbox.flush()).toEqual({sent: 0, failed: 1});
      expect(deliver).not.toHaveBeenCalled();
      expect(outbox.getByDedupeKey('old-result')).toMatchObject({status: 'pending', attempts: -1, lastError: 'personal_agent_delivery_revoked'});
      allowed = true;
      expect(await outbox.flush()).toEqual({sent: 0, failed: 0});
      expect(deliver).not.toHaveBeenCalled();
    } finally {store.close();}
  });
});
