import { createHash } from 'node:crypto';
import type { TaskBindingKey, TaskBindingRecord } from './TaskTypes.js';

export interface TaskBindingStore {
  saveTaskBinding(binding: TaskBindingRecord): Promise<void>;
  getTaskBinding(bindingId: string): Promise<TaskBindingRecord | undefined>;
}

type Clock = () => Date;

export class TaskBindingService {
  constructor(
    private readonly store: TaskBindingStore,
    private readonly clock: Clock = () => new Date(),
  ) {}

  async bind(key: TaskBindingKey, taskId: string): Promise<TaskBindingRecord> {
    const id = taskBindingId(key);
    const previous = await this.store.getTaskBinding(id);
    const now = this.clock().toISOString();
    const record: TaskBindingRecord = {
      id,
      chatType: key.chatType,
      ...(key.chatType === 'group' ? { chatId: key.chatId, topicId: key.topicId } : {}),
      userId: key.userId,
      taskId,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    await this.store.saveTaskBinding(record);
    return record;
  }

  async resolve(key: TaskBindingKey): Promise<TaskBindingRecord | undefined> {
    return this.store.getTaskBinding(taskBindingId(key));
  }

  async resolveOwnedTask(key: TaskBindingKey, actingUserId: string): Promise<string | undefined> {
    if (key.userId !== actingUserId) {
      return undefined;
    }
    return (await this.resolve(key))?.taskId;
  }
}

export function taskBindingId(key: TaskBindingKey): string {
  const canonical = key.chatType === 'private'
    ? `private\u0000${key.userId}`
    : `group\u0000${key.chatId}\u0000${key.userId}\u0000${key.topicId ?? ''}`;
  return `binding_${createHash('sha256').update(canonical).digest('hex')}`;
}
