import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeStore } from '../src/code/store.js';
import { WorkspaceManager } from '../src/code/workspaces.js';
import { CodeGit } from '../src/code/git.js';
import { manifest, sha256 } from '../src/code/paths.js';

const BASE = '1'.repeat(40), SECOND = '2'.repeat(40), THIRD = '3'.repeat(40);
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'praxis-code-git-'));
  const dataDirectory = join(root, 'private'), workspaceDirectory = join(root, 'workspaces');
  const snapshotPath = join(root, 'snapshot'), outboxDirectory = join(root, 'outbox'), exportDirectory = join(root, 'exports');
  mkdirSync(snapshotPath); mkdirSync(exportDirectory);
  writeFileSync(join(snapshotPath, 'main.js'), 'original\n');
  writeFileSync(join(snapshotPath, 'remove.txt'), 'old file\n');
  const store = new CodeStore(dataDirectory);
  store.db.exec('CREATE TABLE code_jobs (id TEXT, owner TEXT, workspace_id TEXT, status TEXT)');
  const config = { store, dataDirectory, workspaceDirectory,
    projects: [{ id: 'podcast-discord', name: 'Podcast', repository: 'fixture:podcast', revision: BASE, snapshotPath }] };
  const workspaces = new WorkspaceManager(config), owner = 'owner';
  const created = workspaces.create({ owner, projectId: 'podcast-discord', baseRevision: BASE, idempotencyKey: 'create-workspace' });
  const workspaceId = created.workspaceId, workspacePath = join(workspaceDirectory, workspaceId);
  const calls = [], receipts = new Map(), captures = [];
  const broker = {
    async sync(args) {
      calls.push(['sync', args]);
      const receipt = receipts.get(args.operationId);
      if (receipt) return receipt;
      const result = exportSource(args, SECOND, 'synchronized\n');
      const value = { operationId: args.operationId, kind: 'sync', status: 'completed', projectId: args.projectId, result };
      receipts.set(args.operationId, value); return value;
    },
    async commit(args) {
      calls.push(['commit', args]);
      if (receipts.has(args.operationId)) return receipts.get(args.operationId);
      const stageRoot = join(outboxDirectory, args.stageId), stage = JSON.parse(readFileSync(join(stageRoot, 'manifest.json')));
      const files = Object.fromEntries(stage.entries.filter(entry => entry.action === 'write').map(entry => [entry.path,
        readFileSync(join(stageRoot, 'files', entry.path))]));
      captures.push({ stage, files });
      const result = { commit: sha256(args.operationId).slice(0, 40), parentCommit: args.parentCommit, revision: args.revision,
        branch: 'main', expectedRemoteHead: BASE };
      const receipt = { operationId: args.operationId, kind: 'commit', status: 'completed', projectId: args.projectId,
        workspaceId: args.workspaceId, result };
      receipts.set(args.operationId, receipt); return receipt;
    },
    async push(args) {
      calls.push(['push', args]);
      const commit = receipts.get(args.commitOperationId);
      const receipt = { operationId: args.operationId, kind: 'push', status: 'completed', projectId: commit.projectId,
        workspaceId: commit.workspaceId, result: { commit: commit.result.commit, branch: 'main' } };
      receipts.set(args.operationId, receipt); return receipt;
    },
    async deploy(args) {
      calls.push(['deploy', args]);
      const push = receipts.get(args.pushOperationId);
      const receipt = { operationId: args.operationId, kind: 'deploy', status: 'completed', projectId: push.projectId,
        workspaceId: push.workspaceId, result: { previousHead: args.expectedHead, commit: push.result.commit } };
      receipts.set(args.operationId, receipt); return receipt;
    },
    async get(args) { calls.push(['get', args]); return receipts.get(args.operationId); },
    async deploymentStatus(args) { calls.push(['deploymentStatus', args]); return { projectId: args.projectId, head: BASE }; },
  };
  function exportSource(args, commit, contents) {
    const path = join(exportDirectory, args.operationId), files = join(path, 'files');
    mkdirSync(files, { recursive: true }); writeFileSync(join(files, 'main.js'), contents);
    const state = manifest(files);
    writeFileSync(join(path, 'manifest.json'), JSON.stringify({ version: 1, projectId: args.projectId, commit,
      revision: state.revision, entries: state.entries }));
    return { exportId: args.operationId, commit, revision: state.revision, branch: 'main' };
  }
  let git = new CodeGit({ store, workspaces, broker, outboxDirectory, exportDirectory });
  function edit(contents = 'changed\n') {
    const read = workspaces.read({ owner, workspaceId, path: 'main.js' });
    return workspaces.apply({ owner, workspaceId, expectedRevision: read.revision, idempotencyKey: `edit-${sha256(contents).slice(0, 20)}`,
      changes: [{ action: 'write', path: 'main.js', expectedSha256: read.sha256, content: contents }] }).result.revision;
  }
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, config, workspaces, git, broker, calls, receipts, captures, owner, workspaceId, workspacePath,
    outboxDirectory, exportDirectory, exportSource, edit,
    reopen: () => (git = new CodeGit({ store, workspaces: new WorkspaceManager(config), broker, outboxDirectory, exportDirectory })) };
}

