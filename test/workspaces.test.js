import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, linkSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeStore } from '../src/code/store.js';
import { WorkspaceManager } from '../src/code/workspaces.js';
import { sha256, LIMITS } from '../src/code/paths.js';

function fixture(t, { readme = 'Welcome\nFind this line\nFind another line\n' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'praxis-workspace-'));
  const dataDirectory = join(root, 'private'), workspaceDirectory = join(root, 'workspaces'), snapshotPath = join(root, 'snapshot');
  mkdirSync(snapshotPath); mkdirSync(join(snapshotPath, 'src'));
  writeFileSync(join(snapshotPath, 'src', 'hello.js'), "export const greeting = 'hello';\n");
  writeFileSync(join(snapshotPath, 'README.md'), readme);
  writeFileSync(join(snapshotPath, '.env'), 'PRIVATE_VALUE=hidden');
  const store = new CodeStore(dataDirectory);
  store.db.exec('CREATE TABLE code_jobs (id TEXT, owner TEXT, workspace_id TEXT, status TEXT)');
  const config = { store, dataDirectory, workspaceDirectory, projects: [{ id: 'demo', name: 'Demo', revision: '0123456789abcdef', snapshotPath, repository: 'fixture:demo' }] };
  let workspaces = new WorkspaceManager(config);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const owner = 'jensen';
  const created = workspaces.create({ owner, projectId: 'demo', baseRevision: '0123456789abcdef', idempotencyKey: 'create-demo-1', label: 'A real task' });
  return { root, store, config, workspaces, owner, created, workspaceId: created.workspaceId,
    workspacePath: join(workspaceDirectory, created.workspaceId), reopen: () => (workspaces = new WorkspaceManager(config)) };
}

test('source discovery, bounded reads/search, edits and receipts survive a new manager', t => {
  const f = fixture(t), { owner, workspaceId, workspaces } = f;
  assert.equal(workspaces.projectsList({ owner }).projects[0].revision, '0123456789abcdef');
  assert.equal(workspaces.filesList({ owner, projectId: 'demo' }).files.length, 2);
  const read = workspaces.read({ owner, workspaceId, path: 'README.md', startLine: 2, lineCount: 1 });
  assert.deepEqual(read.lines, [{ number: 2, text: 'Find this line' }]);
  assert.equal(read.nextLine, 3);
  const search = workspaces.search({ owner, workspaceId, query: 'Find', limit: 1 });
  assert.equal(search.matches[0].line, 2);
  assert.equal(workspaces.search({ owner, workspaceId, query: 'Find', limit: 1, cursor: search.nextCursor }).matches[0].line, 3);
  const args = { owner, workspaceId, expectedRevision: read.revision, idempotencyKey: 'edit-demo-1', changes: [
    { action: 'patch', path: 'README.md', expectedSha256: read.sha256, oldText: 'Welcome', newText: 'Hello Praxis' },
    { action: 'write', path: 'new.txt', expectedSha256: null, content: 'A new file\n' },
  ] };
  const applied = workspaces.apply(args);
  assert.equal(applied.status, 'completed');
  assert.notEqual(applied.result.revision, read.revision);
  assert.deepEqual(workspaces.apply(args), applied);
  assert.throws(() => workspaces.apply({ ...args, changes: [] }), /changes/);
  assert.throws(() => workspaces.apply({ ...args, changes: [{ ...args.changes[0], newText: 'Other' }] }), { code: 'IDEMPOTENCY_CONFLICT' });
  const reopened = f.reopen();
  assert.equal(reopened.list({ owner }).workspaces[0].workspaceId, workspaceId);
  assert.deepEqual(reopened.operationRead({ owner, operationId: applied.operationId }), applied);
  assert.equal(reopened.inspect({ owner, workspaceId }).dirty, true);
  assert.equal(reopened.read({ owner, workspaceId, path: 'README.md' }).lines[0].text, 'Hello Praxis');
});

