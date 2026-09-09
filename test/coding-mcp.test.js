import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server.js';
import { createCodingService } from '../src/code/server.js';

// This runner tests transport/lifecycle integration. Real container isolation is a separate host test.
class FixtureRunner {
  containers = new Map();
  async create({ job, workspacePath }) {
    const name = `praxis-code-${job.id}`;
    this.containers.set(name, { job, workspacePath, exists: true, id: job.id, status: 'created', running: false, records: [] });
    return { name, id: job.id };
  }
  async start({ name }) {
    Object.assign(this.containers.get(name), { status: 'running', running: true, startedAt: new Date().toISOString() });
  }
  complete() {
    const item = [...this.containers.values()].find(row => row.running);
    assert.ok(item);
    const passed = readFileSync(join(item.workspacePath, 'answer.js'), 'utf8').includes('42');
    writeFileSync(join(item.workspacePath, 'report.txt'), passed ? 'fixture check passed\n' : 'fixture check failed\n');
    item.records.push({ timestamp: new Date().toISOString(), stream: 'stdout', text: passed ? 'PASS: answer is 42\n' : 'FAIL\n', partial: false });
    Object.assign(item, { running: false, status: 'exited', exitCode: passed ? 0 : 1, finishedAt: new Date().toISOString() });
  }
  async inspect({ name }) { return this.containers.get(name) || { exists: false }; }
  async logs({ name, cursor }) { const item = this.containers.get(name); return { records: item?.records.slice(cursor) || [], cursor: item?.records.length || cursor, hasMore: false, truncated: false }; }
  async stop({ name }) { Object.assign(this.containers.get(name), { running: false, status: 'exited', exitCode: 143, finishedAt: new Date().toISOString() }); }
  async remove({ name }) { this.containers.delete(name); }
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'praxis-code-mcp-'));
  const snapshot = join(directory, 'snapshot'); mkdirSync(snapshot);
  writeFileSync(join(snapshot, 'answer.js'), 'export const answer = 41;\n');
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const privateJwk = { ...await exportJWK(privateKey), kid: 'coding-fixture', use: 'sig', alg: 'RS256' };
  const publicJwk = { ...await exportJWK(publicKey), kid: 'coding-fixture', use: 'sig', alg: 'RS256' };
  const salt = randomBytes(16);
  const passwordHash = `scrypt$${salt.toString('base64url')}$${scryptSync('fixture-password', salt, 64).toString('base64url')}`;
  const runner = new FixtureRunner();
  let gateway, backend;
  const http = createServer((req, res) => gateway.app(req, res));
  const backendHttp = createServer((req, res) => backend.app(req, res));
  for (const server of [http, backendHttp]) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${http.address().port}/praxis`;
  const backendUrl = `http://127.0.0.1:${backendHttp.address().port}`;
  const resourceUrl = `${baseUrl}/mcp`, issuer = `${baseUrl}/oauth`;
  const gatewayConfig = { baseUrl, allowLoopback: true, dataDirectory: join(directory, 'gateway'), release: 'coding-fixture', coding: { url: backendUrl },
    auth: { passwordHash, jwks: { keys: [privateJwk] }, cookieKeys: ['coding-fixture-cookie-signing-key-at-least-32-characters'] } };
  backend = await createCodingService({ issuer, resourceUrl, publicJwks: { keys: [publicJwk] }, dataDirectory: join(directory, 'private'),
    workspaceDirectory: join(directory, 'workspaces'), release: 'coding-fixture', runner, pollIntervalMs: 20,
    projects: [{ id: 'fixture', name: 'Fixture', repository: 'https://example.test/fixture', revision: 'fixture-base', snapshotPath: snapshot, instructions: 'Keep the module small.', validationCommands: [['fixture-check']] }] });
  gateway = await createApp(gatewayConfig);
  const clients = [];
  async function token(scope = 'praxis:code', overrides = {}) {
    return new SignJWT({ scope, client_id: 'fixture-client', ...overrides }).setProtectedHeader({ alg: 'RS256', kid: privateJwk.kid, typ: 'at+jwt' })
      .setIssuer(overrides.iss ?? issuer).setAudience(overrides.aud ?? resourceUrl).setSubject('jensen').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  }
  async function connect(scope = 'praxis:code') {
    const client = new Client({ name: 'coding-fixture', version: '1.0.0' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(resourceUrl), { requestInit: { headers: { authorization: `Bearer ${await token(scope)}` } } }));
    return client;
  }
  t.after(async () => {
    for (const client of clients) await client.close();
    for (const server of [http, backendHttp]) await new Promise(resolve => server.close(resolve));
    await gateway.close(); await backend.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { connect, token, backendUrl, baseUrl, runner, backend, gateway, async restartGateway() { await gateway.close(); gateway = await createApp(gatewayConfig); } };
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.structuredContent.ok, true);
  return result.structuredContent;
}
async function status(client, jobId, expected) {
  for (let count = 0; count < 100; count++) {
    const job = await call(client, 'job_status', { jobId });
    if (job.status === expected) return job;
    await delay(20);
  }
  assert.fail(`Job did not reach ${expected}`);
}

