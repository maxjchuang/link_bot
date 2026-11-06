import type { CodexBackend, CodexBackendEvent, ResumeTaskInput, StartTaskInput } from '../backends/CodexBackend.js';

export interface TaskLifecycleEventSink {
  append(event: CodexBackendEvent): Promise<void> | void;
}

export class TaskLifecycleService {
  private readonly eventPumps = new Map<string, Promise<void>>();

  constructor(
    private readonly backend: CodexBackend,
    private readonly eventSink: TaskLifecycleEventSink,
  ) {}

  async startTask(input: StartTaskInput): Promise<void> {
    await this.backend.startTask(input);
    this.startEventPump(input.taskId);
  }

  async resumeTask(input: ResumeTaskInput): Promise<void> {
    await this.backend.resumeTask(input);
    this.startEventPump(input.taskId);
  }

  async startTurn(taskId: string, prompt: string): Promise<void> {
    await this.backend.startTurn({ taskId, prompt });
  }

  async steerTurn(taskId: string, prompt: string): Promise<void> {
    await this.backend.steerTurn({ taskId, prompt });
  }

  async interruptTurn(taskId: string): Promise<void> {
    await this.backend.interruptTurn({ taskId });
  }

  async stopTask(taskId: string): Promise<void> {
    await this.backend.stopTask(taskId);
  }

  waitForEvents(taskId: string): Promise<void> | undefined {
    return this.eventPumps.get(taskId);
  }

  private startEventPump(taskId: string): void {
    if (this.eventPumps.has(taskId)) {
      throw new Error(`Task event pump is already running: ${taskId}`);
    }
    const pump = (async () => {
      for await (const event of this.backend.events(taskId)) {
        await this.eventSink.append(event);
      }
    })().finally(() => this.eventPumps.delete(taskId));
    this.eventPumps.set(taskId, pump);
  }
}
