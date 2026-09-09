import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, linkSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { TrustedGit, GitTransportError } from '../src/git/git.js';
import { GitBroker } from '../src/git/broker.js';
import { sha256 } from '../src/code/paths.js';

const owner = 'fixture-owner';
const environment = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com',
  GIT_AUTHOR_DATE: '2026-09-09T00:00:00Z', GIT_COMMITTER_DATE: '2026-09-09T00:00:00Z', GIT_CONFIG_NOSYSTEM: '1' };
function git(directory, args, input) {
  return execFileSync('git', ['--git-dir', directory, ...args], { env: environment, input, encoding: 'buffer', windowsHide: true });
}
function blob(directory, content) { return git(directory, ['hash-object', '-w', '--stdin'], content).toString().trim(); }
function tree(directory, entries) {
  return git(directory, ['mktree', '-z'], Buffer.from(entries.map(entry => `${entry.mode} ${entry.type || 'blob'} ${entry.oid}\t${entry.path}\0`).join(''))).toString().trim();
}
function commit(directory, treeId, parent, message) {
  return git(directory, ['commit-tree', treeId, ...(parent ? ['-p', parent] : []), '-F', '-'], Buffer.from(`${message}\n`)).toString().trim();
}
const canonical = entries => Object.fromEntries(Object.keys(entries).sort().map(path => [path, entries[path]]));

async function fixture(t, { deployment, prototypeFile = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'praxis-broker-'));
  const origin = join(root, 'origin.git'), mirror = join(root, 'mirror.git'), home = join(root, 'home');
  const outboxDirectory = join(root, 'outbox'), exportDirectory = join(root, 'exports'), dataDirectory = join(root, 'private');
  mkdirSync(home); mkdirSync(outboxDirectory);
  execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { windowsHide: true, stdio: 'ignore' });
  execFileSync('git', ['init', '--bare', mirror], { windowsHide: true, stdio: 'ignore' });
  const excludedTree = tree(origin, [{ path: 'retained.txt', oid: blob(origin, Buffer.from('Excluded historical bytes\n')), mode: '100644' }]);
  const baseTree = tree(origin, [
    { path: 'readme.txt', oid: blob(origin, Buffer.from('Before\n')), mode: '100644' },
    { path: 'run.sh', oid: blob(origin, Buffer.from('#!/bin/sh\nexit 0\n')), mode: '100755' },
    ...(prototypeFile ? [{ path: '__proto__', oid: blob(origin, Buffer.from('Ordinary tracked file\n')), mode: '100644' }] : []),
    { path: '.env', oid: blob(origin, Buffer.from('EXISTING=preserved\n')), mode: '100644' },
    { path: 'node_modules', oid: excludedTree, type: 'tree', mode: '040000' },
  ]);
  const base = commit(origin, baseTree, null, 'Initial fixture'); git(origin, ['update-ref', 'refs/heads/main', base]);
  const repositories = [{ projectId: 'demo', directory: mirror, remoteUrl: origin, defaultBranch: 'main', deployment: Boolean(deployment),
    author: { name: 'Praxis', email: 'praxis@example.com' } }];
  const transport = new TrustedGit({ repositories, homeDirectory: home, allowLocalRemotes: true });
  await transport.fetch('demo');
  const options = { repositories, git: transport, outboxDirectory, exportDirectory, dataDirectory, deployment };
  let broker = new GitBroker(options);
  t.after(async () => { await broker.close(); rmSync(root, { recursive: true, force: true }); });
  const f = { root, origin, mirror, home, base, baseTree, transport, options, outboxDirectory, exportDirectory,
    get broker() { return broker; }, reopen: async () => { await broker.close(); broker = new GitBroker(options); return broker; } };
  return f;
}

async function execute(f, kind, input) {
  const args = { owner, operationId: randomUUID(), idempotencyKey: `fixture-${randomUUID()}`, ...input };
  const queued = f.broker.submit(kind, args);
  assert.equal(queued.status, 'queued'); await f.broker.tick();
  return { args, receipt: f.broker.get({ owner, operationId: args.operationId }) };
}

