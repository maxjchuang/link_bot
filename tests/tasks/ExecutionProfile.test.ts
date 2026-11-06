import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXECUTION_PROFILE,
  DEFAULT_HOST_EXECUTION_PROFILE,
  RESTRICTED_USER_EXECUTION_PROFILE,
  completeExecutionProfile,
  taskExecutionProfile,
} from '../../src/tasks/ExecutionProfile.js';

describe('ExecutionProfile', () => {
  it('defaults new host and worker tasks to GPT-6.1 Sol medium Standard', () => {
    expect(DEFAULT_EXECUTION_PROFILE).toMatchObject({ model: 'gpt-6.1-sol', reasoningEffort: 'medium', serviceTier: 'default' });
    expect(DEFAULT_HOST_EXECUTION_PROFILE).toMatchObject({ model: 'gpt-6.1-sol', reasoningEffort: 'medium', serviceTier: 'default' });
    expect(RESTRICTED_USER_EXECUTION_PROFILE).toEqual({ model: 'gpt-6.1-sol', reasoningEffort: 'medium', serviceTier: 'default' });
  });

  it('always resolves a complete profile from the global baseline', () => {
    expect(completeExecutionProfile(undefined)).toEqual(DEFAULT_EXECUTION_PROFILE);
    expect(completeExecutionProfile({ model: 'gpt-5.6-terra' }, undefined, 'task-temporary')).toEqual({
      model: 'gpt-5.6-terra', reasoningEffort: 'medium', serviceTier: 'default', source: 'task-temporary',
    });
  });

  it('migrates legacy task model fields into configured and effective state', () => {
    expect(taskExecutionProfile({ model: 'gpt-5.5', reasoningEffort: 'high' }, '2026-09-01T00:00:00.000Z'))
      .toEqual({
        configured: { model: 'gpt-5.5', reasoningEffort: 'high', serviceTier: 'default', source: 'worker-default' },
        effective: {
          model: 'gpt-5.5', reasoningEffort: 'high', serviceTier: 'default', source: 'worker-default',
          confirmedAt: '2026-09-01T00:00:00.000Z',
        },
      });
  });
});
