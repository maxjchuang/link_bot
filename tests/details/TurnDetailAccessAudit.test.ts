import { createHash } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { createTmpDir } from '../helpers/tmp.js';
import { TurnDetailAccessAudit } from '../../src/details/TurnDetailAccessAudit.js';
import { createTurnDetailRuntime } from '../../src/details/TurnDetailRuntime.js';
import { FeishuTurnDetailController } from '../../src/details/FeishuTurnDetailController.js';
import { artifactAccessPolicy, TurnDetailArtifactService } from '../../src/details/TurnDetailArtifactService.js';
import type { FeishuGateway } from '../../src/feishu/FeishuGateway.js';
import { TurnDetailRecorder } from '../../src/details/TurnDetailRecorder.js';
import { SQLITE_SCHEMA_VERSION } from '../../src/state/SqliteSchema.js';

const identity = { ownerKind: 'task_platform' as const, taskId: 'task', localTurnId: 'turn' };
const hash = (field: string, value: string) => createHash('sha256').update(`${field}\0${value}`).digest('hex');
function history(db: Database.Database, phase = 'outcome'): Array<Record<string, string>> {
  return (db.prepare('SELECT payload FROM audit_events WHERE event_type=? ORDER BY sequence').all(`detail_access.${phase}`) as Array<{ payload: string }>)
    .map(({ payload }) => JSON.parse(payload) as Record<string, string>);
}

async function fixture() {
  const path = join(await createTmpDir(), 'state.sqlite');
  const runtime = createTurnDetailRuntime(path);
  const scope = { kind: 'private_user' as const, chatId: 'private', userId: 'owner' };
  runtime.results!.save(identity, scope, 'public-body-not-for-audit\n'.repeat(300), new Date().toISOString());
  const send = vi.fn(async () => ({ messageId: 'browser' }));
  const replace = vi.fn(async (_id: string, _card: Record<string, unknown>) => undefined);
  const source = vi.fn(async () => ({ chatId: 'private', chatType: 'private' as const }));
  const gateway = { resolveDetailMessageScope: source, isDetailReaderMember: vi.fn(async () => true),
    sendOperationCardToTarget: send, replaceDetailMessageCard: replace,
    uploadFile: vi.fn(async () => 'remote-key'), sendDetailFileToTarget: vi.fn(async () => ({ messageId: 'file-receipt' })) } as unknown as FeishuGateway;
  const input = { chatId: 'private', chatType: 'private' as const, userId: 'owner', messageId: 'source-card',
    action: { kind: 'turn_detail' as const, cardRef: runtime.views!.registerCard(identity), category: 'result' as const } };
  return { path, runtime, input, gateway, send, replace, source, db: new Database(path) };
}

