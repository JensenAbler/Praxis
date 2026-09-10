import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, statSync, symlinkSync, readdirSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { HostAccess } from '../src/code/host.js';
import { hostTools } from '../src/code/host-schema.js';

const sha = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'praxis-host-'));
  const root = join(base, 'outside-workspaces', 'Alpha'), data = join(base, 'registry'), recordings = join(base, 'production-recordings');
  mkdirSync(root, { recursive: true }); mkdirSync(recordings);
  let host = new HostAccess({ dataDirectory: data });
  t.after(() => { host.close(); rmSync(base, { recursive: true, force: true }); });
  return { base, root, recordings, data, owner: 'jensen', get host() { return host; }, reopen() { host.close(); host = new HostAccess({ dataDirectory: data }); return host; } };
}
async function attach(f, extra = {}) { return f.host.projectAttach({ owner: f.owner, name: 'Alpha', path: f.root, dataRoots: { recordings: f.recordings }, ...extra }); }
async function pageAll(call) {
  let cursor; const pages = [];
  do { const result = await call(cursor); pages.push(result); cursor = result.nextCursor; } while (cursor !== null);
  return pages;
}

test('host registry persists separate projects and data roots with explicit name-conflict handling', async t => {
  const f = fixture(t), first = await attach(f);
  assert.equal(first.path, f.root);
  assert.equal(first.snapshot, false);
  assert.equal((await attach(f)).hostProjectId, first.hostProjectId);
  await assert.rejects(attach(f, { path: f.recordings }), { code: 'PROJECT_CONFLICT' });
  f.reopen();
  assert.equal(f.host.getProject(f.owner, first.hostProjectId).dataRoots.recordings, f.recordings);
  assert.throws(() => f.host.getProject('other', first.hostProjectId), { code: 'NOT_FOUND' });
  assert.equal((await f.host.projectsList({ owner: 'other' })).projects.length, 0);
  const next = await attach(f, { path: f.recordings, replace: true });
  assert.equal(next.hostProjectId, first.hostProjectId);
  assert.equal(next.path, f.recordings);
  const second = await attach(f, { name: 'Second' });
  const pages = await pageAll(cursor => f.host.projectsList({ owner: f.owner, cursor, limit: 1 }));
  assert.deepEqual(pages.flatMap(page => page.projects.map(project => project.hostProjectId)), [first.hostProjectId, second.hostProjectId]);
});

test('absolute paths and attached data roots expose hidden, git, transcript and binary files without filename filtering', async t => {
  const f = fixture(t), project = await attach(f);
  mkdirSync(join(f.root, '.git'));
  writeFileSync(join(f.root, '.env'), 'FIXTURE_SECRET=visible-to-requesting-owner\n');
  writeFileSync(join(f.root, '.git', 'config'), '[core]\n');
  writeFileSync(join(f.recordings, 'episode.transcript.jsonl'), '{"text":"fixture dialogue"}\n');
  const bytes = Buffer.from([0, 255, 1, 128, 13, 10, 42, 0]);
  writeFileSync(join(f.recordings, 'episode.wav'), bytes);
  const env = await f.host.fileRead({ owner: f.owner, path: join(f.root, '.env'), includeSha256: true });
  assert.match(env.content, /visible-to-requesting-owner/);
  assert.equal(env.sha256, sha(env.content));
  const audio = await pageAll(cursor => f.host.fileRead({ owner: f.owner, hostProjectId: project.hostProjectId, dataRoot: 'recordings', path: 'episode.wav', encoding: 'base64', maxBytes: 4, cursor }));
  assert.deepEqual(Buffer.concat(audio.map(page => Buffer.from(page.content, 'base64'))), bytes);
  const rows = await pageAll(cursor => f.host.filesList({ owner: f.owner, hostProjectId: project.hostProjectId, path: '.', recursive: true, limit: 1, cursor }));
  assert.deepEqual(rows.flatMap(page => page.entries.map(entry => entry.name)), ['.env', '.git', 'config']);
  assert.equal(f.host.resolvePath({ owner: f.owner, hostProjectId: project.hostProjectId, path: '..' }), join(f.base, 'outside-workspaces'));
  assert.equal(f.host.resolvePath({ owner: f.owner, path: f.recordings }), f.recordings);
  assert.equal((await f.host.pathInfo({ owner: f.owner, path: join(f.root, 'missing') })).exists, false);
});

