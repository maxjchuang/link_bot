import { randomBytes } from 'node:crypto';
import type { DestructiveCommand, DestructiveCommandRequest, UpgradeConfig } from '../domain/types.js';
import type {
  DestructiveCommandDecisionCardAction,
  FeishuIncomingCardAction,
} from '../feishu/FeishuCardActions.js';
import { renderDestructiveCommandCard } from '../feishu/DestructiveCommandCard.js';
import type { FeishuReplyTarget } from '../feishu/FeishuGateway.js';
import type { RenderedFeishuMessage } from '../feishu/FeishuMessageRenderer.js';
import { FileStateStore } from '../state/FileStateStore.js';
import type { UpgradeManager, UpgradeResult } from './UpgradeManager.js';

const confirmationTtlMs = 600_000;
const maxFailureChars = 500;

type RenderedMessage = { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage };
type DecisionInput = Omit<FeishuIncomingCardAction, 'action'> & {
  action: DestructiveCommandDecisionCardAction;
};

export interface DestructiveCommandNotifier {
  sendRenderedMessageToTarget(target: FeishuReplyTarget, message: RenderedMessage): Promise<void>;
  updateMessageCard(messageId: string, message: RenderedMessage): Promise<void>;
  sendTextToTarget?(target: FeishuReplyTarget, text: string): Promise<void>;
}

export class DestructiveCommandCoordinator {
  private readonly createRequestId: () => string;

  constructor(
    private readonly deps: {
      store: FileStateStore;
      config: UpgradeConfig;
      upgradeManager: Pick<UpgradeManager, 'upgrade' | 'restart'>;
      notifier: DestructiveCommandNotifier;
      createRequestId?: () => string;
    },
  ) {
    this.createRequestId = deps.createRequestId ?? defaultRequestId;
  }

  async handleMenu(input: {
    eventId?: string;
    chatId: string;
    userId: string;
    command: DestructiveCommand;
  }): Promise<void> {
    if (!input.eventId) {
      await this.audit('missing_event_id_dropped', input, 'missing_event_id');
      return;
    }
    if (!this.deps.config.enabled || !this.deps.config.adminUsers.includes(input.userId)) {
      await this.audit('unauthorized_dropped', { ...input, sourceEventId: input.eventId }, 'unauthorized');
      return;
    }

    let result;
    try {
      result = await this.deps.store.createDestructiveCommandRequest({
        requestId: this.createRequestId(),
        sourceEventId: input.eventId,
        userId: input.userId,
        chatId: input.chatId,
        command: input.command,
        ttlMs: confirmationTtlMs,
      });
    } catch (error) {
      await this.recordError('Unable to persist destructive command request.', error, input);
      return;
    }

    if (!result.created) {
      const event = result.reason === 'event_retry' ? 'menu_retry_dropped' : 'pending_duplicate_dropped';
      await this.audit(event, result.request, result.reason);
      return;
    }

    await this.audit('request_created', result.request, 'created');
    try {
      await this.deps.notifier.sendRenderedMessageToTarget(
        { chatId: result.request.chatId },
        renderDestructiveCommandCard({ request: result.request, view: 'pending' }),
      );
    } catch (error) {
      const failure = boundedError(error);
      try {
        await this.deps.store.markDestructiveCommandFailed({
          requestId: result.request.id,
          expectedStatus: 'pending',
          failure,
        });
      } catch (stateError) {
        await this.recordError('Unable to mark undelivered destructive command request failed.', stateError, result.request);
      }
      await this.recordError('Unable to deliver destructive command confirmation card.', error, result.request);
    }
  }

