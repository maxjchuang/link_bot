import type { LogLevel } from '../logging/AppLogger.js';

export type ChatType = 'private' | 'group';
export type CodexHomeSource = 'project' | 'global';
export type SessionStatus = 'starting' | 'running' | 'exited' | 'interrupted' | 'unknown';
export type CodexSessionPhase =
  | 'idle'
  | 'starting'
  | 'processing'
  | 'waiting_for_input'
  | 'waiting_for_approval'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'exited';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
  /** Canonical GitHub owner/repository path, for example `owner/project`. */
  repositoryPath?: string;
  /** Explicit clone URL for a user sandbox when repositoryPath is unavailable. */
  sandboxCloneUrl?: string;
  /** Reuse an existing container clone without creating or checking out files. */
  sandboxLocalPath?: string;
  codexArgs: string[];
  runtimeBackend?: RuntimeConfig['backend'];
  baseRef?: string;
  description?: string;
  instructions?: string[];
  access?: {
    allowedUsers: string[];
    allowedChats: string[];
    knowledgeApprovers: string[];
  };
}

export interface CodexHomePaths {
  project: string;
  global: string;
}

export interface SavedModelSelection {
  model: string;
  reasoningEffort?: string;
  updatedAt: string;
}

export interface NotificationConfig {
  enabled: boolean;
  idleMs: number;
  maxFinalChars: number;
  failureTailChars: number;
}

export interface LiveCardsConfig {
  enabled: boolean;
  refreshIntervalMs: number;
  /** New UI only: rollback never disables safe recording, authorization or retention. */
  detailsEnabled?: boolean;
  /** Experimental until native desktop/mobile expansion-state acceptance. Defaults off. */
  inlineDetailsEnabled?: boolean;
  /** Maximum timeline candidates, default 50; subject to card capacity. */
  inlineTimelineMaxItems?: number;
}

export interface RuntimeConfig {
  backend: 'app-server';
  image?: string;
  codexCliVersion?: string;
  socketRoot?: string;
  statePath?: string;
  stagingRoot?: string;
  taskCpuLimit?: number;
  taskMemoryLimitBytes?: number;
  taskPidLimit?: number;
  taskTmpfsLimitBytes?: number;
  appServerMaxFrameBytes?: number;
  taskNetwork?: string;
  isolationVerified?: boolean;
  sharedAuthRiskAccepted?: boolean;
  /** Give task containers a real credentialed origin and standard Git network operations. */
  nativeGitExecution?: boolean;
  /** Keep Manager-side publishing available while native Git is rolled out. */
  managerGitToolFallback?: boolean;
}

export interface UserSandboxesConfig {
  transport?: 'auto' | 'unix-socket' | 'docker-exec';
  enabled: boolean;
  enabledOwners: string[];
  legacyFallbackEnabled: boolean;
  maxAppServersPerUser: number;
  maxActiveTurnsPerUser: number;
  processIdleTimeoutMinutes: number;
  containerIdleTimeoutMinutes: number;
  containerWrapperRetentionHours: number;
  resourceOverrides?: Record<string, { cpuLimit?: number; memoryLimitBytes?: number }>;
}

export interface TaskPoolConfig {
  maxHotTasks: number;
  maxActiveTurns: number;
  memoryHighWatermark: number;
  memoryLowWatermark: number;
  safetyReserveBytes: number;
  idleMemorySampleWindowDays: number;
}

export interface ReadyPoolConfig {
  enabled: boolean;
  defaultMinReady: number;
  defaultMaxReady: number;
}

export interface DiskPolicyConfig {
  enabled: boolean;
  filesystemPath: string;
  scanIntervalMs: number;
  inventoryIntervalMs: number;
  inventoryTimeoutMs: number;
  warningWatermark: number;
  highWatermark: number;
  lowWatermark: number;
  minimumFreeBytes: number;
  attributionEnabled: boolean;
  cleanupEnabled: boolean;
  taskSoftLimitBytes: number;
  userSoftLimitBytes: number;
  warmRetentionDays: number;
  warmRetentionWarningDays: number;
  autoDeleteWarmTasks: boolean;
  maxCleanupTasksPerPass: number;
  /** Bounds candidate inspection without letting blocked candidates consume the deletion budget. */
  maxCleanupCandidatesScannedPerPass?: number;
  orphanGraceHours: number;
}

export interface ManagedMemoryConfig {
  catalogMaxTokens: number;
  automaticRecallMaxTokens: number;
  singleReadMaxTokens: number;
  totalContextRatio: number;
}

