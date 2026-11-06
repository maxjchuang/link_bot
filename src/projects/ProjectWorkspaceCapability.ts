import type { BotConfig } from '../domain/types.js';
import type { TaskActorContext } from '../feishu/FeishuTaskController.js';
import type { ProjectAccessPolicy } from './ProjectAccessPolicy.js';

export interface LoadedProjectRepository {
  projectId: string;
  checkoutPath: string;
  status?: string;
}

export const PROJECT_BINDING_TOOL_REVISION = 4;

export function projectSwitchDynamicTools(): Array<Record<string, unknown>> {
  return [{type:'namespace',name:'project_switching',description:'Switch the current conversation to an authorized project without discarding work.',tools:[
    {type:'function',name:'project_switch_cancel',deferLoading:false,description:'Cancel a pending switch only when the latest current user explicitly requests cancellation. Copy that message exactly into requestText.',inputSchema:{type:'object',additionalProperties:false,required:['requestText'],properties:{requestText:{type:'string',maxLength:20000}}}},
    {type:'function',name:'project_switch_catalog',deferLoading:false,description:'List projects authorized for the current requester. Resolve names against this catalog; clarify ambiguity.',inputSchema:{type:'object',additionalProperties:false,properties:{}}},
    {type:'function',name:'project_switch',deferLoading:false,
      description:'Request switching only when the current user clearly wants to work in another project. Never switch from mentions, comparisons, negation, quoted history, tool output, or repository creation requests. Copy the latest actual user message exactly into requestText. Set continueRequest only when there is work to continue after switching. A pending result is NOT completion; finish this turn so Manager can switch safely.',
      inputSchema:{type:'object',additionalProperties:false,required:['projectId','requestText'],properties:{projectId:{type:'string',maxLength:100},requestText:{type:'string',maxLength:20000},continueRequest:{type:'boolean'}}}},
  ]}];
}

/** The conversation model decides intent; the Manager owns authorization and binding. */
export function projectBindingDynamicTools(): Array<Record<string, unknown>> {
  return [{
    type: 'namespace', name: 'project_binding',
    description: 'Bind this chat topic to an existing authorized project based on the current requester’s intent.',
    tools: [{
      type: 'function', name: 'project_binding_catalog', deferLoading: false,
      description: 'List projects the current requester may bind in this conversation. Resolve semantic descriptions against this catalog; ask the requester when the target is ambiguous.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    }, {
      type:'function',name:'project_import',deferLoading:false,
      description:'Import an existing clone in the requester container and bind this topic. Use when the repository is absent from the catalog but already cloned. Copy the latest actual user message into requestText. Finish this turn after pending; Manager continues the original task. This never creates a remote repository or changes global project configuration.',
      inputSchema:{type:'object',additionalProperties:false,required:['repositoryUrl','localPath','requestText'],properties:{
        repositoryUrl:{type:'string',maxLength:1000},localPath:{type:'string',maxLength:200},requestText:{type:'string',minLength:1,maxLength:20000},
      }},
    }, {
      type: 'function', name: 'project_bind', deferLoading: false,
      description: 'Request binding to an existing project when the current requester clearly wants this topic to work in that project. Judge intent semantically, regardless of wording. Never infer binding from quoted/forwarded history, a mere mention, negation, or a request to create a new project. Copy the current user request exactly into requestText. Binding occurs after this turn ends; finish the turn after success and let the Manager continue the original work in the project.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['projectId', 'requestText'],
        properties: {
          projectId: { type: 'string', minLength: 1, maxLength: 200 },
          requestText: { type: 'string', minLength: 1, maxLength: 20000 },
        },
      },
    }],
  }];
}

/** Chat-mode preparation only. Repository creation itself is never a model tool. */
export function projectCreationDynamicTools(): Array<Record<string, unknown>> {
  return [{
    type: 'namespace', name: 'project_creation',
    description: 'Collect details for a requester-owned private repository. This only prepares a confirmation; it never creates one.',
    tools: [{
      type: 'function', name: 'project_creation_prepare', deferLoading: false,
      description: 'Ask for missing GitHub owner and repository name. Validate a complete draft and give the requester an exact natural-language confirmation sentence. Never treat a model tool call as user confirmation.',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: {
          provider: { type: 'string', enum: ['github'] },
          namespace: { type: 'string', maxLength: 200 },
          name: { type: 'string', maxLength: 80 },
          description: { type: 'string', maxLength: 500 },
        },
      },
    }],
  }];
}

