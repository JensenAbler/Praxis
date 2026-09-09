import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TrustedGit, GitTransportError, validateGitPath } from '../src/git/git.js';

const timestamp = '2026-09-09T12:34:56.000Z';
const author = { name: 'Praxis Test', email: 'praxis-test@example.com' };
const binary = Buffer.from([0, 1, 2, 255, 10, 128, 13]);
const environment = { ...process.env, GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
  GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email,
  GIT_AUTHOR_DATE: timestamp, GIT_COMMITTER_DATE: timestamp, GIT_CONFIG_NOSYSTEM: '1' };
function git(directory, args, input) {
  return execFileSync('git', ['--git-dir', directory, ...args], { env: environment, input, encoding: 'buffer', windowsHide: true });
}
function blob(directory, content) { return git(directory, ['hash-object', '-w', '--stdin'], content).toString().trim(); }
function tree(directory, entries) {
  return git(directory, ['mktree', '-z', '--missing'], Buffer.from(entries.map(entry => `${entry.mode} ${entry.type || 'blob'} ${entry.oid}\t${entry.path}\0`).join(''))).toString().trim();
}
function makeCommit(directory, treeId, parent, message = 'Fixture') {
  return git(directory, ['commit-tree', treeId, ...(parent ? ['-p', parent] : []), '-F', '-'], Buffer.from(`${message}\n`)).toString().trim();
}
function fixture(t, { allowedBranches = ['main'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'praxis-git-'));
  const origin = join(root, 'origin.git'), mirror = join(root, 'mirror.git'), home = join(root, 'home');
  mkdirSync(home);
  execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { windowsHide: true, stdio: 'ignore' });
  const excluded = tree(origin, [{ path: 'retained.bin', oid: blob(origin, binary), mode: '100644' }]);
  const originalTree = tree(origin, [
    { path: 'readme.txt', oid: blob(origin, Buffer.from('Before\n')), mode: '100644' },
    { path: 'run.sh', oid: blob(origin, Buffer.from('#!/bin/sh\necho before\n')), mode: '100755' },
    { path: '.env', oid: blob(origin, Buffer.from('HISTORICAL=preserve\n')), mode: '100644' },
    { path: 'node_modules', oid: excluded, mode: '040000', type: 'tree' },
    { path: 'link', oid: blob(origin, Buffer.from('readme.txt')), mode: '120000' },
    { path: '.gitattributes', oid: blob(origin, Buffer.from('*.txt filter=unexpected\n')), mode: '100644' },
  ]);
  const base = makeCommit(origin, originalTree, null);
  git(origin, ['update-ref', 'refs/heads/main', base]);
  execFileSync('git', ['init', '--bare', mirror], { windowsHide: true, stdio: 'ignore' });
  const options = { repositories: [{ projectId: 'demo', directory: mirror, remoteUrl: origin, defaultBranch: 'main', allowedBranches, author }],
    homeDirectory: home, allowLocalRemotes: true };
  const transport = new TrustedGit(options);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, origin, mirror, home, base, originalTree, options, transport };
}

test('trusted transport preserves exact binary, modes and excluded parent files without checkout', async t => {
  const f = fixture(t), { transport } = f;
  assert.deepEqual(await transport.verifyRepository('demo'), { projectId: 'demo', branch: 'main' });
  assert.deepEqual(await transport.fetch('demo'), { commit: f.base });
  const before = await transport.readTree('demo', f.base);
  const marker = join(f.root, 'MUST-NOT-EXECUTE');
  git(f.mirror, ['config', 'filter.unexpected.clean', `echo bad > '${marker.replaceAll('\\', '/')}'`]);
  git(f.mirror, ['config', 'filter.unexpected.required', 'true']);
  writeFileSync(join(f.mirror, 'hooks', 'pre-push'), `#!/bin/sh\necho bad > '${marker.replaceAll('\\', '/')}'\nexit 1\n`);
  chmodSync(join(f.mirror, 'hooks', 'pre-push'), 0o755);
  const input = { parent: f.base, message: 'Improve real code', timestamp, changes: [
    { path: 'readme.txt', mode: '100644', content: Buffer.from('After\r\n') },
    { path: 'run.sh', mode: '100644', content: Buffer.from('#!/bin/sh\necho after\n') },
    { path: 'assets/bytes.bin', mode: '100755', content: binary },
  ] };
  const result = await transport.createCommit('demo', input);
  assert.deepEqual(await transport.createCommit('demo', input), result, 'fixed inputs produce the same commit');
  const after = await transport.readTree('demo', result.commit);
  for (const path of ['.env', 'node_modules/retained.bin', 'link', '.gitattributes']) {
    assert.deepEqual(after.find(entry => entry.path === path), before.find(entry => entry.path === path));
  }
  const changed = after.find(entry => entry.path === 'readme.txt');
  assert.deepEqual(await transport.readBlob('demo', changed.oid), Buffer.from('After\r\n'));
  const asset = after.find(entry => entry.path === 'assets/bytes.bin');
  assert.equal(asset.mode, '100755'); assert.deepEqual(await transport.readBlob('demo', asset.oid), binary);
  assert.equal(after.find(entry => entry.path === 'run.sh').mode, '100644');
  assert.equal(git(f.mirror, ['show', '-s', '--format=%an <%ae>', result.commit]).toString().trim(), 'Praxis Test <praxis-test@example.com>');
  assert.equal((await transport.push('demo', { commit: result.commit, expectedHead: f.base })).remoteHead, result.commit);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(join(f.mirror, 'readme.txt')), false, 'never checks out source');
  assert.equal((await transport.push('demo', { commit: result.commit, expectedHead: f.base })).alreadyPublished, true);
});

