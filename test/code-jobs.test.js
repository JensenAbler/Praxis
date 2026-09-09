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
  const db = new DatabaseSync(join(directory, 'jobs.sqlite'));
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
  return { directory, workspace, store, runner, jobs, options, setTime(value) { time = value; }, setRevision(value) { revision = value; } };
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
