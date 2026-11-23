import {describe, expect, it} from 'vitest';
import type {BotConfig} from '../../src/domain/types.js';
import type {TaskRecord, TaskScopeRecord} from '../../src/tasks/TaskTypes.js';
import {resolveAgentExecutionIdentity} from '../../src/security/AgentExecutionIdentity.js';

const config: Pick<BotConfig, 'feishu' | 'personalAgent'> = {
  feishu: {appId: 'fixture-app', appSecret: 'fixture-secret'},
  personalAgent: {enabled: true, ownerUserId: 'ou_owner'},
};
function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {id: 'task_fixture', ownerUserId: 'ou_owner', identityMode: 'personal-agent',
    agentOwnerUserId: 'ou_owner', runtimeMode: 'user-sandbox', baseRef: '', branchName: '',
    runtimeState: 'warm', pinned: false, lastUserInteractionAt: '', createdAt: '', updatedAt: '', ...overrides};
}
const scope: TaskScopeRecord = {taskId: 'task_fixture', scope: 'topic', status: 'canonical',
  scopeKey: 'fixture-topic', chatId: 'oc_group', topicId: 'topic_fixture', createdAt: '', updatedAt: ''};
function resolve(overrides: Partial<Parameters<typeof resolveAgentExecutionIdentity>[0]> = {}) {
  return resolveAgentExecutionIdentity({config, task: task(), scope, requesterUserId: 'ou_member_a', groupServiceVersion: 1, ...overrides});
}

