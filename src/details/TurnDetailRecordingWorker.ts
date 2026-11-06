import { parentPort, workerData } from 'node:worker_threads';
import { SqliteTurnDetailStore } from './SqliteTurnDetailStore.js';
import { DetailResourceStore } from './DetailResourceStore.js';
import { TurnDetailRecorder } from './TurnDetailRecorder.js';
import type { DetailCandidate, DetailTurnIdentity } from './TurnDetailTypes.js';

if (!parentPort) throw new Error('detail_worker_only');
const store = new SqliteTurnDetailStore(workerData.path as string);
const files = new DetailResourceStore(`${workerData.path}.turn-details`, {
  allocated: (id, owner) => store.registerResource(id, owner), removed: (id) => store.forgetResource(id),
});
const recorder = new TurnDetailRecorder(store, files);
let failed = false;
parentPort.on('message', ({ sequence, payload }: { sequence: number; payload: string }) => {
  if (failed) return;
  try {
    const start = performance.now();
    const input = JSON.parse(payload) as { identity: DetailTurnIdentity; candidate: DetailCandidate; eventKey: string; receivedAt: string };
    recorder.record(input.identity, input.candidate, input.eventKey, input.receivedAt);
    const turn = store.getTurn(input.identity);
    const outcome = !turn || turn.availability !== 'available' || turn.incomplete ? 'unavailable' : turn.truncated ? 'truncated' : 'ok';
    parentPort!.postMessage({ sequence, ok: true, outcome, elapsedMs: performance.now() - start });
  } catch {
    failed = true;
    parentPort!.postMessage({ sequence, ok: false });
  }
});
