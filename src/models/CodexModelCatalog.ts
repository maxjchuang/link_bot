import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CodexModelInfo {
  slug: string;
  displayName: string;
  description?: string;
  priority: number;
  defaultReasoningLevel?: string;
  supportedReasoningLevels: string[];
}

export type CodexModelCatalog =
  | {
    kind: 'available';
    fetchedAt?: string;
    clientVersion?: string;
    models: CodexModelInfo[];
  }
  | CodexModelCatalogUnavailable;

export interface CodexModelCatalogUnavailable {
  kind: 'unavailable';
  reason: 'missing' | 'invalid' | 'empty';
  message: string;
}

interface ReadCodexModelCatalogOptions {
  codexHome?: string;
}

const UNAVAILABLE_MESSAGES = {
  missing: 'Codex model cache not found. Open Codex once or run a Codex command that refreshes models, then try /model again.',
  invalid: 'Codex model cache is unreadable.',
  empty: 'Codex model cache contains no selectable models.',
} as const;

export async function readCodexModelCatalog(options: ReadCodexModelCatalogOptions = {}): Promise<CodexModelCatalog> {
  const codexHome = options.codexHome ?? join(process.env.HOME ?? homedir(), '.codex');
  const cachePath = join(codexHome, 'models_cache.json');

  let rawCache: string;
  try {
    rawCache = await readFile(cachePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return unavailable('missing');
    }
    return unavailable('invalid');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawCache);
  } catch {
    return unavailable('invalid');
  }

  const cache = parseCache(parsed);
  if (!cache) {
    return unavailable('invalid');
  }

  const visibleModels = cache.models.filter((model) => model.visibility === 'list');
  const models: CodexModelInfo[] = [];
  for (const model of visibleModels) {
    const normalized = normalizeModel(model);
    if (normalized) {
      models.push(normalized);
    }
  }

  models.sort((a, b) => a.priority - b.priority || a.slug.localeCompare(b.slug));

  if (models.length === 0) {
    return unavailable('empty');
  }

  return {
    kind: 'available',
    fetchedAt: cache.fetchedAt,
    clientVersion: cache.clientVersion,
    models,
  };
}

function unavailable(reason: CodexModelCatalogUnavailable['reason']): CodexModelCatalogUnavailable {
  return {
    kind: 'unavailable',
    reason,
    message: UNAVAILABLE_MESSAGES[reason],
  };
}

interface ParsedCache {
  fetchedAt?: string;
  clientVersion?: string;
  models: RawModel[];
}

interface RawModel {
  visibility?: unknown;
  slug?: unknown;
  display_name?: unknown;
  description?: unknown;
  priority?: unknown;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: unknown;
}

function parseCache(value: unknown): ParsedCache | undefined {
  if (!isRecord(value) || !Array.isArray(value.models)) {
    return undefined;
  }

  return {
    fetchedAt: stringOrUndefined(value.fetched_at),
    clientVersion: stringOrUndefined(value.client_version),
    models: value.models.filter(isRecord),
  };
}

function normalizeModel(model: RawModel): CodexModelInfo | undefined {
  if (model.visibility !== 'list') {
    return undefined;
  }

  if (typeof model.slug !== 'string') {
    return undefined;
  }

  const supportedReasoningLevels: string[] = [];
  if (Array.isArray(model.supported_reasoning_levels)) {
    for (const level of model.supported_reasoning_levels) {
      if (isRecord(level) && typeof level.effort === 'string') {
        supportedReasoningLevels.push(level.effort);
      }
    }
  }

  return {
    slug: model.slug,
    displayName: stringOrUndefined(model.display_name) ?? model.slug,
    description: stringOrUndefined(model.description),
    priority: finiteNumberOrDefault(model.priority),
    defaultReasoningLevel: stringOrUndefined(model.default_reasoning_level),
    supportedReasoningLevels,
  };
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function finiteNumberOrDefault(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
