import type { BotConfig, ChatType, ProjectConfig } from '../domain/types.js';

export interface IncomingPrincipal {
  userId: string;
  chatId: string;
  chatType: ChatType;
}

export function isAuthorizedMessage(config: BotConfig, principal: IncomingPrincipal): boolean {
  const unlistedGroupUserAllowed = config.allowUnlistedGroupUsers && principal.chatType === 'group';
  if (config.restrictUsers && !config.allowedUsers.includes(principal.userId) && !unlistedGroupUserAllowed) {
    return false;
  }
  return isAuthorizedChat(config, principal);
}

export function isAuthorizedChat(config: BotConfig, principal: Pick<IncomingPrincipal, 'chatId' | 'chatType'>): boolean {
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
