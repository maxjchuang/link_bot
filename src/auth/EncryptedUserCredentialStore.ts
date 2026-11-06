import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export class EncryptedUserCredentialStore {
  private key?: Buffer;
  private keyPromise?: Promise<Buffer>;
  constructor(private readonly root: string) {}

  async read(provider: string, userId: string): Promise<Buffer | undefined> {
    try {
      const value = await readFile(this.path(provider, userId));
      const iv = value.subarray(0, 12);
      const tag = value.subarray(12, 28);
      const decipher = createDecipheriv('aes-256-gcm', await this.loadKey(), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async write(provider: string, userId: string, value: Buffer): Promise<void> {
    const target = this.path(provider, userId);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', await this.loadKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), { mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
      await chmod(target, 0o600);
    } finally { await rm(temporary, { force: true }); }
  }

  async remove(provider: string, userId: string): Promise<void> {
    await rm(this.path(provider, userId), { force: true });
  }

  private path(provider: string, userId: string): string {
    return join(this.root, safe(provider), `${safe(userId)}.enc`);
  }

  private async loadKey(): Promise<Buffer> {
    if (this.key) return this.key;
    if (this.keyPromise) return this.keyPromise;
    this.keyPromise = this.initializeKey();
    try { return await this.keyPromise; } finally { this.keyPromise = undefined; }
  }

  private async initializeKey(): Promise<Buffer> {
    if (this.key) return this.key;
    const keyPath = join(this.root, 'master.key');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try { this.key = await readFile(keyPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.key = randomBytes(32);
      await writeFile(keyPath, this.key, { mode: 0o600, flag: 'wx' }).catch(async (writeError) => {
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
        this.key = await readFile(keyPath);
      });
    }
    if (this.key.length !== 32) throw new Error('Invalid credential-store master key.');
    return this.key;
  }
}

function safe(value: string): string {
  return Buffer.from(value).toString('base64url');
}
