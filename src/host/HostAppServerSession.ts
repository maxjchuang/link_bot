import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { CodexBackend, CodexBackendEvent } from '../backends/CodexBackend.js';
import type { FeishuIncomingMessage } from '../feishu/FeishuGateway.js';
import type { FeishuOutgoingReply } from '../feishu/FeishuGateway.js';
import type { AppServerTurnExperience } from '../livecards/AppServerTurnExperience.js';
import { DEFAULT_HOST_EXECUTION_PROFILE, type ExecutionProfile } from '../tasks/ExecutionProfile.js';
import type { CodexModelCatalog } from '../models/CodexModelCatalog.js';
import { renderModelSelectorCard } from '../feishu/ModelSelectorCard.js';
import { parseHostTimeDiagnosticIntent } from './HostTimeDiagnosticIntent.js';
import type { AppServerTurnDetailSink } from '../details/AppServerTurnDetailSink.js';

interface HostAppServerSessionDeps {
  backend: CodexBackend;
  cwd: string;
  codexHome?: string;
  args: string[];
  loadThreads(): Promise<Record<string, string>>;
  saveThreads(threads: Record<string, string>): Promise<void>;
  notify(message: FeishuIncomingMessage, text: string, completed: boolean): Promise<void>;
  prepareFinalText?(message: Pick<FeishuIncomingMessage, 'chatId' | 'messageId'> & Partial<Pick<FeishuIncomingMessage, 'userId'>>, text: string): Promise<string>;
  turnExperience?: AppServerTurnExperience;
  turnDetails?: AppServerTurnDetailSink;
  projectId?: string;
  afterTurnCompleted?(): Promise<void>;
  isRestartPending?(): Promise<boolean>;
  readModelCatalog?(): Promise<CodexModelCatalog>;
  defaultExecutionProfile?: ExecutionProfile;
  clock?: () => Date;
}

export class HostAppServerSession {
  private readonly opened = new Map<string, HostSessionState>();
  private readonly diagnosticRuns = new Map<string, HostDiagnosticRun>();
  private threads?: Record<string, string>;

  constructor(private readonly deps: HostAppServerSessionDeps) {}

  async recover(): Promise<void> {
    await this.deps.turnExperience?.recoverOpenCards?.('host_manager', async (record) => {
      try {
        const current = await this.ensureOpened(record.target.chatId);
        const thread = await this.deps.backend.readThread(current.taskId);
        const turns = thread.turns ?? [];
        const turn = turns.find((candidate) => turnId(candidate) === record.codexTurnId)
          ?? [...turns].reverse().find((candidate) => turnContainsPrompt(candidate, record.prompt));
        if (!turn) return { status: 'interrupted' };
        const status = turnStatus(turn);
        if (status === 'completed') {
          const answer = lastAgentMessage(turn);
          return { status, answer: answer && this.deps.prepareFinalText
            ? await this.deps.prepareFinalText({ chatId: record.target.chatId, messageId: record.requestMessageId ?? record.target.replyToMessageId,
              userId: record.requesterUserId }, answer)
            : answer };
        }
        if (status === 'failed') return { status, answer: turnError(turn) };
        return { status: 'interrupted' };
      } catch {
        return { status: 'interrupted' };
      }
    });
  }

