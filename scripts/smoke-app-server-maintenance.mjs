import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServerCodexBackend } from '../dist/src/appserver/AppServerCodexBackend.js';
import { AppServerDreamModel } from '../dist/src/memory/AppServerDreamModel.js';

const root = await mkdtemp(join(tmpdir(), 'link-bot-maintenance-smoke-'));
const backend = new AppServerCodexBackend({ command: process.env.CODEX_COMMAND || 'codex' });
try {
  await backend.startTask({ taskId: 'maintenance_smoke', cwd: root, args: [] });
  const patch = await new AppServerDreamModel(backend).consolidate({
    jobId: 'dream:task:maintenance_smoke:smoke', taskId: 'maintenance_smoke',
    capabilities: {
      shell: false, network: false, workspaceRead: false, workspaceWrite: false,
      approval: false, publish: false, mutableMemory: false,
    },
    events: [{
      sequence: 1, eventKey: 'smoke_message_1', eventType: 'user.message', untrustedData: true,
      text: '{"text":"The team chose bounded retries.","userId":"[redacted]"}',
    }],
  });
  if (!Array.isArray(patch.candidates)) throw new Error('Maintenance smoke returned an invalid Dream patch.');
  console.log(`App-server maintenance smoke passed with ${patch.candidates.length} candidate(s).`);
} finally {
  await backend.stopTask('maintenance_smoke').catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
