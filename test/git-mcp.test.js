import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../src/server.js';
import { createCodingService } from '../src/code/server.js';
import { createGitService } from '../src/git/server.js';
import { TrustedGit } from '../src/git/git.js';

// Actual local Git and authenticated HTTP/MCP transport; deployment activation is an explicit fixture.
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'praxis-git-mcp-'));
  const origin = join(root, 'origin.git'), mirror = join(root, 'mirror.git'), home = join(root, 'home'), snapshot = join(root, 'snapshot');
  for (const path of [home, snapshot]) mkdirSync(path);
  for (const path of [origin, mirror]) execFileSync('git', ['init', '--bare', '--initial-branch=main', path], { windowsHide: true, stdio: 'ignore' });
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' };
  const rawGit = (directory, args, input) => execFileSync('git', ['--git-dir', directory, ...args], { env, input, encoding: 'utf8', windowsHide: true }).trim();
  const before = 'export const answer = 41;\n';
  const blob = rawGit(origin, ['hash-object', '-w', '--stdin'], before);
  const tree = rawGit(origin, ['mktree'], `100644 blob ${blob}\tanswer.js\n`);
  const base = rawGit(origin, ['commit-tree', tree, '-m', 'Fixture baseline']);
  rawGit(origin, ['update-ref', 'refs/heads/main', base]);
  writeFileSync(join(snapshot, 'answer.js'), before);
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const privateJwk = { ...await exportJWK(privateKey), kid: 'git-mcp-fixture', use: 'sig', alg: 'RS256' };
  const publicJwk = { ...await exportJWK(publicKey), kid: 'git-mcp-fixture', use: 'sig', alg: 'RS256' };
  const salt = randomBytes(16), passwordHash = `scrypt$${salt.toString('base64url')}$${scryptSync('fixture-password', salt, 64).toString('base64url')}`;
  let gateway, backend, publishing;
  const gatewayHttp = createServer((req, res) => gateway.app(req, res));
  const backendHttp = createServer((req, res) => backend.app(req, res));
  const publishingHttp = createServer((req, res) => publishing.app(req, res));
  for (const server of [gatewayHttp, backendHttp, publishingHttp]) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${gatewayHttp.address().port}/praxis`, resourceUrl = `${baseUrl}/mcp`, issuer = `${baseUrl}/oauth`;
  const backendUrl = `http://127.0.0.1:${backendHttp.address().port}`, publishingUrl = `http://127.0.0.1:${publishingHttp.address().port}`;
  const repositories = [{ projectId: 'fixture', directory: mirror, remoteUrl: origin, defaultBranch: 'main', deployment: true,
    author: { name: 'Praxis Fixture', email: 'praxis-fixture@example.com' } }];
  const transport = new TrustedGit({ repositories, homeDirectory: home, allowLocalRemotes: true });
  const outboxDirectory = join(root, 'outbox'), exportDirectory = join(root, 'exports');
  mkdirSync(outboxDirectory); mkdirSync(exportDirectory);
  const activations = [], applied = new Map(); let deployedHead = base;
  const deployment = async input => {
    if (input.action === 'status') return input.operationId ? { operation: applied.get(input.operationId) } : { head: deployedHead, managedService: 'fixture', active: true };
    if (applied.has(input.operationId)) return applied.get(input.operationId);
    assert.equal(input.expectedHead, deployedHead);
    assert.equal(rawGit(origin, ['rev-parse', 'refs/heads/main']), input.targetCommit);
    activations.push(input); deployedHead = input.targetCommit;
    const result = { operationId: input.operationId, phase: 'completed', previousHead: input.expectedHead, head: input.targetCommit, processActive: true, fixture: true };
    applied.set(input.operationId, result); return result;
  };
  const publishingConfig = { issuer, resourceUrl, publicJwks: { keys: [publicJwk] }, dataDirectory: join(root, 'publishing-private'),
    release: 'git-fixture', pollIntervalMs: 20, outboxDirectory, exportDirectory, git: transport, repositories, deployment };
  publishing = createGitService(publishingConfig);
  const backendConfig = { issuer, resourceUrl, publicJwks: { keys: [publicJwk] }, dataDirectory: join(root, 'coding-private'),
    workspaceDirectory: join(root, 'workspaces'), release: 'git-fixture', pollIntervalMs: 20,
    runner: { async inspect() { return { exists: false }; } },
    git: { url: `${publishingUrl}/call`, outboxDirectory, exportDirectory, projectIds: ['fixture'] },
    projects: [{ id: 'fixture', name: 'Real Git fixture', repository: 'fixture:local-git', revision: base, snapshotPath: snapshot }] };
  backend = await createCodingService(backendConfig);
  const gatewayConfig = { baseUrl, allowLoopback: true, dataDirectory: join(root, 'gateway-private'), release: 'git-fixture', coding: { url: backendUrl },
    auth: { passwordHash, jwks: { keys: [privateJwk] }, cookieKeys: ['git-fixture-cookie-signing-key-at-least-32-characters'] } };
  gateway = await createApp(gatewayConfig);
  const clients = [];
  const token = (scope = 'praxis:code') => new SignJWT({ scope, client_id: 'git-fixture-client' })
    .setProtectedHeader({ alg: 'RS256', kid: privateJwk.kid, typ: 'at+jwt' }).setIssuer(issuer).setAudience(resourceUrl)
    .setSubject('jensen').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  async function connect(scope = 'praxis:code') {
    const client = new Client({ name: 'git-workflow-fixture', version: '1.0.0' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(resourceUrl), { requestInit: { headers: { authorization: `Bearer ${await token(scope)}` } } }));
    return client;
  }
  t.after(async () => {
    for (const client of clients) await client.close();
    for (const server of [gatewayHttp, backendHttp, publishingHttp]) await new Promise(resolve => server.close(resolve));
    await gateway.close(); await backend.close(); await publishing.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, base, origin, mirror, rawGit, connect, token, backendUrl, publishingUrl, activations,
    backend: () => backend, publishing: () => publishing,
    async restart() {
      await backend.close(); await publishing.close(); await gateway.close();
      publishing = createGitService(publishingConfig); backend = await createCodingService(backendConfig); gateway = await createApp(gatewayConfig);
    } };
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result)); assert.equal(result.structuredContent.ok, true);
  return result.structuredContent;
}
async function terminal(client, operationId) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const receipt = await call(client, 'git_operation_status', { operationId });
    if (['completed', 'failed', 'uncertain'].includes(receipt.status)) {
      assert.equal(receipt.status, 'completed', JSON.stringify(receipt)); return receipt;
    }
    await delay(20);
  }
  assert.fail('Git operation did not reach its terminal receipt');
}