test('synchronization persists a new project snapshot while old workspaces retain their original source and base', async t => {
  const f = fixture(t), { owner, workspaceId, workspaces, git } = f;
  const sync = await git.sync({ owner, projectId: 'podcast-discord', idempotencyKey: 'sync-current-main' });
  assert.equal(sync.status, 'completed');
  assert.equal(workspaces.projectInspect({ owner, projectId: 'podcast-discord' }).revision, SECOND);
  assert.equal(workspaces.projectsList({ owner }).projects[0].revision, SECOND);
  assert.equal(workspaces.inspect({ owner, workspaceId }).baseRevision, BASE);
  assert.equal(workspaces.read({ owner, workspaceId, path: 'main.js' }).lines[0].text, 'original');
  const reopened = f.reopen();
  assert.equal(reopened.workspaces.projectInspect({ owner, projectId: 'podcast-discord' }).revision, SECOND);
  const next = reopened.workspaces.create({ owner, projectId: 'podcast-discord', baseRevision: SECOND, idempotencyKey: 'create-synced-workspace' });
  assert.equal(reopened.workspaces.read({ owner, workspaceId: next.workspaceId, path: 'main.js' }).lines[0].text, 'synchronized');
  assert.deepEqual(await reopened.sync({ owner, projectId: 'podcast-discord', idempotencyKey: 'sync-current-main' }), sync);
  assert.equal(f.calls.filter(([name]) => name === 'sync').length, 1);
});

