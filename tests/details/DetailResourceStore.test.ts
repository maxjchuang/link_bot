import { lstatSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DetailResourceStore } from '../../src/details/DetailResourceStore.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('managed detail resources', () => {
  it('reads only committed bytes and overwrites an uncommitted tail on recovery', async () => {
    const root = join(await createTmpDir(), 'details');
    const files = new DetailResourceStore(root);
    const id = files.create();
    expect(files.append(id, 0, 'first')).toBe(5);
    files.append(id, 5, 'uncommitted');
    expect(files.read(id, 5, 0, 20)).toBe('first');
    expect(files.append(id, 5, 'next')).toBe(9);
    expect(files.read(id, 9, 0, 20)).toBe('firstnext');
    expect(lstatSync(root).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(root, id)).mode & 0o777).toBe(0o600);
  });

  it('rejects arbitrary paths, symlinks, invalid boundaries and oversized reads', async () => {
    const root = join(await createTmpDir(), 'details');
    const files = new DetailResourceStore(root);
    const id = files.create();
    files.append(id, 0, 'text');
    expect(() => files.read('../auth.json', 4, 0, 4)).toThrow();
    expect(() => files.read(id, 100, 0, 4)).toThrow();
    expect(() => files.read(id, 4, -1, 4)).toThrow();
    expect(() => files.read(id, 4, 0, 1024 * 1024)).toThrow();
    const badId = 'a'.repeat(32);
    symlinkSync(join(root, id), join(root, badId));
    expect(() => files.read(badId, 4, 0, 4)).toThrow();
    const linkedRoot = join(await createTmpDir(), 'linked');
    symlinkSync(root, linkedRoot);
    expect(() => new DetailResourceStore(linkedRoot)).toThrow();
  });
});