async function stage(f, { workspaceId = randomUUID(), parent = f.base, changes = [{ path: 'readme.txt', content: Buffer.from('After\n'), mode: '100644' }] } = {}) {
  const { entries: prior } = await f.broker.sourceEntries('demo', parent);
  const entries = Object.assign(Object.create(null), prior), staged = [], stageId = randomUUID();
  const root = join(f.outboxDirectory, stageId); mkdirSync(root); mkdirSync(join(root, 'files'));
  let totalBytes = 0;
  for (const change of changes) {
    const before = Object.hasOwn(entries, change.path) ? entries[change.path] : null;
    if (change.delete) {
      staged.push({ path: change.path, action: 'delete', beforeSha256: before?.sha256 || null }); delete entries[change.path];
    } else {
      const path = join(root, 'files', change.path); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, change.content);
      const digest = sha256(change.content);
      staged.push({ path: change.path, action: 'write', beforeSha256: before?.sha256 || null, sha256: digest, mode: change.mode, bytes: change.content.length });
      entries[change.path] = { kind: 'file', sha256: digest, size: change.content.length, mode: change.mode }; totalBytes += change.content.length;
    }
  }
  const revision = sha256(JSON.stringify(canonical(entries)));
  const manifest = { version: 1, stageId, owner, workspaceId, projectId: 'demo', baseCommit: f.base,
    parentCommit: parent, revision, parentRevision: sha256(JSON.stringify(prior)), entries: staged, totalBytes };
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
  return { root, manifest, args: { workspaceId, projectId: 'demo', baseCommit: f.base, parentCommit: parent,
    revision, stageId, message: 'Implement requested source change' } };
}

test('sync exports immutable exact source and executable modes while excluding protected parent files', async t => {
  const f = await fixture(t);
  const first = await execute(f, 'sync', { projectId: 'demo' });
  assert.equal(first.receipt.status, 'completed', JSON.stringify(first.receipt.error));
  const exported = join(f.exportDirectory, first.receipt.result.exportId), files = join(exported, 'files');
  const metadata = JSON.parse(readFileSync(join(exported, 'manifest.json')));
  assert.equal(metadata.commit, f.base); assert.equal(metadata.revision, first.receipt.result.revision);
  assert.equal(sha256(JSON.stringify(metadata.entries)), metadata.revision);
  assert.equal(readFileSync(join(files, '__proto__'), 'utf8'), 'Ordinary tracked file\n');
  assert.equal(existsSync(join(files, '.env')), false); assert.equal(existsSync(join(files, 'node_modules')), false);
  assert.equal(metadata.entries['run.sh'].mode, '100755');
  if (process.platform !== 'win32') assert.ok(statSync(join(files, 'run.sh')).mode & 0o111);
  assert.deepEqual(f.broker.submit('sync', first.args), first.receipt, 'same-key repeat returns immutable receipt');
  const external = commit(f.origin, f.baseTree, f.base, 'Remote progress'); git(f.origin, ['update-ref', 'refs/heads/main', external]);
  const second = await execute(f, 'sync', { projectId: 'demo' });
  assert.equal(second.receipt.result.commit, external); assert.notEqual(second.receipt.result.exportId, first.receipt.result.exportId);
  assert.equal(JSON.parse(readFileSync(join(exported, 'manifest.json'))).commit, f.base, 'earlier export remains pinned');
  await f.reopen(); assert.deepEqual(f.broker.get({ owner, operationId: first.args.operationId }), first.receipt);
});

test('broker commits exact staged bytes and preserves excluded files across successive workspace commits', async t => {
  const f = await fixture(t), workspaceId = randomUUID();
  const prepared = await stage(f, { workspaceId, changes: [
    { path: 'readme.txt', content: Buffer.from('Changed\r\n'), mode: '100644' },
    { path: 'bytes.bin', content: Buffer.from([0, 255, 128, 13, 10]), mode: '100755' },
  ] });
  const first = await execute(f, 'commit', prepared.args);
  assert.equal(first.receipt.status, 'completed', JSON.stringify(first.receipt.error));
  assert.equal(first.receipt.result.revision, prepared.args.revision); assert.equal(first.receipt.result.parentCommit, f.base);
  assert.deepEqual(await f.transport.remoteHead('demo'), { commit: f.base }, 'commit creates no remote mutation');
  const baseEntries = await f.transport.readTree('demo', f.base), newEntries = await f.transport.readTree('demo', first.receipt.result.commit);
  for (const path of ['.env', 'node_modules/retained.txt']) assert.deepEqual(newEntries.find(entry => entry.path === path), baseEntries.find(entry => entry.path === path));
  const binary = newEntries.find(entry => entry.path === 'bytes.bin');
  assert.equal(binary.mode, '100755'); assert.deepEqual(await f.transport.readBlob('demo', binary.oid), Buffer.from([0, 255, 128, 13, 10]));
  const nextStage = await stage(f, { workspaceId, parent: first.receipt.result.commit,
    changes: [{ path: 'readme.txt', delete: true }, { path: '__proto__', content: Buffer.from('Still ordinary'), mode: '100644' }] });
  const next = await execute(f, 'commit', nextStage.args);
  assert.equal(next.receipt.status, 'completed', JSON.stringify(next.receipt.error));
  assert.equal(next.receipt.result.parentCommit, first.receipt.result.commit);
  assert.equal((await f.transport.readTree('demo', next.receipt.result.commit)).some(entry => entry.path === 'readme.txt'), false);
  const wrongParent = await stage(f, { workspaceId });
  const rejected = await execute(f, 'commit', wrongParent.args); assert.equal(rejected.receipt.error.code, 'COMMIT_CONFLICT');
  const pushed = await execute(f, 'push', { commitOperationId: next.args.operationId });
  assert.equal(pushed.receipt.status, 'completed', JSON.stringify(pushed.receipt.error));
  assert.deepEqual(await f.transport.remoteHead('demo'), { commit: next.receipt.result.commit });
});