test('reads and streamed patches have no workspace file-size ceiling and preserve UTF-8 across pages', async t => {
  const f = fixture(t), path = join(f.root, 'large.log');
  const content = `${'z'.repeat(3 * 1024 * 1024 + 65530)}UNIQUE_BOUNDARY_TARGET${'z'.repeat(65540)}`;
  writeFileSync(path, content);
  const before = await f.host.pathInfo({ owner: f.owner, path, includeSha256: true });
  const patch = await f.host.filePatch({ owner: f.owner, path, oldText: 'UNIQUE_BOUNDARY_TARGET', newText: 'replacement 😀', expectedSha256: before.sha256 });
  const actual = readFileSync(path, 'utf8');
  assert.equal(actual, content.replace('UNIQUE_BOUNDARY_TARGET', 'replacement 😀'));
  assert.equal(patch.sha256, sha(actual));
  const tail = await f.host.fileRead({ owner: f.owner, path, cursor: 3 * 1024 * 1024, maxBytes: 65536 });
  assert.equal(tail.bytesRead, 65536);
  assert.equal(tail.hasMore, true);
  const unicode = join(f.root, 'utf8.txt'), text = 'abc😀xyz€終';
  writeFileSync(unicode, text);
  const pages = await pageAll(cursor => f.host.fileRead({ owner: f.owner, path: unicode, maxBytes: 4, cursor }));
  assert.equal(pages.map(page => page.content).join(''), text);
  assert.equal(pages.reduce((sum, page) => sum + page.bytesRead, 0), Buffer.byteLength(text));
});

test('stale and ambiguous edits leave bytes intact; append offset avoids duplicate chunks', async t => {
  const f = fixture(t), path = join(f.root, '.env');
  const first = await f.host.fileWrite({ owner: f.owner, path, content: 'one one', expectedSha256: null });
  await assert.rejects(f.host.fileWrite({ owner: f.owner, path, content: 'bad', expectedSha256: null }), { code: 'HASH_CONFLICT' });
  await assert.rejects(f.host.filePatch({ owner: f.owner, path, oldText: 'one', newText: 'two', expectedSha256: first.sha256 }), { code: 'PATCH_CONFLICT' });
  await assert.rejects(f.host.filePatch({ owner: f.owner, path, oldText: 'absent', newText: 'two' }), { code: 'PATCH_CONFLICT' });
  writeFileSync(path, 'externally changed');
  await assert.rejects(f.host.fileWrite({ owner: f.owner, path, content: 'bad', expectedSha256: first.sha256 }), { code: 'HASH_CONFLICT' });
  assert.equal(readFileSync(path, 'utf8'), 'externally changed');
  const appended = await f.host.fileWrite({ owner: f.owner, path, mode: 'append', offset: 18, content: '!', expectedSha256: sha('externally changed') });
  assert.equal(appended.size, 19);
  await assert.rejects(f.host.fileWrite({ owner: f.owner, path, mode: 'append', offset: 18, content: '!' }), { code: 'HASH_CONFLICT' });
  assert.equal(readFileSync(path, 'utf8'), 'externally changed!');
  assert.deepEqual(readdirSync(f.root), ['.env']);
});

test('binary writes and nested creation preserve exact bytes and regular-file permissions', async t => {
  const f = fixture(t), path = join(f.root, 'new', 'recording.raw'), bytes = Buffer.from([255, 0, 128, 42]);
  const written = await f.host.fileWrite({ owner: f.owner, path, content: bytes.toString('base64'), encoding: 'base64', createParents: true, permissions: 0o640 });
  assert.equal(written.atomic, true);
  assert.deepEqual(readFileSync(path), bytes);
  await assert.rejects(f.host.fileWrite({ owner: f.owner, path, content: '%%%wrong', encoding: 'base64' }), { code: 'INVALID_ARGUMENT' });
  if (process.platform !== 'win32') {
    chmodSync(path, 0o751); const original = statSync(path);
    await f.host.fileWrite({ owner: f.owner, path, content: 'executable' });
    assert.equal(statSync(path).mode & 0o7777, 0o751);
    assert.equal(statSync(path).uid, original.uid); assert.equal(statSync(path).gid, original.gid);
    await f.host.filePatch({ owner: f.owner, path, oldText: 'executable', newText: 'still executable' });
    assert.equal(statSync(path).mode & 0o7777, 0o751);
  }
});

