import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodeJobs, CODE_JOB_LIMITS } from '../src/code/jobs.js';
import { CodeStore } from '../src/code/store.js';
import { WorkspaceManager } from '../src/code/workspaces.js';
import { containerName } from '../src/code/runner.js';

class NativeFakeRunner {
  constructor(root) {
    this.kind = 'native-root'; this.image = 'native-root:linux:x64:node-22.22.0';
    this.homeDirectory = join(root, 'home'); mkdirSync(this.homeDirectory);
    this.jobsDirectory = join(root, 'native-jobs');
    this.states = new Map(); this.created = []; this.started = []; this.stopped = [];
  }
  describeLogs(name) {
    return { stdout: join(this.jobsDirectory, name, 'stdout.raw'), stderr: join(this.jobsDirectory, name, 'stderr.raw'), events: join(this.jobsDirectory, name, 'output.log') };
  }
  async create(input) {
    this.created.push(input);
    const name = containerName(input.job.id);
    this.states.set(name, { exists: true, id: name, status: 'created', running: false, records: [] });
    return { name, id: name };
  }
  async start({ name }) {
    this.started.push(name);
    Object.assign(this.states.get(name), { status: 'running', running: true, startedAt: '2026-09-10T00:00:00.000Z' });
  }
  async inspect({ name }) {
    if (this.unavailable) throw Object.assign(new Error('Native launch outcome remains unknown'), { code: 'RUNNER_START_UNCERTAIN' });
    return this.states.get(name) ?? { exists: false };
  }
  async logs({ name, cursor = 0 }) {
    const records = this.states.get(name)?.records ?? [];
    return { records: records.slice(cursor), cursor: records.length, hasMore: false, truncated: false };
  }
  async stop({ name }) {
    this.stopped.push(name); this.complete(name, { exitCode: null, signal: 'SIGTERM', terminationReason: 'cancelled' });
  }
  async remove() { /* Native receipts and output remain durable after unit cleanup. */ }
  complete(name, extra = {}) {
    Object.assign(this.states.get(name), { status: 'exited', running: false, exitCode: 0, terminationReason: 'exit', finishedAt: '2026-09-10T00:00:02.000Z', ...extra });
  }
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'praxis-native-jobs-'));
  const dataDirectory = join(root, 'state'), workspaceDirectory = join(root, 'workspaces'), snapshotPath = join(root, 'snapshot');
  const projectRoot = join(root, 'host-project'), recordingRoot = join(root, 'recordings');
  for (const path of [snapshotPath, projectRoot, recordingRoot]) mkdirSync(path);
  writeFileSync(join(snapshotPath, 'source.txt'), 'initial\n');
  const projects = [{ id: 'fixture', name: 'Native workspace fixture', revision: 'a'.repeat(40), snapshotPath }];
  const runner = new NativeFakeRunner(root), resolutions = [];
  let store, jobs, workspaces, time = '2026-09-10T00:00:00.000Z';
  const host = {
    resolvePath(input) {
      resolutions.push(input);
      if (input.owner !== 'jensen' || input.hostProjectId !== 'podcast') throw Object.assign(new Error('Project missing'), { code: 'NOT_FOUND' });
      return input.dataRoot === 'recordings' ? recordingRoot : projectRoot;
    },
  };
  function open() {
    store = new CodeStore(dataDirectory);
    workspaces = new WorkspaceManager({ store, dataDirectory, workspaceDirectory, native: true, projects });
    jobs = new CodeJobs({ store, dataDirectory, runner, workspaces, host, dependencyDirectory: join(root, 'dependencies'), clock: () => time });
  }
  open();
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, dataDirectory, projectRoot, recordingRoot, runner, resolutions,
    get store() { return store; }, get jobs() { return jobs; }, get workspaces() { return workspaces; },
    setTime(value) { time = value; }, reopen() { store.close(); open(); return jobs; },
    workspace() {
      return workspaces.create({ owner: 'jensen', projectId: 'fixture', baseRevision: projects[0].revision, idempotencyKey: 'native-workspace-create' }).result;
    },
  };
}
const request = extra => ({ owner: 'jensen', idempotencyKey: 'native-host-job-0001', argv: ['node', '--version'], ...extra });
const status = (f, job) => f.jobs.get({ owner: 'jensen', jobId: job.id });