export interface ConversationContextConfig {
  enabled: boolean;
  group: { maxMessages: number; lookbackHours: number; maxChars: number };
  topic: { maxMessages: number; maxChars: number };
  requestTimeoutMs: number;
  incremental: boolean;
  includeMediaPlaceholders: boolean;
}

export interface ConversationRoutingConfig {
  /** Optional extra restriction for dynamically activated mention-free topics. Empty means all authorized group chats. */
  ambientChats: Array<{
    chatId: string;
    name?: string;
  }>;
}


export interface DreamConfig {
  enabled: boolean;
  timezone: string;
  startAfter: string;
  maxConcurrency: number;
  maxInteractiveActiveTurns: number;
  batchMaxEvents: number;
  batchMaxChars: number;
  administratorIds: string[];
}

export interface TaskPlatformRolloutConfig {
  enabled: boolean;
  enabledOwners: string[];
  enabledProjects: string[];
  appServerDefault: boolean;
  multiUserEnabled: boolean;
  conversationScopedTasks?: boolean;
  multiRepositoryTasks?: boolean;
  managedMemory?: boolean;
  automaticContextRotation?: boolean;
  nightlyDream?: boolean;
  botGlobalMemory?: boolean;
  projectlessWorkspaces?: boolean;
  projectFreeChat?: boolean;
  projectSwitchingEnabled?: boolean;
  projectContinuationInputHandoffEnabled?: boolean;
}

export interface UpgradeConfig {
  enabled: boolean;
  adminUsers: string[];
  pm2ProcessName: string;
  remote: string;
  branch: string;
}

export interface CodexHooksConfig {
  enabled: boolean;
  autoRepair: boolean;
  socketPath: string;
  permissionTimeoutMs: number;
  adminUsers: string[];
}

export interface MediaConfig {
  enabled: boolean;
  storageRoot: string;
  maxImagesPerTurn: number;
  maxFilesPerTurn: number;
  maxImageBytes: number;
  maxFileBytes: number;
  maxTotalBytesPerTurn: number;
  pendingGroupAttachmentTtlMs: number;
  retentionHours: number;
}


export interface BotConfig {
  feishu: {
    appId: string;
    appSecret: string;
  };
  restrictUsers: boolean;
  allowUnlistedGroupUsers: boolean;
  restrictChatIds: boolean;
  allowedUsers: string[];
  allowedChatIds: string[];
  gitIdentities?: Record<string, { name: string; email: string }>;
  hostControl?: {
    enabled: boolean;
    adminUsers: string[];
    projectId: string;
    socketPath: string;
    managerProcessName: string;
  };
  projects: ProjectConfig[];
  output: {
    directMaxChars: number;
    chunkSize: number;
  };
  codex: {
    command: string;
    defaultArgs: string[];
    isolateSessions: boolean;
    executionProfiles: {
      host: { model: string; reasoningEffort: string; serviceTier: 'default' | 'fast' };
      worker: { model: string; reasoningEffort: string; serviceTier: 'default' | 'fast' };
    };
  };
  logLevel: LogLevel;
  ui: {
    verbosity: 'normal' | 'debug';
    currentRenderMode: 'markdown' | 'code';
    timeZone: string;
  };
  notifications: NotificationConfig;
  liveCards: LiveCardsConfig;
  /** Independent kill switch; never turns off public/log redaction. */
  sensitiveReplyDeliveryEnabled?: boolean;
  runtime?: RuntimeConfig;
  userSandboxes?: UserSandboxesConfig;
  taskPool: TaskPoolConfig;
  readyPool: ReadyPoolConfig;
  diskPolicy: DiskPolicyConfig;
  memory?: ManagedMemoryConfig;
  conversationContext: ConversationContextConfig;
  conversationRouting: ConversationRoutingConfig;
  dream?: DreamConfig;
  taskPlatformRollout: TaskPlatformRolloutConfig;
  upgrade: UpgradeConfig;
  codexHooks: CodexHooksConfig;
  media?: MediaConfig;
}

export interface ChatContext {
  chatId: string;
  chatType: ChatType;
  currentProjectId?: string;
  currentSessionId?: string;
  modelSelectionsByProject?: Record<string, SavedModelSelection>;
}

