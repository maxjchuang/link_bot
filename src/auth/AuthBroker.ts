import { createHash,randomUUID } from 'node:crypto';
import type { FeishuOutgoingReply } from '../feishu/FeishuGateway.js';
import type { TaskActorContext } from '../feishu/FeishuTaskController.js';
import { renderToolAuthorizationCard } from '../feishu/TaskPlatformCards.js';
import type {
PendingAuthenticatedTurn,ToolAuthProvider,ToolAuthRequest,ToolAuthResumeContext,
} from './AuthTypes.js';

export interface PendingAuthStore {
  savePendingAuth(record: PendingAuthenticatedTurn): void;
  getPendingAuth(id: string): PendingAuthenticatedTurn | undefined;
  listPendingAuth?(userId: string): PendingAuthenticatedTurn[];
  listPendingAuthAll?(): PendingAuthenticatedTurn[];
  deletePendingAuth(id: string): void;
}

const AUTH_RESUME_LEASE_MS = 60_000;

export class AuthBroker {
  private readonly providers = new Map<string, ToolAuthProvider>();
  private readonly pendingChecks = new Map<string, Promise<FeishuOutgoingReply>>();
  constructor(
    providers: ToolAuthProvider[], private readonly store: PendingAuthStore,
    private readonly resume: (
      turn: TaskActorContext & { text: string }, context: ToolAuthResumeContext,
    ) => Promise<void>,
    private readonly clock: () => Date = () => new Date(),
    private readonly refresh?: (turn: TaskActorContext) => Promise<void>,
    private readonly onBackgroundError?: (turn: PendingAuthenticatedTurn, error: unknown) => Promise<void>,
    private readonly renderAuthorization: (pending: PendingAuthenticatedTurn) => Promise<NonNullable<FeishuOutgoingReply['rendered']>>
      = async (pending) => renderToolAuthorizationCard(pending),
  ) { for (const provider of providers) this.providers.set(provider.id, provider); }

  supports(providerId: string): boolean { return this.providers.has(providerId); }

  async prepare(
    input: TaskActorContext & { text: string },
    detectionText = input.text,
  ): Promise<FeishuOutgoingReply | undefined> {
    let provider: ToolAuthProvider | undefined;
    for (const candidate of this.providers.values()) {
      if (candidate.requiresAuth(detectionText) && !await candidate.isAuthenticated(input.userId)) {
        provider = candidate;
        break;
      }
    }
    if (!provider) return undefined;
    const login = await provider.begin(input.userId);
    const pending: PendingAuthenticatedTurn = {
      ...input, id: `auth_${randomUUID()}`, provider: provider.id, text: input.text,
      ...(input.createdAt ? { triggerCreatedAt: input.createdAt } : {}),
      loginSessionId: login.sessionId, authorizationUrl: login.authorizationUrl,
      expiresAt: login.expiresAt, createdAt: this.clock().toISOString(),
    };
    this.store.savePendingAuth(pending);
    return {
      text: `需要授权 ${provider.id} 后继续。`,
      rendered: await this.renderAuthorization(pending),
    };
  }

  async prepareRequired(
    input: TaskActorContext & { text: string },
    providerId: string,
    request: ToolAuthRequest,
    idempotencyKey: string,
    source?: { taskId?: string; turnId?: string },
  ): Promise<FeishuOutgoingReply> {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error(`Unknown authentication provider: ${providerId}`);
    const pendingId = `auth_${createHash('sha256').update([
      providerId, input.userId, input.chatId, input.topicId ?? '', idempotencyKey,
    ].join('\0')).digest('hex').slice(0, 32)}`;
    const existing = this.store.getPendingAuth(pendingId);
    if (existing && new Date(existing.expiresAt).getTime() > this.clock().getTime()) {
      return { text: `需要授权 ${provider.id} 后继续。`, rendered: await this.renderAuthorization(existing) };
    }
    if (existing) {
      await provider.discard?.(existing.userId, existing.loginSessionId);
      this.store.deletePendingAuth(existing.id);
    }
    const login = await provider.begin(input.userId, request);
    const pending: PendingAuthenticatedTurn = {
      ...input, id: pendingId, provider: provider.id, text: input.text,
      ...(input.createdAt ? { triggerCreatedAt: input.createdAt } : {}),
      loginSessionId: login.sessionId, authorizationUrl: login.authorizationUrl,
      expiresAt: login.expiresAt, createdAt: this.clock().toISOString(),
      ...(request.scopes?.length ? { requestedScopes: [...new Set(request.scopes)].sort() } : {}),
      ...(source?.taskId ? { sourceTaskId: source.taskId } : {}),
      ...(source?.turnId ? { sourceTurnId: source.turnId } : {}),
    };
    this.store.savePendingAuth(pending);
    return { text: `需要授权 ${provider.id} 后继续。`, rendered: await this.renderAuthorization(pending) };
  }

  async check(input: TaskActorContext & { pendingId: string }): Promise<FeishuOutgoingReply> {
    const existing = this.pendingChecks.get(input.pendingId);
    if (existing) return existing;
    const operation = this.checkOnce(input).finally(() => this.pendingChecks.delete(input.pendingId));
    this.pendingChecks.set(input.pendingId, operation);
    return operation;
  }

