import { cwd } from 'node:process';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { loadConfig } from './config/loadConfig.js';
import { initializeProjectCodexHome } from './codex/CodexHome.js';
import { LarkLongConnectionGateway } from './feishu/FeishuGateway.js';
import { renderFeishuMessage } from './feishu/FeishuMessageRenderer.js';
import { sanitizePublicAnswerText } from './details/DetailSanitizer.js';
import { SensitiveReplyDelivery } from './details/SensitiveReplyDelivery.js';
import { AppServerCodexBackend } from './appserver/AppServerCodexBackend.js';
import { HostAppServerSession } from './host/HostAppServerSession.js';
import { startHostControlServer } from './host/HostControlRpc.js';
import { FeishuAppServerTurnExperience } from './livecards/AppServerTurnExperience.js';
import { SqliteAppServerTurnCardStore } from './livecards/AppServerTurnCardStore.js';
import { createTurnDetailRuntime } from './details/TurnDetailRuntime.js';
import { InlineTurnDetailPublisher } from './details/InlineTurnDetails.js';
import { HostRestartCoordinator } from './host/HostRestartCoordinator.js';
import { installHostCodexCommandPolicy, installHostCommandProtection } from './host/HostCommandProtection.js';
import { readCodexModelCatalog } from './models/CodexModelCatalog.js';
import { deliverMarkdownAttachments } from './host/MarkdownAttachmentDelivery.js';

