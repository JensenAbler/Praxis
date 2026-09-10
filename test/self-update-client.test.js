import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { SelfUpdateQualification, SOURCE_FRESHNESS, releaseOperationId } from '../scripts/autonomy-self-update.js';
import { parseCodeCall } from '../src/code/schema.js';
import { releaseTools } from '../src/release-schema.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const state = () => ({ runId: randomUUID(), steps: {}, calls: [], observations: {} });
const client = (saved, rpc, options = {}) => new SelfUpdateQualification({ state: saved, save() {}, rpc, log() {}, ...options });

function retryFixture({ originalStatus = 'failed', originalExit = 1, image = 'sha256:corrected-image' } = {}) {
  const saved = state(), calls = [], workspaceId = randomUUID(), revision = 'd'.repeat(64);
  const oldJobId = randomUUID(), installJobId = randomUUID(), retryJobId = randomUUID(), syncId = randomUUID();
  const source = `export const fixture = {\n        usage: { sourceFreshness: ${JSON.stringify(SOURCE_FRESHNESS)} }\n};\n`;
  const key = label => `self-update-v05:${saved.runId}:${label}`;
  const validationArgs = { workspaceId, expectedRevision: revision, argv: ['npm', 'test'], network: 'none',
    env: { CI: 'true', NODE_ENV: 'test' }, timeoutSeconds: 900, label: 'Offline Praxis full suite', idempotencyKey: key('validate') };
  const originalJob = { id: oldJobId, workspaceId, status: originalStatus, exitCode: originalExit,
    expectedRevision: revision, revisionAfter: revision, revisionVerified: true };
  saved.validationStep = 'validate-after-image-fix';
  saved.validationImage = 'sha256:corrected-image';
  saved.workspaceId = workspaceId; saved.expectedSourceSha256 = sha(source);
  saved.steps = {
    'sync-base': { name: 'project_sync', args: { projectId: 'praxis', idempotencyKey: key('sync-base') }, result: { operationId: syncId } },
    workspace: { name: 'workspace_create', args: {}, result: { status: 'completed', workspaceId } },
    edit: { name: 'workspace_apply', args: {}, result: { status: 'completed', result: { revision } } },
    install: { name: 'job_start', args: { idempotencyKey: key('install') }, result: { id: installJobId } },
    validate: { name: 'job_start', args: validationArgs, result: { id: oldJobId, status: originalStatus } }
  };
  const rpc = async (name, args) => {
    if (releaseTools[name]) releaseTools[name].schema.strict().parse(args); else parseCodeCall(name, args);
    calls.push({ name, args });
    const ok = value => ({ ok: true, ...value });
    if (name === 'capabilities') return ok({ dependencies: { registryAccessEnabled: true }, selfImprovement: { enabled: true },
      execution: { imageDigest: image }, usage: {} });
    if (name === 'git_operation_status') return ok({ operationId: syncId, status: 'completed', result: { commit: 'a'.repeat(40) } });
    if (name === 'job_status') {
      if (args.jobId === oldJobId) return ok(originalJob);
      assert.ok([installJobId, retryJobId].includes(args.jobId));
      return ok({ id: args.jobId, workspaceId, status: 'completed', exitCode: 0, revisionAfter: revision, revisionVerified: true });
    }
    if (name === 'job_start') return ok({ id: retryJobId });
    if (name === 'file_read') return ok({ sha256: sha(source), revision, nextPosition: null,
      lines: source.split('\n').map((text, index) => ({ number: index + 1, text })) });
    if (name === 'workspace_diff') return ok({ revision, changedFileCount: 1, changes: [{ path: 'src/code/server.js' }],
      diff: SOURCE_FRESHNESS, totalBytes: Buffer.byteLength(SOURCE_FRESHNESS), nextCursor: null });
    if (name === 'praxis_release_status') return ok({ active: { release: 'old' } });
    if (name === 'workspace_inspect') return ok({ workspaceId, revision, status: 'ready' });
    assert.fail('Unexpected retry fixture request: ' + name);
  };
  return { saved, calls, rpc, originalJob, oldJobId, installJobId, retryJobId, revision };
}

