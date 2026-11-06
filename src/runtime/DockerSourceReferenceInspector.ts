import type { SourceInspection, SourceReferenceInspector } from '../feishu/SourceReferenceService.js';
import type { DockerCommandRunner } from './DockerRuntime.js';

export interface SourceContainerTarget {
  containerName: string;
  workspaceRoot: string;
}

export function sourceWorkspaceRoot(task: {
  id: string;
  projectId?: string;
  runtimeMode?: string;
  sandboxWorkspaceLayout?: string;
}): string | undefined {
  if (task.runtimeMode !== 'user-sandbox') return '/workspace';
  if (task.sandboxWorkspaceLayout === 'project') {
    if (!task.projectId) return undefined;
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(task.projectId)
      && !['tasks', '.linkbot'].includes(task.projectId) && !task.projectId.includes('..')
      ? `/workspace/${task.projectId}` : undefined;
  }
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(task.id)) return undefined;
  return `/workspace/tasks/${task.id.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 120)}`;
}

export class DockerSourceReferenceInspector implements SourceReferenceInspector {
  constructor(
    private readonly runner: DockerCommandRunner,
    private readonly targetForTask: (taskId: string) => SourceContainerTarget | undefined,
  ) {}

  async inspect(taskId: string, path: string, line: number): Promise<SourceInspection | undefined> {
    const target = this.targetForTask(taskId);
    if (!target || !/^\/workspace\/[A-Za-z0-9._/-]+$/.test(path) || path.includes('/../')
      || !Number.isSafeInteger(line) || line < 1 || line > 1_000_000) return undefined;
    const result = await this.runner.run([
      'exec', '--user', '10001:10001', target.containerName,
      'node', '-e', SOURCE_INSPECTION_SCRIPT, path, String(line), target.workspaceRoot,
    ], { timeoutMs: 8_000, allowFailure: true }).catch(() => undefined);
    if (!result || result.exitCode !== 0) return undefined;
    try {
      const raw = JSON.parse(result.stdout) as Record<string, unknown>;
      if (typeof raw.relativePath !== 'string') return undefined;
      const fileName = raw.relativePath.slice(0, 300);
      const permalink = raw.remoteConfirmed === true && typeof raw.remote === 'string'
        && typeof raw.sha === 'string' && /^[a-f0-9]{40,64}$/i.test(raw.sha)
        ? sourcePermalink(raw.remote, raw.sha, raw.relativePath, line)
        : undefined;
      const snippet = isSnippet(raw.snippet) ? raw.snippet : undefined;
      return {
        fileName, line,
        ...(permalink ? { permalink } : {}),
        ...(!permalink && snippet ? { snippet } : {}),
        ...(!permalink && typeof raw.diff === 'string' && raw.diff ? { diff: raw.diff.slice(0, 6_000) } : {}),
      };
    } catch {
      return undefined;
    }
  }
}

