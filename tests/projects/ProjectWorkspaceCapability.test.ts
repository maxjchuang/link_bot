import { describe, expect, it } from 'vitest';
import { ProjectAccessPolicy } from '../../src/projects/ProjectAccessPolicy.js';
import { ProjectWorkspaceCapability, projectBindingDynamicTools, projectCreationDynamicTools, projectDynamicTools, projectSwitchDynamicTools } from '../../src/projects/ProjectWorkspaceCapability.js';
import { sampleConfig } from '../helpers/fakes.js';

describe('ProjectWorkspaceCapability', () => {
  it('exposes catalog, switch and cancel with current-message proof and no filesystem mutation parameters',()=>{
    const definitions=JSON.stringify(projectSwitchDynamicTools());
    for(const name of ['project_switch_catalog','project_switch','project_switch_cancel','requestText','continueRequest'])expect(definitions).toContain(name);
    for(const name of ['cwd','cloneUrl','userId','chatId','force','reset'])expect(definitions).not.toContain(`"${name}"`);
  });
  it('offers semantic project discovery and binding without exposing repository mutation tools to chat', () => {
    const definitions = JSON.stringify(projectBindingDynamicTools());
    expect(definitions).toContain('project_binding_catalog');
    expect(definitions).toContain('project_bind');
    expect(definitions).toContain('project_import');
    expect(definitions).toContain('requestText');
    expect(definitions).not.toContain('project_open');
    expect(definitions).not.toContain('project_publish');
  });
  it('exposes only authorized catalog entries and marks repositories already loaded in the task', () => {
    const config = sampleConfig('/tmp/repo');
    config.projects[0] = {
      ...config.projects[0]!, repositoryPath: 'acme/repo', description: 'Main bot', instructions: ['Run tests'],
      access: { allowedUsers: ['ou_user'], allowedChats: [], knowledgeApprovers: [] },
    };
    config.projects[1] = {
      ...config.projects[1]!, access: { allowedUsers: [], allowedChats: [], knowledgeApprovers: [] },
    };
    const capability = new ProjectWorkspaceCapability(config, new ProjectAccessPolicy(config));

    expect(capability.catalog(
      { chatType: 'private', chatId: 'oc_dm', userId: 'ou_user' },
      [{ projectId: 'repo', checkoutPath: '/workspace/projects/repo', status: 'ready' }],
    )).toEqual([{
      id: 'repo', name: 'Repo', repositoryPath: 'acme/repo', description: 'Main bot', instructions: ['Run tests'],
      loaded: true, workspacePath: '/workspace/projects/repo',
    }]);
  });

  it('registers catalog, open, and knowledge proposal tools', () => {
    const [namespace] = projectDynamicTools();
    expect(namespace).toMatchObject({ type: 'namespace', name: 'project' });
    const tools = namespace!.tools as Array<Record<string, unknown>>;
    expect(tools.map((tool) => tool.name)).toEqual([
      'project_catalog', 'project_status', 'project_open', 'project_sync_base', 'project_publish_merge_request', 'project_publish_existing_branch', 'project_knowledge_propose',
    ]);
    expect(tools.filter((tool) => tool.deferLoading === true)).toEqual([
      expect.objectContaining({ name: 'project_knowledge_propose' }),
    ]);
  });

  it('removes the Manager base-sync shim when native Git is enabled', () => {
    const [namespace] = projectDynamicTools({ nativeGitExecution: true });
    const names = (namespace!.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).not.toContain('project_sync_base');
    expect(names).toContain('project_publish_existing_branch');
  });

  it('can remove Manager publish fallbacks after native Git rollout', () => {
    const [namespace] = projectDynamicTools({ nativeGitExecution: true, managerGitToolFallback: false });
    const names = (namespace!.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).not.toContain('project_publish_merge_request');
    expect(names).not.toContain('project_publish_existing_branch');
  });
});
