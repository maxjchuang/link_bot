import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  ApprovalRecord,
  BotErrorLogEntry,
  BotEvent,
  ChatContext,
  ClaimInboundMessageInput,
  ClaimInboundMessageResult,
  CreateDestructiveCommandRequestResult,
  DecideDestructiveCommandResult,
  DestructiveCommand,
  DestructiveCommandRequest,
  InboundMessageReceipt,
  SessionRecord,
} from '../domain/types.js';
import type { AppServerRequestRecord, DecideAppServerRequestResult } from '../approvals/AppServerRequestTypes.js';
import type { TaskBindingRecord, TaskRecord, TurnRecord } from '../tasks/TaskTypes.js';
import type { LiveTurnRecord } from '../livecards/LiveTurnCardTypes.js';

type Clock = () => Date;
type WriteQueueName = 'state' | 'events' | 'sessionLogs';

const MAX_TAIL_SCAN_BYTES = 1_048_576;
const MAX_LOG_LINE_CHARS = 16_384;

function capLogLine(line: string): string {
  if (line.length <= MAX_LOG_LINE_CHARS) {
    return line;
  }
  return `[truncated ${line.length - MAX_LOG_LINE_CHARS} chars]${line.slice(-MAX_LOG_LINE_CHARS)}`;
}

