import { describe, expect, it, vi } from 'vitest';
import { AuthBroker } from '../../src/auth/AuthBroker.js';
import type { PendingAuthenticatedTurn, ToolAuthProvider } from '../../src/auth/AuthTypes.js';

describe('AuthBroker', () => {
  it('pauses a matching turn and resumes it after the same openid completes authorization', async () => {
    const rows = new Map<string, PendingAuthenticatedTurn>();
    const provider = fakeProvider();
    const resume = vi.fn(async () => undefined);
    const broker = new AuthBroker([provider], {
      savePendingAuth: (row) => rows.set(row.id, row),
      getPendingAuth: (id) => rows.get(id),
      deletePendingAuth: (id) => { rows.delete(id); },
    }, resume, () => new Date('2026-08-03T00:00:00Z'));

    const reply = await broker.prepare(actor('ou_one', '查看 https://github.com/example/repo 的 MR'));
    expect(reply?.rendered?.preferred.kind).toBe('card');
    expect(resume).not.toHaveBeenCalled();
    const pending = [...rows.values()][0];
    expect(pending?.userId).toBe('ou_one');

    await expect(broker.check({ ...actor('ou_two', ''), pendingId: pending!.id })).rejects.toThrow('Only the user');
    provider.complete = vi.fn(async (): Promise<'authenticated'> => 'authenticated');
    await expect(broker.check({ ...actor('ou_one', ''), pendingId: pending!.id })).resolves.toMatchObject({
      text: '', delivery: { kind: 'delete_origin_message' },
    });
    await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'ou_one', text: expect.stringContaining('github.com') }),
      expect.objectContaining({ pendingId: pending!.id, attempt: 1 }),
    );
    await vi.waitFor(() => expect(rows.size).toBe(0));
  });

  it('does not interrupt messages that do not require provider authentication', async () => {
    const broker = new AuthBroker([fakeProvider()], emptyStore(), vi.fn());
    await expect(broker.prepare(actor('ou_one', '当前工作区干净吗'))).resolves.toBeUndefined();
  });

  it('uses conversation detection text without replacing the resumed user message', async () => {
    const rows = new Map<string, PendingAuthenticatedTurn>();
    const provider = fakeProvider();
    provider.requiresAuth = (text) => text.includes('github.com');
    const broker = new AuthBroker([provider], {
      savePendingAuth: (row) => rows.set(row.id, row),
      getPendingAuth: (id) => rows.get(id),
      deletePendingAuth: (id) => { rows.delete(id); },
    }, vi.fn());

    await expect(broker.prepare(actor('ou_one', '重试'), '原任务：https://github.com/example/repo')).resolves.toBeDefined();
    expect([...rows.values()][0]?.text).toBe('重试');
  });

  it('creates one idempotent scoped authorization request and records its source turn', async () => {
    const rows = new Map<string, PendingAuthenticatedTurn>();
    const provider = { ...fakeProvider(), id: 'lark' };
    const store = {
      savePendingAuth: (row: PendingAuthenticatedTurn) => rows.set(row.id, row),
      getPendingAuth: (id: string) => rows.get(id),
      deletePendingAuth: (id: string) => { rows.delete(id); },
    };
    const broker = new AuthBroker([provider], store, vi.fn(), () => new Date('2026-08-03T00:00:00Z'));
    const input = actor('ou_one', '读取示例记录');

    const first = await broker.prepareRequired(input, 'lark', { scopes: ['base:record:read'] }, 'turn_1', {
      taskId: 'task_1', turnId: 'turn_1',
    });
    const second = await broker.prepareRequired(input, 'lark', { scopes: ['base:record:read'] }, 'turn_1');

    expect(first.rendered).toEqual(second.rendered);
    expect(provider.begin).toHaveBeenCalledOnce();
    expect(provider.begin).toHaveBeenCalledWith('ou_one', { scopes: ['base:record:read'] });
    expect([...rows.values()][0]).toMatchObject({
      requestedScopes: ['base:record:read'], sourceTaskId: 'task_1', sourceTurnId: 'turn_1',
    });
  });

  it('accepts a natural-language authorization confirmation in the same conversation', async () => {
    const rows = new Map<string, PendingAuthenticatedTurn>();
    const provider = fakeProvider();
    provider.complete = vi.fn(async (): Promise<'authenticated'> => 'authenticated');
    const resume = vi.fn(async () => undefined);
    const store = {
      savePendingAuth: (row: PendingAuthenticatedTurn) => rows.set(row.id, row),
      getPendingAuth: (id: string) => rows.get(id),
      listPendingAuth: () => [...rows.values()],
      deletePendingAuth: (id: string) => { rows.delete(id); },
    };
    const broker = new AuthBroker([provider], store, resume, () => new Date('2026-08-03T00:00:00Z'));
    await broker.prepare(actor('ou_one', '查看 https://github.com/example/repo'));

    await expect(broker.checkLatest(actor('ou_one', '已授权'))).resolves.toMatchObject({ text: '' });
    await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
  });

  it('retains authenticated state after resume failure and retries without another login', async () => {
    const rows = new Map<string, PendingAuthenticatedTurn>();
    const provider = fakeProvider();
    provider.complete = vi.fn(async (): Promise<'authenticated'> => 'authenticated');
    const resume = vi.fn()
      .mockRejectedValueOnce(new Error('turn start rejected'))
      .mockResolvedValueOnce(undefined);
    const onBackgroundError = vi.fn(async () => undefined);
    let now = new Date('2026-08-03T00:00:00Z');
    const store = {
      savePendingAuth: (row: PendingAuthenticatedTurn) => rows.set(row.id, row),
      getPendingAuth: (id: string) => rows.get(id),
      listPendingAuth: () => [...rows.values()],
      deletePendingAuth: (id: string) => { rows.delete(id); },
    };
    const broker = new AuthBroker(
      [provider], store, resume, () => now, undefined, onBackgroundError,
    );
    await broker.prepare(actor('ou_one', '查看 https://github.com/example/repo'));
    const pending = [...rows.values()][0]!;

    await broker.check({ ...actor('ou_one', ''), pendingId: pending.id });
    await vi.waitFor(() => expect(rows.get(pending.id)?.resumeState).toBe('resume_failed'));
    expect(rows.get(pending.id)).toMatchObject({ resumeAttempt: 1, lastResumeError: 'turn start rejected' });
    expect(onBackgroundError).toHaveBeenCalledOnce();

    now = new Date('2026-08-03T01:00:00Z');
    await broker.check({ ...actor('ou_one', ''), pendingId: pending.id });
    await vi.waitFor(() => expect(rows.has(pending.id)).toBe(false));
    expect(provider.complete).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({ pendingId: pending.id, attempt: 1 }));
    expect(resume).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({ pendingId: pending.id, attempt: 2 }));
  });

  it('coalesces concurrent authorization checks into one task resume', async () => {
    const rows = new Map<string, PendingAuthenticatedTurn>();
    const provider = fakeProvider();
    provider.complete = vi.fn(async (): Promise<'authenticated'> => 'authenticated');
    const resume = vi.fn(async () => undefined);
    const broker = new AuthBroker([provider], {
      savePendingAuth: (row) => rows.set(row.id, row),
      getPendingAuth: (id) => rows.get(id),
      deletePendingAuth: (id) => { rows.delete(id); },
    }, resume, () => new Date('2026-08-03T00:00:00Z'));
    await broker.prepare(actor('ou_one', '查看 https://github.com/example/repo'));
    const pending = [...rows.values()][0]!;

    await Promise.all([
      broker.check({ ...actor('ou_one', ''), pendingId: pending.id }),
      broker.check({ ...actor('ou_one', ''), pendingId: pending.id }),
    ]);
    await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
    expect(provider.complete).toHaveBeenCalledOnce();
  });
});

function actor(userId: string, text: string) {
  return { chatId: 'oc_chat', chatType: 'private' as const, userId, text };
}

function fakeProvider(): ToolAuthProvider {
  return {
    id: 'repository', requiresAuth: (text) => text.includes('github.com'),
    isAuthenticated: vi.fn(async () => false),
    begin: vi.fn(async () => ({ sessionId: 'login_1', authorizationUrl: 'https://auth.example', expiresAt: '2026-08-03T00:10:00Z' })),
    complete: vi.fn(async (): Promise<'pending'> => 'pending'), project: vi.fn(async () => false),
  };
}

function emptyStore() {
  return { savePendingAuth: vi.fn(), getPendingAuth: vi.fn(), deletePendingAuth: vi.fn() };
}
