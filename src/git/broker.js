import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, renameSync, existsSync, openSync, closeSync, fsyncSync, chmodSync, fchmodSync, readdirSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { z } from 'zod';
import { readSafe, safePath, normalizePath, IGNORED, sha256, LIMITS, WorkspaceError } from '../code/paths.js';
import { GitTransportError } from './git.js';

const id = z.string().uuid(), oid = z.string().regex(/^[a-f0-9]{40}$/), digest = z.string().regex(/^[a-f0-9]{64}$/);
const project = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const base = { operationId: id, idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/) };
export const brokerSchemas = {
  sync: z.object({ ...base, projectId: project }).strict(),
  commit: z.object({ ...base, workspaceId: id, projectId: project, baseCommit: oid, parentCommit: oid,
    revision: digest, stageId: id, message: z.string().min(1).max(2000).refine(x => x.trim() && !x.includes('\0')) }).strict(),
  push: z.object({ ...base, commitOperationId: id }).strict(),
  deploy: z.object({ ...base, pushOperationId: id, expectedHead: oid }).strict(),
  get: z.object({ operationId: id }).strict(),
  list: z.object({ workspaceId: id.optional(), cursor: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20) }).strict(),
  deploymentStatus: z.object({ projectId: project }).strict()
};
export class BrokerError extends Error {
  constructor(code, message) { super(message); this.name = 'BrokerError'; this.code = code; }
}
function check(value, code, message) { if (!value) throw new BrokerError(code, message); }
function visible(path) {
  try { normalizePath(path); return !path.split('/').some(part => IGNORED.has(part)); } catch { return false; }
}
function canonical(entries) { return Object.assign(Object.create(null), Object.fromEntries(Object.keys(entries).sort().map(path => [path, entries[path]]))); }
function syncDirectory(path) { if (process.platform !== 'win32') { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } } }
function save(root, path, bytes, mode = 0o640) {
  const target = safePath(root, path); mkdirSync(dirname(target), { recursive: true, mode: 0o2750 }); safePath(root, path);
  let parent = dirname(target);
  while (parent !== root) { chmodSync(parent, 0o2750); parent = dirname(parent); }
  const fd = openSync(target, 'wx', mode);
  try { fchmodSync(fd, mode); writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(target));
}
const now = () => new Date().toISOString();

