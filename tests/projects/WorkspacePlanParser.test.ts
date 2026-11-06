import { describe, expect, it } from 'vitest';
import { buildWorkspaceStages, normalizeRepositoryBaseRef, parseBaselineMigration, parseRepositoryViewIntent, parseWorkspacePlan } from '../../src/projects/WorkspacePlanParser.js';
const projects = [{ id: 'website', name: 'Website', path: '/workspace/website', codexArgs: [] }];
describe('configured workspace planning', () => {
  it('preserves exact refs without applying a product release calendar', () => {
    expect(normalizeRepositoryBaseRef('website', '  release/1.2  ')).toBe('release/1.2');
    expect(normalizeRepositoryBaseRef('website', '1.2')).toBe('1.2');
  });
  it('plans an explicitly named repository and branch', () => {
    expect(parseWorkspacePlan('website 基于 main 开发', projects)?.repositories).toEqual([
      { projectId: 'website', baseRef: 'main', role: 'primary', reason: '用户明确指定仓库基线' },
    ]);
  });
  it('does not infer repositories from a product-specific frontend/backend alias', () => {
    expect(parseWorkspacePlan('前后端 release-1.2', projects)).toBeUndefined();
  });
  it('keeps inspection separate from baseline migration', () => {
    expect(parseRepositoryViewIntent('website 查看 release-1.2 分支', projects)?.mode).toBe('inspect');
    expect(parseBaselineMigration('website 基于 release-1.2 分支开发', projects)).toEqual({ projectId: 'website', targetBaseRef: 'release-1.2' });
  });
  it('builds the same generic stage sequence for any configured repository', () => {
    expect(buildWorkspaceStages([{ projectId: 'website', baseRef: 'main', role: 'primary', reason: 'request' }]).map(s => s.kind))
      .toEqual(['materialize', 'implement', 'validate', 'publish', 'monitor']);
  });
});
