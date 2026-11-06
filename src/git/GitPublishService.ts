import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import type { SqliteStateStore } from '../state/SqliteStateStore.js';

export type PublishRequestStatus = 'pending' | 'rejected' | 'expired' | 'publishing' | 'published' | 'unknown' | 'failed';

export interface PublishRequestRecord {
  id: string;
  idempotencyKey: string;
  taskId: string;
  ownerUserId: string;
  repositoryPath: string;
  remote: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  branchName: string;
  status: PublishRequestStatus;
  validation: { changedFiles: number; changedBytes: number; checks: string[] };
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  mergeRequestId?: string;
  failure?: string;
  repositoryId?: string;
  publishMode?: 'new_merge_request' | 'existing_branch';
  forceUpdate?: boolean;
}

export interface MergeRequestBroker {
  findByIdempotencyKey(
    key: string,
    repositoryPath: string,
    hints?: { branchName?: string; baseRef?: string },
  ): Promise<{ id: string } | undefined>;
  createOrUpdate(input: {
    idempotencyKey: string;
    repositoryPath: string;
    branchName: string;
    baseRef: string;
    title: string;
    body: string;
  }): Promise<{ id: string }>;
}

export interface GitCommandRunner {
  run(cwd: string, args: string[]): Promise<string>;
}

export class GitPublishService {
  private readonly requests: SqlitePublishRequestStore;

  constructor(
    store: SqliteStateStore,
    private readonly mergeRequests: MergeRequestBroker,
    private readonly git: GitCommandRunner = new ExecGitCommandRunner(),
    private readonly clock: () => Date = () => new Date(),
    private readonly maxDiffBytes = 1_000_000,
  ) {
    this.requests = new SqlitePublishRequestStore(store, clock);
  }

  async request(input: {
    taskId: string;
    ownerUserId: string;
    repositoryPath: string;
    remote: string;
    baseRef: string;
    baseRevision?: string;
    authorName: string;
    authorEmail: string;
    repositoryId?: string;
    branchName?: string;
    expectedHeadSha?: string;
    ttlMs?: number;
  }): Promise<PublishRequestRecord> {
    const branchName = input.branchName ?? controlledBranch(input.ownerUserId, input.taskId);
    const actualBranch = await this.git.run(input.repositoryPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (actualBranch !== branchName) throw new Error(`Task branch must be ${branchName}.`);
    const baseSha = await this.git.run(input.repositoryPath, ['rev-parse', `${input.baseRevision ?? input.baseRef}^{commit}`]);
    const headSha = await this.git.run(input.repositoryPath, ['rev-parse', 'HEAD^{commit}']);
    if (input.expectedHeadSha && headSha !== input.expectedHeadSha) throw new Error('Exported repository HEAD does not match the requested Head.');
    if (baseSha === headSha) throw new Error('Task has no commits to publish.');
    await this.requireAncestor(input.repositoryPath, baseSha, headSha,
      `The task commit is not based on the latest remote target ${input.baseRef}@${baseSha.slice(0, 12)}. `
      + 'The Manager fetched origin immediately before validation; local branch refs are not authoritative. '
      + 'Migrate or rebase the task workspace onto this exact remote commit before publishing.');
    await this.validateCommitIdentity(input.repositoryPath, input.authorName, input.authorEmail);
    const validation = await this.validateDiff(input.repositoryPath, baseSha, headSha);
    const idempotencyKey = createHash('sha256').update(JSON.stringify([
      input.taskId, input.repositoryId ?? input.repositoryPath, baseSha, headSha,
    ])).digest('hex');
    const now = this.clock();
    return this.requests.create({
      id: `pub_${idempotencyKey.slice(0, 24)}`, idempotencyKey,
      taskId: input.taskId, ownerUserId: input.ownerUserId, repositoryPath: input.repositoryPath,
      remote: input.remote, baseRef: input.baseRef, baseSha, headSha, branchName,
      ...(input.repositoryId ? { repositoryId: input.repositoryId } : {}),
      publishMode: 'new_merge_request',
      status: 'pending', validation, createdAt: now.toISOString(), updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (input.ttlMs ?? 300_000)).toISOString(),
    });
  }

