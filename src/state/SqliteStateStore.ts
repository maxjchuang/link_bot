import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppServerRequestRecord,DecideAppServerRequestResult } from '../approvals/AppServerRequestTypes.js';
import type { PendingAuthenticatedTurn } from '../auth/AuthTypes.js';
import type {
ClaimInboundMessageInput,ClaimInboundMessageResult,InboundAdmissionRecord,
InboundAdmissionStatus,InboundMessageReceipt,
} from '../domain/types.js';
import { transitionAmbientTopicState,type AmbientTopicState } from '../feishu/AmbientChatPolicy.js';
import type { ContextMemoryReadRecord,DreamJobRecord,MemoryEntryRecord,MemorySourceRecord } from '../memory/MemoryTypes.js';
import type { DynamicProjectRecord,ProjectCreationOperation,ProjectCreationStatus } from '../projects/DynamicProjectTypes.js';
import type { PendingProjectRoutingRecord } from '../projects/ProjectRoutingTypes.js';
import type { ConversationExecutionProfileRecord } from '../tasks/ExecutionProfile.js';
import type {
ChangeSetRecord,
RepositoryMigrationRecord,
TaskBindingRecord,TaskContextRecord,TaskMembershipRecord,TaskRecord,TaskRepositoryRecord,
TaskRuntimeState,TaskScopeRecord,TurnRecord,
UserSandboxRecord,
WorkspaceSpecRecord,
} from '../tasks/TaskTypes.js';
import { migrateSqliteSchema } from './SqliteSchema.js';

