import type { DetailCategory } from '../details/TurnDetailTypes.js';
import type { ChatType } from '../domain/types.js';

export interface TurnDetailCardAction { kind: 'turn_detail'; cardRef: string; category: DetailCategory | 'result'; itemRef?: string; cursorRef?: string; download?: true }

export interface ModelSelectCardAction {
  kind: 'model_select';
  model: string;
  reasoning?: string;
  serviceTier?: 'default' | 'fast';
}

export interface ProjectSelectCardAction {
  kind: 'project_select';
  projectId: string;
}

export interface ResumeSelectCardAction {
  kind: 'resume_select';
  codexSessionId: string;
  projectId: string;
}

export interface ResumePageCardAction {
  kind: 'resume_page';
  page: number;
  projectId: string;
}

export interface ApprovalDecisionCardAction {
  kind: 'approval_decision';
  approvalId: string;
  decision: 'approve' | 'reject';
}

export interface DestructiveCommandDecisionCardAction {
  kind: 'destructive_command_decision';
  requestId: string;
  decision: 'confirm' | 'cancel';
}

export interface TaskPublishDecisionCardAction {
  kind: 'task_publish_decision';
  requestId: string;
  decision: 'confirm' | 'reject';
}

export interface TaskDeleteDecisionCardAction {
  kind: 'task_delete_decision';
  requestId: string;
  decision: 'confirm' | 'reject';
}

export interface DiskCleanupDecisionCardAction {
  kind: 'disk_cleanup_decision';
  requestId: string;
  decision: 'confirm' | 'reject';
}

export interface AppServerRequestDecisionCardAction {
  kind: 'app_server_request_decision';
  requestId: string;
  generation: number;
  decision: 'allow' | 'deny' | 'answer';
  answers?: Record<string, string[]>;
}

export interface ProjectKnowledgeDecisionCardAction {
  kind: 'project_knowledge_decision';
  knowledgeId: string;
  decision: 'approve' | 'reject';
}

export interface ToolAuthCheckCardAction {
  kind: 'tool_auth_check';
  pendingId: string;
}
export interface ProjectRoutingSelectCardAction { kind: 'project_routing_select'; routingId: string; projectId?: string; cancel?: boolean }
export interface RepositoryRefDecisionCardAction { kind: 'repository_ref_decision'; projectId: string; targetRef: string; originalText: string; decision: 'inspect'|'migrate'|'cancel' }
export interface RepositoryMigrationDecisionCardAction { kind: 'repository_migration_decision'; migrationId: string; decision: 'confirm'|'reject' }

export type FeishuCardActionPayload =
  | TurnDetailCardAction
  | ModelSelectCardAction
  | ProjectSelectCardAction
  | ResumeSelectCardAction
  | ResumePageCardAction
  | ApprovalDecisionCardAction
  | DestructiveCommandDecisionCardAction
  | TaskPublishDecisionCardAction
  | TaskDeleteDecisionCardAction
  | DiskCleanupDecisionCardAction
  | ProjectKnowledgeDecisionCardAction
  | ToolAuthCheckCardAction
  | ProjectRoutingSelectCardAction
  | RepositoryRefDecisionCardAction
  | RepositoryMigrationDecisionCardAction
  | AppServerRequestDecisionCardAction;

export interface FeishuIncomingCardAction {
  chatId: string;
  chatType: ChatType;
  userId: string;
  messageId?: string;
  threadId?: string;
  action: FeishuCardActionPayload;
}

