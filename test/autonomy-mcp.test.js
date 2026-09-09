import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../src/server.js';
import { createCodingService } from '../src/code/server.js';
import { createGitService } from '../src/git/server.js';

const BASE = '1'.repeat(40), COMMIT = '2'.repeat(40), DIGEST = '3'.repeat(64);
async function fixture(t, { brokenManifest = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'praxis-autonomy-mcp-'));
  const snapshot = join(root, 'snapshot'), outboxDirectory = join(root, 'outbox'), exportDirectory = join(root, 'exports'), fence = join(root, 'fence.json');
  for (const path of [snapshot, outboxDirectory, exportDirectory]) mkdirSync(path);
  writeFileSync(join(snapshot, 'main.js'), 'export const answer = 41;\n');
  writeFileSync(fence, JSON.stringify({ state: 'active' }));
  const keys = {};
  for (const name of ['owner', 'health']) {
    const pair = await generateKeyPair('RS256', { extractable: true });
    keys[name] = { ...pair, privateJwk: { ...await exportJWK(pair.privateKey), kid: name, alg: 'RS256', use: 'sig' },
      publicJwk: { ...await exportJWK(pair.publicKey), kid: name, alg: 'RS256', use: 'sig' } };
  }
  let gateway, backend, publishing, backendAvailable = true;
  const gatewayHttp = createServer((req, res) => gateway.app(req, res));
  const backendHttp = createServer((req, res) => {
    if (backendAvailable) return backend.app(req, res);
    res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: { code: 'BACKEND_UNAVAILABLE', message: 'Fixture coding backend is down.' } }));
  });
  const publishingHttp = createServer((req, res) => publishing.app(req, res));
  for (const server of [gatewayHttp, backendHttp, publishingHttp]) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${gatewayHttp.address().port}/praxis`, resourceUrl = `${baseUrl}/mcp`, issuer = `${baseUrl}/oauth`;
  const backendUrl = `http://127.0.0.1:${backendHttp.address().port}`, publishingUrl = `http://127.0.0.1:${publishingHttp.address().port}`;
  const hostCalls = [], releaseCalls = [], released = new Map();
  publishing = createGitService({ issuer, resourceUrl, publicJwks: { keys: [keys.owner.publicJwk] }, dataDirectory: join(root, 'publishing'),
    release: 'control-fixture', outboxDirectory, exportDirectory, repositories: [{ projectId: 'discord', deployment: true }, { projectId: 'praxis' }], git: {},
    generationFencePath: fence, pollIntervalMs: 20,
    deployment: async input => { hostCalls.push(input); return { head: BASE, processActive: true, phase: 'completed', operations: [], nextCursor: null }; },
    releaseControl: async input => {
      releaseCalls.push(input);
      if (input.action === 'status') return { activeRelease: 'release-old', operation: input.operationId ? released.get(input.operationId) : null };
      if (input.action === 'history') return { operations: [...released.values()], nextCursor: null };
      if (!released.has(input.operationId)) released.set(input.operationId, { operationId: input.operationId, phase: input.action === 'plan' ? 'ready' : 'completed',
        action: input.action, sourceCommit: input.sourceCommit, expectedRelease: input.expectedRelease });
      return released.get(input.operationId);
    } });
  let runnerCalls = 0;
  backend = await createCodingService({ issuer, resourceUrl, publicJwks: { keys: [keys.owner.publicJwk] }, healthPublicJwks: { keys: [keys.health.publicJwk] },
    release: 'application-fixture', dataDirectory: join(root, 'coding'), workspaceDirectory: join(root, 'workspaces'), staging: true, generationFencePath: fence,
    runner: { async inspect() { runnerCalls++; return { exists: false }; }, async launch() { runnerCalls++; throw new Error('No fixture command should launch'); } },
    git: { url: `${publishingUrl}/call`, outboxDirectory, exportDirectory }, projects: [{ id: 'discord', name: 'Discord fixture', revision: BASE, snapshotPath: snapshot }] });
  const salt = randomBytes(16), passwordHash = `scrypt$${salt.toString('base64url')}$${scryptSync('fixture-password', salt, 64).toString('base64url')}`;
  const manifestPath = join(root, 'application-tools.json');
  if (brokenManifest) writeFileSync(manifestPath, '{interrupted manifest');
  gateway = await createApp({ baseUrl, allowLoopback: true, dataDirectory: join(root, 'gateway'), release: 'protected-gateway-fixture',
    coding: { url: backendUrl }, releaseControl: { url: `${publishingUrl}/call` }, ...(brokenManifest ? { toolManifestPath: manifestPath } : {}),
    auth: { passwordHash, jwks: { keys: [keys.owner.privateJwk] }, healthPublicJwks: { keys: [keys.health.publicJwk] }, cookieKeys: ['autonomy-fixture-cookie-key-at-least-32-characters'] } });
  const clients = [];
  const token = ({ signingKey = 'owner', scope = 'praxis:code', clientId = 'owner-fixture' } = {}) => new SignJWT({ scope, client_id: clientId })
    .setProtectedHeader({ alg: 'RS256', kid: signingKey, typ: 'at+jwt' }).setIssuer(issuer).setAudience(resourceUrl).setSubject('jensen')
    .setIssuedAt().setExpirationTime('5m').sign(keys[signingKey].privateKey);
  async function connect(options) {
    const client = new Client({ name: 'autonomy-fixture', version: '1.0.0' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(resourceUrl), { requestInit: { headers: { authorization: `Bearer ${await token(options)}` } } })); return client;
  }
  const workspace = backend.workspaces.create({ owner: 'jensen', projectId: 'discord', baseRevision: BASE, idempotencyKey: 'fixture-workspace' });
  const source = backend.workspaces.read({ owner: 'jensen', workspaceId: workspace.workspaceId, path: 'main.js' });
  const editArgs = { workspaceId: workspace.workspaceId, expectedRevision: source.revision, idempotencyKey: 'fixture-source-edit',
    changes: [{ action: 'patch', path: 'main.js', expectedSha256: source.sha256, oldText: '41', newText: '42' }] };
  const syncId = randomUUID(), stamp = new Date().toISOString();
  publishing.broker.db.prepare(`INSERT INTO git_operations(id,owner,kind,project_id,idempotency_key,request_json,status,result_json,created_at,updated_at)
    VALUES(?,'jensen','sync','praxis',?,'{}','completed',?,?,?)`).run(syncId, `fixture-${syncId}`,
    JSON.stringify({ exportId: syncId, commit: COMMIT, revision: DIGEST }), stamp, stamp);
  t.after(async () => {
    for (const client of clients) await client.close();
    for (const server of [gatewayHttp, backendHttp, publishingHttp]) await new Promise(resolve => server.close(resolve));
    await gateway.close(); await backend.close(); await publishing.close(); rmSync(root, { recursive: true, force: true });
  });
  return { root, connect, token, backendUrl, publishingUrl, baseUrl, issuer, gateway, backend, publishing, hostCalls, releaseCalls, syncId, editArgs,
    runnerCalls: () => runnerCalls, setDown() { backendAvailable = false; }, setFence(state) { writeFileSync(fence, JSON.stringify({ state })); } };
}
async function call(client, name, args = {}, expectedError) {
  const result = await client.callTool({ name, arguments: args });
  if (expectedError) { assert.equal(result.isError, true); assert.equal(result.structuredContent.error.code, expectedError); }
  else assert.notEqual(result.isError, true, JSON.stringify(result));
  return result.structuredContent;
}
async function direct(url, token, action, args = {}) {
  return fetch(`${url}/call`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action, args }) });
}