test('gateway and coding adapter independently enforce explicit coding permission', async t => {
  const f = await fixture(t);
  const old = await f.connect('praxis:probe');
  assert.equal((await call(old, 'probe_capabilities')).version, '0.1.0');
  const denied = await old.callTool({ name: 'projects_list', arguments: {} });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.error.code, 'AUTHORIZATION_REQUIRED');
  for (const value of ['', 'not-a-token', await f.token('praxis:probe')]) {
    const response = await fetch(`${f.backendUrl}/call`, { method: 'POST', headers: { authorization: `Bearer ${value}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'projects_list', args: {} }) });
    assert.equal(response.status, 401);
  }
  const client = await f.connect();
  assert.equal((await call(client, 'projects_list')).projects[0].projectId, 'fixture');
  const missing = await client.callTool({ name: 'file_read', arguments: { projectId: 'fixture', path: 'absent.txt' } });
  assert.equal(missing.structuredContent.error.code, 'NOT_FOUND');
  assert.doesNotMatch(JSON.stringify(missing), /praxis-code-mcp-|ENOENT|open '/);
  assert.equal((await client.callTool({ name: 'probe_capabilities', arguments: {} })).isError, true);
  const injected = await fetch(`${f.backendUrl}/call`, { method: 'POST', headers: { authorization: `Bearer ${await f.token()}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'projects_list', args: { owner: 'someone-else' } }) });
  assert.equal(injected.status, 400);
  const discovery = await (await fetch(`${new URL(f.baseUrl).origin}/.well-known/oauth-protected-resource/praxis/mcp`)).json();
  assert.ok(discovery.scopes_supported.includes('praxis:code'));
});