  async requestExistingBranch(input: {
    taskId: string; ownerUserId: string; repositoryPath: string; remote: string; branchName: string;
    expectedHeadSha: string; authorName: string; authorEmail: string; repositoryId?: string; ttlMs?: number;
  }): Promise<PublishRequestRecord> {
    const actualHead = await this.git.run(input.repositoryPath, ['rev-parse', 'HEAD^{commit}']);
    if (actualHead !== input.expectedHeadSha) throw new Error('Exported repository HEAD does not match the requested Head.');
    const baseSha = (await this.git.run(input.repositoryPath, ['ls-remote', input.remote, `refs/heads/${input.branchName}`])).split(/\s+/)[0];
    if (!baseSha) throw new Error(`Remote branch does not exist: ${input.branchName}`);
    if (baseSha === actualHead) throw new Error('Remote branch already contains the requested Head.');
    const forceUpdate = !await this.isAncestor(input.repositoryPath, baseSha, actualHead);
    await this.validateCommitIdentity(input.repositoryPath, input.authorName, input.authorEmail);
    const parents = (await this.git.run(input.repositoryPath, ['show', '-s', '--format=%P', actualHead])).split(/\s+/).filter(Boolean);
    const validation = parents.length > 1
      ? await this.validateMergeResolution(input.repositoryPath, actualHead)
      : await this.validateDiff(input.repositoryPath, baseSha, actualHead);
    const idempotencyKey = createHash('sha256').update(JSON.stringify([
      'existing_branch', input.taskId, input.repositoryId ?? input.repositoryPath, input.branchName, baseSha, actualHead,
    ])).digest('hex');
    const now = this.clock();
    return this.requests.create({
      id: `pub_${idempotencyKey.slice(0, 24)}`, idempotencyKey, taskId: input.taskId, ownerUserId: input.ownerUserId,
      repositoryPath: input.repositoryPath, remote: input.remote, baseRef: input.branchName, baseSha, headSha: actualHead,
      branchName: input.branchName, publishMode: 'existing_branch', forceUpdate,
      ...(input.repositoryId ? { repositoryId: input.repositoryId } : {}),
      status: 'pending', validation, createdAt: now.toISOString(), updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (input.ttlMs ?? 300_000)).toISOString(),
    });
  }

  private async requireAncestor(repositoryPath: string, baseSha: string, headSha: string, message: string): Promise<void> {
    try {
      await this.git.run(repositoryPath, ['merge-base', '--is-ancestor', baseSha, headSha]);
    } catch {
      throw new Error(message);
    }
  }

  private async isAncestor(repositoryPath: string, baseSha: string, headSha: string): Promise<boolean> {
    try { await this.git.run(repositoryPath, ['merge-base', '--is-ancestor', baseSha, headSha]); return true; }
    catch { return false; }
  }

  private async validateCommitIdentity(repositoryPath: string, name: string, email: string): Promise<void> {
    const [authorName, authorEmail, committerName, committerEmail] =
      (await this.git.run(repositoryPath, ['log', '-1', '--format=%an%x00%ae%x00%cn%x00%ce'])).split('\0');
    if (authorName !== name || authorEmail !== email || committerName !== name || committerEmail !== email) {
      throw new Error('Task commit author and committer must match the configured user identity.');
    }
    if ([authorName, authorEmail, committerName, committerEmail].some((value) => /(?:^(?:ou_|on_|cli_)|@link-bot\.local$)/i.test(value ?? ''))) {
      throw new Error('Task commit identity contains an internal platform identifier.');
    }
  }

  async decide(requestId: string, userId: string, decision: 'confirm' | 'reject'): Promise<PublishRequestRecord> {
    const existing = this.requests.get(requestId);
    if (existing && decision === 'confirm' && (existing.status === 'unknown' || existing.status === 'publishing')) {
      return this.reconcile(requestId, userId);
    }
    const request = this.requests.decide(requestId, userId, decision);
    if (request.status !== 'publishing') return request;
    return this.publish(request);
  }

  async reconcile(requestId: string, userId: string): Promise<PublishRequestRecord> {
    const request = this.requests.get(requestId);
    if (!request) throw new Error(`Publish request not found: ${requestId}`);
    if (request.ownerUserId !== userId) throw new Error('Publish request owner does not match the acting user.');
    if (request.status === 'published') return request;
    if (request.status !== 'unknown' && request.status !== 'publishing') throw new Error(`Publish request is not reconcilable: ${request.status}`);
    return this.publish(request);
  }

  private async publish(request: PublishRequestRecord): Promise<PublishRequestRecord> {
    try {
      const currentHead = await this.git.run(request.repositoryPath, ['rev-parse', 'HEAD^{commit}']);
      if (currentHead !== request.headSha) throw new Error('Task HEAD changed after publish confirmation.');
      const remoteHead = await this.remoteHead(request).catch(() => undefined);
      if (request.publishMode === 'existing_branch' && remoteHead !== request.baseSha && remoteHead !== request.headSha) {
        throw new Error('Remote branch changed after publish validation.');
      }
      if (remoteHead !== request.headSha) {
        await this.git.run(request.repositoryPath, [
          'push', ...(request.forceUpdate ? ['--force'] : []), request.remote,
          `${request.headSha}:refs/heads/${request.branchName}`,
        ]);
      }
      if (request.publishMode === 'existing_branch') {
        return this.requests.update({ ...request, status: 'published', updatedAt: this.clock().toISOString() });
      }
      const prior = await this.mergeRequests.findByIdempotencyKey(request.idempotencyKey, request.repositoryPath, {
        branchName: request.branchName, baseRef: request.baseRef,
      });
      const mergeRequest = prior ?? await this.mergeRequests.createOrUpdate({
        idempotencyKey: request.idempotencyKey,
        repositoryPath: request.repositoryPath,
        branchName: request.branchName,
        baseRef: request.baseRef,
        title: `link_bot task ${request.taskId}`,
        body: [
          `Task: ${request.taskId}`, `Requesting user: ${request.ownerUserId}`,
          ...(request.repositoryId ? [`Repository: ${request.repositoryId}`] : []),
          `Base: ${request.baseSha}`, `Head: ${request.headSha}`,
          `Validation: ${request.validation.checks.join(', ')}`,
        ].join('\n'),
      });
      return this.requests.update({ ...request, status: 'published', mergeRequestId: mergeRequest.id, updatedAt: this.clock().toISOString() });
    } catch (error) {
      const remoteHead = await this.remoteHead(request).catch(() => undefined);
      const status: PublishRequestStatus = remoteHead === request.headSha ? 'unknown' : 'failed';
      return this.requests.update({
        ...request, status, updatedAt: this.clock().toISOString(),
        failure: sanitizeFailure(error),
      });
    }
  }

  private async remoteHead(request: PublishRequestRecord): Promise<string | undefined> {
    const output = await this.git.run(request.repositoryPath, ['ls-remote', request.remote, `refs/heads/${request.branchName}`]);
    return output.split(/\s+/)[0] || undefined;
  }

  private async validateDiff(repositoryPath: string, baseSha: string, headSha: string): Promise<PublishRequestRecord['validation']> {
    const names = (await this.git.run(repositoryPath, ['diff', '--name-only', `${baseSha}...${headSha}`])).split('\n').filter(Boolean);
    const forbidden = names.find(isForbiddenPublishPath);
    if (forbidden) throw new Error(`Publish contains a forbidden path: ${forbidden}`);
    const diff = await this.git.run(repositoryPath, ['diff', '--no-ext-diff', '--unified=0', `${baseSha}...${headSha}`]);
    const changedBytes = Buffer.byteLength(diff);
    if (changedBytes > this.maxDiffBytes) throw new Error(`Publish diff exceeds ${this.maxDiffBytes} bytes.`);
    const possibleSecret = locatePossibleSecret(diff);
    if (possibleSecret) throw new Error(renderPossibleSecretFailure('Publish diff', possibleSecret));
    return { changedFiles: names.length, changedBytes, checks: ['ancestry', 'branch', 'author', 'paths', 'secrets', 'size'] };
  }

  private async validateMergeResolution(repositoryPath: string, headSha: string): Promise<PublishRequestRecord['validation']> {
    const names = (await this.git.run(repositoryPath, ['diff-tree', '--cc', '--no-commit-id', '--name-only', '-r', headSha])).split('\n').filter(Boolean);
    const forbidden = names.find(isForbiddenPublishPath);
    if (forbidden) throw new Error(`Merge resolution contains a forbidden path: ${forbidden}`);
    const diff = await this.git.run(repositoryPath, ['show', '--cc', '--format=', '--unified=0', headSha]);
    const changedBytes = Buffer.byteLength(diff);
    if (changedBytes > this.maxDiffBytes) throw new Error(`Merge resolution diff exceeds ${this.maxDiffBytes} bytes.`);
    const possibleSecret = locatePossibleSecret(diff);
    if (possibleSecret) throw new Error(renderPossibleSecretFailure('Merge resolution', possibleSecret));
    return { changedFiles: names.length, changedBytes, checks: ['ancestry', 'branch', 'author', 'merge-resolution-paths', 'merge-resolution-secrets', 'size'] };
  }
}

