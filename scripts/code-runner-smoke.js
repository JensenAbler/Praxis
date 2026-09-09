import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statfsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CodeStore } from '../src/code/store.js';
import { WorkspaceManager } from '../src/code/workspaces.js';
import { CodeJobs, CODE_JOB_LIMITS } from '../src/code/jobs.js';
import { PodmanRunner, containerName } from '../src/code/runner.js';

// Run only as the dedicated executor under the same hardened systemd policy as the real service.
assert.equal(process.platform, 'linux', 'This script requires the actual Linux executor.');
assert.notEqual(process.getuid(), 0, 'Never run repository or fixture code as host root.');
const runId = randomUUID();
const image = process.env.PRAXIS_SMOKE_IMAGE;
assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
const root = join('/var/lib/praxis-code/fixtures', runId);
const source = join(root, 'source');
const dataDirectory = join(root, 'state');
const workspaceDirectory = join('/srv/praxis-code/storage/workspaces', `smoke-${runId}`);
const logDirectory = join('/srv/praxis-code/storage/container-logs', `smoke-${runId}`);
mkdirSync(source, { recursive: true, mode: 0o700 });
writeFileSync(join(source, 'package.json'), '{"name":"praxis-runner-fixture","private":true,"type":"module","scripts":{"test":"node --test"}}\n');
writeFileSync(join(source, 'sum.js'), 'export const sum = (a, b) => a - b;\n');
writeFileSync(join(source, 'sum.test.js'), 'import test from "node:test"; import assert from "node:assert/strict"; import {sum} from "./sum.js"; test("sum",()=>assert.equal(sum(2,3),5));\n');
const sentinel = join(root, 'private-sentinel.txt');
writeFileSync(sentinel, `private-fixture-${runId}`, { mode: 0o600 });
const projects = [{ id: 'runner-fixture', name: 'Runner acceptance fixture', repository: 'fixture://local', revision: 'fixture-v1', snapshotPath: source, validationCommands: [['node', '--test']], instructions: 'Disposable generic test fixture.' }];
const runner = new PodmanRunner({ image, workspaceRoot: workspaceDirectory, logDirectory,
  storageRoot: '/srv/praxis-code/storage/containers', runRoot: '/run/praxis-code/storage',
  env: { HOME: '/var/lib/praxis-code', XDG_RUNTIME_DIR: '/run/praxis-code', CONTAINERS_STORAGE_CONF: '/etc/praxis-code/storage.conf' } });
