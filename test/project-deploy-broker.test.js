import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GitBroker, BrokerError } from '../src/git/broker.js';

const owner = 'project-owner', projectId = 'p-0123456789abcdef-example', commit = 'a'.repeat(40);

function fixture(t, { loseRestart = false, phase = 'completed' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'praxis-project-deploy-broker-'));
  mkdirSync(join(directory, 'outbox'));
  let remoteCommit = commit, remoteReads = 0, restartCount = 0, routeCount = 0, saved;
  const calls = [];
  const broker = new GitBroker({ dataDirectory: join(directory, 'data'), outboxDirectory: join(directory, 'outbox'),
    exportDirectory: join(directory, 'exports'), repositories: [{ projectId, owner, defaultBranch: 'main' }],
    git: { fetch: async () => {}, remoteHead: async () => { remoteReads++; return { commit: remoteCommit }; } },
    projectDeployment: async args => {
      calls.push(structuredClone(args));
      if (args.action === 'status') {
        if (!saved) throw new BrokerError('OPERATION_NOT_FOUND', 'No helper journal.');
        return structuredClone(saved);
      }
      if (!saved) {
        restartCount++;
        saved = { phase: loseRestart ? 'service_ready' : phase, targetCommit: args.targetCommit,
          operationId: args.operationId, projectId: args.projectId, request: structuredClone(args) };
        if (loseRestart) throw new Error('Lost helper response after restart');
        if (phase === 'completed') routeCount++;
      } else {
        assert.deepEqual(args, saved.request, 'resumption retains every original helper argument');
        if (saved.phase === 'service_ready') { routeCount++; saved.phase = 'completed'; }
      }
      return structuredClone(saved);
    }
  });
  broker.projectProvisioner = { get: () => ({ published: true, template: 'node' }) };
  broker.run_sync = async row => ({ exportId: row.id, projectId, commit, revision: 'b'.repeat(64) });
  const publicationOperationId = randomUUID();
  broker.db.prepare(`INSERT INTO git_operations(id,owner,kind,project_id,idempotency_key,request_json,status,phase,result_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'completed','completed',?,?,?)`).run(publicationOperationId, owner, 'projectPublish', projectId,
      `publication-${publicationOperationId}`, '{}', JSON.stringify({ commit }), '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z');
  const args = { owner, operationId: randomUUID(), idempotencyKey: `deploy-${randomUUID()}`, publicationOperationId,
    expectedHead: null, preparedDependenciesId: 'c'.repeat(64) };
  t.after(async () => { await broker.close(); rmSync(directory, { recursive: true, force: true }); });
  return { broker, args, calls, get restartCount() { return restartCount; }, get routeCount() { return routeCount; },
    get remoteReads() { return remoteReads; }, advanceRemote() { remoteCommit = 'd'.repeat(40); },
    changePhase(value) { saved.phase = value; },
    receipt: () => broker.get({ owner, operationId: args.operationId }) };
}

test('lost project restart response: read-only observation does not publish route, exact retry resumes once', async t => {
  const f = fixture(t, { loseRestart: true });
  assert.equal(f.broker.submit('projectDeploy', f.args).status, 'queued');
  await f.broker.tick();
  assert.equal(f.receipt().status, 'uncertain');
  assert.equal(f.restartCount, 1); assert.equal(f.routeCount, 0);
  await f.broker.observe({ owner, operationId: f.args.operationId });
  assert.equal(f.receipt().status, 'uncertain');
  assert.equal(f.calls.filter(call => call.action === 'apply').length, 1);
  assert.equal(f.routeCount, 0, 'status never runs the unissued nginx mutation');
  f.advanceRemote();
  const beforeReads = f.remoteReads;
  assert.equal(f.broker.submit('projectDeploy', f.args).status, 'queued');
  await f.broker.tick();
  assert.equal(f.receipt().status, 'completed', JSON.stringify(f.receipt()));
  assert.equal(f.remoteReads, beforeReads, 'already activated source is completed even when main advances');
  assert.equal(f.restartCount, 1); assert.equal(f.routeCount, 1);
  assert.equal(f.broker.submit('projectDeploy', f.args).status, 'completed');
  await f.broker.tick();
  assert.equal(f.restartCount, 1); assert.equal(f.routeCount, 1);
});

test('observing a completed project deployment succeeds after published main advances', async t => {
  const f = fixture(t, { loseRestart: true });
  f.broker.submit('projectDeploy', f.args); await f.broker.tick();
  f.changePhase('completed'); f.advanceRemote();
  const beforeReads = f.remoteReads;
  f.broker.submit('projectDeploy', f.args); await f.broker.tick();
  assert.equal(f.receipt().status, 'completed');
  assert.equal(f.remoteReads, beforeReads);
  assert.equal(f.calls.filter(call => call.action === 'apply').length, 1);
});

test('an uncertain helper activation remains uncertain after an explicit same-key retry', async t => {
  const f = fixture(t, { phase: 'uncertain' });
  f.broker.submit('projectDeploy', f.args); await f.broker.tick();
  assert.equal(f.receipt().status, 'uncertain');
  f.broker.submit('projectDeploy', f.args); await f.broker.tick();
  assert.equal(f.receipt().status, 'uncertain');
  assert.equal(f.calls.filter(call => call.action === 'apply').length, 1);
  assert.equal(f.restartCount, 1);
});

test('unstarted project deployment still requires the current published main commit', async t => {
  const f = fixture(t, { phase: 'prepared' });
  f.broker.submit('projectDeploy', f.args); await f.broker.tick();
  f.advanceRemote();
  f.broker.submit('projectDeploy', f.args); await f.broker.tick();
  assert.equal(f.receipt().error.code, 'REMOTE_CONFLICT');
  assert.equal(f.calls.filter(call => call.action === 'apply').length, 1);
});