function isForbiddenPublishPath(path: string): boolean {
  const name = path.split('/').at(-1) ?? path;
  // Conventional environment templates are source-controlled documentation,
  // not runtime credentials. Their added contents still pass the secret-value
  // scan below, so a template containing a real credential remains blocked.
  if (/^\.env(?:\.[A-Za-z0-9_-]+)*\.(?:example|sample|template)$/i.test(name)) return false;
  return /(^|\/)(\.env(?:\.|$)|auth\.json$|\.ssh(?:\/|$))|\.(pem|key)$/i.test(path);
}

interface PossibleSecretLocation { path: string; line: number; keyword: string }

function locatePossibleSecret(diff: string): PossibleSecretLocation | undefined {
  const pattern = /(?:api[_-]?key|token|secret|password)\s*[:=]\s*["'][^"']{12,}["']/i;
  let path = 'unknown';
  let newLine = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) { path = line.slice(6); continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) { newLine = Number(hunk[1]); continue; }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      const match = pattern.exec(line.slice(1));
      if (match) return { path, line: newLine, keyword: /^(?:api[_-]?key|token|secret|password)/i.exec(match[0])?.[0] ?? 'credential' };
      newLine += 1;
    } else if (!line.startsWith('-')) newLine += 1;
  }
  return undefined;
}

