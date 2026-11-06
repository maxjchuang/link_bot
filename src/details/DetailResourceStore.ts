import { randomBytes } from 'node:crypto';
import { constants, openSync, closeSync, lstatSync, realpathSync, mkdirSync, fstatSync,
  ftruncateSync, fsyncSync, readSync, writeSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MAX_READ_BYTES = 64 * 1024;
const MAX_APPEND_BYTES = 64 * 1024;

/** IDs only. Authorization and resource ownership must be checked by the detail service. */
export class DetailResourceStore {
  private readonly root: string;
  private readonly canonicalRoot: string;

  constructor(root: string, private readonly journal?: { allocated(id: string, ownerKey?: string): void; removed(id: string): void }) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('Unsafe detail directory');
    this.canonicalRoot = realpathSync(this.root);
  }

  create(ownerKey?: string, allocate?: (id: string) => void): string {
    this.checkRoot();
    const id = randomBytes(16).toString('hex');
    // Commit ownership before file creation; a crash cannot leave an unidentifiable managed allocation.
    this.journal?.allocated(id, ownerKey);
    allocate?.(id);
    let fd: number;
    try { fd = openSync(this.path(id), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch (error) { this.journal?.removed(id); throw error; }
    try { fsyncSync(fd); } finally { closeSync(fd); }
    this.syncRoot();
    return id;
  }

  append(id: string, committedBytes: number, text: string): number {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > MAX_APPEND_BYTES) throw new Error('Detail append exceeds chunk budget');
    const fd = this.open(id, constants.O_RDWR);
    try {
      this.checkBoundary(fd, committedBytes);
      ftruncateSync(fd, committedBytes); // Discard only this resource's uncommitted tail.
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written, committedBytes + written);
      fsyncSync(fd);
      return committedBytes + written;
    } finally { closeSync(fd); }
  }

  read(id: string, committedBytes: number, offset: number, maxBytes: number): string {
    return this.readBytes(id, committedBytes, offset, maxBytes).toString('utf8');
  }

  readBytes(id: string, committedBytes: number, offset: number, maxBytes: number): Buffer {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes)
      || maxBytes < 0 || maxBytes > MAX_READ_BYTES) throw new Error('Invalid detail read boundary');
    const fd = this.open(id, constants.O_RDONLY);
    try {
      this.checkBoundary(fd, committedBytes);
      if (offset > committedBytes) throw new Error('Invalid detail offset');
      const buffer = Buffer.alloc(Math.min(maxBytes, committedBytes - offset));
      let received = 0;
      while (received < buffer.length) {
        const count = readSync(fd, buffer, received, buffer.length - received, offset + received);
        if (!count) throw new Error('Detail resource incomplete');
        received += count;
      }
      return buffer;
    } finally { closeSync(fd); }
  }

  remove(id: string, journalled = true): void {
    const fd = this.open(id, constants.O_RDONLY);
    try { unlinkSync(this.path(id)); this.syncRoot(); } finally { closeSync(fd); }
    if (journalled) this.journal?.removed(id);
  }

  recoverBoundary(id: string, committedBytes: number): void {
    const fd = this.open(id, constants.O_RDWR);
    try { this.checkBoundary(fd, committedBytes); ftruncateSync(fd, committedBytes); fsyncSync(fd); }
    finally { closeSync(fd); }
  }

  size(id: string): number {
    const fd = this.open(id, constants.O_RDONLY);
    try { return fstatSync(fd).size; } finally { closeSync(fd); }
  }

  private open(id: string, flags: number): number {
    this.checkRoot();
    const fd = openSync(this.path(id), flags | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
      closeSync(fd);
      throw new Error('Unsafe detail resource');
    }
    return fd;
  }

  private path(id: string): string {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid detail resource id');
    return join(this.root, id);
  }

  private checkBoundary(fd: number, committedBytes: number): void {
    if (!Number.isSafeInteger(committedBytes) || committedBytes < 0 || committedBytes > fstatSync(fd).size) {
      throw new Error('Invalid committed detail boundary');
    }
  }

  private checkRoot(): void {
    const stat = lstatSync(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
      || realpathSync(this.root) !== this.canonicalRoot) throw new Error('Unsafe detail directory');
  }

  private syncRoot(): void {
    this.checkRoot();
    const fd = openSync(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}
