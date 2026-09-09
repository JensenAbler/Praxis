import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CodeJobs, CODE_JOB_LIMITS } from '../src/code/jobs.js';
import { containerName, PodmanRunner } from '../src/code/runner.js';

class FakeRunner {
  constructor() { this.containers = new Map(); this.created = 0; this.started = 0; this.stopped = 0; }
  async create({ job }) {
    this.created++;
    const name = containerName(job.id);
    const value = { exists: true, id: 'a'.repeat(64), status: 'created', running: false, records: [] };
    this.containers.set(name, value);
    if (this.createWait) await this.createWait;
    return { name, id: value.id };
  }
  async start({ name }) {
    this.started++;
    Object.assign(this.containers.get(name), { status: 'running', running: true, startedAt: '2026-01-01T00:00:00.000Z' });
    if (this.startProblem) throw Object.assign(new Error('uncertain'), { code: 'CONTAINER_START_FAILED' });
  }
  async inspect({ name }) {
    if (this.inspectProblem) throw Object.assign(new Error('runtime unavailable'), { code: 'RUNNER_UNAVAILABLE' });
    return this.containers.get(name) ?? { exists: false };
  }
  async stop({ name }) {
    this.stopped++;
    if (this.stopProblem) throw Object.assign(new Error('stop failed'), { code: 'CONTAINER_STOP_FAILED' });
    this.complete(name, 137);
  }
  async logs({ name, cursor }) {
    const records = this.containers.get(name)?.records ?? [];
    return { records: records.slice(cursor), cursor: records.length, hasMore: false, truncated: false };
  }
  async remove({ name }) { this.containers.delete(name); }
  complete(name, code = 0) { Object.assign(this.containers.get(name), { status: 'exited', running: false, exitCode: code, finishedAt: '2026-01-01T00:00:01.000Z' }); }
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'praxis-code-jobs-'));
  const workspace = join(directory, 'workspaces', 'fixture');
  mkdirSync(workspace, { recursive: true });
  let db = new DatabaseSync(join(directory, 'jobs.sqlite'));
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  const store = {
    db, transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  let revision = 'revision-a';
  let time = '2026-01-01T00:00:00.000Z';
  const workspaces = {
    getExecutionWorkspace({ owner, workspaceId }) {
      if (owner !== 'jensen' || workspaceId !== 'fixture') throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
      return { path: workspace, workspaceId, revision };
    },
    refreshAfterJob() { revision = 'revision-after-command'; return { revision }; },
  };
  const runner = new FakeRunner();
  const options = { store, dataDirectory: directory, runner, workspaces, clock: () => time };
  const jobs = new CodeJobs(options);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, workspace, store, runner, jobs, options, setTime(value) { time = value; }, setRevision(value) { revision = value; },
    reopenStore() {
      db.close();
      db = new DatabaseSync(join(directory, 'jobs.sqlite'));
      db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      store.db = db;
    },
  };
}
const request = extra => ({ owner: 'jensen', workspaceId: 'fixture', expectedRevision: 'revision-a', idempotencyKey: 'test-key-0001', argv: ['node', '--version'], ...extra });