test('authenticated MCP independently syncs, commits, pushes main, and recovers deployment through all three services', { timeout: 60000 }, async t => {
  const f = await fixture(t), client = await f.connect();
  const tools = await client.listTools();
  for (const name of ['project_sync', 'git_commit', 'git_push', 'git_operation_status', 'git_operations_list', 'deployment_status', 'deployment_fast_forward']) assert.ok(tools.tools.some(tool => tool.name === name));
  const sync = await call(client, 'project_sync', { projectId: 'fixture', idempotencyKey: 'mcp-sync-main' });
  const synced = await terminal(client, sync.operationId);
  assert.equal(synced.result.commit, f.base);
  const project = await call(client, 'project_inspect', { projectId: 'fixture' });
  const workspace = await call(client, 'workspace_create', { projectId: 'fixture', baseRevision: project.revision, idempotencyKey: 'mcp-create-real-workspace', label: 'Real workflow' });
  const workspaceId = workspace.workspaceId;
  const before = await call(client, 'file_read', { workspaceId, path: 'answer.js' });
  const edit = await call(client, 'workspace_apply', { workspaceId, expectedRevision: before.revision, idempotencyKey: 'mcp-edit-real-source', changes: [
    { action: 'patch', path: 'answer.js', expectedSha256: before.sha256, oldText: '41', newText: '42' },
  ] });
  const diff = await call(client, 'workspace_diff', { workspaceId, expectedRevision: edit.result.revision });
  assert.match(diff.diff, /answer = 42/);
  const args = { workspaceId, expectedRevision: edit.result.revision, idempotencyKey: 'mcp-commit-real-source', message: 'Correct the fixture answer' };
  const commit = await call(client, 'git_commit', args), committed = await terminal(client, commit.operationId);
  assert.equal(committed.result.parentCommit, f.base);
  assert.equal(f.rawGit(f.mirror, ['show', `${committed.result.commit}:answer.js`]), 'export const answer = 42;');
  assert.equal(f.rawGit(f.origin, ['rev-parse', 'refs/heads/main']), f.base, 'commit alone does not publish');
  assert.equal((await call(client, 'git_commit', args)).operationId, commit.operationId);
  const push = await call(client, 'git_push', { commitOperationId: commit.operationId, idempotencyKey: 'mcp-push-real-main' });
  await terminal(client, push.operationId);
  assert.equal(f.rawGit(f.origin, ['rev-parse', 'refs/heads/main']), committed.result.commit);
  assert.equal(f.rawGit(f.origin, ['show', 'main:answer.js']), 'export const answer = 42;');
  await f.restart();
  const recovery = await f.connect();
  const recovered = await call(recovery, 'git_operations_list', { workspaceId });
  assert.deepEqual(recovered.operations.map(operation => operation.kind), ['push', 'commit']);
  assert.equal((await terminal(recovery, commit.operationId)).result.commit, committed.result.commit);
  const deployed = await call(recovery, 'deployment_status', { projectId: 'fixture' });
  assert.equal(deployed.head, f.base);
  const deployArgs = { pushOperationId: push.operationId, expectedHead: deployed.head, idempotencyKey: 'mcp-deploy-real-commit' };
  const deploy = await call(recovery, 'deployment_fast_forward', deployArgs), completed = await terminal(recovery, deploy.operationId);
  assert.equal(completed.result.fixture, true);
  assert.equal(completed.result.head, committed.result.commit);
  assert.equal(f.activations.length, 1);
  assert.equal((await call(recovery, 'deployment_fast_forward', deployArgs)).operationId, deploy.operationId);
  assert.equal(f.activations.length, 1);
  const state = JSON.stringify(f.backend().store.db.prepare('SELECT * FROM code_git_requests').all());
  assert.doesNotMatch(state, /Bearer |eyJhbGci/);
  assert.equal(f.publishing().broker.db.prepare('SELECT COUNT(*) AS n FROM git_operations').get().n, 4);
});

