import type { ProjectConfig } from '../domain/types.js';
import type { ConversationContext } from '../conversation/ConversationContextProvider.js';
import { SemanticProjectClassifier } from './SemanticProjectClassifier.js';

export interface ConversationProjectEvidence {
  chatName?: string;
  requestText?: string;
  context?: ConversationContext;
}

/** Select only when conversation metadata contains a clear, unique project match. */
export function selectConversationProject(
  projects: ProjectConfig[],
  evidence: ConversationProjectEvidence,
): ProjectConfig | undefined {
  // Prefer the current request, then walk topic history newest-first. This lets
  // generic retry phrases recover the last explicit implementation target
  // without allowing protocol, dependency, or reference links to become the
  // primary project merely because they are more specific repository URLs.
  const targetSources = [
    evidence.requestText,
    ...(evidence.context?.messages.slice().reverse().map((message) => message.text) ?? []),
  ].filter((text): text is string => Boolean(text));
  for (const source of targetSources) {
    const explicitTarget = explicitDevelopmentTargetText(source);
    if (!explicitTarget) continue;
    const ranked = new SemanticProjectClassifier().classify({ projects, requestText: explicitTarget });
    const best = ranked[0];
    const runnerUp = ranked[1];
    if (best && best.confidence >= 0.85 && best.confidence - (runnerUp?.confidence ?? 0) >= 0.10) {
      return projects.find((project) => project.id === best.projectId);
    }
  }
  const rawCorpus = [
    evidence.chatName,
    evidence.requestText,
    ...(evidence.context?.messages.map((message) => message.text) ?? []),
  ].filter(Boolean).join('\n');
  const linkedRepositories = [...new Set([...rawCorpus.matchAll(
    /https:\/\/github\.com\/([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)\/(?:pull|tree|blob)\//gi,
  )].map((match) => match[1]!.toLocaleLowerCase()))];
  if (linkedRepositories.length === 1) {
    const exact = selectProjectByRepositoryPath(projects, linkedRepositories[0]!);
    if (exact) return exact;
  }
  const corpus = normalize(rawCorpus);
  if (!corpus) return undefined;

  // A topic root often lists every repository participating in an incident.
  // Use the first explicitly named project as the generic workspace anchor;
  // never let the number of aliases make a later project win. The workspace
  // remains multi-project and Codex can open every other authorized project.
  const explicit = projects.map((project) => ({ project, position: firstPosition(project, corpus) }))
    .filter((candidate) => candidate.position >= 0)
    .sort((left, right) => left.position - right.position);
  if (explicit.length > 1 && explicit[0]!.position < explicit[1]!.position) return explicit[0]!.project;
  if (explicit.length > 1 && explicit[0]!.position === explicit[1]!.position) return undefined;

  const ranked = projects.map((project) => ({ project, score: score(project, corpus) }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  const runnerUp = ranked[1];
  if (!best || best.score < 10 || best.score - (runnerUp?.score ?? 0) < 4) return undefined;
  return best.project;
}

function explicitDevelopmentTargetText(text: string): string | undefined {
  const clauses = text.split(/[，。；;\n]+/).map((item) => item.trim()).filter(Boolean);
  const target = clauses.filter((clause) => {
    if (/(?:作为|仅供?|用作).{0,12}(?:参考|协议|依赖)|(?:参考|协议|依赖).{0,12}(?:仓库|项目|mr|链接)/iu.test(clause)) return false;
    const normalized = normalize(clause);
    return /(?:在|修改|实现|开发|完成).{0,50}(?:仓库|项目|前端|后端)|(?:仓库|项目|前端|后端).{0,50}(?:实现|修改|开发|完成)/u.test(normalized)
      || /(?:implement|modify|develop|build).{0,50}(?:repository|repo|project|frontend|backend)|(?:repository|repo|project|frontend|backend).{0,50}(?:implement|modify|develop|build)/i.test(normalized);
  });
  return target.length > 0 ? target.join(' ') : undefined;
}

/** Resolve an external repository identity without collapsing its namespace. */
export function selectProjectByRepositoryPath(projects: ProjectConfig[], repositoryPath: string): ProjectConfig | undefined {
  const normalized = repositoryPath.replace(/^\/+|\/+$/g, '').toLocaleLowerCase();
  const exact = projects.filter((project) => project.repositoryPath?.toLocaleLowerCase() === normalized);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;

  const name = normalized.split('/').at(-1);
  if (!name) return undefined;
  // Once a basename has an explicit external identity, never route another
  // namespace with the same basename through the legacy fuzzy fallback.
  if (projects.some((project) => project.repositoryPath?.toLocaleLowerCase().split('/').at(-1) === name)) return undefined;
  return projects.find((project) => project.id === name || project.path.split('/').at(-1) === name);
}

function score(project: ProjectConfig, corpus: string): number {
  const phrases = projectPhrases(project);
  let result = 0;
  for (const phrase of phrases) {
    if (containsPhrase(corpus, phrase)) result += 12 + Math.min(phrase.split(' ').length, 4);
  }

  const metadata = normalize([project.description, ...(project.instructions ?? [])].filter(Boolean).join(' '));
  const distinctive = new Set(metadata.split(' ').filter((token) => token.length >= 6));
  for (const token of distinctive) if (containsPhrase(corpus, token)) result += 1;
  return result;
}

function projectPhrases(project: ProjectConfig): string[] {
  return [...new Set([normalize(project.id), normalize(project.name)]
    .filter((phrase) => phrase.length >= 4))];
}

function firstPosition(project: ProjectConfig, corpus: string): number {
  const padded = ` ${corpus} `;
  const positions = projectPhrases(project).map((phrase) => padded.indexOf(` ${phrase} `)).filter((index) => index >= 0);
  return positions.length > 0 ? Math.min(...positions) : -1;
}

function containsPhrase(corpus: string, phrase: string): boolean {
  return (` ${corpus} `).includes(` ${phrase} `);
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