export interface CachedCodexStatusSummary {
  statusLine?: string;
  currentTask?: string;
  progressHint?: string;
  cliVersion?: string;
  reasoningEffort?: string;
  summaryMode?: string;
  permissions?: string;
  collaborationMode?: string;
  contextWindow?: string;
  tokenUsage?: string;
  lastTokenUsage?: string;
  primaryLimit?: string;
  weeklyLimit?: string;
  planType?: string;
  model?: string;
  cwd?: string;
}

export interface CachedCodexStatus {
  source: 'live' | 'cached' | 'observation_fallback';
  fetchedAt: string;
  rawText: string;
  summary: CachedCodexStatusSummary;
}

export interface SessionRecord {
  id: string;
  chatId: string;
  projectId: string;
  status: SessionStatus;
  phase?: CodexSessionPhase;
  createdBy: string;
  createdAt: string;
  lastActivityAt?: string;
  updatedAt: string;
  lastPhaseChangedAt?: string;
  pid?: number;
  logPath: string;
  exitCode?: number;
  lastSummary?: string;
  firstUserMessagePreview?: string;
  lastUserMessagePreview?: string;
  stopRequested?: boolean;
  codexSessionId?: string;
  codexHookSessionId?: string;
  resumedFromSessionId?: string;
  resumeSource?: 'link_bot' | 'codex';
  codexHomeSource?: CodexHomeSource;
  codexStatus?: CachedCodexStatus;
}

export interface ApprovalRecord {
  id: string;
  sessionId: string;
  chatId: string;
  requestedBy: string;
  action?: 'stop_session';
  status: ApprovalStatus;
  riskSummary: string;
  createdAt: string;
  expiresAt: string;
  resolvedBy?: string;
  resolvedAt?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  hookRequestId?: string;
  projectId?: string;
  resolution?: 'allow' | 'deny';
  failureReason?: string;
}

export interface InboundMessageReceipt {
  messageId: string;
  chatId: string;
  chatType: ChatType;
  userId: string;
  textPreview: string;
  firstReceivedAt: string;
  processingStartedAt?: string;
  completedAt?: string;
  failedAt?: string;
  failureReason?: string;
  claimOwnerId?: string;
  lastDuplicateAt?: string;
  duplicateCount: number;
  status: 'claimed' | 'processing' | 'completed' | 'failed';
}

export type InboundAdmissionStatus =
  | 'received'
  | 'pending'
  | 'submitting'
  | 'accepted'
  | 'rejected'
  | 'unknown'
  | 'completed';

export interface InboundAdmissionRecord {
  admissionId: string;
  source: 'feishu';
  externalMessageId: string;
  ownerId: string;
  rawPayload: ClaimInboundMessageInput;
  taskId?: string;
  turnId?: string;
  action?: 'start' | 'steer';
  sandboxGeneration?: number;
  processGeneration?: number;
  status: InboundAdmissionStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimInboundMessageInput {
  /** Persisted topic identity for safe recovery of undelivered inputs. */
  threadId?: string;
  messageId?: string;
  chatId: string;
  chatType: ChatType;
  userId: string;
  text: string;
}

export type ClaimInboundMessageResult =
  | { claimed: true; receipt: InboundMessageReceipt; reason?: 'reclaimed_after_restart' | 'reclaimed_after_failure' }
  | { claimed: true; reason: 'missing_message_id' }
  | { claimed: false; receipt: InboundMessageReceipt };

export type DestructiveCommand = 'upgrade' | 'restart';
export type DestructiveCommandStatus =
  | 'pending'
  | 'executing'
  | 'restart_committed'
  | 'failed'
  | 'expired'
  | 'cancelled';

export interface DestructiveCommandRequest {
  id: string;
  sourceEventId: string;
  userId: string;
  chatId: string;
  command: DestructiveCommand;
  status: DestructiveCommandStatus;
  createdAt: string;
  expiresAt: string;
  confirmedAt?: string;
  committedAt?: string;
  finishedAt?: string;
  failure?: string;
}

export type CreateDestructiveCommandRequestResult =
  | { created: true; request: DestructiveCommandRequest }
  | { created: false; reason: 'event_retry' | 'pending_exists'; request: DestructiveCommandRequest };

export type DecideDestructiveCommandResult =
  | { accepted: true; request: DestructiveCommandRequest }
  | {
      accepted: false;
      reason: 'not_found' | 'identity_mismatch' | 'expired' | 'not_pending';
      request?: DestructiveCommandRequest;
    };

export interface BotEvent {
  type: string;
  at: string;
  data: Record<string, unknown>;
}

export interface BotErrorLogEntry {
  at: string;
  source: string;
  message: string;
  data: Record<string, unknown>;
}