test('commit captures exact immutable additions, deletions and bytes; repeated commits advance from the last captured source', async t => {
  const f = fixture(t), { owner, workspaceId, git, workspaces } = f;
  const read = workspaces.read({ owner, workspaceId, path: 'main.js' });
  const revision = workspaces.apply({ owner, workspaceId, expectedRevision: read.revision, idempotencyKey: 'source-full-change', changes: [
    { action: 'write', path: 'main.js', expectedSha256: read.sha256, content: 'first change\n' },
    { action: 'write', path: 'new/nested.js', expectedSha256: null, content: 'new source\n' },
    { action: 'delete', path: 'remove.txt', expectedSha256: sha256('old file\n') },
  ] }).result.revision;
  writeFileSync(join(f.workspacePath, '.env'), 'TOKEN=never-published');
  const args = { owner, workspaceId, expectedRevision: revision, idempotencyKey: 'commit-first-change', message: 'Make a real improvement' };
  const first = await git.commit(args);
  assert.equal(first.status, 'completed');
  assert.equal(f.captures[0].stage.parentCommit, BASE);
  assert.equal(f.captures[0].stage.baseCommit, BASE);
  assert.deepEqual(f.captures[0].stage.entries.map(entry => [entry.path, entry.action]),
    [['main.js', 'write'], ['new/nested.js', 'write'], ['remove.txt', 'delete']]);
  for (const entry of f.captures[0].stage.entries.filter(entry => entry.action === 'write')) {
    assert.equal(sha256(f.captures[0].files[entry.path]), entry.sha256);
    assert.equal(f.captures[0].files[entry.path].length, entry.bytes);
  }
  assert.equal(existsSync(join(f.outboxDirectory, f.captures[0].stage.stageId)), false);
  const nextRevision = f.edit('second change\n');
  assert.deepEqual(await git.commit(args), first);
  const second = await f.reopen().commit({ owner, workspaceId, expectedRevision: nextRevision, idempotencyKey: 'commit-second-change', message: 'Further improve behavior' });
  assert.equal(second.result.parentCommit, first.result.commit);
  assert.equal(f.captures[1].stage.parentRevision, revision);
  assert.equal(f.captures[1].stage.baseCommit, BASE);
  assert.deepEqual(f.captures[1].stage.entries.map(entry => entry.path), ['main.js']);
  assert.equal(f.captures[1].stage.entries[0].beforeSha256, sha256('first change\n'));
  await assert.rejects(git.commit({ owner, workspaceId, expectedRevision: nextRevision, idempotencyKey: 'commit-no-changes', message: 'Nothing' }), { code: 'NO_CHANGES' });
});