function renderPossibleSecretFailure(scope: string, match: PossibleSecretLocation): string {
  return `NON_RETRYABLE[POSSIBLE_SECRET]: ${scope} matched ${match.keyword} at ${match.path}:${match.line}. `
    + 'Do not retry publishing the unchanged Head. Inspect and remove/redact the value, or ask the requester to confirm a false positive for this exact Head.';
}

export class GitHubMergeRequestBroker implements MergeRequestBroker {
  constructor(private readonly runner: GitHubCommandRunner = new ExecGitHubCommandRunner()) {}

  async findByIdempotencyKey(key: string, repositoryPath: string): Promise<{ id: string } | undefined> {
    const marker = idempotencyMarker(key);
    const output = await this.runner.run(repositoryPath, [
      'pr', 'list', '--state', 'all', '--search', `"${marker}" in:body`, '--json', 'number', '--limit', '1',
    ]);
    const rows = JSON.parse(output) as Array<{ number?: number }>;
    return typeof rows[0]?.number === 'number' ? { id: String(rows[0].number) } : undefined;
  }

  async createOrUpdate(input: {
    idempotencyKey: string; repositoryPath: string; branchName: string; baseRef: string; title: string; body: string;
  }): Promise<{ id: string }> {
    const prior = await this.findByIdempotencyKey(input.idempotencyKey, input.repositoryPath);
    if (prior) return prior;
    const output = await this.runner.run(input.repositoryPath, [
      'pr', 'create', '--head', input.branchName, '--base', input.baseRef, '--title', input.title,
      '--body', `${input.body}\n\n${idempotencyMarker(input.idempotencyKey)}`,
    ]);
    const match = output.match(/\/pull\/(\d+)(?:\s|$)/);
    if (!match) throw new Error('GitHub PR creation did not return a pull request URL.');
    return { id: match[1]! };
  }
}

