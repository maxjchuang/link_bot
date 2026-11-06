import { describe, expect, it } from 'vitest';
import { memoryDynamicTools, TaskMemoryCapability } from '../../src/memory/TaskMemoryCapability.js';
import { MemoryService } from '../../src/memory/MemoryService.js';
import { SqliteStateStore } from '../../src/state/SqliteStateStore.js';

describe('memoryDynamicTools', () => {
  it('assigns a namespace to every deferred App Server tool', () => {
    const [namespace] = memoryDynamicTools();
    expect(namespace).toMatchObject({ type: 'namespace', name: 'memory' });
    const tools = namespace!.tools as Array<Record<string, unknown>>;
    expect(tools.filter((tool) => tool.deferLoading === true)).toEqual([
      expect.objectContaining({ name: 'memory_read' }),
      expect.objectContaining({ name: 'memory_sources' }),
      expect.objectContaining({ name: 'memory_propose' }),
    ]);
  });

  it('documents event keys separately from optional natural-language evidence notes', () => {
    const proposal = (memoryDynamicTools()[0] as { tools: Array<Record<string, unknown>> }).tools
      .find((tool) => tool.name === 'memory_propose') as { inputSchema: { required: string[]; properties: Record<string, unknown> } };
    expect(proposal.inputSchema.required).not.toContain('evidenceEventKeys');
    expect(proposal.inputSchema.properties).toHaveProperty('evidenceEventKeys');
    expect(proposal.inputSchema.properties).toHaveProperty('evidenceNotes');
  });

  it('activates administrator bot proposals and keeps non-administrator proposals pending', () => {
    const store = new SqliteStateStore(':memory:');
    store.saveTask({ id: 'task_1', ownerUserId: 'ou_admin', projectId: 'repo', baseRef: 'main', runtimeState: 'hot', pinned: false, branchName: 'main', lastUserInteractionAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    store.saveTaskContext({ id: 'ctx_1', taskId: 'task_1', codexThreadId: 'thread_1', state: 'active', createdBy: 'ou_admin', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    const memory = new MemoryService(store);
    const admin = new TaskMemoryCapability(memory, { taskId: 'task_1', contextId: 'ctx_1', userId: 'ou_admin', botId: 'bot', allowBotMemory: true, isAdministrator: true }, 100_000);
    const active = admin.propose({ scope: 'bot', kind: 'lesson', title: '回流冲突', description: '通用流程', content: '按语义解决冲突。', tags: ['git'], evidence: [] });
    expect(active).toMatchObject({ scope: 'bot', status: 'active' });
    const member = new TaskMemoryCapability(memory, { taskId: 'task_1', contextId: 'ctx_1', userId: 'ou_admin', botId: 'bot', allowBotMemory: true }, 100_000);
    const pending = member.propose({ scope: 'bot', kind: 'lesson', title: '另一条经验', description: '等待审批', content: '使用有界重试。', evidence: [] });
    expect(pending).toMatchObject({ scope: 'bot', status: 'candidate' });
    const disabled = new TaskMemoryCapability(memory, { taskId: 'task_1', contextId: 'ctx_1', userId: 'ou_admin', botId: 'bot', allowBotMemory: false, isAdministrator: true }, 100_000);
    expect(() => disabled.propose({ scope: 'bot', kind: 'lesson', title: '不可写', description: '功能关闭', content: '不能降级。', evidence: [] })).toThrow('unavailable');
    store.close();
  });
});
