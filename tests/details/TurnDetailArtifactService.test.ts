import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTmpDir } from '../helpers/tmp.js';
import { createTurnDetailRuntime } from '../../src/details/TurnDetailRuntime.js';
import { TurnDetailRecorder } from '../../src/details/TurnDetailRecorder.js';
import { artifactAccessPolicy, DETAIL_UPLOAD_PART_BYTES, TurnDetailArtifactService } from '../../src/details/TurnDetailArtifactService.js';
import type { FeishuGateway } from '../../src/feishu/FeishuGateway.js';
import { DetailAccessPolicy } from '../../src/details/DetailAccessPolicy.js';
import { symlink, unlink } from 'node:fs/promises';
import { SqliteStateStore } from '../../src/state/SqliteStateStore.js';
import { FeishuGatewayOutboxTransport, FeishuOutbox } from '../../src/feishu/FeishuOutbox.js';
import type { MediaAttachmentRecord } from '../../src/media/MediaTypes.js';

describe('safe turn artifacts', () => {
  it('splits oversized UTF-8 exports losslessly and retries cached parts with stable per-part delivery keys', async () => {
    const runtime = createTurnDetailRuntime(join(await createTmpDir(), 'state.sqlite'));
    const identity = { ownerKind: 'task_platform' as const, taskId: 'task', localTurnId: 'turn' };
    runtime.results!.save(identity, { kind: 'private_user', chatId: 'private', userId: 'owner' }, 'safe result', new Date().toISOString());
    const data = Buffer.concat([Buffer.alloc(DETAIL_UPLOAD_PART_BYTES - 1, 'a'), Buffer.from('🙂'), Buffer.alloc(500000, 'b')]);
    const uploaded: Buffer[] = [], names: string[] = [], cache = new Map<string, MediaAttachmentRecord>();
    const upload = vi.fn(async (part: Buffer, name: string) => { expect(part.length).toBeLessThanOrEqual(DETAIL_UPLOAD_PART_BYTES);
      expect(Buffer.from(part.toString('utf8')).equals(part)).toBe(true); uploaded.push(part); names.push(name); return `key-${uploaded.length}`; });
    const send = vi.fn(async (_target: unknown, _key: string, _uuid: string) => ({ messageId: 'receipt' }));
    send.mockResolvedValueOnce({ messageId: 'first' }).mockRejectedValueOnce(new Error('second part transient failure'));
    const policy = new DetailAccessPolicy({ resolveSource: async () => ({ chatId: 'private', chatType: 'private' }),
      isGroupMember: async () => false, canReadTopic: async () => false });
    const service = new TurnDetailArtifactService(runtime.store!, runtime.resources!, runtime.results!, () => policy,
      { uploadFile: upload, sendDetailFileToTarget: send }, { getAttachment: (id) => cache.get(id), saveAttachment: (row) => { cache.set(row.id, row); } },
      undefined, undefined, undefined, runtime.audit);
    vi.spyOn(service as unknown as { generate(): Promise<{ data: Buffer; name: string }> }, 'generate').mockResolvedValue({ data, name: 'linkbot-changes.patch' });
    const request = { identity, category: 'result' as const, actor: { userId: 'owner', sourceMessageId: 'source' }, ...service.snapshot(identity, 'result') };
    try {
      await expect(service.deliver(request, 'stable-parent')).rejects.toThrow('second part transient failure');
      await service.deliver(request, 'stable-parent');
      expect(upload).toHaveBeenCalledTimes(2); expect(send).toHaveBeenCalledTimes(4);
      expect(Buffer.concat(uploaded).equals(data)).toBe(true); expect(cache.size).toBe(2);
      expect(names).toEqual(['linkbot-changes.patch.part-1-of-2.txt', 'linkbot-changes.patch.part-2-of-2.txt']);
      expect(send.mock.calls[0]![2]).toBe(send.mock.calls[2]![2]); expect(send.mock.calls[1]![2]).toBe(send.mock.calls[3]![2]);
      expect(send.mock.calls[0]![2]).not.toBe(send.mock.calls[1]![2]);
    } finally { await runtime.close(); }
  });

  it('rechecks access between parts and refuses cached-part delivery after revocation', async () => {
    const runtime = createTurnDetailRuntime(join(await createTmpDir(), 'state.sqlite'));
    const identity = { ownerKind: 'task_platform' as const, taskId: 'task', localTurnId: 'turn' };
    runtime.results!.save(identity, { kind: 'private_user', chatId: 'private', userId: 'owner' }, 'safe result', new Date().toISOString());
    let allowed = true;
    const policy = new DetailAccessPolicy({ resolveSource: async () => allowed ? { chatId: 'private', chatType: 'private' } : undefined,
      isGroupMember: async () => false, canReadTopic: async () => false });
    const upload = vi.fn(async () => { if (upload.mock.calls.length === 2) allowed = false; return 'key'; });
    const send = vi.fn(async () => ({ messageId: 'receipt' }));
    const service = new TurnDetailArtifactService(runtime.store!, runtime.resources!, runtime.results!, () => policy,
      { uploadFile: upload, sendDetailFileToTarget: send }, undefined, undefined, undefined, undefined, runtime.audit);
    vi.spyOn(service as unknown as { generate(): Promise<{ data: Buffer; name: string }> }, 'generate')
      .mockResolvedValue({ data: Buffer.alloc(DETAIL_UPLOAD_PART_BYTES + 1, 'x'), name: 'result.txt' });
    const request = { identity, category: 'result' as const, actor: { userId: 'owner', sourceMessageId: 'source' }, ...service.snapshot(identity, 'result') };
    try {
      await expect(service.deliver(request, 'multipart-revoked')).rejects.toThrow('access_denied');
      expect(send).toHaveBeenCalledOnce();
      await expect(service.deliver(request, 'multipart-revoked')).rejects.toThrow('access_denied');
      expect(send).toHaveBeenCalledOnce(); expect(upload).toHaveBeenCalledTimes(2);
    } finally { await runtime.close(); }
  });

  it.each([DETAIL_UPLOAD_PART_BYTES, DETAIL_UPLOAD_PART_BYTES + 1])('honors the installed SDK byte boundary at %s', async (bytes) => {
    const runtime = createTurnDetailRuntime(join(await createTmpDir(), 'state.sqlite'));
    const identity = { ownerKind: 'task_platform' as const, taskId: 'task', localTurnId: 'turn' };
    runtime.results!.save(identity, { kind: 'private_user', chatId: 'private', userId: 'owner' }, 'safe result', new Date().toISOString());
    const policy = new DetailAccessPolicy({ resolveSource: async () => ({ chatId: 'private', chatType: 'private' }),
      isGroupMember: async () => false, canReadTopic: async () => false });
    const upload = vi.fn(async (data: Buffer) => { expect(data.length).toBeGreaterThan(0); expect(data.length).toBeLessThanOrEqual(DETAIL_UPLOAD_PART_BYTES); return 'key'; });
    const service = new TurnDetailArtifactService(runtime.store!, runtime.resources!, runtime.results!, () => policy,
      { uploadFile: upload, sendDetailFileToTarget: vi.fn(async () => ({ messageId: 'receipt' })) }, undefined, undefined, undefined, undefined, runtime.audit);
    vi.spyOn(service as unknown as { generate(): Promise<{ data: Buffer; name: string }> }, 'generate')
      .mockResolvedValue({ data: Buffer.alloc(bytes, 'x'), name: 'result.txt' });
    try {
      await service.deliver({ identity, category: 'result', actor: { userId: 'owner', sourceMessageId: 'source' }, ...service.snapshot(identity, 'result') }, 'boundary');
      expect(upload).toHaveBeenCalledTimes(bytes === DETAIL_UPLOAD_PART_BYTES ? 1 : 2);
    } finally { await runtime.close(); }
  });
  it('revalidates group membership and the original topic on every queued delivery', async () => {
    const runtime = createTurnDetailRuntime(join(await createTmpDir(), 'state.sqlite'));
    const identity = { ownerKind: 'task_platform' as const, taskId: 'task', localTurnId: 'turn' };
    runtime.results!.save(identity, { kind: 'shared_group_topic', chatId: 'group', topicId: 'topic' }, 'public answer', new Date().toISOString());
    const member = vi.fn(async () => true);
    const source = vi.fn(async () => ({ chatId: 'group', chatType: 'group' as const, topicId: 'topic' }));
    const send = vi.fn(async () => ({ messageId: 'receipt' }));
    const gateway = { resolveDetailMessageScope: source, isDetailReaderMember: member,
      uploadFile: vi.fn(async () => 'key'), sendDetailFileToTarget: send } as unknown as FeishuGateway;
    const service = new TurnDetailArtifactService(runtime.store!, runtime.resources!, runtime.results!, (actor) => artifactAccessPolicy(gateway, actor), gateway, undefined, undefined, undefined, undefined, runtime.audit);
    const request = { identity, category: 'result' as const, actor: { userId: 'alice', sourceMessageId: 'original-card' }, ...service.snapshot(identity, 'result') };
    try {
      await service.deliver(request, 'uuid');
      expect(send).toHaveBeenCalledWith({ chatId: 'group', replyToMessageId: 'original-card', replyInThread: true }, 'key', 'uuid');
      member.mockResolvedValue(false);
      await expect(service.deliver(request, 'uuid')).rejects.toThrow('access_denied');
      member.mockResolvedValue(true);
      source.mockResolvedValue({ chatId: 'group', chatType: 'group', topicId: 'sibling' });
      await expect(service.deliver(request, 'uuid')).rejects.toThrow('access_denied');
      expect(send).toHaveBeenCalledOnce();
    } finally { runtime.close(); }
  });
  it('reuses a cached upload on retry but rejects revoked readers and changed output boundaries', async () => {
    const runtime = createTurnDetailRuntime(join(await createTmpDir(), 'state.sqlite'));
    const identity = { ownerKind: 'task_platform' as const, taskId: 'task', localTurnId: 'turn' };
    runtime.store!.createTurn({ ...identity, threadId: 'thread', scope: { kind: 'private_user', chatId: 'chat', userId: 'owner' },
      schemaVersion: 1, lifecycle: 'running', availability: 'available', startedAt: new Date().toISOString(), retainedBytes: 0, truncated: false });
    const recorder = new TurnDetailRecorder(runtime.store!, runtime.resources!);
    recorder.record(identity, { kind: 'command_item', itemId: 'cmd', command: 'pwd', completed: false }, 'cmd', new Date().toISOString());
    recorder.record(identity, { kind: 'command_delta', itemId: 'cmd', stream: 'combined', text: 'safe\n' }, 'body', new Date().toISOString());
    let allowed = true;
    const policy = new DetailAccessPolicy({ resolveSource: async () => allowed ? { chatId: 'chat', chatType: 'private' } : undefined,
      isGroupMember: async () => false, canReadTopic: async () => false });
    const upload = vi.fn(async () => 'key'), send = vi.fn().mockRejectedValueOnce(new Error('temporary send failure')).mockResolvedValue({ messageId: 'receipt' });
    const cache = new Map<string, MediaAttachmentRecord>();
    const service = new TurnDetailArtifactService(runtime.store!, runtime.resources!, runtime.results!, () => policy,
      { uploadFile: upload, sendDetailFileToTarget: send }, { getAttachment: (id) => cache.get(id), saveAttachment: (record) => { cache.set(record.id, record); } }, undefined, undefined, undefined, runtime.audit);
    const request = { identity, category: 'commands' as const, actor: { userId: 'owner', sourceMessageId: 'source' }, ...service.snapshot(identity, 'commands') };
    try {
      await expect(service.deliver(request, 'uuid')).rejects.toThrow('temporary send failure');
      allowed = false;
      await expect(service.deliver(request, 'uuid')).rejects.toThrow('access_denied');
      allowed = true;
      await service.deliver(request, 'uuid');
      expect(upload).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
      expect([...cache.values()][0]!.storagePath).toBe('');
      recorder.record(identity, { kind: 'command_delta', itemId: 'cmd', stream: 'combined', text: 'later\n' }, 'later', new Date().toISOString());
      expect(runtime.store!.categorySequence(identity, 'commands')).toBe(request.through);
      await expect(service.deliver(request, 'uuid')).rejects.toThrow('snapshot_changed');
      expect(send).toHaveBeenCalledTimes(2);
    } finally { runtime.close(); }
  });
  it('rejects an expired queued artifact without upload or generic media delivery', async () => {
    const path = join(await createTmpDir(), 'state.sqlite');
    const runtime = createTurnDetailRuntime(path), state = new SqliteStateStore(path);
    const identity = { ownerKind: 'task_platform' as const, taskId: 'task', localTurnId: 'turn' };
    runtime.store!.createTurn({ ...identity, threadId: 'thread', scope: { kind: 'private_user', chatId: 'chat', userId: 'owner' },
      schemaVersion: 1, lifecycle: 'running', availability: 'available', startedAt: new Date().toISOString(), retainedBytes: 0, truncated: false });
    const policy = new DetailAccessPolicy({ resolveSource: async () => ({ chatId: 'chat', chatType: 'private' }),
      isGroupMember: async () => false, canReadTopic: async () => false });
    const upload = vi.fn(async () => 'key'), send = vi.fn(async () => ({ messageId: 'receipt' }));
    const service = new TurnDetailArtifactService(runtime.store!, runtime.resources!, runtime.results!, () => policy,
      { uploadFile: upload, sendDetailFileToTarget: send }, undefined, undefined, undefined, undefined, runtime.audit);
    const generic = vi.fn();
    const outbox = new FeishuOutbox(state, new FeishuGatewayOutboxTransport({ sendTextToTarget: generic, sendRenderedMessageToTarget: generic }, state, undefined, undefined, service));
    try {
      outbox.enqueue({ dedupeKey: 'artifact', target: { chatId: 'untrusted-other' }, eventType: 'media_send', payload: { kind: 'turn_detail_artifact',
        request: { identity, category: 'commands', actor: { userId: 'owner', sourceMessageId: 'source' }, ...service.snapshot(identity, 'commands') } } });
      runtime.store!.completeTurn(identity, 'completed', '2020-01-01T00:00:00Z');
      expect(await outbox.flush()).toEqual({ sent: 0, failed: 1 });
      expect(outbox.pending()[0]!.attempts).toBe(-1);
      expect(await outbox.flush()).toEqual({ sent: 0, failed: 0 });
      expect(upload).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(generic).not.toHaveBeenCalled();
    } finally { runtime.close(); state.close(); }
  });
  it('exports results independently of expired details with an explicit bounded Unicode preview', async () => {
    const runtime = createTurnDetailRuntime(join(await createTmpDir(), 'state.sqlite'));
    const identity = { ownerKind: 'host_manager' as const, taskId: 'task', localTurnId: 'turn' };
    const scope = { kind: 'private_user' as const, chatId: 'chat', userId: 'owner' };
    runtime.results!.save(identity, scope, '汉🙂'.repeat(5000), '2020-01-01T00:00:00Z');
    const policy = new DetailAccessPolicy({ resolveSource: async () => ({ chatId: 'chat', chatType: 'private' }),
      isGroupMember: async () => false, canReadTopic: async () => false });
    const upload = vi.fn(async (_data: Buffer, _name: string) => 'key');
    const service = new TurnDetailArtifactService(runtime.store!, runtime.resources!, runtime.results!, () => policy,
      { uploadFile: upload, sendDetailFileToTarget: vi.fn(async () => ({ messageId: 'receipt' })) }, undefined, undefined, 1024, undefined, runtime.audit);
    try {
      await service.deliver({ identity, category: 'result', actor: { userId: 'owner', sourceMessageId: 'source' },
        ...service.snapshot(identity, 'result') }, 'uuid');
      const body = upload.mock.calls[0]![0];
      expect(body.length).toBeLessThanOrEqual(1024);
      expect(body.toString()).not.toContain('�');
      expect(body.toString()).toContain('export-budget limited');
      expect(upload.mock.calls[0]![1]).toBe('linkbot-result.txt');
    } finally { runtime.close(); }
  });
  it('denies expired details and symlink substitution without publishing raw resources', async () => {
    const path = join(await createTmpDir(), 'state.sqlite');
    const runtime = createTurnDetailRuntime(path);
    const identity = { ownerKind: 'task_platform' as const, taskId: 'task', localTurnId: 'turn' };
    const scope = { kind: 'private_user' as const, chatId: 'chat', userId: 'owner' };
    runtime.store!.createTurn({ ...identity, threadId: 'thread', scope, schemaVersion: 1,
      lifecycle: 'running', availability: 'available', startedAt: new Date().toISOString(), retainedBytes: 0, truncated: false });
    const recorder = new TurnDetailRecorder(runtime.store!, runtime.resources!);
    recorder.record(identity, { kind: 'command_item', itemId: 'cmd', command: 'pwd', completed: false }, 'cmd', new Date().toISOString());
    recorder.record(identity, { kind: 'command_delta', itemId: 'cmd', stream: 'combined', text: 'retained\n' }, 'body', new Date().toISOString());
    const policy = new DetailAccessPolicy({ resolveSource: async () => ({ chatId: 'chat', chatType: 'private' }),
      isGroupMember: async () => false, canReadTopic: async () => false });
    const upload = vi.fn(async () => 'key');
    const service = new TurnDetailArtifactService(runtime.store!, runtime.resources!, runtime.results!, () => policy,
      { uploadFile: upload, sendDetailFileToTarget: vi.fn() }, undefined, undefined, undefined, undefined, runtime.audit);
    const request = { identity, category: 'commands' as const, actor: { userId: 'owner', sourceMessageId: 'source' },
      ...service.snapshot(identity, 'commands') };
    try {
      const entry = runtime.store!.listEntries(identity)[0]!;
      const resourcePath = join(`${path}.turn-details`, entry.resource!.resourceId);
      await unlink(resourcePath); await symlink(path, resourcePath);
      await expect(service.deliver(request, 'uuid')).rejects.toThrow();
      expect(upload).not.toHaveBeenCalled();
      runtime.store!.completeTurn(identity, 'completed', '2020-01-01T00:00:00Z');
      await expect(service.deliver(request, 'uuid')).rejects.toThrow('expired');
      expect(upload).not.toHaveBeenCalled();
    } finally { runtime.close(); }
  });
  it('labels complete patches separately from redacted review text', async () => {
    const runtime = createTurnDetailRuntime(join(await createTmpDir(), 'state.sqlite'));
    const identity = { ownerKind: 'task_platform' as const, taskId: 'task', localTurnId: 'turn' };
    runtime.store!.createTurn({ ...identity, threadId: 'thread', scope: { kind: 'private_user', chatId: 'chat', userId: 'owner' },
      schemaVersion: 1, lifecycle: 'running', availability: 'available', startedAt: new Date().toISOString(), retainedBytes: 0, truncated: false });
    const policy = new DetailAccessPolicy({ resolveSource: async () => ({ chatId: 'chat', chatType: 'private' }),
      isGroupMember: async () => false, canReadTopic: async () => false });
    const upload = vi.fn(async (_body: Buffer, _name: string) => 'key');
    const service = new TurnDetailArtifactService(runtime.store!, runtime.resources!, runtime.results!, () => policy,
      { uploadFile: upload, sendDetailFileToTarget: vi.fn(async () => ({ messageId: 'receipt' })) }, undefined, undefined, undefined, undefined, runtime.audit);
    const recorder = new TurnDetailRecorder(runtime.store!, runtime.resources!);
    try {
      for (const [index, text] of ['safe', 'token=fake-secret'].entries()) {
        recorder.record(identity, { kind: 'diff_snapshot', text: `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1 @@\n+${text}\n` }, `diff-${index}`, new Date().toISOString());
        await service.deliver({ identity, category: 'files', actor: { userId: 'owner', sourceMessageId: 'source' },
          ...service.snapshot(identity, 'files') }, `uuid-${index}`);
      }
      expect(upload.mock.calls[0]![1]).toBe('linkbot-changes.patch');
      expect(upload.mock.calls[1]![1]).toBe('linkbot-changes.review.txt');
      expect(upload.mock.calls[1]![0].toString()).not.toContain('fake-secret');
    } finally { runtime.close(); }
  });
  it('exports only committed sanitized command data and enforces upload and send authorization', async () => {
    const runtime = createTurnDetailRuntime(join(await createTmpDir(), 'state.sqlite'));
    const identity = { ownerKind: 'task_platform' as const, taskId: 'task', localTurnId: 'turn' };
    const scope = { kind: 'private_user' as const, chatId: 'chat', userId: 'owner' };
    runtime.store!.createTurn({ ...identity, threadId: 'thread', scope, schemaVersion: 1,
      lifecycle: 'running', availability: 'available', startedAt: new Date().toISOString(), retainedBytes: 0, truncated: false });
    const recorder = new TurnDetailRecorder(runtime.store!, runtime.resources!);
    recorder.record(identity, { kind: 'command_item', itemId: 'cmd', command: 'pwd', completed: false }, 'cmd', new Date().toISOString());
    recorder.record(identity, { kind: 'command_delta', itemId: 'cmd', stream: 'combined', text: 'safe output\ntoken=fake-secret\n' }, 'data', new Date().toISOString());
    let allowed = true;
    const policy = new DetailAccessPolicy({ resolveSource: async () => allowed ? { chatId: 'chat', chatType: 'private' } : undefined,
      isGroupMember: async () => false, canReadTopic: async () => false });
    const upload = vi.fn(async (_data: Buffer, _name: string) => 'file-key');
    const send = vi.fn(async () => ({ messageId: 'file-message' }));
    const service = new TurnDetailArtifactService(runtime.store!, runtime.resources!, runtime.results!, () => policy,
      { uploadFile: upload, sendDetailFileToTarget: send }, undefined, undefined, undefined, undefined, runtime.audit);
    const request = { identity, category: 'commands' as const, actor: { userId: 'owner', sourceMessageId: 'source' },
      ...service.snapshot(identity, 'commands') };
    try {
      await service.deliver(request, 'stable-uuid');
      expect(upload.mock.calls[0]![0].toString()).toContain('safe output');
      expect(upload.mock.calls[0]![0].toString()).not.toContain('fake-secret');
      allowed = false;
      await expect(service.deliver(request, 'stable-uuid')).rejects.toThrow('access_denied');
      expect(upload).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledOnce();
      allowed = true;
      upload.mockImplementationOnce(async () => { allowed = false; return 'file-key'; });
      await expect(service.deliver(request, 'other-uuid')).rejects.toThrow('access_denied');
      expect(send).toHaveBeenCalledOnce();
    } finally { runtime.close(); }
  });
});