export async function startHostManager(projectRoot = cwd()): Promise<void> {
  process.env.LINK_BOT_HOST_MANAGER = '1';
  const realPm2 = installHostCommandProtection(projectRoot);
  const config = await loadConfig(projectRoot);
  if (!config.hostControl?.enabled) throw new Error('hostControl.enabled must be true.');
  const project = config.projects.find((candidate) => candidate.id === config.hostControl!.projectId);
  if (!project) throw new Error(`Host control project not found: ${config.hostControl.projectId}`);
  const stateDir = resolve(projectRoot, '.link-bot/host-control-state');
  const threadsPath = resolve(stateDir, 'threads.json');
  const restartRequestPath = resolve(projectRoot, '.link-bot/host-manager-restart-request.json');
  const restartCoordinator = new HostRestartCoordinator(
    restartRequestPath, config.hostControl.managerProcessName, projectRoot, undefined,
    (managerName, root) => {
      const child = spawn(realPm2, ['restart', managerName, '--update-env'], {
        cwd: root, detached: true, stdio: 'ignore', env: process.env,
      });
      child.unref();
    },
  );
  await restartCoordinator.reconcileStartup();
  await mkdir(stateDir, { recursive: true });
  const codexHome = await initializeProjectCodexHome({ projectRoot });
  installHostCodexCommandPolicy(codexHome.codexHome, realPm2);
  const backend = new AppServerCodexBackend({
    command: config.codex.command,
    maxFrameBytes: config.runtime?.appServerMaxFrameBytes,
  });
  const health = await backend.healthCheck();
  if (!health.ok) throw new Error(`Host App Server health check failed: ${health.reason}`);
  const notifier = new LarkLongConnectionGateway(config.feishu.appId, config.feishu.appSecret);
  const sensitiveReplies = new SensitiveReplyDelivery(resolve(projectRoot, '.link-bot/sensitive-replies'), notifier, undefined,
    config.sensitiveReplyDeliveryEnabled !== false);
  const statePath = config.runtime?.statePath ?? resolve(projectRoot, '.link-bot/task-platform.sqlite');
  const appServerCardStore = new SqliteAppServerTurnCardStore(statePath);
  const turnDetails = createTurnDetailRuntime(statePath);
  const inlinePublisher = new InlineTurnDetailPublisher(turnDetails.store, turnDetails.resources, notifier, undefined, turnDetails.audit,
    config.liveCards.inlineTimelineMaxItems);
  const cardRecovery = new FeishuAppServerTurnExperience(
      notifier, config.liveCards.refreshIntervalMs, undefined, appServerCardStore, 'host_manager', undefined,
      turnDetails ? {
        enabled: config.liveCards.detailsEnabled === true,
        inlineEnabled: config.liveCards.inlineDetailsEnabled === true,
        flush: () => turnDetails.flush(),
        readInline: (identity, context) => inlinePublisher.capture(identity, context),
        registerCard: (identity) => turnDetails.views?.registerCard(identity),
        saveResult: (identity, answer, endedAt) => {
          const scope = turnDetails.store?.getTurn(identity)?.scope;
          if (scope) turnDetails.results?.save(identity, scope, answer, endedAt);
          const metadata = turnDetails.results?.metadata(identity);
          if (!metadata) return;
          const page = turnDetails.results!.readPage(identity);
          return { text: page.text, hasMore: page.nextOffset !== undefined, endedAt: metadata.endedAt };
        },
      } : undefined,
      turnDetails.telemetry,
    );
  const turnExperience = config.liveCards.enabled ? cardRecovery : undefined;
  const session = new HostAppServerSession({
    backend, cwd: project.path, codexHome: codexHome.codexHome,
    args: [...config.codex.defaultArgs, ...project.codexArgs],
    projectId: project.id,
    defaultExecutionProfile: config.codex.executionProfiles.host,
    ...(turnExperience ? { turnExperience } : {}),
    ...(turnDetails ? { turnDetails: turnDetails.sink } : {}),
    prepareFinalText: async (message, text) => deliverMarkdownAttachments(await sensitiveReplies.prepare({
      requesterUserId: message.userId ?? '', ownerUserId: message.userId ?? '',
      chatId: message.chatId, sourceMessageId: message.messageId,
    }, text), project.path, { chatId: message.chatId, replyToMessageId: message.messageId }, notifier),
    loadThreads: async () => JSON.parse(await readFile(threadsPath, 'utf8').catch(() => '{}')) as Record<string, string>,
    saveThreads: async (threads) => {
      const temporary = `${threadsPath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(threads, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, threadsPath);
    },
    notify: async (message, text, completed) => notifier.sendRenderedMessageToTarget({
      chatId: message.chatId, replyToMessageId: message.messageId,
    }, renderFeishuMessage({
      kind: completed ? 'completion' : 'error', bodyMarkdown: sanitizePublicAnswerText(text), fallbackText: sanitizePublicAnswerText(text),
    }, { verbosity: config.ui.verbosity })),
    afterTurnCompleted: async () => { await restartCoordinator.handoffAfterTurn(); },
    isRestartPending: async () => restartCoordinator.isDraining(),
    readModelCatalog: () => readCodexModelCatalog({ codexHome: codexHome.codexHome }),
  });
  if (!config.liveCards.enabled) await cardRecovery.recoverFinalizations('host_manager');
  await session.recover();
  const runDetailMaintenance = () => { try { turnDetails.maintain(); } catch { /* Independent housekeeping. */ }
    void sensitiveReplies.cleanup().catch(() => undefined); };
  runDetailMaintenance();
  const detailMaintenanceTimer = setInterval(runDetailMaintenance, 60_000);
  detailMaintenanceTimer.unref();
  const server = await startHostControlServer(config.hostControl.socketPath, session);
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(detailMaintenanceTimer);
    server.close();
    await session.shutdown(`Link Bot 收到 ${signal}，当前任务已安全中断。`);
    cardRecovery.dispose();
    appServerCardStore.close();
    await turnDetails?.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  console.info(`Host App Server manager listening on ${config.hostControl.socketPath}`);
}

startHostManager().catch((error) => {
  console.error(error);
  // PM2 must observe a real process exit when startup never reaches socket
  // listening; keeping the event loop alive creates a misleading "online"
  // manager while private-message RPCs fail with ECONNREFUSED.
  process.exit(1);
});
