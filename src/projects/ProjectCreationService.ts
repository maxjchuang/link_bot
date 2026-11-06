import { randomUUID } from 'node:crypto';
import type { TaskActorContext } from '../feishu/FeishuTaskController.js';
import type { SqliteStateStore } from '../state/SqliteStateStore.js';
import { conversationTaskIdentity } from '../tasks/ConversationTaskService.js';
import { taskMode } from '../tasks/TaskTypes.js';
import type { DynamicProjectRecord, ProjectCreationOperation } from './DynamicProjectTypes.js';
import type { SandboxRepoRequest, SandboxRepoResult } from './SandboxRepositoryCreationTypes.js';

export type ProjectCreationFields = {
  provider?: 'github'; namespace?: string; name?: string;
  description?: string;
};

export interface ProjectCreationExecutionPorts {
  create(actor: TaskActorContext, request: SandboxRepoRequest): Promise<SandboxRepoResult>;
  readback(actor: TaskActorContext, request: SandboxRepoRequest): Promise<SandboxRepoResult>;
  bind(actor: TaskActorContext, projectId: string, onCheckoutReady?: () => void | Promise<void>): Promise<{ taskId: string; projectId: string }>;
  isProjectIdTaken?(projectId: string): boolean;
}

export class ProjectCreationService {
  private execution?: ProjectCreationExecutionPorts;
  constructor(
    private readonly store: SqliteStateStore,
    private readonly validate: (actor: TaskActorContext, request: SandboxRepoRequest) => Promise<SandboxRepoResult>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  setExecutionPorts(ports: ProjectCreationExecutionPorts): void { this.execution = ports; }

  async executeConfirmed(operationId: string): Promise<ProjectCreationOperation> {
    const initial = this.store.getProjectCreationOperation(operationId);
    if (!initial) throw new Error('Project creation operation not found.');
    const execution = this.execution;
    if (!execution) throw new Error('Repository creation execution is unavailable.');
    return this.store.withTaskLock(`project-creation:${initial.chatId}:${initial.topicId}`, async () => {
      let operation = this.store.getProjectCreationOperation(operationId)!;
      if (operation.status === 'bound' || operation.status === 'failed') return operation;
      if (!['creating', 'remote_created', 'registered', 'checkout_ready'].includes(operation.status)) {
        throw new Error('Repository creation has not been confirmed.');
      }
      const actor: TaskActorContext = {
        chatType: 'group', chatId: operation.chatId, topicId: operation.topicId, userId: operation.ownerUserId,
      };
      if (operation.status === 'creating') {
        if (!operation.confirmedMessageId) throw new Error('Repository creation lacks Feishu confirmation.');
        const request = creationRequest(operation, operation.createAttemptedAt ? 'readback' : 'create');
        if (!operation.createAttemptedAt) {
          const attempted = this.store.transitionProjectCreationOperation(operationId, 'creating', {
            status: 'creating', createAttemptedAt: this.clock().toISOString(), updatedAt: this.clock().toISOString(),
          });
          if (!attempted) throw new Error('Repository creation state changed before dispatch.');
          operation = attempted;
        }
        let result: SandboxRepoResult;
        try {
          result = request.action === 'readback'
            ? await execution.readback(actor, request)
            : await execution.create(actor, request);
        } catch (error) {
          this.recordFailure(operation, error);
          throw error;
        }
        if (result.status === 'exists_foreign') {
          return this.transition(operation, 'failed', { failure: 'repository_exists_foreign' });
        }
        if (result.status === 'auth_required'
          && ['github_login_required', 'git_bootstrap_failed'].includes(result.reason ?? '')) {
          // The first two codes precede provider creation. For Git bootstrap,
          // the sandbox helper already persisted a same-operation receipt and
          // a repeated helper call resumes bootstrap without creating again.
          return this.transition(operation, 'creating', {
            createAttemptedAt: undefined, failure: result.reason,
          });
        }
        if (result.status !== 'created') {
          this.recordFailure(operation, result.reason ?? `repository_${result.status}`);
          return this.store.getProjectCreationOperation(operationId)!;
        }
        assertRemoteResult(operation, result);
        operation = this.transition(operation, 'remote_created', {
          providerRepoId: result.providerRepoId, cloneUrl: result.cloneUrl,
          defaultBranch: result.defaultBranch, failure: undefined,
        });
      }
      if (operation.status === 'remote_created') {
        try {
          const registered = this.registerRemote(operation);
          operation = this.transition(operation, 'registered', { projectId: registered.id });
        } catch (error) {
          this.recordFailure(operation, error);
          throw error;
        }
      }
      if (operation.status === 'registered') {
        const task = this.taskForOperation(operation);
        if (task.mode !== 'project' || task.projectId !== operation.projectId) {
          try {
            await execution.bind(actor, operation.projectId!, () => {
              operation = this.transition(operation, 'checkout_ready', { failure: undefined });
            });
          } catch (error) {
            this.recordFailure(operation, error);
            throw error;
          }
        }
        const current = this.taskForOperation(operation);
        if (current.mode !== 'project' || current.projectId !== operation.projectId) return operation;
        if (operation.status === 'registered') operation = this.transition(operation, 'checkout_ready', { failure: undefined });
      }
      if (operation.status === 'checkout_ready') {
        const current = this.taskForOperation(operation);
        if (current.mode !== 'project' || current.projectId !== operation.projectId) {
          await execution.bind(actor, operation.projectId!);
          if (this.taskForOperation(operation).mode !== 'project') return operation;
        }
        operation = this.transition(operation, 'bound', { failure: undefined });
        const project = this.store.getDynamicProject(operation.projectId!);
        if (project) this.store.saveDynamicProject({ ...project, state: 'active', updatedAt: this.clock().toISOString() });
      }
      return operation;
    });
  }

  async recoverOpenOperations(): Promise<void> {
    for (const operation of this.store.listOpenProjectCreationOperations()) {
      if (!['creating', 'remote_created', 'registered', 'checkout_ready'].includes(operation.status)) continue;
      try { await this.executeConfirmed(operation.operationId); }
      catch { /* Durable state and a sanitized failure remain available for a later retry. */ }
    }
  }

  private transition(
    operation: ProjectCreationOperation, status: ProjectCreationOperation['status'],
    update: Partial<ProjectCreationOperation> = {},
  ): ProjectCreationOperation {
    const next = this.store.transitionProjectCreationOperation(operation.operationId, operation.status, {
      ...update, status, updatedAt: this.clock().toISOString(),
    });
    if (!next) throw new Error('Repository creation state changed concurrently.');
    return next;
  }

  private recordFailure(operation: ProjectCreationOperation, error: unknown): void {
    const message = (error instanceof Error ? error.message : String(error))
      .replace(/gh[pousr]_[A-Za-z0-9]{20,}|Bearer\s+\S+|(?:access|refresh)[_-]?token\s*[:=]\s*\S+/gi, '[redacted]')
      .slice(0, 400);
    this.store.transitionProjectCreationOperation(operation.operationId, operation.status, {
      status: operation.status, failure: message, updatedAt: this.clock().toISOString(),
    });
  }

  private registerRemote(operation: ProjectCreationOperation): DynamicProjectRecord {
    if (!operation.provider || !operation.providerRepoId || !operation.namespace || !operation.name
      || !operation.cloneUrl || !operation.defaultBranch) throw new Error('Remote identity is incomplete.');
    const existing = this.store.getDynamicProjectByProviderRepoId(operation.provider, operation.providerRepoId, operation);
    if (existing) {
      if (existing.ownerUserId !== operation.ownerUserId || existing.chatId !== operation.chatId
        || existing.topicId !== operation.topicId || existing.namespace !== operation.namespace
        || existing.name !== operation.name) throw new Error('Remote repository identity belongs to another topic.');
      return existing;
    }
    let id: string;
    do { id = `dyn_${randomUUID().replace(/-/g, '')}`; }
    while (this.store.getDynamicProject(id) || this.execution?.isProjectIdTaken?.(id));
    const now = this.clock().toISOString();
    const project: DynamicProjectRecord = {
      id, provider: operation.provider, providerRepoId: operation.providerRepoId,
      namespace: operation.namespace, name: operation.name, cloneUrl: operation.cloneUrl,
      defaultBranch: operation.defaultBranch, ownerUserId: operation.ownerUserId,
      chatId: operation.chatId, topicId: operation.topicId, state: 'registered',
      createdAt: now, updatedAt: now,
    };
    this.store.saveDynamicProject(project);
    return project;
  }

  private taskForOperation(operation: ProjectCreationOperation) {
    const actor: TaskActorContext = {
      chatType: 'group', chatId: operation.chatId, topicId: operation.topicId, userId: operation.ownerUserId,
    };
    const scope = this.store.getTaskScopeByKey(conversationTaskIdentity(actor).scopeKey);
    const task = scope ? this.store.getTask(scope.taskId) : undefined;
    if (!task || task.ownerUserId !== operation.ownerUserId) throw new Error('Original topic task is unavailable.');
    return task;
  }

  async prepare(actor: TaskActorContext, fields: ProjectCreationFields): Promise<{ text: string; operationId?: string }> {
    this.requireChatRequester(actor);
    const topicId = actor.topicId;
    if (!topicId) throw new Error('Repository creation requires a group topic.');
    const lockKey = `project-creation:${actor.chatId}:${topicId}`;
    return this.store.withTaskLock(lockKey, async () => {
      const now = this.clock();
      let existing = this.store.getOpenProjectCreationOperationForTopic(actor.chatId, topicId);
      if (existing && ['collecting', 'awaiting_confirmation'].includes(existing.status)
        && Date.parse(existing.expiresAt) <= now.getTime()) {
        this.store.transitionProjectCreationOperation(existing.operationId, existing.status, {
          status: 'failed', failure: 'confirmation_expired', updatedAt: now.toISOString(),
        });
        existing = undefined;
      }
      if (existing && existing.ownerUserId !== actor.userId) {
        return { text: '当前话题已有其他请求者的待创建仓库请求，请等待其完成或过期。' };
      }
      if (existing && existing.status !== 'collecting') {
        return { text: existing.summaryText ?? `仓库创建请求 ${existing.operationId} 正在处理中。`,
          operationId: existing.operationId };
      }
      const current: ProjectCreationOperation = existing ?? {
        operationId: `op_${randomUUID()}`, ownerUserId: actor.userId, chatId: actor.chatId, topicId,
        status: 'collecting', expiresAt: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
        createdAt: now.toISOString(), updatedAt: now.toISOString(),
      };
      const draft = { ...current, ...normalizedFields(fields), updatedAt: now.toISOString() };
      this.store.saveProjectCreationOperation(draft);
      if (!draft.provider) return { text: '请确认是否要在 GitHub 创建仓库。' };
      if (!draft.namespace) return { text: '请提供仓库所属的 namespace 或 GitHub owner。' };
      if (!draft.name) return { text: '请提供要创建的仓库名。' };
      const request: SandboxRepoRequest = {
        action: 'validate', operationId: draft.operationId, provider: draft.provider,
        namespace: draft.namespace, name: draft.name, private: true,
        ...(draft.description ? { description: draft.description } : {}),
      } as SandboxRepoRequest;
      const validation = await this.validate(actor, request);
      if (validation.status === 'auth_required') {
        return { text: `请先在你自己的沙箱中登录 ${providerLabel(draft.provider)}，登录完成后再继续当前仓库创建请求。` };
      }
      if (validation.status === 'exists_foreign') {
        return { text: `仓库 ${draft.namespace}/${draft.name} 已存在；不会将现有仓库当作本次创建结果。请换一个名称。` };
      }
      if (validation.status !== 'ready') return { text: '仓库创建参数未通过提供方校验；请检查命名空间、权限和所有权信息后重试。' };
      const summary = `准备在 ${providerLabel(draft.provider)} 创建私有仓库 ${draft.namespace}/${draft.name}；请求者 ${actor.userId}；仅绑定当前话题 ${actor.chatId}/${topicId}。请由你本人回复“确认创建 ${draft.namespace}/${draft.name}”。`;
      const ready = this.store.transitionProjectCreationOperation(draft.operationId, 'collecting', {
        status: 'awaiting_confirmation', summaryText: summary, updatedAt: now.toISOString(),
      });
      if (!ready) throw new Error('Project creation state changed during validation.');
      return { text: summary, operationId: draft.operationId };
    });
  }

  async confirm(actor: TaskActorContext, text: string, messageId: string): Promise<ProjectCreationOperation | undefined> {
    if (!actor.topicId || !messageId) return undefined;
    try { this.requireChatRequester(actor); } catch { return undefined; }
    const current = this.store.getOpenProjectCreationOperation(actor.userId, actor.chatId, actor.topicId);
    if (!current) return undefined;
    if (current.status === 'creating' && current.confirmedMessageId === messageId) return current;
    const confirmation = text.normalize('NFKC').trim().replace(/[。.!！]$/u, '').trim();
    const target = `${current.namespace}/${current.name}`;
    if (current.confirmedMessageId && current.failure
      && ['creating', 'remote_created', 'registered', 'checkout_ready'].includes(current.status)) {
      return confirmation === `确认创建 ${target}` || confirmation === `我确认创建 ${target}` ? current : undefined;
    }
    if (current.status !== 'awaiting_confirmation' || !current.namespace || !current.name) return undefined;
    const now = this.clock();
    if (Date.parse(current.expiresAt) <= now.getTime()) {
      this.store.transitionProjectCreationOperation(current.operationId, 'awaiting_confirmation', {
        status: 'failed', failure: 'confirmation_expired', updatedAt: now.toISOString(),
      });
      return undefined;
    }
    if (confirmation !== `确认创建 ${target}` && confirmation !== `我确认创建 ${target}`) return undefined;
    return this.store.transitionProjectCreationOperation(current.operationId, 'awaiting_confirmation', {
      status: 'creating', confirmedMessageId: messageId, updatedAt: now.toISOString(),
    });
  }

  private requireChatRequester(actor: TaskActorContext): void {
    if (actor.chatType !== 'group' || !actor.topicId || actor.taskPurpose) {
      throw new Error('Repository creation requires an ordinary group topic.');
    }
    const scope = this.store.getTaskScopeByKey(conversationTaskIdentity(actor).scopeKey);
    const task = scope ? this.store.getTask(scope.taskId) : undefined;
    if (!task || taskMode(task) !== 'chat' || task.ownerUserId !== actor.userId) {
      throw new Error('Repository creation requires the requester’s unbound chat task.');
    }
  }
}

function normalizedFields(fields: ProjectCreationFields): ProjectCreationFields {
  const result: ProjectCreationFields = {};
  if (fields.provider !== undefined) {
    if (fields.provider !== 'github') throw new Error('Invalid repository provider.');
    result.provider = fields.provider;
  }
  const segment = '[A-Za-z0-9][A-Za-z0-9._-]{0,79}';
  if (fields.namespace !== undefined) {
    if (!new RegExp(`^${segment}(?:/${segment}){0,3}$`).test(fields.namespace)
      || looksLikeCredential(fields.namespace)) throw new Error('Invalid namespace.');
    result.namespace = fields.namespace;
  }
  if (fields.name !== undefined) {
    if (!new RegExp(`^${segment}$`).test(fields.name) || looksLikeCredential(fields.name)) {
      throw new Error('Invalid repository name.');
    }
    result.name = fields.name;
  }
  if (fields.description !== undefined) {
    if (fields.description.length > 500 || /\0/.test(fields.description) || looksLikeCredential(fields.description)) {
      throw new Error('Invalid repository description.');
    }
    result.description = fields.description;
  }
  return result;
}

function providerLabel(_provider: 'github'): string { return 'GitHub'; }

function creationRequest(operation: ProjectCreationOperation, action: SandboxRepoRequest['action']): SandboxRepoRequest {
  if (!operation.provider || !operation.namespace || !operation.name) throw new Error('Confirmed repository target is incomplete.');
  const common = { action, operationId: operation.operationId, namespace: operation.namespace,
    name: operation.name, private: true as const,
    ...(operation.description ? { description: operation.description } : {}) };
  return { ...common, provider: 'github' };
}

function assertRemoteResult(operation: ProjectCreationOperation, result: SandboxRepoResult): void {
  const target = `${operation.namespace}/${operation.name}`;
  const sameTarget = typeof result.canonicalPath === 'string' && (operation.provider === 'github'
    ? result.canonicalPath.toLowerCase() === target.toLowerCase() : result.canonicalPath === target);
  const expectedCloneUrl = `git@github.com:${result.canonicalPath}.git`;
  if (!result.providerRepoId || !/^[A-Za-z0-9:_-]{1,128}$/.test(result.providerRepoId)
    || looksLikeCredential(result.providerRepoId)
    || !sameTarget || result.cloneUrl !== expectedCloneUrl
    || !result.defaultBranch || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(result.defaultBranch)
    || looksLikeCredential(result.defaultBranch)) {
    throw new Error('Sandbox returned mismatched or incomplete repository identity.');
  }
}

function looksLikeCredential(value: string): boolean {
  return /gh[pousr]_[A-Za-z0-9]{20,}|(?:access|refresh)[_-]?token\s*[:=]|Bearer\s+\S+/i.test(value);
}
