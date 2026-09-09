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
  const baseUrl = `http://127.0.0.1:${http.address().port}/praxis-probe`;
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
      .setIssuer(issuer).setAudience(resourceUrl).setSubject('jensen').setIssuedAt().setExpirationTime('5m').sign(privateKey);
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
  return { connect, token, backendUrl, baseUrl, runner, async restartGateway() { await gateway.close(); gateway = await createApp(gatewayConfig); } };
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
  const discovery = await (await fetch(`${new URL(f.baseUrl).origin}/.well-known/oauth-protected-resource/praxis-probe/mcp`)).json();
  assert.ok(discovery.scopes_supported.includes('praxis:code'));
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
