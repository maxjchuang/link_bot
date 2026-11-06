import type { BotConfig, ProjectConfig } from '../domain/types.js';
import type { TaskActorContext } from '../feishu/FeishuTaskController.js';
import type { SqliteStateStore } from '../state/SqliteStateStore.js';
import { ProjectAccessPolicy } from './ProjectAccessPolicy.js';
import type { DynamicProjectRecord } from './DynamicProjectTypes.js';

type Actor = Pick<TaskActorContext, 'chatType' | 'chatId' | 'topicId' | 'userId'>;

/** One read boundary for configured projects and topic-private dynamic projects. */
export class DynamicProjectCatalog {
  private readonly access: ProjectAccessPolicy;

  constructor(private readonly store: SqliteStateStore, private readonly config: Pick<BotConfig, 'projects' | 'upgrade'>) {
    this.access = new ProjectAccessPolicy(config);
  }

  resolveFor(actor: Actor, projectId: string): ProjectConfig | DynamicProjectRecord | undefined {
    const configured = this.config.projects.find((project) => project.id === projectId);
    const dynamic = this.store.getDynamicProject(projectId);
    if (configured && dynamic) throw new Error(`Dynamic project ID collision: ${projectId}`);
    if (configured) return this.access.canAccess(configured, actor) ? configured : undefined;
    return dynamic && this.access.canAccess(dynamic, actor) ? dynamic : undefined;
  }

  listFor(actor: Actor): Array<ProjectConfig | DynamicProjectRecord> {
    const dynamic = actor.chatType === 'group' && actor.topicId
      ? this.store.listDynamicProjectsFor(actor.userId, actor.chatId, actor.topicId)
        .filter((project) => this.access.canAccess(project, actor))
      : [];
    for (const project of dynamic) {
      if (this.config.projects.some((configured) => configured.id === project.id)) {
        throw new Error(`Dynamic project ID collision: ${project.id}`);
      }
    }
    return [
      ...this.access.list(actor),
      ...dynamic,
    ];
  }
}