test('main publication rejects external advances and non-descendant commits without changing the remote', async t => {
  const f = fixture(t), transport = f.transport;
  await transport.fetch('demo');
  const prepared = await transport.createCommit('demo', { parent: f.base, timestamp, message: 'Candidate',
    changes: [{ path: 'readme.txt', mode: '100644', content: Buffer.from('Candidate\n') }] });
  const external = makeCommit(f.origin, f.originalTree, f.base, 'External update');
  git(f.origin, ['update-ref', 'refs/heads/main', external]);
  await assert.rejects(transport.push('demo', { commit: prepared.commit, expectedHead: f.base }), { code: 'PUBLISH_CONFLICT' });
  assert.deepEqual(await transport.remoteHead('demo'), { commit: external });
  await transport.fetch('demo');
  await assert.rejects(transport.push('demo', { commit: prepared.commit, expectedHead: external }), { code: 'PUBLISH_CONFLICT' });
  await assert.rejects(transport.push('demo', { commit: prepared.commit, expectedHead: null }), { code: 'PUBLISH_CONFLICT' });
  assert.deepEqual(await transport.remoteHead('demo'), { commit: external });
});

test('exact lease rejects a remote race even when an ordinary fast-forward push would accept it', async t => {
  const f = fixture(t), transport = f.transport;
  await transport.fetch('demo');
  const intermediate = await transport.createCommit('demo', { parent: f.base, timestamp, message: 'Intermediate',
    changes: [{ path: 'readme.txt', mode: '100644', content: Buffer.from('Intermediate\n') }] });
  const candidate = await transport.createCommit('demo', { parent: intermediate.commit, timestamp, message: 'Candidate',
    changes: [{ path: 'readme.txt', mode: '100644', content: Buffer.from('Candidate\n') }] });
  // Copy the intermediate object without advancing main; the publication's first read then races an external update.
  git(f.origin, ['fetch', '--no-write-fetch-head', f.mirror, intermediate.commit]);
  const readHead = transport.remoteHead.bind(transport);
  let first = true;
  transport.remoteHead = async (...args) => {
    const value = await readHead(...args);
    if (first) { first = false; git(f.origin, ['update-ref', 'refs/heads/main', intermediate.commit]); }
    return value;
  };
  await assert.rejects(transport.push('demo', { commit: candidate.commit, expectedHead: f.base }), { code: 'PUBLISH_CONFLICT' });
  assert.deepEqual(await readHead('demo'), { commit: intermediate.commit });
});