  private async checkOnce(input: TaskActorContext & { pendingId: string }): Promise<FeishuOutgoingReply> {
    const pending = this.store.getPendingAuth(input.pendingId);
    if (!pending) return { text: '授权请求不存在或已过期。' };
    if (pending.userId !== input.userId) throw new Error('Only the user who requested authorization can continue it.');
    if (!pending.resumeState && new Date(pending.expiresAt).getTime() <= this.clock().getTime()) {
      await this.providers.get(pending.provider)?.discard?.(pending.userId, pending.loginSessionId);
      this.store.deletePendingAuth(pending.id);
      return statusCardReply('授权请求已过期，请重新发送原消息。');
    }
    const provider = this.providers.get(pending.provider);
    if (!provider) throw new Error(`Unknown authentication provider: ${pending.provider}`);
    let authenticated = pending;
    if (!pending.resumeState) {
      const status = await provider.complete(input.userId, pending.loginSessionId);
      if (status === 'pending') return {
        text: '尚未检测到授权，请先在浏览器完成授权后再点“我已授权”。',
        rendered: await this.renderAuthorization(pending),
        delivery: { kind: 'update_origin_card', onFailure: 'reply_text' },
      };
      if (status === 'expired') {
        this.store.deletePendingAuth(pending.id);
        return statusCardReply('授权已过期，请重新发送原消息。');
      }
      authenticated = { ...pending, resumeState: 'authenticated' };
      this.store.savePendingAuth(authenticated);
    }
    const resumeStartedAt = authenticated.resumeStartedAt ? Date.parse(authenticated.resumeStartedAt) : Number.NaN;
    if (authenticated.resumeState === 'resuming' && Number.isFinite(resumeStartedAt)
      && this.clock().getTime() - resumeStartedAt < AUTH_RESUME_LEASE_MS) {
      return statusCardReply('授权已完成，原任务正在恢复，请勿重复点击。');
    }
    const attempt = (authenticated.resumeAttempt ?? 0) + 1;
    const resuming: PendingAuthenticatedTurn = {
      ...authenticated, resumeState: 'resuming', resumeAttempt: attempt,
      resumeStartedAt: this.clock().toISOString(), lastResumeError: undefined,
    };
    this.store.savePendingAuth(resuming);
    const turn = {
      chatId: resuming.chatId, chatType: resuming.chatType, userId: resuming.userId,
      ...(resuming.topicId ? { topicId: resuming.topicId } : {}),
      ...(resuming.messageId ? { messageId: resuming.messageId } : {}), text: resuming.text,
      ...(resuming.rootId ? { rootId: resuming.rootId } : {}),
      ...(resuming.triggerCreatedAt ? { createdAt: resuming.triggerCreatedAt } : {}),
    };
    void (async () => {
      try {
        await this.refresh?.(resuming);
        await this.resume(turn, {
          pendingId: resuming.id, attempt,
          ...(resuming.sourceTaskId ? { sourceTaskId: resuming.sourceTaskId } : {}),
          ...(resuming.sourceTurnId ? { sourceTurnId: resuming.sourceTurnId } : {}),
        });
        this.store.deletePendingAuth(resuming.id);
      } catch (error) {
        const current = this.store.getPendingAuth(resuming.id);
        if (current?.resumeAttempt === attempt) this.store.savePendingAuth({
          ...current, resumeState: 'resume_failed',
          lastResumeError: safeResumeError(error),
        });
        try {
          await this.onBackgroundError?.(resuming, error);
        } catch {
          // The durable resume_failed state above remains the source of truth even
          // when sending the user-facing recovery card also fails.
        }
      }
    })();
    return {
      text: '', rendered: completedAuthorizationCard(pending.provider),
      delivery: { kind: 'delete_origin_message', onFailure: 'reply_rendered' },
    };
  }

  async checkLatest(input: TaskActorContext): Promise<FeishuOutgoingReply | undefined> {
    const candidates = this.store.listPendingAuth?.(input.userId) ?? [];
    const matching = candidates.filter((pending) => pending.chatId === input.chatId
      && pending.chatType === input.chatType && (pending.topicId ?? '') === (input.topicId ?? ''));
    const pending = matching.find((candidate) => candidate.resumeState
      || new Date(candidate.expiresAt).getTime() > this.clock().getTime());
    if (!pending) return undefined;
    return this.check({ ...input, pendingId: pending.id });
  }

  async recoverPendingResumes(): Promise<void> {
    const pending = (this.store.listPendingAuthAll?.() ?? [])
      .filter((candidate) => candidate.resumeState === 'authenticated' || candidate.resumeState === 'resuming');
    await Promise.all(pending.map(async (candidate) => {
      this.store.savePendingAuth({
        ...candidate, resumeState: 'authenticated', resumeStartedAt: undefined,
      });
      await this.check({
        chatId: candidate.chatId, chatType: candidate.chatType, userId: candidate.userId,
        ...(candidate.topicId ? { topicId: candidate.topicId } : {}),
        ...(candidate.messageId ? { messageId: candidate.messageId } : {}),
        pendingId: candidate.id,
      });
    }));
  }

  async project(userId: string, destination: string): Promise<void> {
    for (const provider of this.providers.values()) await provider.project(userId, destination);
  }
}

function safeResumeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]')
    .replace(/("(?:access_token|refresh_token|device_code|app_secret)"\s*:\s*")[^"]+/gi, '$1[redacted]')
    .slice(0, 1_000);
}

function completedAuthorizationCard(provider: string): NonNullable<FeishuOutgoingReply['rendered']> {
  return {
    preferred: { kind: 'card', payload: {
      schema: '2.0', body: { elements: [{ tag: 'markdown', content: `${provider} 授权已完成，任务正在继续。` }] },
    } },
    fallback: { kind: 'text', text: `${provider} 授权已完成，任务正在继续。` },
  };
}

function statusCardReply(text: string): FeishuOutgoingReply {
  return {
    text,
    rendered: {
      preferred: { kind: 'card', payload: { schema: '2.0', body: { elements: [{ tag: 'markdown', content: text }] } } },
      fallback: { kind: 'text', text },
    },
    delivery: { kind: 'update_origin_card', onFailure: 'reply_text' },
  };
}