test('native host jobs run concurrently with no default deadline and preserve arbitrary argv, absolute cwd, and environment', async t => {
  const f = fixture(t), custom = join(f.root, 'ordinary-host-path'); mkdirSync(custom);
  const input = request({ cwd: custom, env: { NODE_OPTIONS: '--trace-warnings', HOME: custom, CUSTOM_SETTING: 'literal $(value)' }, argv: ['sh', '-c', 'echo "$CUSTOM_SETTING"', 'x'.repeat(40000)] });
  const first = f.jobs.start(input);
  const second = f.jobs.start(request({ idempotencyKey: 'native-host-job-0002' }));
  const third = f.jobs.start(request({ idempotencyKey: 'native-host-job-0003', timeoutSeconds: 2000 }));
  for (let n = 0; n < 3; n++) await f.jobs.tick();
  assert.deepEqual([first, second, third].map(job => status(f, job).status), ['running', 'running', 'running']);
  const admitted = f.runner.created.find(({ job }) => job.id === first.id).job;
  assert.deepEqual(admitted.argv, input.argv); assert.deepEqual(admitted.env, input.env);
  assert.equal(admitted.cwd, custom); assert.equal(admitted.timeoutSeconds, 0); assert.equal(admitted.network, 'host');
  assert.equal(first.workspaceId, null); assert.equal(first.executionUser, 'root'); assert.equal(first.workingDirectory, custom);
  assert.equal(second.workingDirectory, f.runner.homeDirectory);
  f.setTime('2027-09-10T00:00:00.000Z');
  await f.jobs.tick(); await f.jobs.tick();
  assert.equal(status(f, first).status, 'running'); assert.equal(status(f, second).status, 'running');
  assert.deepEqual(f.runner.stopped, []);
});