test('jobs persist before execution, require revisions, enforce owner/idempotency/concurrency', async t => {
  const f = fixture(t);
  assert.throws(() => f.jobs.start(request({ expectedRevision: 'stale' })), { code: 'STALE_REVISION' });
  assert.throws(() => f.jobs.start(request({ cwd: '../outside' })), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => f.jobs.start(request({ env: { NODE_OPTIONS: '--require=/host/secret' } })), { code: 'INVALID_ARGUMENT' });
  const job = f.jobs.start(request());
  assert.equal(job.status, 'queued');
  assert.equal(f.runner.created, 0);
  assert.equal(f.jobs.start(request()).id, job.id);
  assert.throws(() => f.jobs.start(request({ argv: ['bash', '-c', 'different'] })), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.throws(() => f.jobs.start(request({ idempotencyKey: 'test-key-0002' })), { code: 'ACTIVE_JOB_LIMIT' });
  assert.throws(() => f.jobs.get({ owner: 'other', jobId: job.id }), { code: 'NOT_FOUND' });
  assert.equal(new CodeJobs(f.options).get({ owner: 'jensen', jobId: job.id }).status, 'queued');
});

test('completion preserves paginated output and immutable artifacts across manager recreation', async t => {
  const f = fixture(t);
  writeFileSync(join(f.workspace, 'report.txt'), 'report original');
  const job = f.jobs.start(request({ artifactPaths: ['report.txt', 'missing.txt'] }));
  await f.jobs.tick();
  const name = containerName(job.id);
  f.runner.containers.get(name).records.push(
    { timestamp: '2026-01-01T00:00:00.100Z', stream: 'stdout', text: 'first\n' },
    { timestamp: '2026-01-01T00:00:00.200Z', stream: 'stderr', text: 'second\n' },
  );
  await f.jobs.tick();
  assert.equal(f.runner.created, 1); assert.equal(f.runner.started, 1);
  f.runner.complete(name);
  await f.jobs.tick();
  const reopened = new CodeJobs(f.options);
  const completed = reopened.get({ owner: 'jensen', jobId: job.id });
  assert.equal(completed.status, 'completed'); assert.equal(completed.exitCode, 0);
  assert.equal(completed.revisionAfter, 'revision-after-command');
  assert.deepEqual(completed.artifactErrors, [{ path: 'missing.txt', code: 'ARTIFACT_MISSING' }]);
  const all = [];
  let cursor = 0;
  for (;;) {
    const result = reopened.logs({ owner: 'jensen', jobId: job.id, cursor, limit: 2 });
    all.push(...result.records); cursor = result.nextCursor;
    if (!result.hasMore) { assert.equal(result.caughtUp, true); break; }
  }
  assert.deepEqual(all.map(record => record.sequence), all.map((_, index) => index + 1));
  assert.equal(all.filter(record => record.stream !== 'system').map(record => record.text).join(''), 'first\nsecond\n');
  const artifact = reopened.artifactList({ owner: 'jensen', jobId: job.id }).artifacts[0];
  writeFileSync(join(f.workspace, 'report.txt'), 'changed after job');
  const first = reopened.artifactRead({ owner: 'jensen', jobId: job.id, artifactId: artifact.id, limit: 6 });
  const second = reopened.artifactRead({ owner: 'jensen', jobId: job.id, artifactId: artifact.id, cursor: first.nextCursor });
  const value = Buffer.concat([Buffer.from(first.content, 'base64'), Buffer.from(second.content, 'base64')]);
  assert.equal(value.toString(), 'report original');
  assert.equal(createHash('sha256').update(value).digest('hex'), artifact.sha256);
});

test('startup never starts a previously prepared or missing ambiguous execution', async t => {
  for (const exists of [true, false]) {
    const f = fixture(t);
    const job = f.jobs.start(request());
    f.store.db.prepare("UPDATE code_jobs SET status='starting',launch_intent_at=? WHERE id=?").run('2026-01-01T00:00:00.000Z', job.id);
    if (exists) f.runner.containers.set(containerName(job.id), { exists: true, status: 'created', running: false, records: [] });
    await new CodeJobs(f.options).recover();
    assert.equal(f.jobs.get({ owner: 'jensen', jobId: job.id }).status, 'interrupted');
    assert.equal(f.runner.created, 0); assert.equal(f.runner.started, 0);
  }
});

test('an uncertain start adopts observed execution and does not execute twice', async t => {
  const f = fixture(t);
  f.runner.startProblem = true;
  const job = f.jobs.start(request());
  await f.jobs.tick();
  assert.equal(f.jobs.get({ owner: 'jensen', jobId: job.id }).status, 'running');
  const recovered = new CodeJobs(f.options);
  await recovered.recover();
  f.runner.complete(containerName(job.id));
  await recovered.tick();
  assert.equal(recovered.get({ owner: 'jensen', jobId: job.id }).status, 'completed');
  assert.equal(f.runner.created, 1); assert.equal(f.runner.started, 1);
});

test('startedAt observed during pending inspection survives runtime discovery, reopening, and completion', async t => {
  const f = fixture(t);
  const acknowledgedAt = '2026-09-09T06:14:29.961Z';
  const runtimeStartedAt = '2026-09-08T23:14:29.947738575-07:00';
  f.setTime(acknowledgedAt);
  let releaseInspection, inspectionEntered;
  const pendingInspection = new Promise(resolve => { releaseInspection = resolve; });
  const enteredInspection = new Promise(resolve => { inspectionEntered = resolve; });
  const inspect = f.runner.inspect.bind(f.runner);
  f.runner.inspect = async input => {
    const state = await inspect(input);
    state.startedAt = runtimeStartedAt;
    inspectionEntered();
    await pendingInspection;
    return state;
  };
  const job = f.jobs.start(request());
  const ticking = f.jobs.tick();
  await enteredInspection;
  const duringInspection = f.jobs.get({ owner: 'jensen', jobId: job.id });
  const repeatedDuringInspection = f.jobs.start(request());
  releaseInspection();
  await ticking;
  assert.equal(duringInspection.status, 'running');
  assert.equal(duringInspection.startedAt, acknowledgedAt);
  assert.equal(repeatedDuringInspection.startedAt, acknowledgedAt);
  assert.equal(f.jobs.get({ owner: 'jensen', jobId: job.id }).startedAt, acknowledgedAt);

  f.reopenStore();
  const recovered = new CodeJobs(f.options);
  await recovered.recover();
  assert.equal(recovered.get({ owner: 'jensen', jobId: job.id }).startedAt, acknowledgedAt);
  f.runner.complete(containerName(job.id));
  f.runner.containers.get(containerName(job.id)).finishedAt = '2026-09-09T06:14:34.947Z';
  await recovered.tick();
  const completed = recovered.get({ owner: 'jensen', jobId: job.id });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.exitCode, 0);
  assert.equal(completed.startedAt, acknowledgedAt);
  assert.equal(recovered.start(request()).startedAt, acknowledgedAt);
  assert.equal(recovered.list({ owner: 'jensen' }).jobs[0].startedAt, acknowledgedAt);
  assert.equal(f.runner.created, 1);
  assert.equal(f.runner.started, 1);
});