  async handleMessage(message: FeishuIncomingMessage): Promise<{ reply: string; renderedReply?: FeishuOutgoingReply['rendered'] }> {
    const text = message.text.trim();
    if (text === '/status') {
      const current = this.opened.get(message.chatId);
      const persisted = (await this.threadMap())[message.chatId];
      return { reply: current ? `Host App Server\nThread: ${current.threadId}\nActive: ${current.active}` : `Host App Server\nThread: ${persisted ?? 'none'}\nActive: false` };
    }
    // A new turn must not replace the source/card while the prior turn is delivering privately.
    await this.opened.get(message.chatId)?.finishing;
    const diagnostic = parseHostTimeDiagnosticIntent(text, this.deps.clock?.() ?? new Date());
    if (diagnostic.kind === 'invalid' || diagnostic.kind === 'future') return { reply: diagnostic.reply };
    if (diagnostic.kind === 'diagnose') {
      if (await this.deps.isRestartPending?.()) {
        return { reply: 'Link Bot 正在安全重启，当前不接受新任务；服务恢复后请重新发送。' };
      }
      return this.startTimeDiagnostic(message, diagnostic.prompt);
    }
    if (text === '/new') await this.reset(message.chatId);
    const current = await this.ensureOpened(message.chatId);
    if (/^\/model(?:\s|$)/i.test(text)) return this.handleModel(message, current, text);
    if (await this.deps.isRestartPending?.()) {
      return { reply: 'Link Bot 正在安全重启，当前不接受新任务；服务恢复后请重新发送。' };
    }
    current.message = message;
    if (text === '/new') return { reply: `已创建新的宿主机 App Server Session：${current.threadId}` };
    if (current.active) await this.deps.backend.steerTurn({
      taskId: current.taskId, prompt: text, ...(message.images?.length ? { images: message.images } : {}),
    });
    else {
      current.active = true;
      const localTurnId = `host_turn_${randomUUID()}`;
      current.activeTurnId = localTurnId;
      try {
        this.deps.turnDetails?.accepted({ ownerKind: 'host_manager', taskId: current.taskId, localTurnId,
          userId: message.userId, target: { chatId: message.chatId } });
        await this.deps.turnExperience?.accepted({
          taskId: current.taskId, turnId: localTurnId, projectId: this.deps.projectId ?? 'link-bot',
          messageId: message.messageId,
          requesterUserId: message.userId,
          target: { chatId: message.chatId, ...(message.messageId ? { replyToMessageId: message.messageId } : {}) },
          ownerKind: 'host_manager', prompt: text,
          model: current.executionProfile.model,
          reasoningEffort: current.executionProfile.reasoningEffort,
          serviceTier: current.executionProfile.serviceTier,
        });
        const executionProfile = current.pendingExecutionProfile ?? current.executionProfile;
        current.executionProfile = executionProfile;
        current.pendingExecutionProfile = undefined;
        const started = await this.deps.backend.startTurn({
          taskId: current.taskId, prompt: text, executionProfile,
          ...(message.images?.length ? { images: message.images } : {}),
        });
        this.deps.turnDetails?.bind(current.taskId, current.threadId, started?.turnId);
      }
      catch (error) {
        this.deps.turnDetails?.finish(current.taskId, localTurnId, 'failed');
        current.active = false;
        current.activeTurnId = undefined;
        await this.deps.turnExperience?.interruptTurn?.(
          'host_manager', localTurnId, `任务启动失败：${error instanceof Error ? error.message : String(error)}`,
        ).catch(() => false);
        throw error;
      }
    }
    return { reply: '' };
  }

  private async handleModel(
    message: FeishuIncomingMessage,
    current: HostSessionState,
    text: string,
  ): Promise<{ reply: string; renderedReply?: FeishuOutgoingReply['rendered'] }> {
    const args = text.split(/\s+/).slice(1);
    if (args.length === 0) {
      const fallback = profileText(current.executionProfile, current.pendingExecutionProfile);
      const catalog = await this.deps.readModelCatalog?.();
      if (!catalog) return { reply: fallback };
      if (catalog.kind === 'unavailable') return { reply: catalog.message };
      return {
        reply: fallback,
        renderedReply: renderModelSelectorCard({
          chatId: message.chatId,
          chatType: message.chatType,
          current: current.pendingExecutionProfile ?? current.executionProfile,
          clientVersion: catalog.clientVersion,
          fetchedAt: catalog.fetchedAt,
          models: catalog.models,
          fallbackText: fallback,
        }),
      };
    }
    if (args.length > 3 || !args[0] || (args[2] && !['default', 'standard', 'fast'].includes(args[2].toLowerCase()))) {
      return { reply: 'Usage: /model [model] [reasoning-effort] [default|fast]' };
    }
    const profile: ExecutionProfile = {
      model: args[0],
      reasoningEffort: args[1] ?? current.executionProfile.reasoningEffort,
      serviceTier: args[2]?.toLowerCase() === 'fast' ? 'fast' : args[2] ? 'default' : current.executionProfile.serviceTier,
    };
    if (current.active) {
      current.pendingExecutionProfile = profile;
      return { reply: `执行配置将在下一轮生效：${profileLine(profile)}` };
    }
    current.executionProfile = profile;
    current.pendingExecutionProfile = undefined;
    await this.deps.turnExperience?.profileChanged?.(current.taskId, profile);
    return { reply: `执行配置已更新：${profileLine(profile)}` };
  }