export function parseCardActionValue(
  value: unknown,
  formValue?: unknown,
): { chatId: string; chatType: ChatType; action: FeishuCardActionPayload } | undefined {
  if (isObjectRecord(value) && value.kind === 'turn_detail') {
    if (Object.keys(value).some((key) => !['kind', 'cardRef', 'category', 'itemRef', 'cursorRef', 'download'].includes(key))) return undefined;
    const opaque = (ref: unknown): ref is string => typeof ref === 'string' && /^[a-f0-9]{32}$/.test(ref);
    if (!opaque(value.cardRef) || !['process', 'commands', 'files', 'result'].includes(String(value.category))
      || (value.itemRef !== undefined && !opaque(value.itemRef)) || (value.cursorRef !== undefined && !opaque(value.cursorRef))) return undefined;
    if (value.category === 'result' && value.itemRef !== undefined) return undefined;
    if (value.download !== undefined && (value.download !== true || value.itemRef !== undefined || value.cursorRef !== undefined)) return undefined;
    return { chatId: '', chatType: 'private', action: { kind: 'turn_detail', cardRef: value.cardRef, category: value.category as TurnDetailCardAction['category'],
      ...(value.itemRef ? { itemRef: value.itemRef as string } : {}), ...(value.cursorRef ? { cursorRef: value.cursorRef as string } : {}),
      ...(value.download === true ? { download: true } : {}) } };
  }
  if (!isObjectRecord(value) || typeof value.chatId !== 'string' || value.chatId.length === 0) {
    return undefined;
  }

  const chatType: ChatType = value.chatType === 'group' ? 'group' : 'private';
  const form = isObjectRecord(formValue) ? formValue : undefined;

  if (value.kind === 'model_select') {
    const model = readString(form?.model) ?? readString(value.model);
    if (!model) {
      return undefined;
    }
    const reasoning = readString(form?.reasoning) ?? readString(value.reasoning);
    const rawTier = readString(form?.serviceTier) ?? readString(value.serviceTier);
    const serviceTier = rawTier === 'fast' ? 'fast' : rawTier === 'default' ? 'default' : undefined;
    return {
      chatId: value.chatId,
      chatType,
      action: {
        kind: 'model_select', model,
        ...(reasoning ? { reasoning } : {}),
        ...(serviceTier ? { serviceTier } : {}),
      },
    };
  }

  if (value.kind === 'project_select') {
    const projectId = readString(form?.projectId) ?? readString(value.projectId);
    if (!projectId) {
      return undefined;
    }
    return {
      chatId: value.chatId,
      chatType,
      action: { kind: 'project_select', projectId },
    };
  }

  if (value.kind === 'resume_select') {
    const codexSessionId = readString(value.codexSessionId);
    const projectId = readString(value.projectId);
    if (!codexSessionId || !projectId) {
      return undefined;
    }
    return {
      chatId: value.chatId,
      chatType,
      action: { kind: 'resume_select', codexSessionId, projectId },
    };
  }

  if (value.kind === 'resume_page') {
    const page = value.page;
    const projectId = readString(value.projectId);
    if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 || page > 10_000 || !projectId) {
      return undefined;
    }
    return {
      chatId: value.chatId,
      chatType,
      action: { kind: 'resume_page', page, projectId },
    };
  }

  if (value.kind === 'approval_decision') {
    const approvalId = readString(form?.approvalId) ?? readString(value.approvalId);
    const decision = readApprovalDecision(form?.decision) ?? readApprovalDecision(value.decision);
    if (!approvalId || !decision) {
      return undefined;
    }
    return {
      chatId: value.chatId,
      chatType,
      action: { kind: 'approval_decision', approvalId, decision },
    };
  }

  if (value.kind === 'destructive_command_decision') {
    const requestId = readString(value.requestId);
    const decision = readDestructiveCommandDecision(value.decision);
    if (!requestId || !decision) {
      return undefined;
    }
    return {
      chatId: value.chatId,
      chatType,
      action: { kind: 'destructive_command_decision', requestId, decision },
    };
  }


  if (value.kind === 'task_publish_decision' || value.kind === 'task_delete_decision'
    || value.kind === 'disk_cleanup_decision') {
    const requestId = readString(value.requestId);
    const decision = value.decision === 'confirm' || value.decision === 'reject' ? value.decision : undefined;
    if (!requestId || !decision) return undefined;
    return {
      chatId: value.chatId,
      chatType,
      action: { kind: value.kind, requestId, decision },
    };
  }

  if (value.kind === 'app_server_request_decision') {
    const requestId = readString(value.requestId);
    const generation = value.generation;
    const decision = value.decision;
    if (!requestId || typeof generation !== 'number' || !Number.isSafeInteger(generation)
      || (decision !== 'allow' && decision !== 'deny' && decision !== 'answer')) return undefined;
    const answers = readAnswers(form, value);
    if (decision === 'answer' && !answers) return undefined;
    return {
      chatId: value.chatId,
      chatType,
      action: { kind: 'app_server_request_decision', requestId, generation, decision, ...(answers ? { answers } : {}) },
    };
  }

  if (value.kind === 'project_knowledge_decision') {
    const knowledgeId = readString(value.knowledgeId);
    const decision = value.decision === 'approve' || value.decision === 'reject' ? value.decision : undefined;
    if (!knowledgeId || !decision) return undefined;
    return { chatId: value.chatId, chatType, action: { kind: 'project_knowledge_decision', knowledgeId, decision } };
  }

  if (value.kind === 'tool_auth_check') {
    const pendingId = readString(value.pendingId);
    if (!pendingId) return undefined;
    return { chatId: value.chatId, chatType, action: { kind: 'tool_auth_check', pendingId } };
  }

  if (value.kind === 'project_routing_select') {
    const routingId = readString(value.routingId);
    const projectId = readString(form?.projectId) ?? readString(value.projectId);
    const cancel = value.cancel === true;
    if (!routingId || (!cancel && !projectId)) return undefined;
    return { chatId: value.chatId, chatType, action: cancel
      ? { kind: 'project_routing_select', routingId, cancel: true }
      : { kind: 'project_routing_select', routingId, projectId } };
  }

  if (value.kind === 'repository_ref_decision') {
    const projectId = readString(value.projectId); const targetRef = readString(value.targetRef);
    const originalText = readString(value.originalText); const decision = value.decision;
    if (!projectId || !targetRef || !originalText || originalText.length > 2000
      || !['inspect', 'migrate', 'cancel'].includes(String(decision))) return undefined;
    return { chatId: value.chatId, chatType, action: { kind: 'repository_ref_decision', projectId, targetRef,
      originalText, decision: decision as RepositoryRefDecisionCardAction['decision'] } };
  }

  if (value.kind === 'repository_migration_decision') {
    const migrationId = readString(value.migrationId); const decision = value.decision;
    if (!migrationId || !/^repository_migration_[A-Za-z0-9-]+$/.test(migrationId)
      || (decision !== 'confirm' && decision !== 'reject')) return undefined;
    return { chatId: value.chatId, chatType, action: { kind: 'repository_migration_decision', migrationId, decision } };
  }

  return undefined;
}

