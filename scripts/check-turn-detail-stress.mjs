import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSync } from 'node:fs';
import { createTurnDetailRuntime } from '../dist/src/details/TurnDetailRuntime.js';
import { SqliteStateStore } from '../dist/src/state/SqliteStateStore.js';
import { TurnDetailRecorder } from '../dist/src/details/TurnDetailRecorder.js';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { TurnDetailArtifactService, DETAIL_UPLOAD_PART_BYTES } from '../dist/src/details/TurnDetailArtifactService.js';
import { DetailAccessPolicy } from '../dist/src/details/DetailAccessPolicy.js';

const identity = { ownerKind: 'task_platform', taskId: 'acceptance-task',
  localTurnId: process.argv[2] === 'paused-writer' ? process.argv[4] ?? 'acceptance-turn' : 'acceptance-turn' };
const event = { type: 'item.delta', taskId: identity.taskId, threadId: 'thread', turnId: 'remote', itemId: 'output', channel: 'agent_message' };
assert.equal(process.platform, 'linux', 'This isolated SIGSTOP/PID-namespace acceptance harness requires Linux.');
const owned = new Set();
function ownFork(args, options) {
  const child = fork(fileURLToPath(import.meta.url), args, options);
  owned.add(child); child.once('exit', () => owned.delete(child));
  return child;
}