describe('per-access detail audit', () => {
  it('records verification outages as unavailable rather than an actor denial, without publishing content', async () => {
    const f = await fixture();
    const controller = new FeishuTurnDetailController(f.runtime.store!, f.runtime.resources!, f.runtime.views!, f.gateway,
      undefined, f.runtime.results, undefined, f.runtime.telemetry, f.runtime.audit);
    try {
      f.source.mockRejectedValueOnce(new Error('fake-sensitive-upstream-error'));
      expect((await controller.handle(f.input)).text).toContain('暂时无法核验');
      expect(history(f.db).at(-1)!.outcome).toBe('unavailable');
      expect(f.send).not.toHaveBeenCalled();
      expect(f.replace).not.toHaveBeenCalled();
      expect(JSON.stringify(history(f.db))).not.toContain('fake-sensitive-upstream-error');
    } finally { await f.runtime.close(); f.db.close(); }
  });
  it('stores bounded allowlisted metadata only, fingerprints IDs and does not deduplicate attempts', async () => {
    const path = join(await createTmpDir(), 'state.sqlite');
    const audit = new TurnDetailAccessAudit(path, () => new Date('2026-10-15T00:00:00Z'));
    const db = new Database(path);
    try {
      const attempt = { operation: 'view' as const, category: 'commands' as const, actorId: 'token=fake-actor-secret',
        sourceMessageId: 'source', cardRef: 'token=fake-selector-secret', body: 'fake-raw-body', error: 'fake-raw-error', identity };
      const first = audit.begin(attempt); first.finish('served', identity); first.finish('served', identity);
      audit.begin(attempt).finish('duplicate', identity);
      expect(history(db, 'attempt')).toHaveLength(2); expect(history(db)).toHaveLength(2);
      const text = JSON.stringify(db.prepare('SELECT * FROM audit_events').all());
      for (const secret of ['fake-actor-secret', 'fake-selector-secret', 'fake-raw-body', 'fake-raw-error']) expect(text).not.toContain(secret);
      expect(history(db)[0]).toMatchObject({ actorIdHash: hash('actorId', attempt.actorId), sourceMessageIdHash: hash('sourceMessageId', 'source'),
        turnHash: hash('turn', JSON.stringify([identity.ownerKind, identity.taskId, identity.localTurnId])) });
      expect(history(db)[0]!.attemptId).not.toBe(history(db)[1]!.attemptId);
      expect(() => audit.begin({ ...attempt, actorId: 'x'.repeat(4097) })).toThrow('invalid_detail_audit');
      expect(() => audit.begin({ ...attempt, category: 'fake-category-secret' as never })).toThrow('invalid_detail_audit');
      const invalid = audit.begin(attempt);
      expect(() => invalid.finish('fake-outcome-secret' as never)).toThrow('invalid_detail_audit');
      expect(JSON.stringify(db.prepare('SELECT * FROM audit_events').all())).not.toContain('fake-outcome-secret');
    } finally { audit.close(); db.close(); }
  });

  it('audits every served page, duplicate, refusal and transport failure across restart', async () => {
    const f = await fixture();
    let runtime = f.runtime;
    const controller = () => new FeishuTurnDetailController(runtime.store!, runtime.resources!, runtime.views!, f.gateway,
      undefined, runtime.results, undefined, runtime.telemetry, runtime.audit);
    try {
      await controller().handle(f.input);
      await controller().handle(f.input);
      const cursorRef = JSON.stringify(f.replace.mock.calls.at(-1)![1]).match(/"cursorRef":"([a-f0-9]{32})"/)![1]!;
      await controller().handle({ ...f.input, action: { ...f.input.action, cursorRef } });
      await controller().handle({ ...f.input, userId: 'other' });
      await controller().handle({ ...f.input, action: { ...f.input.action, cursorRef: 'f'.repeat(32) } });
      await controller().handle({ ...f.input, action: { ...f.input.action, cardRef: 'f'.repeat(32) } });
      f.replace.mockRejectedValueOnce(new Error('fake-network-secret'));
      await controller().handle(f.input);
      expect(history(f.db).map((row) => row.outcome)).toEqual(['served', 'duplicate', 'served', 'denied', 'invalid_cursor', 'not_found', 'unavailable']);
      expect(history(f.db, 'attempt')).toHaveLength(7);
      expect(history(f.db).filter((row) => row.operation === 'page')).toHaveLength(2);
      await runtime.close(); runtime = createTurnDetailRuntime(f.path);
      await controller().handle(f.input);
      expect(history(f.db).at(-1)!.outcome).toBe('served');
      expect(f.send).toHaveBeenCalledOnce();
      const persisted = JSON.stringify(f.db.prepare('SELECT * FROM audit_events').all());
      expect(persisted).not.toContain('public-body-not-for-audit');
      expect(persisted).not.toContain('fake-network-secret');
    } finally { await runtime.close(); f.db.close(); }
  });

  it('refuses reads before source lookup or disclosure when the audit writer is locked or missing', async () => {
    const f = await fixture();
    const controller = new FeishuTurnDetailController(f.runtime.store!, f.runtime.resources!, f.runtime.views!, f.gateway,
      undefined, f.runtime.results, undefined, undefined, f.runtime.audit);
    try {
      f.db.exec('BEGIN IMMEDIATE');
      expect((await controller.handle(f.input)).text).toContain('暂不可用');
      expect(f.source).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
      const service = new TurnDetailArtifactService(f.runtime.store!, f.runtime.resources!, f.runtime.results!,
        (actor) => artifactAccessPolicy(f.gateway, actor), f.gateway, undefined, undefined, undefined, undefined, f.runtime.audit);
      await expect(service.deliver({ identity, category: 'result', actor: { userId: 'owner', sourceMessageId: 'source-card' },
        ...service.snapshot(identity, 'result') }, 'locked-audit')).rejects.toThrow('detail_audit_unavailable');
      expect(f.gateway.uploadFile).not.toHaveBeenCalled(); expect(f.gateway.sendDetailFileToTarget).not.toHaveBeenCalled();
      f.db.exec('ROLLBACK');
      const missing = new FeishuTurnDetailController(f.runtime.store!, f.runtime.resources!, f.runtime.views!, f.gateway, undefined, f.runtime.results);
      expect((await missing.handle(f.input)).text).toContain('暂不可用');
      expect(f.source).not.toHaveBeenCalled();
      expect((await controller.handle(f.input)).text).toBe('');
      expect(history(f.db).map((row) => row.outcome)).toEqual(['served']);
    } finally { if (f.db.inTransaction) f.db.exec('ROLLBACK'); await f.runtime.close(); f.db.close(); }
  });

  it('leaves a durable unresolved attempt if the outcome write fails after disclosure, and retries idempotently', async () => {
    const f = await fixture();
    const controller = new FeishuTurnDetailController(f.runtime.store!, f.runtime.resources!, f.runtime.views!, f.gateway,
      undefined, f.runtime.results, undefined, undefined, f.runtime.audit);
    try {
      f.db.exec(`CREATE TRIGGER fail_detail_audit BEFORE INSERT ON audit_events WHEN NEW.event_type='detail_access.outcome'
        BEGIN SELECT RAISE(ABORT,'fake-audit-error-secret'); END`);
      const reply = await controller.handle(f.input);
      expect(reply.text).toContain('暂不可用'); expect(reply.text).not.toContain('fake-audit-error-secret');
      expect(f.send).toHaveBeenCalledOnce();
      expect(history(f.db, 'attempt')).toHaveLength(1); expect(history(f.db)).toHaveLength(0);
      f.db.exec('DROP TRIGGER fail_detail_audit');
      expect((await controller.handle(f.input)).text).toBe('');
      expect(f.send).toHaveBeenCalledOnce();
      expect(history(f.db, 'attempt')).toHaveLength(2);
      expect(history(f.db).map((row) => row.outcome)).toEqual(['duplicate']);
      expect(history(f.db)[0]!.attemptId).not.toBe(history(f.db, 'attempt')[0]!.attemptId);
    } finally { await f.runtime.close(); f.db.close(); }
  });

  it('audits download enqueue separately from every delivery retry and denies revoked readers before transport', async () => {
    const f = await fixture();
    const service = new TurnDetailArtifactService(f.runtime.store!, f.runtime.resources!, f.runtime.results!,
      (actor) => artifactAccessPolicy(f.gateway, actor), f.gateway, undefined, undefined, undefined, undefined, f.runtime.audit);
    const requests: Parameters<TurnDetailArtifactService['deliver']>[0][] = [];
    const controller = new FeishuTurnDetailController(f.runtime.store!, f.runtime.resources!, f.runtime.views!, f.gateway,
      undefined, f.runtime.results, { service, enqueue: (request) => { requests.push(request); } }, undefined, f.runtime.audit);
    try {
      expect((await controller.handle({ ...f.input, action: { ...f.input.action, download: true } })).text).toContain('已排队');
      const request = requests[0]!;
      await service.deliver(request, 'delivery-retry-key');
      await service.deliver(request, 'delivery-retry-key');
      f.source.mockResolvedValueOnce(undefined as never);
      await expect(service.deliver(request, 'delivery-retry-key')).rejects.toThrow('access_denied');
      expect(f.gateway.sendDetailFileToTarget).toHaveBeenCalledTimes(2);
      expect(history(f.db).map((row) => [row.operation, row.outcome])).toEqual([
        ['download_request', 'queued'], ['download_delivery', 'delivered'], ['download_delivery', 'delivered'], ['download_delivery', 'denied'],
      ]);
      const deliveries = history(f.db).filter((row) => row.operation === 'download_delivery');
      expect(new Set(deliveries.map((row) => row.attemptId)).size).toBe(3);
      expect(new Set(deliveries.map((row) => row.deliveryKeyHash)).size).toBe(1);
      const missing = new TurnDetailArtifactService(f.runtime.store!, f.runtime.resources!, f.runtime.results!,
        (actor) => artifactAccessPolicy(f.gateway, actor), f.gateway);
      await expect(missing.deliver(request, 'missing-audit')).rejects.toThrow('detail_audit_unavailable');
      expect(f.gateway.sendDetailFileToTarget).toHaveBeenCalledTimes(2);
    } finally { await f.runtime.close(); f.db.close(); }
  });

  it('audits busy downloads without unlocking another in-flight delivery', async () => {
    const f = await fixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const upload = vi.mocked(f.gateway.uploadFile!);
    upload.mockImplementationOnce(async () => { await blocked; return 'key'; });
    const service = new TurnDetailArtifactService(f.runtime.store!, f.runtime.resources!, f.runtime.results!,
      (actor) => artifactAccessPolicy(f.gateway, actor), f.gateway, undefined, undefined, undefined, undefined, f.runtime.audit);
    const request = { identity, category: 'result' as const, actor: { userId: 'owner', sourceMessageId: 'source-card' }, ...service.snapshot(identity, 'result') };
    let first: Promise<unknown> | undefined;
    try {
      first = service.deliver(request, 'one');
      await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
      await expect(service.deliver(request, 'two')).rejects.toThrow('artifact_busy');
      await expect(service.deliver(request, 'three')).rejects.toThrow('artifact_busy');
      release(); await first;
      expect(upload).toHaveBeenCalledOnce();
      expect(history(f.db).map((row) => row.outcome)).toEqual(['busy', 'busy', 'delivered']);
    } finally { release(); await first; await f.runtime.close(); f.db.close(); }
  });

  it('does not claim a known external delivery was undone by a later media-index error', async () => {
    const f = await fixture();
    const service = new TurnDetailArtifactService(f.runtime.store!, f.runtime.resources!, f.runtime.results!,
      (actor) => artifactAccessPolicy(f.gateway, actor), f.gateway,
      { getAttachment: () => undefined, saveAttachment: (record) => { if (record.status === 'sent') throw new Error('fake-index-error-secret'); } },
      undefined, undefined, undefined, f.runtime.audit);
    try {
      await expect(service.deliver({ identity, category: 'result', actor: { userId: 'owner', sourceMessageId: 'source-card' },
        ...service.snapshot(identity, 'result') }, 'post-delivery-error')).rejects.toThrow('fake-index-error-secret');
      expect(f.gateway.sendDetailFileToTarget).toHaveBeenCalledOnce();
      expect(history(f.db).map((row) => row.outcome)).toEqual(['delivered']);
      expect(JSON.stringify(f.db.prepare('SELECT * FROM audit_events').all())).not.toContain('fake-index-error-secret');
    } finally { await f.runtime.close(); f.db.close(); }
  });

  it('leaves download outcomes unresolved on audit failure after a platform receipt', async () => {
    const f = await fixture();
    const service = new TurnDetailArtifactService(f.runtime.store!, f.runtime.resources!, f.runtime.results!,
      (actor) => artifactAccessPolicy(f.gateway, actor), f.gateway, undefined, undefined, undefined, undefined, f.runtime.audit);
    try {
      f.db.exec(`CREATE TRIGGER fail_detail_audit BEFORE INSERT ON audit_events WHEN NEW.event_type='detail_access.outcome'
        BEGIN SELECT RAISE(ABORT,'fake-delivery-audit-secret'); END`);
      await expect(service.deliver({ identity, category: 'result', actor: { userId: 'owner', sourceMessageId: 'source-card' },
        ...service.snapshot(identity, 'result') }, 'post-delivery-audit-error')).rejects.toThrow('detail_audit_unavailable');
      expect(f.gateway.sendDetailFileToTarget).toHaveBeenCalledOnce();
      expect(history(f.db, 'attempt')).toHaveLength(1); expect(history(f.db)).toHaveLength(0);
      expect(JSON.stringify(f.db.prepare('SELECT * FROM audit_events').all())).not.toContain('fake-delivery-audit-secret');
    } finally { await f.runtime.close(); f.db.close(); }
  });

  it('audits stale and expired snapshots without uploading retained bodies', async () => {
    const f = await fixture();
    const now = '2026-10-15T00:00:00Z';
    f.runtime.store!.createTurn({ ...identity, schemaVersion: 1, threadId: 'thread',
      scope: { kind: 'private_user', chatId: 'private', userId: 'owner' }, startedAt: now,
      lifecycle: 'running', availability: 'available', retainedBytes: 0, truncated: false });
    const recorder = new TurnDetailRecorder(f.runtime.store!, f.runtime.resources!);
    recorder.record(identity, { kind: 'command_item', itemId: 'cmd', command: 'pwd', completed: false }, 'cmd', now);
    const service = new TurnDetailArtifactService(f.runtime.store!, f.runtime.resources!, f.runtime.results!,
      (actor) => artifactAccessPolicy(f.gateway, actor), f.gateway, undefined, () => new Date(now), undefined, undefined, f.runtime.audit);
    const request = { identity, category: 'commands' as const, actor: { userId: 'owner', sourceMessageId: 'source-card' }, ...service.snapshot(identity, 'commands') };
    try {
      recorder.record(identity, { kind: 'command_delta', itemId: 'cmd', stream: 'combined', text: 'safe line\n' }, 'delta', now);
      await expect(service.deliver(request, 'stale')).rejects.toThrow('snapshot_changed');
      f.runtime.store!.completeTurn(identity, 'completed', '2020-01-01T00:00:00Z');
      await expect(service.deliver({ ...request, ...service.snapshot(identity, 'commands') }, 'expired')).rejects.toThrow('expired');
      expect(f.gateway.uploadFile).not.toHaveBeenCalled();
      expect(history(f.db).map((row) => row.outcome)).toEqual(['snapshot_changed', 'expired']);
    } finally { await f.runtime.close(); f.db.close(); }
  });

  it('preserves audit history while migrating the semantic rollback floor from schema 30', async () => {
    const path = join(await createTmpDir(), 'state.sqlite');
    let audit = new TurnDetailAccessAudit(path);
    audit.begin({ operation: 'view', category: 'result', actorId: 'owner' }).finish('served');
    audit.close();
    const db = new Database(path);
    try {
      db.exec('UPDATE detail_security_contract SET version=1; PRAGMA user_version=30');
      const before = history(db);
      audit = new TurnDetailAccessAudit(path);
      expect(db.pragma('user_version', { simple: true })).toBe(SQLITE_SCHEMA_VERSION);
      expect(SQLITE_SCHEMA_VERSION).toBe(33);
      expect(db.prepare('SELECT version FROM detail_security_contract WHERE id=1').get()).toEqual({ version: 3 });
      expect(history(db)).toEqual(before);
    } finally { audit.close(); db.close(); }
  });
});