const invoke = runner.invoke;
runner.invoke = async (...args) => {
  const result = await invoke(...args);
  // Synthetic inputs only. Keep operational diagnostics in this private fixture log, not public MCP errors.
  if (result.code !== 0) process.stdout.write(JSON.stringify({ event: 'RUNNER_DIAGNOSTIC', code: result.code, stderr: result.stderr.slice(0, 3000) }) + '\n');
  return result;
};
let store, jobs, workspaces;
function reopen() {
  store?.close();
  store = new CodeStore(dataDirectory);
  jobs = new CodeJobs({ store, dataDirectory, runner });
  workspaces = new WorkspaceManager({ store, dataDirectory, workspaceDirectory, projects });
  jobs.workspaces = workspaces;
}
reopen();
const owner = 'jensen';
const evidence = { runId, evidenceType: 'actual-rootless-container-fixture', startedAt: new Date().toISOString(), image, hostUid: process.getuid(), checks: [], jobs: [] };
const check = (name, observed) => { evidence.checks.push({ name, passed: true, observed }); process.stdout.write(JSON.stringify({ event: 'CHECK', name, observed }) + '\n'); };
const current = workspaceId => workspaces.getExecutionWorkspace({ owner, workspaceId });
const start = (workspaceId, args) => jobs.start({ owner, workspaceId, expectedRevision: current(workspaceId).revision, idempotencyKey: `smoke-${randomUUID()}`, ...args });
async function wait(jobId, maximumMs = 180000) {
  const deadline = Date.now() + maximumMs;
  while (Date.now() < deadline) {
    await jobs.tick();
    const job = jobs.get({ owner, jobId });
    if (!['queued', 'starting', 'running', 'canceling'].includes(job.status)) { evidence.jobs.push({ id: job.id, status: job.status, exitCode: job.exitCode, terminationReason: job.terminationReason, executionError: job.executionError }); return job; }
    await delay(200);
  }
  throw new Error('The fixture job did not become terminal within its observation deadline.');
}
function allLogs(jobId) {
  const records = []; let cursor = 0, pages = 0;
  for (;;) {
    const result = jobs.logs({ owner, jobId, cursor, limit: 5 });
    assert.ok(result.nextCursor >= cursor); records.push(...result.records); pages++;
    cursor = result.nextCursor;
    if (!result.hasMore) return { records, pages, text: records.filter(row => row.stream !== 'system').map(row => row.text).join(''), truncated: result.truncated };
    assert.ok(pages < 3000, 'Log pagination must terminate.');
  }
}
function cgroupEvidence(pid) {
  const membership = readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim();
  const line = membership.split('\n').find(value => value.startsWith('0::'));
  assert.ok(line, 'Unified cgroup v2 membership is required.');
  const rootPath = '/sys/fs/cgroup';
  let path = resolve(rootPath, `.${line.slice(3)}`);
  assert.ok(path.startsWith(`${rootPath}/`));
  const ancestors = [];
  while (path.startsWith(rootPath)) {
    const value = { path };
    for (const file of ['memory.max', 'memory.swap.max', 'pids.max', 'cpu.max']) {
      try { value[file] = readFileSync(join(path, file), 'utf8').trim(); } catch { value[file] = null; }
    }
    ancestors.push(value);
    if (path === rootPath) break;
    path = dirname(path);
  }
  assert.ok(ancestors.some(value => value['memory.max'] === '1610612736'));
  assert.ok(ancestors.some(value => value['memory.swap.max'] === '0'));
  assert.ok(ancestors.some(value => value['pids.max'] === '256'));
  assert.ok(ancestors.some(value => value['cpu.max'] === '100000 100000'));
  return { pid, membership, ancestors };
}