test('project discovery stays compact while project inspection preserves the full task', t => {
  const { workspaces, owner } = fixture(t);
  const instructions = 'Original task with important acceptance details.\n'.repeat(100);
  workspaces.projects.get('demo').instructions = instructions;
  const listed = workspaces.projectsList({ owner });
  assert.equal(listed.projects[0].instructionsAvailable, true);
  assert.equal(Object.hasOwn(listed.projects[0], 'instructions'), false);
  assert.ok(!JSON.stringify(listed).includes(instructions.slice(0, 40)));
  assert.match(listed.nextStep, /project_inspect/);
  assert.equal(workspaces.projectInspect({ owner, projectId: 'demo' }).instructions, instructions);
});

test('owner, revision, hash and batch preconditions reject before any effects', t => {
  const { workspaces, owner, workspaceId } = fixture(t);
  const initial = workspaces.inspect({ owner, workspaceId });
  const write = { action: 'write', path: 'new.txt', expectedSha256: null, content: 'Should not exist' };
  assert.throws(() => workspaces.inspect({ owner: 'other', workspaceId }), { code: 'NOT_FOUND' });
  assert.throws(() => workspaces.read({ owner, projectId: 'demo', workspaceId, path: 'README.md' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => workspaces.apply({ owner, workspaceId, expectedRevision: 'stale', idempotencyKey: 'stale-edit', changes: [write] }), { code: 'REVISION_CONFLICT' });
  assert.throws(() => workspaces.apply({ owner, workspaceId, expectedRevision: initial.revision, idempotencyKey: 'bad-batch-1', changes: [write,
    { action: 'delete', path: 'README.md', expectedSha256: 'stale' }] }), { code: 'HASH_CONFLICT' });
  assert.equal(workspaces.filesList({ owner, workspaceId }).files.some(file => file.path === 'new.txt'), false);
  assert.equal(workspaces.inspect({ owner, workspaceId }).revision, initial.revision);
});

test('small patches edit large Unicode source while preserving input and resulting-file limits', t => {
  const original = '🙂'.repeat((LIMITS.fileBytes - 4) / 4) + '\nEND';
  assert.ok(original.length > LIMITS.writeCharacters);
  assert.equal(Buffer.byteLength(original), LIMITS.fileBytes);
  const { workspaces, workspacePath, owner, workspaceId } = fixture(t, { readme: original });
  const read = workspaces.read({ owner, workspaceId, path: 'README.md' });
  const applied = workspaces.apply({ owner, workspaceId, expectedRevision: read.revision, idempotencyKey: 'large-unicode-patch', changes: [
    { action: 'patch', path: 'README.md', expectedSha256: read.sha256, oldText: '\nEND', newText: '\nFIN' },
  ] });
  const expected = original.slice(0, -3) + 'FIN';
  assert.equal(readFileSync(join(workspacePath, 'README.md'), 'utf8'), expected);
  const common = { owner, workspaceId, expectedRevision: applied.result.revision };
  const hash = sha256(expected), patch = { action: 'patch', path: 'README.md', expectedSha256: hash, oldText: '\nFIN', newText: '\nFIN🙂' };
  assert.throws(() => workspaces.apply({ ...common, idempotencyKey: 'large-unicode-overflow', changes: [patch] }), { code: 'LIMIT_EXCEEDED' });
  for (const field of ['oldText', 'newText']) {
    assert.throws(() => workspaces.apply({ ...common, idempotencyKey: `large-input-${field}`, changes: [
      { ...patch, [field]: 'x'.repeat(LIMITS.writeCharacters + 1) },
    ] }), { code: 'VALIDATION_ERROR' });
  }
  assert.throws(() => workspaces.apply({ ...common, idempotencyKey: 'large-full-write', changes: [
    { action: 'write', path: 'new.txt', expectedSha256: null, content: 'x'.repeat(LIMITS.writeCharacters + 1) },
  ] }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => workspaces.apply({ ...common, idempotencyKey: 'large-total-request', changes: ['one.txt', 'two.txt'].map(path =>
    ({ action: 'write', path, expectedSha256: null, content: 'x'.repeat(LIMITS.writeCharacters) })) }), { code: 'LIMIT_EXCEEDED' });
  assert.equal(workspaces.inspect({ owner, workspaceId }).revision, common.expectedRevision);
  assert.equal(readFileSync(join(workspacePath, 'README.md'), 'utf8'), expected);
});

test('same-file patches apply sequentially using the original hash and journal one final effect', t => {
  const { workspaces, workspacePath, store, owner, workspaceId } = fixture(t, { readme: 'start\n' });
  const read = workspaces.read({ owner, workspaceId, path: 'README.md' });
  const args = { owner, workspaceId, expectedRevision: read.revision, idempotencyKey: 'sequential-patches', changes: [
    { action: 'patch', path: 'README.md', expectedSha256: read.sha256, oldText: 'start', newText: 'middle' },
    { action: 'write', path: 'other.txt', expectedSha256: null, content: 'Other file\n' },
    { action: 'patch', path: 'README.md', expectedSha256: read.sha256, oldText: 'middle', newText: 'finish' },
  ] };
  const applied = workspaces.apply(args);
  assert.deepEqual(applied.result.changedPaths, ['README.md', 'other.txt']);
  const plan = JSON.parse(store.db.prepare('SELECT plan_json FROM operations WHERE id = ?').get(applied.operationId).plan_json);
  assert.equal(plan.files.length, 2);
  assert.equal(plan.files[0].before, read.sha256);
  assert.equal(Buffer.from(plan.files[0].content, 'base64').toString(), 'finish\n');
  assert.equal(readFileSync(join(workspacePath, 'README.md'), 'utf8'), 'finish\n');
  assert.deepEqual(workspaces.apply(args), applied);
});

test('every sequential patch is validated before any file or receipt changes', t => {
  const { workspaces, workspacePath, owner, workspaceId } = fixture(t, { readme: 'start\n' });
  const read = workspaces.read({ owner, workspaceId, path: 'README.md' });
  const first = { action: 'patch', path: 'README.md', expectedSha256: read.sha256, oldText: 'start', newText: 'middle middle' };
  const invalidSteps = [
    [{ ...first, oldText: 'middle middle', newText: 'finish', expectedSha256: sha256('middle middle\n') }, 'HASH_CONFLICT'],
    [{ ...first, oldText: 'missing', newText: 'finish' }, 'PATCH_CONFLICT'],
    [{ ...first, oldText: 'middle', newText: 'finish' }, 'PATCH_CONFLICT'],
  ];
  invalidSteps.forEach(([last, code], index) => {
    assert.throws(() => workspaces.apply({ owner, workspaceId, expectedRevision: read.revision, idempotencyKey: `failed-late-patch-${index}`, changes: [
      { action: 'write', path: 'new.txt', expectedSha256: null, content: 'Must not be created' }, first, last,
    ] }), { code });
    assert.equal(workspaces.inspect({ owner, workspaceId }).revision, read.revision);
    assert.equal(workspaces.operationsList({ owner, workspaceId }).operations.length, 1);
    assert.equal(readFileSync(join(workspacePath, 'README.md'), 'utf8'), 'start\n');
    assert.equal(workspaces.filesList({ owner, workspaceId }).files.some(file => file.path === 'new.txt'), false);
  });
});

test('repeated patch paths do not allow mixed actions, rename reuse or ancestor conflicts', t => {
  const { workspaces, owner, workspaceId } = fixture(t, { readme: 'start\n' });
  const read = workspaces.read({ owner, workspaceId, path: 'README.md' });
  const patch = { action: 'patch', path: 'README.md', expectedSha256: read.sha256, oldText: 'start', newText: 'finish' };
  const conflictingBatches = [
    [patch, { action: 'write', path: 'README.md', expectedSha256: read.sha256, content: 'overwrite' }],
    [{ action: 'write', path: 'README.md', expectedSha256: read.sha256, content: 'overwrite' }, patch],
    [patch, { action: 'delete', path: 'README.md', expectedSha256: read.sha256 }],
    [patch, { action: 'rename', path: 'README.md', to: 'GUIDE.md', expectedSha256: read.sha256 }],
    [{ action: 'rename', path: 'README.md', to: 'GUIDE.md', expectedSha256: read.sha256 },
      { ...patch, path: 'GUIDE.md', expectedSha256: null }],
    [{ action: 'write', path: 'new', expectedSha256: null, content: 'parent' },
      { action: 'write', path: 'new/child', expectedSha256: null, content: 'child' }],
  ];
  conflictingBatches.forEach((changes, index) => {
    assert.throws(() => workspaces.apply({ owner, workspaceId, expectedRevision: read.revision, idempotencyKey: `conflicting-path-${index}`, changes }), { code: 'VALIDATION_ERROR' });
    assert.equal(workspaces.inspect({ owner, workspaceId }).revision, read.revision);
    assert.equal(workspaces.operationsList({ owner, workspaceId }).operations.length, 1);
  });
});

test('sequential patch journal resumes a partial batch without reapplying patches', t => {
  const f = fixture(t, { readme: 'start\n' }), { workspaces, workspacePath, owner, workspaceId, store } = f;
  const read = workspaces.read({ owner, workspaceId, path: 'README.md' });
  const args = { owner, workspaceId, expectedRevision: read.revision, idempotencyKey: 'sequential-crash-replay', changes: [
    { action: 'patch', path: 'README.md', expectedSha256: read.sha256, oldText: 'start', newText: 'middle' },
    { action: 'patch', path: 'README.md', expectedSha256: read.sha256, oldText: 'middle', newText: 'finish' },
    { action: 'write', path: 'second.txt', expectedSha256: null, content: 'Second file\n' },
  ] };
  let operationId;
  workspaces._execute = id => { operationId = id; throw new Error('Simulated process interruption'); };
  assert.throws(() => workspaces.apply(args), /Simulated process interruption/);
  const prepared = store.db.prepare('SELECT status, plan_json FROM operations WHERE id = ?').get(operationId);
  assert.equal(prepared.status, 'prepared');
  const plan = JSON.parse(prepared.plan_json);
  assert.equal(plan.files.length, 2);
  assert.equal(Buffer.from(plan.files[0].content, 'base64').toString(), 'finish\n');
  // A crash can occur between complete file writes, but never journals intermediate patch text.
  writeFileSync(join(workspacePath, 'README.md'), Buffer.from(plan.files[0].content, 'base64'));
  const recovered = f.reopen();
  const receipt = recovered.operationRead({ owner, operationId });
  assert.equal(receipt.status, 'completed');
  assert.deepEqual(receipt.result.changedPaths, ['README.md', 'second.txt']);
  assert.equal(readFileSync(join(workspacePath, 'README.md'), 'utf8'), 'finish\n');
  assert.equal(readFileSync(join(workspacePath, 'second.txt'), 'utf8'), 'Second file\n');
  assert.deepEqual(recovered.apply(args), receipt);
});

test('filesystem tools reject traversal, protected names and linked contents without blocking sandbox cleanup', t => {
  const { workspaces, workspacePath, owner, workspaceId, root } = fixture(t);
  for (const path of ['../private/coding.sqlite', '/etc/passwd', 'C:\\Windows\\win.ini', '.env', '.git/config', 'nested/../../private']) {
    assert.throws(() => workspaces.read({ owner, workspaceId, path }));
  }
  // Use an ordinary filename so the link check, rather than the protected-name filter, rejects it.
  const secret = join(root, 'outside.txt'); writeFileSync(secret, 'not workspace source');
  linkSync(secret, join(workspacePath, 'linked.txt'));
  assert.throws(() => workspaces.read({ owner, workspaceId, path: 'linked.txt' }), { code: 'UNSAFE_PATH' });
  const info = workspaces.inspect({ owner, workspaceId });
  assert.deepEqual(info.issues, [{ path: 'linked.txt', issue: 'hard_link' }]);
  assert.equal(workspaces.getExecutionWorkspace({ owner, workspaceId }).workspaceId, workspaceId);
  assert.match(workspaces.diff({ owner, workspaceId }).diff, /Unsafe filesystem entry/);
  if (process.platform !== 'win32') {
    symlinkSync(root, join(workspacePath, 'escaped'));
    assert.throws(() => workspaces.read({ owner, workspaceId, path: 'escaped/outside.txt' }), { code: 'UNSAFE_PATH' });
  }
});

test('active jobs exclude source reads, edits, removal; internal completion refresh remains available', t => {
  const { workspaces, store, owner, workspaceId } = fixture(t);
  const initial = workspaces.inspect({ owner, workspaceId });
  store.db.prepare('INSERT INTO code_jobs VALUES (?,?,?,?)').run('running-job', owner, workspaceId, 'starting');
  assert.throws(() => workspaces.read({ owner, workspaceId, path: 'README.md' }), { code: 'WORKSPACE_BUSY' });
  assert.throws(() => workspaces.apply({ owner, workspaceId, expectedRevision: initial.revision, idempotencyKey: 'blocked-edit', changes: [{ action: 'write', path: 'x', expectedSha256: null, content: 'x' }] }), { code: 'WORKSPACE_BUSY' });
  assert.throws(() => workspaces.remove({ owner, workspaceId, expectedRevision: initial.revision }), { code: 'WORKSPACE_BUSY' });
  assert.equal(workspaces.refreshAfterJob({ owner, workspaceId }).revision, initial.revision);
});

test('workspace recovery during active commands reports the stored revision without scanning changing files', t => {
  const { workspaces, store, owner, workspaceId, workspacePath, reopen } = fixture(t);
  const initial = workspaces.inspect({ owner, workspaceId });
  assert.equal(initial.revisionVerified, true);
  store.db.prepare('INSERT INTO code_jobs VALUES (?,?,?,?)').run('active-recovery-job', owner, workspaceId, 'queued');
  // A file exceeding the scan limit proves active inspection does not traverse command output.
  writeFileSync(join(workspacePath, 'unfinished-output.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  const recovered = reopen();
  for (const status of ['queued', 'starting', 'running', 'canceling']) {
    store.db.prepare('UPDATE code_jobs SET status = ? WHERE id = ?').run(status, 'active-recovery-job');
    const inspected = recovered.inspect({ owner, workspaceId });
    assert.equal(inspected.revision, initial.revision);
    assert.equal(inspected.revisionVerified, false);
    assert.equal(inspected.dirty, null);
    assert.equal(inspected.inspectionStatus, 'job_in_progress');
    assert.deepEqual(inspected.activeJobIds, ['active-recovery-job']);
    assert.deepEqual(inspected.activeJobs, [{ id: 'active-recovery-job', status }]);
    assert.throws(() => recovered.read({ owner, workspaceId, path: 'README.md' }), { code: 'WORKSPACE_BUSY' });
    assert.throws(() => recovered.diff({ owner, workspaceId }), { code: 'WORKSPACE_BUSY' });
  }
  writeFileSync(join(workspacePath, 'unfinished-output.txt'), 'Finished output\n');
  store.db.prepare("UPDATE code_jobs SET status = 'completed' WHERE id = ?").run('active-recovery-job');
  const finished = recovered.inspect({ owner, workspaceId });
  assert.equal(finished.revisionVerified, true);
  assert.equal(finished.dirty, true);
  assert.notEqual(finished.revision, initial.revision);
  assert.deepEqual(finished.activeJobIds, []);
});

test('diff pagination accounts for renames, additions, deletions, binary content and executable modes', t => {
  const { workspaces, workspacePath, owner, workspaceId } = fixture(t);
  const source = workspaces.read({ owner, workspaceId, path: 'README.md' });
  const applied = workspaces.apply({ owner, workspaceId, expectedRevision: source.revision, idempotencyKey: 'rename-demo', changes: [
    { action: 'rename', path: 'README.md', to: 'GUIDE.md', expectedSha256: source.sha256 },
    { action: 'write', path: 'binary.dat', expectedSha256: null, content: '\0binary' },
  ] });
  if (process.platform !== 'win32') chmodSync(join(workspacePath, 'src', 'hello.js'), 0o755);
  const first = workspaces.diff({ owner, workspaceId, limit: 40 });
  let all = first.diff, cursor = first.nextCursor;
  while (cursor !== null) { const next = workspaces.diff({ owner, workspaceId, expectedRevision: first.revision, limit: 40, cursor }); all += next.diff; cursor = next.nextCursor; }
  assert.match(all, /deleted file mode/); assert.match(all, /new file mode/); assert.match(all, /Binary files differ/);
  if (process.platform !== 'win32') assert.match(all, /old mode 100644\nnew mode 100755/);
  assert.equal(all.length, first.totalCharacters);
  assert.throws(() => workspaces.diff({ owner, workspaceId, expectedRevision: 'outdated' }), { code: 'REVISION_CONFLICT' });
  assert.equal(applied.status, 'completed');
});

test('diff maxBytes names its unit and stays compatible with legacy limit', t => {
  const { workspaces, owner, workspaceId } = fixture(t, { readme: 'before\n'.repeat(100) });
  const read = workspaces.read({ owner, workspaceId, path: 'README.md' });
  workspaces.apply({ owner, workspaceId, expectedRevision: read.revision, idempotencyKey: 'diff-page-byte-alias', changes: [
    { action: 'write', path: 'README.md', expectedSha256: read.sha256, content: 'after\n'.repeat(100) },
  ] });
  const args = { owner, workspaceId };
  const legacy = workspaces.diff({ ...args, limit: 256 });
  assert.ok(legacy.nextCursor !== null);
  assert.ok(Buffer.byteLength(legacy.diff) <= 256);
  assert.deepEqual(workspaces.diff({ ...args, maxBytes: 256 }), legacy);
  assert.deepEqual(workspaces.diff({ ...args, maxBytes: 256, limit: 256 }), legacy);
  assert.throws(() => workspaces.diff({ ...args, maxBytes: 512, limit: 256 }), { code: 'INVALID_ARGUMENT' });
  for (const maxBytes of [0, 100, 32769, 1024.5]) {
    assert.throws(() => workspaces.diff({ ...args, maxBytes }), { code: 'INVALID_ARGUMENT' });
  }
});

test('prepared edit journal resumes after a partial write without duplicating its changes', t => {
  const f = fixture(t), { store, owner, workspaceId, workspacePath, workspaces } = f;
  const read = workspaces.read({ owner, workspaceId, path: 'README.md' });
  const operationId = workspaces.store.transaction(() => workspaces._prepare({ owner, workspaceId, idempotencyKey: 'interrupted-1', kind: 'apply', request: { fixture: true }, plan: { files: [
    { path: 'README.md', before: read.sha256, content: Buffer.from('After interruption\n').toString('base64'), mode: '100644' },
    { path: 'second.txt', before: null, content: Buffer.from('Second write\n').toString('base64'), mode: '100644' },
  ] } }));
  writeFileSync(join(workspacePath, 'README.md'), 'After interruption\n');
  assert.equal(store.db.prepare('SELECT status FROM operations WHERE id = ?').get(operationId).status, 'prepared');
  const recovered = f.reopen();
  assert.equal(recovered.operationRead({ owner, operationId }).status, 'completed');
  assert.equal(readFileSync(join(workspacePath, 'second.txt'), 'utf8'), 'Second write\n');
  assert.equal(recovered.read({ owner, workspaceId, path: 'README.md' }).sha256, sha256('After interruption\n'));
});

test('removal requires a revision and explicit dirty discard, and its receipt is repeatable', t => {
  const { workspaces, owner, workspaceId } = fixture(t);
  const read = workspaces.read({ owner, workspaceId, path: 'README.md' });
  const applied = workspaces.apply({ owner, workspaceId, expectedRevision: read.revision, idempotencyKey: 'dirty-edit-1', changes: [{ action: 'write', path: 'new.txt', expectedSha256: null, content: 'new' }] });
  const args = { owner, workspaceId, expectedRevision: applied.result.revision, idempotencyKey: 'remove-demo-1' };
  assert.equal(workspaces.remove(args).preview, true);
  assert.throws(() => workspaces.remove({ ...args, preview: false }), { code: 'DIRTY_WORKSPACE' });
  const removed = workspaces.remove({ ...args, preview: false, discard: true });
  assert.equal(removed.result.removed, true);
  assert.deepEqual(workspaces.remove({ ...args, preview: false, discard: true }), removed);
  assert.deepEqual(workspaces.list({ owner }).workspaces, []);
});

test('prototype names remain ordinary source files in hashes and diffs', t => {
  const { workspaces, owner, workspaceId } = fixture(t);
  const initial = workspaces.inspect({ owner, workspaceId });
  workspaces.apply({ owner, workspaceId, expectedRevision: initial.revision, idempotencyKey: 'prototype-files', changes:
    ['__proto__', 'constructor', 'toString'].map(path => ({ action: 'write', path, expectedSha256: null, content: `${path}\n` })) });
  const state = workspaces.inspect({ owner, workspaceId });
  assert.notEqual(state.revision, initial.revision);
  assert.equal(state.fileCount, 5);
  for (const path of ['__proto__', 'constructor', 'toString']) {
    assert.equal(workspaces.read({ owner, workspaceId, path }).lines[0].text, path);
    assert.ok(workspaces.diff({ owner, workspaceId }).changes.some(change => change.path === path));
  }
});

test('long source lines and UTF-8 diff pages recover every character', t => {
  const { workspaces, owner, workspaceId } = fixture(t);
  const content = 'x'.repeat(32767) + '🙂'.repeat(17000);
  const initial = workspaces.inspect({ owner, workspaceId });
  workspaces.apply({ owner, workspaceId, expectedRevision: initial.revision, idempotencyKey: 'long-line-file', changes:
    [{ action: 'write', path: 'a file with spaces.txt', expectedSha256: null, content }] });
  let recovered = '', position = { line: 1, column: 1 };
  while (position) {
    const read = workspaces.read({ owner, workspaceId, path: 'a file with spaces.txt', startLine: position.line, startColumn: position.column });
    recovered += read.lines.map(line => line.text).join('\n'); position = read.nextPosition;
  }
  assert.equal(recovered, content);
  let diff = '', cursor = 0, revision;
  do {
    const result = workspaces.diff({ owner, workspaceId, cursor, limit: 4093, expectedRevision: revision });
    diff += result.diff; cursor = result.nextCursor; revision = result.revision;
  } while (cursor !== null);
  assert.ok(diff.includes(`+${content}\n`));
  assert.ok(!diff.includes('\uFFFD'));
  assert.match(diff, /No newline at end of file/);
});

test('ordinary edits produce small contextual diffs', t => {
  const { workspaces, owner, workspaceId } = fixture(t, { readme: Array.from({ length: 1000 }, (_, index) => `line ${index}`).join('\n') + '\n' });
  const source = workspaces.read({ owner, workspaceId, path: 'README.md' });
  workspaces.apply({ owner, workspaceId, expectedRevision: source.revision, idempotencyKey: 'contextual-patch', changes:
    [{ action: 'patch', path: 'README.md', expectedSha256: source.sha256, oldText: 'line 500\n', newText: 'changed line 500\n' }] });
  const diff = workspaces.diff({ owner, workspaceId });
  assert.equal(diff.fullReplacementFallbacks, 0);
  assert.ok(diff.totalCharacters < 500, `Expected a small contextual patch, got ${diff.totalCharacters} characters.`);
  assert.match(diff.diff, /-line 500\n\+changed line 500/);
  assert.ok(!diff.diff.includes('line 400'));
});
