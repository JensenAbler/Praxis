import { constants } from 'node:fs';
import { open, mkdir, unlink, rename, statfs, readFile, lstat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const queues = new Map();

// One disk verification pipeline per process, shared across HostAccess instances.
// This is I/O backpressure, never a file-size ceiling. Queued entries retain metadata
// only; hashing allocates one 64 KiB page at a time. The durable row is authoritative.
const verifications = new Map();
const verificationQueue = [];
let verificationRunning = false;
function scheduleVerification(key, action) {
  const controller = new AbortController();
  let resolve, reject;
  const promise = new Promise((yes,no) => { resolve=yes; reject=no; });
  const job = { key, action, controller, resolve, reject, queued: true };
  verifications.set(key,job); verificationQueue.push(job);
  if (!verificationRunning) {
    verificationRunning = true;
    setImmediate(async () => {
      try {
        while (verificationQueue.length) {
          const next = verificationQueue.shift();
          if (next.cancelled) continue;
          next.queued = false;
          try { next.controller.signal.throwIfAborted(); next.resolve(await next.action(next.controller.signal)); }
          catch (error) { next.reject(error); }
          finally { if (verifications.get(next.key) === next) verifications.delete(next.key); }
        }
      } finally { verificationRunning = false; }
    });
  }
  return promise;
}
function cancelVerification(key, code = 'TRANSFER_CANCELLED') {
  const job=verifications.get(key); if (!job) return;
  const error=Object.assign(new Error('Upload verification cancelled.'),{code});
  job.controller.abort(error);
  if (job.queued) {
    job.cancelled=true; job.reject(error); verifications.delete(key);
    const index=verificationQueue.indexOf(job); if(index>=0)verificationQueue.splice(index,1);
  }
}
function base64Value(code) {
  if(code>=65 && code<=90)return code-65;
  if(code>=97 && code<=122)return code-71;
  if(code>=48 && code<=57)return code+4;
  return code===43 ? 62 : code===47 ? 63 : -1;
}
/** Linear validation avoids RegExp backtracking stack exhaustion on large chunks. */
export function isCanonicalBase64(text) {
  if(typeof text!=='string' || text.length%4)return false;
  if(!text.length)return true;
  const padding=text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const end=text.length-padding;
  for(let i=0;i<end;i++)if(base64Value(text.charCodeAt(i))<0)return false;
  return !padding || (base64Value(text.charCodeAt(end-1)) & (padding===2 ? 15 : 3))===0;
}

const hash = data => createHash('sha256').update(data).digest('hex');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const identity = value => value ? `${value.dev}:${value.ino}` : null;
async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function processIdentity(pid) {
  try {
    const text = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z') return null;
    const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    return boot + ':' + fields[19];
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Disk-backed transfers: metadata is constant-size, payload is never retained in SQLite. */
export class HostUploads {
  constructor(host, directory, helpers) {
    this.pending = new Map(); this.host = host; this.directory = join(directory, 'host-upload-locks'); this.h = helpers;
    host.db.exec(`PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS host_uploads (
        owner TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(owner,id));
      CREATE TABLE IF NOT EXISTS host_upload_locks (
        owner TEXT NOT NULL, id TEXT NOT NULL, token TEXT NOT NULL, pid INTEGER NOT NULL, start TEXT NOT NULL, PRIMARY KEY(owner,id));`);
  }
  async close() {
    this.closing = true;
    for (const key of this.pending.keys()) cancelVerification(this.directory + key, 'TRANSFER_INTERRUPTED');
    await Promise.allSettled([...this.pending.values()]);
  }
  get(owner, id) {
    const row = this.host.db.prepare('SELECT record FROM host_uploads WHERE owner=? AND id=?').get(owner, id);
    return row ? JSON.parse(row.record) : null;
  }
  save(record) {
    record.updatedAt = new Date().toISOString();
    this.host.db.prepare('INSERT INTO host_uploads(owner,id,record) VALUES(?,?,?) ON CONFLICT(owner,id) DO UPDATE SET record=excluded.record')
      .run(record.owner, record.id, JSON.stringify(record));
  }
  result(r, extra = {}) {
    const verification = verifications.get(this.directory + JSON.stringify([r.owner,r.id]));
    return { transferId: r.id, transferState: r.state, path: r.requestedPath, resolvedPath: r.path,
      nextOffset: r.offset, totalBytes: r.totalBytes ?? null, sha256: r.sha256 ?? null,
      queued: Boolean(verification?.queued), verificationWorkers: 1,
      atomic: r.state === 'completed', preconditionVerified: r.state === 'completed', ...(r.lastError ? { lastError: r.lastError } : {}), ...extra, ...this.h.observed() };
  }
  async locked(owner, id, action) {
    const key = join(this.directory, hash(JSON.stringify([owner, id])));
    const prior = queues.get(key) || Promise.resolve();
    let done; const pending = new Promise(resolve => { done = resolve; }); queues.set(key, pending);
    await prior;
    const token = randomUUID(); let owned = false;
    try {
      const start = await processIdentity(process.pid);
      this.h.check(start !== null, 'Cannot verify process identity for durable locking.', 'TRANSFER_LOCK_UNAVAILABLE');
      for (let attempt = 0; attempt < 3; attempt++) {
        const inserted = this.host.db.prepare('INSERT OR IGNORE INTO host_upload_locks(owner,id,token,pid,start) VALUES(?,?,?,?,?)')
          .run(owner, id, token, process.pid, start);
        if (inserted.changes) { owned = true; break; }
        const holder = this.host.db.prepare('SELECT * FROM host_upload_locks WHERE owner=? AND id=?').get(owner,id);
        if (!holder) continue;
        this.h.check(await processIdentity(holder.pid) !== holder.start, 'Transfer is active in another process; retry later.', 'TRANSFER_BUSY');
        // Compare-and-delete: never remove a newer holder after racing stale-lock recovery.
        this.host.db.prepare('DELETE FROM host_upload_locks WHERE owner=? AND id=? AND token=?').run(owner,id,holder.token);
      }
      this.h.check(owned, 'Transfer lock changed; retry later.', 'TRANSFER_BUSY');
      return await action();
    } finally {
      if (owned) this.host.db.prepare('DELETE FROM host_upload_locks WHERE owner=? AND id=? AND token=?').run(owner,id,token);
      done(); if (queues.get(key) === pending) queues.delete(key);
    }
  }
  async available(path, bytes) {
    const space = await statfs(path, { bigint: true });
    this.h.check(BigInt(bytes) <= space.bavail * space.bsize, 'Insufficient filesystem space for this chunk; free space and resume.', 'ENOSPC');
  }
  async recover(r, signal) {
    if (r.state !== 'finalizing') return;
    let stage; try { stage = await lstat(r.temporary); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (stage) {
      this.h.check(stage.isFile() && identity(stage) === r.stagedIdentity, 'Staged file identity changed.', 'TRANSFER_CONFLICT');
      return;
    }
    let destination; try { destination = await lstat(r.path); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    this.h.check(destination?.isFile() && identity(destination) === r.stagedIdentity && destination.size === r.offset &&
      (await this.h.hashFile(r.path, { signal })).sha256 === r.sha256,
    'Finalization outcome is uncertain; destination does not match the recorded staged file.', 'TRANSFER_UNCERTAIN');
    await syncDirectory(dirname(r.path));
    r.state = 'completed'; delete r.lastError; this.save(r);
  }
  async run(args, background = false, signal) {
    signal?.throwIfAborted();
    const { check, targetPath, precondition, fingerprint, maybeStat, readAt, hashFile, hashHandle } = this.h;
    check(!this.closing, 'Upload service is closing; resume after restart.', 'TRANSFER_INTERRUPTED');
    check(typeof args.owner === 'string' && args.owner.length > 0, 'An authenticated owner is required.');
    check(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.transferId || ''), 'Provide a stable client-generated UUID transferId.');
    check(['begin','chunk','status','finalize','abort'].includes(args.transferAction), 'Invalid transferAction.');
    check(args.mode === undefined || args.mode === 'replace', 'Transfers atomically replace regular files; append is not supported.');
    const pendingKey = JSON.stringify([args.owner, args.transferId]);
    const schedulerKey = this.directory + pendingKey;
    if (args.transferAction === 'abort') cancelVerification(schedulerKey);
    const active = this.get(args.owner, args.transferId);
    if (args.transferAction === 'finalize' && ['verifying','finalizing'].includes(active?.state)) {
      check(args.totalBytes === undefined || args.totalBytes === active.finalTotal, 'Finalization is already using a different size.', 'SIZE_MISMATCH');
      check(args.sha256 === undefined || args.sha256 === active.finalHash, 'Finalization is already using a different hash.', 'HASH_CONFLICT');
    }
    if (!background && ['status','finalize'].includes(args.transferAction) && ['verifying','finalizing'].includes(active?.state)) {
      const holder = this.host.db.prepare('SELECT * FROM host_upload_locks WHERE owner=? AND id=?').get(args.owner,args.transferId);
      if (verifications.has(schedulerKey) || this.pending.has(pendingKey) || (holder && await processIdentity(holder.pid) === holder.start))
        return this.result(active, { pending: true });
      if (args.transferAction === 'status')
        return this.result(active, { pending: false, resumeRequired: true });
    }
    return this.locked(args.owner, args.transferId, async () => {
      let r = this.get(args.owner, args.transferId);
      if (args.transferAction === 'begin') {
        check(args.content === undefined && args.offset === undefined, 'begin does not accept content or offset.');
        check(args.totalBytes === undefined || integer(args.totalBytes), 'totalBytes must be a nonnegative safe integer.');
        const requestedPath = this.host.resolvePath(args), path = await targetPath(requestedPath);
        const spec = JSON.stringify([requestedPath, path, args.expectedSha256 ?? null, args.expectedSha256 === undefined,
          args.permissions ?? null, args.totalBytes ?? null, args.sha256 ?? null, Boolean(args.createParents)]);
        if (r) { check(r.spec === spec, 'transferId was already used with different begin arguments.', 'TRANSFER_CONFLICT'); return this.result(r, { resumeRequired: ['verifying','finalizing'].includes(r.state) }); }
        return this.host._locked(path, async () => {
          if (args.createParents) await mkdir(dirname(path), { recursive: true });
          const before = await maybeStat(path);
          if (args.expectedSha256 === null) check(!before, 'The target already exists.', 'HASH_CONFLICT');
          else if (args.expectedSha256 !== undefined) check(before?.isFile(), 'The expected file does not exist or is not regular.', 'HASH_CONFLICT');
          // Whole destination hashing belongs to asynchronous finalize, not a control request.
          check(!before || before.isFile(), 'Transfers require a regular or missing target.', 'INVALID_FILE_TYPE');
          await this.available(dirname(path), 0);
          r = { owner: args.owner, id: args.transferId, spec, requestedPath, path,
            temporary: join(dirname(path), '.praxis-upload-' + randomUUID()), offset: 0, state: 'uploading',
            expectedSha256: args.expectedSha256, permissions: args.permissions,
            totalBytes: args.totalBytes, requiredSha256: args.sha256, createdAt: new Date().toISOString() };
          // Journal first: a crash here can recreate an empty stage, never orphan payload bytes.
          this.save(r);
          const fd = await open(r.temporary, 'wx', 0o600);
          try { await fd.sync(); r.stagedIdentity = identity(await fd.stat()); this.save(r); } finally { await fd.close(); }
          await syncDirectory(dirname(path)); return this.result(r);
        });
      }
      check(r, 'Transfer not found for this owner.', 'NOT_FOUND');
      // All target and precondition settings are immutable after begin. The schema's path
      // default is harmless; explicit alternate locations must not redirect a transfer.
      check(!args.hostProjectId && !args.dataRoot && (args.path === undefined || args.path === '.' || args.path === r.requestedPath),
        'Use transferId alone after begin; the destination is fixed.');
      check(args.expectedSha256 === undefined && args.permissions === undefined && !args.createParents,
        'Target preconditions and permissions are fixed by begin.');
      if (background) await this.recover(r, signal);
      if (args.transferAction === 'status') return this.result(r);
      if (args.transferAction === 'abort') {
        check(r.state !== 'finalizing' || await maybeStat(r.temporary), 'Finalization must be reconciled with finalize before abort.', 'TRANSFER_UNCERTAIN');
        if (r.state === 'completed') return this.result(r, { aborted: false });
        r.state = 'aborted'; this.save(r);
        await unlink(r.temporary).catch(e => { if (e.code !== 'ENOENT') throw e; });
        await syncDirectory(dirname(r.path)); return this.result(r, { aborted: true });
      }
      check(r.state !== 'aborted', 'Transfer was aborted.', 'TRANSFER_ABORTED');
      if (args.transferAction === 'chunk') {
        check(r.state === 'uploading', 'Transfer no longer accepts chunks.', 'TRANSFER_CONFLICT');
        check(integer(args.offset) && typeof args.content === 'string', 'chunk requires content and a nonnegative byte offset.');
        check(args.encoding === undefined || ['utf8','base64'].includes(args.encoding), 'Invalid encoding.');
        if (args.encoding === 'base64') check(isCanonicalBase64(args.content), 'content must be canonical base64.');
        const bytes = Buffer.from(args.content, args.encoding === 'base64' ? 'base64' : 'utf8');
        check(bytes.length > 0 && integer(args.offset + bytes.length), 'Chunk must contain bytes within safe integer offsets.');
        const digest = hash(bytes);
        check(args.chunkSha256 === undefined || args.chunkSha256 === digest, 'Chunk checksum mismatch.', 'CHUNK_HASH_MISMATCH');
        check(args.offset <= r.offset, 'Out-of-order chunk; resume at nextOffset.', 'OFFSET_CONFLICT');
        let fd;
        try { fd = await open(r.temporary, constants.O_RDWR | constants.O_NOFOLLOW); }
        catch (error) {
          if (error.code !== 'ENOENT' || r.offset !== 0) throw error;
          fd = await open(r.temporary, 'wx+', 0o600); await fd.sync(); await syncDirectory(dirname(r.path));
          r.stagedIdentity = identity(await fd.stat()); this.save(r);
        }
        try {
          const info = await fd.stat();
          check(info.isFile() && (!r.stagedIdentity || identity(info) === r.stagedIdentity), 'Staged file identity changed.', 'TRANSFER_CONFLICT');
          r.stagedIdentity = identity(info);
          check(info.size >= r.offset, 'Acknowledged staged bytes are missing.', 'TRANSFER_CONFLICT');
          if (info.size > r.offset) { await fd.truncate(r.offset); await fd.sync(); }
          if (args.offset < r.offset) {
            check(args.offset + bytes.length <= r.offset && (await readAt(fd, args.offset, bytes.length)).equals(bytes),
              'Retry bytes differ from the acknowledged range.', 'CHUNK_CONFLICT');
            return this.result(r, { duplicate: true, chunkSha256: digest });
          }
          check(r.totalBytes === undefined || r.offset + bytes.length <= r.totalBytes, 'Chunk exceeds declared totalBytes.', 'SIZE_MISMATCH');
          await this.available(dirname(r.path), bytes.length);
          let written = 0;
          while (written < bytes.length) {
            const next = await fd.write(bytes, written, bytes.length - written, r.offset + written);
            check(next.bytesWritten > 0, 'Filesystem made no write progress.', 'EIO'); written += next.bytesWritten;
          }
          await fd.sync(); r.offset += bytes.length; this.save(r);
          return this.result(r, { duplicate: false, chunkSha256: digest });
        } finally { await fd.close(); }
      }
      check(args.content === undefined && args.offset === undefined, 'finalize does not accept content or offset.');
      if (r.state === 'completed') {
        check(args.totalBytes === undefined || args.totalBytes === r.offset, 'Final size differs from completed transfer.', 'SIZE_MISMATCH');
        check(args.sha256 === undefined || args.sha256 === r.sha256, 'Final hash differs from completed transfer.', 'HASH_CONFLICT');
        return this.result(r);
      }
      if (!background) {
        const total = args.totalBytes ?? r.totalBytes ?? r.finalTotal, expected = args.sha256 ?? r.requiredSha256 ?? r.finalHash;
        check(total !== undefined && integer(total) && total === r.offset, 'finalize requires the exact totalBytes (at begin or finalize).', 'SIZE_MISMATCH');
        check(r.totalBytes === undefined || total === r.totalBytes, 'Final size differs from begin.', 'SIZE_MISMATCH');
        check(typeof expected === 'string' && /^[a-f0-9]{64}$/.test(expected), 'finalize requires the whole-file sha256 (at begin or finalize).');
        check(!r.requiredSha256 || expected === r.requiredSha256, 'Final hash differs from begin.', 'HASH_CONFLICT');
        r.finalTotal = total; r.finalHash = expected; r.state = r.state === 'finalizing' ? 'finalizing' : 'verifying'; delete r.lastError; this.save(r);
        // Schedule after releasing this operation's lock; the durable row is the recovery source.
        const task = scheduleVerification(schedulerKey, verificationSignal => this.run({
          owner: r.owner, transferId: r.id, transferAction: 'finalize'
        }, true, verificationSignal)).catch(error => {
          const current = this.get(r.owner,r.id);
          if (current && !['completed','aborted'].includes(current.state)) {
            if (current.state === 'verifying' && error.code !== 'TRANSFER_INTERRUPTED') current.state = 'uploading';
            current.lastError = { code: /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'HOST_IO_ERROR',
              message: 'Finalization did not complete. Inspect the destination and retry finalize, or abort staging.' };
            this.save(current);
          }
        }).catch(() => { /* If receipt persistence fails, leave the durable state resumable. */ })
          .finally(() => this.pending.delete(pendingKey));
        this.pending.set(pendingKey, task);
        return this.result(r, { pending: true });
      }
      return this.host._locked(r.path, async () => {
        check(await targetPath(r.requestedPath) === r.path, 'Destination symlink changed since begin.', 'HASH_CONFLICT');
        const total = args.totalBytes ?? r.totalBytes ?? r.finalTotal;
        check(total !== undefined && integer(total) && total === r.offset, 'finalize requires the exact totalBytes (at begin or finalize).', 'SIZE_MISMATCH');
        check(r.totalBytes === undefined || total === r.totalBytes, 'Final size differs from begin.', 'SIZE_MISMATCH');
        check(!r.requiredSha256 || !args.sha256 || args.sha256 === r.requiredSha256, 'Final hash differs from begin.', 'HASH_CONFLICT');
        const expected = args.sha256 ?? r.requiredSha256 ?? r.finalHash;
        check(typeof expected === 'string' && /^[a-f0-9]{64}$/.test(expected), 'finalize requires the whole-file sha256 (at begin or finalize).');
        let fd;
        try { fd = await open(r.temporary, constants.O_RDWR | constants.O_NOFOLLOW); }
        catch (error) { if (error.code !== 'ENOENT' || r.offset !== 0) throw error; fd = await open(r.temporary, 'wx+', 0o600); await fd.sync(); await syncDirectory(dirname(r.path));
          r.stagedIdentity = identity(await fd.stat()); this.save(r); }
        try {
          const staged = await fd.stat();
          check(staged.isFile() && (!r.stagedIdentity || identity(staged) === r.stagedIdentity), 'Staged file identity changed.', 'TRANSFER_CONFLICT');
          check(staged.size >= r.offset, 'Acknowledged staged bytes are missing.', 'TRANSFER_CONFLICT');
          await fd.truncate(r.offset);
          const digest = await hashHandle(fd, { signal });
          check(!expected || digest.sha256 === expected, 'Final file checksum mismatch.', 'HASH_CONFLICT');
          const before = await precondition(r.path, r.expectedSha256, { signal });
          check(!before || before.isFile(), 'Destination is not a regular file.', 'INVALID_FILE_TYPE');
          if (before && process.platform !== 'win32') await fd.chown(before.uid, before.gid);
          await fd.chmod(r.permissions ?? (before ? before.mode & 0o7777 : 0o600)); await fd.sync();
          r.sha256 = digest.sha256; r.stagedIdentity = identity(await fd.stat());
          r.state = 'finalizing'; this.save(r);
          await precondition(r.path, r.expectedSha256, { signal });
          check(fingerprint(await maybeStat(r.path)) === fingerprint(before), 'Destination changed during finalization.', 'HASH_CONFLICT');
          check(identity(await lstat(r.temporary)) === r.stagedIdentity, 'Staged path changed before replacement.', 'TRANSFER_CONFLICT');
          signal?.throwIfAborted();
          await fd.close(); fd = null;
          await rename(r.temporary, r.path); await syncDirectory(dirname(r.path));
          r.state = 'completed'; delete r.lastError; this.save(r);
          return this.result(r);
        } finally { await fd?.close(); }
      });
    });
  }
}
