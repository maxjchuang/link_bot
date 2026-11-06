import type { TaskActorContext } from '../feishu/FeishuTaskController.js';
import type { SqliteStateStore } from '../state/SqliteStateStore.js';

export class ProjectUsageService {
  constructor(private readonly store: SqliteStateStore, private readonly clock: () => Date = () => new Date()) {}

  record(actor: Pick<TaskActorContext, 'chatType' | 'chatId' | 'userId'>, projectId: string): void {
    this.store.db.prepare(`
      INSERT INTO project_usage(actor_key, project_id, last_used_at) VALUES (?, ?, ?)
      ON CONFLICT(actor_key, project_id) DO UPDATE SET last_used_at=excluded.last_used_at
    `).run(actorKey(actor), projectId, this.clock().toISOString());
  }

  recent(actor: Pick<TaskActorContext, 'chatType' | 'chatId' | 'userId'>, authorizedProjectIds: string[]): string | undefined {
    if (authorizedProjectIds.length === 0) return undefined;
    const rows = this.store.db.prepare('SELECT project_id AS projectId FROM project_usage WHERE actor_key=? ORDER BY last_used_at DESC')
      .all(actorKey(actor)) as Array<{ projectId: string }>;
    return rows.find((row) => authorizedProjectIds.includes(row.projectId))?.projectId;
  }
}

function actorKey(actor: Pick<TaskActorContext, 'chatType' | 'chatId' | 'userId'>): string {
  return actor.chatType === 'group' ? `chat:${actor.chatId}` : `user:${actor.userId}`;
}
