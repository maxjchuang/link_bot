import type { ProjectConfig } from '../domain/types.js';
import type { ConversationContext } from '../conversation/ConversationContextProvider.js';
import type { ProjectRoutingCandidate } from './ProjectRoutingTypes.js';

export interface SemanticProjectClassifierInput {
  projects: ProjectConfig[];
  chatName?: string;
  requestText: string;
  context?: ConversationContext;
}

/**
 * A constrained, explainable semantic classifier. It may only rank projects
 * from the authorized catalog; callers retain the confidence gate.
 */
export class SemanticProjectClassifier {
  classify(input: SemanticProjectClassifierInput): ProjectRoutingCandidate[] {
    const corpus = normalize([
      input.chatName, input.requestText,
      ...(input.context?.messages.map((message) => message.text) ?? []),
    ].filter(Boolean).join('\n'));
    return input.projects.map((project) => rank(project, corpus))
      .filter((candidate) => candidate.confidence > 0)
      .sort((left, right) => right.confidence - left.confidence || left.projectId.localeCompare(right.projectId));
  }
}

function rank(project: ProjectConfig, corpus: string): ProjectRoutingCandidate {
  let score = 0;
  const evidence: string[] = [];
  const metadata = normalize([project.id, project.name, project.repositoryPath, project.description,
    ...(project.instructions ?? [])].filter(Boolean).join(' '));
  const direct = [project.id, project.name, project.repositoryPath].filter(Boolean).map((value) => normalize(String(value)));
  if (direct.some((phrase) => phrase.length >= 4 && contains(corpus, phrase))) {
    score += 80; evidence.push('消息或上下文明确提及项目名称或仓库');
  }
  const frontendIntent = any(corpus, ['前端', 'frontend', 'web', '页面', '样式', 'ui', '交互', '组件', 'css', '对齐']);
  const backendIntent = any(corpus, ['后端', 'backend', '服务端', '接口', 'go service', '数据库']);
  if (frontendIntent && any(metadata, ['frontend', 'react', 'web', '前端'])) {
    score += 38; evidence.push('前端/UI 意图与项目职责一致');
  }
  if (backendIntent && any(metadata, ['backend', 'go service', '后端'])) {
    score += 38; evidence.push('后端/服务意图与项目职责一致');
  }
  if (frontendIntent && any(metadata, ['backend', 'go service']) && !any(metadata, ['frontend', 'react'])) score -= 24;
  if (backendIntent && any(metadata, ['frontend', 'react']) && !any(metadata, ['backend', 'go service'])) score -= 24;
  return { projectId: project.id, confidence: Math.max(0, Math.min(0.99, score / 100)), evidence };
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
function contains(corpus: string, phrase: string): boolean {
  return /[\p{Script=Han}]/u.test(phrase) ? corpus.includes(phrase) : ` ${corpus} `.includes(` ${phrase} `);
}
function any(corpus: string, phrases: string[]): boolean { return phrases.some((phrase) => contains(corpus, normalize(phrase))); }