function readAnswers(form: Record<string, unknown> | undefined, value: Record<string, unknown>): Record<string, string[]> | undefined {
  const nested = form?.answers ?? value.answers;
  if (isStringArrayRecord(nested)) return nested;
  if (!Array.isArray(value.questionIds) || !value.questionIds.every((id) => typeof id === 'string')) return undefined;
  const answers = Object.fromEntries(value.questionIds.flatMap((id) => {
    const answer = form?.[id];
    if (typeof answer === 'string' && answer.length > 0) return [[id, [answer]]];
    if (Array.isArray(answer) && answer.every((item) => typeof item === 'string')) return [[id, answer]];
    return [];
  }));
  return Object.keys(answers).length === value.questionIds.length ? answers : undefined;
}

function isStringArrayRecord(value: unknown): value is Record<string, string[]> {
  return isObjectRecord(value) && Object.values(value).every(
    (answers) => Array.isArray(answers) && answers.every((answer) => typeof answer === 'string'),
  );
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readApprovalDecision(value: unknown): 'approve' | 'reject' | undefined {
  return value === 'approve' || value === 'reject' ? value : undefined;
}

function readDestructiveCommandDecision(value: unknown): 'confirm' | 'cancel' | undefined {
  return value === 'confirm' || value === 'cancel' ? value : undefined;
}
