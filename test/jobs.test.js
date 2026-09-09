import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { JobStore } from '../src/jobs.js';
import { runWorker } from '../src/worker.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'praxis-jobs-'));
  const stores = [];
  t.after(() => {
    for (const store of stores) { try { store.close(); } catch { /* May have been explicitly closed. */ } }
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, open() { const store = new JobStore(directory); stores.push(store); return store; } };
}

const request = (key = 'test-key') => ({ owner: 'jensen', idempotencyKey: key, label: 'Fixture', durationSeconds: 1, intervalSeconds: 1 });
const ref = (job) => ({ owner: 'jensen', jobId: job.id });

async function until(check, timeout = 4000) {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > timeout) throw new Error('Condition did not become true.');
    await delay(20);
  }
}

test('reopening and independent connections preserve idempotency and enforce one active job', (t) => {
  const fixtureState = fixture(t);
  const first = fixtureState.open();
  const job = first.start(request());
  first.close();
  const second = fixtureState.open();
  const third = fixtureState.open();
  assert.deepEqual(second.get(ref(job)), job);
  assert.equal(third.start(request()).id, job.id);
  assert.throws(() => third.start({ ...request(), label: 'Different' }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.throws(() => third.start(request('another-key')), { code: 'ACTIVE_JOB_LIMIT' });
  assert.throws(() => second.get({ owner: 'another-owner', jobId: job.id }), { code: 'NOT_FOUND' });
  second.cancel(ref(job));
  assert.equal(third.start(request()).status, 'cancelled');
  assert.notEqual(third.start(request('another-key')).id, job.id);
});

test('simultaneous processes commit exactly one job for a shared idempotency key', async (t) => {
  const state = fixture(t);
  const store = state.open();
  const source = `import { JobStore } from ${JSON.stringify(new URL('../src/jobs.js', import.meta.url).href)};
    const store = new JobStore(process.argv[1]);
    console.log(JSON.stringify(store.start(${JSON.stringify(request())})));
    store.close();`;
  const results = await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, ['--input-type=module', '-e', source, state.directory])));
  const ids = results.map((result) => JSON.parse(result.stdout).id);
  assert.equal(new Set(ids).size, 1);
  assert.equal(store.list({ owner: 'jensen' }).jobs.length, 1);
});

test('queued cancellation is durable and terminal, while pagination never repeats jobs or records', (t) => {
  const state = fixture(t);
  const store = state.open();
  const jobs = [];
  for (let i = 0; i < 3; i++) {
    const job = store.start(request(`key-${i}`));
    jobs.push(job);
    store.cancel(ref(job));
    store.cancel(ref(job));
  }
  const page1 = store.list({ owner: 'jensen', limit: 2 });
  const page2 = store.list({ owner: 'jensen', limit: 2, cursor: page1.nextCursor });
  assert.deepEqual([...page1.jobs, ...page2.jobs].map((job) => job.id), jobs.map((job) => job.id).reverse());
  assert.equal(page2.nextCursor, null);
  const logs = store.logs(ref(jobs[0]));
  assert.equal(logs.records.length, 1);
  assert.equal(logs.records[0].event, 'CANCELLED');
  assert.equal(logs.records[0].sequence, 1);
  assert.deepEqual(store.logs({ ...ref(jobs[0]), cursor: logs.nextCursor }).records, []);
});

test('validates bounded inputs, IDs, and pagination', (t) => {
  const store = fixture(t).open();
  for (const patch of [{ durationSeconds: 181 }, { durationSeconds: 0 }, { intervalSeconds: 11 }, { intervalSeconds: 0.5 }, { label: 'x'.repeat(81) }, { label: 'line\nbreak' }, { idempotencyKey: 'bad key' }]) {
    assert.throws(() => store.start({ ...request(), ...patch }), { code: 'VALIDATION_ERROR' });
  }
  assert.throws(() => store.get({ owner: 'jensen', jobId: '../../elsewhere' }), { code: 'VALIDATION_ERROR' });
  for (const patch of [{ cursor: -1 }, { cursor: '1' }, { cursor: Number.MAX_SAFE_INTEGER + 1 }, { limit: 0 }, { limit: 51 }]) {
    assert.throws(() => store.list({ owner: 'jensen', ...patch }), { code: 'VALIDATION_ERROR' });
  }
});

