import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { FeishuGateway } from '../../src/feishu/FeishuGateway.js';
import { createTurnDetailRuntime } from '../../src/details/TurnDetailRuntime.js';
import { FeishuTurnDetailController } from '../../src/details/FeishuTurnDetailController.js';
import { TurnDetailRecorder } from '../../src/details/TurnDetailRecorder.js';
import { createTmpDir } from '../helpers/tmp.js';
import { artifactAccessPolicy, TurnDetailArtifactService } from '../../src/details/TurnDetailArtifactService.js';

describe('shared detail browsing', () => {
  it('repairs an ambiguous initial send once and persists the receipt before retrying failed updates', async () => {
    const runtime = createTurnDetailRuntime(join(await createTmpDir(), 'state.sqlite'));
    const identity = { ownerKind: 'host_manager' as const, taskId: 'ambiguous', localTurnId: 'turn' };
    runtime.store!.createTurn({ ...identity, threadId: 'thread', schemaVersion: 1,
      scope: { kind: 'private_user', chatId: 'private', userId: 'owner' }, startedAt: new Date().toISOString(),
      lifecycle: 'running', availability: 'available', retainedBytes: 0, truncated: false });
    const send = vi.fn().mockRejectedValueOnce(new Error('ambiguous send')).mockResolvedValue({ messageId: 'browser' });
    const replace = vi.fn().mockRejectedValueOnce(new Error('update unavailable')).mockResolvedValue(undefined);
    const gateway = { sendOperationCardToTarget: send, replaceDetailMessageCard: replace,
      resolveDetailMessageScope: async () => ({ chatId: 'private', chatType: 'private' }), isDetailReaderMember: async () => true } as unknown as FeishuGateway;
    const controller = new FeishuTurnDetailController(runtime.store!, runtime.resources!, runtime.views!, gateway,
      undefined, undefined, undefined, undefined, runtime.audit);
    const input = { chatId: 'private', chatType: 'private' as const, userId: 'owner', messageId: 'source',
      action: { kind: 'turn_detail' as const, cardRef: runtime.views!.registerCard(identity), category: 'process' as const } };
    try {
      expect((await controller.handle(input)).text).toContain('暂不可用');
      expect((await controller.handle(input)).text).toContain('暂不可用');
      expect(send).toHaveBeenCalledTimes(2); expect(replace).toHaveBeenCalledTimes(1);
      expect((await controller.handle(input)).toast?.content).toContain('已更新');
      expect(send).toHaveBeenCalledTimes(2); expect(replace).toHaveBeenCalledTimes(2);
      expect((await controller.handle(input)).toast?.content).toContain('没有变化');
      expect(replace).toHaveBeenCalledTimes(2);
      gateway.resolveOperationCardLink = vi.fn(async () => 'https://applink.feishu.cn/client/chat/open?openChatId=oc_private&position=12');
      expect((await controller.handle(input)).text).toContain('position=12');
      gateway.resolveOperationCardLink = vi.fn(async () => 'https://untrusted.example.com/');
      expect((await controller.handle(input)).text).toBe('');
    } finally { runtime.close(); }
  });
  it('authorizes download requests from verified callback context and exposes only opaque download controls', async () => {
    const runtime = createTurnDetailRuntime(join(await createTmpDir(), 'state.sqlite'));
    const identity = { ownerKind: 'host_manager' as const, taskId: 'task', localTurnId: 'turn' };
    runtime.results!.save(identity, { kind: 'private_user', chatId: 'private', userId: 'owner' }, 'public answer', new Date().toISOString());
    const cardRef = runtime.views!.registerCard(identity);
    const replace = vi.fn(async (_id: string, _card: Record<string, unknown>) => undefined);
    const gateway = { resolveDetailMessageScope: vi.fn(async () => ({ chatId: 'private', chatType: 'private' })),
      isDetailReaderMember: async () => true, sendOperationCardToTarget: async () => ({ messageId: 'browser' }),
      replaceDetailMessageCard: replace, uploadFile: vi.fn(async () => 'key'), sendDetailFileToTarget: vi.fn(async () => ({ messageId: 'file' })) } as unknown as FeishuGateway;
    const service = new TurnDetailArtifactService(runtime.store!, runtime.resources!, runtime.results!, (actor) => artifactAccessPolicy(gateway, actor), gateway, undefined, undefined, undefined, undefined, runtime.audit);
    const enqueue = vi.fn();
    const controller = new FeishuTurnDetailController(runtime.store!, runtime.resources!, runtime.views!, gateway, undefined, runtime.results, { service, enqueue }, undefined, runtime.audit);
    const input = { chatId: 'private', chatType: 'private' as const, userId: 'owner', messageId: 'source',
      action: { kind: 'turn_detail' as const, cardRef, category: 'result' as const } };
    try {
      await controller.handle(input);
      expect(JSON.stringify(replace.mock.calls[0]![1])).toContain('"download":true');
      const download = { ...input, action: { ...input.action, download: true as const } };
      expect((await controller.handle(download)).text).toContain('已排队');
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ identity, category: 'result', actor: { userId: 'owner', sourceMessageId: 'source' } }));
      expect((await controller.handle({ ...download, userId: 'other' })).text).toContain('访问权限');
      expect((await controller.handle({ ...download, chatId: 'forwarded-other' })).text).toContain('访问权限');
      expect(enqueue).toHaveBeenCalledOnce();
      expect(gateway.uploadFile).not.toHaveBeenCalled();
    } finally { runtime.close(); }
  });
  it('reads full results without retained details, survives restart, isolates viewers and rechecks membership', async () => {
    const path = join(await createTmpDir(), 'state.sqlite');
    let runtime = createTurnDetailRuntime(path);
    const identity = { ownerKind: 'task_platform' as const, taskId: 'task', localTurnId: 'result' };
    runtime.results!.save(identity, { kind: 'shared_group_topic', chatId: 'group', topicId: 'topic' },
      '汉🙂'.repeat(3000), '2026-01-01T00:00:00Z');
    const cardRef = runtime.views!.registerCard(identity);
    const send = vi.fn(async () => ({ messageId: `result-${send.mock.calls.length}` }));
    const replace = vi.fn(async (_id: string, _card: Record<string, unknown>) => undefined);
    const member = vi.fn(async () => true);
    const source = vi.fn(async () => ({ chatId: 'group', chatType: 'group' as const, topicId: 'topic' }));
    const gateway = { sendOperationCardToTarget: send, replaceDetailMessageCard: replace,
      resolveDetailMessageScope: source, isDetailReaderMember: member } as unknown as FeishuGateway;
    const controller = () => new FeishuTurnDetailController(runtime.store!, runtime.resources!, runtime.views!, gateway, undefined, runtime.results, undefined, undefined, runtime.audit);
    const input = { chatId: 'group', chatType: 'group' as const, userId: 'alice', messageId: 'root',
      action: { kind: 'turn_detail' as const, cardRef, category: 'result' as const } };
    try {
      await Promise.all([controller().handle(input)]);
      expect(send).toHaveBeenCalledOnce();
      const cursorRef = JSON.stringify(replace.mock.calls.at(-1)![1]).match(/"cursorRef":"([a-f0-9]{32})"/)![1]!;
      await runtime.close(); runtime = createTurnDetailRuntime(path);
      expect((await controller().handle(input)).text).toBe('');
      expect(send).toHaveBeenCalledOnce();
      await controller().handle({ ...input, action: { ...input.action, cursorRef } });
      expect(replace.mock.calls.at(-1)![0]).toBe('result-1');
      replace.mockRejectedValueOnce(new Error('temporary update failure'));
      expect((await controller().handle({ ...input, userId: 'bob', action: { ...input.action, cursorRef } })).text).toContain('暂不可用');
      expect((await controller().handle({ ...input, userId: 'bob', action: { ...input.action, cursorRef } })).text).toBe('');
      expect(send).toHaveBeenCalledTimes(2);
      expect(replace.mock.calls.at(-1)![0]).toBe('result-2');
      member.mockResolvedValue(false);
      const count = replace.mock.calls.length;
      expect((await controller().handle(input)).text).toContain('访问权限');
      expect(replace.mock.calls.length).toBe(count);
      member.mockResolvedValue(true);
      source.mockResolvedValueOnce({ chatId: 'group', chatType: 'group', topicId: 'sibling' });
      expect((await controller().handle(input)).text).toContain('访问权限');
    } finally { runtime.close(); }
  });
  it('denies another private reader before reading or publishing a result', async () => {
    const runtime = createTurnDetailRuntime(join(await createTmpDir(), 'state.sqlite'));
    const identity = { ownerKind: 'host_manager' as const, taskId: 'task', localTurnId: 'result' };
    runtime.results!.save(identity, { kind: 'private_user', chatId: 'private', userId: 'owner' }, 'private answer', new Date().toISOString());
    const send = vi.fn();
    const gateway = { sendOperationCardToTarget: send, replaceDetailMessageCard: vi.fn(),
      resolveDetailMessageScope: async () => ({ chatId: 'private', chatType: 'private' }), isDetailReaderMember: async () => true } as unknown as FeishuGateway;
    const controller = new FeishuTurnDetailController(runtime.store!, runtime.resources!, runtime.views!, gateway, undefined, runtime.results, undefined, undefined, runtime.audit);
    try {
      const reply = await controller.handle({ chatId: 'private', chatType: 'private', userId: 'other', messageId: 'forwarded',
        action: { kind: 'turn_detail', cardRef: runtime.views!.registerCard(identity), category: 'result' } });
      expect(reply.text).toContain('访问权限');
      expect(send).not.toHaveBeenCalled();
    } finally { runtime.close(); }
  });
  it('isolates viewers, avoids duplicate sends, retries failed updates and denies forwarded sources', async () => {
    const path = join(await createTmpDir(), 'state.sqlite');
    const now = new Date('2026-10-14T00:00:00Z');
    const runtime = createTurnDetailRuntime(path, () => now);
    const store = runtime.store!, files = runtime.resources!, views = runtime.views!;
    const identity = { ownerKind: 'task_platform' as const, taskId: 'task', localTurnId: 'local' };
    store.createTurn({ ...identity, threadId: 'thread', codexTurnId: 'turn', schemaVersion: 1,
      scope: { kind: 'shared_group_topic', chatId: 'group', topicId: 'topic' }, startedAt: now.toISOString(),
      lifecycle: 'running', availability: 'available', retainedBytes: 0, truncated: false });
    const recorder = new TurnDetailRecorder(store, files);
    recorder.record(identity, { kind: 'command_item', itemId: 'cmd', command: 'pwd', completed: false }, 'cmd', now.toISOString());
    recorder.record(identity, { kind: 'command_delta', itemId: 'cmd', stream: 'combined', text: 'safe output\n' }, 'output', now.toISOString());
    const cardRef = views.registerCard(identity);
    const send = vi.fn(async () => ({ messageId: `detail-${send.mock.calls.length}` }));
    const replace = vi.fn(async (_messageId: string, _card: Record<string, unknown>) => undefined);
    const source = vi.fn(async () => ({ chatId: 'group', chatType: 'group' as const, topicId: 'topic' }));
    const gateway = { sendOperationCardToTarget: send, replaceDetailMessageCard: replace,
      resolveDetailMessageScope: source, isDetailReaderMember: async () => true } as unknown as FeishuGateway;
    const controller = new FeishuTurnDetailController(store, files, views, gateway, () => now, undefined, undefined, undefined, runtime.audit);
    const input = { chatId: 'group', chatType: 'group' as const, userId: 'alice', messageId: 'root',
      action: { kind: 'turn_detail' as const, cardRef, category: 'commands' as const } };
    try {
      await Promise.all([controller.handle(input), controller.handle(input)]);
      expect(send).toHaveBeenCalledOnce();
      expect(replace).not.toHaveBeenCalled(); // Successful first delivery needs no redundant PATCH.
      expect(JSON.stringify(send.mock.calls[0])).toContain('safe output');
      expect((await controller.handle(input)).toast?.content).toContain('内容没有变化');
      expect(source).toHaveBeenCalledTimes(4); // Initial read + fresh publication proof + two freshly authorized duplicates.
      source.mockResolvedValueOnce({ chatId: 'group', chatType: 'group', topicId: 'topic' })
        .mockResolvedValueOnce({ chatId: 'group', chatType: 'group', topicId: 'sibling' });
      const updatesBeforeRevocation = replace.mock.calls.length;
      expect((await controller.handle({ ...input, userId: 'revoked-during-read' })).text).toContain('访问权限');
      expect(send).toHaveBeenCalledOnce(); expect(replace).toHaveBeenCalledTimes(updatesBeforeRevocation);
      await controller.handle({ ...input, userId: 'bob' });
      expect(send).toHaveBeenCalledTimes(2);
      const itemRef = store.listEntries(identity)[0]!.entryId;
      replace.mockRejectedValueOnce(new Error('network failed'));
      expect((await controller.handle({ ...input, action: { ...input.action, itemRef } })).text).toContain('暂不可用');
      expect((await controller.handle({ ...input, action: { ...input.action, itemRef } })).text).toBe('');
      expect(send).toHaveBeenCalledTimes(2);
      expect(replace.mock.calls.at(-1)![0]).toBe('detail-1');
      source.mockResolvedValueOnce({ chatId: 'group', chatType: 'group', topicId: 'sibling' });
      const before = replace.mock.calls.length;
      expect((await controller.handle(input)).text).toContain('访问权限');
      expect(replace.mock.calls.length).toBe(before);
      // Another authorized member clicking Alice's body-page control gets an independent copy.
      recorder.record(identity, { kind: 'command_delta', itemId: 'cmd', stream: 'combined', text: 'line\n'.repeat(2000) }, 'long', now.toISOString());
      await controller.handle({ ...input, action: { ...input.action, itemRef } });
      const aliceCard = replace.mock.calls.at(-1)![1];
      const cursor = JSON.stringify(aliceCard).match(/"cursorRef":"([a-f0-9]{32})"/)![1]!;
      const count = replace.mock.calls.length;
      await controller.handle({ ...input, userId: 'bob', messageId: 'detail-1', action: { ...input.action, itemRef, cursorRef: cursor } });
      expect(replace.mock.calls.length).toBeGreaterThan(count);
      expect(replace.mock.calls.at(-1)![0]).toBe('detail-2');
    } finally { runtime.close(); }
  });
});
