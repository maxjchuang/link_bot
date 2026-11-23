import type { BotConfig, ChatType, ProjectConfig } from '../domain/types.js';

export interface IncomingPrincipal {
  userId: string;
  chatId: string;
  chatType: ChatType;
}

export function isAuthorizedMessage(config: BotConfig, principal: IncomingPrincipal): boolean {
  // The generic control plane remains owner-only, including after feature rollback.
  // Ordinary delegated group tasks enter through PersonalAgentAdmission instead.
  if (config.personalAgent?.ownerUserId && principal.userId !== config.personalAgent.ownerUserId) return false;
  const unlistedGroupUserAllowed = config.allowUnlistedGroupUsers && principal.chatType === 'group';
  if (config.restrictUsers && !config.allowedUsers.includes(principal.userId) && !unlistedGroupUserAllowed) {
    return false;
  }
  return isAuthorizedChat(config, principal);
}

export function isAuthorizedChat(config: Pick<BotConfig, 'restrictChatIds'|'allowedChatIds'>, principal: Pick<IncomingPrincipal, 'chatId' | 'chatType'>): boolean {
  if (principal.chatType === 'private') {
    return true;
  }
  if (!config.restrictChatIds) {
    return true;
  }
  return config.allowedChatIds.includes(principal.chatId);
}

export function resolveProject(config: BotConfig, projectId: string): ProjectConfig | undefined {
  return config.projects.find((project) => project.id === projectId);
}
