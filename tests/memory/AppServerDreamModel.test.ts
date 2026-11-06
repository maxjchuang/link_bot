import { describe, expect, it, vi } from 'vitest';
import type { CodexBackend, RunMaintenanceTurnInput } from '../../src/backends/CodexBackend.js';
import { AppServerDreamModel } from '../../src/memory/AppServerDreamModel.js';

describe('AppServerDreamModel', () => {
  it('requests strict structured output and normalizes a null episode', async () => {
    const runMaintenanceTurn = vi.fn(async (_input: RunMaintenanceTurnInput) => ({ episode: null, candidates: [], globalCandidates: [] }));
    const model = new AppServerDreamModel({ runMaintenanceTurn } as unknown as CodexBackend);
    await expect(model.consolidate({
      jobId: 'dream_1', taskId: 'task_1', capabilities: {
        shell: false, network: false, workspaceRead: false, workspaceWrite: false,
        approval: false, publish: false, mutableMemory: false,
      },
      events: [{ sequence: 1, eventKey: 'message_1', eventType: 'user.message', untrustedData: true, text: 'hello' }],
    })).resolves.toEqual({ candidates: [], globalCandidates: [] });
    const call = runMaintenanceTurn.mock.calls[0]![0];
    expect(call.taskId).toBe('task_1');
    expect(call.prompt).toContain('untrusted historical events');
    expect(call.outputSchema).toMatchObject({
      additionalProperties: false,
      required: ['episode', 'candidates', 'globalCandidates'],
    });
  });

  it('fails closed when the backend lacks isolated maintenance support', async () => {
    const model = new AppServerDreamModel({} as CodexBackend);
    await expect(model.consolidate({ jobId: 'dream_1', taskId: 'task_1', events: [], capabilities: {
      shell: false, network: false, workspaceRead: false, workspaceWrite: false,
      approval: false, publish: false, mutableMemory: false,
    } })).rejects.toThrow('maintenance_unavailable');
  });
});