test('a stable acknowledgement timestamp does not extend the runtime deadline', async t => {
  const f = fixture(t);
  f.setTime('2026-01-01T00:00:02.000Z');
  const job = f.jobs.start(request({ timeoutSeconds: 3 }));
  await f.jobs.tick();
  assert.equal(f.jobs.get({ owner: 'jensen', jobId: job.id }).startedAt, '2026-01-01T00:00:02.000Z');
  f.setTime('2026-01-01T00:00:03.100Z');
  await f.jobs.tick();
  const result = f.jobs.get({ owner: 'jensen', jobId: job.id });
  assert.equal(result.status, 'timed_out');
  assert.equal(result.startedAt, '2026-01-01T00:00:02.000Z');
  assert.equal(f.runner.stopped, 1);
});

test('unavailable runtime leaves uncertain work locked until state is recoverable', async t => {
  const f = fixture(t);
  const job = f.jobs.start(request());
  await f.jobs.tick();
  f.runner.inspectProblem = true;
  await new CodeJobs(f.options).recover();
  assert.equal(f.jobs.get({ owner: 'jensen', jobId: job.id }).status, 'running');
  assert.throws(() => f.jobs.start(request({ idempotencyKey: 'test-key-0002' })), { code: 'ACTIVE_JOB_LIMIT' });
  f.runner.inspectProblem = false;
  f.runner.complete(containerName(job.id));
  await f.jobs.tick();
  assert.equal(f.jobs.get({ owner: 'jensen', jobId: job.id }).status, 'completed');
});

test('queued cancellation and cancellation during container preparation never start a command', async t => {
  const f = fixture(t);
  const first = f.jobs.start(request());
  assert.equal(f.jobs.cancel({ owner: 'jensen', jobId: first.id }).status, 'cancelled');
  await f.jobs.tick(); assert.equal(f.runner.created, 0);
  let continueCreation;
  f.runner.createWait = new Promise(resolve => { continueCreation = resolve; });
  const job = f.jobs.start(request({ idempotencyKey: 'test-key-0002' }));
  const ticking = f.jobs.tick();
  await Promise.resolve();
  assert.equal(f.jobs.cancel({ owner: 'jensen', jobId: job.id }).status, 'canceling');
  continueCreation(); await ticking;
  assert.equal(f.jobs.get({ owner: 'jensen', jobId: job.id }).status, 'cancelled');
  assert.equal(f.runner.started, 0);
});

test('failed cancellation retains lock and retries observation; timeout is a distinct terminal state', async t => {
  const f = fixture(t);
  const job = f.jobs.start(request());
  await f.jobs.tick(); f.runner.stopProblem = true;
  f.jobs.cancel({ owner: 'jensen', jobId: job.id });
  await f.jobs.tick();
  assert.equal(f.jobs.get({ owner: 'jensen', jobId: job.id }).status, 'canceling');
  f.runner.stopProblem = false; await f.jobs.tick();
  assert.equal(f.jobs.get({ owner: 'jensen', jobId: job.id }).status, 'cancelled');
  const timeout = f.jobs.start(request({ idempotencyKey: 'test-key-0002', expectedRevision: 'revision-after-command', timeoutSeconds: 1 }));
  await f.jobs.tick(); f.setTime('2026-01-01T00:00:02.000Z'); await f.jobs.tick();
  const result = f.jobs.get({ owner: 'jensen', jobId: timeout.id });
  assert.equal(result.status, 'timed_out'); assert.equal(result.terminationReason, 'timeout');
});

