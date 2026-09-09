import { mkdirSync, existsSync, lstatSync, writeFileSync, readFileSync, renameSync, unlinkSync,
  chmodSync, openSync, closeSync, fsyncSync, readSync, rmSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { structuredPatch, formatPatch } from 'diff';
import { WorkspaceError, requireValue, sha256, LIMITS, IGNORED, normalizePath, safePath, readSafe, manifest } from './paths.js';

export { WorkspaceError, LIMITS } from './paths.js';
const ACTIVE = "('queued','starting','running','canceling')";
const ownerCheck = owner => requireValue(typeof owner === 'string' && owner.length > 0 && owner.length <= 100, 'A valid owner is required.');
const now = () => new Date().toISOString();
const publicWorkspace = row => ({ workspaceId: row.id, projectId: row.project_id, label: row.label,
  baseRevision: row.base_revision, revision: row.revision, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const parseEntries = json => Object.assign(Object.create(null), JSON.parse(json));
const textOf = buffer => {
  requireValue(!buffer.includes(0), 'Binary files cannot be read as text.', 'BINARY_FILE');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
  catch { throw new WorkspaceError('BINARY_FILE', 'This file is not valid UTF-8 text.'); }
};
function page(cursor, limit, maximum) {
  requireValue(Number.isSafeInteger(cursor) && cursor >= 0, 'cursor must be a non-negative integer.');
  requireValue(Number.isSafeInteger(limit) && limit > 0 && limit <= maximum, `limit must be 1–${maximum}.`);
}
function keyCheck(key) { requireValue(typeof key === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(key), 'idempotencyKey must be 8–128 simple identifier characters.'); }
function syncDirectory(path) {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function writeDurable(root, path, content, mode) {
  const target = safePath(root, path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  safePath(root, path);
  const temp = join(dirname(target), `.praxis-tmp-${randomUUID()}`);
  const fd = openSync(temp, 'wx', mode === '100755' ? 0o755 : 0o644);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, target);
  chmodSync(target, mode === '100755' ? 0o755 : 0o644);
  syncDirectory(dirname(target));
}

export class WorkspaceManager {
  constructor({ store, dataDirectory, workspaceDirectory, projects = [] }) {
    this.store = store;
    this.db = store.db;
    this.dataDirectory = resolve(dataDirectory);
    this.workspaceDirectory = resolve(workspaceDirectory);
    const privateRelative = relative(this.workspaceDirectory, this.dataDirectory);
    requireValue(privateRelative && (isAbsolute(privateRelative) || privateRelative === '..' || privateRelative.startsWith(`..${sep}`)), 'Private state must be outside workspaces.');
    mkdirSync(this.workspaceDirectory, { recursive: true, mode: 0o700 });
    this.projects = new Map(projects.map(project => {
      requireValue(typeof project.id === 'string' && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(project.id), 'Invalid registered project ID.');
      requireValue(typeof project.revision === 'string' && project.revision.length > 0, 'A pinned project revision is required.');
      return [project.id, { ...project, snapshotPath: resolve(project.snapshotPath) }];
    }));
    requireValue(this.projects.size === projects.length, 'Registered project IDs must be unique.');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL,
        project_id TEXT NOT NULL, label TEXT NOT NULL, base_revision TEXT NOT NULL, revision TEXT NOT NULL,
        status TEXT NOT NULL, path TEXT NOT NULL, snapshot_path TEXT NOT NULL, baseline_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workspace_owner ON workspaces(owner, row_id DESC);
      CREATE TABLE IF NOT EXISTS operations (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL,
        workspace_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, kind TEXT NOT NULL,
        request_json TEXT NOT NULL, plan_json TEXT NOT NULL, status TEXT NOT NULL,
        result_json TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(owner, idempotency_key));
      CREATE INDEX IF NOT EXISTS operations_owner ON operations(owner, row_id DESC);`);
    this.recover();
  }

  _project(projectId) {
    const project = this.projects.get(projectId);
    requireValue(project, 'Project not found.', 'NOT_FOUND');
    return project;
  }
  _publicProject(project) {
    return { projectId: project.id, name: project.name, repository: project.repository, revision: project.revision,
      validationCommands: project.validationCommands || [], instructions: project.instructions || '',
      exclusions: [...IGNORED, '.git', '.env*', 'credential/key files'], limits: LIMITS };
  }
  _row(owner, workspaceId, { removed = false } = {}) {
    ownerCheck(owner);
    const row = this.db.prepare('SELECT * FROM workspaces WHERE owner = ? AND id = ?').get(owner, workspaceId);
    requireValue(row && (removed || row.status !== 'removed'), 'Workspace not found.', 'NOT_FOUND');
    requireValue(row.path === join(this.workspaceDirectory, row.id), 'Stored workspace path is invalid.', 'UNSAFE_PATH');
    return row;
  }
  _idle(row) {
    const active = this.db.prepare(`SELECT id FROM code_jobs WHERE workspace_id = ? AND status IN ${ACTIVE} LIMIT 1`).get(row.id);
    requireValue(!active, 'Workspace has an active command. Wait or cancel it before accessing source.', 'WORKSPACE_BUSY');
  }
  _ready(row) { requireValue(row.status === 'ready', 'Workspace has an unfinished filesystem operation; inspect its receipt.', 'WORKSPACE_RECOVERING'); }
  _refresh(row) {
    const current = manifest(row.path);
    if (current.revision !== row.revision) {
      this.db.prepare('UPDATE workspaces SET revision = ?, updated_at = ? WHERE id = ?').run(current.revision, now(), row.id);
      row.revision = current.revision;
    }
    return current;
  }
  _source({ owner, projectId, workspaceId }) {
    ownerCheck(owner);
    requireValue(Boolean(projectId) !== Boolean(workspaceId), 'Specify exactly one of projectId or workspaceId.');
    if (projectId) {
      const project = this._project(projectId);
      return { root: project.snapshotPath, revision: project.revision, state: manifest(project.snapshotPath) };
    }
    const row = this._row(owner, workspaceId);
    this._ready(row); this._idle(row);
    return { root: row.path, state: this._refresh(row), revision: row.revision };
  }
  _operation(row) {
    return { operationId: row.id, workspaceId: row.workspace_id, kind: row.kind, status: row.status,
      createdAt: row.created_at, updatedAt: row.updated_at, result: row.result_json ? JSON.parse(row.result_json) : null,
      ...(row.last_error ? { error: row.last_error } : {}) };
  }
  _existing(owner, key, request) {
    keyCheck(key);
    const row = this.db.prepare('SELECT * FROM operations WHERE owner = ? AND idempotency_key = ?').get(owner, key);
    if (!row) return null;
    requireValue(row.request_json === JSON.stringify(request), 'This idempotency key was used for different arguments.', 'IDEMPOTENCY_CONFLICT');
    return this._operation(row);
  }
  _prepare({ owner, workspaceId, idempotencyKey, kind, request, plan }) {
    requireValue(this.db.prepare('SELECT COUNT(*) AS count FROM operations').get().count < LIMITS.operations, 'Operation receipt quota reached.', 'LIMIT_EXCEEDED');
    const requestJson = JSON.stringify(request), planJson = JSON.stringify(plan);
    const journalBytes = this.db.prepare('SELECT COALESCE(SUM(length(CAST(request_json AS BLOB)) + length(CAST(plan_json AS BLOB))), 0) AS bytes FROM operations').get().bytes;
    requireValue(journalBytes + Buffer.byteLength(requestJson) + Buffer.byteLength(planJson) <= LIMITS.operationJournalBytes,
      'Operation journal storage quota reached; owner maintenance is required.', 'LIMIT_EXCEEDED');
    const id = randomUUID(), timestamp = now();
    this.db.prepare(`INSERT INTO operations (id,owner,workspace_id,idempotency_key,kind,request_json,plan_json,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'prepared',?,?)`).run(id, owner, workspaceId, idempotencyKey, kind, requestJson, planJson, timestamp, timestamp);
    this.db.prepare("UPDATE workspaces SET status = 'recovering', updated_at = ? WHERE id = ?").run(timestamp, workspaceId);
    return id;
  }
  _finish(operation, result, status = 'ready') {
    this.store.transaction(() => {
      this.db.prepare('UPDATE workspaces SET status = ?, revision = ?, updated_at = ? WHERE id = ?').run(status, result.revision, now(), operation.workspace_id);
      this.db.prepare("UPDATE operations SET status = 'completed', result_json = ?, last_error = NULL, updated_at = ? WHERE id = ?").run(JSON.stringify(result), now(), operation.id);
    });
    return this.operationRead({ owner: operation.owner, operationId: operation.id });
  }
  _execute(operationId) {
    const operation = this.db.prepare('SELECT * FROM operations WHERE id = ?').get(operationId);
    const row = this._row(operation.owner, operation.workspace_id, { removed: true });
    const plan = JSON.parse(operation.plan_json);
    try {
      // Keep source readers and job starts excluded throughout journal replay.
      return this.store.transaction(() => {
        this._idle(row);
        if (operation.kind === 'create') {
          mkdirSync(row.path, { recursive: true, mode: 0o700 });
          const baseline = parseEntries(row.baseline_json);
          for (const [path, entry] of Object.entries(baseline)) {
            requireValue(entry.kind === 'file', 'Source snapshot contains an unsafe entry.', 'UNSAFE_PATH');
            const source = readSafe(row.snapshot_path, path);
            requireValue(sha256(source) === entry.sha256, 'Registered source snapshot changed during workspace creation.', 'SNAPSHOT_CHANGED');
            writeDurable(row.path, path, source, entry.mode);
          }
          const state = manifest(row.path);
          return this._finish(operation, { ...publicWorkspace(row), status: 'ready', revision: state.revision });
        }
        if (operation.kind === 'remove') {
          const trash = join(this.workspaceDirectory, `.removed-${row.id}`);
          if (existsSync(row.path)) {
            safePath(row.path, '', { directory: true });
            renameSync(row.path, trash);
            syncDirectory(this.workspaceDirectory);
          }
          if (existsSync(trash)) {
            requireValue(lstatSync(trash).isDirectory() && !lstatSync(trash).isSymbolicLink(), 'Removal journal path is unsafe.', 'UNSAFE_PATH');
            rmSync(trash, { recursive: true });
            syncDirectory(this.workspaceDirectory);
          }
          return this._finish(operation, { workspaceId: row.id, revision: row.revision, removed: true }, 'removed');
        }
        for (const change of plan.files) {
          const target = safePath(row.path, change.path);
          const current = existsSync(target) ? sha256(readSafe(row.path, change.path)) : null;
          const after = change.content === null ? null : sha256(Buffer.from(change.content, 'base64'));
          requireValue(current === change.before || current === after, 'File changed outside its prepared operation; recovery stopped.', 'RECOVERY_CONFLICT');
          if (change.content === null) {
            if (current !== null) { unlinkSync(target); syncDirectory(dirname(target)); }
          } else writeDurable(row.path, change.path, Buffer.from(change.content, 'base64'), change.mode);
        }
        const state = manifest(row.path);
        return this._finish(operation, { workspaceId: row.id, revision: state.revision, changedPaths: plan.files.map(file => file.path) });
      });
    } catch (error) {
      this.db.prepare('UPDATE operations SET last_error = ?, updated_at = ? WHERE id = ?').run(error.code || 'FILESYSTEM_ERROR', now(), operationId);
      throw error;
    }
  }
  recover() {
    for (const operation of this.db.prepare("SELECT id FROM operations WHERE status = 'prepared' ORDER BY row_id").all()) {
      try { this._execute(operation.id); } catch { /* Receipt stays prepared; never declare partial effects complete. */ }
    }
  }

  projectsList({ owner }) { ownerCheck(owner); return { projects: [...this.projects.values()].map(project => this._publicProject(project)) }; }
  projectInspect({ owner, projectId }) {
    ownerCheck(owner); const project = this._project(projectId), state = manifest(project.snapshotPath);
    return { ...this._publicProject(project), sourceDigest: state.revision, fileCount: Object.keys(state.entries).length, bytes: state.bytes };
  }
  create({ owner, projectId, baseRevision, idempotencyKey, label = '' }) {
    ownerCheck(owner); requireValue(typeof label === 'string' && label.length <= 100, 'label must be at most 100 characters.');
    const request = { kind: 'create', projectId, baseRevision, label };
    const prepared = this.store.transaction(() => {
      const existing = this._existing(owner, idempotencyKey, request); if (existing) return existing;
      const project = this._project(projectId);
      requireValue(baseRevision === project.revision, 'baseRevision must match the registered project revision.', 'REVISION_CONFLICT');
      requireValue(this.db.prepare("SELECT COUNT(*) AS count FROM workspaces WHERE status != 'removed'").get().count < LIMITS.workspaces, 'Workspace quota reached.', 'LIMIT_EXCEEDED');
      const state = manifest(project.snapshotPath);
      requireValue(Object.values(state.entries).every(entry => entry.kind === 'file'), 'Source snapshot contains unsafe entries.', 'UNSAFE_PATH');
      const id = randomUUID(), timestamp = now();
      this.db.prepare(`INSERT INTO workspaces (id,owner,project_id,label,base_revision,revision,status,path,snapshot_path,baseline_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'recovering',?,?,?,?,?)`).run(id, owner, projectId, label || project.name || projectId, project.revision, state.revision,
        join(this.workspaceDirectory, id), project.snapshotPath, JSON.stringify(state.entries), timestamp, timestamp);
      return this._prepare({ owner, workspaceId: id, idempotencyKey, kind: 'create', request, plan: {} });
    });
    return typeof prepared === 'string' ? this._execute(prepared) : prepared;
  }
  list({ owner, cursor = 0, limit = 20 }) {
    ownerCheck(owner); page(cursor, limit, 100);
    const rows = this.db.prepare("SELECT * FROM workspaces WHERE owner = ? AND status != 'removed' AND (? = 0 OR row_id < ?) ORDER BY row_id DESC LIMIT ?").all(owner, cursor, cursor, limit + 1);
    const selected = rows.slice(0, limit);
    return { workspaces: selected.map(publicWorkspace), nextCursor: rows.length > limit ? selected.at(-1).row_id : null };
  }
  inspect({ owner, workspaceId }) {
    return this.store.transaction(() => {
      const row = this._row(owner, workspaceId); this._ready(row); this._idle(row);
      const state = this._refresh(row), baseline = parseEntries(row.baseline_json);
      const issues = Object.entries(state.entries).filter(([, entry]) => entry.kind === 'unsafe').map(([path, entry]) => ({ path, issue: entry.issue }));
      const project = this.projects.get(row.project_id);
      return { ...publicWorkspace(row), dirty: !same(state.entries, baseline), fileCount: Object.keys(state.entries).length, bytes: state.bytes,
        issues: issues.slice(0, 100), issuesTruncated: issues.length > 100,
        validationCommands: project?.validationCommands || [], instructions: project?.instructions || '',
        jobs: this.db.prepare('SELECT id, status FROM code_jobs WHERE workspace_id = ? AND owner = ? ORDER BY rowid DESC LIMIT 20').all(workspaceId, owner),
        exclusions: [...IGNORED, '.git', '.env*', 'credential/key files'], limits: LIMITS };
    });
  }
  filesList({ path = '', cursor = 0, limit = 100, ...source }) {
    page(cursor, limit, 200); normalizePath(path, { directory: true });
    return this.store.transaction(() => {
      const { state, revision } = this._source(source);
      const matches = Object.entries(state.entries).filter(([name]) => !path || name === path || name.startsWith(`${path}/`));
      return { revision, files: matches.slice(cursor, cursor + limit).map(([name, entry]) => ({ path: name, ...entry })),
        nextCursor: cursor + limit < matches.length ? cursor + limit : null };
    });
  }
  read({ path, startLine = 1, startColumn = 1, lineCount = 100, ...source }) {
    requireValue(Number.isSafeInteger(startLine) && startLine >= 1 && Number.isSafeInteger(startColumn) && startColumn >= 1
      && Number.isSafeInteger(lineCount) && lineCount >= 1 && lineCount <= 200, 'startLine/startColumn must be positive and lineCount 1–200.');
    return this.store.transaction(() => {
      const { root, revision } = this._source(source), content = readSafe(root, path), lines = textOf(content).split('\n');
      const selected = []; let characters = 0, nextPosition = null;
      for (let index = startLine - 1; index < Math.min(lines.length, startLine - 1 + lineCount); index++) {
        const column = index === startLine - 1 ? startColumn : 1;
        const line = lines[index].slice(column - 1); let available = LIMITS.readCharacters - characters;
        if (line.length > available) {
          if (available > 0 && /[\uD800-\uDBFF]/.test(line[available - 1])) available--;
          if (available > 0) selected.push({ number: index + 1, column, text: line.slice(0, available), truncated: true });
          nextPosition = { line: index + 1, column: column + available };
          break;
        }
        selected.push({ number: index + 1, ...(column > 1 ? { column } : {}), text: line }); characters += line.length;
        nextPosition = index + 1 < lines.length ? { line: index + 2, column: 1 } : null;
      }
      return { path, revision, sha256: sha256(content), startLine, startColumn, lines: selected,
        nextPosition, nextLine: nextPosition?.line ?? null, columnUnit: 'utf16_code_units', totalLines: lines.length };
    });
  }
  search({ query, path = '', caseSensitive = true, cursor = 0, limit = 50, ...source }) {
    requireValue(typeof query === 'string' && query.length >= 1 && query.length <= 1000 && !query.includes('\n'), 'query must be 1–1000 characters and a single line.');
    requireValue(typeof caseSensitive === 'boolean', 'caseSensitive must be boolean.');
    page(cursor, limit, 100); normalizePath(path, { directory: true });
    return this.store.transaction(() => {
      const { root, revision, state } = this._source(source), matches = [];
      let seen = 0, hasMore = false;
      outer: for (const [name, entry] of Object.entries(state.entries)) {
        if (entry.kind !== 'file' || (path && name !== path && !name.startsWith(`${path}/`))) continue;
        const bytes = readSafe(root, name); let text;
        try { text = textOf(bytes); } catch { continue; }
        const lines = text.split('\n');
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index], haystack = caseSensitive ? line : line.toLowerCase();
          const column = haystack.indexOf(caseSensitive ? query : query.toLowerCase());
          if (column < 0 || seen++ < cursor) continue;
          if (matches.length === limit) { hasMore = true; break outer; }
          const start = Math.max(0, column - 120);
          matches.push({ path: name, line: index + 1, column: column + 1, text: line.slice(start, start + 500), truncated: line.length > 500 });
        }
      }
      return { revision, literal: true, matches, nextCursor: hasMore ? cursor + matches.length : null };
    });
  }

  apply({ owner, workspaceId, expectedRevision, idempotencyKey, changes }) {
    ownerCheck(owner);
    requireValue(Array.isArray(changes) && changes.length > 0 && changes.length <= LIMITS.changes, `changes must contain 1–${LIMITS.changes} operations.`);
    requireValue(Buffer.byteLength(JSON.stringify(changes)) <= LIMITS.applyBytes, 'Edit batch exceeds the byte limit.', 'LIMIT_EXCEEDED');
    const request = { kind: 'apply', workspaceId, expectedRevision, changes };
    const prepared = this.store.transaction(() => {
      const existing = this._existing(owner, idempotencyKey, request); if (existing) return existing;
      const row = this._row(owner, workspaceId); this._ready(row); this._idle(row);
      const state = this._refresh(row);
      requireValue(expectedRevision === row.revision, 'Workspace revision changed; inspect it before editing.', 'REVISION_CONFLICT');
      const files = [], touched = new Set();
      const touch = path => {
        normalizePath(path);
        requireValue(!path.split('/').some(part => IGNORED.has(part)), 'Filesystem edits cannot target excluded dependency/cache paths.', 'PATH_REJECTED');
        requireValue(!touched.has(path), 'Each path may be changed only once per batch.'); touched.add(path);
        const target = safePath(row.path, path);
        requireValue(!existsSync(target) || lstatSync(target).isFile(), 'Edit targets must be files, not directories.', 'PATH_REJECTED');
      };
      for (const change of changes) {
        requireValue(change && ['write', 'patch', 'rename', 'delete'].includes(change.action), 'Unsupported edit action.');
        touch(change.path);
        const before = state.entries[change.path];
        requireValue(!before || before.kind === 'file', 'Unsafe entries must be removed by a sandbox command.', 'UNSAFE_PATH');
        requireValue(change.expectedSha256 === (before?.sha256 ?? null), 'File hash changed or file existence precondition failed.', 'HASH_CONFLICT');
        requireValue(before || change.action === 'write', 'This operation requires an existing file.', 'NOT_FOUND');
        requireValue(change.executable === undefined || typeof change.executable === 'boolean', 'executable must be boolean.');
        const mode = change.executable === undefined ? before?.mode || '100644' : change.executable ? '100755' : '100644';
        if (change.action === 'delete') files.push({ path: change.path, before: before.sha256, content: null, mode });
        if (change.action === 'rename') {
          touch(change.to);
          requireValue(!state.entries[change.to] && !existsSync(safePath(row.path, change.to)), 'Rename destination already exists.', 'HASH_CONFLICT');
          files.push({ path: change.to, before: null, content: readSafe(row.path, change.path).toString('base64'), mode });
          files.push({ path: change.path, before: before.sha256, content: null, mode });
        }
        if (change.action === 'write' || change.action === 'patch') {
          let content = change.content;
          if (change.action === 'patch') {
            requireValue(typeof change.oldText === 'string' && change.oldText.length > 0 && typeof change.newText === 'string', 'patch requires nonempty oldText and string newText.');
            const old = textOf(readSafe(row.path, change.path)), position = old.indexOf(change.oldText);
            requireValue(position >= 0 && old.indexOf(change.oldText, position + 1) < 0, 'oldText must match exactly once.', 'PATCH_CONFLICT');
            content = old.slice(0, position) + change.newText + old.slice(position + change.oldText.length);
          }
          requireValue(typeof content === 'string' && content.length <= LIMITS.writeCharacters && Buffer.byteLength(content) <= LIMITS.fileBytes, 'File content must be text within the write limit.');
          files.push({ path: change.path, before: before?.sha256 ?? null, content: Buffer.from(content).toString('base64'), mode });
        }
      }
      for (const path of touched) for (const other of touched) requireValue(path === other || !path.startsWith(`${other}/`), 'Batch paths cannot be parents of each other.');
      let resultingBytes = state.bytes, resultingEntries = state.entryCount;
      const newDirectories = new Set();
      for (const file of files) {
        const before = state.entries[file.path];
        resultingBytes -= before?.size || 0;
        if (file.content === null) resultingEntries--;
        else {
          resultingBytes += Buffer.from(file.content, 'base64').length;
          if (!before) resultingEntries++;
          const parts = file.path.split('/'); parts.pop();
          for (let index = 1; index <= parts.length; index++) {
            const path = parts.slice(0, index).join('/');
            if (!existsSync(safePath(row.path, path))) newDirectories.add(path);
          }
        }
      }
      requireValue(resultingBytes <= LIMITS.sourceBytes && resultingEntries + newDirectories.size <= LIMITS.files,
        'The edit would exceed workspace source limits.', 'LIMIT_EXCEEDED');
      return this._prepare({ owner, workspaceId, idempotencyKey, kind: 'apply', request, plan: { files } });
    });
    return typeof prepared === 'string' ? this._execute(prepared) : prepared;
  }

  diff({ owner, workspaceId, expectedRevision, cursor = 0, limit = 16384 }) {
    page(cursor, limit, 32768);
    return this.store.transaction(() => {
      const row = this._row(owner, workspaceId); this._ready(row); this._idle(row);
      const state = this._refresh(row), baseline = parseEntries(row.baseline_json);
      if (expectedRevision !== undefined) requireValue(expectedRevision === row.revision, 'Workspace changed between diff pages.', 'REVISION_CONFLICT');
      const paths = [...new Set([...Object.keys(baseline), ...Object.keys(state.entries)])].sort(), changes = [];
      for (const path of paths) {
        const before = baseline[path], after = state.entries[path]; if (same(before, after)) continue;
        const kind = !before ? 'added' : !after ? 'deleted' : 'modified';
        changes.push({ path, kind, before: before || null, after: after || null });
      }
      const cache = this._diffCache(row, changes);
      const fd = openSync(cache.path, 'r'); let output = '', length = 0;
      try {
        requireValue(cursor <= cache.bytes, 'Diff cursor is beyond the end of the result.');
        const bytes = Buffer.alloc(Math.min(limit + 4, cache.bytes - cursor));
        const read = readSync(fd, bytes, 0, bytes.length, cursor);
        // Cursors are byte offsets; never split a Unicode character between pages.
        let end = Math.min(limit, read);
        while (end > 0) {
          try { output = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)); length = end; break; }
          catch { end--; }
        }
        if (read > 0 && length === 0) {
          for (let end = 1; end <= Math.min(4, read); end++) {
            try { output = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)); length = end; break; } catch { /* incomplete code point */ }
          }
          requireValue(length > 0, 'Diff cursor must point to a UTF-8 character boundary.');
        }
      } finally { closeSync(fd); }
      const end = cursor + length;
      return { workspaceId, revision: row.revision, dirty: changes.length > 0, changedFileCount: changes.length,
        diff: output, nextCursor: end < cache.bytes ? end : null, cursorUnit: 'utf8_bytes', totalBytes: cache.bytes,
        totalCharacters: cache.characters, fullReplacementFallbacks: cache.fallbacks,
        ...(cursor === 0 ? { changes: changes.slice(0, 100), changesTruncated: changes.length > 100 } : {}) };
    });
  }
  _diffCache(row, changes) {
    const directory = join(this.dataDirectory, 'diff-cache');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'current.patch'), metadataPath = join(directory, 'current.json');
    let existing;
    try { existing = JSON.parse(readFileSync(metadataPath, 'utf8')); } catch { /* cache miss */ }
    if (existing?.workspaceId === row.id && existing.revision === row.revision && existsSync(path)) return { ...existing, path };
    // Only one cached diff is retained, so historical edits cannot grow cache usage.
    if (existsSync(path)) unlinkSync(path);
    const temp = join(directory, 'pending.patch');
    const fd = openSync(temp, 'w', 0o600);
    let bytes = 0, characters = 0, fallbacks = 0;
    const deadline = Date.now() + 5000;
    try {
      for (const change of changes) {
        const { path: name, before, after } = change;
        let patch = { oldFileName: before ? `a/${name}` : '/dev/null', newFileName: after ? `b/${name}` : '/dev/null', hunks: [],
          isGit: true, isCreate: !before, isDelete: !after,
          ...(!before ? { newMode: after.mode } : !after ? { oldMode: before.mode } : before.mode !== after.mode ? { oldMode: before.mode, newMode: after.mode } : {}) };
        let note = '';
        if (before?.kind === 'unsafe' || after?.kind === 'unsafe') note = 'Unsafe filesystem entry; contents were not followed.\n';
        else {
          const oldBytes = before ? readSafe(row.snapshot_path, name) : Buffer.alloc(0), newBytes = after ? readSafe(row.path, name) : Buffer.alloc(0);
          if (before) requireValue(sha256(oldBytes) === before.sha256, 'Protected baseline changed.', 'SNAPSHOT_CHANGED');
          let oldText, newText;
          try { oldText = textOf(oldBytes); newText = textOf(newBytes); } catch { note = 'Binary files differ.\n'; }
          if (!note && before?.sha256 !== after?.sha256) {
            const calculated = structuredPatch(patch.oldFileName, patch.newFileName, oldText, newText, undefined, undefined,
              { context: 3, timeout: Math.max(0, Math.min(250, deadline - Date.now())), maxEditLength: 10000 });
            if (calculated) patch = { ...calculated, ...patch, hunks: calculated.hunks };
            else {
              fallbacks++;
              const oldLines = oldText ? oldText.replace(/\n$/, '').split('\n') : [], newLines = newText ? newText.replace(/\n$/, '').split('\n') : [];
              const lines = oldLines.map(line => `-${line}`);
              if (oldLines.length && !oldText.endsWith('\n')) lines.push('\\ No newline at end of file');
              for (const line of newLines) lines.push(`+${line}`);
              if (newLines.length && !newText.endsWith('\n')) lines.push('\\ No newline at end of file');
              patch.hunks = [{ oldStart: 1, oldLines: oldLines.length, newStart: 1, newLines: newLines.length, lines }];
            }
          }
        }
        const text = formatPatch(patch) + note;
        bytes += Buffer.byteLength(text); characters += text.length;
        requireValue(bytes <= LIMITS.diffCacheBytes, 'Diff exceeds the private cache limit; inspect changed files individually.', 'LIMIT_EXCEEDED');
        writeFileSync(fd, text);
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temp, path);
    const metadata = { workspaceId: row.id, revision: row.revision, bytes, characters, fallbacks };
    writeDurable(directory, 'current.json', JSON.stringify(metadata), '100644');
    return { ...metadata, path };
  }
  remove({ owner, workspaceId, expectedRevision, preview = true, discard = false, idempotencyKey }) {
    ownerCheck(owner);
    const request = { kind: 'remove', workspaceId, expectedRevision, discard };
    const prepared = this.store.transaction(() => {
      if (!preview) { const existing = this._existing(owner, idempotencyKey, request); if (existing) return existing; }
      const row = this._row(owner, workspaceId); this._ready(row); this._idle(row);
      const state = this._refresh(row), dirty = !same(state.entries, JSON.parse(row.baseline_json));
      requireValue(expectedRevision === row.revision, 'Workspace changed before removal.', 'REVISION_CONFLICT');
      if (preview) return { workspaceId, revision: row.revision, dirty, preview: true, wouldRemove: true };
      requireValue(!dirty || discard === true, 'Workspace has changes; explicit discard is required.', 'DIRTY_WORKSPACE');
      return this._prepare({ owner, workspaceId, idempotencyKey, kind: 'remove', request, plan: {} });
    });
    return typeof prepared === 'string' ? this._execute(prepared) : prepared;
  }
  operationsList({ owner, workspaceId, cursor = 0, limit = 20 }) {
    ownerCheck(owner); page(cursor, limit, 100);
    const rows = this.db.prepare('SELECT * FROM operations WHERE owner = ? AND (? IS NULL OR workspace_id = ?) AND (? = 0 OR row_id < ?) ORDER BY row_id DESC LIMIT ?')
      .all(owner, workspaceId ?? null, workspaceId ?? null, cursor, cursor, limit + 1);
    const selected = rows.slice(0, limit);
    return { operations: selected.map(row => this._operation(row)), nextCursor: rows.length > limit ? selected.at(-1).row_id : null };
  }
  operationRead({ owner, operationId }) {
    ownerCheck(owner); const row = this.db.prepare('SELECT * FROM operations WHERE owner = ? AND id = ?').get(owner, operationId);
    requireValue(row, 'Operation not found.', 'NOT_FOUND'); return this._operation(row);
  }
  getExecutionWorkspace({ owner, workspaceId }) {
    const row = this._row(owner, workspaceId); this._ready(row); safePath(row.path, '', { directory: true });
    return { path: row.path, workspaceId: row.id, revision: row.revision };
  }
  refreshAfterJob({ owner, workspaceId }) {
    return this.store.transaction(() => {
      const row = this._row(owner, workspaceId); this._ready(row); this._refresh(row);
      return { workspaceId: row.id, revision: row.revision };
    });
  }
}
