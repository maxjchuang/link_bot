import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MediaService } from '../../src/media/MediaService.js';
import { SqliteStateStore } from '../../src/state/SqliteStateStore.js';
import type { TaskRecord } from '../../src/tasks/TaskTypes.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('MediaService', () => {
  it('recovers a forwarded image through its verified envelope without querying the original chat',async()=>{
    const root=await createTmpDir(),store=new SqliteStateStore(join(root,'state.sqlite'));
    const download=vi.fn(async()=>({data:png()}));
    const service=new MediaService(config(root),store,{downloadMessageResource:download},{});
    const input={task:task(),turnId:'source',chatId:'oc_1',userId:'ou_1',images:[{
      messageId:'om_private_child',imageKey:'img_1',forwardedEnvelopeMessageId:'om_forward',dataUrl:`data:image/png;base64,${png().toString('base64')}`}]};
    const attachmentIds=await service.retainContextImages(input);
    const record=service.getAttachment(attachmentIds[0]!)!;
    await unlink(record.storagePath);
    await expect(service.handoffImages({...input,attachmentIds,recoverMissing:true})).rejects.toThrow('verified envelope');
    expect(download).not.toHaveBeenCalled();
    const restored=await service.handoffImages({...input,attachmentIds,recoverMissing:true,
      verifiedForwardedImages:[{messageId:'om_private_child',imageKey:'img_1',envelopeMessageId:'om_forward'}]});
    expect(restored).toEqual(input.images);
    expect(download).toHaveBeenCalledWith(expect.objectContaining({messageId:'om_forward',resourceKey:'img_1'}));
    store.close();
  });
  it('retains scoped historical images idempotently without sharing another task’s attachment identity',async()=>{
    const root=await createTmpDir(),store=new SqliteStateStore(join(root,'state.sqlite'));
    const service=new MediaService(config(root),store,{},{});
    const image={messageId:'om_image',imageKey:'img_1',dataUrl:`data:image/png;base64,${png().toString('base64')}`};
    const input={task:task(),turnId:'source',chatId:'oc_1',topicId:'topic_1',userId:'ou_1',images:[image]};
    const ids=await service.retainContextImages(input);
    expect(await service.retainContextImages(input)).toEqual(ids);
    expect(await service.handoffImages({...input,attachmentIds:ids})).toEqual([image]);
    await expect(service.handoffImages({...input,userId:'ou_2',attachmentIds:ids})).rejects.toThrow('scope');
    const other={...input,task:{...task(),id:'task_2'}};
    const otherIds=await service.retainContextImages(other);
    expect(otherIds).not.toEqual(ids);
    expect(await service.handoffImages({...other,attachmentIds:otherIds})).toEqual([image]);
    expect(service.getAttachment(ids[0]!)?.taskId).toBe('task_1');
    store.close();
  });
  it('recovers a missing cache object from the original resource and refuses changed bytes',async()=>{
    const root=await createTmpDir(),store=new SqliteStateStore(join(root,'state.sqlite'));
    const download=vi.fn(async()=>({data:png()}));
    const service=new MediaService(config(root),store,{downloadMessageResource:download},{});
    const input={task:task(),turnId:'source',chatId:'oc_1',userId:'ou_1',images:[{messageId:'om_image',imageKey:'img_1',dataUrl:`data:image/png;base64,${png().toString('base64')}`}]};
    const attachmentIds=await service.retainContextImages(input);
    const record=service.getAttachment(attachmentIds[0]!)!;
    await unlink(record.storagePath);
    expect(await service.handoffImages({...input,attachmentIds,recoverMissing:true})).toHaveLength(1);
    expect(download).toHaveBeenCalledWith(expect.objectContaining({messageId:'om_image',resourceKey:'img_1'}));
    await unlink(record.storagePath);
    download.mockResolvedValueOnce({data:Buffer.from('changed')});
    await expect(service.handoffImages({...input,attachmentIds,recoverMissing:true})).rejects.toThrow('content changed');
    store.close();
  });
  it('reprojects files into the continuation turn and expires both staging projections',async()=>{
    const root=await createTmpDir(),store=new SqliteStateStore(join(root,'state.sqlite'));
    store.saveTask(task());
    const remove=vi.fn(async()=>undefined);
    const service=new MediaService(config(root),store,{downloadMessageResource:vi.fn(async()=>({data:Buffer.from('report')}))},
      {stageInboundAttachment:vi.fn(async(_task,turnId,_source,fileName)=>`/workspace/.linkbot/inbox/${turnId}/${fileName}`),removeInboundAttachments:remove});
    const input={task:task(),turnId:'source',chatId:'oc_1',userId:'ou_1'};
    const original=await service.prepareInbound({...input,externalMessageId:'om_file',resources:[{kind:'file',resourceKey:'file_1',resourceOwnerMessageId:'om_file',fileName:'report.txt'}]});
    const replay=await service.replayInbound({...input,turnId:'continued',attachmentIds:original.attachmentIds});
    expect(replay.promptContext).toContain('/continued/');
    expect(service.getAttachment(original.attachmentIds[0]!)?.turnId).toBe('source');
    await service.cleanupExpired('2099-01-01T00:00:00.000Z');
    expect(remove.mock.calls.map(call=>(call as unknown as [TaskRecord,string])[1]).sort()).toEqual(['continued','source']);
    store.close();
  });
  it('prepares images as multimodal input and stages files with an untrusted manifest', async () => {
    const root = await createTmpDir();
    const store = new SqliteStateStore(join(root, 'state.sqlite'));
    const stageInboundAttachment = vi.fn(async (_task, turnId, _source, fileName) =>
      `/workspace/.linkbot/inbox/${turnId}/${fileName}`);
    const service = new MediaService(config(root), store, {
      downloadMessageResource: vi.fn(async ({ kind }) => kind === 'image'
        ? { data: png(), declaredMime: 'image/png' }
        : { data: Buffer.from('report body'), declaredMime: 'text/plain' }),
    }, { stageInboundAttachment });

    const prepared = await service.prepareInbound({
      task: task(), turnId: 'turn_1', chatId: 'oc_1', userId: 'ou_1', externalMessageId: 'om_1',
      resources: [
        { kind: 'image', resourceKey: 'img_1', resourceOwnerMessageId: 'om_1' },
        { kind: 'file', resourceKey: 'file_1', resourceOwnerMessageId: 'om_1', fileName: '../report.txt' },
      ],
    });

    expect(prepared.images).toEqual([{ url: expect.stringMatching(/^data:image\/png;base64,/), detail: 'auto' }]);
    expect(prepared.promptContext).toContain('/workspace/.linkbot/inbox/turn_1/');
    expect(prepared.promptContext).toContain('-report.txt');
    expect(prepared.promptContext).toContain('untrusted user data');
    expect(stageInboundAttachment).toHaveBeenCalledTimes(1);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM media_attachments').get()).toEqual({ count: 2 });
    store.close();
  });

  it('keeps unmentioned group media scoped to the sender and topic until consumed', async () => {
    const root = await createTmpDir();
    const store = new SqliteStateStore(join(root, 'state.sqlite'));
    const service = new MediaService(config(root), store, {
      downloadMessageResource: vi.fn(async () => ({ data: png(), declaredMime: 'image/png' })),
    }, { stageInboundAttachment: vi.fn() });
    await service.capturePending({
      chatId: 'oc_group', topicId: 'omt_1', userId: 'ou_1', externalMessageId: 'om_image',
      resources: [{ kind: 'image', resourceKey: 'img_1', resourceOwnerMessageId: 'om_image' }],
    });

    await expect(service.consumePending({
      task: task(), turnId: 'turn_wrong', chatId: 'oc_group', topicId: 'omt_1', userId: 'ou_2',
    })).resolves.toMatchObject({ attachmentIds: [] });
    const consumed = await service.consumePending({
      task: task(), turnId: 'turn_2', chatId: 'oc_group', topicId: 'omt_1', userId: 'ou_1',
    });
    expect(consumed.attachmentIds).toHaveLength(1);
    expect(consumed.images).toHaveLength(1);
    expect(store.db.prepare('SELECT status FROM pending_media_bindings').get()).toEqual({ status: 'consumed' });
    store.close();
  });

  it('exports task-outbox and shared workspace artifacts and registers them idempotently', async () => {
    const root = await createTmpDir();
    const store = new SqliteStateStore(join(root, 'state.sqlite'));
    const exportArtifact = vi.fn(async (_task, _sourcePath, destination) => {
      await writeFile(destination, Buffer.from('result'));
    });
    const service = new MediaService(config(root), store, {}, { exportArtifact });

    const first = await service.registerArtifact(task(), 'turn_3', {
      path: '/workspace/.linkbot/outbox/result.txt', disposition: 'auto', displayName: 'result.txt',
    });
    const second = await service.registerArtifact(task(), 'turn_3', {
      path: '/workspace/.linkbot/outbox/result.txt', disposition: 'auto', displayName: 'result.txt',
    });

    expect(first.id).toBe(second.id);
    expect(first.kind).toBe('file');
    expect(service.outboundForTurn('task_1', 'turn_3')).toHaveLength(1);
    const shared = await service.registerArtifact({ ...task(), runtimeMode: 'user-sandbox' }, 'turn_3', {
      path: '/workspace/.linkbot/artifacts/report/result.txt', disposition: 'file', displayName: 'shared.txt',
    });
    expect(shared.kind).toBe('file');
    expect(exportArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task_1' }), '/workspace/.linkbot/artifacts/report/result.txt', expect.any(String),
    );
    await expect(service.registerArtifact(task(), 'turn_3', {
      path: '/workspace/.linkbot/artifacts/../secret', disposition: 'file', displayName: 'secret',
    })).rejects.toThrow('workspace artifacts directory');
    await expect(service.registerArtifact(task(), 'turn_3', {
      path: '/home/codex/.codex/auth.json', disposition: 'file', displayName: 'auth.json',
    })).rejects.toThrow('task outbox');
    store.close();
  });

  it('retains expired artifacts while an outbox delivery still references them', async () => {
    const root = await createTmpDir();
    const store = new SqliteStateStore(join(root, 'state.sqlite'));
    const storagePath = join(root, 'object.bin');
    await writeFile(storagePath, 'x');
    const service = new MediaService(config(root), store, {}, {});
    service.saveAttachment({
      id: 'att_expired', direction: 'outbound', kind: 'file', originalName: 'x.bin', safeName: 'x.bin',
      detectedMime: 'application/octet-stream', sizeBytes: 1, sha256: 'hash_1', storagePath,
      chatId: 'oc_1', taskId: 'task_1', turnId: 'turn_1', status: 'exported',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-02T00:00:00.000Z',
    });
    store.db.prepare('INSERT INTO media_objects(sha256,storage_path,detected_mime,size_bytes,created_at) VALUES (?,?,?,?,?)')
      .run('hash_1', storagePath, 'application/octet-stream', 1, '2026-01-01T00:00:00.000Z');
    store.db.prepare(`INSERT INTO outbound_events(id,dedupe_key,target,event_type,status,attempts,payload,created_at,updated_at)
      VALUES ('out_1','send_1','{}','media_send','pending',0,?,'2026-01-01','2026-01-01')`)
      .run(JSON.stringify({ attachmentId: 'att_expired' }));

    await expect(service.cleanupExpired('2026-02-01T00:00:00.000Z')).resolves.toEqual({ attachments: 0, objects: 0 });
    store.db.prepare("UPDATE outbound_events SET status='sent' WHERE id='out_1'").run();
    await expect(service.cleanupExpired('2026-02-01T00:00:00.000Z')).resolves.toEqual({ attachments: 1, objects: 1 });
    expect(service.getAttachment('att_expired')).toBeUndefined();
    store.close();
  });
});

function config(root: string) {
  return {
    enabled: true, storageRoot: join(root, 'media'), maxImagesPerTurn: 8, maxFilesPerTurn: 10,
    maxImageBytes: 10_485_760, maxFileBytes: 52_428_800, maxTotalBytesPerTurn: 104_857_600,
    pendingGroupAttachmentTtlMs: 300_000, retentionHours: 24,
  };
}

function task(): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: 'task_1', ownerUserId: 'ou_1', runtimeMode: 'legacy-task-container', projectId: 'repo',
    baseRef: 'main', branchName: 'task/task_1', runtimeState: 'hot', pinned: false,
    lastUserInteractionAt: now, createdAt: now, updatedAt: now,
  };
}

function png(): Buffer {
  return Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00]);
}
