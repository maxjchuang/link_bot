import type { ProjectConfig } from '../domain/types.js';

export interface PlannedRepository {
  projectId: string;
  baseRef: string;
  role: 'primary' | 'dependency';
  reason: string;
}

export interface WorkspaceStage {
  id: string;
  kind: 'materialize' | 'idl_publish' | 'generated_clients' | 'implement' | 'validate' | 'publish' | 'monitor';
  projectIds: string[];
  dependsOn: string[];
  state: 'pending' | 'completed';
}
export interface WorkspacePlan { repositories: PlannedRepository[]; stages: WorkspaceStage[]; explicit: boolean }

export interface RepositoryViewIntent {
  projectId: string;
  targetRef: string;
  mode: 'inspect' | 'migrate' | 'ambiguous';
  confidence: 'high' | 'medium';
  evidence: string[];
}

/**
 * Parses a request to use a repository ref without conflating a temporary
 * read-only view with a durable workspace-baseline migration.
 */
export function parseRepositoryViewIntent(text: string, projects: ProjectConfig[]): RepositoryViewIntent | undefined {
  const project = projects.find((candidate) => {
    const aliases = [candidate.id, candidate.name].filter(Boolean).map(escapeRegExp);
    return aliases.some((alias) => new RegExp(`(?:^|[^A-Za-z0-9_-])${alias}(?:$|[^A-Za-z0-9_-])`, 'i').test(text));
  });
  if (!project) return undefined;

  const projectAliases = [project.id, project.name].filter(Boolean).map(escapeRegExp).join('|');
  const patterns = [
    new RegExp(`(?:${projectAliases})[^\n]{0,100}?([A-Za-z0-9][A-Za-z0-9._/-]{0,299})\\s*(?:分支|基线)`, 'i'),
    /(?:切换?到|切到|查看|看看|读取|分析|核对|基于|从)\s*([A-Za-z0-9][A-Za-z0-9._/-]{0,299})\s*(?:分支|基线)/i,
    /\b((?:release(?:-web)?-[A-Za-z0-9._/-]+|feat(?:ure)?[-/][A-Za-z0-9._/-]+|fix[-/][A-Za-z0-9._/-]+|hotfix[-/][A-Za-z0-9._/-]+))\b/i,
  ];
  const targetRef = patterns.map((pattern) => pattern.exec(text)?.[1]).find(Boolean);
  if (!targetRef || targetRef.startsWith('-') || /\.\./.test(targetRef)) return undefined;

  const inspect = /查看|看看|读取|分析|核对|确认|排查|查询|日志|logid|只读|对比|检查/i.test(text);
  const migrate = /修改|修复|开发|实现|编码|写代码|改代码|提交|创建\s*MR|提\s*MR|合并请求|迁移基线/i.test(text);
  const explicitSwitch = /切换?|迁移|改成|调整.*基线/i.test(text);
  const mode = migrate ? 'migrate' : inspect ? 'inspect' : explicitSwitch ? 'ambiguous' : 'inspect';
  return {
    projectId: project.id, targetRef, mode,
    confidence: inspect || migrate ? 'high' : 'medium',
    evidence: [project.id, targetRef, ...(inspect ? ['inspect-cue'] : []), ...(migrate ? ['write-cue'] : []), ...(explicitSwitch ? ['switch-cue'] : [])],
  };
}

export function mergeWorkspacePlans(...plans: Array<WorkspacePlan | undefined>): WorkspacePlan | undefined {
  const available = plans.filter((plan): plan is WorkspacePlan => Boolean(plan));
  if (available.length === 0) return undefined;
  const repositories: PlannedRepository[] = [];
  for (const plan of available) {
    for (const repository of plan.repositories) {
      const index = repositories.findIndex((item) => item.projectId === repository.projectId);
      if (index < 0) repositories.push(repository);
      else repositories[index] = { ...repositories[index]!, ...repository };
    }
  }
  if (!repositories.some((item) => item.role === 'primary')) repositories[0]!.role = 'primary';
  const previousStages = available.flatMap((plan) => plan.stages);
  return {
    repositories,
    stages: buildWorkspaceStages(repositories).map((stage) => previousStages.some((previous) =>
      previous.kind === stage.kind && previous.state === 'completed'
      && stage.projectIds.every((projectId) => previous.projectIds.includes(projectId)))
      ? { ...stage, state: 'completed' as const }
      : stage),
    explicit: available.some((plan) => plan.explicit),
  };
}

export function normalizeRepositoryBaseRef(_projectId: string, baseRef: string): string {
  return baseRef.trim();
}

export function parseBaselineMigration(text: string, projects: ProjectConfig[] = []): { projectId: string; targetBaseRef: string } | undefined {
  const intent = parseRepositoryViewIntent(text, projects);
  return intent?.mode === 'migrate' ? { projectId: intent.projectId, targetBaseRef: intent.targetRef } : undefined;
}

export function parseWorkspacePlan(text: string, projects: ProjectConfig[]): WorkspacePlan | undefined {
  const normalized = text.toLocaleLowerCase();
  const repositories: PlannedRepository[] = [];
  const add = (project: ProjectConfig, baseRef: string, role: PlannedRepository['role'], reason: string) => {
    if (!repositories.some((item) => item.projectId === project.id)) repositories.push({ projectId: project.id, baseRef, role, reason });
  };
  for (const project of projects) {
    const escapedId = escapeRegExp(project.id);
    const direct = new RegExp(`(?:${escapedId}|${escapeRegExp(project.name.toLocaleLowerCase())})[^\\n]{0,80}?(?:从|基于|base(?:ref)?[:=]?|分支[:=]?)\\s*([A-Za-z0-9._/-]+)`, 'i').exec(normalized);
    if (direct?.[1]) add(project, direct[1], repositories.length === 0 ? 'primary' : 'dependency', '用户明确指定仓库基线');
  }
  if (repositories.length === 0) return undefined;
  if (!repositories.some((item) => item.role === 'primary')) repositories[0]!.role = 'primary';
  return { repositories, stages: buildWorkspaceStages(repositories), explicit: true };
}

export function buildWorkspaceStages(repositories: PlannedRepository[]): WorkspaceStage[] {
  const ids = repositories.map((item) => item.projectId);
  const applicationIds = ids;
  const stages: WorkspaceStage[] = [{ id: 'materialize', kind: 'materialize', projectIds: ids, dependsOn: [], state: 'pending' }];
  const implementationDependency = 'materialize';
  stages.push({ id: 'implement', kind: 'implement', projectIds: applicationIds.length ? applicationIds : ids, dependsOn: [implementationDependency], state: 'pending' });
  stages.push({ id: 'validate', kind: 'validate', projectIds: applicationIds.length ? applicationIds : ids, dependsOn: ['implement'], state: 'pending' });
  stages.push({ id: 'publish', kind: 'publish', projectIds: ids, dependsOn: ['validate'], state: 'pending' });
  stages.push({ id: 'monitor', kind: 'monitor', projectIds: ids, dependsOn: ['publish'], state: 'pending' });
  return stages;
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