test('native request identity and running work survive reopening the real store without another launch', async t => {
  const f = fixture(t), input = request({ cwd: f.projectRoot, env: { CUSTOM_SETTING: 'persisted' } });
  const job = f.jobs.start(input); await f.jobs.tick();
  f.runner.states.get(containerName(job.id)).records.push({ timestamp: '2026-09-10T00:00:01Z', stream: 'stdout', text: 'saved output\n' });
  f.reopen(); await f.jobs.recover();
  assert.equal(f.jobs.start(input).id, job.id); assert.equal(status(f, job).status, 'running');
  assert.throws(() => f.jobs.start({ ...input, env: { CUSTOM_SETTING: 'different' } }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.throws(() => f.jobs.get({ owner: 'other', jobId: job.id }), { code: 'NOT_FOUND' });
  f.runner.complete(containerName(job.id)); await f.jobs.tick(); f.reopen();
  assert.equal(f.jobs.start(input).id, job.id); assert.equal(status(f, job).status, 'completed');
  assert.equal(f.runner.created.length, 1); assert.equal(f.runner.started.length, 1);
  const recovered = f.jobs.logs({ owner: 'jensen', jobId: job.id });
  assert.ok(recovered.records.some(row => row.text === 'saved output\n'));
  assert.equal(recovered.outputRetention.mode, 'durable-native-files-with-searchable-excerpts');
  assert.deepEqual(recovered.outputRetention.rawLogs, f.runner.describeLogs(containerName(job.id)));
});

test('native project jobs pin the resolved project/data directory and listing keeps their project identity', async t => {
  const f = fixture(t);
  const input = request({ hostProjectId: 'podcast', dataRoot: 'recordings', cwd: '..' });
  const job = f.jobs.start(input);
  assert.equal(job.workingDirectory, resolve(f.recordingRoot, '..'));
  assert.deepEqual(f.resolutions, [{ owner: 'jensen', hostProjectId: 'podcast', dataRoot: 'recordings', path: '.' }]);
  assert.equal(f.jobs.list({ owner: 'jensen', hostProjectId: 'podcast' }).jobs[0].id, job.id);
  assert.equal(f.jobs.list({ owner: 'jensen', hostProjectId: 'other' }).jobs.length, 0);
  await f.jobs.tick();
  assert.equal(f.runner.created[0].job.cwd, job.workingDirectory);
  assert.equal(f.resolutions.length, 1, 'The admitted directory remains pinned if the project registration later changes');
  assert.equal(f.jobs.start(input).id, job.id);
  assert.throws(() => f.jobs.start(request({ idempotencyKey: 'native-project-missing', hostProjectId: 'missing' })), { code: 'NOT_FOUND' });
});

test('native timeout and cancellation evidence remain explicit after recovery, including signal-only exits', async t => {
  const f = fixture(t), timed = f.jobs.start(request({ timeoutSeconds: 10 }));
  await f.jobs.tick();
  f.runner.complete(containerName(timed.id), { exitCode: null, signal: 'SIGTERM', terminationReason: 'timeout' });
  f.reopen(); await f.jobs.recover();
  assert.equal(status(f, timed).status, 'timed_out'); assert.equal(status(f, timed).terminationReason, 'timeout');
  assert.equal(status(f, timed).signal, 'SIGTERM'); assert.equal(status(f, timed).exitCode, null);
  const canceled = f.jobs.start(request({ idempotencyKey: 'native-cancel-job-0002' })); await f.jobs.tick();
  f.jobs.cancel({ owner: 'jensen', jobId: canceled.id }); await f.jobs.tick();
  assert.equal(status(f, canceled).status, 'cancelled'); assert.equal(status(f, canceled).terminationReason, 'cancelled');
  assert.deepEqual(f.runner.stopped, [containerName(canceled.id)]);
});

test('native ambiguous admission stays recoverable and is never treated as permission to execute again', async t => {
  const f = fixture(t), job = f.jobs.start(request()); await f.jobs.tick();
  f.runner.unavailable = true; f.reopen(); await f.jobs.recover();
  assert.equal(status(f, job).status, 'running'); assert.equal(status(f, job).executionError, 'RUNNER_START_UNCERTAIN');
  assert.equal(f.jobs.start(request()).id, job.id); await f.jobs.tick();
  assert.equal(f.runner.started.length, 1);
  f.runner.unavailable = false; f.runner.complete(containerName(job.id)); await f.jobs.recover();
  assert.equal(status(f, job).status, 'completed'); assert.equal(status(f, job).executionError, null);
});

test('native host artifacts larger than the previous total cap are immutable, hashed, and page-readable', async t => {
  const f = fixture(t), source = join(f.projectRoot, 'large-result.bin');
  const bytes = Buffer.alloc(CODE_JOB_LIMITS.artifactTotalBytes + 123, 169); writeFileSync(source, bytes);
  const job = f.jobs.start(request({ cwd: f.projectRoot, artifactPaths: [source] }));
  await f.jobs.tick(); f.runner.complete(containerName(job.id)); await f.jobs.tick(); f.reopen();
  const final = status(f, job); assert.equal(final.status, 'completed'); assert.deepEqual(final.artifactErrors, []);
  const artifact = f.jobs.artifactList({ owner: 'jensen', jobId: job.id }).artifacts[0];
  assert.equal(artifact.bytes, bytes.length); assert.equal(artifact.sha256, createHash('sha256').update(bytes).digest('hex'));
  writeFileSync(source, 'source changed after capture');
  let cursor = 0; const chunks = [];
  for (;;) {
    const page = f.jobs.artifactRead({ owner: 'jensen', jobId: job.id, artifactId: artifact.id, cursor, limit: 32768 });
    chunks.push(Buffer.from(page.content, 'base64')); cursor = page.nextCursor; if (!page.hasMore) break;
  }
  assert.deepEqual(Buffer.concat(chunks), bytes);
});

test('native host artifact capture follows an explicitly requested file symlink', async t => {
  const f = fixture(t), target = join(f.recordingRoot, 'outside.txt'), link = join(f.projectRoot, 'recording.txt');
  writeFileSync(target, 'explicit linked host output');
  try { symlinkSync(target, link, 'file'); } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Windows account lacks file symlink privilege'); return; }
    throw error;
  }
  const job = f.jobs.start(request({ cwd: f.projectRoot, artifactPaths: ['recording.txt'] }));
  await f.jobs.tick(); f.runner.complete(containerName(job.id)); await f.jobs.tick();
  assert.deepEqual(status(f, job).artifactErrors, []);
  const artifact = f.jobs.artifactList({ owner: 'jensen', jobId: job.id }).artifacts[0];
  const result = f.jobs.artifactRead({ owner: 'jensen', jobId: job.id, artifactId: artifact.id });
  assert.equal(Buffer.from(result.content, 'base64').toString(), 'explicit linked host output');
});

test('native workspace jobs retain revision checks, refresh changed source, and recover dependency preparation identity', async t => {
  const f = fixture(t), workspace = f.workspace(), before = f.workspaces.getExecutionWorkspace({ owner: 'jensen', workspaceId: workspace.workspaceId });
  const input = request({ workspaceId: workspace.workspaceId, expectedRevision: before.revision, cwd: f.projectRoot });
  assert.throws(() => f.jobs.start({ ...input, expectedRevision: 'stale' }), { code: 'STALE_REVISION' });
  const job = f.jobs.start(input); await f.jobs.tick();
  assert.equal(f.runner.created[0].job.cwd, f.projectRoot, 'A workspace job can explicitly choose an ordinary absolute host directory');
  writeFileSync(join(before.path, 'source.txt'), 'changed by command\n');
  f.runner.complete(containerName(job.id)); await f.jobs.tick();
  const final = status(f, job), inspected = f.workspaces.inspect({ owner: 'jensen', workspaceId: workspace.workspaceId });
  assert.equal(final.status, 'completed'); assert.notEqual(final.revisionAfter, before.revision);
  assert.equal(final.revisionAfter, inspected.revision); assert.equal(final.revisionVerified, true);
  f.reopen(); assert.equal(f.jobs.start(input).id, job.id);
  const prepare = { owner: 'jensen', workspaceId: workspace.workspaceId, expectedRevision: inspected.revision, idempotencyKey: 'native-dependencies-0001' };
  const preparation = f.jobs.prepareDependencies(prepare);
  assert.equal(preparation.timeoutSeconds, 0);
  f.runner.image = 'native-root:linux:x64:node-24.1.0';
  f.reopen();
  assert.equal(f.jobs.prepareDependencies(prepare).id, preparation.id, 'Recovery retains the original operation when the native Node identity changes');
  assert.equal(readFileSync(join(before.path, 'source.txt'), 'utf8'), 'changed by command\n');
});

test('native migration recovers terminal legacy commands and implicit-timeout dependency requests without launching them', async t => {
  const f = fixture(t), workspace = f.workspace(), state = f.workspaces.getExecutionWorkspace({ owner: 'jensen', workspaceId: workspace.workspaceId });
  delete f.runner.kind; f.runner.image = `sha256:${'b'.repeat(64)}`;
  const legacy = new CodeJobs({ store: f.store, dataDirectory: f.dataDirectory, runner: f.runner, workspaces: f.workspaces,
    dependencyDirectory: join(f.root, 'dependencies'), clock: () => '2026-09-10T00:00:00.000Z' });
  const input = request({ workspaceId: workspace.workspaceId, expectedRevision: state.revision });
  const command = legacy.start(input); await legacy.tick(); f.runner.complete(containerName(command.id)); await legacy.tick();
  assert.equal(legacy.get({ owner: 'jensen', jobId: command.id }).status, 'completed');
  const preparationInput = { owner: 'jensen', workspaceId: workspace.workspaceId, expectedRevision: state.revision, idempotencyKey: 'legacy-dependency-0001' };
  const preparation = legacy.prepareDependencies(preparationInput);
  assert.equal(preparation.timeoutSeconds, 300);
  await legacy.tick(); f.runner.complete(containerName(preparation.id), { exitCode: 1 }); await legacy.tick();
  assert.equal(legacy.get({ owner: 'jensen', jobId: preparation.id }).status, 'failed');
  const launches = f.runner.started.length;
  f.runner.kind = 'native-root'; f.runner.image = 'native-root:linux:x64:node-24.1.0';
  f.reopen(); await f.jobs.recover();
  assert.equal(f.jobs.start(input).id, command.id);
  const recovered = f.jobs.prepareDependencies(preparationInput);
  assert.equal(recovered.id, preparation.id); assert.equal(recovered.timeoutSeconds, 300); assert.equal(recovered.status, 'failed');
  assert.equal(status(f, command).executionMode, undefined);
  assert.equal(status(f, command).outputRetention.mode, 'head-and-tail');
  assert.throws(() => f.jobs.start({ ...input, argv: ['different'] }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.throws(() => f.jobs.prepareDependencies({ ...preparationInput, timeoutSeconds: 1 }), { code: 'IDEMPOTENCY_CONFLICT' });
  await f.jobs.tick();
  assert.equal(f.runner.started.length, launches); assert.equal(f.runner.created.length, launches);
});