test('canonical Praxis discovery and authenticated coding use one issuer and resource', async t => {
  const f = await fixture(t), origin = new URL(f.baseUrl).origin;
  const resource = `${f.baseUrl}/mcp`, issuer = `${f.baseUrl}/oauth`;
  const health = await (await fetch(`${f.baseUrl}/healthz`)).json();
  assert.equal(health.name, 'Praxis');
  for (const path of ['/.well-known/oauth-authorization-server/praxis/oauth', '/.well-known/openid-configuration/praxis/oauth', '/praxis/oauth/.well-known/openid-configuration']) {
    const metadata = await (await fetch(`${origin}${path}`)).json();
    assert.equal(metadata.issuer, issuer);
    assert.equal(metadata.authorization_endpoint, `${issuer}/auth`);
    assert.equal(metadata.token_endpoint, `${issuer}/token`);
    assert.ok(metadata.scopes_supported.includes('praxis:code'));
    assert.ok(metadata.scopes_supported.includes('praxis:probe'));
  }
  const metadata = await (await fetch(`${origin}/.well-known/oauth-protected-resource/praxis/mcp`)).json();
  assert.equal(metadata.resource_name, 'Praxis');
  assert.equal(metadata.resource, resource);
  assert.deepEqual(metadata.authorization_servers, [issuer]);
  assert.deepEqual(metadata.scopes_supported, ['praxis:probe', 'praxis:code', 'offline_access']);
  // A separately configured legacy gateway can remain during migration, but this
  // canonical application must never route old paths or accept old token audiences.
  for (const path of ['/praxis-probe/mcp', '/praxis-probe/healthz', '/praxis-probe/oauth/.well-known/openid-configuration', '/.well-known/oauth-protected-resource/praxis-probe/mcp', '/.well-known/oauth-authorization-server/praxis-probe/oauth']) {
    assert.equal((await fetch(`${origin}${path}`)).status, 404, path);
  }
  for (const overrides of [{ aud: `${origin}/praxis-probe/mcp` }, { iss: `${origin}/praxis-probe/oauth` }]) {
    const rejected = await fetch(resource, { headers: { authorization: `Bearer ${await f.token('praxis:code', overrides)}` } });
    assert.equal(rejected.status, 401);
  }
  const client = await f.connect('praxis:code praxis:probe');
  assert.equal(client.getServerVersion().name, 'Praxis');
  assert.equal((await call(client, 'projects_list')).projects[0].projectId, 'fixture');
  assert.equal((await call(client, 'probe_capabilities')).resourceUrl, resource);
});

test('authenticated coding tools edit, run, survive gateway restart, and recover diff/artifacts in a fresh client', async t => {
  const f = await fixture(t), client = await f.connect();
  const request = { projectId: 'fixture', baseRevision: 'fixture-base', idempotencyKey: 'coding-create-fixture', label: 'Recovery fixture' };
  const created = await call(client, 'workspace_create', request), workspaceId = created.workspaceId;
  assert.equal((await call(client, 'workspace_create', request)).operationId, created.operationId);
  const file = await call(client, 'file_read', { workspaceId, path: 'answer.js' });
  const edit = await call(client, 'workspace_apply', { workspaceId, expectedRevision: file.revision, idempotencyKey: 'coding-edit-fixture',
    changes: [{ action: 'patch', path: 'answer.js', expectedSha256: file.sha256, oldText: '= 41', newText: '= 42' }] });
  assert.equal(edit.status, 'completed');
  const stale = await client.callTool({ name: 'workspace_apply', arguments: { workspaceId, expectedRevision: file.revision, idempotencyKey: 'coding-stale-fixture', changes: [{ action: 'delete', path: 'answer.js', expectedSha256: file.sha256 }] } });
  assert.equal(stale.structuredContent.error.code, 'REVISION_CONFLICT');
  const badPath = await client.callTool({ name: 'file_read', arguments: { workspaceId, path: '../private/coding.sqlite' } });
  assert.equal(badPath.isError, true);
  const jobRequest = { workspaceId, expectedRevision: edit.result.revision, idempotencyKey: 'coding-run-fixture', argv: ['fixture-check'], artifactPaths: ['report.txt'] };
  const job = await call(client, 'job_start', jobRequest);
  await status(client, job.id, 'running');
  await f.restartGateway();
  f.runner.complete();
  const fresh = await f.connect();
  const finished = await status(fresh, job.id, 'completed');
  assert.equal(finished.exitCode, 0);
  assert.equal((await call(fresh, 'workspaces_list')).workspaces[0].workspaceId, workspaceId);
  assert.equal((await call(fresh, 'jobs_list')).jobs[0].id, job.id);
  assert.equal((await call(fresh, 'job_start', jobRequest)).id, job.id);
  const diff = await call(fresh, 'workspace_diff', { workspaceId });
  assert.match(diff.diff, /\+export const answer = 42/);
  const logs = await call(fresh, 'job_logs', { jobId: job.id });
  assert.ok(logs.records.some(record => record.text.includes('PASS')));
  const artifacts = await call(fresh, 'artifact_list', { jobId: job.id });
  const report = await call(fresh, 'artifact_read', { jobId: job.id, artifactId: artifacts.artifacts[0].id });
  assert.equal(Buffer.from(report.content, report.encoding).toString(), 'fixture check passed\n');
  const receipt = await call(fresh, 'operation_read', { operationId: edit.operationId });
  assert.equal(receipt.status, 'completed');
});