test('explicit image-fix validation retry preserves the failed job and source, uses a new key, and recovers both jobs read-only', async () => {
  const f = retryFixture(), originalReceipt = structuredClone(f.saved.steps.validate);
  await client(f.saved, f.rpc).prepare();
  const starts = f.calls.filter(call => call.name === 'job_start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].args.expectedRevision, originalReceipt.args.expectedRevision);
  assert.equal(starts[0].args.workspaceId, originalReceipt.args.workspaceId);
  assert.equal(starts[0].args.network, 'none');
  assert.deepEqual(starts[0].args.argv, ['npm', 'test']);
  assert.notEqual(starts[0].args.idempotencyKey, originalReceipt.args.idempotencyKey);
  assert.equal(starts[0].args.idempotencyKey, client(f.saved, f.rpc).key('validate-after-image-fix'));
  assert.ok(f.calls.findIndex(call => call.name === 'job_status' && call.args.jobId === f.oldJobId) < f.calls.indexOf(starts[0]));
  assert.deepEqual(f.saved.steps.validate, originalReceipt);
  assert.equal(f.saved.observations.validationRetry.originalJob.status, 'failed');
  assert.equal(f.saved.observations.validationRetry.imageDigest, f.saved.validationImage);
  assert.equal(f.saved.validatedJobId, f.retryJobId);
  assert.equal(f.saved.validatedRevision, f.revision);
  await client(f.saved, f.rpc).prepare();
  assert.equal(f.calls.filter(call => call.name === 'job_start').length, 1, 'Resume must not submit another retry job');
  const before = f.calls.length;
  await client(f.saved, f.rpc).recover();
  const recovered = f.calls.slice(before);
  assert.ok(recovered.every(call => /status$|inspect$|_read$|^capabilities$/.test(call.name)));
  assert.deepEqual(new Set(recovered.filter(call => call.name === 'job_status').map(call => call.args.jobId)),
    new Set([f.installJobId, f.oldJobId, f.retryJobId]));
});

test('validation retry refuses running, successful, or non-explicit original exits without submitting a job', async () => {
  for (const [originalStatus, originalExit] of [['running', null], ['completed', 0], ['failed', 0], ['failed', null]]) {
    const f = retryFixture({ originalStatus, originalExit });
    await assert.rejects(client(f.saved, f.rpc).prepare(), /confirmed failed|explicit nonzero/);
    assert.equal(f.calls.filter(call => call.name === 'job_start').length, 0);
    assert.equal(f.saved.steps.validate.result.id, f.oldJobId);
  }
});

test('validation retry requires a selected active image and a dedicated noncolliding label', async () => {
  const wrongImage = retryFixture({ image: 'sha256:old-image' });
  await assert.rejects(client(wrongImage.saved, wrongImage.rpc).prepare(), /has not been activated/);
  assert.deepEqual(wrongImage.calls.map(call => call.name), ['capabilities']);
  const missingImage = retryFixture(); delete missingImage.saved.validationImage;
  await assert.rejects(client(missingImage.saved, missingImage.rpc).prepare(), /select the corrected executor image/);
  assert.equal(missingImage.calls.length, 0);
  const wrongLabel = retryFixture(); wrongLabel.saved.validationStep = 'install';
  await assert.rejects(client(wrongLabel.saved, wrongLabel.rpc).prepare(), /dedicated validate-/);
  assert.equal(wrongLabel.calls.length, 0);
  const collision = retryFixture();
  collision.saved.steps[collision.saved.validationStep] = { name: 'job_start', args: { argv: ['npm', 'ci'] }, result: { id: collision.installJobId } };
  await assert.rejects(client(collision.saved, collision.rpc).prepare(), /Saved validation retry inputs changed/);
  assert.equal(collision.calls.filter(call => call.name === 'job_start').length, 0);
});

test('validation retry requires the original request and failed job to preserve the pinned source revision', async () => {
  for (const change of ['request', 'result', 'unverified']) {
    const f = retryFixture();
    if (change === 'request') f.saved.steps.validate.args.expectedRevision = 'e'.repeat(64);
    if (change === 'result') f.originalJob.revisionAfter = 'e'.repeat(64);
    if (change === 'unverified') f.originalJob.revisionVerified = false;
    await assert.rejects(client(f.saved, f.rpc).prepare(), /original validation source|changed tracked source|must be recoverable/);
    assert.equal(f.calls.filter(call => call.name === 'job_start').length, 0);
  }
});

test('self-update client resumes a lost job submission with exactly the persisted inputs', async () => {
  const saved = state(), seen = [], jobId = randomUUID();
  const q = client(saved, async (name, args) => {
    seen.push({ name, args });
    if (seen.length === 1) throw new Error('Lost response');
    return { ok: true, id: jobId, status: 'failed' };
  });
  const input = { workspaceId: randomUUID(), argv: ['npm', 'test'], idempotencyKey: 'same-job-key' };
  await assert.rejects(q.step('test', 'job_start', async () => input), /Lost response/);
  const recovered = await q.step('test', 'job_start', async () => { assert.fail('Original inputs must be reused'); });
  assert.equal(recovered.id, jobId);
  assert.deepEqual(seen[0], seen[1]);
  await q.step('test', 'job_start', async () => { assert.fail('Terminal receipt must be reused'); });
  assert.equal(seen.length, 2);
});

test('lost release admission is recovered read-only without resuming a failed restoration', async () => {
  const saved = state(), names = [], key = 'same-apply-key', operationId = releaseOperationId(key);
  const q = client(saved, async name => {
    names.push(name);
    if (name === 'praxis_release_apply') throw new Error('Lost activation response');
    return { ok: true, active: { release: 'candidate' }, operation: { operationId, status: 'failed', phase: 'restoration_failed' } };
  });
  await assert.rejects(q.step('release-apply', 'praxis_release_apply', async () => ({ idempotencyKey: key })), /Lost activation response/);
  const receipt = await q.step('release-apply', 'praxis_release_apply', async () => { assert.fail('Do not change activation inputs'); });
  assert.equal(receipt.status, 'failed');
  await assert.rejects(q.observe('release-apply', 'release', operationId), /do not recreate/);
  assert.deepEqual(names, ['praxis_release_apply', 'praxis_release_status', 'praxis_release_status']);
});

test('bounded self-update invocation returns pending before another request', async () => {
  const saved = state(), q = client(saved, async () => assert.fail('No request after deadline'), { budgetMs: -1 });
  await assert.rejects(q.call('capabilities'), { code: 'PENDING' });
  assert.equal(saved.calls.length, 0);
});

test('self-update workflow fixtures use current schemas and recover with no mutation calls', async () => {
  const saved = state(), workspaceId = randomUUID(), base = 'a'.repeat(40), commit = 'b'.repeat(40);
  const beforeRevision = 'c'.repeat(64), afterRevision = 'd'.repeat(64), planDigest = 'e'.repeat(64);
  let source = 'export const fixture = {\n        usage: {\n          pagination: "fixture"\n        }\n};\n';
  let revision = beforeRevision, release = 'old', applied = false;
  const git = new Map(), jobs = new Map(), receipts = new Map(), releases = new Map(), calls = [];
  const rpc = async (name, args) => {
    const tool = releaseTools[name];
    if (tool) tool.schema.strict().parse(args); else parseCodeCall(name, args);
    calls.push(name);
    const ok = value => ({ ok: true, ...value });
    if (name === 'capabilities') return ok({ release, dependencies: { registryAccessEnabled: true }, selfImprovement: { enabled: true }, usage: applied ? { sourceFreshness: SOURCE_FRESHNESS } : {} });
    if (name === 'project_sync') {
      const operationId = randomUUID(), value = { operationId, status: 'completed', result: { commit: saved.publishedCommit || base } };
      git.set(operationId, value); return ok(value);
    }
    if (name === 'git_operation_status') return ok(git.get(args.operationId));
    if (name === 'project_inspect') return ok({ revision: base });
    if (name === 'workspace_create') {
      const operationId = randomUUID(), value = { operationId, status: 'completed', workspaceId, result: { revision } };
      receipts.set(operationId, value); return ok(value);
    }
    if (name === 'file_read') return ok({ sha256: sha(source), revision, nextPosition: null,
      lines: source.split('\n').map((text, index) => ({ number: index + 1, text })) });
    if (name === 'workspace_apply') {
      assert.equal(args.changes.length, 1); assert.equal(args.changes[0].path, 'src/code/server.js');
      assert.equal(args.changes[0].expectedSha256, sha(source));
      source = source.replace(args.changes[0].oldText, args.changes[0].newText); revision = afterRevision;
      const operationId = randomUUID(), value = { operationId, status: 'completed', workspaceId, result: { revision } };
      receipts.set(operationId, value); return ok(value);
    }
    if (name === 'job_start') {
      assert.equal(args.expectedRevision, revision);
      if (args.argv[1] === 'ci') { assert.equal(args.network, 'registries'); assert.ok(args.argv.includes('--ignore-scripts')); }
      else { assert.deepEqual(args.argv, ['npm', 'test']); assert.equal(args.network, 'none'); }
      const id = randomUUID(), value = { id, status: 'completed', exitCode: 0, revisionVerified: true, revisionAfter: revision };
      jobs.set(id, value); return ok(value);
    }
    if (name === 'job_status') return ok(jobs.get(args.jobId));
    if (name === 'workspace_diff') return ok({ revision, changedFileCount: 1, changes: [{ path: 'src/code/server.js' }],
      diff: SOURCE_FRESHNESS, totalBytes: Buffer.byteLength(SOURCE_FRESHNESS), nextCursor: null });
    if (name === 'git_commit' || name === 'git_push') {
      const operationId = randomUUID(), value = { operationId, status: 'completed', result: { commit, parentCommit: base,
        expectedRemoteHead: base, publishedCommit: commit, observedRemoteHead: commit } };
      git.set(operationId, value); return ok(value);
    }
    if (name === 'praxis_release_plan') {
      const operationId = releaseOperationId(args.idempotencyKey), value = { operationId, status: 'ready', result: {
        sourceCommit: commit, release: 'candidate', expectedRelease: 'old', planDigest,
        testEvidence: { npmTestPassed: true, authenticatedMcpPassed: true } } };
      releases.set(operationId, value); return ok(value);
    }
    if (name === 'praxis_release_apply') {
      assert.equal(args.planDigest, planDigest); assert.equal(args.expectedRelease, 'old');
      release = 'candidate'; applied = true;
      const operationId = releaseOperationId(args.idempotencyKey), value = { operationId, status: 'completed', result: { release } };
      releases.set(operationId, value); return ok(value);
    }
    if (name === 'praxis_release_status') return ok({ active: { release }, ...(args.operationId ? { operation: releases.get(args.operationId) } : {}) });
    if (name === 'workspace_inspect') return ok({ workspaceId, revision, status: 'ready' });
    if (name === 'operation_read') return ok(receipts.get(args.operationId));
    assert.fail('Unexpected fixture request: ' + name);
  };
  for (const phase of ['prepare', 'publish', 'plan', 'apply']) await client(saved, rpc)[phase]();
  assert.equal(saved.applied.result.release, 'candidate');
  const writesBefore = calls.length;
  await client(saved, rpc).recover();
  assert.ok(calls.slice(writesBefore).every(name => /status$|inspect$|_read$|^capabilities$/.test(name)));
  const before = calls.filter(name => ['job_start', 'workspace_apply', 'git_commit', 'git_push', 'praxis_release_apply'].includes(name)).length;
  await client(saved, rpc).apply();
  assert.equal(calls.filter(name => ['job_start', 'workspace_apply', 'git_commit', 'git_push', 'praxis_release_apply'].includes(name)).length, before);
});