function sameAnswers(
  left: Record<string, string[]> | undefined,
  right: Record<string, string[]> | undefined,
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

async function readFileWindow(filePath: string, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const file = await open(filePath, 'r');
  let bytesRead = 0;
  try {
    while (bytesRead < length) {
      const result = await file.read(buffer, bytesRead, length - bytesRead, position + bytesRead);
      if (result.bytesRead === 0) {
        break;
      }
      bytesRead += result.bytesRead;
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

export class FileStateStore {
  private readonly writeChains: Record<WriteQueueName, Promise<unknown>> = {
    state: Promise.resolve(),
    events: Promise.resolve(),
    sessionLogs: Promise.resolve(),
  };
  private readonly writeContext = new AsyncLocalStorage<WriteQueueName>();
  private readonly baseDir: string;
  private readonly inboundClaimOwnerId = randomUUID();

  constructor(projectRoot: string, private readonly clock: Clock = () => new Date()) {
    this.baseDir = join(projectRoot, '.link-bot');
  }

  async saveChat(chat: ChatContext): Promise<void> {
    const id = this.safeFileName(chat.chatId);
    await this.writeJson(join(this.baseDir, 'state/chats', `${id}.json`), chat);
  }

  async getChat(chatId: string): Promise<ChatContext | undefined> {
    const id = this.safeFileName(chatId);
    return this.readJson<ChatContext>(join(this.baseDir, 'state/chats', `${id}.json`));
  }

  async listChats(): Promise<ChatContext[]> {
    const chats = await this.readJsonDirectory<ChatContext>(join(this.baseDir, 'state/chats'));
    return chats.sort((a, b) => a.chatId.localeCompare(b.chatId));
  }

  async saveTaskBinding(binding: TaskBindingRecord): Promise<void> {
    const id = this.safeFileName(binding.id);
    await this.writeJson(join(this.baseDir, 'state/task-bindings', `${id}.json`), binding);
  }

  async getTaskBinding(bindingId: string): Promise<TaskBindingRecord | undefined> {
    const id = this.safeFileName(bindingId);
    return this.readJson<TaskBindingRecord>(join(this.baseDir, 'state/task-bindings', `${id}.json`));
  }

  async saveTask(task: TaskRecord): Promise<void> {
    const id = this.safeFileName(task.id);
    await this.writeJson(join(this.baseDir, 'state/tasks', `${id}.json`), task);
  }

  async getTask(taskId: string): Promise<TaskRecord | undefined> {
    const id = this.safeFileName(taskId);
    return this.readJson<TaskRecord>(join(this.baseDir, 'state/tasks', `${id}.json`));
  }

  async listTasks(): Promise<TaskRecord[]> {
    const tasks = await this.readJsonDirectory<TaskRecord>(join(this.baseDir, 'state/tasks'));
    return tasks.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async updateTask(taskId: string, updater: (current: TaskRecord) => TaskRecord): Promise<TaskRecord | undefined> {
    const id = this.safeFileName(taskId);
    const filePath = join(this.baseDir, 'state/tasks', `${id}.json`);
    return this.enqueue('state', async () => {
      const current = await this.readJson<TaskRecord>(filePath);
      if (!current) return undefined;
      const next = updater(current);
      await this.writeJsonFile(filePath, next);
      return next;
    });
  }

  async saveTurn(turn: TurnRecord): Promise<void> {
    const id = this.safeFileName(turn.id);
    await this.writeJson(join(this.baseDir, 'state/turns', `${id}.json`), turn);
  }

  async getTurn(turnId: string): Promise<TurnRecord | undefined> {
    const id = this.safeFileName(turnId);
    return this.readJson<TurnRecord>(join(this.baseDir, 'state/turns', `${id}.json`));
  }

  async updateTurn(turnId: string, updater: (current: TurnRecord) => TurnRecord): Promise<TurnRecord | undefined> {
    const id = this.safeFileName(turnId);
    const filePath = join(this.baseDir, 'state/turns', `${id}.json`);
    return this.enqueue('state', async () => {
      const current = await this.readJson<TurnRecord>(filePath);
      if (!current) return undefined;
      const next = updater(current);
      await this.writeJsonFile(filePath, next);
      return next;
    });
  }

  async listNonterminalTurns(): Promise<TurnRecord[]> {
    const terminal = new Set<TurnRecord['state']>(['completed', 'interrupted', 'failed']);
    const turns = await this.readJsonDirectory<TurnRecord>(join(this.baseDir, 'state/turns'));
    return turns.filter((turn) => !terminal.has(turn.state)).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async createAppServerRequest(record: AppServerRequestRecord): Promise<{ created: boolean; request: AppServerRequestRecord }> {
    const id = this.safeFileName(record.id);
    const filePath = join(this.baseDir, 'state/app-server-requests', `${id}.json`);
    return this.enqueue('state', async () => {
      const current = await this.readJson<AppServerRequestRecord>(filePath);
      if (current) return { created: false, request: current };
      await this.writeJsonFile(filePath, record);
      return { created: true, request: record };
    });
  }

  async getAppServerRequest(requestId: string): Promise<AppServerRequestRecord | undefined> {
    const id = this.safeFileName(requestId);
    return this.readJson<AppServerRequestRecord>(join(this.baseDir, 'state/app-server-requests', `${id}.json`));
  }

  async listPendingAppServerRequests(): Promise<AppServerRequestRecord[]> {
    const requests = await this.readJsonDirectory<AppServerRequestRecord>(join(this.baseDir, 'state/app-server-requests'));
    return requests
      .filter((request) => request.status === 'pending' || request.status === 'decided')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async updateAppServerRequest(requestId: string, updater: (current: AppServerRequestRecord) => AppServerRequestRecord): Promise<AppServerRequestRecord | undefined> {
    const id = this.safeFileName(requestId);
    const filePath = join(this.baseDir, 'state/app-server-requests', `${id}.json`);
    return this.enqueue('state', async () => {
      const current = await this.readJson<AppServerRequestRecord>(filePath);
      if (!current) return undefined;
      const next = updater(current);
      await this.writeJsonFile(filePath, next);
      return next;
    });
  }

  async decideAppServerRequest(input: {
    requestId: string;
    userId: string;
    generation: number;
    decision: 'allow' | 'deny' | 'answer';
    answers?: Record<string, string[]>;
  }): Promise<DecideAppServerRequestResult> {
    const id = this.safeFileName(input.requestId);
    const filePath = join(this.baseDir, 'state/app-server-requests', `${id}.json`);
    return this.enqueue('state', async () => {
      const request = await this.readJson<AppServerRequestRecord>(filePath);
      if (!request) return { accepted: false, reason: 'not_found' };
      if (request.ownerUserId !== input.userId) {
        return { accepted: false, reason: 'identity_mismatch', request };
      }
      if (request.generation !== input.generation) {
        return { accepted: false, reason: 'generation_mismatch', request };
      }
      if (request.status === 'decided' || request.status === 'delivered') {
        const sameDecision = request.decision === input.decision && sameAnswers(request.answers, input.answers);
        if (sameDecision) return { accepted: true, duplicate: true, request };
        return { accepted: false, reason: 'not_pending', request };
      }
      if (request.status !== 'pending') return { accepted: false, reason: 'not_pending', request };
      const now = this.clock().toISOString();
      if (request.expiresAt <= now) {
        const expired: AppServerRequestRecord = { ...request, status: 'expired', invalidatedAt: now };
        await this.writeJsonFile(filePath, expired);
        return { accepted: false, reason: 'expired', request: expired };
      }
      const decided: AppServerRequestRecord = {
        ...request,
        status: 'decided',
        decision: input.decision,
        ...(input.answers ? { answers: input.answers } : {}),
        decidedAt: now,
      };
      await this.writeJsonFile(filePath, decided);
      return { accepted: true, duplicate: false, request: decided };
    });
  }

  async markAppServerRequestDelivered(requestId: string): Promise<AppServerRequestRecord | undefined> {
    const id = this.safeFileName(requestId);
    const filePath = join(this.baseDir, 'state/app-server-requests', `${id}.json`);
    return this.enqueue('state', async () => {
      const request = await this.readJson<AppServerRequestRecord>(filePath);
      if (!request || request.status !== 'decided') return request;
      const delivered: AppServerRequestRecord = {
        ...request,
        status: 'delivered',
        deliveredAt: this.clock().toISOString(),
      };
      await this.writeJsonFile(filePath, delivered);
      return delivered;
    });
  }

  async invalidateAppServerRequests(taskId: string, activeGeneration: number): Promise<AppServerRequestRecord[]> {
    return this.enqueue('state', async () => {
      const directory = join(this.baseDir, 'state/app-server-requests');
      const requests = await this.readJsonDirectory<AppServerRequestRecord>(directory);
      const invalidated: AppServerRequestRecord[] = [];
      const now = this.clock().toISOString();
      for (const request of requests) {
        if (request.taskId !== taskId || request.generation === activeGeneration) continue;
        if (request.status !== 'pending' && request.status !== 'decided') continue;
        const next: AppServerRequestRecord = { ...request, status: 'connection_lost', invalidatedAt: now };
        await this.writeJsonFile(join(directory, `${this.safeFileName(request.id)}.json`), next);
        invalidated.push(next);
      }
      return invalidated;
    });
  }

  async saveSession(session: SessionRecord): Promise<void> {
    const id = this.safeFileName(session.id);
    await this.writeJson(join(this.baseDir, 'state/sessions', `${id}.json`), session);
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    const id = this.safeFileName(sessionId);
    return this.readJson<SessionRecord>(join(this.baseDir, 'state/sessions', `${id}.json`));
  }

  async listSessions(): Promise<SessionRecord[]> {
    const sessions = await this.readJsonDirectory<SessionRecord>(join(this.baseDir, 'state/sessions'));
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async updateSession(sessionId: string, updater: (current: SessionRecord) => SessionRecord): Promise<SessionRecord | undefined> {
    const id = this.safeFileName(sessionId);
    const filePath = join(this.baseDir, 'state/sessions', `${id}.json`);
    return this.enqueue('state', async () => {
      const current = await this.readJson<SessionRecord>(filePath);
      if (!current) {
        return undefined;
      }
      const next = updater(current);
      await this.writeJsonFile(filePath, next);
      return next;
    });
  }

  async listSessionsByChat(chatId: string, limit = 10): Promise<SessionRecord[]> {
    const sessions = await this.listSessions();
    return sessions
      .filter((session) => session.chatId === chatId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  async saveLiveTurn(record: LiveTurnRecord): Promise<void> {
    const id = this.safeFileName(record.turnId);
    await this.writeJson(join(this.baseDir, 'state/live-turns', `${id}.json`), record);
  }

  async getLiveTurn(turnId: string): Promise<LiveTurnRecord | undefined> {
    const id = this.safeFileName(turnId);
    return this.readJson<LiveTurnRecord>(join(this.baseDir, 'state/live-turns', `${id}.json`));
  }

  async updateLiveTurn(
    turnId: string,
    updater: (current: LiveTurnRecord) => LiveTurnRecord,
  ): Promise<LiveTurnRecord | undefined> {
    const id = this.safeFileName(turnId);
    const filePath = join(this.baseDir, 'state/live-turns', `${id}.json`);
    return this.enqueue('state', async () => {
      const current = await this.readJson<LiveTurnRecord>(filePath);
      if (!current) {
        return undefined;
      }
      const next = updater(current);
      await this.writeJsonFile(filePath, next);
      return next;
    });
  }

  async listOpenLiveTurns(): Promise<LiveTurnRecord[]> {
    const terminalStates = new Set<LiveTurnRecord['state']>(['finalized', 'failed', 'fallback']);
    const records = await this.readJsonDirectory<LiveTurnRecord>(join(this.baseDir, 'state/live-turns'));
    return records
      .filter((record) => !terminalStates.has(record.state))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  async saveApproval(approval: ApprovalRecord): Promise<void> {
    const id = this.safeFileName(approval.id);
    await this.writeJson(join(this.baseDir, 'state/approvals', `${id}.json`), approval);
  }

  async getApproval(approvalId: string): Promise<ApprovalRecord | undefined> {
    const id = this.safeFileName(approvalId);
    return this.readJson<ApprovalRecord>(join(this.baseDir, 'state/approvals', `${id}.json`));
  }

  async listPendingApprovalsByChat(chatId: string): Promise<ApprovalRecord[]> {
    const approvals = await this.listPendingApprovals();
    return approvals.filter((approval) => approval.chatId === chatId);
  }

  async listPendingApprovals(): Promise<ApprovalRecord[]> {
    await this.waitForPendingWrites('state');
    const approvalsDir = join(this.baseDir, 'state/approvals');
    let files: string[];
    try {
      files = await readdir(approvalsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const approvals = await Promise.all(
      files
        .filter((fileName) => fileName.endsWith('.json'))
        .map(async (fileName) => this.readJson<ApprovalRecord>(join(approvalsDir, fileName))),
    );

    return approvals.filter((approval): approval is ApprovalRecord => Boolean(approval && approval.status === 'pending'));
  }

  async claimInboundMessage(input: ClaimInboundMessageInput): Promise<ClaimInboundMessageResult> {
    if (!input.messageId) {
      return { claimed: true, reason: 'missing_message_id' };
    }

    const messageId = input.messageId;
    const id = this.safeFileName(messageId);
    const filePath = join(this.baseDir, 'state/inbound-messages', `${id}.json`);
    return this.enqueue('state', async () => {
      const current = await this.readJson<InboundMessageReceipt>(filePath);
      if (current) {
        if (current.status === 'failed' || (current.status !== 'completed' && current.claimOwnerId !== this.inboundClaimOwnerId)) {
          const reclaimed: InboundMessageReceipt = {
            ...current, status: 'processing', claimOwnerId: this.inboundClaimOwnerId,
            processingStartedAt: this.clock().toISOString(), completedAt: undefined,
            failedAt: undefined, failureReason: undefined,
          };
          await this.writeJsonFile(filePath, reclaimed);
          return {
            claimed: true, receipt: reclaimed,
            reason: current.status === 'failed' ? 'reclaimed_after_failure' : 'reclaimed_after_restart',
          };
        }
        const duplicate: InboundMessageReceipt = {
          ...current,
          lastDuplicateAt: this.clock().toISOString(),
          duplicateCount: current.duplicateCount + 1,
        };
        await this.writeJsonFile(filePath, duplicate);
        return { claimed: false, receipt: duplicate };
      }

      const receipt: InboundMessageReceipt = {
        messageId,
        chatId: input.chatId,
        chatType: input.chatType,
        userId: input.userId,
        textPreview: input.text.length <= 200 ? input.text : `${input.text.slice(0, 197)}...`,
        firstReceivedAt: this.clock().toISOString(),
        processingStartedAt: this.clock().toISOString(),
        claimOwnerId: this.inboundClaimOwnerId,
        duplicateCount: 0,
        status: 'processing',
      };
      await this.writeJsonFile(filePath, receipt);
      return { claimed: true, receipt };
    });
  }

  async completeInboundMessage(messageId?: string): Promise<void> {
    if (!messageId) return;
    const id = this.safeFileName(messageId);
    const filePath = join(this.baseDir, 'state/inbound-messages', `${id}.json`);
    await this.enqueue('state', async () => {
      const current = await this.readJson<InboundMessageReceipt>(filePath);
      if (!current || current.claimOwnerId !== this.inboundClaimOwnerId) return;
      await this.writeJsonFile(filePath, {
        ...current, status: 'completed', completedAt: this.clock().toISOString(),
      });
    });
  }

  async failInboundMessage(messageId: string | undefined, reason: string): Promise<void> {
    if (!messageId) return;
    const id = this.safeFileName(messageId);
    const filePath = join(this.baseDir, 'state/inbound-messages', `${id}.json`);
    await this.enqueue('state', async () => {
      const current = await this.readJson<InboundMessageReceipt>(filePath);
      if (!current || current.claimOwnerId !== this.inboundClaimOwnerId || current.status === 'completed') return;
      await this.writeJsonFile(filePath, {
        ...current, status: 'failed', failedAt: this.clock().toISOString(), failureReason: reason.slice(0, 500),
      });
    });
  }

  async getDestructiveCommandRequest(requestId: string): Promise<DestructiveCommandRequest | undefined> {
    const id = this.safeFileName(requestId);
    return this.readJson<DestructiveCommandRequest>(join(this.baseDir, 'state/destructive-commands', `${id}.json`));
  }

  async createDestructiveCommandRequest(input: {
    requestId: string;
    sourceEventId: string;
    userId: string;
    chatId: string;
    command: DestructiveCommand;
    ttlMs: number;
  }): Promise<CreateDestructiveCommandRequestResult> {
    const id = this.safeFileName(input.requestId);
    const directory = join(this.baseDir, 'state/destructive-commands');
    const filePath = join(directory, `${id}.json`);
    return this.enqueue('state', async () => {
      const requests = await this.readJsonDirectory<DestructiveCommandRequest>(directory);
      const retry = requests.find((request) => request.sourceEventId === input.sourceEventId);
      if (retry) {
        return { created: false, reason: 'event_retry', request: retry };
      }

      const now = this.clock();
      const nowIso = now.toISOString();
      for (const request of requests) {
        if (request.status === 'pending' && request.expiresAt <= nowIso) {
          await this.writeJsonFile(join(directory, `${this.safeFileName(request.id)}.json`), {
            ...request,
            status: 'expired',
            finishedAt: nowIso,
          });
        }
      }

      const pending = requests.find(
        (request) =>
          request.status === 'pending' &&
          request.expiresAt > nowIso &&
          request.userId === input.userId &&
          request.command === input.command,
      );
      if (pending) {
        return { created: false, reason: 'pending_exists', request: pending };
      }

      const request: DestructiveCommandRequest = {
        id: input.requestId,
        sourceEventId: input.sourceEventId,
        userId: input.userId,
        chatId: input.chatId,
        command: input.command,
        status: 'pending',
        createdAt: nowIso,
        expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
      };
      await this.writeJsonFile(filePath, request);
      return { created: true, request };
    });
  }

  async decideDestructiveCommand(input: {
    requestId: string;
    userId: string;
    chatId: string;
    decision: 'confirm' | 'cancel';
  }): Promise<DecideDestructiveCommandResult> {
    const id = this.safeFileName(input.requestId);
    const filePath = join(this.baseDir, 'state/destructive-commands', `${id}.json`);
    return this.enqueue('state', async () => {
      const request = await this.readJson<DestructiveCommandRequest>(filePath);
      if (!request) {
        return { accepted: false, reason: 'not_found' };
      }
      if (request.userId !== input.userId || request.chatId !== input.chatId) {
        return { accepted: false, reason: 'identity_mismatch', request };
      }
      if (request.status !== 'pending') {
        return { accepted: false, reason: 'not_pending', request };
      }

      const now = this.clock().toISOString();
      if (request.expiresAt <= now) {
        const expired: DestructiveCommandRequest = {
          ...request,
          status: 'expired',
          finishedAt: now,
        };
        await this.writeJsonFile(filePath, expired);
        return { accepted: false, reason: 'expired', request: expired };
      }

      const decided: DestructiveCommandRequest =
        input.decision === 'confirm'
          ? { ...request, status: 'executing', confirmedAt: now }
          : { ...request, status: 'cancelled', finishedAt: now };
      await this.writeJsonFile(filePath, decided);
      return { accepted: true, request: decided };
    });
  }

  async markDestructiveCommandFailed(input: {
    requestId: string;
    expectedStatus: 'pending' | 'executing';
    failure: string;
  }): Promise<DestructiveCommandRequest | undefined> {
    const id = this.safeFileName(input.requestId);
    const filePath = join(this.baseDir, 'state/destructive-commands', `${id}.json`);
    return this.enqueue('state', async () => {
      const request = await this.readJson<DestructiveCommandRequest>(filePath);
      if (!request || request.status !== input.expectedStatus) {
        return undefined;
      }
      const failed: DestructiveCommandRequest = {
        ...request,
        status: 'failed',
        failure: input.failure.slice(0, 500),
        finishedAt: this.clock().toISOString(),
      };
      await this.writeJsonFile(filePath, failed);
      return failed;
    });
  }

  async commitDestructiveCommandRestart(requestId: string): Promise<DestructiveCommandRequest | undefined> {
    const id = this.safeFileName(requestId);
    const filePath = join(this.baseDir, 'state/destructive-commands', `${id}.json`);
    return this.enqueue('state', async () => {
      const request = await this.readJson<DestructiveCommandRequest>(filePath);
      if (!request || request.status !== 'executing') {
        return undefined;
      }
      const committed: DestructiveCommandRequest = {
        ...request,
        status: 'restart_committed',
        committedAt: this.clock().toISOString(),
      };
      await this.writeJsonFile(filePath, committed);
      return committed;
    });
  }

  async findPrivateChatIdByUser(userId: string): Promise<string | undefined> {
    const receipts = await this.readJsonDirectory<InboundMessageReceipt>(join(this.baseDir, 'state/inbound-messages'));
    return receipts
      .filter((receipt) => receipt.chatType === 'private' && receipt.userId === userId)
      .sort((left, right) => right.firstReceivedAt.localeCompare(left.firstReceivedAt))[0]?.chatId;
  }

  async appendEvent(event: BotEvent): Promise<void> {
    const day = this.clock().toISOString().slice(0, 10);
    await this.enqueue('events', async () => {
      const filePath = join(this.baseDir, 'events', `${day}.jsonl`);
      await mkdir(dirname(filePath), { recursive: true });
      await appendFile(filePath, `${JSON.stringify(event)}\n`, 'utf8');
    });
  }

  async appendErrorLog(entry: BotErrorLogEntry): Promise<void> {
    const day = this.clock().toISOString().slice(0, 10);
    await this.enqueue('events', async () => {
      const filePath = join(this.baseDir, 'logs/errors', `${day}.jsonl`);
      await mkdir(dirname(filePath), { recursive: true });
      await appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    });
  }

  async appendSessionLog(sessionId: string, text: string): Promise<void> {
    await this.enqueue('sessionLogs', async () => {
      const filePath = this.sessionLogPath(sessionId);
      await mkdir(dirname(filePath), { recursive: true });
      await appendFile(filePath, text, 'utf8');
    });
  }

  async tailSessionLog(sessionId: string, lineCount: number): Promise<string[]> {
    const normalizedLineCount = Math.floor(lineCount);
    if (!Number.isFinite(lineCount) || normalizedLineCount <= 0) {
      return [];
    }

    await this.waitForPendingWrites('sessionLogs');
    const filePath = this.sessionLogPath(sessionId);
    try {
      const { size } = await stat(filePath);
      const isBoundedTail = size > MAX_TAIL_SCAN_BYTES;
      const start = isBoundedTail ? size - MAX_TAIL_SCAN_BYTES + 1 : 0;
      const readStart = isBoundedTail ? start - 1 : start;
      const bytesToRead = size - readStart;
      const buffer = await readFileWindow(filePath, readStart, bytesToRead);

      const previousByte = isBoundedTail && buffer.length > 0 ? buffer[0] : undefined;
      const contentStart = isBoundedTail ? 1 : 0;
      const content = buffer.subarray(contentStart).toString('utf8');
      const lines = content.split(/\r?\n/);
      if (isBoundedTail && previousByte !== 0x0a && lines.length > 1) {
        lines.shift();
      }
      if (lines[lines.length - 1] === '') {
        lines.pop();
      }
      return lines.slice(-normalizedLineCount).map(capLogLine);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async tailSessionLogBytes(sessionId: string, maxBytes: number): Promise<string> {
    const normalizedMaxBytes = Math.floor(maxBytes);
    if (!Number.isFinite(maxBytes) || normalizedMaxBytes <= 0) {
      return '';
    }

    await this.waitForPendingWrites('sessionLogs');
    const filePath = this.sessionLogPath(sessionId);
    try {
      const { size } = await stat(filePath);
      const bytesToRead = Math.min(size, normalizedMaxBytes);
      const start = size - bytesToRead;
      const buffer = await readFileWindow(filePath, start, bytesToRead);
      return buffer.toString('utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return '';
      }
      throw error;
    }
  }

  async sessionLogSize(sessionId: string): Promise<number> {
    await this.waitForPendingWrites('sessionLogs');
    try {
      return (await stat(this.sessionLogPath(sessionId))).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 0;
      }
      throw error;
    }
  }

  async sessionLogLinesFrom(sessionId: string, byteOffset: number): Promise<string[]> {
    await this.waitForPendingWrites('sessionLogs');
    const filePath = this.sessionLogPath(sessionId);
    try {
      const { size } = await stat(filePath);
      const isOldOffset = size - byteOffset > MAX_TAIL_SCAN_BYTES;
      const start = isOldOffset ? size - MAX_TAIL_SCAN_BYTES + 1 : byteOffset;
      const readStart = isOldOffset ? start - 1 : start;
      const bytesToRead = Math.max(0, size - readStart);
      const buffer = await readFileWindow(filePath, readStart, bytesToRead);
      const previousByte = isOldOffset && buffer.length > 0 ? buffer[0] : undefined;
      const contentStart = isOldOffset ? 1 : 0;
      const content = buffer.subarray(contentStart).toString('utf8');
      const lines = content.split(/\r?\n/);
      if (isOldOffset && previousByte !== 0x0a && lines.length > 1) {
        lines.shift();
      }
      if (lines[lines.length - 1] === '') {
        lines.pop();
      }
      return lines.map(capLogLine);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  sessionLogPath(sessionId: string): string {
    const id = this.safeFileName(sessionId);
    return join(this.baseDir, 'logs/sessions', `${id}.log`);
  }

  private safeFileName(id: string): string {
    if (!/^[A-Za-z0-9_.-]+$/.test(id) || id === '.' || id === '..') {
      throw new Error(`Invalid state id: ${id}`);
    }
    return id;
  }

  private async readJson<T>(filePath: string): Promise<T | undefined> {
    await this.waitForPendingWrites('state');
    try {
      return JSON.parse(await readFile(filePath, 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  private async readJsonDirectory<T>(directoryPath: string): Promise<T[]> {
    await this.waitForPendingWrites('state');
    let files: string[];
    try {
      files = await readdir(directoryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const records: Array<T | undefined> = await Promise.all(
      files.filter((fileName) => fileName.endsWith('.json')).map(async (fileName) => this.readJson<T>(join(directoryPath, fileName))),
    );
    return records.filter((record): record is T => Boolean(record));
  }

  private async writeJson(filePath: string, value: unknown): Promise<void> {
    await this.enqueue('state', async () => this.writeJsonFile(filePath, value));
  }

  private enqueue<T>(queue: WriteQueueName, operation: () => Promise<T>): Promise<T> {
    const run = () => this.writeContext.run(queue, operation);
    const next = this.writeChains[queue].then(run, run);
    this.writeChains[queue] = next.catch(() => undefined);
    return next;
  }

  private async waitForPendingWrites(queue: WriteQueueName): Promise<void> {
    if (this.writeContext.getStore() === queue) {
      return;
    }
    await this.writeChains[queue];
  }

  private async writeJsonFile(filePath: string, value: unknown): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(tmpPath, filePath);
  }
}
