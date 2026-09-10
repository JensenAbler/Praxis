import { mkdirSync, statSync } from 'node:fs';
import { open, stat, lstat, realpath, readlink, readdir, mkdir, rename, unlink } from 'node:fs/promises';
import { resolve, isAbsolute, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceError } from './paths.js';

const CHUNK = 65536;
const observed = () => ({ observedAt: new Date().toISOString(), consistency: 'live-unverified', snapshot: false,
  consistencyNote: 'Host files can change during this operation and between pages. No workspace revision or external-process lock is implied.' });
export class HostAccessError extends WorkspaceError {}
function check(value, message, code = 'INVALID_ARGUMENT') { if (!value) throw new HostAccessError(code, message); }
const hashOf = value => createHash('sha256').update(value).digest('hex');
const fingerprint = value => value ? `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}` : null;
const fileType = value => value.isFile() ? 'file' : value.isDirectory() ? 'directory' : value.isSymbolicLink() ? 'symlink' : 'special';
const details = value => ({ type: fileType(value), size: value.size, mode: value.mode & 0o7777, uid: value.uid, gid: value.gid,
  modifiedAt: value.mtime.toISOString(), device: value.dev, inode: value.ino });
async function maybeStat(path) { try { return await stat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function safe(action) {
  try { return await action(); }
  catch (error) {
    if (error instanceof HostAccessError) throw error;
    // No source, argument values or filesystem error strings enter diagnostic logs.
    throw new HostAccessError(error.code || 'HOST_IO_ERROR', `Host filesystem operation failed (${/^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'HOST_IO_ERROR'}).`);
  }
}
async function targetPath(path, depth = 0) {
  check(depth < 64, 'Symbolic-link resolution loop.', 'ELOOP');
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try {
      if ((await lstat(path)).isSymbolicLink()) return targetPath(resolve(dirname(path), await readlink(path)), depth + 1);
    } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await targetPath(parent, depth + 1), path.slice(parent.length).replace(/^[/\\]+/, ''));
  }
}
async function readAt(handle, offset, length) {
  const data = Buffer.alloc(length);
  let bytesRead = 0;
  while (bytesRead < length) {
    const result = await handle.read(data, bytesRead, length - bytesRead, offset + bytesRead);
    if (!result.bytesRead) break;
    bytesRead += result.bytesRead;
  }
  return data.subarray(0, bytesRead);
}
async function hashHandle(handle) {
  const digest = createHash('sha256');
  let bytes = 0;
  while (true) {
    const part = await readAt(handle, bytes, CHUNK);
    if (!part.length) break;
    digest.update(part); bytes += part.length;
  }
  return { sha256: digest.digest('hex'), hashedBytes: bytes };
}
async function hashFile(path) {
  const handle = await open(path, 'r');
  try {
    return await hashHandle(handle);
  } finally { await handle.close(); }
}
async function precondition(path, expectedSha256) {
  const value = await maybeStat(path);
  if (expectedSha256 === null) check(!value, 'The target already exists.', 'HASH_CONFLICT');
  else if (expectedSha256 !== undefined) {
    check(value?.isFile(), 'The expected file does not exist or is not regular.', 'HASH_CONFLICT');
    check((await hashFile(path)).sha256 === expectedSha256, 'File content no longer matches expectedSha256.', 'HASH_CONFLICT');
  }
  return value;
}
function encodeCursor(signature, state) { return Buffer.from(JSON.stringify({ signature, ...state })).toString('base64url'); }
function decodeCursor(cursor, signature) {
  if (!cursor) return { index: 0, offset: 0 };
  let value; try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { /* Invalid token below. */ }
  check(value?.signature === signature && Number.isSafeInteger(value.index) && value.index >= 0
    && Number.isSafeInteger(value.offset) && value.offset >= 0, 'Cursor must come from this tool with the same path and options.');
  return value;
}