  async shutdown(reason = 'Link Bot 正在重启，当前任务已中断。'): Promise<void> {
    for (const current of this.opened.values()) {
      if (current.activeTurnId) {
        this.deps.turnDetails?.interrupt(current.taskId, current.activeTurnId);
        await this.deps.turnExperience?.interruptTurn?.('host_manager', current.activeTurnId, reason).catch(() => false);
      }
      await this.deps.backend.stopTask(current.taskId).catch(() => undefined);
      current.active = false;
      current.activeTurnId = undefined;
    }
    for (const run of this.diagnosticRuns.values()) {
      this.deps.turnDetails?.interrupt(run.taskId, run.localTurnId);
      await this.deps.turnExperience?.interruptTurn?.('host_manager', run.localTurnId, reason).catch(() => false);
      await this.deps.backend.stopTask(run.taskId).catch(() => undefined);
    }
    this.diagnosticRuns.clear();
    this.opened.clear();
  }

  private async startTimeDiagnostic(
    message: FeishuIncomingMessage,
    prompt: string,
  ): Promise<{ reply: string; renderedReply?: FeishuOutgoingReply['rendered'] }> {
    const taskId = `host_diag_${randomUUID()}`;
    const localTurnId = `host_turn_${randomUUID()}`;
    const current = this.opened.get(message.chatId);
    const requestedProfile = current?.pendingExecutionProfile ?? current?.executionProfile
      ?? this.deps.defaultExecutionProfile ?? DEFAULT_HOST_EXECUTION_PROFILE;
    const opened = await this.deps.backend.startTask({
      taskId, cwd: this.deps.cwd, codexHome: this.deps.codexHome, args: this.deps.args,
      executionProfile: requestedProfile,
    });
    const executionProfile: ExecutionProfile = {
      model: opened.model ?? requestedProfile.model,
      reasoningEffort: opened.reasoningEffort ?? requestedProfile.reasoningEffort,
      serviceTier: opened.serviceTier ?? requestedProfile.serviceTier,
    };
    const run: HostDiagnosticRun = { taskId, localTurnId, message };
    this.diagnosticRuns.set(taskId, run);
    void this.pumpDiagnostic(run);
    try {
      this.deps.turnDetails?.accepted({ ownerKind: 'host_manager', taskId, localTurnId,
        userId: message.userId, target: { chatId: message.chatId } });
      await this.deps.turnExperience?.accepted({
        taskId, turnId: localTurnId, projectId: this.deps.projectId ?? 'link-bot',
        messageId: message.messageId,
        requesterUserId: message.userId,
        target: { chatId: message.chatId, ...(message.messageId ? { replyToMessageId: message.messageId } : {}) },
        ownerKind: 'host_manager', prompt,
        model: executionProfile.model, reasoningEffort: executionProfile.reasoningEffort,
        serviceTier: executionProfile.serviceTier,
      });
      const started = await this.deps.backend.startTurn({ taskId, prompt, executionProfile });
      this.deps.turnDetails?.bind(taskId, opened.threadId, started?.turnId);
      return { reply: '' };
    } catch (error) {
      this.diagnosticRuns.delete(taskId);
      this.deps.turnDetails?.finish(taskId, localTurnId, 'failed');
      await this.deps.backend.stopTask(taskId).catch(() => undefined);
      await this.deps.turnExperience?.interruptTurn?.(
        'host_manager', localTurnId, `诊断任务启动失败：${error instanceof Error ? error.message : String(error)}`,
      ).catch(() => false);
      throw error;
    }
  }

