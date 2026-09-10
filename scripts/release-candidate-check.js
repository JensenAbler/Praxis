/** Fixed readiness client; candidate runs in a separate process and OS unit. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { randomBytes, scryptSync } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../src/server.js';
import { loadToolManifest } from '../src/tool-manifest.js';

if (process.env.PRAXIS_EXECUTION_MODE !== 'native-root') assert.notEqual(process.getuid?.(), 0);
const candidate = resolve(process.argv[2]), directory = resolve(process.argv[3]);
loadToolManifest(join(candidate, 'coding-tools.json'));
const listen = async server => { await new Promise(done => server.listen(0, '127.0.0.1', done)); return server.address().port; };
const reserve = createServer();
const port = await listen(reserve);
await new Promise(done => reserve.close(done));
const http = createServer((req, res) => gateway ? gateway.app(req, res) : res.writeHead(503).end());
const gatewayPort = await listen(http), baseUrl = `http://127.0.0.1:${gatewayPort}/praxis`, issuer = `${baseUrl}/oauth`, resourceUrl = `${baseUrl}/mcp`;
const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
const jwk = { ...await exportJWK(privateKey), kid: 'release-stage', use: 'sig', alg: 'RS256' };
const publicJwks = { keys: [{ ...await exportJWK(publicKey), kid: jwk.kid, use: 'sig', alg: 'RS256' }] };
const source = join(directory, 'source'); mkdirSync(source, { recursive: true });
writeFileSync(join(source, 'check.txt'), 'Praxis candidate readiness\n');
const outboxDirectory = join(directory, 'outbox'), exportDirectory = join(directory, 'exports');
mkdirSync(outboxDirectory, { recursive: true }); mkdirSync(exportDirectory, { recursive: true });
const backendConfig = { port, issuer, resourceUrl, publicJwks, dataDirectory: directory, workspaceDirectory: join(directory, 'workspaces'),
  staging: true, release: 'candidate-readiness',
  // Readiness only reads fixture state. Any accidental execution must fail closed.
  runnerConfig: { image: `sha256:${'0'.repeat(64)}`, workspaceRoot: join(directory, 'workspaces'),
    logDirectory: join(directory, 'runner-logs'), storageRoot: join(directory, 'runner-storage'),
    runRoot: join(directory, 'runner-runtime'), binary: '/usr/bin/false', runtimeBinary: '/usr/bin/false' },
  git: { url: 'http://127.0.0.1:1/call', outboxDirectory, exportDirectory },
  projects: [{ id: 'release-check', name: 'Release checker fixture', revision: 'a'.repeat(40), snapshotPath: source }] };
const configPath = join(directory, 'candidate.json'); writeFileSync(configPath, JSON.stringify(backendConfig));
const salt = randomBytes(16), password = randomBytes(32);
let gateway, client, child;
try {
  child = spawn(process.execPath, [join(candidate, 'src/code/server.js')], { env: { ...process.env, PRAXIS_CODING_CONFIG: configPath }, stdio: ['ignore', 'ignore', 'inherit'] });
  let started = false;
  for (let n = 0; n < 40; n++) {
    if (child.exitCode !== null) throw new Error('Candidate exited before readiness');
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) { started = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(started, 'Candidate startup deadline');
  gateway = await createApp({ baseUrl, allowLoopback: true, release: 'protected-checker', dataDirectory: join(directory, 'gateway'),
    coding: { url: `http://127.0.0.1:${port}` }, toolManifestPath: join(candidate, 'coding-tools.json'),
    auth: { passwordHash: `scrypt$${salt.toString('base64url')}$${scryptSync(password, salt, 64).toString('base64url')}`,
      jwks: { keys: [jwk] }, cookieKeys: [randomBytes(48).toString('base64url')] } });
  const token = await new SignJWT({ scope: 'praxis:code', client_id: 'candidate-check' }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid, typ: 'at+jwt' })
    .setIssuer(issuer).setAudience(resourceUrl).setSubject('jensen').setIssuedAt().setExpirationTime('2m').sign(privateKey);
  client = new Client({ name: 'protected-release-checker', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(resourceUrl), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const tools = await client.listTools(); assert.ok(tools.tools.some(tool => tool.name === 'job_status'));
  const call = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); assert.equal(result.structuredContent?.ok, true, name); return result.structuredContent; };
  assert.equal((await call('capabilities')).release, 'candidate-readiness');
  const read = await call('file_read', { projectId: 'release-check', path: 'check.txt' });
  assert.ok(JSON.stringify(read).includes('Praxis candidate readiness'));
  const jobs = await call('jobs_list');
  const first = jobs.jobs?.[0];
  if (first) await call('job_status', { jobId: first.id });
  const denied = await fetch(resourceUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer invalid' }, body: '{}' });
  assert.equal(denied.status, 401);
  console.log(JSON.stringify({ ok: true, checks: ['authenticated MCP initialization', 'tool discovery', 'source read', 'job listing/status', 'invalid auth rejection'], existingJobInspected: Boolean(first) }));
} finally {
  await client?.close();
  child?.kill('SIGTERM');
  if (child && child.exitCode === null) await new Promise(done => { child.once('exit', done); setTimeout(() => { child.kill('SIGKILL'); done(); }, 5000).unref(); });
  await gateway?.close();
  http.closeAllConnections(); await new Promise(done => http.close(done));
}
