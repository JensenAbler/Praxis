import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { SelfUpdateQualification, SOURCE_FRESHNESS, releaseOperationId } from '../scripts/autonomy-self-update.js';
import { parseCodeCall } from '../src/code/schema.js';
import { releaseTools } from '../src/release-schema.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const state = () => ({ runId: randomUUID(), steps: {}, calls: [], observations: {} });
const client = (saved, rpc, options = {}) => new SelfUpdateQualification({ state: saved, save() {}, rpc, log() {}, ...options });

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
