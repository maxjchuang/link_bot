import {describe, expect, it} from 'vitest';
import {resolveTaskExecutionOwner} from '../../src/security/AgentExecutionIdentity.js';

const task = {id: 'task', identityMode: 'personal-agent' as const, agentOwnerUserId: 'ou_owner',
  ownerUserId: 'ou_owner', runtimeMode: 'user-sandbox' as const};
const config = {personalAgent: {enabled: true as const, ownerUserId: 'ou_owner'}};
describe('execution ownership is not requester authority', () => {
  it('keeps legacy owner unchanged when the agent flag is enabled', () => {
    expect(resolveTaskExecutionOwner(config, {...task, identityMode: undefined, agentOwnerUserId: undefined, ownerUserId: 'ou_legacy'})).toBe('ou_legacy');
  });
  it('resolves only the fixed, persisted owner', () => {
    expect(resolveTaskExecutionOwner(config, task)).toBe('ou_owner');
  });
  it.each([{}, {personalAgent: {enabled: false as const}},
    {personalAgent: {enabled: true as const, ownerUserId: 'ou_other'}}])('does not fall back if config is unavailable: %j', changed => {
    expect(() => resolveTaskExecutionOwner(changed, task)).toThrow('owner');
  });
  it.each([{ownerUserId: 'ou_requester'}, {agentOwnerUserId: undefined}, {runtimeMode: 'legacy-task-container' as const}])('rejects invalid persisted identity: %j', changed => {
    expect(() => resolveTaskExecutionOwner(config, {...task, ...changed})).toThrow('identity');
  });
});