test('independent monitor timeout sentinel is an explicit inference, not a fabricated POSIX exit', async t => {
  const f = fixture(t);
  const job = f.jobs.start(request({ timeoutSeconds: 1 })); await f.jobs.tick();
  const name = containerName(job.id);
  Object.assign(f.runner.containers.get(name), { running: false, status: 'exited', exitCode: null, monitorExitCode: -1, finishedAt: '2026-01-01T00:00:01.100Z' });
  await f.jobs.tick();
  const result = f.jobs.get({ owner: 'jensen', jobId: job.id });
  assert.equal(result.status, 'interrupted'); assert.equal(result.exitCode, null);
  assert.equal(result.terminationReason, 'timeout_inferred');
  assert.ok(f.runner.containers.has(name), 'Unconfirmed terminal execution should preserve runtime diagnostics.');
  assert.equal(f.runner.started, 1);
});

test('output retention and pages remain bounded for noisy commands', async t => {
  const f = fixture(t);
  const job = f.jobs.start(request()); await f.jobs.tick();
  f.runner.containers.get(containerName(job.id)).records.push({ timestamp: '2026-01-01T00:00:00.100Z', stream: 'stdout', text: 'x'.repeat(CODE_JOB_LIMITS.logBytes + 5000) });
  await f.jobs.tick();
  const result = f.jobs.logs({ owner: 'jensen', jobId: job.id, limit: 100 });
  assert.equal(result.truncated, true); assert.equal(result.outputBytes, CODE_JOB_LIMITS.logBytes);
  assert.equal(result.hasMore, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 55000);
  assert.ok(result.records.every(record => Buffer.byteLength(record.text) <= 4096));
});

test('multibyte text remains intact across record byte boundaries', async t => {
  const f = fixture(t);
  const job = f.jobs.start(request()); await f.jobs.tick();
  const text = 'a'.repeat(4095) + '🙂'.repeat(2200) + '\n';
  f.runner.containers.get(containerName(job.id)).records.push({ timestamp: '2026-01-01T00:00:00.100Z', stream: 'stdout', text });
  await f.jobs.tick();
  const logs = f.jobs.logs({ owner: 'jensen', jobId: job.id, limit: 100 });
  assert.equal(logs.records.filter(row => row.stream === 'stdout').map(row => row.text).join(''), text);
  assert.ok(logs.records.every(row => Buffer.byteLength(row.text) <= 4096));
});

test('tiny output records cannot expand private SQLite beyond the record retention cap', async t => {
  const f = fixture(t);
  const job = f.jobs.start(request()); await f.jobs.tick();
  f.runner.containers.get(containerName(job.id)).records = Array.from({ length: CODE_JOB_LIMITS.logRecords + 10 }, () => ({ timestamp: '2026-01-01T00:00:00.100Z', stream: 'stdout', text: '\n' }));
  await f.jobs.tick();
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM code_records WHERE job_id=? AND stream!='system'").get(job.id).count, CODE_JOB_LIMITS.logRecords);
  assert.equal(f.jobs.get({ owner: 'jensen', jobId: job.id }).truncated, true);
});

test('JSON escaping cannot bypass the log response byte budget', async t => {
  const f = fixture(t);
  const job = f.jobs.start(request()); await f.jobs.tick();
  f.runner.containers.get(containerName(job.id)).records.push({ timestamp: '2026-01-01T00:00:00.100Z', stream: 'stdout', text: '\u0000'.repeat(60000) });
  await f.jobs.tick();
  const result = f.jobs.logs({ owner: 'jensen', jobId: job.id, limit: 100 });
  assert.equal(result.hasMore, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 55000);
  assert.ok(result.records.some(record => record.stream === 'stdout' && record.text.includes('\u0000')), 'Stored NUL output must not be silently cut off by the SQLite TEXT getter.');
});

test('a second live process lease cannot supervise the same durable queue', async t => {
  const f = fixture(t);
  // This unknown token belongs to a still-live PID: even PID reuse must fail closed.
  f.store.db.prepare('INSERT INTO code_runner_lock(singleton,pid,token) VALUES(1,?,?)').run(process.pid, 'another-runner-token');
  await assert.rejects(f.jobs.tick(), { code: 'RUNNER_BUSY' });
  assert.equal(f.runner.created, 0);
});

test('source scan failure leaves the last revision available for a corrective sandbox job', async t => {
  const f = fixture(t);
  f.options.workspaces.refreshAfterJob = () => { throw Object.assign(new Error('too large'), { code: 'LIMIT_EXCEEDED' }); };
  const job = f.jobs.start(request()); await f.jobs.tick();
  f.runner.complete(containerName(job.id)); await f.jobs.tick();
  const result = f.jobs.get({ owner: 'jensen', jobId: job.id });
  assert.equal(result.status, 'failed'); assert.equal(result.exitCode, 0);
  assert.equal(result.revisionAfter, 'revision-a'); assert.equal(result.revisionVerified, false);
  assert.equal(result.executionError, 'LIMIT_EXCEEDED');
  assert.equal(f.jobs.start(request({ idempotencyKey: 'cleanup-key-001' })).status, 'queued');
});

