import { chmod,copyFile,mkdir,stat } from 'node:fs/promises';
import { basename,dirname,join } from 'node:path';

const ALLOWED_AUTH_FILES = new Set(['auth.json']);


export interface CredentialCopyTarget {
  stop(): Promise<void>;
  copyFile(source: string, destination: string): Promise<void>;
}

export interface UserToolCredentialProjector {
  project(userId: string, destination: string): Promise<unknown>;
}

export class TaskCredentialManager {
  constructor(
    private readonly protectedAuthRoot: string,
    private readonly userToolCredentials?: UserToolCredentialProjector,
  ) {}

  async stageMinimumAuth(taskAuthRoot: string): Promise<string[]> {
    const copied: string[] = [];
    await mkdir(taskAuthRoot, { recursive: true, mode: 0o700 });
    for (const fileName of ALLOWED_AUTH_FILES) {
      const source = join(this.protectedAuthRoot, fileName);
      try {
        const sourceStat = await stat(source);
        if (!sourceStat.isFile()) continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new Error(`Unable to validate protected Codex authentication source: ${fileName}`);
      }
      const destination = join(taskAuthRoot, basename(fileName));
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(source, destination);
      await chmod(destination, 0o600);
      copied.push(fileName);
    }
    if (copied.length === 0) throw new Error('Protected Codex authentication source is unavailable.');
    return copied;
  }

  async stageUserToolHome(userId: string, destination: string): Promise<boolean> {
    if (!this.userToolCredentials) return false;
    await mkdir(destination, { recursive: true, mode: 0o700 });
    return Boolean(await this.userToolCredentials.project(userId, destination));
  }

  async replaceFailedTaskAuth(target: CredentialCopyTarget, stagedFiles: string[]): Promise<void> {
    await target.stop();
    for (const source of stagedFiles) {
      if (!ALLOWED_AUTH_FILES.has(basename(source))) throw new Error('Credential file is not in the minimum allowlist.');
      await target.copyFile(source, `/home/codex/.codex/${basename(source)}`);
    }
  }
}
