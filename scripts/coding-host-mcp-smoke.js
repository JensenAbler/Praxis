#!/usr/bin/env node
/** Run only in the dedicated hardened coding fixture unit, after host bootstrap. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, randomBytes, scryptSync, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../src/server.js';
import { createCodingService } from '../src/code/server.js';
import { containerName } from '../src/code/runner.js';

const startedAt = new Date().toISOString();
const fixtureId = randomUUID();
const receipt = {
  evidenceKind: 'authenticated-MCP-client-temporary-authority', fixtureId, startedAt,
  authentication: 'Ephemeral fixture issuer and signing keys; no live OAuth authority, owner password, or ChatGPT sign-in.',
  executor: 'Real PodmanRunner, using the protected fixed image and existing dedicated container storage.',
  gatewayRestartMode: 'Gateway application instance and HTTP listener recreated in the same fixture process; coding backend remains alive.',
  assertions: [], status: 'running',
};
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'timed_out']);
let phase = 'configuration', backend, gateway, gatewayHttp, backendHttp, fixtureJobId;
const clients = [];
const mark = (name, detail = {}) => receipt.assertions.push({ name, ...detail, passedAt: new Date().toISOString() });
const sha256 = value => createHash('sha256').update(value).digest('hex');
async function listen(server, port = 0) {
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  return server.address().port;
}
async function closeHttp(server) {
  if (!server?.listening) return;
  server.closeIdleConnections();
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `MCP tool failed: ${name}`);
  assert.equal(result.structuredContent?.ok, true, `MCP tool lacks a success result: ${name}`);
  return result.structuredContent;
}
async function awaitStatus(client, jobId, expected, maximumMs = 15000) {
  const deadline = Date.now() + maximumMs;
  while (Date.now() < deadline) {
    const job = await call(client, 'job_status', { jobId });
    if (job.status === expected) return job;
    if (terminal.has(job.status)) receipt.unexpectedJob = { id: job.id, status: job.status, exitCode: job.exitCode,
      executionError: job.executionError, terminationReason: job.terminationReason };
    assert.ok(!terminal.has(job.status), `Job reached an unexpected terminal status while waiting for ${expected}`);
    await delay(100);
  }
  throw Object.assign(new Error(`Job did not reach ${expected} in time`), { code: 'FIXTURE_DEADLINE' });
}

try {
  assert.equal(process.platform, 'linux', 'This smoke test requires the isolated Linux coding host.');
  assert.notEqual(process.getuid(), 0, 'Run the test as the dedicated coding identity, never root.');
  assert.equal(process.argv.length, 3, 'Supply one protected JSON configuration file with runnerConfig.');
  const supplied = JSON.parse(readFileSync(resolve(process.argv[2]), 'utf8'));
  assert.ok(supplied.runnerConfig && typeof supplied.runnerConfig.image === 'string', 'Protected runnerConfig is required.');
  receipt.release = supplied.release || 'host-mcp-fixture';
  receipt.image = supplied.runnerConfig.image;
  const directory = `/var/lib/praxis-code/mcp-fixture-${fixtureId}`;
  const workspaceDirectory = `/srv/praxis-code/storage/mcp-workspaces-${fixtureId}`;
  const snapshotPath = join(directory, 'snapshot');
  mkdirSync(snapshotPath, { recursive: true, mode: 0o700 });
  mkdirSync(workspaceDirectory, { recursive: true, mode: 0o700 });
  const files = {
    'answer.cjs': 'exports.answer = 41;\n',
    'rename-me.txt': 'Rename this fixture file.\n',
    'delete-me.txt': 'Delete this fixture file.\n',
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(snapshotPath, name), content, { mode: 0o444, flag: 'wx' });
  const baseRevision = sha256(JSON.stringify(files));
  receipt.source = { kind: 'synthetic immutable fixture', baseRevision };
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const kid = `host-fixture-${fixtureId}`;
  const privateJwk = { ...await exportJWK(privateKey), kid, use: 'sig', alg: 'RS256' };
  const publicJwk = { ...await exportJWK(publicKey), kid, use: 'sig', alg: 'RS256' };
  const salt = randomBytes(16), password = randomBytes(32);
  const passwordHash = `scrypt$${salt.toString('base64url')}$${scryptSync(password, salt, 64).toString('base64url')}`;
  password.fill(0);
  gatewayHttp = createServer((req, res) => gateway ? gateway.app(req, res) : res.writeHead(503).end());
  backendHttp = createServer((req, res) => backend ? backend.app(req, res) : res.writeHead(503).end());
  const gatewayPort = await listen(gatewayHttp), backendPort = await listen(backendHttp);
  const baseUrl = `http://127.0.0.1:${gatewayPort}/praxis-probe`;
  const backendUrl = `http://127.0.0.1:${backendPort}`, issuer = `${baseUrl}/oauth`, resourceUrl = `${baseUrl}/mcp`;
  const gatewayConfig = {
    baseUrl, allowLoopback: true, dataDirectory: join(directory, 'gateway'), release: receipt.release,
    coding: { url: backendUrl },
    auth: { passwordHash, jwks: { keys: [privateJwk] }, cookieKeys: [randomBytes(48).toString('base64url')] },
  };
  backend = await createCodingService({
    issuer, resourceUrl, publicJwks: { keys: [publicJwk] }, dataDirectory: join(directory, 'backend'),
    workspaceDirectory, release: receipt.release, pollIntervalMs: 100,
    runnerConfig: { ...supplied.runnerConfig, workspaceRoot: workspaceDirectory, logDirectory: join(directory, 'runner-logs') },
    projects: [{ id: 'host-fixture', name: 'Host MCP fixture', repository: 'fixture:synthetic', revision: baseRevision, snapshotPath,
      instructions: 'Synthetic source used only for authenticated transport and real container evidence.', validationCommands: [['node', '-e', "require('node:assert/strict').equal(require('./answer.cjs').answer, 42)"]] }],
  });
  gateway = await createApp(gatewayConfig);
  async function token(scope) {
    return new SignJWT({ scope, client_id: 'host-mcp-fixture-client' }).setProtectedHeader({ alg: 'RS256', kid, typ: 'at+jwt' })
      .setIssuer(issuer).setAudience(resourceUrl).setSubject('jensen').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  }
  async function connect(scope = 'praxis:code') {
    const client = new Client({ name: 'praxis-host-mcp-fixture', version: '1.0.0' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(resourceUrl), { requestInit: { headers: { authorization: `Bearer ${await token(scope)}` } } }));
    return client;
  }

  phase = 'permission_boundaries';
  const probeClient = await connect('praxis:probe');
  await call(probeClient, 'probe_capabilities');
  const denied = await probeClient.callTool({ name: 'projects_list', arguments: {} });
  assert.equal(denied.isError, true); assert.equal(denied.structuredContent.error.code, 'AUTHORIZATION_REQUIRED');
  for (const value of ['', 'invalid-fixture-token', await token('praxis:probe')]) {
    const response = await fetch(`${backendUrl}/call`, { method: 'POST', headers: { authorization: `Bearer ${value}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'projects_list', args: {} }) });
    assert.equal(response.status, 401);
  }
  const client = await connect();
  assert.equal((await client.callTool({ name: 'probe_capabilities', arguments: {} })).isError, true);
  mark(phase, { gatewayInsufficientScopeDenied: true, backendMissingMalformedAndProbeTokenDenied: true, codeTokenCannotUseProbeTools: true });

  phase = 'source_discovery_and_create';
  const capabilities = await call(client, 'capabilities');
  receipt.backendBootId = capabilities.bootId;
  assert.equal(capabilities.execution.imageDigest, receipt.image);
  assert.equal((await call(client, 'projects_list')).projects[0].projectId, 'host-fixture');
  assert.equal((await call(client, 'project_inspect', { projectId: 'host-fixture' })).revision, baseRevision);
  assert.equal((await call(client, 'files_list', { projectId: 'host-fixture' })).files.length, 3);
  const createRequest = { projectId: 'host-fixture', baseRevision, idempotencyKey: `create-${fixtureId}`, label: `Host MCP recovery ${fixtureId}` };
  const created = await call(client, 'workspace_create', createRequest), workspaceId = created.workspaceId;
  receipt.workspaceId = workspaceId; receipt.createOperationId = created.operationId;
  assert.equal((await call(client, 'workspace_create', createRequest)).operationId, created.operationId);
  assert.equal((await call(client, 'code_search', { workspaceId, query: '= 41' })).matches[0].path, 'answer.cjs');
  mark(phase, { workspaceId, createOperationId: created.operationId, createIdempotencyVerified: true });

  phase = 'all_edit_actions_and_conflicts';
  const answer = await call(client, 'file_read', { workspaceId, path: 'answer.cjs' });
  const rename = await call(client, 'file_read', { workspaceId, path: 'rename-me.txt' });
  const deletion = await call(client, 'file_read', { workspaceId, path: 'delete-me.txt' });
  const editRequest = { workspaceId, expectedRevision: answer.revision, idempotencyKey: `apply-${fixtureId}`, changes: [
    { action: 'patch', path: 'answer.cjs', expectedSha256: answer.sha256, oldText: '= 41', newText: '= 42' },
    { action: 'write', path: 'created.txt', expectedSha256: null, content: 'Created by authenticated MCP.\n' },
    { action: 'rename', path: 'rename-me.txt', to: 'renamed.txt', expectedSha256: rename.sha256 },
    { action: 'delete', path: 'delete-me.txt', expectedSha256: deletion.sha256 },
  ] };
  const edited = await call(client, 'workspace_apply', editRequest);
  receipt.applyOperationId = edited.operationId;
  assert.equal(edited.status, 'completed');
  assert.equal((await call(client, 'workspace_apply', editRequest)).operationId, edited.operationId);
  const stale = await client.callTool({ name: 'workspace_apply', arguments: { ...editRequest, idempotencyKey: `stale-${fixtureId}` } });
  assert.equal(stale.structuredContent.error.code, 'REVISION_CONFLICT');
  const pathEscape = await client.callTool({ name: 'file_read', arguments: { workspaceId, path: '../backend/coding.sqlite' } });
  assert.equal(pathEscape.isError, true);
  mark(phase, { actions: ['patch', 'write', 'rename', 'delete'], editIdempotencyVerified: true, staleRevisionDenied: true, pathEscapeDenied: true });

  phase = 'real_command_and_gateway_restart';
  const command = [
    "const fs = require('node:fs'); const assert = require('node:assert/strict');",
    "assert.equal(require('./answer.cjs').answer, 42);",
    "assert.equal(fs.readFileSync('created.txt', 'utf8'), 'Created by authenticated MCP.\\n');",
    "assert.equal(fs.readFileSync('renamed.txt', 'utf8'), 'Rename this fixture file.\\n');",
    "assert.equal(fs.existsSync('rename-me.txt'), false); assert.equal(fs.existsSync('delete-me.txt'), false);",
    "assert.equal(fs.existsSync('report.txt'), false); console.log('HOST_MCP_STARTED');",
    "fs.writeFileSync('report.txt', JSON.stringify({ fixture: 'authenticated-host-mcp', answer: 42, executions: 1 }) + '\\n');",
    "setTimeout(() => { console.log('HOST_MCP_COMPLETED'); }, 5000);",
  ].join('\n');
  const jobRequest = { workspaceId, expectedRevision: edited.result.revision, idempotencyKey: `job-${fixtureId}`, label: `Host MCP command ${fixtureId}`,
    argv: ['node', '-e', command], timeoutSeconds: 20, artifactPaths: ['report.txt'] };
  const job = await call(client, 'job_start', jobRequest); fixtureJobId = job.id; receipt.jobId = job.id;
  const running = await awaitStatus(client, job.id, 'running');
  const backendBefore = backend.jobs.get({ owner: 'jensen', jobId: job.id });
  assert.equal(backendBefore.status, 'running');
  for (const old of clients) await old.close();
  await closeHttp(gatewayHttp);
  await gateway.close(); gateway = undefined;
  gateway = await createApp(gatewayConfig);
  gatewayHttp = createServer((req, res) => gateway.app(req, res));
  await listen(gatewayHttp, gatewayPort);
  assert.equal((await backend.jobs.runner.inspect({ name: containerName(job.id) })).running, true,
    'The real container must still be running after the gateway was recreated.');
  receipt.gatewayRestartedAt = new Date().toISOString();
  mark(phase, { jobId: job.id, runningStartedAt: running.startedAt, realContainerRunningAfterGatewayRestart: true });

  phase = 'fresh_client_recovers_completed_job';
  const fresh = await connect();
  assert.equal((await call(fresh, 'capabilities')).bootId, receipt.backendBootId);
  const recovered = (await call(fresh, 'workspaces_list')).workspaces.find(workspace => workspace.label === createRequest.label);
  assert.equal(recovered?.workspaceId, workspaceId);
  const recoveredJob = (await call(fresh, 'jobs_list', { workspaceId: recovered.workspaceId })).jobs.find(item => item.label === jobRequest.label);
  assert.equal(recoveredJob?.id, job.id);
  const finished = await awaitStatus(fresh, recoveredJob.id, 'completed');
  assert.equal(finished.exitCode, 0); assert.equal(finished.startedAt, running.startedAt);
  assert.equal((await call(fresh, 'job_start', jobRequest)).id, job.id);
  assert.equal((await call(fresh, 'jobs_list', { workspaceId })).jobs.length, 1);
  receipt.jobStartedAt = finished.startedAt; receipt.jobFinishedAt = finished.finishedAt; receipt.jobExitCode = finished.exitCode;
  mark(phase, { sameWorkspace: true, sameJob: true, backendBootIdUnchanged: true, jobIdempotencyVerified: true });

  phase = 'persisted_logs_artifact_diff_and_mutation_receipts';
  const records = []; let logCursor = 0, logPages = 0;
  while (true) {
    const page = await call(fresh, 'job_logs', { jobId: job.id, cursor: logCursor, limit: 2 }); logPages++;
    records.push(...page.records); assert.equal(page.truncated, false);
    if (!page.hasMore) break;
    assert.ok(page.nextCursor > logCursor); logCursor = page.nextCursor;
    assert.ok(logPages < 100);
  }
  assert.deepEqual(records.map(record => record.sequence), records.map((_, index) => index + 1));
  assert.equal(records.filter(record => record.stream !== 'system' && record.text.includes('HOST_MCP_STARTED')).length, 1);
  assert.equal(records.filter(record => record.stream !== 'system' && record.text.includes('HOST_MCP_COMPLETED')).length, 1);
  assert.ok(records.some(record => record.stream === 'system' && record.text.startsWith('COMPLETED')));
  const artifact = (await call(fresh, 'artifact_list', { jobId: job.id })).artifacts.find(item => item.name === 'report.txt');
  assert.ok(artifact);
  const artifactParts = []; let artifactCursor = 0, artifactPages = 0;
  while (true) {
    const page = await call(fresh, 'artifact_read', { jobId: job.id, artifactId: artifact.id, cursor: artifactCursor, limit: 17 }); artifactPages++;
    artifactParts.push(Buffer.from(page.content, page.encoding));
    if (!page.hasMore) break;
    assert.ok(page.nextCursor > artifactCursor); artifactCursor = page.nextCursor;
    assert.ok(artifactPages < 100);
  }
  const artifactBytes = Buffer.concat(artifactParts);
  assert.equal(sha256(artifactBytes), artifact.sha256);
  assert.deepEqual(JSON.parse(artifactBytes.toString('utf8')), { fixture: 'authenticated-host-mcp', answer: 42, executions: 1 });
  const inspected = await call(fresh, 'workspace_inspect', { workspaceId });
  assert.equal(inspected.revision, finished.revisionAfter);
  let diff = '', diffCursor = 0, diffPages = 0;
  do {
    const page = await call(fresh, 'workspace_diff', { workspaceId, expectedRevision: inspected.revision, cursor: diffCursor, limit: 256 }); diffPages++;
    diff += page.diff; diffCursor = page.nextCursor; assert.ok(diffPages < 100);
  } while (diffCursor !== null);
  assert.match(diff, /\+exports.answer = 42/); assert.match(diff, /deleted file mode/); assert.match(diff, /new file mode/);
  assert.ok(diff.includes('renamed.txt') && diff.includes('created.txt') && diff.includes('report.txt'));
  assert.equal((await call(fresh, 'operation_read', { operationId: edited.operationId })).status, 'completed');
  assert.ok((await call(fresh, 'operations_list', { workspaceId })).operations.some(operation => operation.operationId === edited.operationId));
  receipt.artifact = { id: artifact.id, bytes: artifactBytes.length, sha256: artifact.sha256 };
  mark(phase, { logPages, logRecords: records.length, artifactPages, artifactHashIndependentlyVerified: true, diffPages, mutationReceiptRecovered: true });
  receipt.status = 'completed';
} catch (error) {
  receipt.status = 'failed';
  receipt.failure = { phase, code: /^[A-Z_]+$/.test(error.code || '') ? error.code : 'FIXTURE_ERROR', errorType: error.name || 'Error' };
  process.exitCode = 1;
} finally {
  // Cancel only this fixture's own active job. Never touch production jobs or other containers.
  if (backend && fixtureJobId) {
    try {
      const current = backend.jobs.get({ owner: 'jensen', jobId: fixtureJobId });
      if (!terminal.has(current.status)) {
        backend.jobs.cancel({ owner: 'jensen', jobId: fixtureJobId });
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline && !terminal.has(backend.jobs.get({ owner: 'jensen', jobId: fixtureJobId }).status)) {
          await backend.jobs.tick(); await delay(100);
        }
        receipt.cleanupJobStatus = backend.jobs.get({ owner: 'jensen', jobId: fixtureJobId }).status;
      }
    } catch { receipt.cleanupJobStatus = 'inspection_required'; }
  }
  for (const client of clients) { try { await client.close(); } catch { /* Already closed during gateway restart. */ } }
  for (const server of [gatewayHttp, backendHttp]) { try { await closeHttp(server); } catch { receipt.cleanupRequiresInspection = true; } }
  try { await gateway?.close(); } catch { receipt.cleanupRequiresInspection = true; }
  try { await backend?.close(); } catch { receipt.cleanupRequiresInspection = true; }
  if (receipt.cleanupRequiresInspection && receipt.status === 'completed') {
    receipt.status = 'failed'; receipt.failure = { phase: 'cleanup', code: 'CLEANUP_FAILED', errorType: 'Error' }; process.exitCode = 1;
  }
  receipt.finishedAt = new Date().toISOString();
  receipt.elapsedMilliseconds = Date.parse(receipt.finishedAt) - Date.parse(startedAt);
  receipt.fixtureStateRetained = true;
  process.stdout.write(JSON.stringify(receipt) + '\n');
}