test('symlinks expose external directories and writes preserve the symlink itself', async t => {
  const f = fixture(t), path = join(f.recordings, 'real.log'), link = join(f.root, 'linked.log');
  writeFileSync(path, 'before');
  try { symlinkSync(path, link, 'file'); } catch (error) { if (error.code === 'EPERM') { t.skip('Creating file symlinks requires Windows permission.'); return; } throw error; }
  symlinkSync(f.recordings, join(f.root, 'recordings'), process.platform === 'win32' ? 'junction' : 'dir');
  symlinkSync(f.root, join(f.recordings, 'loop'), process.platform === 'win32' ? 'junction' : 'dir');
  const listing = await f.host.filesList({ owner: f.owner, path: f.root, recursive: true });
  assert.equal(listing.hasMore, false);
  assert(listing.entries.some(entry => entry.path === join(f.root, 'recordings', 'real.log')));
  const info = await f.host.pathInfo({ owner: f.owner, path: link });
  assert.equal(info.symlink, true);
  await f.host.fileWrite({ owner: f.owner, path: link, content: 'after', expectedSha256: sha('before') });
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readFileSync(path, 'utf8'), 'after');
  await f.host.filePatch({ owner: f.owner, path: link, oldText: 'after', newText: 'patched' });
  assert.equal(readFileSync(path, 'utf8'), 'patched');
});

test('literal search paginates scan budgets, overlapping matches and chunk boundaries across all file extensions', async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, '.env'), 'aaaaa');
  writeFileSync(join(f.root, 'session.transcript.jsonl'), `${'x'.repeat(65534)}needle${'x'.repeat(17)}needle`);
  writeFileSync(join(f.root, 'recording.bin'), Buffer.from('z\0needle\0q'));
  const overlap = await pageAll(cursor => f.host.search({ owner: f.owner, path: join(f.root, '.env'), query: 'aaa', limit: 1, maxScanBytes: 1, cursor }));
  assert.deepEqual(overlap.flatMap(page => page.matches.map(match => match.byteOffset)), [0, 1, 2]);
  const pages = await pageAll(cursor => f.host.search({ owner: f.owner, path: f.root, query: 'needle', limit: 1, maxScanBytes: 4096, maxFiles: 1, cursor }));
  const matches = pages.flatMap(page => page.matches);
  assert.equal(matches.length, 3);
  assert.deepEqual(matches.filter(match => match.path.endsWith('jsonl')).map(match => match.byteOffset), [65534, 65557]);
  assert(matches.some(match => match.path.endsWith('.bin')));
  assert(pages.every(page => page.scannedBytes <= 4096));
  const first = await f.host.search({ owner: f.owner, path: f.root, query: 'needle', maxScanBytes: 1 });
  await assert.rejects(f.host.search({ owner: f.owner, path: f.root, query: 'different', cursor: first.nextCursor }), { code: 'INVALID_ARGUMENT' });
});

test('all descriptors use the host dispatch contract and bound output rather than source file size', t => {
  assert.equal(Object.keys(hostTools).length, 8);
  for (const tool of Object.values(hostTools)) {
    assert.equal(tool.target, 'host');
    assert.equal(typeof HostAccess.prototype[tool.method], 'function');
  }
  assert(hostTools.host_file_write.schema.safeParse({ path: '/tmp/new.env', content: 'a'.repeat(200000) }).success);
  assert(hostTools.host_file_read.schema.safeParse({ path: '/var/log/service.log', cursor: 10 ** 12 }).success);
  assert.equal(hostTools.host_file_read.schema.parse({ path: '/var/log/service.log' }).maxBytes, 16384);
  assert(!hostTools.host_file_read.schema.safeParse({ path: '/tmp/file', maxBytes: 1000000 }).success);
});
