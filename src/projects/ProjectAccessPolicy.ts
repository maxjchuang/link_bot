import type { BotConfig, ProjectConfig } from '../domain/types.js';
import type { TaskActorContext } from '../feishu/FeishuTaskController.js';
import { isDynamicProjectRecord, type DynamicProjectRecord } from './DynamicProjectTypes.js';

type ProjectActor = Pick<TaskActorContext, 'chatType' | 'chatId' | 'topicId' | 'userId'>;

export class ProjectAccessPolicy {
  constructor(private readonly config: Pick<BotConfig, 'projects' | 'upgrade'>) {}

  list(actor: ProjectActor): ProjectConfig[] {
    return this.config.projects.filter((project) => this.canAccess(project, actor));
  }

  canAccess(project: ProjectConfig | DynamicProjectRecord, actor: ProjectActor): boolean {
    if (isDynamicProjectRecord(project)) {
      return actor.chatType === 'group' && actor.userId === project.ownerUserId
        && actor.chatId === project.chatId && actor.topicId === project.topicId;
    }
    if (this.isAdministrator(actor.userId)) return true;
    if (!project.access) return false;
    return actor.chatType === 'group'
      ? project.access.allowedChats.includes('*') || project.access.allowedChats.includes(actor.chatId)
      : project.access.allowedUsers.includes('*') || project.access.allowedUsers.includes(actor.userId);
  }

  canApproveKnowledge(project: ProjectConfig, userId: string): boolean {
    return this.isAdministrator(userId) || project.access?.knowledgeApprovers.includes(userId) === true;
  }

  private isAdministrator(userId: string): boolean {
    return this.config.upgrade.adminUsers.includes(userId);
  }
}