test('discovered coding contracts explain page units, large-file patches, compact status, and focused logs', async t => {
  const f = await fixture(t), client = await f.connect();
  const catalog = (await client.listTools()).tools;
  const tool = name => catalog.find(entry => entry.name === name);
  const diff = tool('workspace_diff').inputSchema.properties;
  assert.equal(diff.maxBytes.minimum, 256);
  assert.equal(diff.maxBytes.maximum, 32768);
  assert.match(diff.maxBytes.description, /UTF-8.*bytes.*16384/);
  assert.match(diff.limit.description, /Legacy alias.*bytes/);
  assert.match(diff.cursor.description, /opaque.*exactly/);
  const read = tool('file_read');
  assert.equal(read.inputSchema.properties.lineCount.default, 100);
  assert.equal(read.inputSchema.properties.lineCount.maximum, 200);
  assert.match(read.description, /nextPosition\.line.*nextPosition\.column/);
  assert.match(tool('workspace_apply').description, /ORIGINAL file SHA-256/);
  const status = tool('job_status').inputSchema.properties;
  assert.equal(status.includeCommand.default, false);
  const logs = tool('job_logs').inputSchema.properties;
  assert.equal(logs.limit.maximum, 100);
  assert.equal(logs.limit.default, 50);
  assert.match(logs.limit.description, /log records/);
  assert.deepEqual(logs.view.enum, ['head', 'tail']);
  assert.match(logs.cursor.description, /backward.*independent/);
  assert.equal(logs.query.maxLength, 200);
  assert.match(logs.query.description, /retained.*not omitted/);
  assert.match((await call(client, 'capabilities')).usage.jobRecovery, /job_status.*tail/);
});