test('only configured branches and remotes are available; transport errors do not leak output', async t => {
  const f = fixture(t);
  assert.throws(() => new TrustedGit({ ...f.options, allowLocalRemotes: false }), { code: 'INVALID_CONFIGURATION' });
  for (const remoteUrl of ['https://secret-token@github.com/owner/repo.git', 'https://github.com.evil/owner/repo.git',
    'ssh://git@github.com/owner/repo.git?exec=bad', 'ext::sh -c whatever']) {
    assert.throws(() => new TrustedGit({ ...f.options, repositories: [{ ...f.options.repositories[0], remoteUrl }] }), { code: 'INVALID_CONFIGURATION' });
  }
  assert.throws(() => new TrustedGit({ ...f.options, transportEnv: { GIT_CONFIG_COUNT: '1' } }), { code: 'INVALID_CONFIGURATION' });
  await assert.rejects(f.transport.remoteHead('demo', 'other'), { code: 'BRANCH_NOT_ALLOWED' });
  await assert.rejects(f.transport.fetch('demo', { ref: '--upload-pack=bad' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.transport.fetch('missing'), { code: 'PROJECT_NOT_FOUND' });
  await assert.rejects(f.transport.fetch('demo', { ref: 'refs/heads/missing-private-branch' }), error => {
    assert.equal(error.code, 'GIT_COMMAND_FAILED');
    assert.equal(String(error).includes('missing-private-branch'), false);
    assert.equal(String(error).includes(f.root), false); return true;
  });
});

test('changed path, tree, identity and size constraints reject unsafe candidates', async t => {
  const f = fixture(t); await f.transport.fetch('demo');
  const input = { parent: f.base, timestamp, message: 'Changes', changes: [{ path: 'readme.txt', mode: '100644', content: Buffer.from('ok') }] };
  for (const path of ['../outside', '/absolute', '.git/config', 'a/.GiT/hooks/foo', 'a\\b', 'a/./b', 'a//b', 'C:/bad', 'a\nb', 'a/git~1/config']) {
    assert.throws(() => validateGitPath(path), { code: 'INVALID_ARGUMENT' });
  }
  await assert.rejects(f.transport.createCommit('demo', { ...input, changes: [...input.changes, ...input.changes] }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.transport.createCommit('demo', { ...input, changes: [{ path: 'link', content: Buffer.from('new'), mode: '100644' }] }), { code: 'UNSUPPORTED_TREE' });
  await assert.rejects(f.transport.createCommit('demo', { ...input, changes: [{ path: 'readme.txt/child', content: Buffer.from('new'), mode: '100644' }] }), { code: 'PUBLISH_CONFLICT' });
  await assert.rejects(f.transport.createCommit('demo', { ...input, changes: [{ path: 'missing', delete: true }] }), { code: 'PUBLISH_CONFLICT' });
  await assert.rejects(f.transport.createCommit('demo', { ...input, changes: [{ path: 'huge', content: Buffer.alloc(2 * 1024 * 1024 + 1), mode: '100644' }] }), { code: 'LIMIT_EXCEEDED' });
  await assert.rejects(f.transport.createCommit('demo', { ...input, timestamp: undefined }), { code: 'INVALID_ARGUMENT' });
  const deleted = await f.transport.createCommit('demo', { ...input, changes: [{ path: 'readme.txt', delete: true }] });
  assert.equal((await f.transport.readTree('demo', deleted.commit)).some(entry => entry.path === 'readme.txt'), false);
  assert.deepEqual(await f.transport.remoteHead('demo'), { commit: f.base }, 'preparation has no external mutation');
});

test('explicitly allowed new branch uses an absent-head lease', async t => {
  const f = fixture(t, { allowedBranches: ['main', 'praxis/requested'] }); await f.transport.fetch('demo');
  const commit = await f.transport.createCommit('demo', { parent: f.base, timestamp, message: 'Optional branch',
    changes: [{ path: 'new.txt', content: Buffer.from('new'), mode: '100644' }] });
  assert.deepEqual(await f.transport.remoteHead('demo', 'praxis/requested'), { commit: null });
  assert.equal((await f.transport.push('demo', { commit: commit.commit, expectedHead: null, branch: 'praxis/requested' })).remoteHead, commit.commit);
  assert.deepEqual(await f.transport.remoteHead('demo'), { commit: f.base });
});

test('a lost push response is reconciled by reading the remote; unknown verification remains explicitly uncertain', async t => {
  const f = fixture(t); await f.transport.fetch('demo');
  const input = { parent: f.base, timestamp, message: 'Lost response',
    changes: [{ path: 'readme.txt', content: Buffer.from('published'), mode: '100644' }] };
  const commit = await f.transport.createCommit('demo', input);
  const command = f.transport.command.bind(f.transport);
  let pushCalls = 0;
  f.transport.command = async (repository, args, options) => {
    const result = await command(repository, args, options);
    if (args[0] === 'push') { pushCalls++; throw new GitTransportError('GIT_COMMAND_FAILED', 'Simulated lost response'); }
    return result;
  };
  assert.equal((await f.transport.push('demo', { commit: commit.commit, expectedHead: f.base })).remoteHead, commit.commit);
  assert.equal((await f.transport.push('demo', { commit: commit.commit, expectedHead: f.base })).alreadyPublished, true);
  assert.equal(pushCalls, 1, 'reconciliation does not repeat the externally completed push');
  const next = await f.transport.createCommit('demo', { ...input, parent: commit.commit, message: 'Next',
    changes: [{ path: 'readme.txt', content: Buffer.from('next'), mode: '100644' }] });
  const readHead = f.transport.remoteHead.bind(f.transport); let reads = 0;
  f.transport.remoteHead = async (...args) => {
    if (++reads > 1) throw new GitTransportError('GIT_COMMAND_FAILED', 'Simulated unavailable remote');
    return readHead(...args);
  };
  await assert.rejects(f.transport.push('demo', { commit: next.commit, expectedHead: commit.commit }), error => {
    assert.equal(error.code, 'PUBLISH_UNCERTAIN'); assert.equal(error.pushAttempted, true); return true;
  });
  assert.equal(pushCalls, 2);
  assert.deepEqual(await readHead('demo'), { commit: next.commit });
});

test('workspace-style Git environment and global config are ignored', async t => {
  const f = fixture(t);
  const names = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'];
  const saved = new Map(names.map(name => [name, process.env[name]]));
  try {
    process.env.GIT_DIR = join(f.root, 'wrong'); process.env.GIT_WORK_TREE = join(f.root, 'wrong');
    process.env.GIT_OBJECT_DIRECTORY = join(f.root, 'wrong'); process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'protocol.file.allow'; process.env.GIT_CONFIG_VALUE_0 = 'never';
    writeFileSync(join(f.home, '.gitconfig'), '[protocol "file"]\nallow = never\n');
    const transport = new TrustedGit(f.options);
    assert.deepEqual(await transport.fetch('demo'), { commit: f.base });
    assert.deepEqual(await transport.remoteHead('demo'), { commit: f.base });
  } finally {
    for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});