test('artifact snapshot rejects escaping links without reading their targets', async t => {
  const f = fixture(t);
  const outside = join(f.directory, 'private.txt'); writeFileSync(outside, 'private sentinel');
  try { symlinkSync(outside, join(f.workspace, 'link.txt')); } catch (error) {
    if (error.code === 'EPERM') { t.skip('Windows host does not permit symlink creation. Linux deployment must exercise this case.'); return; }
    throw error;
  }
  const job = f.jobs.start(request({ artifactPaths: ['link.txt'] }));
  await f.jobs.tick(); f.runner.complete(containerName(job.id)); await f.jobs.tick();
  assert.deepEqual(f.jobs.artifactList({ owner: 'jensen', jobId: job.id }).artifacts, []);
  assert.deepEqual(f.jobs.get({ owner: 'jensen', jobId: job.id }).artifactErrors, [{ path: 'link.txt', code: 'UNSAFE_ARTIFACT' }]);
});

test('Podman arguments contain only fixed sandbox policy, exact argv, and no inherited credentials', async t => {
  const f = fixture(t);
  const calls = [];
  const runner = new PodmanRunner({ image: `sha256:${'b'.repeat(64)}`, workspaceRoot: join(f.directory, 'workspaces'), logDirectory: join(f.directory, 'logs'),
    env: { HOME: '/private/executor-home', XDG_RUNTIME_DIR: '/run/praxis-code' },
    invoke: async (binary, args, env) => { calls.push({ binary, args, env }); return { code: 0, stdout: 'c'.repeat(64), stderr: '' }; },
  });
  const job = f.jobs.start(request({ argv: ['bash', '-c', 'printf "$HOME"; cat /etc/passwd'] }));
  await runner.create({ job: { id: job.id, ...request({ argv: job.argv }), timeoutSeconds: 30, cwd: '.', env: {} }, workspacePath: f.workspace });
  const call = calls[0];
  assert.ok(call.args.includes('--network=none')); assert.ok(call.args.includes('--read-only'));
  assert.ok(call.args.includes('--security-opt=no-new-privileges')); assert.ok(call.args.includes('--cap-drop=ALL'));
  assert.equal(call.args.filter(value => value === '--mount').length, 1);
  assert.deepEqual(call.args.slice(-3), job.argv);
  assert.equal(call.env.GITHUB_TOKEN, undefined); assert.equal(call.env.SSH_AUTH_SOCK, undefined);
  assert.equal(call.args.includes('--privileged'), false);
  assert.deepEqual(call.args.slice(0, runner.globalArgs.length), runner.globalArgs);
  assert.throws(() => new PodmanRunner({ image: 'node:latest', workspaceRoot: f.workspace, logDirectory: f.directory }), { code: 'RUNNER_CONFIG' });
});

test('log recycling before the first poll is detectable from the persisted pre-launch seed', async t => {
  const f = fixture(t);
  const runner = new PodmanRunner({ image: `sha256:${'b'.repeat(64)}`, workspaceRoot: join(f.directory, 'workspaces'), logDirectory: join(f.directory, 'logs'),
    invoke: async () => ({ code: 0, stdout: 'c'.repeat(64), stderr: '' }) });
  const job = f.jobs.start(request());
  const created = await runner.create({ job: { ...job, env: {} }, workspacePath: f.workspace });
  writeFileSync(runner.logPath(created.name), '2026-01-01T00:00:01.000Z stdout F retained tail\n');
  const result = await runner.logs({ name: created.name, cursor: created.logCursor, fingerprint: created.logFingerprint, final: true });
  assert.equal(result.truncated, true); assert.equal(result.records[0].text, 'retained tail\n');
});

test('real log-file reader identifies recycling and retains an incomplete terminal tail explicitly', async t => {
  const f = fixture(t);
  const runner = new PodmanRunner({ image: `sha256:${'b'.repeat(64)}`, workspaceRoot: join(f.directory, 'workspaces'), logDirectory: join(f.directory, 'logs') });
  mkdirSync(runner.logDirectory);
  const name = containerName(f.jobs.start(request()).id);
  writeFileSync(runner.logPath(name), '2026-01-01T00:00:00.000Z stdout F first\n');
  const initial = await runner.logs({ name });
  assert.equal(initial.records[0].text, 'first\n'); assert.equal(initial.truncated, false);
  writeFileSync(runner.logPath(name), '2026-01-01T00:00:01.000Z stdout P terminal tail');
  const rotated = await runner.logs({ name, cursor: initial.cursor, fingerprint: initial.fingerprint, final: true });
  assert.equal(rotated.truncated, true); assert.equal(rotated.records[0].text, 'terminal tail');
  assert.equal(rotated.hasMore, false);
});

