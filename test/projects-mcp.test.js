import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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

test('authenticated MCP creates, edits, commits and publishes a new project, then recovers after service restart', { timeout: 60000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'praxis-new-project-mcp-'));
  const home = join(root, 'home'), origin = join(root, 'origin.git'), outboxDirectory = join(root, 'outbox'), exportDirectory = join(root, 'exports');
  for (const path of [home, outboxDirectory, exportDirectory]) mkdirSync(path);
  execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { windowsHide: true, stdio: 'ignore' });
  const transport = new TrustedGit({ repositories: [], homeDirectory: home, allowLocalRemotes: true });
  const register = transport.registerRepository.bind(transport);
  transport.registerRepository = (repository, options) => register({ ...repository, remoteUrl: origin }, options);
  const rawGit = args => execFileSync('git', ['--git-dir', origin, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  let remote, remoteKey, createCalls = 0;
  const github = {
    async checkIdentity() {}, async getRepository() { return remote; },
    async createRepository(name, visibility, marker) {
      createCalls++; remote = { id: 10, name, private: visibility === 'private', description: marker, owner: { login: 'FixtureOwner' } }; return remote;
    },
    async findDeployKey() { return remoteKey; }, async addDeployKey() { return (remoteKey = { id: 20, read_only: false }); }
  };
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const privateJwk = { ...await exportJWK(privateKey), kid: 'project-mcp', use: 'sig', alg: 'RS256' };
  const publicJwk = { ...await exportJWK(publicKey), kid: 'project-mcp', use: 'sig', alg: 'RS256' };
  let gateway, backend, publishing;
  const gatewayHttp = createServer((req, res) => gateway.app(req, res));
  const backendHttp = createServer((req, res) => backend.app(req, res));
  const publishingHttp = createServer((req, res) => publishing.app(req, res));
  for (const server of [gatewayHttp, backendHttp, publishingHttp]) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${gatewayHttp.address().port}/praxis`, resourceUrl = `${baseUrl}/mcp`, issuer = `${baseUrl}/oauth`;
  const publishingConfig = { issuer, resourceUrl, publicJwks: { keys: [publicJwk] }, release: 'new-project-fixture', pollIntervalMs: 20,
    dataDirectory: join(root, 'publishing-private'), outboxDirectory, exportDirectory, repositories: [], git: transport,
    projectProvisioning: { account: 'FixtureOwner', directory: join(root, 'protected-projects'), github } };
  const backendConfig = { issuer, resourceUrl, publicJwks: { keys: [publicJwk] }, release: 'new-project-fixture', pollIntervalMs: 20,
    dataDirectory: join(root, 'coding-private'), workspaceDirectory: join(root, 'workspaces'), projects: [],
    runner: { async inspect() { return { exists: false }; } },
    git: { url: `http://127.0.0.1:${publishingHttp.address().port}/call`, outboxDirectory, exportDirectory, projectIds: [] } };
  const salt = randomBytes(16), passwordHash = `scrypt$${salt.toString('base64url')}$${scryptSync('fixture-password', salt, 64).toString('base64url')}`;
  const gatewayConfig = { baseUrl, allowLoopback: true, dataDirectory: join(root, 'gateway-private'), release: 'new-project-fixture',
    coding: { url: `http://127.0.0.1:${backendHttp.address().port}` }, auth: { passwordHash, jwks: { keys: [privateJwk] }, cookieKeys: ['new-project-cookie-key-at-least-32-characters'] } };
  async function start() {
    publishing = createGitService(publishingConfig);
    publishing.broker.projectProvisioner.keyPair = async () => ({ publicKey: 'ssh-ed25519 fixture', transportEnv: {} });
    backend = await createCodingService(backendConfig); gateway = await createApp(gatewayConfig);
  }
  await start();
  const clients = [];
  async function connect() {
    const token = await new SignJWT({ scope: 'praxis:code', client_id: 'new-project-fixture' }).setProtectedHeader({ alg: 'RS256', kid: privateJwk.kid, typ: 'at+jwt' })
      .setIssuer(issuer).setAudience(resourceUrl).setSubject('jensen').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    const client = new Client({ name: 'new-project-fixture', version: '1.0.0' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(resourceUrl), { requestInit: { headers: { authorization: `Bearer ${token}` } } })); return client;
  }
  t.after(async () => {
    for (const client of clients) await client.close();
    for (const server of [gatewayHttp, backendHttp, publishingHttp]) await new Promise(resolve => server.close(resolve));
    await gateway.close(); await backend.close(); await publishing.close(); rmSync(root, { recursive: true, force: true });
  });
  async function call(client, name, args = {}) {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response)); return response.structuredContent;
  }
  async function terminal(client, operationId) {
    for (let i = 0; i < 500; i++) {
      const receipt = await call(client, 'git_operation_status', { operationId });
      if (['completed', 'failed', 'uncertain'].includes(receipt.status)) { assert.equal(receipt.status, 'completed', JSON.stringify(receipt)); return receipt; }
      await delay(20);
    }
    assert.fail('Project operation did not complete');
  }
  const client = await connect();
  const tools = await client.listTools();
  assert(tools.tools.some(tool => tool.name === 'project_create')); assert(tools.tools.some(tool => tool.name === 'project_publish'));
  const createArgs = { name: 'new-app', template: 'node', idempotencyKey: 'new-app-create-once' };
  const created = await call(client, 'project_create', createArgs), ready = await terminal(client, created.operationId);
  const projectId = ready.projectId;
  assert.equal((await call(client, 'project_create', createArgs)).operationId, created.operationId);
  assert.equal((await call(client, 'projects_list')).projects.length, 1);
  const project = await call(client, 'project_inspect', { projectId });
  assert.deepEqual(project.validationCommands, [['npm', 'test']]);
  const workspace = await call(client, 'workspace_create', { projectId, baseRevision: project.revision, idempotencyKey: 'new-app-workspace' });
  const file = await call(client, 'file_read', { workspaceId: workspace.workspaceId, path: 'app.js' });
  const edited = await call(client, 'workspace_apply', { workspaceId: workspace.workspaceId, expectedRevision: file.revision, idempotencyKey: 'new-app-edit', changes: [
    { action: 'patch', path: 'app.js', expectedSha256: file.sha256, oldText: "message: 'new-app'", newText: "message: 'A useful new application'" }
  ] });
  const committed = await terminal(client, (await call(client, 'git_commit', { workspaceId: workspace.workspaceId,
    expectedRevision: edited.result.revision, message: 'Build the new application', idempotencyKey: 'new-app-commit' })).operationId);
  const pushBeforePublish = await client.callTool({ name: 'git_push', arguments: { commitOperationId: committed.operationId, idempotencyKey: 'new-app-before-publish' } });
  assert.equal(pushBeforePublish.structuredContent.status, 'failed');
  assert.equal(pushBeforePublish.structuredContent.error.code, 'REPOSITORY_NOT_PUBLISHED');
  const publishArgs = { projectId, commitOperationId: committed.operationId, idempotencyKey: 'new-app-publish-private' };
  const published = await terminal(client, (await call(client, 'project_publish', publishArgs)).operationId);
  assert.equal(rawGit(['rev-parse', 'main']), committed.result.commit);
  assert.match(rawGit(['show', 'main:app.js']), /A useful new application/);
  assert.equal(remote.private, true); assert.equal(createCalls, 1);
  assert.equal(published.result.exportId, published.operationId);
  await gateway.close(); await backend.close(); await publishing.close(); await start();
  const recovery = await connect();
  assert.equal((await call(recovery, 'project_inspect', { projectId })).repository, 'https://github.com/FixtureOwner/new-app');
  assert.equal((await call(recovery, 'project_publish', publishArgs)).operationId, published.operationId);
  assert.equal(createCalls, 1);
  const sync = await terminal(recovery, (await call(recovery, 'project_sync', { projectId, idempotencyKey: 'new-app-sync-main' })).operationId);
  assert.equal(sync.result.commit, committed.result.commit);
  const journal = JSON.stringify(backend.store.db.prepare('SELECT * FROM code_git_requests').all());
  assert.doesNotMatch(journal, /Bearer |eyJhbGci|publish-key|GIT_SSH_COMMAND/);
});