/** Trusted source publisher. It never checks out or executes candidate source. */
export class GitBroker {
  constructor({ dataDirectory, outboxDirectory, exportDirectory, git, repositories, deployment }) {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(exportDirectory, { recursive: true, mode: 0o2750 });
    this.db = new DatabaseSync(join(dataDirectory, 'git.sqlite'));
    chmodSync(join(dataDirectory, 'git.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS git_operations (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL,
        kind TEXT NOT NULL, project_id TEXT NOT NULL, workspace_id TEXT, idempotency_key TEXT NOT NULL,
        request_json TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, error_json TEXT,
        phase TEXT NOT NULL DEFAULT 'prepared', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(owner,idempotency_key));
      CREATE INDEX IF NOT EXISTS git_owner ON git_operations(owner,row_id DESC);`);
    for (const suffix of ['-wal', '-shm']) if (existsSync(join(dataDirectory, `git.sqlite${suffix}`))) chmodSync(join(dataDirectory, `git.sqlite${suffix}`), 0o600);
    this.git = git; this.outbox = outboxDirectory; this.exports = exportDirectory;
    this.repositories = new Map(repositories.map(repo => [repo.projectId, repo]));
    this.deployment = deployment; this.pending = null;
  }
  policy(projectId) {
    const repo = this.repositories.get(projectId);
    check(repo, 'PUBLICATION_DISABLED', 'Publication is not enabled for this registered project.');
    check((repo.defaultBranch || 'main') === 'main', 'INVALID_CONFIGURATION', 'This release publishes only to main.');
    return repo;
  }
  row(owner, operationId) {
    const row = this.db.prepare('SELECT * FROM git_operations WHERE owner=? AND id=?').get(owner, operationId);
    check(row, 'NOT_FOUND', 'Git operation not found.'); return row;
  }
  receipt(row) {
    return { operationId: row.id, kind: row.kind, projectId: row.project_id,
      ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}), status: row.status, phase: row.phase,
      result: row.result_json ? JSON.parse(row.result_json) : null,
      ...(row.error_json ? { error: JSON.parse(row.error_json) } : {}), createdAt: row.created_at, updatedAt: row.updated_at };
  }
  get({ owner, operationId }) { return this.receipt(this.row(owner, operationId)); }
  async observe({ owner, operationId }) {
    const row = this.row(owner, operationId);
    if (row.status === 'uncertain' && !this.pending) {
      try {
        if (row.kind === 'push') {
          const result = await this.run_push(row, JSON.parse(row.request_json));
          this.update(row, 'completed', 'completed', result);
        } else if (row.kind === 'deploy') {
          const result = await this.deployment({ action: 'status', operationId: row.id });
          const record = result.operation || result;
          if (record.phase === 'completed') this.update(row, 'completed', 'completed', { ...record, commit: JSON.parse(row.result_json).commit, branch: 'main' });
          else if (record.phase === 'failed') this.update(row, 'failed', 'failed', record, { code: 'DEPLOYMENT_FAILED', message: 'Deployment activation failed; the saved checkout was retained.' });
        }
      } catch { /* Observation failure leaves the durable uncertain receipt unchanged. */ }
    }
    return this.get({ owner, operationId });
  }
  list({ owner, workspaceId, cursor = 0, limit = 20 }) {
    const rows = this.db.prepare(`SELECT * FROM git_operations WHERE owner=? AND (? IS NULL OR workspace_id=?)
      AND (?=0 OR row_id<?) ORDER BY row_id DESC LIMIT ?`).all(owner, workspaceId || null, workspaceId || null, cursor, cursor, limit + 1);
    const hasMore = rows.length > limit, page = rows.slice(0, limit);
    return { operations: page.map(row => this.receipt(row)), hasMore, nextCursor: hasMore ? page.at(-1).row_id : null };
  }
  async deploymentStatus({ projectId }) {
    const repo = this.policy(projectId);
    check(repo.deployment && this.deployment, 'DEPLOYMENT_DISABLED', 'Deployment is not enabled for this project.');
    return this.deployment({ action: 'status' });
  }
  submit(kind, { owner, ...input }) {
    const parsed = brokerSchemas[kind]?.safeParse(input);
    check(parsed?.success && ['sync', 'commit', 'push', 'deploy'].includes(kind), 'INVALID_ARGUMENT', 'Invalid publishing request.');
    const args = parsed.data;
    const encoded = JSON.stringify(args);
    const existing = this.db.prepare('SELECT * FROM git_operations WHERE owner=? AND idempotency_key=?').get(owner, args.idempotencyKey);
    if (existing) {
      check(existing.kind === kind && existing.request_json === encoded, 'IDEMPOTENCY_CONFLICT', 'The key belongs to different publishing inputs.');
      return this.receipt(existing);
    }
    check(!this.db.prepare('SELECT id FROM git_operations WHERE id=?').get(args.operationId), 'IDEMPOTENCY_CONFLICT', 'The operation identifier is already used.');
    let projectId = args.projectId, workspaceId = args.workspaceId;
    if (kind === 'push' || kind === 'deploy') {
      const parent = this.row(owner, args.commitOperationId || args.pushOperationId);
      check(parent.kind === (kind === 'push' ? 'commit' : 'push') && parent.status === 'completed', 'OPERATION_NOT_READY', 'A completed predecessor operation is required.');
      projectId = parent.project_id; workspaceId = parent.workspace_id;
      const pending = this.db.prepare("SELECT id,request_json FROM git_operations WHERE owner=? AND kind=? AND status IN ('queued','running','uncertain')").all(owner, kind)
        .find(row => { const prior = JSON.parse(row.request_json); return (prior.commitOperationId || prior.pushOperationId) === (args.commitOperationId || args.pushOperationId); });
      check(!pending, 'GIT_OPERATION_PENDING', `An earlier ${kind} operation remains unresolved${pending ? `: ${pending.id}` : ''}. Recover it before submitting another attempt.`);
    }
    const repo = this.policy(projectId);
    if (kind === 'deploy') check(repo.deployment && this.deployment, 'DEPLOYMENT_DISABLED', 'Deployment is not enabled for this project.');
    check(this.db.prepare('SELECT COUNT(*) AS n FROM git_operations').get().n < 10000, 'LIMIT_EXCEEDED', 'Publishing receipt quota reached.');
    const stamp = now();
    this.db.prepare(`INSERT INTO git_operations(id,owner,kind,project_id,workspace_id,idempotency_key,request_json,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'queued',?,?)`).run(args.operationId, owner, kind, projectId, workspaceId || null, args.idempotencyKey, encoded, stamp, stamp);
    return this.get({ owner, operationId: args.operationId });
  }
  update(row, status, phase, result = null, error = null) {
    this.db.prepare('UPDATE git_operations SET status=?,phase=?,result_json=?,error_json=?,updated_at=? WHERE id=?')
      .run(status, phase, result ? JSON.stringify(result) : null, error ? JSON.stringify(error) : null, now(), row.id);
  }
  async tick() {
    if (this.pending) return this.pending;
    this.pending = this.runNext().finally(() => { this.pending = null; }); return this.pending;
  }
  async runNext() {
    const row = this.db.prepare("SELECT * FROM git_operations WHERE status IN ('queued','running') ORDER BY row_id LIMIT 1").get();
    if (!row) return;
    const args = JSON.parse(row.request_json);
    this.update(row, 'running', row.phase, row.result_json ? JSON.parse(row.result_json) : null);
    try {
      const result = await this[`run_${row.kind}`](row, args);
      this.update(row, 'completed', 'completed', result);
    } catch (error) {
      const known = error instanceof BrokerError || error instanceof GitTransportError || error instanceof WorkspaceError;
      const latest = this.row(row.owner, row.id);
      const definitePushFailure = row.kind === 'push' && row.phase !== 'push_intent' && error instanceof GitTransportError && (error.pushAttempted !== true || error.code === 'GIT_PUSH_FAILED');
      const uncertain = !error.definiteFailure && !definitePushFailure && (latest.phase === 'push_intent' || latest.phase === 'deploy_intent');
      this.update(row, uncertain ? 'uncertain' : 'failed', latest.phase,
        latest.result_json ? JSON.parse(latest.result_json) : null,
        { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : 'Publishing could not finish. Recover this operation before attempting more work.' });
    }
  }
  async sourceEntries(projectId, commit) {
    const tree = await this.git.readTree(projectId, commit), entries = Object.create(null);
    let total = 0;
    check(tree.length <= LIMITS.files, 'LIMIT_EXCEEDED', 'Repository tree exceeds the source entry limit.');
    for (const item of tree) {
      if (!visible(item.path)) continue;
      check(item.type === 'blob' && ['100644', '100755'].includes(item.mode), 'UNSUPPORTED_SOURCE', 'The repository contains a source symlink or submodule; this workflow requires ordinary files.');
      const bytes = await this.git.readBlob(projectId, item.oid);
      total += bytes.length;
      check(bytes.length <= LIMITS.fileBytes && total <= LIMITS.sourceBytes, 'LIMIT_EXCEEDED', 'Repository source exceeds the supported size.');
      entries[item.path] = { kind: 'file', sha256: sha256(bytes), size: bytes.length, mode: item.mode };
    }
    return { entries: canonical(entries), tree };
  }
  async run_sync(row) {
    let commit = row.result_json ? JSON.parse(row.result_json).commit : null;
    if (!commit) {
      ({ commit } = await this.git.fetch(row.project_id));
      this.update(row, 'running', 'fetched', { commit });
    }
    const { entries, tree } = await this.sourceEntries(row.project_id, commit);
    const revision = sha256(JSON.stringify(entries));
    const target = join(this.exports, row.id);
    if (!existsSync(target)) {
      let retained = 0;
      const usage = directory => { for (const item of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, item.name), stat = lstatSync(path);
        check(!stat.isSymbolicLink(), 'UNSAFE_PATH', 'Export storage contains a linked entry.');
        if (stat.isDirectory()) usage(path); else retained += stat.size;
      } };
      usage(this.exports);
      check(retained + Object.values(entries).reduce((sum, item) => sum + item.size, 0) <= 512 * 1024 * 1024, 'LIMIT_EXCEEDED', 'Immutable export storage is full. An operator must archive unused snapshots.');
      // Incomplete directories are never returned. A new attempt can safely use a new temporary name.
      const pending = join(this.exports, `.pending-${row.id}-${Date.now()}`);
      mkdirSync(pending, { mode: 0o2750 }); chmodSync(pending, 0o2750);
      mkdirSync(join(pending, 'files'), { mode: 0o2750 }); chmodSync(join(pending, 'files'), 0o2750);
      for (const item of tree) if (Object.hasOwn(entries, item.path)) save(join(pending, 'files'), item.path, await this.git.readBlob(row.project_id, item.oid), item.mode === '100755' ? 0o750 : 0o640);
      save(pending, 'manifest.json', JSON.stringify({ version: 1, projectId: row.project_id, commit, revision, entries }));
      syncDirectory(pending); renameSync(pending, target); syncDirectory(this.exports);
    }
    return { exportId: row.id, commit, revision, branch: 'main' };
  }
  async run_commit(row, args) {
    await this.git.fetch(row.project_id);
    const remote = await this.git.remoteHead(row.project_id, 'main');
    check(remote.commit, 'REMOTE_CONFLICT', 'Remote main is missing.');
    const prior = this.db.prepare("SELECT * FROM git_operations WHERE owner=? AND workspace_id=? AND kind='commit' AND status='completed' AND row_id<? ORDER BY row_id DESC LIMIT 1")
      .get(row.owner, row.workspace_id, row.row_id);
    if (prior) check(JSON.parse(prior.result_json).commit === args.parentCommit, 'COMMIT_CONFLICT', 'Workspace parent differs from its most recent committed snapshot.');
    else check(args.parentCommit === args.baseCommit && await this.git.isAncestor(row.project_id, args.baseCommit, remote.commit),
      'GIT_BASE_REQUIRED', 'The workspace base must belong to registered remote main history.');
    check(await this.git.isAncestor(row.project_id, remote.commit, args.parentCommit), 'REMOTE_CONFLICT', 'Remote main advanced beyond this workspace. Sync and reconcile the newer source before publishing.');
    const root = safePath(this.outbox, args.stageId), stage = JSON.parse(readSafe(root, 'manifest.json', 16 * 1024 * 1024));
    check(stage.version === 1 && stage.stageId === args.stageId && stage.owner === row.owner && stage.workspaceId === row.workspace_id
      && stage.projectId === row.project_id && stage.baseCommit === args.baseCommit && stage.parentCommit === args.parentCommit
      && stage.revision === args.revision && Array.isArray(stage.entries) && stage.entries.length > 0 && stage.entries.length <= LIMITS.files,
    'STAGE_MISMATCH', 'Staged source does not match the requested commit.');
    const { entries } = await this.sourceEntries(row.project_id, args.parentCommit);
    check(stage.parentRevision === sha256(JSON.stringify(entries)), 'STAGE_MISMATCH', 'Staged parent manifest does not match the Git parent.');
    const changed = new Set(), changes = []; let total = 0;
    for (const item of stage.entries) {
      check(visible(item.path) && !changed.has(item.path), 'PATH_REJECTED', 'Staged changes include a protected or duplicate path.'); changed.add(item.path);
      const before = Object.hasOwn(entries, item.path) ? entries[item.path] : null;
      check(item.beforeSha256 === (before?.sha256 || null), 'HASH_CONFLICT', 'Staged file precondition differs from the Git parent.');
      if (item.action === 'delete') {
        check(before, 'HASH_CONFLICT', 'Deleted source must exist in the parent.'); delete entries[item.path]; changes.push({ path: item.path, delete: true });
      } else {
        check(item.action === 'write' && ['100644', '100755'].includes(item.mode), 'STAGE_MISMATCH', 'Unsupported source change.');
        const bytes = readSafe(join(root, 'files'), item.path);
        check(bytes.length === item.bytes && sha256(bytes) === item.sha256, 'STAGE_MISMATCH', 'Staged source bytes do not match their digest.');
        total += bytes.length; check(total <= LIMITS.sourceBytes, 'LIMIT_EXCEEDED', 'Staged source exceeds the transfer limit.');
        entries[item.path] = { kind: 'file', sha256: item.sha256, size: item.bytes, mode: item.mode };
        changes.push({ path: item.path, content: bytes, mode: item.mode });
      }
    }
    check(Object.keys(entries).length <= LIMITS.files && Object.values(entries).reduce((sum, entry) => sum + entry.size, 0) <= LIMITS.sourceBytes, 'LIMIT_EXCEEDED', 'Resulting source exceeds the workspace limit.');
    check(total === stage.totalBytes && sha256(JSON.stringify(canonical(entries))) === args.revision, 'STAGE_MISMATCH', 'Resulting source manifest differs from the captured revision.');
    const result = await this.git.createCommit(row.project_id, { parent: args.parentCommit, changes, message: args.message, timestamp: row.created_at });
    return { commit: result.commit, parentCommit: args.parentCommit, revision: args.revision, branch: 'main', expectedRemoteHead: remote.commit };
  }
  async run_push(row, args) {
    const parent = this.row(row.owner, args.commitOperationId), result = JSON.parse(parent.result_json);
    if (row.phase === 'push_intent') {
      const current = await this.git.remoteHead(row.project_id, 'main');
      if (current.commit === result.commit) return { ...result, publishedCommit: result.commit, observedRemoteHead: current.commit, reconciled: true };
      if (current.commit) {
        await this.git.fetch(row.project_id);
        if (await this.git.isAncestor(row.project_id, result.commit, current.commit)) return { ...result, publishedCommit: result.commit, observedRemoteHead: current.commit, reconciled: true };
      }
      throw new BrokerError('PUSH_UNCERTAIN', 'A push was attempted, but publication cannot be established. It will not be repeated automatically.');
    }
    const current = await this.git.remoteHead(row.project_id, 'main');
    check(current.commit === result.expectedRemoteHead, 'REMOTE_CONFLICT', 'Remote main changed after commit preparation. No push was attempted.');
    this.update(row, 'running', 'push_intent', { commit: result.commit, expectedRemoteHead: result.expectedRemoteHead });
    const published = await this.git.push(row.project_id, { commit: result.commit, expectedHead: result.expectedRemoteHead, branch: 'main' });
    return { ...result, publishedCommit: result.commit, observedRemoteHead: published.remoteHead, alreadyPublished: published.alreadyPublished };
  }
  async run_deploy(row, args) {
    const push = JSON.parse(this.row(row.owner, args.pushOperationId).result_json);
    this.update(row, 'running', 'deploy_intent', { commit: push.commit, expectedHead: args.expectedHead });
    let result;
    try { result = await this.deployment({ action: 'apply', operationId: row.id, expectedHead: args.expectedHead, targetCommit: push.commit }); }
    catch (error) {
      if (error.admissionRejected && row.phase !== 'deploy_intent') error.definiteFailure = true;
      throw error;
    }
    if (result.phase !== 'completed') {
      this.update(row, 'running', 'deploy_intent', { ...result, commit: push.commit, expectedHead: args.expectedHead });
      const error = new BrokerError(result.phase === 'uncertain' ? 'DEPLOYMENT_UNCERTAIN' : 'DEPLOYMENT_FAILED', 'Deployment did not establish successful process activation. Read its persisted status.');
      error.definiteFailure = result.phase === 'failed'; throw error;
    }
    return { ...result, commit: push.commit, branch: 'main' };
  }
  async close() { await this.pending; this.db.close(); }
}

export function fixedDeploymentClient({ executable = '/usr/local/libexec/praxis-deploy-discord', sudoPath = '/usr/bin/sudo' } = {}) {
  return input => new Promise((resolve, reject) => {
    const child = execFile(sudoPath, ['-n', executable], { encoding: 'utf8', maxBuffer: 128 * 1024,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' } }, (error, stdout) => {
      let response; try { response = JSON.parse(stdout); } catch { return reject(new BrokerError('DEPLOYMENT_UNCERTAIN', 'The deployment helper did not return a readable receipt.')); }
      if (!response.ok || error) {
        const failure = new BrokerError(typeof response.code === 'string' ? response.code : 'DEPLOYMENT_FAILED', typeof response.message === 'string' ? response.message : 'Deployment helper failed.');
        failure.admissionRejected = response.ok === false && ['DEPLOYMENT_BUSY', 'RETENTION_LIMIT', 'FORBIDDEN', 'INVALID_ARGUMENT'].includes(response.code);
        return reject(failure);
      }
      resolve(response.data);
    });
    child.stdin.end(JSON.stringify(input));
  });
}
