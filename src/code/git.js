import { mkdirSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, lstatSync, existsSync, readdirSync, rmSync, chmodSync, fchmodSync, constants } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireValue, readSafe, safePath, sha256, manifest, LIMITS, WorkspaceError } from './paths.js';
import { CodeProjects } from './projects.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const TERMINAL = new Set(['completed', 'failed']);
const STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'uncertain']);
export const GIT_LIMITS = Object.freeze({ outboxBytes: 512 * 1024 * 1024, journalBytes: 128 * 1024 * 1024 });
const now = () => new Date().toISOString();
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ownerValue = owner => requireValue(typeof owner === 'string' && owner.length > 0 && owner.length <= 100, 'A valid owner is required.');
const keyValue = key => requireValue(typeof key === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(key), 'idempotencyKey must be 8–128 simple identifier characters.');
const idValue = id => requireValue(typeof id === 'string' && UUID.test(id), 'operationId must be a UUID.');
function directorySync(path) {
  if (process.platform === 'win32') return;
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function durableFile(root, path, content) {
  const target = safePath(root, path);
  let parent = root;
  for (const component of path.split('/').slice(0, -1)) {
    parent = join(parent, component);
    if (!existsSync(parent)) { mkdirSync(parent, { mode: 0o2750 }); chmodSync(parent, 0o2750); }
  }
  safePath(root, path);
  const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o640);
  try { writeFileSync(fd, content); fchmodSync(fd, 0o640); fsyncSync(fd); } finally { closeSync(fd); }
  directorySync(dirname(target));
}
function outside(root, container) {
  const path = relative(container, root);
  return path && (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`));
}
function directoryBytes(root) {
  let total = 0;
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const target = join(path, entry.name), stat = lstatSync(target);
      requireValue(!stat.isSymbolicLink(), 'Git transfer storage contains an unsafe entry.', 'UNSAFE_PATH');
      if (stat.isDirectory()) visit(target);
      else {
        requireValue(stat.isFile() && stat.nlink === 1, 'Git transfer storage contains an unsafe entry.', 'UNSAFE_PATH');
        total += stat.size;
      }
    }
  }
  visit(root); return total;
}

/** Captures source only. Credentials, Git execution, and deployment belong to the separate broker. */
export class CodeGit {
  constructor({ store, workspaces, broker, outboxDirectory, exportDirectory }) {
    this.store = store; this.db = store.db; this.workspaces = workspaces; this.broker = broker;
    this.outboxDirectory = resolve(outboxDirectory); this.exportDirectory = resolve(exportDirectory);
    requireValue(outside(this.outboxDirectory, workspaces.workspaceDirectory) && outside(this.exportDirectory, workspaces.workspaceDirectory),
      'Git transfer directories must be outside coding workspaces.', 'UNSAFE_PATH');
    requireValue(outside(this.outboxDirectory, this.exportDirectory) && outside(this.exportDirectory, this.outboxDirectory),
      'Git outbox and export directories must be separate.', 'UNSAFE_PATH');
    if (!existsSync(this.outboxDirectory)) {
      mkdirSync(this.outboxDirectory, { recursive: true, mode: 0o2750 }); chmodSync(this.outboxDirectory, 0o2750);
    }
    safePath(this.outboxDirectory, '', { directory: true });
    safePath(this.exportDirectory, '', { directory: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS code_git_requests (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL,
        project_id TEXT NOT NULL, workspace_id TEXT, kind TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        input_json TEXT NOT NULL, request_json TEXT NOT NULL, snapshot_json TEXT,
        receipt_json TEXT NOT NULL, integrated INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(owner,idempotency_key));
      CREATE INDEX IF NOT EXISTS code_git_owner ON code_git_requests(owner,row_id DESC);
      CREATE TABLE IF NOT EXISTS code_git_workspace_heads (
        workspace_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, commit_hash TEXT NOT NULL,
        revision TEXT NOT NULL, entries_json TEXT NOT NULL, updated_at TEXT NOT NULL);`);
    for (const row of this.db.prepare("SELECT * FROM code_git_requests WHERE kind='commit'").all()) this._cleanup(row);
    this.projects = new CodeProjects({ git: this });
  }

  _row(owner, operationId) {
    ownerValue(owner); idValue(operationId);
    const row = this.db.prepare('SELECT * FROM code_git_requests WHERE owner=? AND id=?').get(owner, operationId);
    requireValue(row, 'Git operation not found.', 'NOT_FOUND');
    return row;
  }
  _existing(owner, idempotencyKey, input) {
    ownerValue(owner); keyValue(idempotencyKey);
    const row = this.db.prepare('SELECT * FROM code_git_requests WHERE owner=? AND idempotency_key=?').get(owner, idempotencyKey);
    if (row) requireValue(row.input_json === JSON.stringify(input), 'This idempotency key was used for different arguments.', 'IDEMPOTENCY_CONFLICT');
    return row;
  }
  _prepare({ owner, idempotencyKey, input, projectId, workspaceId = null, request = {}, snapshot = null, operationId = randomUUID() }) {
    requireValue(this.db.prepare('SELECT COUNT(*) AS count FROM code_git_requests').get().count < LIMITS.operations,
      'Git operation receipt quota reached.', 'LIMIT_EXCEEDED');
    const createdAt = now(), kind = input.kind;
    const receipt = { operationId, kind, status: 'queued', projectId, ...(workspaceId ? { workspaceId } : {}),
      result: null, submissionPending: true, createdAt, updatedAt: createdAt };
    const body = { ...request, owner, operationId, idempotencyKey };
    const inputJson = JSON.stringify(input), requestJson = JSON.stringify(body), snapshotJson = snapshot ? JSON.stringify(snapshot) : null;
    const journalBytes = this.db.prepare(`SELECT COALESCE(SUM(length(CAST(input_json AS BLOB)) + length(CAST(request_json AS BLOB))
      + COALESCE(length(CAST(snapshot_json AS BLOB)),0)),0) AS bytes FROM code_git_requests`).get().bytes;
    requireValue(journalBytes + Buffer.byteLength(inputJson) + Buffer.byteLength(requestJson) + Buffer.byteLength(snapshotJson || '') <= GIT_LIMITS.journalBytes,
      'Git operation journal quota reached; owner maintenance is required.', 'LIMIT_EXCEEDED');
    this.db.prepare(`INSERT INTO code_git_requests (id,owner,project_id,workspace_id,kind,idempotency_key,input_json,
      request_json,snapshot_json,receipt_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(operationId, owner, projectId, workspaceId, kind, idempotencyKey, inputJson, requestJson,
        snapshotJson, JSON.stringify(receipt), createdAt, createdAt);
    return this._row(owner, operationId);
  }
  _capture({ owner, workspaceId, expectedRevision, idempotencyKey, message, input }) {
    return this.workspaces.withSnapshot({ owner, workspaceId, expectedRevision }, snapshot => {
      const existing = this._existing(owner, idempotencyKey, input);
      if (existing) return existing;
      requireValue(COMMIT.test(snapshot.baseCommit), 'This workspace does not have a full Git base commit.', 'GIT_BASE_REQUIRED');
      const pending = this.db.prepare(`SELECT receipt_json FROM code_git_requests WHERE workspace_id=? AND kind='commit' AND integrated=0`)
        .all(workspaceId).find(row => !TERMINAL.has(JSON.parse(row.receipt_json).status));
      requireValue(!pending, 'An earlier commit is not yet resolved. Inspect its Git operation before committing again.', 'GIT_OPERATION_PENDING');
      const head = this.db.prepare('SELECT * FROM code_git_workspace_heads WHERE workspace_id=?').get(workspaceId);
      const parentEntries = head ? JSON.parse(head.entries_json) : snapshot.baseline;
      const parentCommit = head?.commit_hash || snapshot.baseCommit;
      const parentRevision = head?.revision || sha256(JSON.stringify(snapshot.baseline));
      const entries = [], paths = [...new Set([...Object.keys(parentEntries), ...Object.keys(snapshot.state.entries)])].sort();
      let totalBytes = 0;
      for (const path of paths) {
        const before = parentEntries[path], after = snapshot.state.entries[path];
        if (equal(before, after)) continue;
        if (!after) entries.push({ path, action: 'delete', beforeSha256: before.sha256 });
        else {
          entries.push({ path, action: 'write', beforeSha256: before?.sha256 || null, sha256: after.sha256, mode: after.mode, bytes: after.size });
          totalBytes += after.size;
        }
      }
      requireValue(entries.length > 0, 'The workspace has no changes since its previous commit or original base.', 'NO_CHANGES');
      const stageId = randomUUID(), operationId = randomUUID(), stageRoot = join(this.outboxDirectory, stageId);
      const stage = { version: 1, stageId, owner, workspaceId, projectId: snapshot.projectId, baseCommit: snapshot.baseCommit,
        parentCommit, revision: snapshot.state.revision, parentRevision, entries, totalBytes };
      requireValue(directoryBytes(this.outboxDirectory) + totalBytes + Buffer.byteLength(JSON.stringify(stage)) + 1 <= GIT_LIMITS.outboxBytes,
        'Git source transfer quota reached. Resolve pending Git operations before capturing more commits.', 'LIMIT_EXCEEDED');
      // A private incomplete directory is never named in a broker request. Rename publishes only fsynced data.
      const preparing = join(this.outboxDirectory, `.pending-${stageId}`);
      mkdirSync(preparing, { mode: 0o2750 }); chmodSync(preparing, 0o2750);
      mkdirSync(join(preparing, 'files'), { mode: 0o2750 }); chmodSync(join(preparing, 'files'), 0o2750);
      for (const entry of entries) if (entry.action === 'write') {
        const bytes = readSafe(snapshot.root, entry.path);
        requireValue(bytes.length === entry.bytes && sha256(bytes) === entry.sha256, 'Workspace changed during commit capture.', 'REVISION_CONFLICT');
        durableFile(join(preparing, 'files'), entry.path, bytes);
      }
      durableFile(preparing, 'manifest.json', `${JSON.stringify(stage)}\n`);
      directorySync(preparing); renameSync(preparing, stageRoot); directorySync(this.outboxDirectory);
      return this._prepare({ owner, idempotencyKey, input, projectId: snapshot.projectId, workspaceId, operationId,
        request: { workspaceId, projectId: snapshot.projectId, baseCommit: snapshot.baseCommit, parentCommit,
          revision: snapshot.state.revision, idempotencyKey, message, stageId }, snapshot: snapshot.state });
    });
  }

  async sync({ owner, projectId, idempotencyKey }) {
    const input = { kind: 'sync', projectId };
    const row = this.store.transaction(() => {
      const existing = this._existing(owner, idempotencyKey, input); if (existing) return existing;
      this.workspaces._project(projectId, owner);
      return this._prepare({ owner, idempotencyKey, input, projectId, request: { projectId } });
    });
    return this._submit(row);
  }
  async commit({ owner, workspaceId, expectedRevision, idempotencyKey, message }) {
    ownerValue(owner); keyValue(idempotencyKey);
    requireValue(typeof message === 'string' && message.trim().length > 0 && message.length <= 2000 && !message.includes('\0'),
      'Commit message must be 1–2000 characters without NUL.');
    const input = { kind: 'commit', workspaceId, expectedRevision, message };
    const existing = this._existing(owner, idempotencyKey, input);
    return this._submit(existing || this._capture({ owner, workspaceId, expectedRevision, idempotencyKey, message, input }));
  }
  async push({ owner, commitOperationId, idempotencyKey }) {
    const input = { kind: 'push', commitOperationId };
    const row = this.store.transaction(() => {
      const existing = this._existing(owner, idempotencyKey, input); if (existing) return existing;
      const commit = this._row(owner, commitOperationId), receipt = JSON.parse(commit.receipt_json);
      requireValue(commit.kind === 'commit' && receipt.status === 'completed', 'A completed commit operation is required.', 'COMMIT_NOT_READY');
      return this._prepare({ owner, idempotencyKey, input, projectId: commit.project_id, workspaceId: commit.workspace_id,
        request: { commitOperationId } });
    });
    return this._submit(row);
  }
  async deploy({ owner, pushOperationId, expectedHead, idempotencyKey, preparedDependenciesId }) {
    requireValue(typeof expectedHead === 'string' && COMMIT.test(expectedHead), 'expectedHead must be a full Git commit.');
    requireValue(preparedDependenciesId === undefined || DIGEST.test(preparedDependenciesId), 'preparedDependenciesId must be a SHA-256.');
    const input = { kind: 'deploy', pushOperationId, expectedHead, ...(preparedDependenciesId ? { preparedDependenciesId } : {}) };
    const row = this.store.transaction(() => {
      const existing = this._existing(owner, idempotencyKey, input); if (existing) return existing;
      const push = this._row(owner, pushOperationId), receipt = JSON.parse(push.receipt_json);
      requireValue(push.kind === 'push' && receipt.status === 'completed', 'A completed push operation is required.', 'PUSH_NOT_READY');
      return this._prepare({ owner, idempotencyKey, input, projectId: push.project_id, workspaceId: push.workspace_id,
        request: { pushOperationId, expectedHead, ...(preparedDependenciesId ? { preparedDependenciesId } : {}) } });
    });
    return this._submit(row);
  }
  async deploymentStatus({ owner, projectId }) {
    ownerValue(owner); this.workspaces._project(projectId, owner);
    return this.broker.deploymentStatus({ owner, projectId });
  }
  async projectDeploy({ owner, publicationOperationId, expectedHead, preparedDependenciesId, recoverOperationId, idempotencyKey }) {
    requireValue(expectedHead === null || COMMIT.test(expectedHead), 'expectedHead must be a full Git commit or null for first deployment.');
    requireValue(preparedDependenciesId === undefined || DIGEST.test(preparedDependenciesId), 'Invalid dependency bundle identifier.');
    if (recoverOperationId) idValue(recoverOperationId);
    const input = { kind: 'projectDeploy', publicationOperationId, expectedHead, ...(preparedDependenciesId ? { preparedDependenciesId } : {}), ...(recoverOperationId ? { recoverOperationId } : {}) };
    const row = this.store.transaction(() => {
      const existing = this._existing(owner, idempotencyKey, input); if (existing) return existing;
      const published = this._row(owner, publicationOperationId), receipt = JSON.parse(published.receipt_json);
      requireValue(['push', 'projectPublish'].includes(published.kind) && receipt.status === 'completed', 'A completed project publication is required.', 'PUSH_NOT_READY');
      const { kind: _kind, ...request } = input;
      return this._prepare({ owner, idempotencyKey, input, projectId: published.project_id, workspaceId: published.workspace_id, request });
    });
    return this._submit(row);
  }
  async diagnosis({ owner, projectId, limit }) {
    ownerValue(owner); this.workspaces._project(projectId, owner);
    return this.broker.diagnosis({ owner, projectId, limit });
  }
  async deploymentHistory({ owner, projectId, limit, cursor }) {
    ownerValue(owner); this.workspaces._project(projectId, owner);
    return this.broker.deploymentHistory({ owner, projectId, limit, ...(cursor ? { cursor } : {}) });
  }
  async restart(args) { return this._recovery('restart', args); }
  async rollback(args) { return this._recovery('rollback', args); }
  async _recovery(kind, { owner, projectId, expectedHead, idempotencyKey, deploymentOperationId, recoverOperationId }) {
    ownerValue(owner); keyValue(idempotencyKey); this.workspaces._project(projectId, owner);
    requireValue(COMMIT.test(expectedHead), 'expectedHead must be a full Git commit.');
    if (deploymentOperationId) idValue(deploymentOperationId);
    if (recoverOperationId) idValue(recoverOperationId);
    const request = { projectId, expectedHead, ...(deploymentOperationId ? { deploymentOperationId } : {}), ...(recoverOperationId ? { recoverOperationId } : {}) };
    const input = { kind, ...request };
    const row = this.store.transaction(() => this._existing(owner, idempotencyKey, input) || this._prepare({ owner, idempotencyKey, input, projectId, request }));
    return this._submit(row);
  }
  projectCreate(args) { return this.projects.create(args); }
  projectPublish(args) { return this.projects.publish(args); }

  _observe(row, receipt) {
    requireValue(receipt && receipt.operationId === row.id && receipt.kind === row.kind && receipt.projectId === row.project_id
      && STATUSES.has(receipt.status) && (!row.workspace_id || receipt.workspaceId === row.workspace_id),
    'Publishing service returned an inconsistent operation receipt.', 'BROKER_PROTOCOL_ERROR');
    const observed = this.store.transaction(() => {
      const latest = this._row(row.owner, row.id), previous = JSON.parse(latest.receipt_json);
      if (TERMINAL.has(previous.status)) return previous;
      if (receipt.status === 'completed' && !latest.integrated) {
        if (['projectCreate', 'projectPublish'].includes(row.kind)) this.projects.integrate(row, receipt);
        if (row.kind === 'sync') this._import(row, receipt);
        if (row.kind === 'commit') {
          const result = receipt.result, request = JSON.parse(row.request_json), snapshot = JSON.parse(row.snapshot_json);
          requireValue(result && COMMIT.test(result.commit) && result.parentCommit === request.parentCommit
            && result.revision === snapshot.revision && result.branch === 'main', 'Commit receipt does not match captured source.', 'BROKER_PROTOCOL_ERROR');
          this.db.prepare(`INSERT INTO code_git_workspace_heads (workspace_id,operation_id,commit_hash,revision,entries_json,updated_at)
            VALUES (?,?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET operation_id=excluded.operation_id,
            commit_hash=excluded.commit_hash,revision=excluded.revision,entries_json=excluded.entries_json,updated_at=excluded.updated_at`)
            .run(row.workspace_id, row.id, result.commit, result.revision, JSON.stringify(snapshot.entries), now());
        }
      }
      const value = { ...receipt, createdAt: row.created_at, updatedAt: now() };
      this.db.prepare('UPDATE code_git_requests SET receipt_json=?,integrated=?,updated_at=? WHERE id=?')
        .run(JSON.stringify(value), receipt.status === 'completed' ? 1 : 0, value.updatedAt, row.id);
      return value;
    });
    this._cleanup(this._row(row.owner, row.id));
    return observed;
  }
  _import(row, receipt) {
    const result = receipt.result;
    requireValue(result && result.exportId === row.id && COMMIT.test(result.commit) && DIGEST.test(result.revision)
      && result.branch === 'main', 'Synchronization receipt has invalid export metadata.', 'BROKER_PROTOCOL_ERROR');
    const root = safePath(this.exportDirectory, row.id, { directory: true });
    const exportManifest = JSON.parse(readSafe(root, 'manifest.json', 16 * 1024 * 1024).toString('utf8'));
    const files = safePath(root, 'files', { directory: true }), state = manifest(files);
    requireValue(exportManifest.version === 1 && exportManifest.projectId === row.project_id && exportManifest.commit === result.commit
      && exportManifest.revision === result.revision && state.revision === result.revision && equal(exportManifest.entries, state.entries)
      && Object.values(state.entries).every(entry => entry.kind === 'file'), 'Synchronized source does not match its export receipt.', 'SNAPSHOT_CHANGED');
    const registered = this.db.prepare(`SELECT requests.row_id FROM project_snapshot_overrides AS overrides
      JOIN code_git_requests AS requests ON requests.id=overrides.operation_id WHERE overrides.project_id=?`).get(row.project_id);
    if (!registered || registered.row_id < row.row_id) {
      this.workspaces.registerSnapshot({ projectId: row.project_id, revision: result.commit, snapshotPath: files, operationId: row.id });
    }
  }
  _cleanup(row) {
    if (row.kind !== 'commit' || !TERMINAL.has(JSON.parse(row.receipt_json).status)) return;
    const { stageId } = JSON.parse(row.request_json);
    if (!UUID.test(stageId)) return;
    try {
      const path = safePath(this.outboxDirectory, stageId, { directory: true });
      if (!existsSync(path)) return;
      requireValue(lstatSync(path).isDirectory(), 'Git stage is not a safe directory.', 'UNSAFE_PATH');
      rmSync(path, { recursive: true }); directorySync(this.outboxDirectory);
    } catch { /* The durable result remains final; a later read or restart retries cleanup. */ }
  }
  async _submit(row) {
    const receipt = JSON.parse(row.receipt_json);
    if (TERMINAL.has(receipt.status)) { this._cleanup(row); return receipt; }
    let observed;
    try { observed = await this.broker[row.kind](JSON.parse(row.request_json)); }
    catch (error) {
      if (error.brokerRejected && error.code !== 'IDEMPOTENCY_CONFLICT') {
        return this._observe(row, { operationId: row.id, kind: row.kind, projectId: row.project_id,
          ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}), status: 'failed', phase: 'admission_rejected', result: null,
          error: { code: error.code, message: error.message } });
      }
      if (error.code === 'AUTHORIZATION_REQUIRED') throw error;
      return this._uncertain(row);
    }
    return this._observe(row, observed);
  }
  _uncertain(row) {
    return this.store.transaction(() => {
      const current = JSON.parse(this._row(row.owner, row.id).receipt_json);
      if (TERMINAL.has(current.status)) return current;
      const receipt = { ...current, status: 'uncertain', updatedAt: now(), error: { code: 'BROKER_UNAVAILABLE',
        message: 'The operation outcome could not be confirmed. Inspect this operation; repeat a mutation only with the same arguments and idempotency key.' } };
      this.db.prepare('UPDATE code_git_requests SET receipt_json=?,updated_at=? WHERE id=?').run(JSON.stringify(receipt), receipt.updatedAt, row.id);
      return receipt;
    });
  }
  async get({ owner, operationId }) {
    const row = this._row(owner, operationId), receipt = JSON.parse(row.receipt_json);
    if (TERMINAL.has(receipt.status)) { this._cleanup(row); return receipt; }
    try { return this._observe(row, await this.broker.get({ owner, operationId })); }
    catch (error) {
      if (error instanceof WorkspaceError) throw error;
      return this._uncertain(row);
    }
  }
  async list({ owner, workspaceId, cursor = 0, limit = 20 }) {
    ownerValue(owner);
    requireValue(Number.isSafeInteger(cursor) && cursor >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      'cursor must be non-negative and limit must be 1–100.');
    if (workspaceId) this.workspaces._row(owner, workspaceId, { removed: true });
    const rows = this.db.prepare(`SELECT * FROM code_git_requests WHERE owner=? AND (? IS NULL OR workspace_id=?)
      AND (?=0 OR row_id<?) ORDER BY row_id DESC LIMIT ?`).all(owner, workspaceId || null, workspaceId || null, cursor, cursor, limit + 1);
    return { operations: rows.slice(0, limit).map(row => JSON.parse(row.receipt_json)),
      nextCursor: rows.length > limit ? rows[limit - 1].row_id : null,
      nextStep: 'Use git_operation_status to refresh any nonterminal operation. Cursors are opaque; follow the returned value.' };
  }
}