export interface GitHubCommandRunner {
  run(cwd: string, args: string[]): Promise<string>;
}

class ExecGitHubCommandRunner implements GitHubCommandRunner {
  run(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('gh', args, { cwd, maxBuffer: 2_000_000, timeout: 60_000, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
        if (error) return reject(new Error(`GitHub CLI ${args[0]} failed${commandFailureDetail(stderr || error.message)}`));
        resolve(stdout.trim());
      });
    });
  }
}

export class RemoteAwareMergeRequestBroker implements MergeRequestBroker {
  constructor(
    private readonly github: MergeRequestBroker = new GitHubMergeRequestBroker(),
    private readonly git: GitCommandRunner = new ExecGitCommandRunner(),
  ) {}

  async findByIdempotencyKey(
    key: string, repositoryPath: string, hints?: { branchName?: string; baseRef?: string },
  ): Promise<{ id: string } | undefined> {
    return (await this.provider(repositoryPath)).findByIdempotencyKey(key, repositoryPath, hints);
  }

  async createOrUpdate(input: {
    idempotencyKey: string; repositoryPath: string; branchName: string; baseRef: string; title: string; body: string;
  }): Promise<{ id: string }> {
    return (await this.provider(input.repositoryPath)).createOrUpdate(input);
  }

  private async provider(repositoryPath: string): Promise<MergeRequestBroker> {
    const remote = await this.git.run(repositoryPath, ['remote', 'get-url', 'origin']);
    const host = gitRemoteHost(remote);
    if (host === 'github.com') return this.github;
    throw new Error(`Unsupported merge request provider for Git remote host: ${host || 'unknown'}.`);
  }
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = fieldValue(value, key);
  return field && typeof field === 'object' && !Array.isArray(field) ? field as Record<string, unknown> : {};
}

function objectArray(value: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const field = fieldValue(value, key);
  return Array.isArray(field) ? field.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') : [];
}

function scalarField(value: Record<string, unknown>, ...keys: string[]): string | number | undefined {
  for (const key of keys) {
    const field = fieldValue(value, key);
    if (typeof field === 'string' || typeof field === 'number') return field;
  }
  return undefined;
}

function fieldValue(value: Record<string, unknown>, key: string): unknown {
  const normalized = key.replace(/_/g, '').toLowerCase();
  const actual = Object.keys(value).find((candidate) => candidate.replace(/_/g, '').toLowerCase() === normalized);
  return actual === undefined ? undefined : value[actual];
}

function stringField(value: Record<string, unknown>, ...keys: string[]): string {
  return String(scalarField(value, ...keys) ?? '');
}

function gitRemoteHost(remote: string): string {
  const scp = remote.match(/^[^@]+@([^:]+):/);
  if (scp) return scp[1]!.toLowerCase();
  try { return new URL(remote).hostname.toLowerCase(); } catch { return ''; }
}

function commandFailureDetail(value: string): string {
  const detail = sanitizeGitOutput(value);
  return detail ? `: ${detail}` : '.';
}

function idempotencyMarker(key: string): string {
  return `link-bot-idempotency:${key}`;
}

class SqlitePublishRequestStore {
  constructor(private readonly store: SqliteStateStore, private readonly clock: () => Date) {}