test('independent worker completes bounded job and logs survive a web-store restart', async (t) => {
  const state = fixture(t);
  const store = state.open();
  const job = store.start(request());
  const controller = new AbortController();
  const running = runWorker({ dataDirectory: state.directory, pollIntervalMs: 20, signal: controller.signal });
  try {
    await until(() => store.get(ref(job)).status === 'completed');
    store.close();
    const reopened = state.open();
    const logs = reopened.logs(ref(job));
    assert.deepEqual(logs.records.map((record) => record.event), ['STARTED', 'HEARTBEAT', 'COMPLETED']);
    assert.deepEqual(logs.records.map((record) => record.sequence), [1, 2, 3]);
    assert.ok(logs.records.every((record) => record.runId === job.id && Number.isFinite(Date.parse(record.utc))));
    assert.ok(logs.records.at(-1).elapsedSeconds >= 1);
    assert.equal(logs.records[1].heartbeat, 1);
  } finally { controller.abort(); await running; }
});

test('running cancellation is observed by worker; duplicate workers are rejected', async (t) => {
  const state = fixture(t);
  const store = state.open();
  const job = store.start({ ...request(), durationSeconds: 30 });
  const controller = new AbortController();
  const running = runWorker({ dataDirectory: state.directory, pollIntervalMs: 20, signal: controller.signal });
  try {
    await until(() => store.get(ref(job)).status === 'running');
    await assert.rejects(runWorker({ dataDirectory: state.directory }), { code: 'WORKER_BUSY' });
    assert.equal(store.cancel(ref(job)).cancellationRequested, true);
    await until(() => store.get(ref(job)).status === 'cancelled');
    assert.deepEqual(store.logs(ref(job)).records.map((record) => record.event), ['STARTED', 'CANCELLED']);
  } finally { controller.abort(); await running; }
});

test('new worker interrupts an ambiguous running job and never restarts it', async (t) => {
  const state = fixture(t);
  const store = state.open();
  const job = store.start(request());
  store.claimNext('previous-worker');
  store.close();
  const reopened = state.open();
  const controller = new AbortController();
  const running = runWorker({ dataDirectory: state.directory, pollIntervalMs: 20, signal: controller.signal });
  try {
    await until(() => reopened.get(ref(job)).status === 'interrupted');
    assert.deepEqual(reopened.logs(ref(job)).records.map((record) => record.event), ['STARTED', 'INTERRUPTED']);
    assert.equal(reopened.start(request()).id, job.id);
  } finally { controller.abort(); await running; }
});

test('hard-killed worker lock is reclaimed and its running job is interrupted', async (t) => {
  const state = fixture(t);
  const store = state.open();
  const job = store.start({ ...request(), durationSeconds: 30 });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/worker.js', import.meta.url))], {
    env: { ...process.env, PRAXIS_DATA_DIR: state.directory },
    stdio: 'ignore',
  });
  const exit = once(child, 'exit');
  try {
    await until(() => store.get(ref(job)).status === 'running');
  } finally {
    child.kill('SIGKILL');
    await exit;
  }
  assert.equal(store.get(ref(job)).status, 'running');
  const controller = new AbortController();
  const running = runWorker({ dataDirectory: state.directory, pollIntervalMs: 20, signal: controller.signal });
  try {
    await until(() => store.get(ref(job)).status === 'interrupted');
    assert.deepEqual(store.logs(ref(job)).records.map((record) => record.event), ['STARTED', 'INTERRUPTED']);
  } finally { controller.abort(); await running; }
});