test('a durable rolling tail retains the final summary after the head cap without rewriting head records', async t => {
  const f = fixture(t);
  const job = f.jobs.start(request()); await f.jobs.tick();
  const name = containerName(job.id);
  f.runner.containers.get(name).records.push({ timestamp: '2026-01-01T00:00:00.100Z', stream: 'stdout', text: 'x'.repeat(CODE_JOB_LIMITS.logBytes + 10000) });
  await f.jobs.tick();
  const headBefore = f.store.db.prepare('SELECT sequence,timestamp,stream,CAST(text AS BLOB) AS text_bytes,partial FROM code_records WHERE job_id=? ORDER BY sequence').all(job.id);
  f.runner.containers.get(name).records.push({ timestamp: '2026-01-01T00:00:00.900Z', stream: 'stdout', text: 'FINAL: 30 passed, 0 failed\n' });
  f.runner.complete(name); await f.jobs.tick();
  f.reopenStore();
  const reopened = new CodeJobs(f.options);
  const status = reopened.get({ owner: 'jensen', jobId: job.id });
  assert.equal(status.status, 'completed');
  assert.equal(status.outputBytes, CODE_JOB_LIMITS.logBytes);
  assert.equal(status.outputRetention.headLimitReached, true);
  assert.equal(status.outputRetention.runnerLogLoss, false);
  assert.equal(status.outputRetention.completeOriginalOutput, false);
  assert.ok(status.recentOutput.records.some(row => row.text.includes('FINAL: 30 passed, 0 failed')));
  assert.deepEqual(f.store.db.prepare('SELECT sequence,timestamp,stream,CAST(text AS BLOB) AS text_bytes,partial FROM code_records WHERE job_id=? AND sequence<=? ORDER BY sequence').all(job.id, headBefore.at(-1).sequence), headBefore);
  const tail = reopened.logs({ owner: 'jensen', jobId: job.id, view: 'tail', query: '30 passed', stream: 'stdout' });
  assert.equal(tail.records.length, 1);
  assert.equal(tail.hasMore, false); assert.equal(tail.nextCursor, null);
  assert.equal(reopened.logs({ owner: 'jensen', jobId: job.id, query: '30 passed' }).records.length, 0);
  assert.throws(() => reopened.logs({ owner: 'other', jobId: job.id, view: 'tail' }), { code: 'NOT_FOUND' });
  assert.ok(Buffer.byteLength(JSON.stringify(status)) < 12000);
});

test('tail pagination starts newest, filters literally, and stays bounded with tiny fragments', async t => {
  const f = fixture(t);
  const job = f.jobs.start(request()); await f.jobs.tick();
  const name = containerName(job.id);
  f.runner.containers.get(name).records = Array.from({ length: CODE_JOB_LIMITS.logRecords + 20 }, (_, i) => ({ timestamp: '2026-01-01T00:00:00.100Z', stream: i % 2 ? 'stderr' : 'stdout', text: `${i}: [.*]\n` }));
  await f.jobs.tick();
  const status = f.jobs.get({ owner: 'jensen', jobId: job.id });
  assert.equal(status.outputRetention.tailRecords, CODE_JOB_LIMITS.tailRecords);
  assert.equal(status.outputRetention.tailEvictedRecords, CODE_JOB_LIMITS.logRecords + 20 - CODE_JOB_LIMITS.tailRecords);
  assert.ok(status.outputRetention.tailBytes <= CODE_JOB_LIMITS.tailBytes);
  let cursor = 0;
  const seen = [];
  do {
    const page = f.jobs.logs({ owner: 'jensen', jobId: job.id, view: 'tail', cursor, limit: 3, query: '[.*]', stream: 'stderr' });
    assert.deepEqual(page.records.map(row => row.sequence), page.records.map(row => row.sequence).toSorted((a, b) => a - b));
    if (!cursor) assert.equal(page.records.at(-1).sequence, CODE_JOB_LIMITS.logRecords + 20);
    seen.push(...page.records.map(row => row.sequence));
    cursor = page.nextCursor;
    assert.equal(page.hasMore, cursor !== null);
  } while (cursor !== null);
  assert.equal(seen.length, CODE_JOB_LIMITS.tailRecords / 2);
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(f.jobs.logs({ owner: 'jensen', jobId: job.id, view: 'tail', query: '[.+]' }).records.length, 0);
});