test('a lost broker response is recovered after restart without resubmitting or recapturing work', async t => {
  const f = fixture(t), { owner, workspaceId, git } = f;
  const original = f.broker.commit;
  f.broker.commit = async args => { await original(args); throw new Error('transport lost after durable completion'); };
  const args = { owner, workspaceId, expectedRevision: f.edit(), idempotencyKey: 'commit-lost-response', message: 'Recover me' };
  const uncertain = await git.commit(args);
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(existsSync(join(f.outboxDirectory, f.captures[0].stage.stageId)), true);
  const recovered = await f.reopen().get({ owner, operationId: uncertain.operationId });
  assert.equal(recovered.status, 'completed');
  assert.equal(f.captures.length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'commit').length, 1);
  assert.equal(existsSync(join(f.outboxDirectory, f.captures[0].stage.stageId)), false);
  assert.deepEqual(await f.git.commit(args), recovered);
  await assert.rejects(git.commit({ ...args, message: 'Changed request' }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('pending commits prevent competing capture while newer edits remain available for a later commit', async t => {
  const f = fixture(t), { owner, workspaceId, git } = f;
  const original = f.broker.commit;
  f.broker.commit = async args => {
    const completed = await original(args);
    return { ...completed, status: 'running', result: null };
  };
  const firstRevision = f.edit();
  const first = await git.commit({ owner, workspaceId, expectedRevision: firstRevision, idempotencyKey: 'pending-commit-first', message: 'First' });
  assert.equal(first.status, 'running');
  const secondRevision = f.edit('while commit in flight\n');
  await assert.rejects(git.commit({ owner, workspaceId, expectedRevision: secondRevision, idempotencyKey: 'pending-commit-second', message: 'Second' }), { code: 'GIT_OPERATION_PENDING' });
  const completed = await git.get({ owner, operationId: first.operationId });
  assert.equal(completed.result.revision, firstRevision);
  assert.equal(f.workspaces.inspect({ owner, workspaceId }).revision, secondRevision);
  f.broker.commit = original;
  const second = await git.commit({ owner, workspaceId, expectedRevision: secondRevision, idempotencyKey: 'pending-commit-second', message: 'Second' });
  assert.equal(second.result.parentCommit, completed.result.commit);
});

test('owner, idle state and revision checks fail before any broker admission', async t => {
  const f = fixture(t), { owner, workspaceId, git } = f;
  const expectedRevision = f.edit(), args = { owner, workspaceId, expectedRevision, idempotencyKey: 'precondition-commit', message: 'Changes' };
  await assert.rejects(git.commit({ ...args, owner: 'another-owner' }), { code: 'NOT_FOUND' });
  await assert.rejects(git.commit({ ...args, expectedRevision: 'stale' }), { code: 'REVISION_CONFLICT' });
  f.store.db.prepare('INSERT INTO code_jobs (id,owner,workspace_id,status) VALUES (?,?,?,?)').run('busy-job', owner, workspaceId, 'running');
  await assert.rejects(git.commit(args), { code: 'WORKSPACE_BUSY' });
  assert.equal(f.calls.length, 0);
  f.store.db.prepare("UPDATE code_jobs SET status='completed'").run();
  const commit = await git.commit(args);
  const count = f.calls.length;
  await assert.rejects(git.get({ owner: 'another-owner', operationId: commit.operationId }), { code: 'NOT_FOUND' });
  await assert.rejects(git.push({ owner: 'another-owner', commitOperationId: commit.operationId, idempotencyKey: 'foreign-push' }), { code: 'NOT_FOUND' });
  assert.equal(f.calls.length, count);
});

test('tampered synchronized bytes fail closed; status recovery can integrate the corrected immutable export', async t => {
  const f = fixture(t), { owner, git } = f;
  const original = f.broker.sync;
  f.broker.sync = async args => {
    const receipt = await original(args);
    writeFileSync(join(f.exportDirectory, args.operationId, 'files', 'main.js'), 'tampered bytes');
    return receipt;
  };
  await assert.rejects(git.sync({ owner, projectId: 'podcast-discord', idempotencyKey: 'sync-tampered-export' }), { code: 'SNAPSHOT_CHANGED' });
  assert.equal(f.workspaces.projectInspect({ owner, projectId: 'podcast-discord' }).revision, BASE);
  const operationId = (await git.list({ owner })).operations[0].operationId;
  writeFileSync(join(f.exportDirectory, operationId, 'files', 'main.js'), 'synchronized\n');
  assert.equal((await git.get({ owner, operationId })).status, 'completed');
  assert.equal(f.workspaces.projectInspect({ owner, projectId: 'podcast-discord' }).revision, SECOND);
});

test('stale synchronization observations cannot replace a newer registered project snapshot', async t => {
  const f = fixture(t), { owner, git } = f;
  const original = f.broker.sync;
  f.broker.sync = async args => { const receipt = await original(args); return { ...receipt, status: 'running', result: null }; };
  const older = await git.sync({ owner, projectId: 'podcast-discord', idempotencyKey: 'sync-older-snapshot' });
  f.broker.sync = async args => {
    const result = f.exportSource(args, THIRD, 'newest\n');
    const receipt = { operationId: args.operationId, kind: 'sync', status: 'completed', projectId: args.projectId, result };
    f.receipts.set(args.operationId, receipt); return receipt;
  };
  await git.sync({ owner, projectId: 'podcast-discord', idempotencyKey: 'sync-newest-snapshot' });
  assert.equal((await git.get({ owner, operationId: older.operationId })).status, 'completed');
  assert.equal(f.workspaces.projectInspect({ owner, projectId: 'podcast-discord' }).revision, THIRD);
});

test('push and deployment forward durable operation references and recover through owner-scoped pagination', async t => {
  const f = fixture(t), { owner, workspaceId, git } = f;
  const commit = await git.commit({ owner, workspaceId, expectedRevision: f.edit(), idempotencyKey: 'workflow-commit', message: 'Feature' });
  const push = await git.push({ owner, commitOperationId: commit.operationId, idempotencyKey: 'workflow-push' });
  const deploy = await git.deploy({ owner, pushOperationId: push.operationId, expectedHead: BASE, idempotencyKey: 'workflow-deploy' });
  assert.equal(deploy.result.commit, commit.result.commit);
  assert.deepEqual(await git.deploymentStatus({ owner, projectId: 'podcast-discord' }), { projectId: 'podcast-discord', head: BASE });
  const firstPage = await git.list({ owner, workspaceId, limit: 2 });
  assert.deepEqual(firstPage.operations.map(operation => operation.kind), ['deploy', 'push']);
  const lastPage = await f.reopen().list({ owner, workspaceId, cursor: firstPage.nextCursor, limit: 2 });
  assert.deepEqual(lastPage.operations.map(operation => operation.kind), ['commit']);
  assert.equal(lastPage.nextCursor, null);
  assert.deepEqual((await git.list({ owner: 'unrelated-owner' })).operations, []);
  await assert.rejects(git.deploy({ owner, pushOperationId: commit.operationId, expectedHead: BASE, idempotencyKey: 'bad-deploy-reference' }), { code: 'PUSH_NOT_READY' });
});

test('shared source stages retain precise group access under a restrictive service umask', { skip: process.platform === 'win32' }, async t => {
  const previous = process.umask(0o077);
  try {
    const f = fixture(t), { owner, workspaceId } = f;
    const original = f.broker.commit;
    f.broker.commit = async args => {
      const root = join(f.outboxDirectory, args.stageId);
      for (const path of [root, join(root, 'files'), join(root, 'files', 'nested')]) assert.equal(lstatSync(path).mode & 0o7777, 0o2750);
      for (const path of [join(root, 'manifest.json'), join(root, 'files', 'nested', 'new.txt')]) assert.equal(lstatSync(path).mode & 0o777, 0o640);
      return original(args);
    };
    const revision = f.workspaces.inspect({ owner, workspaceId }).revision;
    const changed = f.workspaces.apply({ owner, workspaceId, expectedRevision: revision, idempotencyKey: 'umask-new-file',
      changes: [{ action: 'write', path: 'nested/new.txt', expectedSha256: null, content: 'source\n' }] });
    const receipt = await f.git.commit({ owner, workspaceId, expectedRevision: changed.result.revision, idempotencyKey: 'umask-commit', message: 'Permissions' });
    assert.equal(receipt.status, 'completed');
  } finally { process.umask(previous); }
});

test('confirmed admission rejection releases the captured stage while ambiguous failure remains recoverable', async t => {
  const f = fixture(t), { owner, workspaceId, git } = f;
  let stageId;
  const original = f.broker.commit;
  f.broker.commit = async args => {
    stageId = args.stageId;
    throw Object.assign(new Error('Publication is disabled for this project.'), { code: 'PUBLICATION_DISABLED', brokerRejected: true });
  };
  const expectedRevision = f.edit();
  const failed = await git.commit({ owner, workspaceId, expectedRevision, idempotencyKey: 'definite-admission-rejection', message: 'Changes' });
  assert.equal(failed.status, 'failed'); assert.equal(failed.phase, 'admission_rejected');
  assert.equal(failed.error.code, 'PUBLICATION_DISABLED');
  assert.equal(existsSync(join(f.outboxDirectory, stageId)), false);
  f.broker.commit = original;
  assert.equal((await git.commit({ owner, workspaceId, expectedRevision, idempotencyKey: 'fresh-authorized-commit', message: 'Changes' })).status, 'completed');
});

test('late running observations never overwrite an already completed commit receipt', async t => {
  const f = fixture(t), { owner, workspaceId, git } = f;
  const original = f.broker.commit;
  let releaseFirst;
  const waiting = new Promise(resolve => { releaseFirst = resolve; });
  f.broker.commit = async args => { const receipt = await original(args); await waiting; return { ...receipt, status: 'running', result: null }; };
  const operation = git.commit({ owner, workspaceId, expectedRevision: f.edit(), idempotencyKey: 'late-running-observation', message: 'Changes' });
  const operationId = (await git.list({ owner })).operations[0].operationId;
  const recovered = await git.get({ owner, operationId });
  assert.equal(recovered.status, 'completed');
  releaseFirst();
  assert.deepEqual(await operation, recovered);
  assert.equal((await git.get({ owner, operationId })).status, 'completed');
});
