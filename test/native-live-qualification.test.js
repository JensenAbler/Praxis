import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Script, runInNewContext } from 'node:vm';
import { NativeRootQualification, QualificationPending } from '../scripts/native-root-live-qualification.js';

const sha = value => createHash('sha256').update(value).digest('hex');
function setup() {
  const runId = randomUUID(), state = { runId, fixtureRoot: `/var/lib/praxis-root/acceptance/${runId}`, steps: {}, captures: {}, calls: [], observations: {} };
  const q = new NativeRootQualification({ state, save() {}, rpc: async () => { throw Error('Unexpected RPC'); }, captureDirectory: '/unused', log() {} });
  return { q, state };
}

test('qualification generated programs compile and large stdout/artifact bytes match independent expectations', async () => {
  const { q, state } = setup(), scripts = [], written = new Map(), stdout = [], projectId = randomUUID(), jobId = randomUUID();
  const home = '/fixture-home', size = 2 * 1024 * 1024 + 37;
  q.capabilities = async () => ({ execution: { home, jobsDirectory: '/jobs' } });
  state.steps['hidden-patch'] = { result: {} };
  q.step = async (label, name) => { assert.equal(name, 'host_project_attach'); return { hostProjectId: projectId }; };
  q.job = async (label, argv, extra) => {
    assert.equal(argv[0], 'node'); new Script(argv[2]); scripts.push(label);
    if (label === 'large-output') {
      assert.deepEqual(extra.artifactPaths, ['large.bin']);
      runInNewContext(argv[2], { Buffer, require(name) {
        if (name === 'fs') return { writeFileSync(path, bytes) { written.set(path, bytes); } };
        assert.equal(name, 'is-number'); return () => true;
      }, process: { env: { HOME: home }, stdout: { write: bytes => stdout.push(bytes) }, stderr: { write() {} } } });
    }
    return { id: jobId, timeoutSeconds: 0, network: 'host', outputRetention: { rawLogs: { stdout: `/jobs/praxis-code-${jobId}/stdout.raw` } } };
  };
  q.smallFile = async path => {
    if (path.endsWith('install-report.json')) return { content: JSON.stringify({ uid: 0, cwd: state.fixtureRoot, home, customEnvironment: true, cache: home + '/.npm', packageVersion: '7.0.0' }) };
    if (path.endsWith('/.env')) return { content: 'FIXTURE_VALUE=patched\n' };
    return { content: JSON.stringify({ home, dependency: true }) };
  };
  q.call = async name => {
    const small = Buffer.from([0, 255, 128, 17, 13, 10]);
    if (name === 'host_path_info') return { sha256: sha(small) };
    if (name === 'host_file_read') return { content: small.toString('base64') };
    if (name === 'host_files_list') return { entries: [{ name: '.env' }] };
    if (name === 'host_search') return { matches: [{}] };
    assert.equal(name, 'artifact_list'); return { artifacts: [{ id: 'fixture-artifact', name: 'large.bin', bytes: size, sha256: sha(written.get('large.bin')) }] };
  };
  q.capture = async (label, expected) => {
    const actual = label === 'stdout' ? Buffer.concat(stdout) : written.get('large.bin');
    assert.deepEqual(actual, expected);
    assert.ok(actual.length > 2 * 1024 * 1024);
    return { sha256: sha(actual) };
  };
  await q.prepare(); assert.equal(state.prepared, true); assert.deepEqual(scripts, ['create', 'install', 'large-output']);
});

test('qualification heartbeat generates exactly one start/completion and restart targets only the coding backend', async () => {
  const { q, state } = setup(); state.prepared = true;
  const lines = []; let callback, elapsed = 0n, caps = 0;
  q.capabilities = async () => ({ bootId: `boot-${caps++}` });
  q.startJob = async (label, argv) => {
    if (label === 'heartbeat') {
      new Script(argv[2]);
      runInNewContext(argv[2], { require(name) { assert.equal(name, 'fs'); return { openSync() { return 4; }, writeSync(_fd, line) { lines.push(line); }, fsyncSync() {}, closeSync() {} }; },
        process: { hrtime: { bigint: () => elapsed }, stdout: { write() {} } }, setInterval(fn) { callback = fn; return 1; }, clearInterval() {} });
      for (let index = 0; index < 30; index++) { elapsed += 1000000000n; callback(); }
    } else assert.deepEqual(argv, ['systemctl', 'restart', 'praxis-code.service']);
    state.steps[label] = { result: { id: label } }; return state.steps[label].result;
  };
  q.call = async (name, args) => { assert.equal(name, 'job_status'); assert.equal(args.jobId, 'heartbeat'); return { status: 'running' }; };
  q.observe = async label => ({ id: label, status: 'completed', exitCode: 0, startedAt: '2026-01-01T00:00:01Z', finishedAt: '2026-01-01T00:00:30Z' });
  q.smallFile = async () => ({ content: lines.join(''), sha256: sha(lines.join('')) });
  await q.restart(); assert.equal(lines.length, 32); assert.equal(state.restarted, true); assert.equal(state.observations.restart.elapsedSeconds, 30);
});

test('qualification resumes a saved job request with its original inputs and never repeats a saved admission', async () => {
  const { q, state } = setup(), original = { argv: ['echo', 'original'], idempotencyKey: 'fixture-key' };
  state.steps.run = { name: 'job_start', args: original };
  let calls = 0;
  q.rpc = async (name, args) => { calls++; assert.equal(name, 'job_start'); assert.deepEqual(args, original); return { ok: true, id: 'original-job' }; };
  assert.equal((await q.step('run', 'job_start', { argv: ['different'] })).id, 'original-job');
  assert.equal((await q.step('run', 'job_start', {})).id, 'original-job'); assert.equal(calls, 1);
});

test('uncertain host writes yield for hash recovery without automatic mutation retries', async () => {
  const { q } = setup(); let calls = 0;
  q.rpc = async () => { calls++; return { ok: false, error: { code: 'BACKEND_UNAVAILABLE' } }; };
  await assert.rejects(q.call('host_file_patch', { path: '/fixture', oldText: 'before', newText: 'after' }), QualificationPending);
  assert.equal(calls, 1);
});