if (process.argv[2] === 'paused-writer') {
  const runtime = createTurnDetailRuntime(process.argv[3]);
  runtime.sink.accepted({ ...identity, userId: 'owner', target: { chatId: 'fixture' } });
  runtime.sink.bind(identity.taskId, 'thread', 'remote');
  runtime.store.claimWriter(identity, 'acceptance-writer');
  const recorder = new TurnDetailRecorder(runtime.store, runtime.resources);
  recorder.record(identity, { kind: 'process_delta', itemId: 'output', source: 'progress', text: 'committed prefix\n' }, 'prefix', new Date().toISOString());
  const append = runtime.resources.append.bind(runtime.resources);
  runtime.resources.append = (id, boundary, text) => {
    const result = append(id, boundary, text);
    if (text.includes('acceptance crash boundary')) { writeSync(1, 'DETAIL_ACCEPTANCE_TAIL_WRITTEN\n'); process.kill(process.pid, 'SIGSTOP'); }
    return result;
  };
  recorder.record(identity, { kind: 'process_delta', itemId: 'output', source: 'progress', text: 'acceptance crash boundary safe tail\n' }, 'tail', new Date().toISOString());
  recorder.record(identity, { kind: 'terminal', lifecycle: 'completed' }, 'terminal', new Date().toISOString());
  runtime.store.releaseWriter(identity, 'acceptance-writer');
  await runtime.close();
  process.send?.({ done: true });
} else if (process.argv[2] === 'pressure-writer') {
  const runtime = createTurnDetailRuntime(process.argv[3]), db = new Database(process.argv[3]);
  const files = runtime.resources, append = files.append.bind(files);
  const limit = 50 * 1024 * 1024;
  let physical = 0, peak = 0, rss = 0, removals = 0;
  files.remove = () => { removals++; throw new Error('injected managed unlink failure'); };
  files.append = (id, boundary, text) => {
    const before = files.size(id);
    try { return append(id, boundary, text); }
    finally { physical += files.size(id) - before; peak = Math.max(peak, physical); }
  };
  const reports = [];
  try {
    for (let turn = 0; turn < 2; turn++) {
      physical = 0; peak = 0;
      const id = { ownerKind: Number(process.argv[4]) % 2 ? 'host_manager' : 'task_platform', taskId: `pressure-${process.pid}`, localTurnId: `turn-${turn}` };
      runtime.store.createTurn({ ...id, threadId: 'thread', codexTurnId: 'remote', schemaVersion: 1,
        scope: { kind: 'private_user', chatId: 'fixture', userId: 'owner' }, startedAt: new Date().toISOString(),
        lifecycle: 'running', availability: 'available', retainedBytes: 0, truncated: false });
      runtime.store.claimWriter(id, 'pressure-writer');
      const recorder = new TurnDetailRecorder(runtime.store, files);
      for (let index = 0; index < 64; index++) {
        const text = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1,1024 @@\n'
          + ('+' + String(index).padStart(3, '0') + 'x'.repeat(996) + '\n').repeat(1024);
        recorder.record(id, { kind: 'diff_snapshot', text }, `diff-${index}`, new Date().toISOString());
        rss = Math.max(rss, process.memoryUsage().rss);
        assert.ok(peak <= limit, `physical body cap exceeded: ${peak}`);
        assert.ok(runtime.store.getTurn(id).retainedBytes <= limit, 'logical cap exceeded');
      }
      recorder.record(id, { kind: 'terminal', lifecycle: 'completed' }, 'terminal', new Date().toISOString());
      runtime.results.save(id, { kind: 'private_user', chatId: 'fixture', userId: 'owner' }, 'retained public fixture answer', new Date().toISOString());
      runtime.store.releaseWriter(id, 'pressure-writer');
      const key = JSON.stringify([id.ownerKind, id.taskId, id.localTurnId]);
      const rows = db.prepare('SELECT resource_id FROM detail_resource_registry WHERE turn_key=?').all(key);
      const actual = rows.reduce((sum, row) => sum + files.size(row.resource_id), 0);
      assert.equal(physical, actual);
      reports.push({ physicalPeak: peak, physical: actual, files: rows.length, logical: runtime.store.getTurn(id).retainedBytes,
        truncated: runtime.store.getTurn(id).truncated });
    }
    process.send?.({ pressure: true, turns: reports, rss, failedUnlinks: removals });
  } finally { db.close(); await runtime.close(); }
} else if (process.argv[2] === 'async-writer') {
  const runtime = createTurnDetailRuntime(process.argv[3]); let rss = 0;
  try {
    for (let turn = 0; turn < 8; turn++) {
      const id = { ownerKind: Number(process.argv[4]) % 2 ? 'host_manager' : 'task_platform', taskId: `async-${process.pid}`, localTurnId: `async-turn-${turn}` };
      runtime.sink.accepted({ ...id, userId: 'owner', target: { chatId: 'fixture' } }); runtime.sink.bind(id.taskId, 'thread', 'remote');
      for (let index = 0; index < 8; index++) {
        const diff = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1,256 @@\n'
          + ('+' + String(index).padStart(3, '0') + 'y'.repeat(996) + '\n').repeat(256);
        const journal = runtime.sink.event({ type: 'turn.diff', taskId: id.taskId, threadId: 'thread', turnId: 'remote', diff }, `diff-${index}`);
        assert.notEqual(journal.detailUnavailable, true);
      }
      runtime.sink.saveResult(id, 'async public fixture answer', new Date().toISOString());
      runtime.sink.finish(id.taskId, id.localTurnId, 'completed'); await runtime.flush();
      const stored = runtime.store.getTurn(id);
      assert.equal(stored.lifecycle, 'completed'); assert.notEqual(stored.incomplete, true);
      const ref = runtime.store.listEntries(id)[0].resource;
      assert.ok(runtime.resources.read(ref.resourceId, ref.committedBytes, 0, 1024).includes('+007'));
      rss = Math.max(rss, process.memoryUsage().rss);
    }
    process.send?.({ asyncWriter: true, turns: 8, snapshots: 64, rss });
  } finally { await runtime.close(); }
} else {
  const root = await mkdtemp(join(tmpdir(), 'linkbot-detail-stress-')), path = join(root, 'state.sqlite');
  const runtime = createTurnDetailRuntime(path), core = new SqliteStateStore(path);
  const now = new Date().toISOString();
  core.saveTask({ id: identity.taskId, ownerUserId: 'owner', projectId: 'fixture', baseRef: 'main', branchName: 'fixture', runtimeState: 'hot',
    connectionGeneration: 1, pinned: false, lastUserInteractionAt: now, createdAt: now, updatedAt: now });
  core.saveTurn({ id: identity.localTurnId, taskId: identity.taskId, state: 'running', prompt: '', createdBy: 'owner', createdAt: now, updatedAt: now });
  const child = ownFork(['paused-writer', path], {
    execArgv: [],
    env: { ...process.env, CODEBOT_DETAIL_ACCEPTANCE_PAUSE: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const completion = once(child, 'exit');
  let stderr = ''; child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('acceptance child did not reach barrier')), 15000);
      let output = '';
      child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-200); if (output.includes('DETAIL_ACCEPTANCE_TAIL_WRITTEN')) { clearTimeout(timer); resolve(); } });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`acceptance child exited before barrier: ${stderr}`)); });
    });
    // Wait for the owned child to confirm it actually stopped before racing maintenance.
    for (let retry = 0; retry < 100; retry++) {
      if (/State:\s+T/.test(await readFile(`/proc/${child.pid}/status`, 'utf8'))) break;
      if (retry === 99) throw new Error('acceptance child failed to stop');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    core.updateTurn(identity.localTurnId, (turn) => ({ ...turn, state: 'completed', completedAt: new Date().toISOString() }));
    const before = runtime.store.listEntries(identity)[0].resource;
    const physicalBefore = runtime.resources.size(before.resourceId);
    runtime.maintain();
    const during = { lifecycle: runtime.store.getTurn(identity).lifecycle, physical: runtime.resources.size(before.resourceId), committed: before.committedBytes };
    child.kill('SIGCONT');
    const [code] = await completion;
    assert.equal(code, 0, stderr);
    const final = runtime.store.listEntries(identity)[0].resource;
    const body = runtime.resources.read(final.resourceId, final.committedBytes, 0, 1024);
    assert.ok(body.includes('acceptance crash boundary'), JSON.stringify({ during, physicalBefore, finalBody: body }));
    assert.equal(during.lifecycle, 'running', 'another process must not terminate an active recording writer');
    assert.equal(during.physical, physicalBefore, 'maintenance truncated a live writer tail');
    console.log(JSON.stringify({ test: 'cross-process-live-tail', passed: true, during, physicalBefore }));
    core.saveTurn({ id: 'crash-turn', taskId: identity.taskId, state: 'running', prompt: '', createdBy: 'owner', createdAt: now, updatedAt: now });
    const crashed = ownFork(['paused-writer', path, 'crash-turn'], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    crashed.stderr.resume();
    const crashedExit = once(crashed, 'exit');
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('crash child barrier timeout')), 15000);
        let output = '';
        crashed.stdout.on('data', (chunk) => { output = (output + chunk).slice(-200); if (output.includes('DETAIL_ACCEPTANCE_TAIL_WRITTEN')) { clearTimeout(timer); resolve(); } });
        crashed.once('exit', () => { clearTimeout(timer); reject(new Error('crash child exited before barrier')); });
      });
      crashed.kill('SIGKILL'); await crashedExit;
      const crashId = { ...identity, localTurnId: 'crash-turn' };
      const resource = runtime.store.listEntries(crashId)[0].resource;
      assert.ok(runtime.resources.size(resource.resourceId) > resource.committedBytes);
      core.updateTurn('crash-turn', (turn) => ({ ...turn, state: 'completed', completedAt: new Date().toISOString() }));
      for (let retry = 0; retry < 4; retry++) runtime.maintain();
      assert.equal(runtime.resources.size(resource.resourceId), resource.committedBytes);
      assert.equal(runtime.store.hasStreamGap(crashId), true);
      assert.equal(runtime.store.getTurn(crashId).incomplete, true);
      console.log(JSON.stringify({ test: 'cross-process-hard-crash-boundary', passed: true, committed: resource.committedBytes,
        physicalAfterRecovery: runtime.resources.size(resource.resourceId), incomplete: true }));
    } finally { if (crashed.exitCode === null && crashed.signalCode === null) { crashed.kill('SIGKILL'); await crashedExit; } }
    const remove = runtime.resources.remove.bind(runtime.resources);
    runtime.resources.remove = () => { throw new Error('injected managed unlink failure'); };
    const pressure = [];
    try {
      await Promise.all(Array.from({ length: 4 }, async (_, index) => {
        const producer = ownFork(['pressure-writer', path, String(index)], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        const done = once(producer, 'exit'); let report;
        producer.on('message', (message) => { if (message.pressure) report = message; });
        let errors = ''; producer.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-2000); });
        const watchdog = setTimeout(() => producer.kill('SIGKILL'), 90000);
        try {
          const [code] = await done; assert.equal(code, 0, errors); assert.ok(report);
          pressure.push(report);
        } finally { clearTimeout(watchdog); if (producer.exitCode === null && producer.signalCode === null) { producer.kill('SIGKILL'); await done; } }
      }));
    } finally { runtime.resources.remove = remove; }
    const asynchronous = []; let backgroundRemoved = 0;
    const maintenanceTimer = setInterval(() => { try { backgroundRemoved += runtime.maintenance.run(64).removed; } catch { /* Evidence checked after all writers drain. */ } }, 20);
    try {
      await Promise.all(Array.from({ length: 4 }, async (_, index) => {
        const producer = ownFork(['async-writer', path, String(index)], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        const done = once(producer, 'exit'); let report, errors = '';
        producer.on('message', (message) => { if (message.asyncWriter) report = message; });
        producer.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-2000); });
        const watchdog = setTimeout(() => producer.kill('SIGKILL'), 90000);
        try { const [code] = await done; assert.equal(code, 0, errors); assert.ok(report); asynchronous.push(report); }
        finally { clearTimeout(watchdog); if (producer.exitCode === null && producer.signalCode === null) { producer.kill('SIGKILL'); await done; } }
      }));
    } finally { clearInterval(maintenanceTimer); }
    console.log(JSON.stringify({ test: 'multi-process-async-recording-with-maintenance', passed: true, processes: 4,
      turns: asynchronous.reduce((sum, p) => sum + p.turns, 0), snapshots: asynchronous.reduce((sum, p) => sum + p.snapshots, 0),
      maxProcessRss: Math.max(...asynchronous.map((p) => p.rss)) }));
    const db = new Database(path);
    try {
      let removed = backgroundRemoved;
      for (let batch = 0; batch < 20; batch++) removed += runtime.maintenance.run(64).removed;
      assert.ok(removed >= 392);
      assert.equal(db.prepare('SELECT count(*) AS n FROM detail_resource_deletions').get().n, 0);
      assert.equal(db.prepare('SELECT count(*) AS n FROM detail_recording_writers').get().n, 0);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      const largeId = { ownerKind: 'task_platform', taskId: 'large-export-fixture', localTurnId: 'large-export-turn' };
      const stamp = new Date().toISOString(), scope = { kind: 'private_user', chatId: 'fixture', userId: 'owner' };
      runtime.store.createTurn({ ...largeId, schemaVersion: 1, threadId: 'thread', scope, startedAt: stamp,
        lifecycle: 'running', availability: 'available', retainedBytes: 0, truncated: false });
      runtime.store.claimWriter(largeId, 'large-export');
      const recorder = new TurnDetailRecorder(runtime.store, runtime.resources);
      recorder.record(largeId, { kind: 'command_item', itemId: 'command', command: 'pwd', completed: false }, 'command', stamp);
      const chunk = ('ordinary safe fixture output '.repeat(35) + '\n').repeat(64);
      for (let index = 0; index < 512; index++) assert.equal(recorder.record(largeId,
        { kind: 'command_delta', itemId: 'command', stream: 'combined', text: chunk }, `chunk-${index}`, stamp), true);
      recorder.record(largeId, { kind: 'terminal', lifecycle: 'completed' }, 'terminal', stamp);
      runtime.store.releaseWriter(largeId, 'large-export'); runtime.results.save(largeId, scope, 'large fixture public result', stamp);
      const uploads = [];
      const policy = new DetailAccessPolicy({ resolveSource: async () => ({ chatId: 'fixture', chatType: 'private' }),
        isGroupMember: async () => false, canReadTopic: async () => false });
      const service = new TurnDetailArtifactService(runtime.store, runtime.resources, runtime.results, () => policy, {
        uploadFile: async (data) => { assert.ok(data.length <= DETAIL_UPLOAD_PART_BYTES); uploads.push(data); return `key-${uploads.length}`; },
        sendDetailFileToTarget: async () => ({ messageId: 'fixture-receipt' }),
      }, undefined, undefined, undefined, runtime.telemetry, runtime.audit);
      await service.deliver({ identity: largeId, category: 'commands', actor: { userId: 'owner', sourceMessageId: 'fixture-source' },
        ...service.snapshot(largeId, 'commands') }, 'large-fixture-delivery');
      assert.equal(uploads.length, 2);
      const ref = runtime.store.listEntries(largeId)[0].resource;
      const expected = createHash('sha256');
      for (let offset = 0; offset < ref.committedBytes; offset += 65536) expected.update(runtime.resources.readBytes(ref.resourceId, ref.committedBytes,
        offset, Math.min(65536, ref.committedBytes - offset)));
      const assembled = Buffer.concat(uploads);
      assert.equal(createHash('sha256').update(assembled.subarray(assembled.length - ref.committedBytes)).digest('hex'), expected.digest('hex'));
      console.log(JSON.stringify({ test: 'real-retained-body-multipart-export', passed: true, retainedBodyBytes: ref.committedBytes,
        uploadParts: uploads.map((data) => data.length), lossless: true, transport: 'mock-only' }));
      const total = db.prepare('SELECT count(*) AS n FROM turn_results').get().n;
      const later = createTurnDetailRuntime(path, () => new Date(Date.now() + 8 * 86400000));
      try { for (let batch = 0; batch < 12; batch++) later.maintenance.run(64); } finally { await later.close(); }
      assert.equal(db.prepare('SELECT count(*) AS n FROM detail_resource_registry').get().n, 0);
      assert.deepEqual(await readdir(`${path}.turn-details`), []);
      assert.equal(db.prepare('SELECT count(*) AS n FROM turn_results').get().n, total);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      console.log(JSON.stringify({ test: 'multi-process-50MiB-fault-pressure', passed: true, processes: 4, turns: pressure.flatMap((p) => p.turns),
        snapshots: 512, maxProcessRss: Math.max(...pressure.map((p) => p.rss)), retiredRemoved: removed, preservedPublicResults: total }));
    } finally { db.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await completion; }
    await Promise.all([...owned].map(async (remaining) => {
      const exited = once(remaining, 'exit'); remaining.kill('SIGKILL'); await exited;
    }));
    core.close(); await runtime.close();
  }
}