test('gateway, coding adapter, and publishing broker each reject probe permission and owner injection', { timeout: 60000 }, async t => {
  const f = await fixture(t), probe = await f.connect('praxis:probe');
  const denied = await probe.callTool({ name: 'project_sync', arguments: { projectId: 'fixture', idempotencyKey: 'denied-sync-main' } });
  assert.equal(denied.isError, true); assert.equal(denied.structuredContent.error.code, 'AUTHORIZATION_REQUIRED');
  for (const [url, action, args] of [[f.backendUrl, 'project_sync', { projectId: 'fixture', idempotencyKey: 'denied-backend-sync' }],
    [f.publishingUrl, 'list', {}]]) {
    const response = await fetch(`${url}/call`, { method: 'POST', headers: { authorization: `Bearer ${await f.token('praxis:probe')}`, 'content-type': 'application/json' }, body: JSON.stringify({ action, args }) });
    assert.equal(response.status, 401);
  }
  for (const [url, action] of [[f.backendUrl, 'git_operations_list'], [f.publishingUrl, 'list']]) {
    const response = await fetch(`${url}/call`, { method: 'POST', headers: { authorization: `Bearer ${await f.token()}`, 'content-type': 'application/json' }, body: JSON.stringify({ action, args: { owner: 'another-owner' } }) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_ARGUMENT');
  }
  assert.equal(f.publishing().broker.db.prepare('SELECT COUNT(*) AS n FROM git_operations').get().n, 0);
  assert.equal(f.backend().store.db.prepare('SELECT COUNT(*) AS n FROM code_git_requests').get().n, 0);
});