/** Enumerates aliases independently; only directory ancestry is de-duplicated. */
async function* walk(root, recursive, followSymlinks, ancestors = new Set()) {
  let info, raw, canonical;
  try { raw = await lstat(root); info = await stat(root); canonical = await realpath(root); }
  catch (error) { yield { path: root, error: error.code || 'HOST_IO_ERROR' }; return; }
  if (!info.isDirectory()) { yield { path: root, ...details(info), symlink: raw.isSymbolicLink() }; return; }
  if (ancestors.has(canonical)) return;
  const parents = new Set(ancestors).add(canonical);
  let names; try { names = (await readdir(root)).sort(); }
  catch (error) { yield { path: root, error: error.code || 'HOST_IO_ERROR' }; return; }
  for (const name of names) {
    const path = join(root, name);
    let rawChild, child;
    try { rawChild = await lstat(path); child = rawChild.isSymbolicLink() && followSymlinks ? await stat(path) : rawChild; }
    catch (error) { yield { path, name, error: error.code || 'HOST_IO_ERROR' }; continue; }
    yield { path, name, ...details(child), symlink: rawChild.isSymbolicLink() };
    if (recursive && child.isDirectory()) yield* walk(path, true, followSymlinks, parents);
  }
}

export class HostAccess {
  constructor({ dataDirectory }) {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDirectory, 'host-projects.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS host_projects (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL,
        name TEXT NOT NULL, path TEXT NOT NULL, data_roots_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(owner,name));`);
    this.locks = new Map();
  }
  close() { this.db.close(); }
  _public(row) { return { hostProjectId: row.id, name: row.name, path: row.path, dataRoots: JSON.parse(row.data_roots_json), createdAt: row.created_at, updatedAt: row.updated_at }; }
  getProject(owner, hostProjectId) {
    const row = this.db.prepare('SELECT * FROM host_projects WHERE id=? AND owner=?').get(hostProjectId, owner);
    check(row, 'Attached host project not found.', 'NOT_FOUND');
    return this._public(row);
  }
  resolvePath({ owner, hostProjectId, dataRoot, path = '.' }) {
    check(typeof owner === 'string' && owner.length > 0, 'An authenticated owner is required.');
    check(typeof path === 'string' && path.length > 0 && !path.includes('\0'), 'A filesystem path is required.');
    if (isAbsolute(path)) {
      check(!dataRoot, 'Use dataRoot with a project-relative path, or provide an absolute path alone.');
      return resolve(path);
    }
    check(hostProjectId, 'Relative paths require hostProjectId.');
    const project = this.getProject(owner, hostProjectId);
    const root = dataRoot ? project.dataRoots[dataRoot] : project.path;
    check(typeof root === 'string', 'Named data root not found.', 'NOT_FOUND');
    return resolve(root, path);
  }
  projectAttach({ owner, name, path, dataRoots = {}, replace = false }) {
    return safe(async () => {
      check(typeof owner === 'string' && owner.length > 0 && typeof name === 'string' && name.length > 0, 'Owner and project name are required.');
      check(isAbsolute(path), 'Project path must be absolute.');
      check(statSync(path).isDirectory(), 'Project path must be an existing directory.');
      const roots = Object.create(null);
      for (const key of Object.keys(dataRoots).sort()) {
        check(isAbsolute(dataRoots[key]), 'Data roots must be absolute.');
        check(statSync(dataRoots[key]).isDirectory(), 'Data roots must be existing directories.');
        roots[key] = resolve(dataRoots[key]);
      }
      const normalized = resolve(path), encoded = JSON.stringify(roots), timestamp = new Date().toISOString();
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const previous = this.db.prepare('SELECT * FROM host_projects WHERE owner=? AND name=?').get(owner, name);
        if (previous) {
          check(replace || (previous.path === normalized && previous.data_roots_json === encoded), 'This project name already refers to different paths. Use replace=true to update it.', 'PROJECT_CONFLICT');
          if (previous.path !== normalized || previous.data_roots_json !== encoded) this.db.prepare('UPDATE host_projects SET path=?,data_roots_json=?,updated_at=? WHERE id=?').run(normalized, encoded, timestamp, previous.id);
          this.db.exec('COMMIT');
          return { ...this.getProject(owner, previous.id), ...observed() };
        }
        const id = randomUUID();
        this.db.prepare('INSERT INTO host_projects(id,owner,name,path,data_roots_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id, owner, name, normalized, encoded, timestamp, timestamp);
        this.db.exec('COMMIT');
        return { ...this.getProject(owner, id), ...observed() };
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    });
  }
  projectsList({ owner, cursor = 0, limit = 50 }) {
    return safe(async () => {
      const rows = this.db.prepare('SELECT * FROM host_projects WHERE owner=? AND row_id>? ORDER BY row_id LIMIT ?').all(owner, cursor, limit + 1);
      const page = rows.slice(0, limit), hasMore = rows.length > limit;
      return { projects: page.map(row => this._public(row)), hasMore, nextCursor: hasMore ? page.at(-1).row_id : null, ...observed() };
    });
  }
  pathInfo(args) {
    return safe(async () => {
      const path = this.resolvePath(args);
      let raw; try { raw = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return { path, exists: false, ...observed() }; throw error; }
      const info = await maybeStat(path);
      return { path, exists: true, targetExists: Boolean(info), symlink: raw.isSymbolicLink(),
        ...(raw.isSymbolicLink() ? { linkTarget: await readlink(path) } : {}),
        ...(info ? { resolvedPath: await realpath(path), ...details(info) } : { type: 'symlink' }),
        ...(args.includeSha256 && info?.isFile() ? await hashFile(path) : {}), ...observed() };
    });
  }
  filesList(args) {
    return safe(async () => {
      const path = this.resolvePath(args), { recursive = false, followSymlinks = true, limit = 100 } = args;
      const signature = hashOf(JSON.stringify(['list', path, recursive, followSymlinks]));
      const cursor = decodeCursor(args.cursor, signature), entries = [];
      let index = 0, hasMore = false;
      for await (const entry of walk(path, recursive, followSymlinks)) {
        if (index++ < cursor.index) continue;
        if (entries.length === limit) { hasMore = true; break; }
        entries.push(entry);
      }
      return { path, entries, hasMore, nextCursor: hasMore ? encodeCursor(signature, { index: cursor.index + entries.length, offset: 0 }) : null, ...observed() };
    });
  }
  fileRead(args) {
    return safe(async () => {
      const path = this.resolvePath(args), { cursor = 0, maxBytes = 16384, encoding = 'utf8', includeSha256 = false, expectedSha256 } = args;
      const handle = await open(path, 'r');
      try {
        const before = await handle.stat();
        // Hash the same open inode as the returned page, even if its path is replaced.
        const fullHash = includeSha256 || expectedSha256 ? await hashHandle(handle) : {};
        if (expectedSha256) check(fullHash.sha256 === expectedSha256, 'File content no longer matches expectedSha256.', 'HASH_CONFLICT');
        let bytes = await readAt(handle, cursor, maxBytes + 1);
        const hasMore = bytes.length > maxBytes;
        bytes = bytes.subarray(0, maxBytes);
        if (encoding === 'utf8' && hasMore) {
          // Leave an incomplete UTF-8 suffix for the next page; base64 is byte-exact.
          let start = bytes.length - 1;
          while (start >= Math.max(0, bytes.length - 4) && (bytes[start] & 0xc0) === 0x80) start--;
          if (start >= 0) {
            const lead = bytes[start], needed = lead >= 0xf0 && lead <= 0xf4 ? 4 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xc2 && lead <= 0xdf ? 2 : 1;
            if (bytes.length - start < needed) bytes = bytes.subarray(0, start);
          }
        }
        const after = await handle.stat();
        return { path, ...details(after), cursor, bytesRead: bytes.length, encoding,
          content: bytes.toString(encoding === 'base64' ? 'base64' : 'utf8'), hasMore,
          nextCursor: hasMore ? cursor + bytes.length : null, ...fullHash,
          changedDuringRead: fingerprint(before) !== fingerprint(after),
          ...(encoding === 'utf8' ? { decoding: 'UTF-8; invalid byte sequences use replacement characters. Use base64 for exact bytes.' } : {}), ...observed() };
      } finally { await handle.close(); }
    });
  }
  async _locked(path, action) {
    const previous = this.locks.get(path) || Promise.resolve();
    let release; const current = new Promise(done => { release = done; });
    this.locks.set(path, current);
    await previous;
    try { return await action(); }
    finally { release(); if (this.locks.get(path) === current) this.locks.delete(path); }
  }
  async _replace(path, before, expectedSha256, permissions, produce) {
    const temporary = join(dirname(path), `.praxis-host-${randomUUID()}`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await produce(handle);
      if (before && process.platform !== 'win32') await handle.chown(before.uid, before.gid);
      await handle.chmod(permissions ?? (before ? before.mode & 0o7777 : 0o600));
      await handle.sync(); await handle.close(); handle = null;
      await precondition(path, expectedSha256);
      check(fingerprint(await maybeStat(path)) === fingerprint(before), 'File changed while replacement was being prepared.', 'HASH_CONFLICT');
      await rename(temporary, path);
      if (process.platform !== 'win32') { const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
    } finally { await handle?.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  fileWrite(args) {
    return safe(async () => {
      const requestedPath = this.resolvePath(args), path = await targetPath(requestedPath);
      const { mode = 'replace', encoding = 'utf8', expectedSha256, offset, permissions } = args;
      check(mode !== 'replace' || offset === undefined, 'offset applies only to append mode.');
      if (encoding === 'base64') check(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.content), 'content must be canonical base64.');
      const bytes = Buffer.from(args.content, encoding === 'base64' ? 'base64' : 'utf8');
      return this._locked(path, async () => {
        if (args.createParents) await mkdir(dirname(path), { recursive: true });
        const before = await precondition(path, expectedSha256);
        check(!before?.isDirectory(), 'The target is a directory.', 'EISDIR');
        let atomic = false;
        if (mode === 'replace' && (!before || before.isFile())) {
          await this._replace(path, before, expectedSha256, permissions, handle => handle.writeFile(bytes)); atomic = true;
        } else {
          if (offset !== undefined) check((before?.size ?? 0) === offset, 'Append offset no longer matches file size.', 'HASH_CONFLICT');
          const handle = await open(path, mode === 'append' ? 'a' : 'w', permissions ?? 0o600);
          try { await handle.writeFile(bytes); if (permissions !== undefined) await handle.chmod(permissions); if (before?.isFile() || !before) await handle.sync(); }
          finally { await handle.close(); }
        }
        const after = await stat(path);
        return { path: requestedPath, resolvedPath: path, mode, atomic, bytesWritten: bytes.length, ...details(after),
          ...(after.isFile() ? await hashFile(path) : {}), ...observed() };
      });
    });
  }
  filePatch(args) {
    return safe(async () => {
      const requestedPath = this.resolvePath(args), path = await targetPath(requestedPath);
      const needle = Buffer.from(args.oldText), replacement = Buffer.from(args.newText);
      check(needle.length > 0, 'oldText must not be empty.');
      return this._locked(path, async () => {
        const before = await precondition(path, args.expectedSha256);
        check(before?.isFile(), 'Patching requires an existing regular file.', 'NOT_FOUND');
        let source = await open(path, 'r');
        try {
          let offset = 0, match = -1;
          while (true) {
            const data = await readAt(source, offset, CHUNK + needle.length - 1);
            const candidates = Math.min(CHUNK, Math.max(0, data.length - needle.length + 1));
            if (!candidates) break;
            let start = 0;
            while (true) {
              const found = data.indexOf(needle, start);
              if (found < 0 || found >= candidates) break;
              check(match < 0, 'oldText occurs more than once; provide a unique surrounding context.', 'PATCH_CONFLICT');
              match = offset + found; start = found + 1;
            }
            offset += candidates;
          }
          check(match >= 0, 'oldText does not occur in the current file.', 'PATCH_CONFLICT');
          await this._replace(path, before, args.expectedSha256, undefined, async output => {
            let position = 0;
            while (position < match) { const part = await readAt(source, position, Math.min(CHUNK, match - position)); check(part.length, 'File changed during patch.', 'HASH_CONFLICT'); await output.writeFile(part); position += part.length; }
            await output.writeFile(replacement); position = match + needle.length;
            while (true) { const part = await readAt(source, position, CHUNK); if (!part.length) break; await output.writeFile(part); position += part.length; }
            // Windows prevents replacing a file while this read handle remains open.
            await source.close(); source = null;
          });
          return { path: requestedPath, resolvedPath: path, atomic: true, replacedAtByte: match, removedBytes: needle.length,
            insertedBytes: replacement.length, ...details(await stat(path)), ...await hashFile(path), ...observed() };
        } finally { await source?.close(); }
      });
    });
  }
  search(args) {
    return safe(async () => {
      const path = this.resolvePath(args), { recursive = true, followSymlinks = true, limit = 50, maxScanBytes = 8388608, maxFiles = 200 } = args;
      const needle = Buffer.from(args.query); check(needle.length > 0, 'query must not be empty.');
      const signature = hashOf(JSON.stringify(['search', path, recursive, followSymlinks, args.query]));
      const cursor = decodeCursor(args.cursor, signature), matches = [], errors = [];
      let index = 0, scannedBytes = 0, scannedFiles = 0;
      const result = next => ({ path, matches, errors, scannedBytes, scannedFiles, hasMore: Boolean(next), nextCursor: next ? encodeCursor(signature, next) : null, ...observed() });
      for await (const entry of walk(path, recursive, followSymlinks)) {
        if (entry.type === 'directory' || entry.type === 'symlink' || entry.type === 'special') continue;
        const fileIndex = index++;
        if (fileIndex < cursor.index) continue;
        let offset = fileIndex === cursor.index ? cursor.offset : 0;
        if (scannedFiles >= maxFiles || scannedBytes >= maxScanBytes) return result({ index: fileIndex, offset });
        scannedFiles++;
        if (entry.error) { errors.push(entry); continue; }
        let handle;
        try {
          handle = await open(entry.path, 'r');
          while (scannedBytes < maxScanBytes) {
            const budget = Math.min(CHUNK, maxScanBytes - scannedBytes);
            const data = await readAt(handle, offset, budget + needle.length - 1);
            const candidates = Math.min(budget, Math.max(0, data.length - needle.length + 1));
            if (!candidates) break;
            let start = 0;
            while (true) {
              const found = data.indexOf(needle, start);
              if (found < 0 || found >= candidates) break;
              matches.push({ path: entry.path, byteOffset: offset + found, excerpt: data.subarray(Math.max(0, found - 80), Math.min(data.length, found + Math.min(needle.length, 160) + 80)).toString('utf8') });
              if (matches.length === limit) { scannedBytes += found + 1; return result({ index: fileIndex, offset: offset + found + 1 }); }
              start = found + 1;
            }
            scannedBytes += candidates; offset += candidates;
          }
          if (scannedBytes >= maxScanBytes) return result({ index: fileIndex, offset });
        } catch (error) { errors.push({ path: entry.path, error: error.code || 'HOST_IO_ERROR' }); }
        finally { await handle?.close(); }
      }
      return result(null);
    });
  }
}
