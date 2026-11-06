import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EncryptedUserCredentialStore } from '../../src/auth/EncryptedUserCredentialStore.js';

describe('EncryptedUserCredentialStore', () => {
  it('uses one master key for concurrent first writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'credential-store-concurrent-'));
    const store = new EncryptedUserCredentialStore(root);
    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      store.write(`provider-${index}`, 'ou_one', Buffer.from(`value-${index}`))));
    await expect(Promise.all(Array.from({ length: 12 }, (_, index) =>
      store.read(`provider-${index}`, 'ou_one')))).resolves.toEqual(
      Array.from({ length: 12 }, (_, index) => Buffer.from(`value-${index}`)),
    );
  });
});