test('protected release recovery and activation dispatch survive an unavailable coding backend and unreadable application manifest', { timeout: 30000 }, async t => {
  const f = await fixture(t, { brokenManifest: true }); f.setDown();
  const client = await f.connect();
  const listed = await client.listTools();
  for (const name of ['praxis_release_plan', 'praxis_release_apply', 'praxis_release_status', 'praxis_release_history', 'praxis_release_rollback']) {
    assert(listed.tools.some(tool => tool.name === name));
  }
  await call(client, 'capabilities', {}, 'BACKEND_UNAVAILABLE');
  assert.equal((await call(client, 'praxis_release_status')).activeRelease, 'release-old');
  // Even syntactically valid application data cannot replace a protected tool.
  writeFileSync(join(f.root, 'application-tools.json'), JSON.stringify({ version: 1, tools: [{ name: 'praxis_release_status',
    title: 'Application replacement', description: 'Fixture attempts to replace protected control', write: false, destructive: false,
    inputSchema: { type: 'object', properties: {} } }] }));
  assert.equal((await call(client, 'praxis_release_status')).activeRelease, 'release-old');
  const planArgs = { syncOperationId: f.syncId, expectedRelease: 'release-old', idempotencyKey: 'autonomy-release-plan' };
  const plan = await call(client, 'praxis_release_plan', planArgs);
  assert.equal(plan.phase, 'ready'); assert.equal(plan.sourceCommit, COMMIT);
  assert.equal((await call(client, 'praxis_release_plan', planArgs)).operationId, plan.operationId);
  const apply = await call(client, 'praxis_release_apply', { planId: plan.operationId, planDigest: DIGEST, expectedRelease: 'release-old', idempotencyKey: 'autonomy-release-apply' });
  assert.equal(apply.phase, 'completed');
  const recovered = await call(client, 'praxis_release_status', { operationId: apply.operationId });
  assert.equal(recovered.operation.operationId, apply.operationId);
  assert.equal((await call(client, 'praxis_release_history')).operations.length, 2);
  const rollback = await call(client, 'praxis_release_rollback', { deploymentOperationId: apply.operationId, expectedRelease: 'release-new', idempotencyKey: 'autonomy-release-rollback' });
  assert.equal(rollback.phase, 'completed');
  assert.equal(f.hostCalls.length, 0); assert.equal(f.runnerCalls(), 0);
});