function isSnippet(value: unknown): value is { startLine: number; lines: string[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snippet = value as { startLine?: unknown; lines?: unknown };
  return typeof snippet.startLine === 'number' && Number.isSafeInteger(snippet.startLine)
    && Array.isArray(snippet.lines) && snippet.lines.length <= 30
    && snippet.lines.every((line) => typeof line === 'string');
}

export function sourcePermalink(remote: string, sha: string, relativePath: string, line: number): string | undefined {
  if (!/^[a-f0-9]{40,64}$/i.test(sha) || !Number.isSafeInteger(line) || line < 1) return undefined;
  let host: string;
  let repo: string;
  const ssh = /^(?:git@|ssh:\/\/git@)(github\.com)[:/]([^?#]+)$/i.exec(remote);
  if (ssh) {
    host = ssh[1]!.toLowerCase();
    repo = ssh[2]!;
  } else {
    try {
      const parsed = new URL(remote);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return undefined;
      host = parsed.hostname.toLowerCase();
      repo = parsed.pathname.replace(/^\//, '');
    } catch { return undefined; }
  }
  if (!['github.com'].includes(host)) return undefined;
  repo = repo.replace(/\.git$/i, '');
  const segments = repo.split('/');
  const fileSegments = relativePath.split('/');
  if (segments.length < 2 || [...segments, ...fileSegments].some((part) => !/^[A-Za-z0-9._-]+$/.test(part) || part === '..')) return undefined;
  return `https://${host}/${segments.map(encodeURIComponent).join('/')}/blob/${sha}/${fileSegments.map(encodeURIComponent).join('/')}#L${line}`;
}

export const SOURCE_INSPECTION_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const requested = process.argv[1];
const line = Number(process.argv[2]);
const allowed = fs.realpathSync(process.argv[3]);
const resolved = fs.realpathSync(requested);
if (resolved !== requested || !resolved.startsWith(allowed + '/') || !fs.statSync(resolved).isFile()) process.exit(2);
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
const key = ['/home/codex/.link-bot/native-git/id_ed25519', '/home/codex/.codex/native-git/id_ed25519']
  .find((candidate) => fs.existsSync(candidate));
if (key) env.GIT_SSH_COMMAND = 'ssh -i ' + key + ' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new';
function git(cwd, args, timeout = 1200) {
  try { return execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', timeout, maxBuffer: 100000, env, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return undefined; }
}
function trustedRemote(value) {
  if (!value) return false;
  const match = /^(?:git@(?:github\.com):|ssh:\/\/git@(?:github\.com)\/|https:\/\/(?:github\.com)\/)([A-Za-z0-9._/-]+?)(?:\.git)?$/i.exec(value);
  return Boolean(match && match[1].split('/').length >= 2
    && match[1].split('/').every((part) => part && part !== '.' && part !== '..'));
}
function probeRemote(url, branch) {
  const cleanEnv = { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_CONFIG_PARAMETERS: '',
    XDG_CONFIG_HOME: '/dev/null' };
  try {
    return execFileSync('/usr/bin/git', ['-C', '/', 'ls-remote', url, 'refs/heads/' + branch], {
      encoding: 'utf8', timeout: 2500, maxBuffer: 100000, env: cleanEnv, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split(/\s/)[0];
  } catch { return undefined; }
}
const root = git(path.dirname(resolved), ['rev-parse', '--show-toplevel']);
if (!root || (root !== allowed && !root.startsWith(allowed + '/'))) process.exit(3);
const relativePath = path.relative(root, resolved);
if (!relativePath || relativePath.startsWith('..') || !git(root, ['ls-files', '--error-unmatch', '--', relativePath])) process.exit(4);
const sha = git(root, ['rev-parse', 'HEAD']);
const remote = git(root, ['config', '--get', 'remote.origin.url']);
const status = git(root, ['status', '--porcelain=v1', '--', relativePath]);
const headBlob = git(root, ['rev-parse', 'HEAD:' + relativePath]);
const workingBlob = git(root, ['hash-object', '--', resolved]);
const dirty = status === undefined || status !== '' || !headBlob || !workingBlob || headBlob !== workingBlob;
let remoteConfirmed = false;
const effectiveRemote = git(root, ['remote', 'get-url', 'origin']);
if (!dirty && trustedRemote(remote) && effectiveRemote === remote && /^[a-f0-9]{40,64}$/i.test(sha)) {
  const refs = (git(root, ['for-each-ref', '--points-at', 'HEAD', '--format=%(refname:short)', 'refs/remotes/origin']) || '').split('\n');
  const branch = refs.find((ref) => ref.startsWith('origin/') && ref !== 'origin/HEAD')?.slice(7);
  if (branch) remoteConfirmed = probeRemote(remote, branch) === sha;
}
let snippet;
let diff;
const metadata = fs.statSync(resolved);
if (metadata.size <= 512000) {
  const content = fs.readFileSync(resolved, 'utf8');
  if (!content.includes('\0')) {
    const lines = content.split(/\r?\n/);
    if (line >= 1 && line <= lines.length) {
      const startLine = Math.max(1, line - 5);
      snippet = { startLine, lines: lines.slice(startLine - 1, Math.min(lines.length, line + 5)).map((value) => value.slice(0, 250)) };
    }
  }
}
if (dirty) {
  const patch = git(root, ['diff', 'HEAD', '--no-ext-diff', '--unified=3', '--', relativePath]) || '';
  const hunks = patch.match(/^@@[^\n]*\n(?:^(?!@@)[^\n]*\n?)*/gm) || [];
  diff = hunks.find((hunk) => { const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(hunk); return m && line >= Number(m[1]) && line < Number(m[1]) + Number(m[2] || 1); });
}
process.stdout.write(JSON.stringify({ relativePath, remote, sha, remoteConfirmed, snippet, diff: diff?.slice(0, 6000) }));
`;