test('legacy completed jobs keep their records and disclose unavailable historical tail output', async t => {
  const f = fixture(t);
  const job = f.jobs.start(request()); await f.jobs.tick();
  const name = containerName(job.id);
  f.runner.containers.get(name).records.push({ timestamp: '2026-01-01T00:00:00.100Z', stream: 'stdout', text: 'historical head\n' });
  f.runner.complete(name); await f.jobs.tick();
  f.store.db.exec('DROP TABLE code_tail_records; DROP TABLE code_output_state;');
  f.store.db.prepare('UPDATE code_jobs SET truncated=1 WHERE id=?').run(job.id);
  const original = f.store.db.prepare('SELECT * FROM code_records WHERE job_id=? ORDER BY sequence').all(job.id);
  f.reopenStore();
  const reopened = new CodeJobs(f.options);
  const status = reopened.get({ owner: 'jensen', jobId: job.id });
  assert.equal(status.outputRetention.mode, 'legacy-head-only');
  assert.equal(status.outputRetention.runnerLogLoss, null);
  assert.equal(status.outputRetention.completeOriginalOutput, false);
  assert.equal(status.recentOutput.view, 'head');
  assert.ok(status.recentOutput.records.at(-1).text.includes('COMPLETED exit=0'));
  assert.deepEqual(f.store.db.prepare('SELECT * FROM code_records WHERE job_id=? ORDER BY sequence').all(job.id), original);
  assert.equal(reopened.logs({ owner: 'jensen', jobId: job.id, view: 'tail' }).records.length, 0);
  assert.equal(f.runner.started, 1);
});

test('status commands are compact by default and recent output respects JSON escaping budgets', async t => {
  const f = fixture(t);
  const argv = ['node', '-e', 'x'.repeat(8192)];
  const job = f.jobs.start(request({ argv })); await f.jobs.tick();
  f.runner.containers.get(containerName(job.id)).records.push({ timestamp: '2026-01-01T00:00:00.100Z', stream: 'stdout', text: '\u0000'.repeat(60000) + '🙂 done\n' });
  await f.jobs.tick();
  const status = f.jobs.get({ owner: 'jensen', jobId: job.id });
  assert.equal(status.argvTruncated, true); assert.equal(status.argv[2].length, 256);
  assert.deepEqual(f.jobs.get({ owner: 'jensen', jobId: job.id, includeCommand: true }).argv, argv);
  assert.ok(Buffer.byteLength(JSON.stringify(status.recentOutput)) < CODE_JOB_LIMITS.statusOutputBytes + 300);
  assert.ok(status.recentOutput.records.at(-1).text.endsWith('🙂 done\n'));
  assert.ok(!status.recentOutput.records.some(row => row.text.includes('�')));
});

test('active-job rejection identifies only the requesting owner’s blocker', t => {
  const f = fixture(t), job = f.jobs.start(request());
  assert.throws(() => f.jobs.start(request({ idempotencyKey: 'another-work-1' })), error => error.code === 'ACTIVE_JOB_LIMIT' && error.message.includes(job.id) && !error.message.includes('cancel'));
  assert.throws(() => f.jobs.start(request({ owner: 'other', idempotencyKey: 'another-work-2' })), error => error.code === 'ACTIVE_JOB_LIMIT' && !error.message.includes(job.id) && !error.message.includes(job.workspaceId));
});

test('terminal drain reaches the newest available summary past its bounded sequential-read budget', async t => {
  const f = fixture(t);
  const reader = new PodmanRunner({ image: `sha256:${'b'.repeat(64)}`, workspaceRoot: join(f.directory, 'workspaces'), logDirectory: join(f.directory, 'logs') });
  mkdirSync(reader.logDirectory);
  f.runner.logs = input => reader.logs(input);
  const job = f.jobs.start(request()); await f.jobs.tick();
  const name = containerName(job.id);
  const raw = '2026-01-01T00:00:00.100Z stdout F ' + '🙂'.repeat(1300000) + '\n2026-01-01T00:00:00.900Z stdout F FINAL: 76 passed, 0 failed\n';
  writeFileSync(reader.logPath(name), raw);
  f.runner.complete(name); await f.jobs.tick();
  const status = f.jobs.get({ owner: 'jensen', jobId: job.id });
  assert.equal(status.status, 'completed');
  assert.ok(status.recentOutput.records.some(row => row.text.includes('FINAL: 76 passed, 0 failed')));
  assert.equal(status.outputRetention.runnerLogLoss, true);
  assert.ok(status.outputRetention.skippedContainerLogBytes > 2000000);
  assert.equal(status.outputRetention.completeOriginalOutput, false);
  assert.ok(status.outputRetention.observedOutputBytes < Buffer.byteLength(raw));
  assert.ok(status.outputRetention.tailBytes <= CODE_JOB_LIMITS.tailBytes);
  assert.equal(f.jobs.row('jensen', job.id).runner_cursor, Buffer.byteLength(raw));
  assert.ok(!f.jobs.logs({ owner: 'jensen', jobId: job.id }).records.some(row => row.text.includes('�')));
});

