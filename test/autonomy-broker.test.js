import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GitBroker } from '../src/git/broker.js';
import { ownedProjectId } from '../src/git/projects.js';

const OLD = '1'.repeat(40), CURRENT = '2'.repeat(40), DIGEST = '3'.repeat(64), BLOB = '4'.repeat(40);
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'praxis-autonomy-broker-')), fence = join(root, 'fence.json');
  const outboxDirectory = join(root, 'outbox'); mkdirSync(outboxDirectory);
  writeFileSync(fence, JSON.stringify({ state: 'active', release: 'release-old' }));
  const owner = 'jensen', projectId = ownedProjectId(owner, 'application');
  const calls = [], records = new Map(), releaseCalls = [];
  let head = OLD, loseRestart = false;
  const host = async input => {
    calls.push(input);
    if (input.action === 'diagnosis') return { head, operationalEvents: [{ event: 'service-active' }], processActive: true, providerVerified: false };
    if (input.action === 'history') return { operations: [...records.values()], nextCursor: null };
    if (input.action === 'status') return input.operationId ? records.get(input.operationId) : { head, processActive: true };
    if (records.has(input.operationId)) return records.get(input.operationId);
    assert.equal(input.expectedHead, head);
    const before = head;
    if (input.action === 'apply') head = input.targetCommit;
    if (input.action === 'rollback') head = records.get(input.deploymentOperationId).previousHead;
    const result = { operationId: input.operationId, phase: 'completed', previousHead: before, targetCommit: head, head };
    records.set(input.operationId, result);
    if (input.action === 'restart' && loseRestart) { loseRestart = false; throw new Error('Fixture lost response after restart'); }
    return result;
  };
  const git = { async fetch() { return { commit: CURRENT }; }, async remoteHead() { return { commit: CURRENT }; },
    async readTree() { return [{ path: 'README.md', type: 'blob', mode: '100644', oid: BLOB }]; }, async readBlob() { return Buffer.from('Application source\n'); }, registerRepository() {} };
  const projectCalls = [], projectRecords = new Map();
  const broker = new GitBroker({ dataDirectory: join(root, 'broker'), outboxDirectory, exportDirectory: join(root, 'exports'), git,
    repositories: [{ projectId: 'discord', deployment: true }, { projectId: 'praxis' }, { projectId, owner }],
    generationFencePath: fence, deployment: host, projectProvisioning: { directory: join(root, 'projects'), account: 'FixtureOwner' },
    projectDeployment: async input => {
      projectCalls.push(input);
      if (input.action === 'status') return projectRecords.get(input.operationId) || { projectId, currentHead: null };
      if (!projectRecords.has(input.operationId)) projectRecords.set(input.operationId, { phase: 'completed', head: input.targetCommit, runtime: input.runtime });
      return projectRecords.get(input.operationId);
    }, releaseControl: async input => { releaseCalls.push(input); return { phase: 'completed', action: input.action, operationId: input.operationId, activeRelease: 'release-old' }; } });
  broker.db.prepare(`INSERT INTO git_created_projects(project_id,owner,name,template,create_operation_id,initial_commit,repository_json,published,created_at)
    VALUES(?,?,?,?,?,?,?,1,?)`).run(projectId, owner, 'application', 'node', randomUUID(), CURRENT, '{}', new Date().toISOString());
  const seed = (kind, project, result, requestOwner = owner) => {
    const id = randomUUID(), now = new Date().toISOString();
    broker.db.prepare(`INSERT INTO git_operations(id,owner,kind,project_id,idempotency_key,request_json,status,result_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'completed',?,?,?)`).run(id, requestOwner, kind, project, `fixture-${id}`, '{}', JSON.stringify(result), now, now);
    return id;
  };
  const submit = (kind, args) => broker.submit(kind, { owner, operationId: randomUUID(), idempotencyKey: `test-${randomUUID()}`, ...args });
  const finish = async operation => { await broker.tick(); return broker.get({ owner, operationId: operation.operationId }); };
  t.after(async () => { await broker.close(); rmSync(root, { recursive: true, force: true }); });
  return { broker, owner, projectId, calls, records, projectCalls, releaseCalls, seed, submit, finish,
    loseRestart() { loseRestart = true; }, setFence(state) { writeFileSync(fence, JSON.stringify({ state })); } };
}

