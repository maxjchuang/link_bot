import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { SourceReferenceService, parseLocalSourceTarget, sanitizeUnresolvedSourceLinks } from '../../src/feishu/SourceReferenceService.js';
import { DockerSourceReferenceInspector, SOURCE_INSPECTION_SCRIPT, sourcePermalink, sourceWorkspaceRoot } from '../../src/runtime/DockerSourceReferenceInspector.js';
import { createTmpDir } from '../helpers/tmp.js';

const execFileAsync = promisify(execFile);

describe('SourceReferenceService', () => {
  it('turns a confirmed container path into an immutable browser link', async () => {
    const inspect = vi.fn(async () => ({
      fileName: 'application/chatbot/service/task_model_notification.go', line: 210,
      permalink: 'https://github.com/example/example-api/blob/abc/application/chatbot/service/task_model_notification.go#L210',
    }));
    const service = new SourceReferenceService({ inspect });
    const markdown = '见[通知代码](/workspace/projects/example-api/application/chatbot/service/task_model_notification.go:210)。';
    const result = await service.resolveMarkdown('task_1', markdown);
    expect(result).toContain('[通知代码](https://github.com/example/example-api/blob/abc/');
    expect(result).not.toContain('/workspace/projects');
    expect(inspect).toHaveBeenCalledWith('task_1', '/workspace/projects/example-api/application/chatbot/service/task_model_notification.go', 210);
  });

  it('resolves angle-wrapped local paths emitted by Codex', async () => {
    const inspect = vi.fn(async () => ({ fileName: 'sandbox.go', line: 1187,
      permalink: 'https://github.com/example/example-api/blob/abc/infra/vefaas_sandbox/sandbox.go#L1187',
    }));
    const service = new SourceReferenceService({ inspect });
    const result = await service.resolveMarkdown('task_1',
      '[挂载前缀的构造](</workspace/example-api/infra/vefaas_sandbox/sandbox.go:1187>)');
    expect(result).toBe('[挂载前缀的构造](https://github.com/example/example-api/blob/abc/infra/vefaas_sandbox/sandbox.go#L1187)');
    expect(inspect).toHaveBeenCalledWith('task_1', '/workspace/example-api/infra/vefaas_sandbox/sandbox.go', 1187);
  });

  it('handles titled local links and safely de-links filenames with parentheses', async () => {
    const inspect = vi.fn(async (_taskId: string, path: string) => path.includes('a(b)')
      ? undefined : { fileName: 'a.go', line: 10, permalink: 'https://github.com/example/repo/blob/abc/a.go#L10' });
    const service = new SourceReferenceService({ inspect });
    const result = await service.resolveMarkdown('task_1',
      '[普通](/workspace/repo/a.go:10 "source") 和 [括号](/workspace/repo/a(b).go:10)');
    expect(result).toContain('[普通](https://github.com/example/repo/blob/abc/a.go#L10)');
    expect(result).toContain('括号（`a(b).go:10`，本地路径）');
    expect(result).not.toContain('](/workspace/');
  });

  it('shows at most three bounded local excerpts without making dead links', async () => {
    const service = new SourceReferenceService({ inspect: vi.fn(async (_taskId, path, line) => ({
      fileName: path.split('/').at(-1)!, line,
      snippet: { startLine: line - 5, lines: Array.from({ length: 11 }, (_, index) => `line ${index}`) },
    })) });
    const markdown = [1, 2, 3, 4].map((value) =>
      `[引用${value}](/workspace/projects/repo/file${value}.go:${value + 10})`).join(' · ');
    const result = await service.resolveMarkdown('task_1', markdown);
    expect(result.match(/片段 \d ·/g)).toHaveLength(3);
    expect(result).toContain('6 | line 0');
    expect(result).toContain('引用4（`file4.go:14`，本地路径）');
    expect(result).not.toContain('](/workspace/');
  });

  it('leaves fenced examples untouched and rejects path traversal', async () => {
    const inspect = vi.fn(async () => undefined);
    const service = new SourceReferenceService({ inspect });
    const result = await service.resolveMarkdown('task_1', '```md\n[x](/workspace/a.go:1)\n```\n[y](/workspace/../secret:1)');
    expect(result).toContain('```md\n[x](/workspace/a.go:1)\n```');
    expect(result).toContain('y（本地路径不可访问）');
    expect(inspect).not.toHaveBeenCalled();
    expect(parseLocalSourceTarget('http://workspace/projects/repo/a.go:210'))
      .toEqual({ path: '/workspace/projects/repo/a.go', line: 210 });
  });

  it('preserves inline code and fences with a different delimiter', () => {
    const input = '`http://workspace/repo/a.go:10`\n```md\n~~~\n[x](/workspace/repo/a.go:10)\n```\n[y](/workspace/repo/a.go:10)';
    const result = sanitizeUnresolvedSourceLinks(input);
    expect(result).toContain('`http://workspace/repo/a.go:10`');
    expect(result).toContain('~~~\n[x](/workspace/repo/a.go:10)\n```');
    expect(result).toContain('y（`a.go:10`，本地路径）');
  });

  it('uses a short diff for a local change and reuses the same excerpt for repeated references', async () => {
    const service = new SourceReferenceService({ inspect: vi.fn(async () => ({
      fileName: 'src/a.go', line: 20, diff: '@@ -18,3 +18,4 @@\n-old\n+new',
    })) });
    const result = await service.resolveMarkdown('task_1',
      '[第一处](/workspace/repo/src/a.go:20) 和 [同一处](/workspace/repo/src/a.go:20)');
    expect(result.match(/片段 1 ·/g)).toHaveLength(1);
    expect(result).toContain('同一处（`src/a.go:20`，见片段 1）');
    expect(result).toContain('+new');
  });

  it('bounds source inspection time before final-message delivery', async () => {
    vi.useFakeTimers();
    try {
      const service = new SourceReferenceService({ inspect: async () => new Promise(() => undefined) });
      let result: string | undefined;
      void service.resolveMarkdown('task_1', '[一](/workspace/repo/a.go:10) [二](/workspace/repo/b.go:20)')
        .then((value) => { result = value; });
      await vi.advanceTimersByTimeAsync(10_001);
      expect(result).toContain('一（`a.go:10`，本地路径）');
      expect(result).toContain('二（`b.go:20`，本地路径）');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not leave local links clickable on an oversized malformed line', () => {
    const line = '[x]('.repeat(6_000) + '[源码](/workspace/repo/a.go:10)';
    const result = sanitizeUnresolvedSourceLinks(line);
    expect(result).not.toContain('](/workspace/');
    expect(result).toContain('源码（本地路径不可访问）');
    expect(sanitizeUnresolvedSourceLinks('[x](/workspace/a'.repeat(5_000))).not.toContain('](/workspace/');
  });
});

describe('DockerSourceReferenceInspector', () => {
  it('uses the project checkout for shared sandbox tasks and the task directory for legacy tasks', () => {
    expect(sourceWorkspaceRoot({ id: 'task_1', projectId: 'example-api', runtimeMode: 'user-sandbox', sandboxWorkspaceLayout: 'project' }))
      .toBe('/workspace/example-api');
    expect(sourceWorkspaceRoot({ id: 'task_1', projectId: 'example-api', runtimeMode: 'user-sandbox' }))
      .toBe('/workspace/tasks/task_1');
    expect(sourceWorkspaceRoot({ id: 'task_1', projectId: 'example-api', runtimeMode: 'legacy' }))
      .toBe('/workspace');
  });

  it('uses only confirmed remote revisions and rejects untrusted hosts', async () => {
    const sha = 'a'.repeat(40);
    const runner = { run: vi.fn(async () => ({ stdout: JSON.stringify({
      relativePath: 'application/a.go', remote: 'git@github.com:example/example-api.git',
      sha, remoteConfirmed: true, snippet: { startLine: 5, lines: ['code'] },
    }), stderr: '', exitCode: 0 })) };
    const inspector = new DockerSourceReferenceInspector(runner, () => ({
      containerName: 'task_container', workspaceRoot: '/workspace',
    }));
    expect(await inspector.inspect('task_1', '/workspace/projects/repo/application/a.go', 10))
      .toMatchObject({ permalink: `https://github.com/example/example-api/blob/${sha}/application/a.go#L10` });
    expect(runner.run).toHaveBeenCalledWith(expect.arrayContaining([
      'exec', '--user', '10001:10001', 'task_container',
    ]), expect.objectContaining({ timeoutMs: 8_000 }));
    expect(sourcePermalink('https://evil.example/example/repo', sha, 'a.go', 1)).toBeUndefined();
    expect(sourcePermalink('git@github.com:example/repo.git', sha, '../secret', 1)).toBeUndefined();

    runner.run.mockResolvedValueOnce({ stdout: JSON.stringify({
      relativePath: 'application/a.go', remote: '', sha: '', remoteConfirmed: false,
      snippet: { startLine: 5, lines: ['local change'] },
    }), stderr: '', exitCode: 0 });
    expect(await inspector.inspect('task_1', '/workspace/projects/repo/application/a.go', 10))
      .toMatchObject({ fileName: 'application/a.go', snippet: { lines: ['local change'] } });
  });

  it('extracts the relevant three-context-line diff hunk from a dirty checkout', async () => {
    const root = await createTmpDir();
    const file = join(root, 'source.go');
    const original = Array.from({ length: 24 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
    await execFileAsync('/usr/bin/git', ['init', '-q', root]);
    await writeFile(file, original);
    await execFileAsync('/usr/bin/git', ['-C', root, 'add', 'source.go']);
    await execFileAsync('/usr/bin/git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial']);
    await writeFile(file, original.replace('line 10', 'changed line 10'));

    const { stdout } = await execFileAsync('node', ['-e', SOURCE_INSPECTION_SCRIPT, file, '10', root]);
    const result = JSON.parse(stdout) as { remoteConfirmed: boolean; diff: string; snippet: { lines: string[] } };
    expect(result.remoteConfirmed).toBe(false);
    expect(result.diff).toContain('+changed line 10');
    expect(result.diff.split('\n').length).toBeLessThanOrEqual(10);
    expect(result.snippet.lines).toHaveLength(11);
  });

  it('does not publish a remote permalink when git status fails', async () => {
    const root = await createTmpDir();
    const remote = join(root, 'remote.git');
    const repo = join(root, 'repo');
    await execFileAsync('/usr/bin/git', ['init', '--bare', '-q', remote]);
    await execFileAsync('/usr/bin/git', ['init', '-q', repo]);
    await execFileAsync('/usr/bin/git', ['-C', repo, 'checkout', '-qb', 'main']);
    const file = join(repo, 'source.go');
    await writeFile(file, 'source code\n');
    await execFileAsync('/usr/bin/git', ['-C', repo, 'add', 'source.go']);
    await execFileAsync('/usr/bin/git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial']);
    await execFileAsync('/usr/bin/git', ['-C', repo, 'remote', 'add', 'origin', remote]);
    await execFileAsync('/usr/bin/git', ['-C', repo, 'push', '-q', '-u', 'origin', 'main']);
    await execFileAsync('/usr/bin/git', ['-C', repo, 'remote', 'set-url', 'origin', 'git@github.com:example/repo.git']);
    const sha = (await execFileAsync('/usr/bin/git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
    const probeEnv = { ...process.env, TEST_GIT_SHA: sha };
    const noNetwork = fileURLToPath(new URL('../fixtures/stub-ls-remote.cjs', import.meta.url));
    const clean = await execFileAsync('node', ['-r', noNetwork, '-e', SOURCE_INSPECTION_SCRIPT, file, '1', repo], { env: probeEnv });
    expect(JSON.parse(clean.stdout).remoteConfirmed).toBe(true);
    const stale = await execFileAsync('node', ['-r', noNetwork, '-e', SOURCE_INSPECTION_SCRIPT, file, '1', repo],
      { env: { ...probeEnv, TEST_GIT_SHA: 'b'.repeat(40) } });
    expect(JSON.parse(stale.stdout).remoteConfirmed).toBe(false);
    const preload = fileURLToPath(new URL('../fixtures/fail-git-status.cjs', import.meta.url));
    const { stdout } = await execFileAsync('node', ['-r', preload, '-e', SOURCE_INSPECTION_SCRIPT, file, '1', repo], { env: probeEnv });
    const result = JSON.parse(stdout) as { remoteConfirmed: boolean; snippet: { lines: string[] } };
    expect(result.remoteConfirmed).toBe(false);
    expect(result.snippet.lines).toContain('source code');

    await execFileAsync('/usr/bin/git', ['-C', repo, 'update-index', '--assume-unchanged', 'source.go']);
    await writeFile(file, 'modified source code\n');
    const hiddenChange = await execFileAsync('node', ['-r', noNetwork, '-e', SOURCE_INSPECTION_SCRIPT, file, '1', repo], { env: probeEnv });
    expect(JSON.parse(hiddenChange.stdout).remoteConfirmed).toBe(false);

    await writeFile(file, 'source code\n');
    await execFileAsync('/usr/bin/git', ['-C', repo, 'update-index', '--no-assume-unchanged', 'source.go']);
    await execFileAsync('/usr/bin/git', ['-C', repo, 'remote', 'set-url', 'origin', 'https://internal.example/example/repo.git']);
    const untrusted = await execFileAsync('node', ['-r', noNetwork, '-e', SOURCE_INSPECTION_SCRIPT, file, '1', repo], { env: probeEnv });
    expect(JSON.parse(untrusted.stdout).remoteConfirmed).toBe(false);

    await execFileAsync('/usr/bin/git', ['-C', repo, 'remote', 'set-url', 'origin', 'ssh://git@github.com/example/repo.git']);
    const sshUrl = await execFileAsync('node', ['-r', noNetwork, '-e', SOURCE_INSPECTION_SCRIPT, file, '1', repo], { env: probeEnv });
    expect(JSON.parse(sshUrl.stdout).remoteConfirmed).toBe(true);
  });
});
