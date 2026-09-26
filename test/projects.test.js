import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { TrustedGit } from '../src/git/git.js';
import { GitBroker } from '../src/git/broker.js';
import { ProjectProvisioner, GitHubProvisioningClient, ownedProjectId, projectScaffold, projectBrokerSchemas } from '../src/git/projects.js';
import { CodeStore } from '../src/code/store.js';
import { WorkspaceManager } from '../src/code/workspaces.js';
import { CodeGit } from '../src/code/git.js';
import { CodeProjects } from '../src/code/projects.js';

const stamp = '2026-09-09T12:00:00.000Z';
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'praxis-new-project-'));
  const home = join(root, 'home'), exports = join(root, 'exports'), outbox = join(root, 'outbox');
  mkdirSync(home); mkdirSync(outbox);
  const git = new TrustedGit({ repositories: [], homeDirectory: home, allowLocalRemotes: true });
  const broker = new GitBroker({ dataDirectory: join(root, 'git'), exportDirectory: exports, outboxDirectory: outbox, repositories: [], git });
  const provisioner = new ProjectProvisioner({ broker, directory: join(root, 'projects'), account: 'FixtureOwner', ...options });
  const cleanup = [];
  t.after(async () => { for (const close of cleanup) await close(); await broker.close(); rmSync(root, { recursive: true, force: true }); });
  function prepare(kind, input = {}, owner = 'alice') {
    const args = projectBrokerSchemas[kind].parse({ operationId: randomUUID(), idempotencyKey: `test-${randomUUID()}`, ...input });
    const { projectId } = provisioner.admit(kind, owner, args);
    broker.db.prepare(`INSERT INTO git_operations(id,owner,kind,project_id,idempotency_key,request_json,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'queued',?,?)`).run(args.operationId, owner, kind, projectId, args.idempotencyKey, JSON.stringify(args), stamp, stamp);
    return { args, row: broker.row(owner, args.operationId) };
  }
  async function run(prepared) {
    const row = broker.row(prepared.row.owner, prepared.row.id);
    try {
      const result = await provisioner[{ projectCreate: 'runCreate', projectPublish: 'runPublish', projectAdopt: 'runAdopt' }[row.kind]](row, prepared.args);
      broker.update(row, 'completed', 'completed', result); return broker.row(row.owner, row.id);
    } catch (error) {
      const latest = broker.row(row.owner, row.id);
      const uncertain = error.uncertain || /_intent$/.test(latest.phase);
      broker.update(row, uncertain ? 'uncertain' : 'failed', latest.phase, latest.result_json ? JSON.parse(latest.result_json) : null, { code: error.code, message: error.message });
      throw error;
    }
  }
  return { root, home, exports, outbox, broker, git, provisioner, prepare, run, cleanup };
}
async function created(f, template = 'node') {
  const operation = f.prepare('projectCreate', { name: `demo-${template}`, template });
  const row = await f.run(operation), result = JSON.parse(row.result_json);
  return { operation, row, result, id: row.project_id };
}
function githubFixture(f, id, { failAt } = {}) {
  const origin = join(f.root, 'origin.git');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { stdio: 'ignore', windowsHide: true });
  const counts = { create: 0, key: 0, push: 0 }, state = { repository: null, key: null };
  let failure = failAt;
  f.provisioner.github = {
    async checkIdentity() {},
    async getRepository() { return state.repository; },
    async createRepository(name, visibility, marker) {
      counts.create++;
      state.repository = { id: 100, name, owner: { login: 'FixtureOwner' }, private: visibility === 'private', description: marker };
      if (failure === 'create') { failure = null; throw new Error('Lost response'); }
      return state.repository;
    },
    async findDeployKey() { return state.key; },
    async addDeployKey() {
      counts.key++; state.key = { id: 200, read_only: false };
      if (failure === 'key') { failure = null; throw new Error('Lost response'); }
      return state.key;
    }
  };
  f.provisioner.keyPair = async () => ({ publicKey: 'ssh-ed25519 fixture', transportEnv: {} });
  const originalRegister = f.git.registerRepository.bind(f.git);
  f.git.registerRepository = (config, options) => originalRegister(config.projectId === id ? { ...config, remoteUrl: origin } : config, options);
  const originalPush = f.git.push.bind(f.git);
  f.git.push = async (...args) => {
    counts.push++;
    const result = await originalPush(...args);
    if (failure === 'push') { failure = null; throw new Error('Lost response'); }
    return result;
  };
  return { counts, state, origin };
}
function seedOrigin(f, origin) {
  const work = join(f.root, `seed-${randomUUID()}`);
  execFileSync('git', ['init', '--initial-branch=main', work], { stdio: 'ignore', windowsHide: true });
  writeFileSync(join(work, 'README.md'), 'existing repository\n');
  const g = (...args) => execFileSync('git', ['-C', work, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { stdio: 'ignore', windowsHide: true });
  g('add', '.'); g('commit', '-m', 'existing history'); g('push', origin, 'main');
  return execFileSync('git', ['-C', work, 'rev-parse', 'HEAD']).toString().trim();
}
function existingRepository(overrides = {}) {
  return { id: 300, name: 'legacy', owner: { login: 'FixtureOwner' }, private: true, archived: false,
    default_branch: 'main', permissions: { admin: true }, ...overrides };
}

test('adoption verifies an existing repository, adds one key, mirrors main and registers a deployable adopted project', async t => {
  const f = fixture(t), id = ownedProjectId('alice', 'legacy'), fx = githubFixture(f, id);
  const head = seedOrigin(f, fx.origin);
  fx.state.repository = existingRepository();
  const done = await f.run(f.prepare('projectAdopt', { name: 'legacy' })), result = JSON.parse(done.result_json);
  assert.equal(done.status, 'completed'); assert.equal(result.commit, head); assert.equal(fx.counts.key, 1); assert.equal(fx.counts.create, 0);
  assert.equal(result.project.template, 'adopted'); assert.equal(result.project.repository, 'https://github.com/FixtureOwner/legacy');
  assert.equal(result.project.publication, 'private');
  const row = f.provisioner.get('alice', id); assert.equal(row.published, 1); assert.equal(row.initial_commit, head);
  const repo = f.broker.repositories.get(id); assert.equal(repo.adopted, true); assert.equal(repo.deployment, true); assert.equal(repo.localOnly, false);
  assert.match(result.revision, /^[a-f0-9]{64}$/);
  assert.equal(readFileSync(join(f.exports, done.id, 'files', 'README.md'), 'utf8'), 'existing repository\n');
  assert.throws(() => f.prepare('projectAdopt', { name: 'legacy' }), { code: 'PROJECT_EXISTS' });
  assert.throws(() => f.prepare('projectPublish', { projectId: id }), { code: 'PROJECT_ALREADY_PUBLISHED' });
});

test('adoption refuses missing, foreign, archived, non-admin and non-main repositories before any key is added', async t => {
  for (const [repository, code] of [[null, 'REPOSITORY_NOT_FOUND'], [existingRepository({ owner: { login: 'someone-else' } }), 'REPOSITORY_CONFLICT'],
    [existingRepository({ archived: true }), 'REPOSITORY_CONFLICT'], [existingRepository({ permissions: { admin: false } }), 'GITHUB_AUTHORIZATION_REQUIRED'],
    [existingRepository({ default_branch: 'master' }), 'UNSUPPORTED_REPOSITORY']]) {
    const f = fixture(t), fx = githubFixture(f, ownedProjectId('alice', 'legacy'));
    fx.state.repository = repository;
    await assert.rejects(f.run(f.prepare('projectAdopt', { name: 'legacy' })), { code });
    assert.equal(fx.counts.key, 0);
  }
});

test('a lost deploy-key response leaves adoption uncertain and recovery never adds a second key', async t => {
  const f = fixture(t), id = ownedProjectId('alice', 'legacy'), fx = githubFixture(f, id, { failAt: 'key' });
  const head = seedOrigin(f, fx.origin);
  fx.state.repository = existingRepository();
  const prepared = f.prepare('projectAdopt', { name: 'legacy' });
  await assert.rejects(f.run(prepared));
  assert.equal(f.broker.row('alice', prepared.row.id).status, 'uncertain');
  const recovered = await f.run(prepared);
  assert.equal(recovered.status, 'completed'); assert.equal(JSON.parse(recovered.result_json).commit, head); assert.equal(fx.counts.key, 1);
});

test('adopted projects cannot use the stateless app deployer', async t => {
  const f = fixture(t), id = ownedProjectId('alice', 'legacy'), fx = githubFixture(f, id);
  seedOrigin(f, fx.origin); fx.state.repository = existingRepository();
  const done = await f.run(f.prepare('projectAdopt', { name: 'legacy' }));
  f.broker.projectDeployment = async () => { throw new Error('must not be called'); };
  assert.throws(() => f.broker.submit('projectDeploy', { owner: 'alice', operationId: randomUUID(), idempotencyKey: 'adopted-app-deploy',
    publicationOperationId: done.id, expectedHead: null }), error => ['DEPLOYMENT_DISABLED', 'OPERATION_NOT_READY', 'INVALID_ARGUMENT'].includes(error.code));
});

test('safe project names and owner namespaces cannot select paths or another owner project', t => {
  const f = fixture(t);
  assert.notEqual(ownedProjectId('alice', 'same-name'), ownedProjectId('bob', 'same-name'));
  for (const value of ['../x', 'UPPER', 'x/y', '-option', 'x.git', 'x'.repeat(41), 'a\nb', 'a:b']) {
    assert.throws(() => ownedProjectId('alice', value), { code: 'INVALID_ARGUMENT' });
    assert.equal(projectBrokerSchemas.projectCreate.safeParse({ name: value, template: 'node', operationId: randomUUID(), idempotencyKey: 'project-create' }).success, false);
  }
  assert.throws(() => f.provisioner.get('bob', ownedProjectId('alice', 'demo')), { code: 'NOT_FOUND' });
});

test('all templates produce real initial Git commits, immutable exports and restartable registrations', async t => {
  const f = fixture(t);
  for (const template of ['node', 'python', 'static']) {
    const made = await created(f, template), result = made.result;
    assert.match(result.commit, /^[a-f0-9]{40}$/);
    assert.equal(result.project.publication, 'local'); assert.equal(result.project.repository, null);
    const files = await f.git.readTree(made.id, result.commit);
    assert(files.some(file => file.path === 'README.md'));
    assert(files.every(file => file.type === 'blob' && file.mode === '100644'));
    assert.equal(readFileSync(join(f.exports, made.row.id, 'files', 'README.md'), 'utf8'), projectScaffold(`demo-${template}`, template).files['README.md']);
    const command = template === 'node' ? [process.execPath, '--test'] : [process.platform === 'win32' ? 'python' : 'python3', '-m', 'unittest', 'discover', '-v'];
    execFileSync(command[0], command.slice(1), { cwd: join(f.exports, made.row.id, 'files'), windowsHide: true, timeout: 15000, stdio: 'pipe',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    const repeated = await f.run(made.operation);
    assert.equal(JSON.parse(repeated.result_json).commit, result.commit, 'local restart recreates exactly the same root commit');
    assert.throws(() => f.prepare('projectCreate', { name: `demo-${template}`, template }), { code: 'PROJECT_EXISTS' });
    assert.throws(() => f.prepare('projectPublish', { projectId: made.id }, 'bob'), { code: 'NOT_FOUND' });
  }
  f.git.repositories.clear(); f.broker.repositories.clear();
  new ProjectProvisioner({ broker: f.broker, directory: join(f.root, 'projects'), account: 'FixtureOwner' });
  assert.equal(f.git.repositories.size, 3);
  assert.equal(f.broker.repositories.size, 3);
});

test('a local project remains usable when remote provisioning is not configured', async t => {
  const f = fixture(t), made = await created(f);
  const publication = f.prepare('projectPublish', { projectId: made.id });
  await assert.rejects(f.run(publication), { code: 'GITHUB_SETUP_REQUIRED' });
  assert.equal(f.broker.row('alice', publication.row.id).status, 'failed');
  assert.equal(f.provisioner.get('alice', made.id).published, 0);
  assert((await f.git.readTree(made.id, made.result.commit)).length > 0);
});

test('first publication creates a private repository, adds a scoped key and publishes exact main', async t => {
  const f = fixture(t), made = await created(f), remote = githubFixture(f, made.id);
  const publication = f.prepare('projectPublish', { projectId: made.id });
  assert.equal(publication.args.visibility, 'private');
  const row = await f.run(publication), result = JSON.parse(row.result_json);
  assert.equal(result.publishedCommit, made.result.commit);
  assert.equal(remote.state.repository.private, true);
  assert.deepEqual(remote.counts, { create: 1, key: 1, push: 1 });
  assert.equal((await f.git.remoteHead(made.id)).commit, made.result.commit);
  assert.equal(f.broker.policy(made.id, 'alice').localOnly, false);
  assert.throws(() => f.prepare('projectPublish', { projectId: made.id }), { code: 'PROJECT_ALREADY_PUBLISHED' });
});

for (const failAt of ['create', 'key', 'push']) test(`lost ${failAt} response is observed without duplicating the remote effect`, async t => {
  const f = fixture(t), made = await created(f), remote = githubFixture(f, made.id, { failAt });
  const publication = f.prepare('projectPublish', { projectId: made.id, visibility: 'public' });
  await assert.rejects(f.run(publication));
  assert.equal(f.broker.row('alice', publication.row.id).status, 'uncertain');
  const recovered = await f.run(publication);
  assert.equal(recovered.status, 'completed');
  assert.equal(remote.state.repository.private, false);
  assert.deepEqual(remote.counts, { create: 1, key: 1, push: 1 });
});

test('unknown creation and existing repository collisions never adopt or repeat a mutation', async t => {
  const f = fixture(t), made = await created(f), remote = githubFixture(f, made.id);
  remote.state.repository = { id: 200, name: 'demo-node', private: true, description: 'Unrelated existing repository' };
  const collision = f.prepare('projectPublish', { projectId: made.id });
  await assert.rejects(f.run(collision), { code: 'REPOSITORY_EXISTS' });
  assert.deepEqual(remote.counts, { create: 0, key: 0, push: 0 });
  remote.state.repository = null;
  const uncertain = f.prepare('projectPublish', { projectId: made.id });
  f.broker.update(uncertain.row, 'uncertain', 'project_remote_intent', { commit: made.result.commit, visibility: 'private' });
  await assert.rejects(f.run(uncertain), { code: 'PROJECT_PUBLICATION_UNCERTAIN', uncertain: true });
  assert.deepEqual(remote.counts, { create: 0, key: 0, push: 0 });
});

test('read-only publication recovery cannot initiate unattempted key or push effects', async t => {
  const f = fixture(t), made = await created(f), remote = githubFixture(f, made.id, { failAt: 'create' });
  f.broker.projectProvisioner = f.provisioner;
  const publication = f.prepare('projectPublish', { projectId: made.id });
  await assert.rejects(f.run(publication));
  const before = { ...remote.counts };
  const observed = await f.broker.observe({ owner: 'alice', operationId: publication.row.id });
  assert.equal(observed.status, 'uncertain'); assert.deepEqual(remote.counts, before);
  const resumed = f.broker.submit('projectPublish', { owner: 'alice', ...publication.args });
  assert.equal(resumed.status, 'queued');
  await f.run(publication);
  assert.deepEqual(remote.counts, { create: 1, key: 1, push: 1 });
});

test('missing saved deploy credentials are not regenerated during recovery', async t => {
  const f = fixture(t), made = await created(f);
  await assert.rejects(f.provisioner.keyPair(made.id, { allowCreate: false }), { code: 'PROJECT_CREDENTIAL_MISSING' });
  const original = await f.provisioner.keyPair(made.id);
  const recovered = await f.provisioner.keyPair(made.id, { allowCreate: false });
  assert.equal(original.publicKey, recovered.publicKey);
  assert.match(original.publicKey, /^ssh-ed25519 /);
  assert.match(original.transportEnv.GIT_SSH_COMMAND, /IdentitiesOnly=yes/);
});

test('a completed local workspace commit can be the first published main', async t => {
  const f = fixture(t), made = await created(f), remote = githubFixture(f, made.id);
  const next = await f.git.createCommit(made.id, { parent: made.result.commit, timestamp: stamp, message: 'Build useful app',
    changes: [{ path: 'app.js', content: Buffer.from('export const ready = true;\n'), mode: '100644' }] });
  const commitId = randomUUID();
  f.broker.db.prepare(`INSERT INTO git_operations(id,owner,kind,project_id,idempotency_key,request_json,status,result_json,created_at,updated_at)
    VALUES(?,'alice','commit',?,?,?,'completed',?,?,?)`).run(commitId, made.id, `commit-${commitId}`, '{}', JSON.stringify({ commit: next.commit }), stamp, stamp);
  const published = await f.run(f.prepare('projectPublish', { projectId: made.id, commitOperationId: commitId }));
  assert.equal(JSON.parse(published.result_json).commit, next.commit);
  assert.equal((await f.git.remoteHead(made.id)).commit, next.commit);
  assert.equal(remote.counts.push, 1);
});

test('GitHub API uses the fixed account, private default, bounded errors and private credentials', async t => {
  const f = fixture(t), tokenFile = join(f.home, 'provision-token');
  writeFileSync(tokenFile, 'github_pat_TESTONLY123456789', { mode: 0o600 }); chmodSync(tokenFile, 0o600);
  const calls = [];
  const client = new GitHubProvisioningClient({ account: 'FixtureOwner', tokenFile, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => url.endsWith('/user') ? { login: 'FixtureOwner' } : { id: 100 } };
  } });
  await client.checkIdentity(); await client.createRepository('new-app', undefined, 'receipt');
  assert.equal(calls[0].url, 'https://api.github.com/user');
  assert.equal(calls[1].url, 'https://api.github.com/user/repos');
  assert.equal(JSON.parse(calls[1].options.body).private, true);
  assert.equal(calls[1].options.redirect, 'error');
  assert.throws(() => client.repoPath('../other'), { code: 'INVALID_ARGUMENT' });
  client.fetch = async () => ({ status: 403, ok: false, json: async () => ({ message: 'SECRET-TOKEN' }) });
  await assert.rejects(client.getRepository('new-app'), error => error.code === 'GITHUB_AUTHORIZATION_REQUIRED' && !error.message.includes('SECRET'));
  client.fetch = async () => ({ status: 200, ok: true, json: async () => ({ login: 'WrongOwner' }) });
  await assert.rejects(client.checkIdentity(), { code: 'GITHUB_ACCOUNT_MISMATCH' });
});

test('coding adapter verifies source, restores owner registration and supports ordinary isolated workspaces', async t => {
  const f = fixture(t), made = await created(f), store = new CodeStore(join(f.root, 'code-private'));
  store.db.exec('CREATE TABLE code_jobs (id TEXT, owner TEXT, workspace_id TEXT, status TEXT)');
  f.cleanup.push(() => store.close());
  const workspaceOptions = { store, dataDirectory: join(f.root, 'code-private'), workspaceDirectory: join(f.root, 'workspaces'), projects: [] };
  const workspaces = new WorkspaceManager(workspaceOptions);
  const codeGit = new CodeGit({ store, workspaces, broker: {}, outboxDirectory: f.outbox, exportDirectory: f.exports });
  const projects = new CodeProjects({ git: codeGit });
  const codeRow = { id: made.row.id, owner: 'alice', project_id: made.id, kind: 'projectCreate' };
  projects.integrate(codeRow, { result: made.result });
  assert.equal(workspaces.projects.get(made.id).owner, 'alice');
  assert.equal(workspaces.projects.get(made.id).revision, made.result.commit);
  const workspace = workspaces.create({ owner: 'alice', projectId: made.id, baseRevision: made.result.commit, idempotencyKey: 'new-app-workspace' });
  assert.equal(workspaces.read({ owner: 'alice', workspaceId: workspace.workspaceId, path: 'app.js' }).path, 'app.js');
  const restored = new WorkspaceManager(workspaceOptions);
  new CodeProjects({ git: { ...codeGit, workspaces: restored } });
  assert.equal(restored.projects.get(made.id).owner, 'alice');
  assert.throws(() => projects.integrate({ ...codeRow, owner: 'bob' }, { result: made.result }), { code: 'BROKER_PROTOCOL_ERROR' });
});
