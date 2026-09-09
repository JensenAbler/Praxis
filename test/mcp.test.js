import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../src/server.js';
import { runWorker } from '../src/worker.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'praxis-mcp-test-'));
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...await exportJWK(privateKey), kid: 'mcp-test-key', use: 'sig', alg: 'RS256' };
  const salt = randomBytes(16);
  const passwordHash = `scrypt$${salt.toString('base64url')}$${scryptSync('mcp-test-password', salt, 64).toString('base64url')}`;
  let service;
  const clients = [];
  const http = createServer((request, response) => service.app(request, response));
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  const baseUrl = `${origin}/praxis`;
  service = await createApp({
    baseUrl, dataDirectory: directory, allowLoopback: true, release: 'mcp-integration-test',
    auth: { passwordHash, jwks: { keys: [jwk] }, cookieKeys: ['mcp-fixture-cookie-signing-key-at-least-32-characters'] },
  });
  // OAuth issuance is exercised independently by auth.test.js. These tokens still traverse
  // the real middleware signature, issuer, audience, owner, expiry, and scope checks.
  const token = await new SignJWT({ scope: 'praxis:probe', client_id: 'mcp-fixture-client' })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid, typ: 'at+jwt' })
    .setIssuer(`${baseUrl}/oauth`).setAudience(service.resourceUrl).setSubject('jensen')
    .setIssuedAt().setExpirationTime('5m').sign(privateKey);
  t.after(async () => {
    for (const client of clients) await client.close();
    await new Promise((resolve) => http.close(resolve));
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function connect() {
    const client = new Client({ name: 'praxis-mcp-integration', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(service.resourceUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    return client;
  }
  return { directory, connect, client: await connect(), resourceUrl: service.resourceUrl, token };
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.structuredContent.ok, true);
  assert.deepEqual(JSON.parse(result.content.find((entry) => entry.type === 'text').text), result.structuredContent);
  return result.structuredContent;
}

async function waitForStatus(client, jobId, status) {
  const start = performance.now();
  for (;;) {
    const result = await call(client, 'probe_job_status', { jobId });
    if (result.job.status === status) return result.job;
    if (performance.now() - start > 5000) assert.fail(`Job remained ${result.job.status}, expected ${status}.`);
    await delay(30);
  }
}

test('legacy 2025 MCP clients can initialize, discover tools, and call them', async (t) => {
  const { resourceUrl, token } = await fixture(t);
  let id = 0;
  async function request(method, params) {
    const response = await fetch(resourceUrl, { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25'
    }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    assert.equal(response.status, 200);
    const body = await response.text();
    const result = response.headers.get('content-type').includes('text/event-stream')
      ? JSON.parse(body.split('\n').find(line => line.startsWith('data:')).slice(5)) : JSON.parse(body);
    assert.equal(result.error, undefined, JSON.stringify(result));
    return result.result;
  }
  const initialized = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-fixture', version: '1.0' } });
  assert.equal(initialized.protocolVersion, '2025-11-25');
  assert.equal((await request('tools/list', {})).tools.length, 9);
  assert.equal((await request('tools/call', { name: 'probe_capabilities', arguments: {} })).structuredContent.ok, true);
});

test('MCP SDK discovers precise limits, verifies synthetic evidence, and recovers from controlled errors', async (t) => {
  const { client, resourceUrl } = await fixture(t);
  const tools = await client.listTools();
  assert.equal(tools.tools.find((tool) => tool.name === 'probe_jobs_list').inputSchema.properties.limit.maximum, 50);
  const capabilities = await call(client, 'probe_capabilities');
  assert.equal(capabilities.resourceUrl, resourceUrl);
  assert.equal(capabilities.release, 'mcp-integration-test');
  assert.equal(capabilities.limits.maxDurationSeconds, 180);
  assert.equal(capabilities.limits.maxActiveJobs, 1);
  assert.ok(capabilities.excluded.includes('arbitrary execution'));

  const response = await call(client, 'probe_response', { bytes: 4097, marker: 'integration-end-marker' });
  assert.equal(response.payloadBytes, 4097);
  assert.equal(Buffer.byteLength(response.payload), 4097);
  assert.equal(response.sha256, createHash('sha256').update(response.payload).digest('hex'));
  assert.equal(response.endMarker, 'integration-end-marker');

  const failure = await client.callTool({ name: 'probe_failure', arguments: {} });
  assert.equal(failure.isError, true);
  assert.equal(failure.structuredContent.error.code, 'FIXTURE_ERROR');
  assert.match(failure.structuredContent.error.recovery, /probe_capabilities/);
  assert.equal((await call(client, 'probe_capabilities')).bootId, capabilities.bootId);

  const invalid = await client.callTool({ name: 'probe_jobs_list', arguments: { limit: 51 } });
  assert.equal(invalid.isError, true);
  assert.match(JSON.stringify(invalid.content), /50/);
  assert.deepEqual((await call(client, 'probe_jobs_list', { limit: 50 })).jobs, []);
  const receipts = await call(client, 'probe_observations', { limit: 100 });
  assert.ok(receipts.observations.some((record) => record.tool === 'probe_failure' && record.errorCode === 'FIXTURE_ERROR'));
  assert.ok(receipts.observations.some((record) => record.tool === 'probe_response' && record.resultJsonBytes > 4097));
});

test('MCP jobs are idempotent, finish independently, paginate evidence, recover in a new client, and cancel', async (t) => {
  const { client, connect, directory } = await fixture(t);
  const request = { idempotencyKey: 'mcp-integration-idempotent', label: 'MCP fixture', durationSeconds: 1, intervalSeconds: 1 };
  const started = await call(client, 'probe_job_start', request);
  assert.equal(started.job.status, 'queued');
  assert.equal((await call(client, 'probe_job_start', request)).job.id, started.job.id);
  const conflict = await client.callTool({ name: 'probe_job_start', arguments: { ...request, durationSeconds: 2 } });
  assert.equal(conflict.isError, true);
  assert.equal(conflict.structuredContent.error.code, 'IDEMPOTENCY_CONFLICT');

  const controller = new AbortController();
  const worker = runWorker({ dataDirectory: directory, pollIntervalMs: 20, signal: controller.signal });
  try {
    const completed = await waitForStatus(client, started.job.id, 'completed');
    assert.ok(completed.startedAt && completed.finishedAt);
    const records = [];
    let cursor = 0;
    for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
      const page = await call(client, 'probe_job_logs', { jobId: started.job.id, cursor, limit: 1 });
      if (page.records.length === 0) { assert.equal(page.nextCursor, cursor); break; }
      assert.ok(page.nextCursor > cursor);
      records.push(...page.records);
      cursor = page.nextCursor;
    }
    assert.deepEqual(records.map((record) => record.sequence), [1, 2, 3]);
    assert.deepEqual(records.map((record) => record.event), ['STARTED', 'HEARTBEAT', 'COMPLETED']);
    assert.ok(records.every((record) => record.runId === started.job.id));
    assert.equal((await call(client, 'probe_job_start', request)).job.status, 'completed');

    const freshClient = await connect();
    const recovered = await call(freshClient, 'probe_jobs_list', { limit: 1 });
    assert.equal(recovered.jobs[0].id, started.job.id);
    assert.equal(recovered.jobs[0].status, 'completed');
    assert.equal(recovered.nextCursor, null);

    const cancellable = await call(client, 'probe_job_start', { ...request, idempotencyKey: 'mcp-integration-cancel', durationSeconds: 30 });
    await waitForStatus(client, cancellable.job.id, 'running');
    assert.equal((await call(client, 'probe_job_cancel', { jobId: cancellable.job.id })).job.cancellationRequested, true);
    await waitForStatus(client, cancellable.job.id, 'cancelled');
    const cancelledLogs = await call(client, 'probe_job_logs', { jobId: cancellable.job.id });
    assert.equal(cancelledLogs.records.at(-1).event, 'CANCELLED');
    assert.equal((await call(client, 'probe_job_cancel', { jobId: cancellable.job.id })).job.status, 'cancelled');
    assert.equal((await call(client, 'probe_job_cancel', { jobId: started.job.id })).job.status, 'completed');
  } finally { controller.abort(); await worker; }
});