  private async pumpDiagnostic(run: HostDiagnosticRun): Promise<void> {
    try {
      for await (let event of this.deps.backend.events(run.taskId)) {
        if (!this.diagnosticRuns.has(run.taskId)) return;
        if (event.type === 'turn.completed') event = await this.prepareCompletion(run.message, event);
        this.deps.turnDetails?.event(event, `host:${randomUUID()}`);
        if (event.type === 'turn.completed') {
          let deliveredByCard = false;
          try {
            deliveredByCard = await this.deps.turnExperience?.event(event) ?? false;
          } catch (error) {
            console.error('Host diagnostic card completion failed; using message fallback.', error);
          }
          if (!deliveredByCard) await this.deps.notify(run.message, finalText(event), event.status === 'completed');
          return;
        }
        if (event.type === 'backend.disconnected' || event.type === 'task.exited') {
          const reason = event.type === 'backend.disconnected'
            ? `诊断任务执行中断：${event.reason}`
            : `诊断任务执行中断：Codex App Server 已退出${event.exitCode === undefined ? '' : `（退出码 ${event.exitCode}）`}。`;
          let deliveredByCard = false;
          try {
            deliveredByCard = await this.deps.turnExperience?.interruptTurn?.('host_manager', run.localTurnId, reason) ?? false;
          } catch (error) {
            console.error('Host diagnostic card interruption failed; using message fallback.', error);
          }
          if (!deliveredByCard) await this.deps.notify(run.message, reason, false);
          return;
        }
        try {
          await this.deps.turnExperience?.event(event);
        } catch (error) {
          console.error('Host diagnostic card progress failed; continuing event pump.', error);
        }
      }
    } finally {
      this.diagnosticRuns.delete(run.taskId);
      await this.deps.backend.stopTask(run.taskId).catch(() => undefined);
    }
  }

  private async ensureOpened(chatId: string) {
    const existing = this.opened.get(chatId);
    if (existing) return existing;
    const taskId = `host_${createHash('sha256').update(chatId).digest('hex').slice(0, 20)}`;
    const threads = await this.threadMap();
    const requestedProfile = this.deps.defaultExecutionProfile ?? DEFAULT_HOST_EXECUTION_PROFILE;
    const opened = threads[chatId]
      ? await this.deps.backend.resumeTask({ taskId, threadId: threads[chatId]!, cwd: this.deps.cwd, codexHome: this.deps.codexHome, args: this.deps.args, executionProfile: requestedProfile })
      : await this.deps.backend.startTask({ taskId, cwd: this.deps.cwd, codexHome: this.deps.codexHome, args: this.deps.args, executionProfile: requestedProfile });
    if (!opened.threadId) throw new Error('Host App Server did not return a thread id.');
    threads[chatId] = opened.threadId;
    await this.deps.saveThreads(threads);
    const state: HostSessionState = {
      taskId, threadId: opened.threadId, active: false,
      executionProfile: {
        model: opened.model ?? requestedProfile.model,
        reasoningEffort: opened.reasoningEffort ?? requestedProfile.reasoningEffort,
        serviceTier: opened.serviceTier ?? requestedProfile.serviceTier,
      },
    };
    this.opened.set(chatId, state);
    void this.pump(chatId, taskId);
    return state;
  }

  private async reset(chatId: string): Promise<void> {
    const current = this.opened.get(chatId);
    if (current?.activeTurnId) this.deps.turnDetails?.interrupt(current.taskId, current.activeTurnId);
    if (current) await this.deps.backend.stopTask(current.taskId).catch(() => undefined);
    this.opened.delete(chatId);
    const threads = await this.threadMap();
    delete threads[chatId];
    await this.deps.saveThreads(threads);
  }

  private async pump(chatId: string, taskId: string): Promise<void> {
    for await (let event of this.deps.backend.events(taskId)) {
      const current = this.opened.get(chatId);
      if (!current) return;
      if (event.type === 'turn.completed') {
        await this.publishCompletion(current, event);
        continue;
      }
      this.deps.turnDetails?.event(event, `host:${randomUUID()}`);
      if (event.type === 'backend.disconnected' || event.type === 'task.exited') {
        const activeTurnId = current.activeTurnId;
        const message = current.message;
        const reason = event.type === 'backend.disconnected'
          ? `任务执行中断：${event.reason}`
          : `任务执行中断：Codex App Server 已退出${event.exitCode === undefined ? '' : `（退出码 ${event.exitCode}）`}。`;
        current.active = false;
        current.activeTurnId = undefined;
        this.opened.delete(chatId);
        if (activeTurnId) {
          let deliveredByCard = false;
          try {
            deliveredByCard = await this.deps.turnExperience?.interruptTurn?.(
              'host_manager', activeTurnId, reason,
            ) ?? false;
          } catch (error) {
            console.error('Host App Server card interruption failed; using message fallback.', error);
          }
          try {
            if (message && !deliveredByCard) await this.deps.notify(message, reason, false);
          } finally {
            await this.deps.afterTurnCompleted?.();
          }
        }
      } else {
        try {
          await this.deps.turnExperience?.event(event);
        } catch (error) {
          // Card progress is best-effort; never terminate the authoritative
          // App Server event stream because SQLite or Feishu is temporarily busy.
          console.error('Host App Server card progress failed; continuing event pump.', error);
        }
      }
    }
  }