test('invalid MCP arguments receive structured bounded errors without mutation or echoed private inputs', async t => {
  const f = await fixture(t), client = await f.connect('praxis:code praxis:probe');
  const sensitive = 'PRIVATE_SOURCE_OR_TOKEN_NOT_FOR_DIAGNOSTICS';
  const invalid = await client.callTool({ name: 'workspace_create', arguments: {
    projectId: 'fixture', baseRevision: 'fixture-base', idempotencyKey: 'invalid-create-fixture', label: 'x'.repeat(81), [sensitive]: sensitive,
  } });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.error.code, 'INVALID_ARGUMENT');
  assert.match(invalid.structuredContent.requestId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(JSON.parse(invalid.content[0].text), invalid.structuredContent);
  assert.equal(invalid.structuredContent.error.retry.strategy, 'correct_arguments');
  assert.equal(invalid.structuredContent.error.issues[0].field, 'label');
  assert.equal(invalid.structuredContent.error.issues[0].maximum, 80);
  assert.doesNotMatch(JSON.stringify(invalid), new RegExp(sensitive));
  assert.deepEqual((await call(client, 'workspaces_list')).workspaces, []);
  assert.deepEqual((await call(client, 'operations_list')).operations, []);
  const observations = await call(client, 'probe_observations', { limit: 100 });
  const receipt = observations.observations.find(row => row.requestId === invalid.structuredContent.requestId);
  assert.equal(receipt.errorCode, 'INVALID_ARGUMENT');
  assert.match(receipt.httpRequestId, /^[a-f0-9-]{36}$/);

  const badRead = await client.callTool({ name: 'file_read', arguments: { projectId: 'fixture', path: 'answer.js', lineCount: 230 } });
  assert.equal(badRead.structuredContent.error.issues[0].maximum, 200);
  assert.equal((await call(client, 'file_read', { projectId: 'fixture', path: 'answer.js' })).lines[0].text, 'export const answer = 41;');
  // Permission checks run before validation, including in the gateway handler.
  const probeOnly = await f.connect('praxis:probe');
  const denied = await probeOnly.callTool({ name: 'workspace_create', arguments: { [sensitive]: sensitive } });
  assert.equal(denied.structuredContent.error.code, 'AUTHORIZATION_REQUIRED');
  assert.equal(denied.structuredContent.error.issues, undefined);
  assert.doesNotMatch(JSON.stringify(denied), new RegExp(sensitive));

  // Bypassing MCP does not bypass independent backend schema validation.
  const direct = await fetch(`${f.backendUrl}/call`, { method: 'POST', headers: { authorization: `Bearer ${await f.token()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'workspace_create', args: { projectId: 'fixture', baseRevision: 'fixture-base', idempotencyKey: 'invalid-direct-fixture', [sensitive]: sensitive } }) });
  const body = await direct.json();
  assert.equal(direct.status, 400);
  assert.equal(body.error.code, 'INVALID_ARGUMENT');
  assert.equal(body.requestId, direct.headers.get('x-praxis-request-id'));
  assert.doesNotMatch(JSON.stringify(body), new RegExp(sensitive));
  assert.deepEqual((await call(client, 'workspaces_list')).workspaces, []);
});

test('authenticated backend failures correlate with safe diagnostics and preserve read recovery guidance', async t => {
  const f = await fixture(t), client = await f.connect();
  const privateDetails = 'PRIVATE_TOKEN source-text C:\\private\\credentials.json';
  const emitted = [];
  t.mock.method(console, 'error', text => emitted.push(JSON.parse(text)));
  const original = f.backend.workspaces.projectsList;
  f.backend.workspaces.projectsList = () => { throw new TypeError(privateDetails); };
  const failed = await client.callTool({ name: 'projects_list', arguments: {} });
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.error.code, 'INTERNAL_ERROR');
  assert.equal(failed.structuredContent.error.retry.strategy, 'retry_read');
  const backendRecord = emitted.find(row => row.event === 'coding_request_failed');
  assert.equal(backendRecord.requestId, failed.structuredContent.requestId);
  assert.equal(backendRecord.action, 'projects_list');
  assert.equal(backendRecord.errorType, 'TypeError');
  assert.match(backendRecord.stackFingerprint, /^[a-f0-9]{24}$/);
  assert.doesNotMatch(JSON.stringify([failed, emitted]), /PRIVATE_TOKEN|source-text|credentials\.json/);
  assert.equal(backendRecord.stack, undefined);
  assert.equal(backendRecord.message, undefined);
  f.backend.workspaces.projectsList = original;
  assert.equal((await call(client, 'projects_list')).projects[0].projectId, 'fixture');
});

test('diagnostic audit failures do not hide a completed mutation or corrupt its durable receipt', async t => {
  const f = await fixture(t), client = await f.connect();
  const emitted = [];
  t.mock.method(console, 'error', text => emitted.push(JSON.parse(text)));
  t.mock.method(f.gateway.audit, 'record', () => { throw new Error('PRIVATE_AUDIT_DATABASE_PATH'); });
  const request = { projectId: 'fixture', baseRevision: 'fixture-base', idempotencyKey: 'audit-failure-create', label: 'Audit failure fixture' };
  const created = await call(client, 'workspace_create', request);
  assert.equal(created.status, 'completed');
  assert.equal((await call(client, 'workspace_create', request)).operationId, created.operationId);
  assert.equal((await call(client, 'operation_read', { operationId: created.operationId })).status, 'completed');
  assert.equal((await call(client, 'workspaces_list')).workspaces.length, 1);
  assert.ok(emitted.some(row => row.event === 'mcp_audit_failed' && row.requestId === created.requestId));
  assert.doesNotMatch(JSON.stringify(emitted), /PRIVATE_AUDIT_DATABASE_PATH/);
});

test('diff byte budgets retain legacy calls and return actionable structured range or alias errors', async t => {
  const f = await fixture(t), client = await f.connect();
  const created = await call(client, 'workspace_create', { projectId: 'fixture', baseRevision: 'fixture-base', idempotencyKey: 'diff-budget-fixture' });
  const legacy = await call(client, 'workspace_diff', { workspaceId: created.workspaceId, limit: 256 });
  const preferred = await call(client, 'workspace_diff', { workspaceId: created.workspaceId, maxBytes: 256 });
  assert.equal(legacy.diff, preferred.diff);
  assert.equal(legacy.revision, preferred.revision);
  const rejected = await client.callTool({ name: 'workspace_diff', arguments: { workspaceId: created.workspaceId, limit: 100 } });
  assert.equal(rejected.structuredContent.error.code, 'INVALID_ARGUMENT');
  assert.equal(rejected.structuredContent.error.issues[0].minimum, 256);
  const conflict = await client.callTool({ name: 'workspace_diff', arguments: { workspaceId: created.workspaceId, maxBytes: 4096, limit: 8192 } });
  assert.equal(conflict.structuredContent.error.code, 'INVALID_ARGUMENT');
  assert.match(conflict.structuredContent.error.issues[0].message, /maxBytes and limit must match/);
  assert.equal((await call(client, 'workspace_diff', { workspaceId: created.workspaceId })).revision, legacy.revision);
});

test('malformed authenticated HTTP requests expose a correlation ID without echoing request text', async t => {
  const f = await fixture(t);
  const emitted = [];
  t.mock.method(console, 'error', text => emitted.push(JSON.parse(text)));
  const response = await fetch(`${f.baseUrl}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${await f.token()}`, 'content-type': 'application/json' }, body: '{"PRIVATE_REQUEST_CONTENT":' });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error, 'invalid_json');
  assert.match(body.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(body.requestId, response.headers.get('x-praxis-request-id'));
  assert.ok(emitted.some(row => row.event === 'mcp_http_failed' && row.requestId === body.requestId));
  assert.doesNotMatch(JSON.stringify([body, emitted]), /PRIVATE_REQUEST_CONTENT/);
});

test('explicit stale job and unmatched patch rejections direct callers to refresh state', async t => {
  const f = await fixture(t), client = await f.connect();
  const created = await call(client, 'workspace_create', { projectId: 'fixture', baseRevision: 'fixture-base', idempotencyKey: 'recovery-guidance-fixture' });
  const file = await call(client, 'file_read', { workspaceId: created.workspaceId, path: 'answer.js' });
  const stale = await client.callTool({ name: 'job_start', arguments: { workspaceId: created.workspaceId, expectedRevision: 'outdated-revision', idempotencyKey: 'rejected-stale-job', argv: ['fixture-check'] } });
  assert.equal(stale.structuredContent.error.code, 'STALE_REVISION');
  assert.equal(stale.structuredContent.error.retry.strategy, 'refresh_state');
  assert.deepEqual((await call(client, 'jobs_list', { workspaceId: created.workspaceId })).jobs, []);
  const patch = await client.callTool({ name: 'workspace_apply', arguments: { workspaceId: created.workspaceId, expectedRevision: file.revision, idempotencyKey: 'rejected-unmatched-patch',
    changes: [{ action: 'patch', path: 'answer.js', expectedSha256: file.sha256, oldText: 'This text is absent', newText: 'updated text' }] } });
  assert.equal(patch.structuredContent.error.code, 'PATCH_CONFLICT');
  assert.equal(patch.structuredContent.error.retry.strategy, 'refresh_state');
  assert.equal((await call(client, 'file_read', { workspaceId: created.workspaceId, path: 'answer.js' })).sha256, file.sha256);
});