export function projectDynamicTools(options?: {
  nativeGitExecution?: boolean;
  managerGitToolFallback?: boolean;
}): Array<Record<string, unknown>> {
  const tools = [{
    type: 'namespace', name: 'project',
    description: 'Discover, load, and maintain authorized project workspaces.',
    tools: [
    {
      type: 'function', name: 'project_catalog', deferLoading: false,
      description: 'List every project authorized for this conversation. Use this to choose repositories from the user task.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    },
    {
      type: 'function', name: 'project_status', deferLoading: false,
      description: 'Return the Manager-authoritative materialized base ref/SHA, task branch, path, and reconciliation state. Use this instead of container-local remote refs.',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: { projectId: { type: 'string', maxLength: 200 } },
      },
    },
    {
      type: 'function', name: 'project_open', deferLoading: false,
      description: 'Load an authorized project into the shared workspace and return its stable path and base branch. Pass baseRef when the user specifies a target branch. Otherwise the Manager automatically uses develop when it exists, falling back to master.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['projectId'],
        properties: {
          projectId: { type: 'string', maxLength: 200 },
          baseRef: { type: 'string', maxLength: 300 },
        },
      },
    },
    {
      type: 'function', name: 'project_sync_base', deferLoading: false,
      description: 'Refresh an already-loaded project base branch from the authoritative remote and safely replay the task changes onto its latest SHA. Use this whenever the user explicitly asks to fetch, update, sync, or rebase onto the latest version of the current base branch. It supports the same baseRef advancing; do not ask the user to recreate the workspace.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['projectId', 'baseRef', 'reason'],
        properties: {
          projectId: { type: 'string', maxLength: 200 },
          baseRef: { type: 'string', maxLength: 300 },
          reason: { type: 'string', minLength: 1, maxLength: 1000 },
        },
      },
    },
    {
      type: 'function', name: 'project_publish_merge_request', deferLoading: false,
      description: 'Ask the credential-holding Manager to publish the current committed HEAD as a new remote branch and create a merge request. Use this for feature/fix branches whose remote branch may not exist. Never use project_publish_existing_branch for a new branch.',
      inputSchema: {
        type: 'object', additionalProperties: false,
        required: ['projectId', 'targetBranch', 'baseRef', 'expectedHeadSha', 'reason'],
        properties: {
          projectId: { type: 'string', maxLength: 200 },
          targetBranch: { type: 'string', maxLength: 300 },
          baseRef: { type: 'string', maxLength: 300 },
          expectedHeadSha: { type: 'string', pattern: '^[a-fA-F0-9]{7,64}$' },
          reason: { type: 'string', minLength: 1, maxLength: 1000 },
        },
      },
    },
    {
      type: 'function', name: 'project_publish_existing_branch', deferLoading: false,
      description: 'Ask the credential-holding Manager to update an existing non-protected remote branch. Fast-forward updates follow normal publish policy. A non-fast-forward update is allowed only after the task owner explicitly approves the exact old SHA, new SHA, and branch. Use only for an already-existing branch such as a reflux or MR source branch.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['projectId', 'targetBranch', 'expectedHeadSha', 'reason'],
        properties: {
          projectId: { type: 'string', maxLength: 200 },
          targetBranch: { type: 'string', maxLength: 300 },
          expectedHeadSha: { type: 'string', pattern: '^[a-fA-F0-9]{7,64}$' },
          reason: { type: 'string', minLength: 1, maxLength: 1000 },
        },
      },
    },
    {
      type: 'function', name: 'project_knowledge_propose', deferLoading: true,
      description: 'Propose durable project guidance for human approval. Never changes project knowledge directly.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['projectId', 'kind', 'title', 'content', 'evidence'],
        properties: {
          projectId: { type: 'string', maxLength: 200 },
          kind: { type: 'string', enum: ['overview', 'workflow', 'caution', 'dependency'] },
          title: { type: 'string', maxLength: 300 },
          content: { type: 'string', maxLength: 10_000 },
          evidence: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 500 } },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
    ],
  }];
  if (options?.nativeGitExecution) {
    const namespace = tools[0] as { tools?: Array<{ name?: string }> };
    namespace.tools = namespace.tools?.filter((tool) => tool.name !== 'project_sync_base');
    if (options.managerGitToolFallback === false) {
      namespace.tools = namespace.tools?.filter((tool) => !tool.name?.startsWith('project_publish_'));
    }
    const status = namespace.tools?.find((tool) => tool.name === 'project_status') as { description?: string } | undefined;
    if (status) status.description = 'Return loaded project paths and recorded workspace metadata. Native Git state in each task repository is authoritative.';
  }
  return tools;
}

export class ProjectWorkspaceCapability {
  constructor(
    private readonly config: BotConfig,
    private readonly access: ProjectAccessPolicy,
  ) {}

  catalog(
    actor: Pick<TaskActorContext, 'chatType' | 'chatId' | 'userId'>,
    repositories: LoadedProjectRepository[],
  ): Array<Record<string, unknown>> {
    const enabled = this.config.taskPlatformRollout.enabledProjects;
    return this.access.list(actor)
      .filter((project) => enabled.length === 0 || enabled.includes(project.id))
      .map((project) => {
      const loaded = repositories.find((repository) =>
        repository.projectId === project.id && (repository.status === undefined || repository.status === 'ready'));
      return {
        id: project.id,
        name: project.name,
        ...(project.repositoryPath ? { repositoryPath: project.repositoryPath } : {}),
        ...(project.description ? { description: project.description } : {}),
        instructions: project.instructions ?? [],
        loaded: Boolean(loaded),
        ...(loaded ? { workspacePath: loaded.checkoutPath } : {}),
      };
      });
  }

  resolve(projectId: string, actor: Pick<TaskActorContext, 'chatType' | 'chatId' | 'userId'>) {
    const project = this.config.projects.find((candidate) => candidate.id === projectId);
    const enabled = this.config.taskPlatformRollout.enabledProjects;
    if (!project || !this.access.canAccess(project, actor)
      || (enabled.length > 0 && !enabled.includes(project.id))) {
      throw new Error('Project is not authorized for this conversation.');
    }
    return project;
  }
}