try {
  const created = workspaces.create({ owner, projectId: 'runner-fixture', baseRevision: 'fixture-v1', idempotencyKey: `workspace-${runId}`, label: 'Runner acceptance fixture' });
  const workspaceId = created.result.workspaceId;
  const other = workspaces.create({ owner, projectId: 'runner-fixture', baseRevision: 'fixture-v1', idempotencyKey: `other-${runId}`, label: 'Unrelated fixture workspace' });
  const otherPath = current(other.result.workspaceId).path;
  check('isolated_workspace_created', { workspaceId, otherWorkspaceId: other.result.workspaceId });

  const failing = start(workspaceId, { argv: ['node', '--test'], timeoutSeconds: 20 });
  const failed = await wait(failing.id);
  assert.equal(failed.status, 'failed'); assert.notEqual(failed.exitCode, 0);
  check('real_failing_test', { jobId: failed.id, exitCode: failed.exitCode });

  const file = workspaces.read({ owner, workspaceId, path: 'sum.js' });
  assert.throws(() => workspaces.apply({ owner, workspaceId, expectedRevision: current(workspaceId).revision, idempotencyKey: `stale-${runId}`, changes: [{ action: 'write', path: 'sum.js', expectedSha256: '0'.repeat(64), content: 'no' }] }), { code: 'HASH_CONFLICT' });
  assert.throws(() => workspaces.read({ owner, workspaceId, path: '../private-sentinel.txt' }));
  workspaces.apply({ owner, workspaceId, expectedRevision: current(workspaceId).revision, idempotencyKey: `fix-${runId}`, changes: [{ action: 'patch', path: 'sum.js', expectedSha256: file.sha256, oldText: 'a - b', newText: 'a + b' }] });
  const passing = await wait(start(workspaceId, { argv: ['node', '--test'], timeoutSeconds: 20 }).id);
  assert.equal(passing.status, 'completed'); assert.equal(passing.exitCode, 0);
  check('source_fix_and_real_passing_test', { jobId: passing.id, staleHashRejected: true, traversalRejected: true });

  const script = `import assert from 'node:assert/strict'; import fs from 'node:fs';
    const denied = ${JSON.stringify([sentinel, join(otherPath, 'sum.js'), '/etc/praxis-probe/credentials/password-hash', '/var/run/docker.sock'])};
    for (const path of denied) assert.throws(()=>fs.readFileSync(path));
    assert.throws(()=>fs.writeFileSync('/etc/praxis-smoke-write','no'));
    assert.deepEqual(fs.readdirSync('/sys/class/net').sort(),['lo']);
    fs.writeFileSync('writable.txt','workspace is writable');
    fs.symlinkSync('/etc/passwd','unsafe-link.txt');
    console.log(JSON.stringify({fixture:'isolation',hostPathsDenied:denied.length,networkInterfaces:['lo'],rootReadOnly:true,workspaceWritable:true,uid:process.getuid()}));
    await new Promise(resolve=>setTimeout(resolve,10000));
    fs.writeFileSync('report.json', JSON.stringify({ok:true,marker:'preserved-artifact'}));
    console.log('SMOKE_COMPLETED');`;
  const isolationRequest = { owner, workspaceId, expectedRevision: current(workspaceId).revision, idempotencyKey: `isolation-${runId}`, argv: ['node', '--input-type=module', '-e', script], timeoutSeconds: 30, artifactPaths: ['report.json', 'unsafe-link.txt'] };
  const isolation = jobs.start(isolationRequest);
  assert.equal(jobs.start(isolationRequest).id, isolation.id);
  assert.throws(() => start(workspaceId, { argv: ['true'], timeoutSeconds: 1 }), { code: 'ACTIVE_JOB_LIMIT' });
  await jobs.tick();
  const running = await runner.inspect({ name: containerName(isolation.id) });
  assert.equal(running.running, true);
  const cgroups = cgroupEvidence(running.pid);
  const raw = await runner.call(['container', 'inspect', containerName(isolation.id)]);
  assert.equal(raw.code, 0);
  const inspected = JSON.parse(raw.stdout)[0];
  assert.equal(inspected.HostConfig.NetworkMode, 'none');
  assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
  const mounts = inspected.Mounts.map(mount => ({ destination: mount.Destination, type: mount.Type, writable: mount.RW }));
  assert.deepEqual(mounts.filter(mount => mount.type === 'bind').map(mount => mount.destination), ['/workspace']);
  check('actual_cgroup_network_and_mount_policy', { cgroups, networkMode: inspected.HostConfig.NetworkMode, readOnlyRootfs: inspected.HostConfig.ReadonlyRootfs, mounts });
  // Reopen all private service state while the real container is still running.
  reopen(); await jobs.recover();
  assert.equal(jobs.get({ owner, jobId: isolation.id }).status, 'running');
  const isolated = await wait(isolation.id);
  assert.equal(isolated.status, 'completed');
  const output = allLogs(isolation.id);
  assert.match(output.text, /SMOKE_COMPLETED/); assert.equal(output.truncated, false);
  const artifacts = jobs.artifactList({ owner, jobId: isolation.id }).artifacts;
  assert.equal(artifacts.length, 1); assert.equal(artifacts[0].name, 'report.json');
  assert.deepEqual(isolated.artifactErrors, [{ path: 'unsafe-link.txt', code: 'UNSAFE_ARTIFACT' }]);
  const artifact = jobs.artifactRead({ owner, jobId: isolation.id, artifactId: artifacts[0].id });
  const artifactBytes = Buffer.from(artifact.content, 'base64');
  assert.equal(createHash('sha256').update(artifactBytes).digest('hex'), artifacts[0].sha256);
  assert.equal(JSON.parse(artifactBytes).marker, 'preserved-artifact');
  check('running_job_recovery_idempotency_logs_artifacts', { jobId: isolation.id, logPages: output.pages, records: output.records.length, artifactId: artifacts[0].id, unsafeArtifactRejected: true });

  const timed = start(workspaceId, { argv: ['node', '-e', 'setInterval(()=>{},1000)'], timeoutSeconds: 1 });
  await jobs.tick();
  // Do not tick the worker: conmon's independent timer must terminate the actual container.
  await delay(2500);
  const timedState = await runner.inspect({ name: containerName(timed.id) });
  assert.equal(timedState.running, false);
  check('independent_timer_stopped_container', { state: timedState });
  const timedOut = await wait(timed.id);
  assert.ok(['timed_out', 'interrupted'].includes(timedOut.status));
  assert.ok(['timeout', 'timeout_inferred', 'exit_unconfirmed'].includes(timedOut.terminationReason));
  assert.ok(timedOut.exitCode === null || timedOut.exitCode >= 0);
  check('independent_container_timeout', { jobId: timed.id, exitCode: timedOut.exitCode, status: timedOut.status, terminationReason: timedOut.terminationReason, automaticallyRestarted: false });

  const cancellation = start(workspaceId, { argv: ['node', '-e', 'setInterval(()=>{},1000)'], timeoutSeconds: 15 });
  await jobs.tick(); jobs.cancel({ owner, jobId: cancellation.id });
  const cancelled = await wait(cancellation.id); assert.equal(cancelled.status, 'cancelled');
  check('actual_running_command_cancellation', { jobId: cancelled.id, status: cancelled.status });

  const noisy = start(workspaceId, { argv: ['node', '-e', `process.stdout.write('x'.repeat(${CODE_JOB_LIMITS.logBytes + 10000}))`], timeoutSeconds: 20 });
  const noisyResult = await wait(noisy.id);
  assert.equal(noisyResult.status, 'completed'); assert.equal(noisyResult.truncated, true);
  assert.ok(noisyResult.outputBytes <= CODE_JOB_LIMITS.logBytes);
  check('bounded_real_output', { jobId: noisy.id, outputBytes: noisyResult.outputBytes, truncated: noisyResult.truncated });

  const ambiguous = start(workspaceId, { argv: ['node', '-e', 'require("node:fs").writeFileSync("must-not-run.txt","bad")'], timeoutSeconds: 10 });
  store.db.prepare("UPDATE code_jobs SET status='starting' WHERE id=?").run(ambiguous.id);
  const prepared = await runner.create({ job: { ...ambiguous, env: {} }, workspacePath: current(workspaceId).path });
  store.db.prepare('UPDATE code_jobs SET container_id=?,runner_cursor=?,log_fingerprint=? WHERE id=?').run(prepared.id, prepared.logCursor, prepared.logFingerprint, ambiguous.id);
  reopen(); await jobs.recover();
  assert.equal(jobs.get({ owner, jobId: ambiguous.id }).status, 'interrupted');
  assert.equal(existsSync(join(current(workspaceId).path, 'must-not-run.txt')), false);
  check('prepared_execution_recovery_does_not_start_command', { jobId: ambiguous.id, status: 'interrupted', markerAbsent: true });

  const diff = workspaces.diff({ owner, workspaceId, expectedRevision: current(workspaceId).revision });
  assert.match(diff.diff, /a \+ b/);
  const filesystem = statfsSync(workspaceDirectory);
  const capacity = Number(filesystem.blocks) * Number(filesystem.bsize);
  assert.ok(capacity > 7 * 1024 ** 3 && capacity <= 8 * 1024 ** 3, 'Workspaces must live on the bounded 8 GiB filesystem.');
  check('review_diff_and_actual_storage_boundary', { changedFiles: diff.changedFileCount, filesystemCapacityBytes: capacity, stressTestPerformed: false });
  evidence.completedAt = new Date().toISOString(); evidence.passed = true;
} catch (error) {
  evidence.completedAt = new Date().toISOString(); evidence.passed = false;
  evidence.failure = { name: error.name, code: error.code ?? null, message: error.message.slice(0, 1000) };
  process.exitCode = 1;
} finally {
  writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify({ event: 'RESULT', ...evidence }) + '\n');
  store?.close();
}