test('staged digests, full manifests, before hashes and owner bindings reject altered captures', async t => {
  const f = await fixture(t);
  for (const [label, mutate, errorCode] of [
    ['before hash', item => { item.manifest.entries[0].beforeSha256 = '0'.repeat(64); }, 'HASH_CONFLICT'],
    ['manifest digest', item => { item.manifest.revision = item.args.revision = '0'.repeat(64); }, 'STAGE_MISMATCH'],
    ['owner', item => { item.manifest.owner = 'someone-else'; }, 'STAGE_MISMATCH'],
    ['bytes', item => { writeFileSync(join(item.root, 'files', 'readme.txt'), 'Mutated after capture'); }, 'STAGE_MISMATCH'],
    ['parent digest', item => { item.manifest.parentRevision = '0'.repeat(64); }, 'STAGE_MISMATCH'],
    ['protected path', item => { item.manifest.entries[0].path = '.env'; }, 'PATH_REJECTED'],
    ['traversal', item => { item.manifest.entries[0].path = '../outside'; }, 'PATH_REJECTED'],
  ]) {
    const item = await stage(f); mutate(item); writeFileSync(join(item.root, 'manifest.json'), JSON.stringify(item.manifest));
    const result = await execute(f, 'commit', item.args);
    assert.equal(result.receipt.status, 'failed', label); assert.equal(result.receipt.error.code, errorCode, label);
  }
  assert.deepEqual(await f.transport.remoteHead('demo'), { commit: f.base });
});

