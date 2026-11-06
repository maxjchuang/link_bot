import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);

export async function validateAppServerSchema(command: string, expectedVersion?: string): Promise<string> {
  const { stdout } = await run(command, ['--version'], { timeout: 2_000 });
  const version = stdout.trim().match(/(?:codex-cli\s+)?(\d+\.\d+\.\d+)/)?.[1];
  if (!version) throw new Error('Unable to read Codex CLI version.');
  if (expectedVersion && version !== expectedVersion) throw new Error(`Expected Codex ${expectedVersion}; got ${version}.`);
  const output = mkdtempSync(join(tmpdir(), 'link-bot-app-server-schema-'));
  try {
    await run(command, ['app-server', 'generate-json-schema', '--experimental', '--out', output], { timeout: 20_000, maxBuffer: 1_048_576 });
    assertAppServerSchema(output);
    return version;
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

export function assertAppServerSchema(output: string): void {
  assertRequired('v2/ThreadResumeParams.json', ['threadId']);
  assertRequired('v2/ThreadReadParams.json', ['threadId']);
  assertRequired('v2/TurnStartParams.json', ['input', 'threadId']);
  assertRequired('v2/TurnSteerParams.json', ['expectedTurnId', 'input', 'threadId']);
  assertRequired('v2/TurnInterruptParams.json', ['threadId', 'turnId']);
  assertProperties('v2/ThreadStartParams.json', [
    'cwd', 'model', 'sandbox', 'approvalPolicy', 'baseInstructions', 'config', 'dynamicTools',
    'environments', 'ephemeral', 'runtimeWorkspaceRoots', 'selectedCapabilityRoots',
  ]);
  assertProperties('v2/TurnStartParams.json', [
    'cwd', 'approvalPolicy', 'environments', 'outputSchema', 'runtimeWorkspaceRoots',
  ]);

  const notificationMethods = unionMethods('ServerNotification.json');
  for (const method of [
    'turn/started', 'turn/completed', 'turn/diff/updated', 'item/started', 'item/completed',
    'item/agentMessage/delta', 'item/commandExecution/outputDelta', 'item/fileChange/outputDelta',
    'thread/tokenUsage/updated',
    'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded',
    'item/reasoning/textDelta', 'serverRequest/resolved',
  ]) assertIncludes(notificationMethods, method, 'server notification');
  assertProperties('v2/ReasoningSummaryTextDeltaNotification.json', ['itemId', 'summaryIndex', 'delta']);
  assertProperties('v2/ReasoningSummaryPartAddedNotification.json', ['itemId', 'summaryIndex']);
  assertProperties('v2/ServerRequestResolvedNotification.json', ['threadId', 'requestId']);

  const requestMethods = unionMethods('ServerRequest.json');
  for (const method of [
    'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput',
    'item/tool/call',
  ]) assertIncludes(requestMethods, method, 'server request');

  function schema(relativePath: string) {
    return JSON.parse(readFileSync(join(output, relativePath), 'utf8'));
  }

  function assertRequired(relativePath: string, names: string[]) {
    const required = schema(relativePath).required || [];
    for (const name of names) assertIncludes(required, name, `${relativePath} required field`);
  }

  function assertProperties(relativePath: string, names: string[]) {
    const properties = Object.keys(schema(relativePath).properties || {});
    for (const name of names) assertIncludes(properties, name, `${relativePath} property`);
  }

  function unionMethods(relativePath: string) {
    return (schema(relativePath).oneOf || []).flatMap((entry: { properties?: { method?: { enum?: string[] } } }) => entry.properties?.method?.enum || []);
  }

  function assertIncludes(values: string[], expected: string, context: string) {
    if (!values.includes(expected)) throw new Error(`Missing ${context}: ${expected}`);
  }
}