export interface ReadySlotRecord {
  id: string;
  versionKey: string;
  status: 'ready' | 'claimed' | 'discarded';
  claimedByTaskId?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface LifecycleIntentRecord {
  id: string;
  taskId: string;
  fromState: TaskRuntimeState;
  toState: TaskRuntimeState;
  status: 'pending' | 'completed' | 'reconciled';
  observedState?: TaskRuntimeState;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationContextCursorRecord {
  consumerContextId?: string;
  taskId: string;
  chatId: string;
  threadId?: string;
  lastIncludedMessageId?: string;
  lastIncludedCreatedAt?: string;
  /** Incremented when Codex reports a native conversation compaction. */
  compactionEpoch?: number;
  /** The next task turn must reload bounded conversation context without its incremental cursor. */
  recoveryRequired?: boolean;
  recoveryRequiredAt?: string;
  recoveryRestoredAt?: string;
  updatedAt: string;
}

export interface ReconciledPublishRequest {
  id: string;
  taskId: string;
  previousStatus: 'pending';
  status: 'expired';
}

export class SqliteStateStore {
  readonly db: Database.Database;
  private readonly taskQueues = new Map<string, Promise<unknown>>();
  private readonly inboundClaimOwnerId = randomUUID();

  constructor(databasePath: string, private readonly clock: () => Date = () => new Date()) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    migrateSqliteSchema(this.db);
    this.reconcileSubmittingAdmissionsAfterRestart();
  }

  close(): void {
    this.db.close();
  }

  getDynamicProject(projectId: string): DynamicProjectRecord | undefined {
    return payloadRow<DynamicProjectRecord>(this.db.prepare('SELECT payload FROM dynamic_projects WHERE id=?').get(projectId));
  }

  getDynamicProjectByProviderRepoId(provider: DynamicProjectRecord['provider'], providerRepoId: string,
    scope?: Pick<DynamicProjectRecord, 'ownerUserId'|'chatId'|'topicId'>): DynamicProjectRecord | undefined {
    return payloadRow<DynamicProjectRecord>(this.db.prepare(
      `SELECT payload FROM dynamic_projects WHERE provider=? AND provider_repo_id=?${scope ? ' AND owner_user_id=? AND chat_id=? AND topic_id=?' : ''} ORDER BY created_at,id LIMIT 1`,
    ).get(provider, providerRepoId, ...(scope ? [scope.ownerUserId,scope.chatId,scope.topicId] : [])));
  }

  listDynamicProjectsFor(ownerUserId: string, chatId: string, topicId: string): DynamicProjectRecord[] {
    return this.db.prepare(`SELECT payload FROM dynamic_projects
      WHERE owner_user_id=? AND chat_id=? AND topic_id=? ORDER BY created_at,id`)
      .all(ownerUserId, chatId, topicId).map(payloadRowRequired<DynamicProjectRecord>);
  }

  saveDynamicProject(record: DynamicProjectRecord): void {
    rejectCredentialFields(record);
    const previous = this.getDynamicProject(record.id);
    if (previous && (previous.provider !== record.provider || previous.providerRepoId !== record.providerRepoId
      || previous.ownerUserId !== record.ownerUserId || previous.chatId !== record.chatId || previous.topicId !== record.topicId)) {
      throw new Error('Dynamic project identity and topic scope are immutable.');
    }
    this.db.prepare(`INSERT INTO dynamic_projects
      (id,provider,provider_repo_id,namespace,name,owner_user_id,chat_id,topic_id,state,payload,created_at,updated_at)
      VALUES (@id,@provider,@providerRepoId,@namespace,@name,@ownerUserId,@chatId,@topicId,@state,@payload,@createdAt,@updatedAt)
      ON CONFLICT(id) DO UPDATE SET namespace=excluded.namespace,name=excluded.name,
        state=excluded.state,payload=excluded.payload,updated_at=excluded.updated_at`)
      .run({ ...record, payload: json(record) });
  }

  getProjectCreationOperation(operationId: string): ProjectCreationOperation | undefined {
    return payloadRow<ProjectCreationOperation>(this.db.prepare(
      'SELECT payload FROM project_creation_operations WHERE operation_id=?',
    ).get(operationId));
  }

  listOpenProjectCreationOperations(): ProjectCreationOperation[] {
    return this.db.prepare(`SELECT payload FROM project_creation_operations
      WHERE status NOT IN ('bound','failed') ORDER BY created_at,operation_id`)
      .all().map(payloadRowRequired<ProjectCreationOperation>);
  }

  getOpenProjectCreationOperation(ownerUserId: string, chatId: string, topicId: string): ProjectCreationOperation | undefined {
    return payloadRow<ProjectCreationOperation>(this.db.prepare(`SELECT payload FROM project_creation_operations
      WHERE owner_user_id=? AND chat_id=? AND topic_id=? AND status NOT IN ('bound','failed')`)
      .get(ownerUserId, chatId, topicId));
  }

  getOpenProjectCreationOperationForTopic(chatId: string, topicId: string): ProjectCreationOperation | undefined {
    return payloadRow<ProjectCreationOperation>(this.db.prepare(`SELECT payload FROM project_creation_operations
      WHERE chat_id=? AND topic_id=? AND status NOT IN ('bound','failed')`).get(chatId, topicId));
  }

  saveProjectCreationOperation(record: ProjectCreationOperation): void {
    rejectCredentialFields(record);
    const previous = this.getProjectCreationOperation(record.operationId);
    if (previous && (previous.ownerUserId !== record.ownerUserId || previous.chatId !== record.chatId
      || previous.topicId !== record.topicId)) {
      throw new Error('Project creation operation requester and topic are immutable.');
    }
    this.db.prepare(`INSERT INTO project_creation_operations
      (operation_id,owner_user_id,chat_id,topic_id,provider,namespace,name,status,expires_at,payload,created_at,updated_at)
      VALUES (@operationId,@ownerUserId,@chatId,@topicId,@provider,@namespace,@name,@status,@expiresAt,@payload,@createdAt,@updatedAt)
      ON CONFLICT(operation_id) DO UPDATE SET
        provider=excluded.provider,namespace=excluded.namespace,name=excluded.name,
        status=excluded.status,expires_at=excluded.expires_at,payload=excluded.payload,updated_at=excluded.updated_at`)
      .run({ ...record, provider: record.provider ?? null, namespace: record.namespace ?? null,
        name: record.name ?? null, payload: json(record) });
  }

  transitionProjectCreationOperation(
    operationId: string, expectedStatus: ProjectCreationStatus,
    update: Partial<ProjectCreationOperation> & Pick<ProjectCreationOperation, 'status' | 'updatedAt'>,
  ): ProjectCreationOperation | undefined {
    return this.db.transaction(() => {
      const current = this.getProjectCreationOperation(operationId);
      if (!current || current.status !== expectedStatus) return undefined;
      const next = { ...current, ...update, operationId: current.operationId,
        ownerUserId: current.ownerUserId, chatId: current.chatId, topicId: current.topicId };
      rejectCredentialFields(next);
      const changed = this.db.prepare(`UPDATE project_creation_operations SET
        provider=@provider,namespace=@namespace,name=@name,status=@status,
        expires_at=@expiresAt,payload=@payload,updated_at=@updatedAt
        WHERE operation_id=@operationId AND status=@expectedStatus`).run({
        ...next, expectedStatus, provider: next.provider ?? null, namespace: next.namespace ?? null,
        name: next.name ?? null, payload: json(next),
      }).changes;
      return changed === 1 ? next : undefined;
    }).immediate();
  }

  getConversationExecutionProfile(scopeKey: string): ConversationExecutionProfileRecord | undefined {
    return payloadRow<ConversationExecutionProfileRecord>(this.db.prepare(
      'SELECT payload FROM conversation_execution_profiles WHERE scope_key=?',
    ).get(scopeKey));
  }

  saveConversationExecutionProfile(record: ConversationExecutionProfileRecord): void {
    this.db.prepare(`
      INSERT INTO conversation_execution_profiles
        (scope_key,chat_id,topic_id,owner_user_id,status,payload,created_at,updated_at)
      VALUES (@scopeKey,@chatId,@topicId,@ownerUserId,@status,@payload,@createdAt,@updatedAt)
      ON CONFLICT(scope_key) DO UPDATE SET
        owner_user_id=excluded.owner_user_id,status=excluded.status,payload=excluded.payload,updated_at=excluded.updated_at
    `).run({ ...record, topicId: record.topicId ?? null, payload: json(record) });
  }

  consumeConversationExecutionProfile(scopeKey: string, taskId: string, now = this.clock().toISOString()): ConversationExecutionProfileRecord | undefined {
    return this.db.transaction(() => {
      const current = this.getConversationExecutionProfile(scopeKey);
      if (!current || current.status !== 'pending') return undefined;
      const consumed: ConversationExecutionProfileRecord = {
        ...current, status: 'consumed', consumedTaskId: taskId, updatedAt: now,
      };
      const changed = this.db.prepare(`
        UPDATE conversation_execution_profiles SET status='consumed',payload=?,updated_at=?
        WHERE scope_key=? AND status='pending'
      `).run(json(consumed), now, scopeKey).changes;
      return changed === 1 ? consumed : undefined;
    }).immediate();
  }

  /**
   * Pending publish approvals are bounded by their recorded approval window.
   * Expiring them is local and deterministic; publishing/unknown requests need
   * an authoritative remote reconciliation and are intentionally left intact.
   */
  expirePendingPublishRequests(now = this.clock().toISOString()): ReconciledPublishRequest[] {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT id, task_id AS taskId, payload FROM publish_requests
        WHERE status='pending' AND json_extract(payload, '$.expiresAt') <= ?
        ORDER BY updated_at, id
      `).all(now) as Array<{ id: string; taskId: string; payload: string }>;
      const reconciled: ReconciledPublishRequest[] = [];
      for (const row of rows) {
        const payload = JSON.parse(row.payload) as Record<string, unknown>;
        const next = { ...payload, status: 'expired', updatedAt: now };
        const changed = this.db.prepare(`
          UPDATE publish_requests SET status='expired', payload=?, updated_at=?
          WHERE id=? AND status='pending'
        `).run(json(next), now, row.id).changes;
        if (changed === 1) reconciled.push({
          id: row.id, taskId: row.taskId, previousStatus: 'pending', status: 'expired',
        });
      }
      return reconciled;
    }).immediate();
  }

  getAmbientTopicState(chatId: string, topicId: string): AmbientTopicState | undefined {
    return payloadRow<AmbientTopicState>(this.db.prepare(
      'SELECT payload FROM ambient_topic_states WHERE chat_id=? AND topic_id=?',
    ).get(chatId, topicId));
  }

  applyAmbientTopicMessage(input: {
    chatId: string; topicId: string; userId: string; messageId: string;
    createdAt: string; wasMentioned: boolean; seed?: AmbientTopicState;
  }): AmbientTopicState {
    return this.db.transaction(() => {
      const current = this.getAmbientTopicState(input.chatId, input.topicId) ?? input.seed;
      const next = transitionAmbientTopicState(current, input, this.clock().toISOString());
      this.db.prepare(`
        INSERT INTO ambient_topic_states(id, chat_id, topic_id, last_message_created_at, payload, updated_at)
        VALUES (@id, @chatId, @topicId, @lastMessageCreatedAt, @payload, @updatedAt)
        ON CONFLICT(id) DO UPDATE SET last_message_created_at=excluded.last_message_created_at,
          payload=excluded.payload, updated_at=excluded.updated_at
      `).run({ ...next, payload: json(next) });
      return next;
    }).immediate();
  }

  deleteAmbientTopicState(chatId: string, topicId: string): void {
    this.db.prepare('DELETE FROM ambient_topic_states WHERE chat_id=? AND topic_id=?').run(chatId, topicId);
  }

  getFinalizedLiveCardAnswer(taskId: string): string | undefined {
    const row = this.db.prepare('SELECT payload FROM live_cards WHERE task_id=? ORDER BY updated_at DESC LIMIT 1')
      .get(taskId) as { payload: string } | undefined;
    if (!row) return undefined;
    const payload = JSON.parse(row.payload) as { state?: unknown; snapshot?: { finalAnswer?: unknown } };
    return payload.state === 'finalized' && typeof payload.snapshot?.finalAnswer === 'string'
      ? payload.snapshot.finalAnswer : undefined;
  }

  savePendingProjectRouting(record: PendingProjectRoutingRecord): void {
    this.db.prepare(`INSERT INTO pending_project_routing(id,original_message_id,chat_id,requester_user_id,status,expires_at,payload,created_at,updated_at)
      VALUES (@id,@originalMessageId,@chatId,@userId,@status,@expiresAt,@payload,@createdAt,@updatedAt)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,expires_at=excluded.expires_at,payload=excluded.payload,updated_at=excluded.updated_at`)
      .run({ ...record, payload: json(record) });
  }

  getPendingProjectRouting(id: string): PendingProjectRoutingRecord | undefined {
    return payloadRow<PendingProjectRoutingRecord>(this.db.prepare('SELECT payload FROM pending_project_routing WHERE id=?').get(id));
  }

  getPendingProjectRoutingByMessage(messageId: string): PendingProjectRoutingRecord | undefined {
    return payloadRow<PendingProjectRoutingRecord>(this.db.prepare('SELECT payload FROM pending_project_routing WHERE original_message_id=?').get(messageId));
  }

  saveConversationContextCursor(record: ConversationContextCursorRecord): void {
    this.db.prepare(`
      INSERT INTO conversation_context_cursors(task_id, chat_id, thread_key, payload, updated_at)
      VALUES (@taskId, @chatId, @threadKey, @payload, @updatedAt)
      ON CONFLICT(task_id, chat_id, thread_key) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at
    `).run({
      ...record, threadKey: record.threadId ?? '', payload: json(record),
    });
  }

  getConversationContextCursor(
    taskId: string,
    chatId: string,
    threadId?: string,
  ): ConversationContextCursorRecord | undefined {
    return payloadRow<ConversationContextCursorRecord>(this.db.prepare(`
      SELECT payload FROM conversation_context_cursors WHERE task_id=? AND chat_id=? AND thread_key=?
    `).get(taskId, chatId, threadId ?? ''));
  }

  savePendingAuth(record: PendingAuthenticatedTurn): void {
    this.db.prepare(`INSERT OR REPLACE INTO pending_tool_auth(id, provider, user_id, expires_at, payload, created_at)
      VALUES (@id, @provider, @userId, @expiresAt, @payload, @createdAt)`)
      .run({ ...record, payload: json(record) });
  }

  getPendingAuth(id: string): PendingAuthenticatedTurn | undefined {
    return payloadRow<PendingAuthenticatedTurn>(this.db.prepare('SELECT payload FROM pending_tool_auth WHERE id=?').get(id));
  }

  listPendingAuth(userId: string): PendingAuthenticatedTurn[] {
    return (this.db.prepare('SELECT payload FROM pending_tool_auth WHERE user_id=? ORDER BY created_at DESC')
      .all(userId) as Array<{ payload: string }>).map((row) => JSON.parse(row.payload) as PendingAuthenticatedTurn);
  }

  listPendingAuthAll(): PendingAuthenticatedTurn[] {
    return (this.db.prepare('SELECT payload FROM pending_tool_auth ORDER BY created_at')
      .all() as Array<{ payload: string }>).map((row) => JSON.parse(row.payload) as PendingAuthenticatedTurn);
  }

  deletePendingAuth(id: string): void {
    this.db.prepare('DELETE FROM pending_tool_auth WHERE id=?').run(id);
  }

  saveTask(task: TaskRecord): void {
    if (task.mode === 'chat' && (task.projectId !== undefined || task.runtimeMode !== 'user-sandbox')) {
      throw new Error('Chat task must be an unbound user-sandbox task.');
    }
    if (task.mode !== 'chat' && !task.projectId) throw new Error('Project task requires projectId.');
    const existing = this.getTask(task.id);
    const existingMode = existing?.runtimeMode ?? 'legacy-task-container';
    const nextMode = task.runtimeMode ?? 'legacy-task-container';
    if (existing && existingMode !== nextMode) {
      throw new Error(`Task runtime mode is immutable: ${task.id} (${existingMode} -> ${nextMode}).`);
    }
    this.db.prepare(`
      INSERT INTO tasks(id, owner_user_id, project_id, runtime_state, last_user_interaction_at, payload, created_at, updated_at)
      VALUES (@id, @ownerUserId, @projectId, @runtimeState, @lastUserInteractionAt, @payload, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET owner_user_id=excluded.owner_user_id, project_id=excluded.project_id,
        runtime_state=excluded.runtime_state, last_user_interaction_at=excluded.last_user_interaction_at,
        payload=excluded.payload, updated_at=excluded.updated_at
    `).run({ ...task, projectId: task.projectId ?? '', payload: json(task) });
  }

  saveUserSandbox(record: UserSandboxRecord): void {
    const existing = this.getUserSandbox(record.id);
    if (existing && existing.ownerId !== record.ownerId) throw new Error('User sandbox owner is immutable.');
    if (existing && record.generation < existing.generation) throw new Error('User sandbox generation cannot move backwards.');
    this.db.prepare(`
      INSERT INTO user_sandboxes(
        id,owner_id,generation,status,lease_owner,lease_expires_at,payload,created_at,updated_at
      ) VALUES (@id,@ownerId,@generation,@status,@leaseOwner,@leaseExpiresAt,@payload,@createdAt,@updatedAt)
      ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,status=excluded.status,
        lease_owner=excluded.lease_owner,lease_expires_at=excluded.lease_expires_at,
        payload=excluded.payload,updated_at=excluded.updated_at
    `).run({
      ...record, leaseOwner: record.leaseOwner ?? null, leaseExpiresAt: record.leaseExpiresAt ?? null,
      payload: json(record),
    });
  }

  getUserSandbox(id: string): UserSandboxRecord | undefined {
    return payloadRow<UserSandboxRecord>(this.db.prepare('SELECT payload FROM user_sandboxes WHERE id=?').get(id));
  }

  getUserSandboxByOwner(ownerId: string): UserSandboxRecord | undefined {
    return payloadRow<UserSandboxRecord>(this.db.prepare('SELECT payload FROM user_sandboxes WHERE owner_id=?').get(ownerId));
  }

  listUserSandboxes(): UserSandboxRecord[] {
    return this.db.prepare('SELECT payload FROM user_sandboxes ORDER BY created_at,id')
      .all().map(payloadRowRequired<UserSandboxRecord>);
  }

  getOrCreateUserSandbox(ownerId: string): { sandbox: UserSandboxRecord; created: boolean } {
    return this.db.transaction(() => {
      const existing = this.getUserSandboxByOwner(ownerId);
      if (existing) return { sandbox: existing, created: false };
      const now = this.clock().toISOString();
      const sandbox: UserSandboxRecord = {
        id: `sandbox_${randomUUID()}`, ownerId, generation: 1, status: 'provisioning',
        createdAt: now, lastActiveAt: now, updatedAt: now,
      };
      this.saveUserSandbox(sandbox);
      return { sandbox, created: true };
    }).immediate();
  }

  claimUserSandboxLease(input: {
    ownerId: string; leaseOwner: string; leaseExpiresAt: string; now?: string;
  }): UserSandboxRecord | undefined {
    return this.db.transaction(() => {
      const sandbox = this.getUserSandboxByOwner(input.ownerId);
      if (!sandbox) return undefined;
      const now = input.now ?? this.clock().toISOString();
      if (sandbox.leaseOwner && sandbox.leaseOwner !== input.leaseOwner
        && sandbox.leaseExpiresAt && sandbox.leaseExpiresAt > now) return undefined;
      const leased = { ...sandbox, leaseOwner: input.leaseOwner, leaseExpiresAt: input.leaseExpiresAt, updatedAt: now };
      this.saveUserSandbox(leased);
      return leased;
    }).immediate();
  }

  advanceUserSandboxGeneration(input: {
    ownerId: string; expectedGeneration: number; leaseOwner: string;
    status?: UserSandboxRecord['status']; containerId?: string; now?: string;
  }): UserSandboxRecord | undefined {
    return this.db.transaction(() => {
      const sandbox = this.getUserSandboxByOwner(input.ownerId);
      if (!sandbox || sandbox.generation !== input.expectedGeneration || sandbox.leaseOwner !== input.leaseOwner) return undefined;
      const now = input.now ?? this.clock().toISOString();
      const next: UserSandboxRecord = {
        ...sandbox, generation: sandbox.generation + 1, status: input.status ?? 'provisioning',
        ...(input.containerId ? { containerId: input.containerId } : { containerId: undefined }),
        lastActiveAt: now, updatedAt: now, stoppedAt: undefined,
      };
      this.saveUserSandbox(next);
      return next;
    }).immediate();
  }

  updateUserSandboxFenced(input: {
    ownerId: string;
    expectedGeneration: number;
    leaseOwner: string;
    update: (current: UserSandboxRecord) => UserSandboxRecord;
  }): UserSandboxRecord | undefined {
    return this.db.transaction(() => {
      const current = this.getUserSandboxByOwner(input.ownerId);
      if (!current || current.generation !== input.expectedGeneration || current.leaseOwner !== input.leaseOwner) {
        return undefined;
      }
      const next = input.update(current);
      if (next.id !== current.id || next.ownerId !== current.ownerId || next.generation !== current.generation) {
        throw new Error('Fenced user sandbox update cannot change identity or generation.');
      }
      this.saveUserSandbox(next);
      return next;
    }).immediate();
  }

  allocateUserSandboxTaskProcessGeneration(input: {
    taskId: string; expectedSandboxGeneration: number; now?: string;
  }): { sandbox: UserSandboxRecord; processGeneration: number } | undefined {
    return this.db.transaction(() => {
      const task = this.getTask(input.taskId);
      if (!task || (task.runtimeMode ?? 'legacy-task-container') !== 'user-sandbox') return undefined;
      const sandbox = this.getUserSandboxByOwner(task.ownerUserId);
      if (!sandbox || sandbox.generation !== input.expectedSandboxGeneration) return undefined;
      if (task.sandboxId && task.sandboxId !== sandbox.id) throw new Error('Task is bound to a different user sandbox.');
      const processGeneration = (task.appServerProcessGeneration ?? 0) + 1;
      const now = input.now ?? this.clock().toISOString();
      this.saveTask({
        ...task,
        sandboxId: sandbox.id,
        sandboxGeneration: sandbox.generation,
        appServerProcessGeneration: processGeneration,
        connectionGeneration: processGeneration,
        updatedAt: now,
      });
      return { sandbox, processGeneration };
    }).immediate();
  }

  getTask(taskId: string): TaskRecord | undefined {
    return payloadRow<TaskRecord>(this.db.prepare('SELECT payload FROM tasks WHERE id = ?').get(taskId));
  }

  updateTask(taskId: string, updater: (current: TaskRecord) => TaskRecord): TaskRecord | undefined {
    return this.db.transaction(() => {
      const current = this.getTask(taskId);
      if (!current) return undefined;
      const next = updater(current);
      this.saveTask(next);
      return next;
    }).immediate();
  }

  fallbackUnstartedUserSandboxTaskToLegacy(taskId: string): TaskRecord | undefined {
    return this.db.transaction(() => {
      const task = this.getTask(taskId);
      if (!task || task.runtimeMode !== 'user-sandbox') return undefined;
      const hasTurns = Boolean(this.db.prepare('SELECT 1 FROM turns WHERE task_id=? LIMIT 1').get(taskId));
      if (task.sandboxId || task.runtimeId || task.codexThreadId || task.activeTurnId || hasTurns) {
        throw new Error('User sandbox fallback is no longer safe after runtime or turn ownership was established.');
      }
      const next: TaskRecord = {
        ...task,
        runtimeMode: 'legacy-task-container',
        updatedAt: this.clock().toISOString(),
      };
      // This is the sole mode transition: an explicit, pre-runtime fallback.
      // saveTask intentionally continues to reject every general mode change.
      this.db.prepare(`
        UPDATE tasks SET payload=@payload, updated_at=@updatedAt WHERE id=@id
      `).run({ id: next.id, payload: json(next), updatedAt: next.updatedAt });
      return next;
    }).immediate();
  }

  listTasks(): TaskRecord[] {
    return this.db.prepare('SELECT payload FROM tasks ORDER BY created_at, id').all().map(payloadRowRequired<TaskRecord>);
  }

  transitionTask(input: {
    taskId: string;
    expectedStates: TaskRuntimeState[];
    nextState: TaskRuntimeState;
    now?: string;
  }): TaskRecord | undefined {
    return this.db.transaction(() => {
      const current = this.getTask(input.taskId);
      if (!current || !input.expectedStates.includes(current.runtimeState)) return undefined;
      const next = { ...current, runtimeState: input.nextState, updatedAt: input.now ?? this.clock().toISOString() };
      this.saveTask(next);
      return next;
    }).immediate();
  }

  withTaskLock<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.taskQueues.get(taskId) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const chain = current.then(() => undefined, () => undefined);
    this.taskQueues.set(taskId, chain);
    return current.finally(() => {
      if (this.taskQueues.get(taskId) === chain) this.taskQueues.delete(taskId);
    });
  }

  saveTaskBinding(binding: TaskBindingRecord): void {
    this.db.prepare(`
      INSERT INTO task_bindings(id, user_id, task_id, payload, created_at, updated_at)
      VALUES (@id, @userId, @taskId, @payload, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id, task_id=excluded.task_id,
        payload=excluded.payload, updated_at=excluded.updated_at
    `).run({ ...binding, payload: json(binding) });
  }

  getTaskBinding(bindingId: string): TaskBindingRecord | undefined {
    return payloadRow<TaskBindingRecord>(this.db.prepare('SELECT payload FROM task_bindings WHERE id = ?').get(bindingId));
  }

  getLatestTaskBinding(taskId: string): TaskBindingRecord | undefined {
    return payloadRow<TaskBindingRecord>(
      this.db.prepare('SELECT payload FROM task_bindings WHERE task_id=? ORDER BY updated_at DESC, id DESC LIMIT 1').get(taskId),
    );
  }

  saveTaskScope(scope: TaskScopeRecord): void {
    this.db.prepare(`
      INSERT INTO task_scopes(task_id, scope_type, scope_key, status, payload, created_at, updated_at)
      VALUES (@taskId, @scope, @scopeKey, @status, @payload, @createdAt, @updatedAt)
      ON CONFLICT(task_id) DO UPDATE SET scope_type=excluded.scope_type, scope_key=excluded.scope_key,
        status=excluded.status, payload=excluded.payload, updated_at=excluded.updated_at
    `).run({ ...scope, payload: json(scope) });
  }

  createConversationTask(input: {
    task: TaskRecord;
    scope: TaskScopeRecord;
    membership: TaskMembershipRecord;
  }): void {
    this.db.transaction(() => {
      if (this.getTaskScopeByKey(input.scope.scopeKey)) return;
      this.saveTask(input.task);
      this.saveTaskScope(input.scope);
      this.saveTaskMembership(input.membership);
    })();
  }

  getTaskScope(taskId: string): TaskScopeRecord | undefined {
    return payloadRow<TaskScopeRecord>(this.db.prepare('SELECT payload FROM task_scopes WHERE task_id=?').get(taskId));
  }

  getTaskScopeByKey(scopeKey: string): TaskScopeRecord | undefined {
    return payloadRow<TaskScopeRecord>(this.db.prepare('SELECT payload FROM task_scopes WHERE scope_key=?').get(scopeKey));
  }

  listTaskScopes(): TaskScopeRecord[] {
    return this.db.prepare('SELECT payload FROM task_scopes ORDER BY created_at,task_id')
      .all().map(payloadRowRequired<TaskScopeRecord>);
  }

  saveTaskMembership(membership: TaskMembershipRecord): void {
    this.db.prepare(`
      INSERT INTO task_memberships(id, task_id, user_id, role, status, payload, created_at, updated_at)
      VALUES (@id, @taskId, @userId, @role, @status, @payload, @createdAt, @updatedAt)
      ON CONFLICT(task_id, user_id) DO UPDATE SET role=excluded.role, status=excluded.status,
        payload=excluded.payload, updated_at=excluded.updated_at
    `).run({ ...membership, payload: json(membership) });
  }

  getTaskMembership(taskId: string, userId: string): TaskMembershipRecord | undefined {
    return payloadRow<TaskMembershipRecord>(
      this.db.prepare('SELECT payload FROM task_memberships WHERE task_id=? AND user_id=?').get(taskId, userId),
    );
  }

  listTaskMemberships(taskId: string): TaskMembershipRecord[] {
    return this.db.prepare('SELECT payload FROM task_memberships WHERE task_id=? ORDER BY created_at, id')
      .all(taskId).map(payloadRowRequired<TaskMembershipRecord>);
  }

  saveTaskContext(context: TaskContextRecord): void {
    this.db.prepare(`
      INSERT INTO task_contexts(id, task_id, codex_thread_id, state, payload, created_at, updated_at)
      VALUES (@id, @taskId, @codexThreadId, @state, @payload, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET codex_thread_id=excluded.codex_thread_id, state=excluded.state,
        payload=excluded.payload, updated_at=excluded.updated_at
    `).run({ ...context, payload: json(context) });
  }

  getTaskContext(contextId: string): TaskContextRecord | undefined {
    return payloadRow<TaskContextRecord>(this.db.prepare('SELECT payload FROM task_contexts WHERE id=?').get(contextId));
  }

  getActiveTaskContext(taskId: string): TaskContextRecord | undefined {
    return payloadRow<TaskContextRecord>(
      this.db.prepare("SELECT payload FROM task_contexts WHERE task_id=? AND state='active'").get(taskId),
    );
  }

  listTaskContexts(taskId: string): TaskContextRecord[] {
    return this.db.prepare('SELECT payload FROM task_contexts WHERE task_id=? ORDER BY created_at, id')
      .all(taskId).map(payloadRowRequired<TaskContextRecord>);
  }

  activateTaskContext(context: TaskContextRecord): { previous?: TaskContextRecord; current: TaskContextRecord } {
    return this.db.transaction(() => {
      const previous = this.getActiveTaskContext(context.taskId);
      const now = context.updatedAt;
      if (previous && previous.id !== context.id) {
        const archived: TaskContextRecord = {
          ...previous,
          state: 'archived',
          archivedAt: now,
          updatedAt: now,
        };
        this.saveTaskContext(archived);
      }
      this.saveTaskContext({ ...context, state: 'active' });
      const task = this.getTask(context.taskId);
      if (!task) throw new Error(`Task not found: ${context.taskId}`);
      this.saveTask({ ...task, codexThreadId: context.codexThreadId, updatedAt: now });
      return { ...(previous ? { previous } : {}), current: context };
    }).immediate();
  }

  saveTaskRepository(repository: TaskRepositoryRecord): void {
    this.db.prepare(`
      INSERT INTO task_repositories(id, task_id, project_id, checkout_path, is_primary, payload, created_at, updated_at)
      VALUES (@id, @taskId, @projectId, @checkoutPath, @isPrimary, @payload, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, checkout_path=excluded.checkout_path,
        is_primary=excluded.is_primary, payload=excluded.payload, updated_at=excluded.updated_at
    `).run({ ...repository, isPrimary: repository.isPrimary ? 1 : 0, payload: json(repository) });
  }

  getTaskRepository(repositoryId: string): TaskRepositoryRecord | undefined {
    return payloadRow<TaskRepositoryRecord>(this.db.prepare('SELECT payload FROM task_repositories WHERE id=?').get(repositoryId));
  }

  listTaskRepositories(taskId: string): TaskRepositoryRecord[] {
    return this.db.prepare('SELECT payload FROM task_repositories WHERE task_id=? ORDER BY is_primary DESC, created_at, id')
      .all(taskId).map(payloadRowRequired<TaskRepositoryRecord>);
  }

  saveRepositoryMigration(record: RepositoryMigrationRecord): void {
    this.db.prepare(`INSERT INTO repository_migrations(id,task_id,repository_id,state,payload,created_at,updated_at)
      VALUES (@id,@taskId,@repositoryId,@state,@payload,@createdAt,@updatedAt)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state,payload=excluded.payload,updated_at=excluded.updated_at`)
      .run({ ...record, payload: json(record) });
  }

  getRepositoryMigration(id: string): RepositoryMigrationRecord | undefined {
    return payloadRow<RepositoryMigrationRecord>(this.db.prepare('SELECT payload FROM repository_migrations WHERE id=?').get(id));
  }

  listRepositoryMigrations(taskId: string): RepositoryMigrationRecord[] {
    return this.db.prepare('SELECT payload FROM repository_migrations WHERE task_id=? ORDER BY created_at,id')
      .all(taskId).map(payloadRowRequired<RepositoryMigrationRecord>);
  }

  saveWorkspaceSpec(record: WorkspaceSpecRecord): void {
    this.db.transaction(() => {
      if (record.state !== 'superseded') {
        this.db.prepare(`UPDATE workspace_specs SET state='superseded', updated_at=?
          WHERE task_id=? AND id<>? AND state<>'superseded'`).run(record.updatedAt, record.taskId, record.id);
      }
      this.db.prepare(`INSERT INTO workspace_specs(id,task_id,version,generation,state,payload,created_at,updated_at)
        VALUES (@id,@taskId,@version,@generation,@state,@payload,@createdAt,@updatedAt)
        ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,state=excluded.state,payload=excluded.payload,updated_at=excluded.updated_at`)
        .run({ ...record, payload: json(record) });
    })();
  }

  getActiveWorkspaceSpec(taskId: string): WorkspaceSpecRecord | undefined {
    return payloadRow<WorkspaceSpecRecord>(this.db.prepare(
      `SELECT payload FROM workspace_specs WHERE task_id=? AND state<>'superseded' ORDER BY version DESC LIMIT 1`,
    ).get(taskId));
  }

  listWorkspaceSpecs(taskId: string): WorkspaceSpecRecord[] {
    return this.db.prepare('SELECT payload FROM workspace_specs WHERE task_id=? ORDER BY version,id')
      .all(taskId).map(payloadRowRequired<WorkspaceSpecRecord>);
  }

  saveChangeSet(record: ChangeSetRecord): void {
    this.db.prepare(`INSERT INTO change_sets(id,task_id,project_id,payload,created_at,updated_at)
      VALUES (@id,@taskId,@projectId,@payload,@createdAt,@updatedAt)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at`)
      .run({ ...record, payload: json(record) });
  }

  getChangeSet(id: string): ChangeSetRecord | undefined {
    return payloadRow<ChangeSetRecord>(this.db.prepare('SELECT payload FROM change_sets WHERE id=?').get(id));
  }

  saveMemoryEntry(memory: MemoryEntryRecord): void {
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO memory_entries(id, scope_type, scope_id, kind, status, version, estimated_tokens, payload, created_at, updated_at)
        VALUES (@id, @scope, @scopeId, @kind, @status, @version, @estimatedTokens, @payload, @createdAt, @updatedAt)
        ON CONFLICT(id) DO UPDATE SET scope_type=excluded.scope_type, scope_id=excluded.scope_id,
          kind=excluded.kind, status=excluded.status, version=excluded.version,
          estimated_tokens=excluded.estimated_tokens, payload=excluded.payload, updated_at=excluded.updated_at
      `).run({ ...memory, payload: json(memory) });
      this.db.prepare('DELETE FROM memory_entries_fts WHERE memory_id=?').run(memory.id);
      this.db.prepare(`
        INSERT INTO memory_entries_fts(memory_id, scope_type, scope_id, title, description, content, tags)
        VALUES (@id, @scope, @scopeId, @title, @description, @content, @tags)
      `).run({ ...memory, tags: memory.tags.join(' ') });
    })();
  }

  getMemoryEntry(memoryId: string): MemoryEntryRecord | undefined {
    return payloadRow<MemoryEntryRecord>(this.db.prepare('SELECT payload FROM memory_entries WHERE id=?').get(memoryId));
  }

  listMemoryEntries(scope: MemoryEntryRecord['scope'], scopeId: string): MemoryEntryRecord[] {
    return this.db.prepare('SELECT payload FROM memory_entries WHERE scope_type=? AND scope_id=? ORDER BY updated_at DESC, id')
      .all(scope, scopeId).map(payloadRowRequired<MemoryEntryRecord>);
  }

  searchMemoryEntries(scope: MemoryEntryRecord['scope'], scopeId: string, query: string, limit: number): MemoryEntryRecord[] {
    const match = query.split(/\s+/).map((token) => token.replace(/["']/g, '').trim()).filter(Boolean)
      .slice(0, 12).map((token) => `"${token}"`).join(' OR ');
    if (!match) return this.listMemoryEntries(scope, scopeId).filter((memory) => memory.status === 'active').slice(0, limit);
    const rows = this.db.prepare(`
      SELECT memory_entries.payload
      FROM memory_entries_fts
      JOIN memory_entries ON memory_entries.id = memory_entries_fts.memory_id
      WHERE memory_entries_fts MATCH ? AND memory_entries.scope_type=? AND memory_entries.scope_id=?
        AND memory_entries.status='active'
      ORDER BY bm25(memory_entries_fts), memory_entries.updated_at DESC
      LIMIT ?
    `).all(match, scope, scopeId, limit) as Array<{ payload: string }>;
    const matches = rows.map(payloadRowRequired<MemoryEntryRecord>);
    if (matches.length > 0 || !/[\u3400-\u9fff]/u.test(query)) return matches;
    // unicode61 does not segment unspaced CJK phrases. Fall back to bounded
    // in-memory n-gram matching so “解决回流冲突” can recall “回流冲突任务…”.
    const grams = [...query.matchAll(/[\u3400-\u9fff]{2,}/gu)].flatMap(([segment]) => {
      const output: string[] = [];
      for (let size = Math.min(6, segment.length); size >= 2; size -= 1) {
        for (let index = 0; index + size <= segment.length; index += 1) output.push(segment.slice(index, index + size));
      }
      return output;
    });
    return this.listMemoryEntries(scope, scopeId)
      .filter((memory) => memory.status === 'active')
      .map((memory) => ({ memory, score: grams.reduce((score, gram) => score + (JSON.stringify(memory).includes(gram) ? gram.length : 0), 0) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || right.memory.updatedAt.localeCompare(left.memory.updatedAt))
      .slice(0, limit).map((item) => item.memory);
  }

  saveMemorySource(source: MemorySourceRecord): boolean {
    return this.db.prepare(`
      INSERT OR IGNORE INTO memory_sources(id, memory_id, event_key, payload, created_at)
      VALUES (@id, @memoryId, @eventKey, @payload, @createdAt)
    `).run({ ...source, payload: json(source) }).changes === 1;
  }

  listMemorySources(memoryId: string): MemorySourceRecord[] {
    return this.db.prepare('SELECT payload FROM memory_sources WHERE memory_id=? ORDER BY created_at, id')
      .all(memoryId).map(payloadRowRequired<MemorySourceRecord>);
  }

  recordContextMemoryRead(read: ContextMemoryReadRecord): boolean {
    return this.db.prepare(`
      INSERT OR IGNORE INTO context_memory_reads(
        id, context_id, memory_id, memory_version, detail_level, estimated_tokens, payload, loaded_at
      ) VALUES (@id, @contextId, @memoryId, @memoryVersion, @detailLevel, @estimatedTokens, @payload, @loadedAt)
    `).run({ ...read, payload: json(read) }).changes === 1;
  }

  listContextMemoryReads(contextId: string): ContextMemoryReadRecord[] {
    return this.db.prepare('SELECT payload FROM context_memory_reads WHERE context_id=? ORDER BY loaded_at, id')
      .all(contextId).map(payloadRowRequired<ContextMemoryReadRecord>);
  }

  saveDreamJob(job: DreamJobRecord): void {
    this.db.prepare(`
      INSERT INTO dream_jobs(
        id, scope_type, scope_id, business_date, status, from_event_sequence, to_event_sequence,
        watermark_sequence, attempt_count, payload, created_at, updated_at
      ) VALUES (
        @id, @scope, @scopeId, @businessDate, @status, @fromEventSequence, @toEventSequence,
        @watermarkSequence, @attemptCount, @payload, @createdAt, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, from_event_sequence=excluded.from_event_sequence,
        to_event_sequence=excluded.to_event_sequence, watermark_sequence=excluded.watermark_sequence,
        attempt_count=excluded.attempt_count, payload=excluded.payload, updated_at=excluded.updated_at
    `).run({
      ...job,
      toEventSequence: job.toEventSequence ?? null,
      watermarkSequence: job.watermarkSequence ?? null,
      payload: json(job),
    });
  }

  createDreamJob(job: DreamJobRecord): boolean {
    return this.db.prepare(`
      INSERT OR IGNORE INTO dream_jobs(
        id, scope_type, scope_id, business_date, status, from_event_sequence, to_event_sequence,
        watermark_sequence, attempt_count, payload, created_at, updated_at
      ) VALUES (
        @id, @scope, @scopeId, @businessDate, @status, @fromEventSequence, @toEventSequence,
        @watermarkSequence, @attemptCount, @payload, @createdAt, @updatedAt
      )
    `).run({
      ...job,
      toEventSequence: job.toEventSequence ?? null,
      watermarkSequence: job.watermarkSequence ?? null,
      payload: json(job),
    }).changes === 1;
  }

  claimNextDreamJob(maxAttempts = 5): DreamJobRecord | undefined {
    return this.db.transaction(() => {
      const running = this.db.prepare("SELECT 1 FROM dream_jobs WHERE status='running' LIMIT 1").get();
      if (running) return undefined;
      const row = this.db.prepare(`
        SELECT payload FROM dream_jobs
        WHERE status IN ('pending','deferred','interrupted','failed') AND attempt_count < ?
        ORDER BY created_at, id LIMIT 1
      `).get(maxAttempts);
      const current = payloadRow<DreamJobRecord>(row);
      if (!current) return undefined;
      const now = this.clock().toISOString();
      const claimed: DreamJobRecord = {
        ...current, status: 'running', attemptCount: current.attemptCount + 1,
        startedAt: now, updatedAt: now, lastErrorCode: undefined,
      };
      const changed = this.db.prepare(`
        UPDATE dream_jobs SET status='running', attempt_count=?, payload=?, updated_at=?
        WHERE id=? AND status=? AND attempt_count=?
      `).run(claimed.attemptCount, json(claimed), now, current.id, current.status, current.attemptCount).changes;
      return changed === 1 ? claimed : undefined;
    })();
  }

  dreamWatermark(scope: DreamJobRecord['scope'], scopeId: string): number {
    const row = this.db.prepare(`
      SELECT MAX(watermark_sequence) AS watermark FROM dream_jobs
      WHERE scope_type=? AND scope_id=? AND watermark_sequence IS NOT NULL
    `).get(scope, scopeId) as { watermark: number | null };
    return row.watermark ?? 0;
  }

  updateDreamJob(job: DreamJobRecord, expectedStatus?: DreamJobRecord['status']): boolean {
    const sql = expectedStatus
      ? 'UPDATE dream_jobs SET status=?, to_event_sequence=?, watermark_sequence=?, attempt_count=?, payload=?, updated_at=? WHERE id=? AND status=?'
      : 'UPDATE dream_jobs SET status=?, to_event_sequence=?, watermark_sequence=?, attempt_count=?, payload=?, updated_at=? WHERE id=?';
    const values = [
      job.status, job.toEventSequence ?? null, job.watermarkSequence ?? null, job.attemptCount,
      json(job), job.updatedAt, job.id, ...(expectedStatus ? [expectedStatus] : []),
    ];
    return this.db.prepare(sql).run(...values).changes === 1;
  }

  getDreamJob(jobId: string): DreamJobRecord | undefined {
    return payloadRow<DreamJobRecord>(this.db.prepare('SELECT payload FROM dream_jobs WHERE id=?').get(jobId));
  }

  listDreamJobs(status?: DreamJobRecord['status']): DreamJobRecord[] {
    const rows = status
      ? this.db.prepare('SELECT payload FROM dream_jobs WHERE status=? ORDER BY created_at, id').all(status)
      : this.db.prepare('SELECT payload FROM dream_jobs ORDER BY created_at, id').all();
    return rows.map(payloadRowRequired<DreamJobRecord>);
  }

  interruptRunningDreamJobs(errorCode: string): number {
    return this.db.transaction(() => {
      const jobs = this.listDreamJobs('running');
      let changed = 0;
      const now = this.clock().toISOString();
      for (const job of jobs) {
        const interrupted: DreamJobRecord = { ...job, status: 'interrupted', lastErrorCode: errorCode, updatedAt: now };
        changed += this.updateDreamJob(interrupted, 'running') ? 1 : 0;
      }
      return changed;
    })();
  }

  saveTurn(turn: TurnRecord): void {
    this.db.prepare(`
      INSERT INTO turns(id, task_id, state, payload, created_at, updated_at)
      VALUES (@id, @taskId, @state, @payload, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state, payload=excluded.payload, updated_at=excluded.updated_at
    `).run({ ...turn, payload: json(turn) });
  }

  getTurn(turnId: string): TurnRecord | undefined {
    return payloadRow<TurnRecord>(this.db.prepare('SELECT payload FROM turns WHERE id = ?').get(turnId));
  }

  updateTurn(turnId: string, updater: (current: TurnRecord) => TurnRecord): TurnRecord | undefined {
    return this.db.transaction(() => {
      const current = this.getTurn(turnId);
      if (!current) return undefined;
      const next = updater(current);
      this.saveTurn(next);
      return next;
    }).immediate();
  }

  listTurnsByTask(taskId: string): TurnRecord[] {
    return this.db.prepare('SELECT payload FROM turns WHERE task_id=? ORDER BY created_at, id').all(taskId).map(payloadRowRequired<TurnRecord>);
  }

  listNonterminalTurns(): TurnRecord[] {
    return this.db.prepare("SELECT payload FROM turns WHERE state IN ('queued','submitted','running','waiting_approval') ORDER BY created_at, id")
      .all().map(payloadRowRequired<TurnRecord>);
  }

  appendTurnEvent(input: {
    eventKey: string;
    taskId: string;
    turnId?: string;
    generation?: number;
    eventType: string;
    payload: unknown;
    createdAt?: string;
  }): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO turn_events(event_key, task_id, turn_id, generation, event_type, payload, created_at)
      VALUES (@eventKey, @taskId, @turnId, @generation, @eventType, @payload, @createdAt)
    `).run({ ...input, turnId: input.turnId ?? null, generation: input.generation ?? null, payload: json(input.payload), createdAt: input.createdAt ?? this.clock().toISOString() });
    return result.changes === 1;
  }

  listTurnEvents(taskId: string): Array<{ sequence: number; eventKey: string; eventType: string; payload: unknown }> {
    const rows = this.db.prepare(`
      SELECT sequence, event_key AS eventKey, event_type AS eventType, payload
      FROM turn_events WHERE task_id = ? ORDER BY sequence
    `).all(taskId) as Array<{ sequence: number; eventKey: string; eventType: string; payload: string }>;
    return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) as unknown }));
  }

  latestTurnEventAt(taskId: string, turnId?: string): string | undefined {
    const row = (turnId
      ? this.db.prepare('SELECT created_at AS createdAt FROM turn_events WHERE task_id = ? AND turn_id = ? ORDER BY sequence DESC LIMIT 1').get(taskId, turnId)
      : this.db.prepare('SELECT created_at AS createdAt FROM turn_events WHERE task_id = ? ORDER BY sequence DESC LIMIT 1').get(taskId)
    ) as { createdAt?: string } | undefined;
    return row?.createdAt;
  }

  listTurnEventsAfter(taskId: string, sequence: number, limit: number): Array<{ sequence: number; eventKey: string; eventType: string; payload: unknown }> {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('Turn event limit must be a positive integer.');
    const rows = this.db.prepare(`
      SELECT sequence, event_key AS eventKey, event_type AS eventType, payload
      FROM turn_events WHERE task_id=? AND sequence>? ORDER BY sequence LIMIT ?
    `).all(taskId, sequence, limit) as Array<{ sequence: number; eventKey: string; eventType: string; payload: string }>;
    return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) as unknown }));
  }

  saveAppServerRequest(request: AppServerRequestRecord): void {
    const updatedAt = request.deliveredAt ?? request.decidedAt ?? request.invalidatedAt ?? request.createdAt;
    this.db.prepare(`
      INSERT INTO approvals(id, task_id, owner_user_id, generation, status, payload, created_at, updated_at)
      VALUES (@id, @taskId, @ownerUserId, @generation, @status, @payload, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, payload=excluded.payload, updated_at=excluded.updated_at
    `).run({ ...request, payload: json(request), updatedAt });
  }

  createAppServerRequest(request: AppServerRequestRecord): { created: boolean; request: AppServerRequestRecord } {
    return this.db.transaction(() => {
      const current = this.getAppServerRequest(request.id);
      if (current) return { created: false, request: current };
      this.saveAppServerRequest(request);
      return { created: true, request };
    })();
  }

  getAppServerRequest(requestId: string): AppServerRequestRecord | undefined {
    return payloadRow<AppServerRequestRecord>(this.db.prepare('SELECT payload FROM approvals WHERE id=?').get(requestId));
  }

  listPendingAppServerRequests(): AppServerRequestRecord[] {
    return this.db.prepare("SELECT payload FROM approvals WHERE status IN ('pending','decided') ORDER BY created_at")
      .all().map(payloadRowRequired<AppServerRequestRecord>);
  }

  updateAppServerRequest(requestId: string, updater: (current: AppServerRequestRecord) => AppServerRequestRecord): AppServerRequestRecord | undefined {
    return this.db.transaction(() => {
      const current = this.getAppServerRequest(requestId);
      if (!current) return undefined;
      const next = updater(current);
      this.saveAppServerRequest(next);
      return next;
    }).immediate();
  }

  decideAppServerRequest(input: {
    requestId: string;
    userId: string;
    generation: number;
    decision: 'allow' | 'deny' | 'answer';
    answers?: Record<string, string[]>;
  }): DecideAppServerRequestResult {
    return this.db.transaction((): DecideAppServerRequestResult => {
      const request = this.getAppServerRequest(input.requestId);
      if (!request) return { accepted: false, reason: 'not_found' };
      if (request.ownerUserId !== input.userId) return { accepted: false, reason: 'identity_mismatch', request };
      if (request.generation !== input.generation) return { accepted: false, reason: 'generation_mismatch', request };
      if (request.status === 'decided' || request.status === 'delivered') {
        if (request.decision === input.decision && JSON.stringify(request.answers ?? null) === JSON.stringify(input.answers ?? null)) {
          return { accepted: true, duplicate: true, request };
        }
        return { accepted: false, reason: 'not_pending', request };
      }
      if (request.status !== 'pending') return { accepted: false, reason: 'not_pending', request };
      const now = this.clock().toISOString();
      if (request.expiresAt <= now) {
        const expired: AppServerRequestRecord = { ...request, status: 'expired', invalidatedAt: now };
        this.saveAppServerRequest(expired);
        return { accepted: false, reason: 'expired', request: expired };
      }
      const decided: AppServerRequestRecord = {
        ...request, status: 'decided', decision: input.decision,
        ...(input.answers ? { answers: input.answers } : {}), decidedAt: now,
      };
      this.saveAppServerRequest(decided);
      return { accepted: true, duplicate: false, request: decided };
    })();
  }

  markAppServerRequestDelivered(requestId: string): AppServerRequestRecord | undefined {
    return this.db.transaction(() => {
      const request = this.getAppServerRequest(requestId);
      if (!request || request.status !== 'decided') return request;
      const delivered: AppServerRequestRecord = { ...request, status: 'delivered', deliveredAt: this.clock().toISOString() };
      this.saveAppServerRequest(delivered);
      return delivered;
    })();
  }

  invalidateAppServerRequests(taskId: string, activeGeneration: number): AppServerRequestRecord[] {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT payload FROM approvals WHERE task_id=? AND generation<>? AND status IN ('pending','decided')
      `).all(taskId, activeGeneration).map(payloadRowRequired<AppServerRequestRecord>);
      const now = this.clock().toISOString();
      for (const request of rows) this.saveAppServerRequest({
        ...request, status: 'connection_lost', invalidatedAt: now,
      });
      return rows;
    })();
  }

  claimInboundMessage(input: ClaimInboundMessageInput): ClaimInboundMessageResult {
    if (!input.messageId) return { claimed: true, reason: 'missing_message_id' };
    const claim = this.db.transaction((): ClaimInboundMessageResult => {
      const admission = this.getInboundAdmissionByExternalMessageId(input.messageId!);
      const existing = payloadRow<InboundMessageReceipt>(
        this.db.prepare('SELECT payload FROM inbound_message_receipts WHERE message_id = ?').get(input.messageId),
      );
      if (existing) {
        // A request that may already have reached Codex must be reconciled from
        // App Server evidence or an explicit user decision. Delivery retries
        // must never turn it back into an executable prompt automatically.
        if (admission?.status === 'unknown') {
          const duplicate: InboundMessageReceipt = {
            ...existing, duplicateCount: existing.duplicateCount + 1, lastDuplicateAt: this.clock().toISOString(),
          };
          this.db.prepare('UPDATE inbound_message_receipts SET payload=? WHERE message_id=?')
            .run(json(duplicate), duplicate.messageId);
          return { claimed: false, receipt: duplicate };
        }
        if (existing.status === 'failed' || (existing.status !== 'completed' && existing.claimOwnerId !== this.inboundClaimOwnerId)) {
          const reclaimed: InboundMessageReceipt = {
            ...existing, status: 'processing', claimOwnerId: this.inboundClaimOwnerId,
            processingStartedAt: this.clock().toISOString(), completedAt: undefined,
            failedAt: undefined, failureReason: undefined,
          };
          this.db.prepare('UPDATE inbound_message_receipts SET payload=?, claimed_at=? WHERE message_id=?')
            .run(json(reclaimed), reclaimed.processingStartedAt, reclaimed.messageId);
          if (admission && admission.status === 'rejected') {
            this.saveInboundAdmission({ ...admission, status: 'pending', error: undefined, updatedAt: reclaimed.processingStartedAt! });
          }
          return {
            claimed: true, receipt: reclaimed,
            reason: existing.status === 'failed' ? 'reclaimed_after_failure' : 'reclaimed_after_restart',
          };
        }
        const duplicate: InboundMessageReceipt = {
          ...existing, duplicateCount: existing.duplicateCount + 1, lastDuplicateAt: this.clock().toISOString(),
        };
        this.db.prepare('UPDATE inbound_message_receipts SET payload=? WHERE message_id=?')
          .run(json(duplicate), duplicate.messageId);
        return { claimed: false, receipt: duplicate };
      }
      const now = this.clock().toISOString();
      const receipt: InboundMessageReceipt = {
        messageId: input.messageId!, chatId: input.chatId, chatType: input.chatType, userId: input.userId,
        textPreview: input.text.slice(0, 200), firstReceivedAt: now, processingStartedAt: now,
        claimOwnerId: this.inboundClaimOwnerId, duplicateCount: 0, status: 'processing',
      };
      this.db.prepare('INSERT INTO inbound_message_receipts(message_id, payload, claimed_at) VALUES (?, ?, ?)')
        .run(receipt.messageId, json(receipt), receipt.firstReceivedAt);
      this.saveInboundAdmission({
        admissionId: `admission:${receipt.messageId}`,
        source: 'feishu',
        externalMessageId: receipt.messageId,
        ownerId: input.userId,
        rawPayload: input,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      });
      return { claimed: true, receipt };
    });
    return claim.immediate();
  }

  completeInboundMessage(messageId?: string): void {
    if (!messageId) return;
    const complete = this.db.transaction(() => {
      const current = payloadRow<InboundMessageReceipt>(
        this.db.prepare('SELECT payload FROM inbound_message_receipts WHERE message_id=?').get(messageId),
      );
      if (!current || current.claimOwnerId !== this.inboundClaimOwnerId) return;
      const completed: InboundMessageReceipt = {
        ...current, status: 'completed', completedAt: this.clock().toISOString(),
      };
      this.db.prepare('UPDATE inbound_message_receipts SET payload=? WHERE message_id=?')
        .run(json(completed), messageId);
      const admission = this.getInboundAdmissionByExternalMessageId(messageId);
      if (admission && (admission.status === 'received' || admission.status === 'pending')) {
        this.saveInboundAdmission({ ...admission, status: 'completed', updatedAt: completed.completedAt! });
      }
    });
    complete.immediate();
  }

  failInboundMessage(messageId: string | undefined, reason: string): void {
    if (!messageId) return;
    const fail = this.db.transaction(() => {
      const current = payloadRow<InboundMessageReceipt>(
        this.db.prepare('SELECT payload FROM inbound_message_receipts WHERE message_id=?').get(messageId),
      );
      if (!current || current.claimOwnerId !== this.inboundClaimOwnerId || current.status === 'completed') return;
      const failed: InboundMessageReceipt = {
        ...current, status: 'failed', failedAt: this.clock().toISOString(), failureReason: reason.slice(0, 500),
      };
      this.db.prepare('UPDATE inbound_message_receipts SET payload=? WHERE message_id=?')
        .run(json(failed), messageId);
      const admission = this.getInboundAdmissionByExternalMessageId(messageId);
      if (admission?.status === 'submitting') {
        this.saveInboundAdmission({ ...admission, status: 'unknown', error: failed.failureReason, updatedAt: failed.failedAt! });
      } else if (admission && admission.status !== 'accepted' && admission.status !== 'completed' && admission.status !== 'unknown') {
        this.saveInboundAdmission({ ...admission, status: 'rejected', error: failed.failureReason, updatedAt: failed.failedAt! });
      }
    });
    fail.immediate();
  }

  getInboundAdmission(admissionId: string): InboundAdmissionRecord | undefined {
    return payloadRow<InboundAdmissionRecord>(
      this.db.prepare('SELECT payload FROM inbound_admissions WHERE admission_id=?').get(admissionId),
    );
  }

  getInboundAdmissionByExternalMessageId(externalMessageId: string): InboundAdmissionRecord | undefined {
    return payloadRow<InboundAdmissionRecord>(
      this.db.prepare("SELECT payload FROM inbound_admissions WHERE source='feishu' AND external_message_id=?")
        .get(externalMessageId),
    );
  }

  listInboundAdmissions(status?: InboundAdmissionStatus): InboundAdmissionRecord[] {
    const rows = status
      ? this.db.prepare('SELECT payload FROM inbound_admissions WHERE status=? ORDER BY created_at,admission_id').all(status)
      : this.db.prepare('SELECT payload FROM inbound_admissions ORDER BY created_at,admission_id').all();
    return rows.map(payloadRowRequired<InboundAdmissionRecord>);
  }

  bindInboundAdmission(input: {
    externalMessageId: string; taskId: string; turnId: string; action: 'start'|'steer';
  }): InboundAdmissionRecord | undefined {
    return this.db.transaction(() => {
      const admission = this.getInboundAdmissionByExternalMessageId(input.externalMessageId);
      if (!admission) return undefined;
      if (admission.taskId && admission.taskId !== input.taskId) {
        throw new Error('Inbound admission is already bound to another task.');
      }
      if (admission.action && admission.action !== input.action) {
        throw new Error('Inbound admission action is immutable after binding.');
      }
      if (admission.turnId && admission.turnId !== input.turnId) {
        throw new Error('Inbound admission turn is immutable after binding.');
      }
      const next = {
        ...admission, taskId: input.taskId, turnId: input.turnId,
        action: input.action, updatedAt: this.clock().toISOString(),
      };
      this.saveInboundAdmission(next);
      return next;
    }).immediate();
  }

  transitionInboundAdmission(input: {
    externalMessageId: string;
    expectedStatuses: InboundAdmissionStatus[];
    status: InboundAdmissionStatus;
    sandboxGeneration?: number;
    processGeneration?: number;
    error?: string;
  }): InboundAdmissionRecord | undefined {
    return this.db.transaction(() => {
      const admission = this.getInboundAdmissionByExternalMessageId(input.externalMessageId);
      if (!admission || !input.expectedStatuses.includes(admission.status)) return undefined;
      const next: InboundAdmissionRecord = {
        ...admission,
        status: input.status,
        ...(input.sandboxGeneration === undefined ? {} : { sandboxGeneration: input.sandboxGeneration }),
        ...(input.processGeneration === undefined ? {} : { processGeneration: input.processGeneration }),
        ...(input.error === undefined ? { error: undefined } : { error: input.error.slice(0, 500) }),
        updatedAt: this.clock().toISOString(),
      };
      this.saveInboundAdmission(next);
      return next;
    }).immediate();
  }

  completeInboundAdmissionsForTurn(input: {
    taskId: string; turnId: string; error?: string;
  }): InboundAdmissionRecord[] {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT payload FROM inbound_admissions
        WHERE task_id=? AND turn_id=? AND status='accepted'
        ORDER BY created_at,admission_id
      `).all(input.taskId, input.turnId) as Array<{ payload: string }>;
      const now = this.clock().toISOString();
      return rows.map((row) => {
        const admission = JSON.parse(row.payload) as InboundAdmissionRecord;
        const completed: InboundAdmissionRecord = {
          ...admission,
          status: 'completed',
          ...(input.error ? { error: input.error.slice(0, 500) } : {}),
          updatedAt: now,
        };
        this.saveInboundAdmission(completed);
        return completed;
      });
    }).immediate();
  }

  private saveInboundAdmission(record: InboundAdmissionRecord): void {
    this.db.prepare(`
      INSERT INTO inbound_admissions(
        admission_id,source,external_message_id,owner_id,task_id,turn_id,action,
        sandbox_generation,process_generation,status,payload,created_at,updated_at
      ) VALUES (
        @admissionId,@source,@externalMessageId,@ownerId,@taskId,@turnId,@action,
        @sandboxGeneration,@processGeneration,@status,@payload,@createdAt,@updatedAt
      )
      ON CONFLICT(admission_id) DO UPDATE SET task_id=excluded.task_id,turn_id=excluded.turn_id,action=excluded.action,
        sandbox_generation=excluded.sandbox_generation,process_generation=excluded.process_generation,
        status=excluded.status,payload=excluded.payload,updated_at=excluded.updated_at
    `).run({
      ...record,
      taskId: record.taskId ?? null,
      turnId: record.turnId ?? null,
      action: record.action ?? null,
      sandboxGeneration: record.sandboxGeneration ?? null,
      processGeneration: record.processGeneration ?? null,
      payload: json(record),
    });
  }

  private reconcileSubmittingAdmissionsAfterRestart(): void {
    const now = this.clock().toISOString();
    const rows = this.db.prepare("SELECT payload FROM inbound_admissions WHERE status='submitting'")
      .all() as Array<{ payload: string }>;
    for (const row of rows) {
      const admission = JSON.parse(row.payload) as InboundAdmissionRecord;
      this.saveInboundAdmission({
        ...admission,
        status: 'unknown',
        error: admission.error ?? 'manager restarted before App Server acceptance was confirmed',
        updatedAt: now,
      });
    }
  }

  saveReadySlot(slot: ReadySlotRecord): void {
    this.db.prepare(`
      INSERT INTO ready_slots(id, version_key, status, claimed_by_task_id, payload, created_at, updated_at)
      VALUES (@id, @versionKey, @status, @claimedByTaskId, @payload, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, claimed_by_task_id=excluded.claimed_by_task_id,
        payload=excluded.payload, updated_at=excluded.updated_at
    `).run({ ...slot, claimedByTaskId: slot.claimedByTaskId ?? null, payload: json(slot) });
  }

  claimReadySlot(versionKey: string, taskId: string): ReadySlotRecord | undefined {
    return this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT payload FROM ready_slots WHERE version_key = ? AND status = 'ready' ORDER BY created_at, id LIMIT 1
      `).get(versionKey);
      const slot = payloadRow<ReadySlotRecord>(row);
      if (!slot) return undefined;
      const now = this.clock().toISOString();
      const claimed: ReadySlotRecord = { ...slot, status: 'claimed', claimedByTaskId: taskId, updatedAt: now };
      const result = this.db.prepare(`
        UPDATE ready_slots SET status='claimed', claimed_by_task_id=?, payload=?, updated_at=?
        WHERE id=? AND status='ready'
      `).run(taskId, json(claimed), now, slot.id);
      return result.changes === 1 ? claimed : undefined;
    })();
  }

  listReadySlots(versionKey?: string): ReadySlotRecord[] {
    const rows = versionKey
      ? this.db.prepare("SELECT payload FROM ready_slots WHERE status='ready' AND version_key=? ORDER BY created_at, id").all(versionKey)
      : this.db.prepare("SELECT payload FROM ready_slots WHERE status='ready' ORDER BY created_at, id").all();
    return rows.map(payloadRowRequired<ReadySlotRecord>);
  }

  discardReadySlot(slotId: string): ReadySlotRecord | undefined {
    return this.db.transaction(() => {
      const slot = payloadRow<ReadySlotRecord>(this.db.prepare('SELECT payload FROM ready_slots WHERE id=?').get(slotId));
      if (!slot || slot.status !== 'ready') return undefined;
      const discarded: ReadySlotRecord = { ...slot, status: 'discarded', updatedAt: this.clock().toISOString() };
      const changed = this.db.prepare("UPDATE ready_slots SET status='discarded', payload=?, updated_at=? WHERE id=? AND status='ready'")
        .run(json(discarded), discarded.updatedAt, slotId).changes;
      return changed === 1 ? discarded : undefined;
    })();
  }

  listEvictableHotTasks(): TaskRecord[] {
    const rows = this.db.prepare(`
      SELECT t.payload FROM tasks t
      WHERE t.runtime_state='hot'
        AND json_extract(t.payload, '$.pinned')=0
        AND NOT EXISTS (SELECT 1 FROM turns WHERE task_id=t.id AND state IN ('queued','submitted','running','waiting_approval'))
        AND NOT EXISTS (SELECT 1 FROM approvals WHERE task_id=t.id AND status IN ('pending','decided'))
        AND NOT EXISTS (SELECT 1 FROM publish_requests WHERE task_id=t.id AND status IN ('pending','publishing','unknown'))
        AND NOT EXISTS (SELECT 1 FROM runtime_leases WHERE task_id=t.id AND status='active')
        AND NOT EXISTS (SELECT 1 FROM lifecycle_intents WHERE task_id=t.id AND status='pending')
      ORDER BY t.last_user_interaction_at, t.id
    `).all();
    return rows.map(payloadRowRequired<TaskRecord>);
  }

  taskCleanupBlockers(taskId: string): string[] {
    const task = this.getTask(taskId);
    if (!task) return ['missing_task'];
    const blockers: string[] = [];
    if (task.pinned) blockers.push('pinned');
    if (task.activeTurnId) blockers.push('active_turn');
    const checks: Array<[string, string]> = [
      ['nonterminal_turn', "SELECT 1 FROM turns WHERE task_id=? AND state IN ('queued','submitted','running','waiting_approval') LIMIT 1"],
      ['approval', "SELECT 1 FROM approvals WHERE task_id=? AND status IN ('pending','decided') LIMIT 1"],
      ['publish', "SELECT 1 FROM publish_requests WHERE task_id=? AND status IN ('pending','publishing','unknown') LIMIT 1"],
      ['runtime_lease', "SELECT 1 FROM runtime_leases WHERE task_id=? AND status='active' LIMIT 1"],
      ['lifecycle_intent', "SELECT 1 FROM lifecycle_intents WHERE task_id=? AND status='pending' LIMIT 1"],
      ['external_operation', "SELECT 1 FROM external_operation_claims WHERE status='pending' AND json_extract(payload, '$.taskId')=? LIMIT 1"],
      ['dream_job', "SELECT 1 FROM dream_jobs WHERE scope_type='task' AND scope_id=? AND status IN ('pending','running') LIMIT 1"],
    ];
    for (const [name, sql] of checks) {
      if (this.db.prepare(sql).get(taskId)) blockers.push(name);
    }
    return blockers;
  }

  hotTaskCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE runtime_state='hot'").get() as { count: number }).count;
  }

  hotCapacityCount(): number {
    return (this.db.prepare(`
      SELECT COUNT(DISTINCT capacity_key) AS count FROM (
        SELECT CASE
          WHEN json_extract(payload, '$.runtimeMode')='user-sandbox' THEN 'user:' || owner_user_id
          ELSE 'task:' || id
        END AS capacity_key
        FROM tasks WHERE runtime_state='hot'
        UNION ALL
        SELECT CASE
          WHEN json_extract(task.payload, '$.runtimeMode')='user-sandbox' THEN 'user:' || task.owner_user_id
          ELSE 'task:' || task.id
        END AS capacity_key
        FROM runtime_leases AS lease
        JOIN tasks AS task ON task.id=lease.task_id
        WHERE lease.lease_type='hot_start' AND lease.status='active'
      )
    `).get() as { count: number }).count;
  }

  claimHotStart(taskId: string, maxHotTasks: number): boolean {
    return this.db.transaction(() => {
      const task = this.getTask(taskId);
      if (!task) return false;
      const sameUnitActive = this.isHotCapacityUnitActive(taskId);
      if (!sameUnitActive && this.hotCapacityCount() >= maxHotTasks) return false;
      const now = this.clock().toISOString();
      return this.db.prepare(`
        INSERT INTO runtime_leases(id, task_id, lease_type, status, payload, created_at, updated_at)
        VALUES (?, ?, 'hot_start', 'active', '{}', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status='active',
          payload=excluded.payload,
          updated_at=excluded.updated_at
        WHERE runtime_leases.status='released'
      `).run(`hot-start:${taskId}`, taskId, now, now).changes === 1;
    })();
  }

  isHotCapacityUnitActive(taskId: string): boolean {
    const task = this.getTask(taskId);
    if (!task) return false;
    return task.runtimeMode === 'user-sandbox'
      ? Boolean(this.db.prepare(`
        SELECT 1 FROM tasks AS candidate
        WHERE candidate.owner_user_id=?
          AND json_extract(candidate.payload, '$.runtimeMode')='user-sandbox'
          AND (candidate.runtime_state='hot' OR EXISTS (
            SELECT 1 FROM runtime_leases AS lease
            WHERE lease.task_id=candidate.id AND lease.lease_type='hot_start' AND lease.status='active'
          )) LIMIT 1
      `).get(task.ownerUserId))
      : task.runtimeState === 'hot' || Boolean(this.db.prepare(`
        SELECT 1 FROM runtime_leases
        WHERE task_id=? AND lease_type='hot_start' AND status='active' LIMIT 1
      `).get(taskId));
  }

  releaseHotStart(taskId: string): boolean {
    return this.db.prepare("UPDATE runtime_leases SET status='released', updated_at=? WHERE id=? AND status='active'")
      .run(this.clock().toISOString(), `hot-start:${taskId}`).changes === 1;
  }

  completeHotStart(taskId: string, succeeded: boolean): TaskRecord | undefined {
    return this.db.transaction(() => {
      const task = this.getTask(taskId);
      if (!task) return undefined;
      const now = this.clock().toISOString();
      const next = succeeded ? { ...task, runtimeState: 'hot' as const, updatedAt: now } : task;
      if (succeeded) this.saveTask(next);
      this.releaseHotStart(taskId);
      return next;
    })();
  }

  claimActiveTurn(
    taskId: string,
    turnId: string,
    maxActiveTurns: number,
    ownerLimit?: { ownerId: string; maxActiveTurns: number },
  ): boolean {
    const claim = this.db.transaction(() => {
      const count = (this.db.prepare("SELECT COUNT(*) AS count FROM runtime_leases WHERE lease_type='active_turn' AND status='active'").get() as { count: number }).count;
      if (count >= maxActiveTurns) return false;
      if (ownerLimit) {
        const ownerCount = (this.db.prepare(`
          SELECT COUNT(*) AS count
          FROM runtime_leases AS lease
          JOIN tasks AS task ON task.id = lease.task_id
          WHERE lease.lease_type='active_turn' AND lease.status='active' AND task.owner_user_id=?
        `).get(ownerLimit.ownerId) as { count: number }).count;
        if (ownerCount >= ownerLimit.maxActiveTurns) return false;
      }
      const now = this.clock().toISOString();
      const payload = { turnId };
      return this.db.prepare(`
        INSERT OR IGNORE INTO runtime_leases(id, task_id, lease_type, status, payload, created_at, updated_at)
        VALUES (?, ?, 'active_turn', 'active', ?, ?, ?)
      `).run(`active-turn:${turnId}`, taskId, json(payload), now, now).changes === 1;
    });
    // Both the gateway and host-manager write this WAL database. Reserve the
    // writer before reading capacity so the read snapshot never needs a
    // fallible deferred-transaction promotion (SQLITE_BUSY_SNAPSHOT).
    return claim.immediate();
  }

  releaseActiveTurn(turnId: string): boolean {
    return this.db.prepare("UPDATE runtime_leases SET status='released', updated_at=? WHERE id=? AND status='active'")
      .run(this.clock().toISOString(), `active-turn:${turnId}`).changes === 1;
  }

  releaseTaskLeases(taskId: string): number {
    return this.db.prepare("UPDATE runtime_leases SET status='released', updated_at=? WHERE task_id=? AND status='active'")
      .run(this.clock().toISOString(), taskId).changes;
  }

  recordResourceSample(input: { taskId?: string; sampleType: 'idle_task_rss' | 'host_used'; bytes: number; createdAt?: string }): void {
    this.db.prepare('INSERT INTO resource_samples(task_id, sample_type, bytes, created_at) VALUES (?, ?, ?, ?)')
      .run(input.taskId ?? null, input.sampleType, input.bytes, input.createdAt ?? this.clock().toISOString());
  }

  resourceSampleP95(sampleType: 'idle_task_rss' | 'host_used', since: string, minimumSamples = 20): number | undefined {
    const rows = this.db.prepare('SELECT bytes FROM resource_samples WHERE sample_type=? AND created_at>=? ORDER BY bytes')
      .all(sampleType, since) as Array<{ bytes: number }>;
    if (rows.length < minimumSamples) return undefined;
    return rows[Math.ceil(rows.length * 0.95) - 1]?.bytes;
  }

  recordStartupMetric(input: { taskId?: string; startupType: 'ready' | 'warm' | 'cold'; durationMs: number; createdAt?: string }): void {
    this.db.prepare('INSERT INTO startup_metrics(task_id, startup_type, duration_ms, created_at) VALUES (?, ?, ?, ?)')
      .run(input.taskId ?? null, input.startupType, input.durationMs, input.createdAt ?? this.clock().toISOString());
  }

  startupLatency(startupType: 'ready' | 'warm' | 'cold'): { p50: number; p95: number; count: number } | undefined {
    const rows = this.db.prepare('SELECT duration_ms AS durationMs FROM startup_metrics WHERE startup_type=? ORDER BY duration_ms')
      .all(startupType) as Array<{ durationMs: number }>;
    if (rows.length === 0) return undefined;
    return {
      p50: percentile(rows.map((row) => row.durationMs), 0.5),
      p95: percentile(rows.map((row) => row.durationMs), 0.95),
      count: rows.length,
    };
  }

  saveLiveCard(input: { id: string; taskId?: string; turnId?: string; operationSequence: number; payload: unknown; createdAt: string; updatedAt: string }): void {
    this.db.prepare(`
      INSERT INTO live_cards(id, task_id, turn_id, operation_sequence, payload, created_at, updated_at)
      VALUES (@id, @taskId, @turnId, @operationSequence, @payload, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET operation_sequence=excluded.operation_sequence, payload=excluded.payload, updated_at=excluded.updated_at
    `).run({ ...input, taskId: input.taskId ?? null, turnId: input.turnId ?? null, payload: json(input.payload) });
  }

  advanceLiveCard(input: { id: string; expectedSequence: number; nextSequence: number; payload: unknown }): boolean {
    const result = this.db.prepare(`
      UPDATE live_cards SET operation_sequence=?, payload=?, updated_at=?
      WHERE id=? AND operation_sequence=?
    `).run(input.nextSequence, json(input.payload), this.clock().toISOString(), input.id, input.expectedSequence);
    return result.changes === 1;
  }

  claimExternalOperation(input: { idempotencyKey: string; operationType: string; payload: unknown }): boolean {
    const now = this.clock().toISOString();
    return this.db.prepare(`
      INSERT OR IGNORE INTO external_operation_claims(idempotency_key, operation_type, status, payload, created_at, updated_at)
      VALUES (?, ?, 'pending', ?, ?, ?)
    `).run(input.idempotencyKey, input.operationType, json(input.payload), now, now).changes === 1;
  }

  beginLifecycleIntent(intent: LifecycleIntentRecord): void {
    this.db.transaction(() => {
      const task = this.getTask(intent.taskId);
      if (!task || task.runtimeState !== intent.fromState) throw new Error(`Lifecycle precondition failed for ${intent.taskId}.`);
      this.db.prepare(`
        INSERT INTO lifecycle_intents(id, task_id, from_state, to_state, status, observed_state, created_at, updated_at)
        VALUES (@id, @taskId, @fromState, @toState, @status, @observedState, @createdAt, @updatedAt)
      `).run({ ...intent, observedState: intent.observedState ?? null });
      this.saveTask({ ...task, runtimeState: intent.toState, updatedAt: intent.updatedAt });
    })();
  }

  completeLifecycleIntent(intentId: string, observedState: TaskRuntimeState): void {
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT task_id AS taskId, to_state AS toState FROM lifecycle_intents WHERE id=? AND status=?')
        .get(intentId, 'pending') as { taskId: string; toState: TaskRuntimeState } | undefined;
      if (!row) return;
      const matchesIntent = row.toState === observedState || (row.toState === 'warming' && observedState === 'warm');
      if (!matchesIntent) throw new Error(`Observed lifecycle state does not match intent ${intentId}.`);
      const now = this.clock().toISOString();
      this.db.prepare(`UPDATE lifecycle_intents SET status='completed', observed_state=?, updated_at=? WHERE id=?`)
        .run(observedState, now, intentId);
      const task = this.getTask(row.taskId);
      if (task) this.saveTask({ ...task, runtimeState: observedState, updatedAt: now });
    })();
  }

  listPendingLifecycleIntents(): LifecycleIntentRecord[] {
    const rows = this.db.prepare(`
      SELECT id, task_id AS taskId, from_state AS fromState, to_state AS toState, status,
        observed_state AS observedState, created_at AS createdAt, updated_at AS updatedAt
      FROM lifecycle_intents WHERE status='pending' ORDER BY created_at, id
    `).all() as LifecycleIntentRecord[];
    return rows.map((row) => ({ ...row, ...(row.observedState ? {} : { observedState: undefined }) }));
  }

  wasArchivedByWarmRetention(taskId: string): boolean {
    const latest = this.db.prepare(`
      SELECT id, from_state AS fromState, to_state AS toState, status
      FROM lifecycle_intents WHERE task_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(taskId) as Pick<LifecycleIntentRecord, 'id' | 'fromState' | 'toState' | 'status'> | undefined;
    return Boolean(latest?.id.startsWith('disk_cleanup_')
      && latest.fromState === 'warm' && latest.toState === 'archived' && latest.status === 'completed');
  }

  reconcileLifecycleIntent(intentId: string, observedState: TaskRuntimeState): void {
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT task_id AS taskId FROM lifecycle_intents WHERE id=? AND status=?')
        .get(intentId, 'pending') as { taskId: string } | undefined;
      if (!row) return;
      const now = this.clock().toISOString();
      this.db.prepare(`UPDATE lifecycle_intents SET status='reconciled', observed_state=?, updated_at=? WHERE id=?`)
        .run(observedState, now, intentId);
      const task = this.getTask(row.taskId);
      if (task) this.saveTask({ ...task, runtimeState: observedState, updatedAt: now });
    })();
  }
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function rejectCredentialFields(record: object): void {
  if (Object.keys(record).some((key) => /(?:token|password|credential|secret|auth)/i.test(key))) {
    throw new Error('Provider credentials must not be persisted in project metadata.');
  }
}

function payloadRow<T>(row: unknown): T | undefined {
  if (!row) return undefined;
  return JSON.parse((row as { payload: string }).payload) as T;
}

function payloadRowRequired<T>(row: unknown): T {
  const value = payloadRow<T>(row);
  if (!value) throw new Error('SQLite row has no payload.');
  return value;
}

function percentile(sorted: number[], ratio: number): number {
  return sorted[Math.ceil(sorted.length * ratio) - 1] ?? 0;
}