test('independent health JWT permits only diagnostic reads and cannot grant owner, production or release access', { timeout: 30000 }, async t => {
  const f = await fixture(t), healthOptions = { signingKey: 'health', scope: 'praxis:health', clientId: 'praxis-health' };
  const health = await f.connect(healthOptions), jwt = await f.token(healthOptions);
  assert.equal((await call(health, 'capabilities')).release, 'application-fixture');
  assert.equal((await call(health, 'projects_list')).projects.length, 1);
  assert.equal((await call(health, 'file_read', { projectId: 'discord', path: 'main.js' })).lines[0].text, 'export const answer = 41;');
  for (const [name, args] of [['workspace_apply', f.editArgs], ['production_diagnosis', { projectId: 'discord' }], ['praxis_release_status', {}],
    ['probe_job_start', { idempotencyKey: 'health-cannot-start' }], ['workspaces_list', {}]]) {
    await call(health, name, args, 'AUTHORIZATION_REQUIRED');
  }
  const deniedBackend = await direct(f.backendUrl, jwt, 'workspace_apply', f.editArgs);
  assert.equal(deniedBackend.status, 400); assert.equal((await deniedBackend.json()).error.code, 'AUTHORIZATION_REQUIRED');
  assert.equal((await direct(f.publishingUrl, jwt, 'releaseStatus')).status, 401);
  for (const options of [
    { signingKey: 'health', scope: 'praxis:code', clientId: 'praxis-health' },
    { signingKey: 'health', scope: 'praxis:health praxis:code', clientId: 'praxis-health' },
    { signingKey: 'health', scope: 'praxis:health', clientId: 'wrong-client' },
    { signingKey: 'owner', scope: 'praxis:health', clientId: 'praxis-health' }
  ]) {
    const forged = await f.token(options);
    assert.equal((await direct(f.backendUrl, forged, 'capabilities')).status, 401);
    assert.equal((await direct(f.publishingUrl, forged, 'releaseStatus')).status, 401);
    await assert.rejects(f.gateway.auth.verifyAccessToken(forged));
  }
  const discovery = await (await fetch(`${f.issuer}/.well-known/openid-configuration`)).json();
  assert.equal(discovery.scopes_supported.includes('praxis:health'), false, 'ordinary OAuth consent cannot mint health grants');
  assert.equal(f.backend.store.db.prepare('SELECT COUNT(*) AS n FROM operations').get().n, 1, 'only fixture workspace creation occurred');
  assert.equal(f.backend.store.db.prepare('SELECT COUNT(*) AS n FROM code_jobs').get().n, 0);
  assert.equal(f.releaseCalls.length, 0); assert.equal(f.hostCalls.length, 0); assert.equal(f.runnerCalls(), 0);
});

test('authenticated generation fence rejects application and broker writes while reads and independent recovery stay reachable', { timeout: 30000 }, async t => {
  const f = await fixture(t), client = await f.connect(); f.setFence('draining');
  await call(client, 'workspace_apply', f.editArgs, 'UPDATE_IN_PROGRESS');
  await call(client, 'production_restart', { projectId: 'discord', expectedHead: BASE, idempotencyKey: 'drained-production-restart' }, 'UPDATE_IN_PROGRESS');
  const brokerWrite = await direct(f.publishingUrl, await f.token(), 'restart', { projectId: 'discord', expectedHead: BASE,
    operationId: randomUUID(), idempotencyKey: 'direct-drained-restart' });
  assert.equal(brokerWrite.status, 400); assert.equal((await brokerWrite.json()).error.code, 'UPDATE_IN_PROGRESS');
  assert.equal((await call(client, 'file_read', { projectId: 'discord', path: 'main.js' })).lines[0].text, 'export const answer = 41;');
  assert.equal((await call(client, 'production_diagnosis', { projectId: 'discord' })).processActive, true);
  assert.equal((await call(client, 'praxis_release_status')).activeRelease, 'release-old');
  const recovery = await call(client, 'praxis_release_rollback', { deploymentOperationId: randomUUID(), expectedRelease: 'release-old', idempotencyKey: 'independent-fenced-recovery' });
  assert.equal(recovery.phase, 'completed', 'the independent controller, not the application fence, decides release recovery admission');
  assert.deepEqual(f.hostCalls.map(input => input.action), ['diagnosis']);
  f.setFence('active');
  const edit = await call(client, 'workspace_apply', f.editArgs);
  assert.equal(edit.status, 'completed');
  assert.equal((await call(client, 'file_read', { workspaceId: f.editArgs.workspaceId, path: 'main.js' })).lines[0].text, 'export const answer = 42;');
});