test('production diagnosis and history are read-only while deployment, restart and rollback dispatch exact durable inputs', async t => {
  const f = fixture(t), push = f.seed('push', 'discord', { commit: CURRENT });
  assert.equal((await f.broker.diagnosis({ owner: f.owner, projectId: 'discord', limit: 5 })).providerVerified, false);
  assert.equal((await f.broker.deploymentHistory({ owner: f.owner, projectId: 'discord', limit: 5 })).operations.length, 0);
  assert.deepEqual(f.calls.map(call => call.action), ['diagnosis', 'history']);
  const deploy = f.submit('deploy', { pushOperationId: push, expectedHead: OLD, preparedDependenciesId: DIGEST });
  assert.equal((await f.finish(deploy)).status, 'completed');
  assert.equal(f.calls.at(-1).preparedDependenciesId, DIGEST);
  const restart = f.submit('restart', { projectId: 'discord', expectedHead: CURRENT });
  assert.equal((await f.finish(restart)).status, 'completed');
  const rollback = f.submit('rollback', { projectId: 'discord', expectedHead: CURRENT, deploymentOperationId: deploy.operationId });
  const restored = await f.finish(rollback);
  assert.equal(restored.result.head, OLD);
  const stored = JSON.parse(f.broker.row(f.owner, rollback.operationId).request_json);
  assert.equal(f.broker.submit('rollback', { owner: f.owner, ...stored }).operationId, rollback.operationId);
  await f.broker.tick();
  assert.deepEqual(f.calls.filter(call => !['diagnosis', 'history', 'status'].includes(call.action)).map(call => call.action), ['apply', 'restart', 'rollback']);
  assert.throws(() => f.broker.get({ owner: 'another-owner', operationId: rollback.operationId }), { code: 'NOT_FOUND' });
});

test('lost production restart result is recovered through status without another restart', async t => {
  const f = fixture(t); f.loseRestart();
  const restart = f.submit('restart', { projectId: 'discord', expectedHead: OLD });
  assert.equal((await f.finish(restart)).status, 'uncertain');
  const observed = await f.broker.observe({ owner: f.owner, operationId: restart.operationId });
  assert.equal(observed.status, 'completed');
  assert.deepEqual(f.calls.map(call => call.action), ['restart', 'status']);
});

test('new-app deployment uses the registered owner/runtime, exact publication and immutable export once', async t => {
  const f = fixture(t), publication = f.seed('projectPublish', f.projectId, { commit: CURRENT });
  const deployment = f.submit('projectDeploy', { publicationOperationId: publication, expectedHead: null, preparedDependenciesId: DIGEST });
  assert.equal((await f.finish(deployment)).status, 'completed');
  assert.deepEqual(f.projectCalls[0], { action: 'apply', operationId: deployment.operationId, projectId: f.projectId,
    exportId: deployment.operationId, targetCommit: CURRENT, expectedHead: null, runtime: 'node', preparedDependenciesId: DIGEST });
  const args = JSON.parse(f.broker.row(f.owner, deployment.operationId).request_json);
  f.broker.submit('projectDeploy', { owner: f.owner, ...args }); await f.broker.tick();
  assert.equal(f.projectCalls.length, 1);
  assert.throws(() => f.broker.submit('projectDeploy', { owner: 'another-owner', ...args, operationId: randomUUID(), idempotencyKey: 'other-owner-deploy' }), { code: 'NOT_FOUND' });
  assert.throws(() => f.broker.submit('projectDeploy', { owner: f.owner, ...args, runtime: 'shell' }), { code: 'INVALID_ARGUMENT' });
});

test('generation fence blocks admissions while diagnosis, receipts and independent release control remain available', async t => {
  const f = fixture(t), sync = f.seed('sync', 'praxis', { exportId: randomUUID(), commit: CURRENT, revision: DIGEST });
  f.setFence('draining');
  for (const [kind, args] of [['restart', { projectId: 'discord', expectedHead: OLD }], ['sync', { projectId: 'praxis' }], ['projectCreate', { name: 'blocked', template: 'node' }]]) {
    assert.throws(() => f.submit(kind, args), { code: 'UPDATE_IN_PROGRESS' });
  }
  assert.equal((await f.broker.diagnosis({ owner: f.owner, projectId: 'discord' })).head, OLD);
  assert.equal(f.broker.get({ owner: f.owner, operationId: sync }).status, 'completed');
  assert.equal((await f.broker.release('releaseStatus', { owner: f.owner })).activeRelease, 'release-old');
  const planned = await f.broker.release('releasePlan', { owner: f.owner, syncOperationId: sync, expectedRelease: 'release-old', idempotencyKey: 'same-release-plan' });
  const repeated = await f.broker.release('releasePlan', { owner: f.owner, syncOperationId: sync, expectedRelease: 'release-old', idempotencyKey: 'same-release-plan' });
  assert.equal(planned.operationId, repeated.operationId);
  assert.equal(f.releaseCalls.at(-1).sourceCommit, CURRENT); assert.equal(f.releaseCalls.at(-1).sourceDigest, DIGEST);
  assert.equal('syncOperationId' in f.releaseCalls.at(-1), false);
  assert.equal(f.broker.db.prepare('SELECT COUNT(*) AS n FROM git_operations').get().n, 1, 'fenced mutations created no durable operations');
  const foreign = f.seed('sync', 'praxis', { exportId: randomUUID(), commit: CURRENT, revision: DIGEST }, 'another-owner');
  await assert.rejects(f.broker.release('releasePlan', { owner: f.owner, syncOperationId: foreign, expectedRelease: 'release-old', idempotencyKey: 'foreign-source-plan' }), { code: 'NOT_FOUND' });
});