describe('explicit agent execution identity (not an admission decision)', () => {
  it.each(['ou_member_a', 'ou_member_b', 'ou_owner'])('keeps executor fixed and actor real: %s', requesterUserId => {
    const result = resolve({requesterUserId});
    expect(result).toMatchObject({mode: 'personal-agent', agentOwnerUserId: 'ou_owner', requesterUserId,
      groupServiceVersion: 1, audience: {chatId: 'oc_group', chatType: 'group', topicId: 'topic_fixture'}});
    expect(result.agentId).toMatch(/^agent_[a-f0-9]+$/);
  });

  it('derives agent identity only from trusted application configuration', () => {
    const first = resolve();
    expect(resolve({requesterUserId: 'ou_member_b'}).agentId).toBe(first.agentId);
    expect(resolve({config: {...config, feishu: {...config.feishu, appId: 'another-app'}}}).agentId).not.toBe(first.agentId);
    expect(JSON.stringify(first)).not.toContain('fixture-secret');
  });

  it('never reinterprets a historical task when the switch is enabled', () => {
    const original = task({identityMode: undefined, agentOwnerUserId: undefined, ownerUserId: 'ou_original'});
    expect(resolve({task: original})).toMatchObject({mode: 'legacy', agentOwnerUserId: 'ou_original', requesterUserId: 'ou_member_a'});
    expect(original).not.toHaveProperty('agentOwnerUserId', 'ou_owner');
  });

  it('keeps legacy execution valid with the feature disabled or absent', () => {
    for (const personalAgent of [undefined, {enabled: false as const}]) {
      expect(resolve({config: {...config, personalAgent}, task: task({identityMode: undefined, agentOwnerUserId: undefined})}).mode).toBe('legacy');
    }
  });

  it('rejects an unknown persisted mode rather than treating it as personal-agent', () => {
    expect(() => resolve({task: task({identityMode: 'unexpected' as TaskRecord['identityMode']})}))
      .toThrow('agent_identity_mode_invalid');
  });

  it('rejects a persisted null mode; only an absent field means legacy', () => {
    expect(() => resolve({task: task({identityMode: null as unknown as TaskRecord['identityMode'], agentOwnerUserId: undefined})}))
      .toThrow('agent_identity_mode_invalid');
  });

  it.each([undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('requires an operation-bound group version: %s', groupServiceVersion => {
    expect(() => resolve({groupServiceVersion})).toThrow('agent_group_service_version_required');
  });

  it.each([undefined, {enabled: false as const}])('does not downgrade personal tasks when the switch is off: %j', personalAgent => {
    expect(() => resolve({config: {...config, personalAgent}})).toThrow('personal_agent_disabled');
  });

  it.each([
    {...scope, taskId: 'another_task'}, {...scope, chatId: undefined}, {...scope, topicId: undefined},
    {...scope, status: 'legacy' as const}, {...scope, scope: 'legacy' as const},
  ])('rejects incomplete, mismatched or legacy audiences: %j', badScope => {
    expect(() => resolve({scope: badScope})).toThrow();
  });

  it('does not reuse a persisted task after the configured owner changes', () => {
    expect(() => resolve({config: {...config, personalAgent: {enabled: true, ownerUserId: 'ou_other'}}}))
      .toThrow('agent_execution_owner_mismatch');
  });

  it('keeps owner private tasks private without requiring a group version', () => {
    const privateScope: TaskScopeRecord = {...scope, scope: 'private', topicId: undefined, privateUserId: 'ou_owner', chatId: 'oc_private'};
    expect(resolve({scope: privateScope, requesterUserId: 'ou_owner', groupServiceVersion: undefined}))
      .toMatchObject({requesterUserId: 'ou_owner', audience: {chatType: 'private', chatId: 'oc_private'}});
    expect(resolve({scope: privateScope, requesterUserId: 'ou_owner'})).not.toHaveProperty('groupServiceVersion');
    expect(() => resolve({scope: privateScope})).toThrow('private_actor_mismatch');
    expect(() => resolve({scope: {...privateScope, privateUserId: 'ou_member_a'}})).toThrow('private_owner_required');
  });

  it('does not mutate the persisted task or audience', () => {
    const record = task(), snapshot = JSON.stringify({record, scope});
    resolve({task: record});
    expect(JSON.stringify({record, scope})).toBe(snapshot);
  });

  it.each([
    {task: task({agentOwnerUserId: undefined})},
    {task: task({agentOwnerUserId: 'ou_other'})},
    {task: task({ownerUserId: 'ou_member_a'})},
    {task: task({runtimeMode: 'legacy-task-container'})},
    {task: task({identityMode: undefined})},
    {task: task({identityMode: 'invalid' as 'personal-agent'})},
    {config: {...config, personalAgent: {enabled: false}}},
    {config: {...config, personalAgent: undefined}},
    {config: {...config, personalAgent: {enabled: true, ownerUserId: 'ou_other'}}},
    {requesterUserId: ''},
    {scope: {...scope, taskId: 'task_other'}},
    {scope: {...scope, chatId: undefined}},
    {scope: {...scope, topicId: undefined}},
    {scope: {...scope, status: 'legacy'}},
    {groupServiceVersion: undefined},
    {groupServiceVersion: 0},
    {groupServiceVersion: 1.5},
    {groupServiceVersion: Number.MAX_SAFE_INTEGER + 1},
  ])('fails closed rather than choosing the requester: %j', overrides => {
    expect(() => resolve(overrides as Parameters<typeof resolve>[0])).toThrow('agent_');
  });

  it('uses the persisted audience, not the executor private chat', () => {
    expect(resolve().audience.chatId).not.toBe('ou_owner');
    expect(resolve({scope: {...scope, scope: 'group', topicId: undefined}}).audience)
      .toEqual({chatId: 'oc_group', chatType: 'group'});
  });

  it('allows only the owner counterpart in a new personal private task', () => {
    const privateScope = {...scope, scope: 'private' as const, chatId: 'oc_private', topicId: undefined, privateUserId: 'ou_owner'};
    expect(resolve({scope: privateScope, requesterUserId: 'ou_owner', groupServiceVersion: undefined}).audience)
      .toEqual({chatId: 'oc_private', chatType: 'private'});
    expect(() => resolve({scope: privateScope})).toThrow('agent_');
    expect(() => resolve({scope: {...privateScope, privateUserId: 'ou_member_a'}, requesterUserId: 'ou_member_a'})).toThrow('agent_');
  });
});