test('real reader preserves UTF-8 across forced long-line cuts and never stalls on malformed bytes', async t => {
  const f = fixture(t);
  const reader = new PodmanRunner({ image: `sha256:${'b'.repeat(64)}`, workspaceRoot: join(f.directory, 'workspaces'), logDirectory: join(f.directory, 'logs') });
  mkdirSync(reader.logDirectory);
  const name = containerName(f.jobs.start(request()).id);
  const text = '🙂'.repeat(100) + '\n';
  writeFileSync(reader.logPath(name), '2026-01-01T00:00:00.100Z stderr F ' + text);
  let cursor = 0, fingerprint, continuation, output = '';
  for (let i = 0; i < 20; i++) {
    const page = await reader.logs({ name, cursor, fingerprint, continuation, limitBytes: 64, final: true });
    assert.ok(page.cursor > cursor);
    assert.ok(page.records.every(row => row.stream === 'stderr'));
    output += page.records.map(row => row.text).join('');
    cursor = page.cursor; fingerprint = page.fingerprint; continuation = page.continuation;
    if (!page.hasMore) break;
  }
  assert.equal(output, text);
  writeFileSync(reader.logPath(name), Buffer.alloc(256, 0x80));
  const malformed = await reader.logs({ name, cursor: 0, limitBytes: 64 });
  assert.equal(malformed.cursor, 64);
});

test('a record terminator exactly after a forced cut closes persisted stream continuation', async t => {
  const f = fixture(t);
  const reader = new PodmanRunner({ image: `sha256:${'b'.repeat(64)}`, workspaceRoot: join(f.directory, 'workspaces'), logDirectory: join(f.directory, 'logs') });
  mkdirSync(reader.logDirectory);
  const name = containerName(f.jobs.start(request()).id);
  const prefix = '2026-01-01T00:00:00.100Z stderr F ';
  const payload = 'x'.repeat(64 - Buffer.byteLength(prefix));
  writeFileSync(reader.logPath(name), prefix + payload + '\n2026-01-01T00:00:00.200Z stdout F last\n');
  const first = await reader.logs({ name, limitBytes: 64 });
  assert.equal(first.cursor, 64); assert.equal(first.continuation.stream, 'stderr');
  const second = await reader.logs({ name, cursor: first.cursor, fingerprint: first.fingerprint, continuation: JSON.parse(JSON.stringify(first.continuation)), limitBytes: 64, final: true });
  assert.deepEqual(second.records.map(row => [row.stream, row.text]), [['stderr', '\n'], ['stdout', 'last\n']]);
  assert.equal(second.continuation, null);
});

test('manager recreation preserves an unfinished stderr record continuation without duplicate execution', async t => {
  const f = fixture(t);
  const reader = new PodmanRunner({ image: `sha256:${'b'.repeat(64)}`, workspaceRoot: join(f.directory, 'workspaces'), logDirectory: join(f.directory, 'logs') });
  mkdirSync(reader.logDirectory);
  f.runner.logs = input => reader.logs(input);
  const job = f.jobs.start(request()); await f.jobs.tick();
  const name = containerName(job.id);
  const payload = '🙂'.repeat(80000) + '\n';
  writeFileSync(reader.logPath(name), '2026-01-01T00:00:00.100Z stderr F ' + payload);
  await f.jobs.tick();
  assert.equal(JSON.parse(f.store.db.prepare('SELECT continuation_json FROM code_output_state WHERE job_id=?').get(job.id).continuation_json).stream, 'stderr');
  f.reopenStore();
  const reopened = new CodeJobs(f.options);
  f.runner.complete(name); await reopened.recover();
  let cursor = 0, recovered = '';
  for (;;) {
    const result = reopened.logs({ owner: 'jensen', jobId: job.id, cursor, stream: 'stderr', limit: 100 });
    recovered += result.records.map(row => row.text).join('');
    cursor = result.nextCursor;
    if (!result.hasMore) break;
  }
  assert.equal(recovered, payload);
  assert.equal(reopened.get({ owner: 'jensen', jobId: job.id }).outputRetention.runnerLogLoss, false);
  assert.equal(f.runner.started, 1);
});