  create(request: PublishRequestRecord): PublishRequestRecord {
    return this.store.db.transaction(() => {
      const existing = this.store.db.prepare('SELECT payload FROM publish_requests WHERE idempotency_key=?')
        .get(request.idempotencyKey) as { payload: string } | undefined;
      if (existing) {
        const prior = JSON.parse(existing.payload) as PublishRequestRecord;
        const now = this.clock().toISOString();
        const retryableTerminal = prior.status === 'expired' || prior.status === 'rejected' || prior.status === 'failed';
        const pendingExpired = prior.status === 'pending' && prior.expiresAt <= now;
        if (!retryableTerminal && !pendingExpired) return prior;

        // The Git operation remains idempotent, but an explicit retry after the approval window
        // needs a fresh window and a fresh card delivery generation.
        const renewed = { ...request, id: prior.id };
        this.store.db.prepare(`
          UPDATE publish_requests
          SET owner_user_id=@ownerUserId, status=@status, payload=@payload, updated_at=@updatedAt
          WHERE id=@id
        `).run({ ...renewed, payload: JSON.stringify(renewed) });
        return renewed;
      }
      this.store.db.prepare(`
        INSERT INTO publish_requests(id, task_id, owner_user_id, status, idempotency_key, payload, created_at, updated_at)
        VALUES (@id, @taskId, @ownerUserId, @status, @idempotencyKey, @payload, @createdAt, @updatedAt)
      `).run({ ...request, payload: JSON.stringify(request) });
      return request;
    })();
  }

  get(id: string): PublishRequestRecord | undefined {
    const row = this.store.db.prepare('SELECT payload FROM publish_requests WHERE id=?').get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as PublishRequestRecord : undefined;
  }

  decide(id: string, userId: string, decision: 'confirm' | 'reject'): PublishRequestRecord {
    return this.store.db.transaction(() => {
      const request = this.get(id);
      if (!request) throw new Error(`Publish request not found: ${id}`);
      if (request.ownerUserId !== userId) throw new Error('Publish request owner does not match the acting user.');
      if (request.status === 'published' || request.status === 'rejected') return request;
      if (request.status !== 'pending') throw new Error(`Publish request is not pending: ${request.status}`);
      const now = this.clock().toISOString();
      if (request.expiresAt <= now) return this.update({ ...request, status: 'expired', updatedAt: now });
      return this.update({ ...request, status: decision === 'confirm' ? 'publishing' : 'rejected', updatedAt: now });
    })();
  }

  update(request: PublishRequestRecord): PublishRequestRecord {
    this.store.db.prepare('UPDATE publish_requests SET status=?, payload=?, updated_at=? WHERE id=?')
      .run(request.status, JSON.stringify(request), request.updatedAt, request.id);
    return request;
  }
}

export class ExecGitCommandRunner implements GitCommandRunner {
  run(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      execFile('git', args, { cwd, maxBuffer: 2_000_000, timeout: 60_000, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
        if (error) {
          const elapsedMs = Date.now() - startedAt;
          const detail = sanitizeGitOutput(stderr || error.message);
          return reject(new Error(
            `Git ${args[0]} ${error.killed ? `timed out after ${elapsedMs}ms` : 'failed'}`
            + `${detail ? `: ${detail}` : '.'}`,
          ));
        }
        resolve(stdout.trim());
      });
    });
  }
}

function sanitizeGitOutput(value: string): string {
  return value
    .replace(/(?:https?:\/\/)[^\s/@]+@/gi, (match) => `${match.slice(0, match.indexOf('//') + 2)}[redacted]@`)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, 1_000);
}

export function controlledBranch(userId: string, taskId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(userId) || !/^[A-Za-z0-9._-]+$/.test(taskId)) {
    throw new Error('User and task ids must be safe Git branch components.');
  }
  return `codex/${userId}/${taskId}`;
}

function sanitizeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:https?:\/\/)[^\s@]+@/g, 'https://[redacted]@').slice(0, 500);
}