  private async publishCompletion(current: HostSessionState, event: Extract<CodexBackendEvent, { type: 'turn.completed' }>): Promise<void> {
    const message = current.message;
    let release!: () => void;
    const finishing = new Promise<void>((resolve) => { release = resolve; });
    current.finishing = finishing;
    current.active = false;
    current.activeTurnId = undefined;
    try {
      if (message) event = await this.prepareCompletion(message, event);
      this.deps.turnDetails?.event(event, `host:${randomUUID()}`);
      let deliveredByCard = false;
      try { deliveredByCard = await this.deps.turnExperience?.event(event) ?? false; }
      catch (error) { console.error('Host App Server card completion failed; using message fallback.', error); }
      if (message && !deliveredByCard) await this.deps.notify(message, finalText(event), event.status === 'completed');
    } finally {
      if (current.finishing === finishing) current.finishing = undefined;
      release();
      await this.deps.afterTurnCompleted?.();
    }
  }

  private async prepareCompletion(
    message: FeishuIncomingMessage, event: Extract<CodexBackendEvent, { type: 'turn.completed' }>,
  ): Promise<Extract<CodexBackendEvent, { type: 'turn.completed' }>> {
    if (event.status !== 'completed' || !this.deps.prepareFinalText || !isRecord(event.turn)
      || !Array.isArray(event.turn.items)) return event;
    const items = [...event.turn.items];
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (isRecord(item) && item.type === 'agentMessage' && typeof item.text === 'string') {
        items[index] = { ...item, text: await this.deps.prepareFinalText(message, item.text) };
        break;
      }
    }
    return { ...event, turn: { ...event.turn, items } };
  }

  private async threadMap(): Promise<Record<string, string>> {
    return this.threads ??= await this.deps.loadThreads();
  }
}

interface HostSessionState {
  taskId: string;
  threadId: string;
  active: boolean;
  executionProfile: ExecutionProfile;
  pendingExecutionProfile?: ExecutionProfile;
  activeTurnId?: string;
  message?: FeishuIncomingMessage;
  finishing?: Promise<void>;
}

interface HostDiagnosticRun {
  taskId: string;
  localTurnId: string;
  message: FeishuIncomingMessage;
}

function profileText(effective: ExecutionProfile, pending?: ExecutionProfile): string {
  return `当前配置：${profileLine(effective)}${pending ? `\n下一轮：${profileLine(pending)}` : ''}`;
}

function profileLine(profile: ExecutionProfile): string {
  return `${profile.model} / ${profile.reasoningEffort} / ${profile.serviceTier === 'fast' ? 'fast' : 'default'}`;
}

function finalText(event: Extract<CodexBackendEvent, { type: 'turn.completed' }>): string {
  if (event.status !== 'completed') return `任务处理失败：${event.status}`;
  const turn = typeof event.turn === 'object' && event.turn !== null ? event.turn as { items?: unknown[] } : {};
  const messages = (turn.items ?? []).flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const value = item as { type?: string; text?: string };
    return value.type === 'agentMessage' && value.text ? [value.text] : [];
  });
  return messages.at(-1) ?? '任务已完成。';
}

function turnId(value: unknown): string | undefined {
  return field(value, 'id');
}

function turnContainsPrompt(value: unknown, prompt?: string): boolean {
  if (!prompt?.trim() || !isRecord(value) || !Array.isArray(value.items)) return false;
  return value.items.some((item) => {
    if (!isRecord(item) || item.type !== 'userMessage' || !Array.isArray(item.content)) return false;
    const text = item.content.flatMap((part) => isRecord(part) && typeof part.text === 'string' ? [part.text] : []).join('\n');
    return text.trim() === prompt.trim();
  });
}

function turnStatus(value: unknown): 'completed' | 'failed' | 'interrupted' {
  const status = field(value, 'status');
  return status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'interrupted';
}

function lastAgentMessage(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.items)) return undefined;
  return value.items.flatMap((item) => isRecord(item) && item.type === 'agentMessage' && typeof item.text === 'string'
    ? [item.text] : []).at(-1);
}

function turnError(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.error)) return undefined;
  return typeof value.error.message === 'string' ? value.error.message : undefined;
}

function field(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === 'string' ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