  async handleDecision(input: DecisionInput): Promise<void> {
    let decision;
    try {
      decision = await this.deps.store.decideDestructiveCommand({
        requestId: input.action.requestId,
        userId: input.userId,
        chatId: input.chatId,
        decision: input.action.decision,
      });
    } catch (error) {
      await this.recordError('Unable to persist destructive command decision.', error, {
        requestId: input.action.requestId,
        userId: input.userId,
        chatId: input.chatId,
      });
      return;
    }

    if (!decision.accepted) {
      await this.audit(
        decision.reason === 'expired' ? 'expired_dropped' : 'confirm_retry_dropped',
        decision.request ?? {
          requestId: input.action.requestId,
          userId: input.userId,
          chatId: input.chatId,
        },
        decision.reason,
      );
      return;
    }

    const request = decision.request;
    if (input.action.decision === 'cancel') {
      await this.audit('cancelled', request, 'cancelled');
      await this.bestEffortCardUpdate(input.messageId, request, 'cancelled');
      return;
    }

    await this.audit('confirmed', request, 'confirmed');
    await this.bestEffortCardUpdate(input.messageId, request, 'executing');

    let result: UpgradeResult;
    try {
      const execute = request.command === 'upgrade' ? this.deps.upgradeManager.upgrade.bind(this.deps.upgradeManager) : this.deps.upgradeManager.restart.bind(this.deps.upgradeManager);
      result = await execute({
        userId: request.userId,
        beforePm2Restart: async () => {
          const committed = await this.deps.store.commitDestructiveCommandRestart(request.id);
          if (!committed) {
            throw new Error('Destructive restart commit was not persisted.');
          }
          await this.audit('restart_committed', committed, 'restart_committed');
        },
        beforeRestart: this.deps.notifier.sendTextToTarget
          ? (message) => this.deps.notifier.sendTextToTarget!({ chatId: request.chatId }, message)
          : undefined,
      });
    } catch (error) {
      await this.failExecution(request, input.messageId, boundedError(error));
      return;
    }

    if (result.status === 'failed') {
      await this.failExecution(request, input.messageId, result.error);
    }
  }

  private async failExecution(request: DestructiveCommandRequest, messageId: string | undefined, failure: string): Promise<void> {
    let failed: DestructiveCommandRequest | undefined;
    try {
      failed = await this.deps.store.markDestructiveCommandFailed({
        requestId: request.id,
        expectedStatus: 'executing',
        failure,
      });
    } catch (error) {
      await this.recordError('Unable to persist destructive command failure.', error, request);
    }

    await this.audit('execution_failed', failed ?? request, boundedError(failure));
    if (failed) {
      await this.bestEffortCardUpdate(messageId, failed, 'failed', failure);
    } else {
      await this.recordError('Destructive command failed after restart was committed.', failure, request);
    }
  }

  private async bestEffortCardUpdate(
    messageId: string | undefined,
    request: DestructiveCommandRequest,
    view: 'executing' | 'cancelled' | 'failed',
    failure?: string,
  ): Promise<void> {
    if (!messageId) return;
    try {
      await this.deps.notifier.updateMessageCard(
        messageId,
        renderDestructiveCommandCard({ request, view, failure }),
      );
    } catch (error) {
      await this.recordError('Unable to update destructive command card.', error, request);
    }
  }

  private async audit(
    suffix: string,
    value: DestructiveCommandRequest | Record<string, unknown>,
    reason: string,
  ): Promise<void> {
    await this.deps.store.appendEvent({
      type: `destructive_command.${suffix}`,
      at: new Date().toISOString(),
      data: { ...auditData(value), reason },
    });
  }

  private async recordError(message: string, error: unknown, value: object): Promise<void> {
    await this.deps.store.appendErrorLog({
      at: new Date().toISOString(),
      source: 'destructive_command',
      message,
      data: { ...auditData(value), error: boundedError(error) },
    });
  }
}

function defaultRequestId(): string {
  return `dcr_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`;
}

function auditData(value: object): Record<string, unknown> {
  const data = value as Record<string, unknown>;
  return {
    requestId: data.id ?? data.requestId,
    sourceEventId: data.sourceEventId ?? data.eventId,
    userId: data.userId,
    chatId: data.chatId,
    command: data.command,
    status: data.status,
  };
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, maxFailureChars);
}
