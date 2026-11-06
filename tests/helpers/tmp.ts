import { mkdtemp, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function createTmpDir(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'link-bot-')));
}
