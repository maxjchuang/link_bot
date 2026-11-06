import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTmpDir } from '../helpers/tmp.js';
import { readCodexModelCatalog } from '../../src/models/CodexModelCatalog.js';

describe('readCodexModelCatalog', () => {
  it('reads visible models sorted by priority and slug, ignoring hidden models', async () => {
    const codexHome = await createTmpDir();
    await writeCache(codexHome, {
      fetched_at: '2026-06-03T13:43:32.128077Z',
      client_version: '0.136.0',
      models: [
        {
          slug: 'gpt-z',
          display_name: 'GPT Z',
          description: 'Last visible model',
          default_reasoning_level: 'medium',
          supported_reasoning_levels: [{ effort: 'medium', description: 'Balanced' }],
          visibility: 'list',
          priority: 20,
        },
        {
          slug: 'hidden-model',
          display_name: 'Hidden Model',
          description: 'Should not be returned',
          default_reasoning_level: 'low',
          supported_reasoning_levels: [{ effort: 'low', description: 'Fast' }],
          visibility: 'hidden',
          priority: 1,
        },
        {
          slug: 'gpt-a',
          display_name: 'GPT A',
          description: 'Tie sorted first by slug',
          default_reasoning_level: 'high',
          supported_reasoning_levels: [
            { effort: 'low', description: 'Fast' },
            { effort: 'high', description: 'Deep' },
          ],
          visibility: 'list',
          priority: 10,
        },
        {
          slug: 'gpt-b',
          display_name: 'GPT B',
          description: 'Tie sorted second by slug',
          default_reasoning_level: 'low',
          supported_reasoning_levels: [],
          visibility: 'list',
          priority: 10,
        },
      ],
    });

    await expect(readCodexModelCatalog({ codexHome })).resolves.toEqual({
      kind: 'available',
      fetchedAt: '2026-06-03T13:43:32.128077Z',
      clientVersion: '0.136.0',
      models: [
        {
          slug: 'gpt-a',
          displayName: 'GPT A',
          description: 'Tie sorted first by slug',
          defaultReasoningLevel: 'high',
          supportedReasoningLevels: ['low', 'high'],
          priority: 10,
        },
        {
          slug: 'gpt-b',
          displayName: 'GPT B',
          description: 'Tie sorted second by slug',
          defaultReasoningLevel: 'low',
          supportedReasoningLevels: [],
          priority: 10,
        },
        {
          slug: 'gpt-z',
          displayName: 'GPT Z',
          description: 'Last visible model',
          defaultReasoningLevel: 'medium',
          supportedReasoningLevels: ['medium'],
          priority: 20,
        },
      ],
    });
  });

  it('returns missing-cache result', async () => {
    const codexHome = await createTmpDir();

    await expect(readCodexModelCatalog({ codexHome })).resolves.toEqual({
      kind: 'unavailable',
      reason: 'missing',
      message: 'Codex model cache not found. Open Codex once or run a Codex command that refreshes models, then try /model again.',
    });
  });

  it('returns invalid-cache result for malformed JSON', async () => {
    const codexHome = await createTmpDir();
    await writeFile(join(codexHome, 'models_cache.json'), '{not json', 'utf8');

    await expect(readCodexModelCatalog({ codexHome })).resolves.toEqual({
      kind: 'unavailable',
      reason: 'invalid',
      message: 'Codex model cache is unreadable.',
    });
  });

  it.each([
    ['missing models array', {}],
    ['non-array models field', { models: {} }],
  ])('returns invalid-cache result for invalid cache shape: %s', async (_name, cache) => {
    const codexHome = await createTmpDir();
    await writeCache(codexHome, cache);

    await expect(readCodexModelCatalog({ codexHome })).resolves.toEqual({
      kind: 'unavailable',
      reason: 'invalid',
      message: 'Codex model cache is unreadable.',
    });
  });

  it('skips malformed model entries when valid visible models remain', async () => {
    const codexHome = await createTmpDir();
    await writeCache(codexHome, {
      models: [
        'gpt-5',
        null,
        {
          slug: 1,
          display_name: 'Missing Slug',
          visibility: 'list',
          priority: 1,
        },
        {
          slug: 'gpt-visible',
          display_name: 'GPT Visible',
          description: 'Selectable model',
          default_reasoning_level: 'medium',
          supported_reasoning_levels: [{ effort: 'medium' }],
          visibility: 'list',
          priority: 2,
        },
      ],
    });

    await expect(readCodexModelCatalog({ codexHome })).resolves.toEqual({
      kind: 'available',
      models: [
        {
          slug: 'gpt-visible',
          displayName: 'GPT Visible',
          description: 'Selectable model',
          defaultReasoningLevel: 'medium',
          priority: 2,
          supportedReasoningLevels: ['medium'],
        },
      ],
    });
  });

  it('tolerates missing optional model fields and non-string cache metadata', async () => {
    const codexHome = await createTmpDir();
    await writeCache(codexHome, {
      fetched_at: 123,
      client_version: false,
      models: [
        {
          slug: 'gpt-minimal',
          visibility: 'list',
        },
      ],
    });

    await expect(readCodexModelCatalog({ codexHome })).resolves.toEqual({
      kind: 'available',
      models: [
        {
          slug: 'gpt-minimal',
          displayName: 'gpt-minimal',
          priority: Number.MAX_SAFE_INTEGER,
          supportedReasoningLevels: [],
        },
      ],
    });
  });

  it.each([
    ['missing reasoning array', undefined, []],
    ['non-array reasoning field', 'low', []],
    [
      'mixed valid and invalid reasoning entries',
      [{ effort: 'low' }, { effort: 1 }, null, { effort: 'high' }, 'medium'],
      ['low', 'high'],
    ],
  ])('tolerates %s', async (_name, supportedReasoningLevels, expectedReasoningLevels) => {
    const codexHome = await createTmpDir();
    await writeCache(codexHome, {
      models: [
        {
          slug: 'gpt-reasoning',
          display_name: 1,
          description: false,
          default_reasoning_level: {},
          supported_reasoning_levels: supportedReasoningLevels,
          visibility: 'list',
          priority: Number.POSITIVE_INFINITY,
        },
      ],
    });

    await expect(readCodexModelCatalog({ codexHome })).resolves.toEqual({
      kind: 'available',
      models: [
        {
          slug: 'gpt-reasoning',
          displayName: 'gpt-reasoning',
          priority: Number.MAX_SAFE_INTEGER,
          supportedReasoningLevels: expectedReasoningLevels,
        },
      ],
    });
  });

  it('returns empty-cache result when no visible models exist', async () => {
    const codexHome = await createTmpDir();
    await writeCache(codexHome, {
      models: [
        {
          slug: 'hidden-model',
          display_name: 'Hidden Model',
          description: 'Should not be returned',
          default_reasoning_level: 'low',
          supported_reasoning_levels: [{ effort: 'low', description: 'Fast' }],
          visibility: 'hidden',
          priority: 1,
        },
      ],
    });

    await expect(readCodexModelCatalog({ codexHome })).resolves.toEqual({
      kind: 'unavailable',
      reason: 'empty',
      message: 'Codex model cache contains no selectable models.',
    });
  });
});

async function writeCache(codexHome: string, cache: unknown): Promise<void> {
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, 'models_cache.json'), `${JSON.stringify(cache)}\n`, 'utf8');
}