test('linked source stages are rejected and Git operation receipts remain owner-scoped', async t => {
  const f = await fixture(t), item = await stage(f);
  linkSync(join(item.root, 'files', 'readme.txt'), join(f.root, 'linked-copy'));
  const result = await execute(f, 'commit', item.args);
  assert.equal(result.receipt.status, 'failed'); assert.equal(result.receipt.error.code, 'UNSAFE_PATH');
  assert.throws(() => f.broker.get({ owner: 'other', operationId: result.args.operationId }), { code: 'NOT_FOUND' });
  assert.throws(() => f.broker.submit('push', { owner: 'other', operationId: randomUUID(), idempotencyKey: 'different-owner-key', commitOperationId: result.args.operationId }), { code: 'NOT_FOUND' });
  assert.equal(f.broker.list({ owner: 'other' }).operations.length, 0);
  assert.throws(() => f.broker.submit('commit', { ...result.args, message: 'Changed key arguments' }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('remote advances reject push before intent and do not overwrite external commits', async t => {
  const f = await fixture(t), item = await stage(f), prepared = await execute(f, 'commit', item.args);
  assert.equal(prepared.receipt.status, 'completed');
  const external = commit(f.origin, f.baseTree, f.base, 'External advance'); git(f.origin, ['update-ref', 'refs/heads/main', external]);
  let pushes = 0; const push = f.transport.push.bind(f.transport);
  f.transport.push = async (...args) => { pushes++; return push(...args); };
  const result = await execute(f, 'push', { commitOperationId: prepared.args.operationId });
  assert.equal(result.receipt.status, 'failed'); assert.equal(result.receipt.error.code, 'REMOTE_CONFLICT');
  assert.equal(pushes, 0); assert.deepEqual(await f.transport.remoteHead('demo'), { commit: external });
});

test('lost response and process restart reconcile publication by observation without another push', async t => {
  const f = await fixture(t), item = await stage(f), prepared = await execute(f, 'commit', item.args);
  const push = f.transport.push.bind(f.transport); let pushCalls = 0;
  f.transport.push = async (...args) => { pushCalls++; await push(...args); throw new GitTransportError('PUBLISH_UNCERTAIN', 'Fixture lost push response', { pushAttempted: true }); };
  const result = await execute(f, 'push', { commitOperationId: prepared.args.operationId });
  assert.equal(result.receipt.status, 'uncertain'); assert.equal(result.receipt.phase, 'push_intent');
  await f.reopen();
  const recovered = await f.broker.observe({ owner, operationId: result.args.operationId });
  assert.equal(recovered.status, 'completed'); assert.equal(recovered.result.reconciled, true); assert.equal(pushCalls, 1);
  assert.deepEqual(f.broker.submit('push', result.args), recovered); assert.equal(pushCalls, 1);
  // Simulate termination after the durable intent and before completion was recorded.
  f.broker.db.prepare("UPDATE git_operations SET status='running',phase='push_intent' WHERE id=?").run(result.args.operationId);
  await f.reopen(); await f.broker.tick();
  assert.equal(f.broker.get({ owner, operationId: result.args.operationId }).status, 'completed'); assert.equal(pushCalls, 1);
});

test('an uncertain unpublished push remains uncertain without repeating its mutation', async t => {
  const f = await fixture(t), item = await stage(f), prepared = await execute(f, 'commit', item.args);
  let pushCalls = 0;
  f.transport.push = async () => { pushCalls++; throw new GitTransportError('PUBLISH_UNCERTAIN', 'Fixture unavailable transport', { pushAttempted: true }); };
  const result = await execute(f, 'push', { commitOperationId: prepared.args.operationId });
  assert.equal(result.receipt.status, 'uncertain');
  assert.throws(() => f.broker.submit('push', { owner, operationId: randomUUID(), idempotencyKey: 'same-predecessor-new-key',
    commitOperationId: prepared.args.operationId }), { code: 'GIT_OPERATION_PENDING' });
  await f.reopen(); assert.equal((await f.broker.observe({ owner, operationId: result.args.operationId })).status, 'uncertain');
  await f.broker.tick(); assert.equal(pushCalls, 1); assert.deepEqual(await f.transport.remoteHead('demo'), { commit: f.base });
  // A read failure after process recovery is not evidence that an earlier external mutation failed.
  f.broker.db.prepare("UPDATE git_operations SET status='running',phase='push_intent' WHERE id=?").run(result.args.operationId);
  const remoteHead = f.transport.remoteHead.bind(f.transport);
  f.transport.remoteHead = async () => { throw new GitTransportError('GIT_COMMAND_FAILED', 'Fixture unavailable recovery read'); };
  await f.reopen(); await f.broker.tick();
  assert.equal(f.broker.get({ owner, operationId: result.args.operationId }).status, 'uncertain');
  assert.equal(pushCalls, 1); f.transport.remoteHead = remoteHead;
});

test('deployment uses the completed owned push receipt and persisted uncertain results recover read-only', async t => {
  const calls = []; let completed = false, deploymentId;
  const deployment = async input => {
    calls.push(input);
    if (input.action === 'apply') { deploymentId = input.operationId; throw new Error('Fixture response loss'); }
    return { operation: { operationId: deploymentId, phase: completed ? 'completed' : 'uncertain' } };
  };
  const f = await fixture(t, { deployment }), item = await stage(f), prepared = await execute(f, 'commit', item.args);
  assert.throws(() => f.broker.submit('deploy', { owner, operationId: randomUUID(), idempotencyKey: 'wrong-predecessor',
    pushOperationId: prepared.args.operationId, expectedHead: f.base }), { code: 'OPERATION_NOT_READY' });
  const pushed = await execute(f, 'push', { commitOperationId: prepared.args.operationId });
  const deployed = await execute(f, 'deploy', { pushOperationId: pushed.args.operationId, expectedHead: f.base });
  assert.equal(deployed.receipt.status, 'uncertain');
  assert.throws(() => f.broker.submit('deploy', { owner, operationId: randomUUID(), idempotencyKey: 'same-deployment-new-key',
    pushOperationId: pushed.args.operationId, expectedHead: f.base }), { code: 'GIT_OPERATION_PENDING' });
  assert.deepEqual(calls[0], { action: 'apply', operationId: deployed.args.operationId, expectedHead: f.base, targetCommit: prepared.receipt.result.commit });
  await f.reopen(); completed = true;
  const recovered = await f.broker.observe({ owner, operationId: deployed.args.operationId });
  assert.equal(recovered.status, 'completed'); assert.equal(recovered.result.commit, prepared.receipt.result.commit);
  assert.equal(calls.filter(call => call.action === 'apply').length, 1);
  assert.equal(calls.at(-1).action, 'status'); assert.equal(calls.at(-1).operationId, deployed.args.operationId);
});

test('new prototype-named files are ordinary exact source entries', async t => {
  const f = await fixture(t, { prototypeFile: false });
  const item = await stage(f, { changes: [{ path: '__proto__', content: Buffer.from('New ordinary file'), mode: '100644' }] });
  const result = await execute(f, 'commit', item.args);
  assert.equal(result.receipt.status, 'completed', JSON.stringify(result.receipt.error));
  const entry = (await f.transport.readTree('demo', result.receipt.result.commit)).find(value => value.path === '__proto__');
  assert.ok(entry); assert.equal((await f.transport.readBlob('demo', entry.oid)).toString(), 'New ordinary file');
  assert.equal(result.receipt.result.revision, item.args.revision);
});
