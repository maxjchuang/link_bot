import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppServerCodexBackend } from '../../src/appserver/AppServerCodexBackend.js';
import { createTmpDir } from '../helpers/tmp.js';

// The fixture retains top-level fields/methods from Codex 0.161.0's generated
// schema; nested payload details are unnecessary for this compatibility check.
async function fakeCli(mutate?: (schema: Record<string, any>) => void): Promise<string> {
  const root = await createTmpDir();
  const fixture = JSON.parse(await readFile(resolve('tests/fixtures/app-server-schema-contract.json'), 'utf8'));
  mutate?.(fixture);
  await writeFile(join(root, 'schema.json'), JSON.stringify(fixture));
  const command = join(root, 'codex');
  await writeFile(command, `#!${process.execPath}\n` + [
    "const fs = require('node:fs'); const path = require('node:path');",
    "if (process.argv.includes('--version')) { console.log('codex-cli 0.999.0'); process.exit(0); }",
    "const directory = process.argv[process.argv.indexOf('--out') + 1];",
    "const schemas = JSON.parse(fs.readFileSync(path.join(__dirname, 'schema.json'), 'utf8'));",
    "for (const [name, schema] of Object.entries(schemas)) {",
    "  const target = path.join(directory, name); fs.mkdirSync(path.dirname(target), { recursive: true });",
    "  fs.writeFileSync(target, JSON.stringify(schema));",
    '}',
  ].join('\n'));
  await chmod(command, 0o755);
  return command;
}

describe('App Server protocol compatibility', () => {
  it('accepts an unfamiliar version with additive protocol changes', async () => {
    const command = await fakeCli((schema) => {
      schema['v2/TurnStartParams.json'].properties.futureOptionalField = {};
      schema['ServerNotification.json'].oneOf.push({ properties: { method: { enum: ['future/event'] } } });
    });
    expect(await new AppServerCodexBackend({ command }).healthCheck()).toEqual({ ok: true });
  });
  it('reports a missing required field instead of rejecting the version number', async () => {
    const command = await fakeCli((schema) => { delete schema['v2/TurnStartParams.json'].properties.cwd; });
    expect(await new AppServerCodexBackend({ command }).healthCheck())
      .toMatchObject({ ok: false, reason: expect.stringContaining('cwd') });
  });
  it('detects the removal of a required server request', async () => {
    const command = await fakeCli((schema) => {
      schema['ServerRequest.json'].oneOf = schema['ServerRequest.json'].oneOf.filter(
        (entry: { properties: { method: { enum: string[] } } }) => !entry.properties.method.enum.includes('item/tool/call'));
    });
    expect(await new AppServerCodexBackend({ command }).healthCheck())
      .toMatchObject({ ok: false, reason: expect.stringContaining('item/tool/call') });
  });
});
