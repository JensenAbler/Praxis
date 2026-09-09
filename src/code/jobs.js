import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, lstatSync, openSync, readSync, closeSync, writeFileSync, fsyncSync, renameSync, constants, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { containerName } from './runner.js';

export const CODE_JOB_LIMITS = Object.freeze({
  timeoutSeconds: 900, preparationTimeoutSeconds: 120, activeJobs: 1, retainedJobs: 200, logBytes: 1048576, logRecords: 8192,
  artifacts: 16, artifactBytes: 524288, artifactTotalBytes: 2097152,
});
const ACTIVE = ['queued', 'starting', 'running', 'canceling'];
const ACTIVE_SQL = "('queued','starting','running','canceling')";
const RUNNER_TOKEN = randomUUID();
const PROCESS_WORK = new Set();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENV_KEYS = new Set(['CI', 'NODE_ENV', 'TZ', 'LANG', 'LC_ALL', 'FORCE_COLOR', 'NO_COLOR', 'PYTHONHASHSEED', 'PYTHONDONTWRITEBYTECODE']);
const now = () => new Date().toISOString();

export class CodeJobError extends Error {
  constructor(code, message) { super(message); this.name = 'CodeJobError'; this.code = code; }
}
function requireValue(condition, message) {
  if (!condition) throw new CodeJobError('INVALID_ARGUMENT', message);
}
function ownerValue(owner) { requireValue(typeof owner === 'string' && owner.length > 0 && owner.length <= 100, 'A valid owner is required.'); }
function idValue(id) { requireValue(typeof id === 'string' && UUID.test(id), 'jobId must be a UUID.'); }
function page(cursor, limit, max = 100) {
  requireValue(Number.isSafeInteger(cursor) && cursor >= 0, 'cursor must be a non-negative integer.');
  requireValue(Number.isSafeInteger(limit) && limit > 0 && limit <= max, `limit must be between 1 and ${max}.`);
}
function utf8Prefix(bytes, maximum) {
  let end = Math.min(bytes.length, maximum);
  if (end < bytes.length) while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end);
}
function syncDirectory(directory) {
  if (process.platform === 'win32') return; // Windows directory handles cannot use this Node interface.
  const fd = openSync(directory, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function durableFile(path, bytes) {
  const temporary = `${path}.pending`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
}
function safeRelative(value, allowDot = false) {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\\\0-\x1f]/.test(value), 'Paths must be bounded workspace-relative POSIX paths.');
  requireValue(!value.startsWith('/') && !/^[a-z]:/i.test(value), 'Absolute paths are not allowed.');
  requireValue(allowDot && value === '.' || value.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git'), 'Path traversal and protected Git internals are not allowed.');
  return value;
}
function inputValue(input) {
  const { owner, idempotencyKey, workspaceId, expectedRevision, label = '', argv, cwd = '.', env = {}, timeoutSeconds = 300, artifactPaths = [] } = input;
  ownerValue(owner);
  requireValue(typeof idempotencyKey === 'string' && /^[a-zA-Z0-9._:-]{8,128}$/.test(idempotencyKey), 'idempotencyKey must contain 8–128 letters, numbers, dots, underscores, colons, or hyphens.');
  requireValue(typeof workspaceId === 'string' && workspaceId.length <= 100 && workspaceId.length > 0, 'workspaceId is required.');
  requireValue(typeof expectedRevision === 'string' && expectedRevision.length <= 200 && expectedRevision.length > 0, 'expectedRevision is required.');
  requireValue(typeof label === 'string' && label.length <= 80 && !/[\0-\x1f]/.test(label), 'label must be at most 80 characters without control characters.');
  requireValue(Array.isArray(argv) && argv.length > 0 && argv.length <= 64, 'argv must contain 1–64 command arguments.');
  requireValue(argv.every(arg => typeof arg === 'string' && arg.length <= 8192 && !arg.includes('\0')) && argv[0].length > 0, 'Command arguments must be bounded strings without NUL characters.');
  requireValue(Buffer.byteLength(JSON.stringify(argv)) <= 32768, 'Command arguments exceed the 32 KiB limit.');
  safeRelative(cwd, true);
  requireValue(env && typeof env === 'object' && !Array.isArray(env), 'env must be an object.');
  for (const [key, value] of Object.entries(env)) requireValue(ENV_KEYS.has(key) && typeof value === 'string' && value.length <= 1000 && !value.includes('\0'), `Environment override ${key} is not permitted or exceeds its limit.`);
  requireValue(Number.isInteger(timeoutSeconds) && timeoutSeconds >= 1 && timeoutSeconds <= CODE_JOB_LIMITS.timeoutSeconds, 'timeoutSeconds must be between 1 and 900.');
  requireValue(Array.isArray(artifactPaths) && artifactPaths.length <= CODE_JOB_LIMITS.artifacts, 'At most 16 artifact paths may be requested.');
  artifactPaths.forEach(path => safeRelative(path));
  requireValue(new Set(artifactPaths).size === artifactPaths.length, 'Artifact paths must be unique.');
  return { owner, idempotencyKey, workspaceId, expectedRevision, label, argv, cwd, env: Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))), timeoutSeconds, artifactPaths };
}

function publicJob(row, summary = false) {
  const request = JSON.parse(row.request_json);
  const argv = summary ? request.argv.slice(0, 8).map(arg => arg.slice(0, 256)) : request.argv;
  return {
    id: row.id, workspaceId: row.workspace_id, label: request.label, status: row.status,
    argv, argvTruncated: summary && (request.argv.length > argv.length || request.argv.some(arg => arg.length > 256)),
    cwd: request.cwd, timeoutSeconds: request.timeoutSeconds, network: 'none',
    expectedRevision: request.expectedRevision, revisionAfter: row.revision_after,
    revisionVerified: Boolean(row.revision_after) && !row.execution_error,
    createdAt: row.created_at, updatedAt: row.updated_at, startedAt: row.started_at, finishedAt: row.finished_at,
    exitCode: row.exit_code, signal: row.signal, cancellationRequested: Boolean(row.cancel_requested),
    terminationReason: row.termination_reason, executionError: row.execution_error,
    ...(row.termination_reason === 'timeout_inferred' ? { terminationExplanation: 'The container stopped at its configured deadline, but the runtime did not provide a process exit code. Timeout is inferred, and execution will not be repeated automatically.' } : {}),
    outputBytes: row.output_bytes, truncated: Boolean(row.truncated),
    artifactPaths: request.artifactPaths, artifactErrors: JSON.parse(row.artifact_errors),
  };
}

/** Durable scheduling only. Enforcement is the real runner and its enclosing OS configuration. */
export class CodeJobs {
  constructor({ store, dataDirectory, runner, workspaces, clock = now }) {
    this.store = store; this.db = store.db; this.runner = runner; this.workspaces = workspaces;
    this.dataDirectory = resolve(dataDirectory); this.clock = clock; this.busy = false;
    mkdirSync(join(this.dataDirectory, 'artifacts'), { recursive: true, mode: 0o700 });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS code_jobs (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        owner TEXT NOT NULL, workspace_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        request_json TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
        container_id TEXT, launch_intent_at TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
        exit_code INTEGER, signal TEXT, termination_reason TEXT, execution_error TEXT,
        revision_after TEXT, output_bytes INTEGER NOT NULL DEFAULT 0, truncated INTEGER NOT NULL DEFAULT 0,
        runner_cursor INTEGER NOT NULL DEFAULT 0, log_fingerprint TEXT, artifact_errors TEXT NOT NULL DEFAULT '[]',
        UNIQUE(owner, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS code_jobs_workspace_status ON code_jobs(workspace_id,status);
      CREATE TABLE IF NOT EXISTS code_records (
        job_id TEXT NOT NULL REFERENCES code_jobs(id), sequence INTEGER NOT NULL,
        timestamp TEXT NOT NULL, stream TEXT NOT NULL, text TEXT NOT NULL, partial INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(job_id,sequence)
      );
      CREATE TABLE IF NOT EXISTS code_artifacts (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES code_jobs(id), name TEXT NOT NULL,
        path TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(job_id,name)
      );
      CREATE TABLE IF NOT EXISTS code_runner_lock (singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL, token TEXT NOT NULL);
    `);
  }

  acquireRunner() {
    this.store.transaction(() => {
      const lock = this.db.prepare('SELECT * FROM code_runner_lock WHERE singleton=1').get();
      if (lock?.token === RUNNER_TOKEN) return;
      if (lock) {
        let alive = true;
        try { process.kill(lock.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
        if (alive) throw new CodeJobError('RUNNER_BUSY', 'Another coding worker owns execution. A reused PID is treated conservatively as still owned.');
      }
      this.db.prepare('INSERT OR REPLACE INTO code_runner_lock(singleton,pid,token) VALUES(1,?,?)').run(process.pid, RUNNER_TOKEN);
    });
  }

  row(owner, jobId) {
    ownerValue(owner); idValue(jobId);
    const row = this.db.prepare('SELECT * FROM code_jobs WHERE owner=? AND id=?').get(owner, jobId);
    if (!row) throw new CodeJobError('NOT_FOUND', 'The job was not found for this owner.');
    return row;
  }
  record(jobId, stream, text, timestamp = this.clock(), partial = false) {
    this.db.prepare(`INSERT INTO code_records(job_id,sequence,timestamp,stream,text,partial)
      VALUES (?,(SELECT COALESCE(MAX(sequence),0)+1 FROM code_records WHERE job_id=?),?,?,?,?)`).run(jobId, jobId, timestamp, stream, text, partial ? 1 : 0);
  }

  start(input) {
    const request = inputValue(input);
    const { owner, idempotencyKey } = request;
    const requestJson = JSON.stringify(request);
    return this.store.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM code_jobs WHERE owner=? AND idempotency_key=?').get(owner, idempotencyKey);
      if (existing) {
        if (existing.request_json !== requestJson) throw new CodeJobError('IDEMPOTENCY_CONFLICT', 'This idempotency key belongs to a different command. Use a new key only for intentionally new work.');
        return publicJob(existing);
      }
      if (this.db.prepare(`SELECT 1 FROM code_jobs WHERE status IN ${ACTIVE_SQL} LIMIT 1`).get()) throw new CodeJobError('ACTIVE_JOB_LIMIT', 'One command may be active at a time. Inspect or cancel the existing job.');
      if (this.db.prepare('SELECT COUNT(*) AS count FROM code_jobs').get().count >= CODE_JOB_LIMITS.retainedJobs) throw new CodeJobError('JOB_QUOTA_EXCEEDED', 'The retained job quota is full. Owner maintenance is required before starting more work.');
      const workspace = this.workspaces.getExecutionWorkspace({ owner, workspaceId: request.workspaceId });
      if (workspace && typeof workspace.then === 'function') throw new Error('getExecutionWorkspace must be synchronous inside the transaction.');
      if (workspace.revision !== request.expectedRevision) throw new CodeJobError('STALE_REVISION', 'The workspace revision changed. Inspect it and submit the command against the current revision.');
      const id = randomUUID(), time = this.clock();
      this.db.prepare(`INSERT INTO code_jobs(id,owner,workspace_id,idempotency_key,request_json,status,created_at,updated_at)
        VALUES (?,?,?,?,?,'queued',?,?)`).run(id, owner, request.workspaceId, idempotencyKey, requestJson, time, time);
      this.record(id, 'system', 'QUEUED', time);
      return publicJob(this.row(owner, id));
    });
  }

  get({ owner, jobId }) { return publicJob(this.row(owner, jobId)); }

  list({ owner, workspaceId, cursor = 0, limit = 20 }) {
    ownerValue(owner); page(cursor, limit);
    const rows = this.db.prepare(`SELECT * FROM code_jobs WHERE owner=? AND (? IS NULL OR workspace_id=?)
      AND (?=0 OR row_id<?) ORDER BY row_id DESC LIMIT ?`).all(owner, workspaceId ?? null, workspaceId ?? null, cursor, cursor, limit + 1);
    const selected = [], jobs = [];
    let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      const value = publicJob(row, true), size = Buffer.byteLength(JSON.stringify(value));
      if (selected.length && bytes + size > 49152) break;
      selected.push(row); jobs.push(value); bytes += size;
    }
    const hasMore = rows.length > selected.length;
    return { jobs, nextCursor: hasMore ? selected.at(-1).row_id : null, hasMore };
  }

  logs({ owner, jobId, cursor = 0, limit = 50 }) {
    page(cursor, limit);
    return this.store.transaction(() => {
      const job = this.row(owner, jobId);
      // Node SQLite TEXT reads can stop at embedded NUL even though SQLite retained all bytes.
      const rows = this.db.prepare('SELECT sequence,timestamp,stream,CAST(text AS BLOB) AS text_bytes,partial FROM code_records WHERE job_id=? AND sequence>? ORDER BY sequence LIMIT ?')
        .all(jobId, cursor, limit + 1).map(row => ({ ...row, text: Buffer.from(row.text_bytes).toString('utf8') }));
      const selected = [];
      let pageBytes = 0;
      for (const row of rows.slice(0, limit)) {
        const bytes = Buffer.byteLength(JSON.stringify({ sequence: row.sequence, timestamp: row.timestamp, stream: row.stream, text: row.text, partial: Boolean(row.partial) }));
        if (selected.length && pageBytes + bytes > 49152) break;
        selected.push(row); pageBytes += bytes;
      }
      const hasMore = rows.length > selected.length;
      return {
        jobId, status: job.status,
        records: selected.map(row => ({ sequence: row.sequence, timestamp: row.timestamp, stream: row.stream, text: row.text, partial: Boolean(row.partial) })),
        nextCursor: selected.at(-1)?.sequence ?? cursor, hasMore, caughtUp: !hasMore,
        terminal: !ACTIVE.includes(job.status), truncated: Boolean(job.truncated), outputBytes: job.output_bytes,
        encoding: 'utf8', binaryDecoding: 'Non-UTF-8 output is displayed with replacement characters.',
        retention: 'Bounded container logs are copied into persisted records; detected recycling marks truncated.',
      };
    });
  }

  cancel({ owner, jobId }) {
    return this.store.transaction(() => {
      const job = this.row(owner, jobId);
      if (!ACTIVE.includes(job.status)) return publicJob(job);
      const time = this.clock();
      if (job.status === 'queued') {
        const expected = JSON.parse(job.request_json).expectedRevision;
        this.db.prepare("UPDATE code_jobs SET status='cancelled',cancel_requested=1,termination_reason='cancelled',finished_at=?,updated_at=?,revision_after=? WHERE id=?").run(time, time, expected, jobId);
        this.record(jobId, 'system', 'CANCELLED before execution', time);
      } else {
        this.db.prepare("UPDATE code_jobs SET status='canceling',cancel_requested=1,termination_reason='cancelled',updated_at=? WHERE id=?").run(time, jobId);
      }
      return publicJob(this.row(owner, jobId));
    });
  }

  artifactList({ owner, jobId }) {
    this.row(owner, jobId);
    const rows = this.db.prepare('SELECT id,name,bytes,sha256,created_at FROM code_artifacts WHERE job_id=? ORDER BY name').all(jobId);
    return { jobId, artifacts: rows.map(row => ({ id: row.id, name: row.name, bytes: row.bytes, sha256: row.sha256, createdAt: row.created_at })) };
  }

  artifactRead({ owner, jobId, artifactId, cursor = 0, limit = 16384 }) {
    page(cursor, limit, 32768); this.row(owner, jobId);
    requireValue(typeof artifactId === 'string' && /^[a-f0-9]{64}$/.test(artifactId), 'artifactId must be the ID returned by artifactList.');
    const artifact = this.db.prepare('SELECT * FROM code_artifacts WHERE id=? AND job_id=?').get(artifactId, jobId);
    if (!artifact) throw new CodeJobError('NOT_FOUND', 'The artifact was not found for this job.');
    const fd = openSync(artifact.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const bytes = Buffer.alloc(Math.min(limit, Math.max(0, artifact.bytes - cursor)));
      readSync(fd, bytes, 0, bytes.length, cursor);
      const end = Math.min(artifact.bytes, cursor + bytes.length);
      return { jobId, artifactId, name: artifact.name, sha256: artifact.sha256, totalBytes: artifact.bytes,
        cursor, bytes: bytes.length, encoding: 'base64', content: bytes.toString('base64'), nextCursor: end, hasMore: end < artifact.bytes };
    } finally { closeSync(fd); }
  }

  async collect(job, final = false) {
    if (job.output_bytes >= CODE_JOB_LIMITS.logBytes) return;
    const existingCount = this.db.prepare("SELECT COUNT(*) AS count FROM code_records WHERE job_id=? AND stream!='system'").get(job.id).count;
    if (existingCount >= CODE_JOB_LIMITS.logRecords) return;
    const result = await this.runner.logs({ name: containerName(job.id), cursor: job.runner_cursor, fingerprint: job.log_fingerprint, limitBytes: 262144, final });
    this.store.transaction(() => {
      const current = this.row(job.owner, job.id);
      let bytes = current.output_bytes, truncated = Boolean(current.truncated || result.truncated), count = existingCount;
      for (const record of result.records) {
        const source = Buffer.from(record.text);
        const room = CODE_JOB_LIMITS.logBytes - bytes;
        if (room <= 0 || count >= CODE_JOB_LIMITS.logRecords) { truncated = true; break; }
        const selected = utf8Prefix(source, room);
        // Split large messages so one record never defeats the record-count page limit.
        for (let offset = 0; offset < selected.length;) {
          if (count >= CODE_JOB_LIMITS.logRecords) { truncated = true; break; }
          const chunk = utf8Prefix(selected.subarray(offset), 4096);
          this.record(job.id, record.stream, chunk.toString('utf8'), record.timestamp, record.partial || source.length > 4096);
          offset += chunk.length;
          bytes += chunk.length; count++;
        }
        if (source.length > selected.length || bytes >= CODE_JOB_LIMITS.logBytes || count >= CODE_JOB_LIMITS.logRecords) truncated = true;
      }
      this.db.prepare('UPDATE code_jobs SET runner_cursor=?,log_fingerprint=?,output_bytes=?,truncated=?,updated_at=? WHERE id=?')
        .run(result.cursor, result.fingerprint ?? null, bytes, truncated ? 1 : 0, this.clock(), job.id);
    });
    return result;
  }

  snapshotArtifacts(job, workspacePath) {
    const request = JSON.parse(job.request_json);
    const errors = [];
    let total = 0;
    const directory = join(this.dataDirectory, 'artifacts', job.id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    syncDirectory(join(this.dataDirectory, 'artifacts'));
    const root = realpathSync(workspacePath);
    for (const name of request.artifactPaths) {
      try {
        let path = root;
        for (const part of name.split('/')) {
          path = join(path, part);
          const stat = lstatSync(path);
          if (stat.isSymbolicLink()) throw new CodeJobError('UNSAFE_ARTIFACT', 'Artifact links are not allowed.');
        }
        const child = relative(root, realpathSync(path));
        if (!child || child.startsWith('..') || isAbsolute(child)) throw new CodeJobError('UNSAFE_ARTIFACT', 'The artifact is outside its workspace.');
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.nlink !== 1) throw new CodeJobError('UNSAFE_ARTIFACT', 'Artifacts must be ordinary files without links.');
        if (stat.size > CODE_JOB_LIMITS.artifactBytes || total + stat.size > CODE_JOB_LIMITS.artifactTotalBytes) throw new CodeJobError('ARTIFACT_LIMIT', 'Artifact retention limits were exceeded.');
        const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let bytes;
        try { bytes = Buffer.alloc(stat.size); readSync(fd, bytes, 0, bytes.length, 0); } finally { closeSync(fd); }
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const id = createHash('sha256').update(`${job.id}:${name}`).digest('hex');
        const destination = join(directory, id);
        durableFile(destination, bytes);
        syncDirectory(directory);
        this.db.prepare('INSERT OR IGNORE INTO code_artifacts(id,job_id,name,path,bytes,sha256,created_at) VALUES(?,?,?,?,?,?,?)')
          .run(id, job.id, name, destination, bytes.length, sha256, this.clock());
        total += bytes.length;
      } catch (error) { errors.push({ path: name, code: error.code === 'ENOENT' ? 'ARTIFACT_MISSING' : error.code ?? 'ARTIFACT_READ_FAILED' }); }
    }
    return errors;
  }

  async finish(job, state, forcedReason) {
    // Caller must first establish that the container is absent or has stopped.
    if (state.running) throw new CodeJobError('JOB_STILL_RUNNING', 'A running job cannot be finalized.');
    for (let count = 0; count < 8; count++) {
      const current = this.row(job.owner, job.id);
      if (current.output_bytes >= CODE_JOB_LIMITS.logBytes) break;
      const result = await this.collect(current, true);
      if (!result?.hasMore) break;
    }
    let revision = null, artifactErrors = [], executionError = job.execution_error;
    try {
      const workspace = this.workspaces.getExecutionWorkspace({ owner: job.owner, workspaceId: job.workspace_id });
      revision = workspace.revision;
      artifactErrors = this.snapshotArtifacts(job, workspace.path);
      const refreshed = await this.workspaces.refreshAfterJob({ owner: job.owner, workspaceId: job.workspace_id });
      revision = refreshed?.revision ?? this.workspaces.getExecutionWorkspace({ owner: job.owner, workspaceId: job.workspace_id }).revision;
    } catch (error) { executionError = error.code ?? 'WORKSPACE_REFRESH_FAILED'; }
    const latest = this.row(job.owner, job.id);
    const reason = forcedReason ?? latest.termination_reason ?? (state.oomKilled ? 'memory_limit' : 'exit');
    const status = reason === 'cancelled' ? 'cancelled' : reason === 'timeout' ? 'timed_out'
      : ['interrupted', 'timeout_inferred', 'exit_unconfirmed'].includes(reason) ? 'interrupted' : state.exitCode === 0 && !executionError ? 'completed' : 'failed';
    this.store.transaction(() => {
      const current = this.row(job.owner, job.id);
      if (!ACTIVE.includes(current.status)) return;
      const time = this.clock();
      this.db.prepare(`UPDATE code_jobs SET status=?,updated_at=?,finished_at=?,exit_code=?,signal=?,termination_reason=?,
        execution_error=?,revision_after=?,artifact_errors=? WHERE id=?`)
        .run(status, time, state.finishedAt ?? time, state.exitCode ?? null, state.signal ?? null, reason, executionError, revision, JSON.stringify(artifactErrors), job.id);
      this.record(job.id, 'system', `${status.toUpperCase()}${state.exitCode == null ? ' exit=unknown' : ` exit=${state.exitCode}`} reason=${reason}${state.monitorExitCode == null ? '' : ` monitorExit=${state.monitorExitCode}`}`, time);
    });
    // Metadata and copied output are already durable. Cleanup failure leaves diagnostic material.
    if (status !== 'interrupted' && state.exitCode != null) {
      try { await this.runner.remove({ name: containerName(job.id) }); } catch { /* Retain; never erase a running or ambiguous container. */ }
    }
  }

  async reconcile(job, { startup = false } = {}) {
    const name = containerName(job.id);
    const state = await this.runner.inspect({ name });
    if (!state.exists) { await this.finish(job, state, 'interrupted'); return; }
    if (job.execution_error && /^(RUNNER_|CONTAINER_)/.test(job.execution_error)) {
      // A control-call error is superseded by observed container state, not mistaken for command failure.
      this.db.prepare('UPDATE code_jobs SET execution_error=NULL WHERE id=?').run(job.id);
      job = this.row(job.owner, job.id);
    }
    if (state.running) {
      this.db.prepare("UPDATE code_jobs SET status=CASE WHEN status='canceling' THEN status ELSE 'running' END,container_id=?,started_at=COALESCE(started_at,?),updated_at=? WHERE id=?")
        .run(state.id ?? job.container_id, state.startedAt ?? job.started_at ?? this.clock(), this.clock(), job.id);
      return;
    }
    if (['created', 'configured'].includes(state.status)) {
      // Even a saved creation is never promoted to another start during recovery.
      await this.finish(job, state, 'interrupted'); return;
    }
    const timeout = JSON.parse(job.request_json).timeoutSeconds;
    const elapsed = state.startedAt && state.finishedAt ? Date.parse(state.finishedAt) - Date.parse(state.startedAt) : 0;
    const monitorExitCode = state.monitorExitCode ?? state.exitCode;
    // Conmon can report -1 when its independent timer fires. Timing plus this sentinel supports an inference,
    // not a claimed POSIX exit status or proof that the worker itself requested termination.
    const reason = job.termination_reason ?? (monitorExitCode === -1 && elapsed >= timeout * 1000 ? 'timeout_inferred'
      : state.exitCode == null ? 'exit_unconfirmed' : undefined);
    await this.finish(job, state, reason);
  }

  async recover() {
    if (this.busy || PROCESS_WORK.has(this.dataDirectory)) return;
    this.busy = true;
    PROCESS_WORK.add(this.dataDirectory);
    try {
      this.acquireRunner();
      for (const job of this.db.prepare(`SELECT * FROM code_jobs WHERE status IN ${ACTIVE_SQL} AND status!='queued' ORDER BY row_id`).all()) {
        // An unavailable runtime keeps the job active and locked; failure is not evidence of absence.
        try { await this.reconcile(job, { startup: true }); }
        catch (error) { this.db.prepare('UPDATE code_jobs SET execution_error=?,updated_at=? WHERE id=?').run(error.code ?? 'RUNNER_UNAVAILABLE', this.clock(), job.id); }
      }
    } finally { this.busy = false; PROCESS_WORK.delete(this.dataDirectory); }
  }

  async tick() {
    if (this.busy || PROCESS_WORK.has(this.dataDirectory)) return;
    this.busy = true;
    PROCESS_WORK.add(this.dataDirectory);
    let job;
    try {
      this.acquireRunner();
      job = this.db.prepare(`SELECT * FROM code_jobs WHERE status IN ${ACTIVE_SQL} ORDER BY row_id LIMIT 1`).get();
      if (!job) return;
      if (job.status === 'queued') {
        this.store.transaction(() => {
          this.db.prepare("UPDATE code_jobs SET status='starting',updated_at=? WHERE id=? AND status='queued'").run(this.clock(), job.id);
          this.record(job.id, 'system', 'STARTING');
        });
        job = this.row(job.owner, job.id);
        const request = JSON.parse(job.request_json);
        let workspace;
        try { workspace = this.workspaces.getExecutionWorkspace({ owner: job.owner, workspaceId: job.workspace_id }); }
        catch (error) {
          this.db.prepare('UPDATE code_jobs SET execution_error=? WHERE id=?').run(error.code ?? 'WORKSPACE_UNAVAILABLE', job.id);
          await this.finish(this.row(job.owner, job.id), { exists: false }, 'interrupted'); return;
        }
        if (workspace.revision !== request.expectedRevision) {
          this.db.prepare("UPDATE code_jobs SET execution_error='STALE_REVISION' WHERE id=?").run(job.id);
          await this.finish(this.row(job.owner, job.id), { exists: false }, 'interrupted'); return;
        }
        const created = await this.runner.create({ job: { id: job.id, ...request }, workspacePath: workspace.path });
        this.db.prepare('UPDATE code_jobs SET container_id=?,launch_intent_at=?,updated_at=?,runner_cursor=?,log_fingerprint=? WHERE id=?')
          .run(created.id, this.clock(), this.clock(), created.logCursor ?? 0, created.logFingerprint ?? null, job.id);
        // Cancellation can arrive while create awaits. A created-but-unstarted container is safe to retain/finish.
        job = this.row(job.owner, job.id);
        if (job.cancel_requested) { await this.finish(job, { exists: true, status: 'created', exitCode: null }, 'cancelled'); return; }
        await this.runner.start({ name: containerName(job.id) });
        this.db.prepare("UPDATE code_jobs SET status=CASE WHEN cancel_requested=1 THEN 'canceling' ELSE 'running' END,started_at=COALESCE(started_at,?),updated_at=? WHERE id=?").run(this.clock(), this.clock(), job.id);
        this.record(job.id, 'system', 'RUNNING');
      }
      job = this.row(job.owner, job.id);
      const state = await this.runner.inspect({ name: containerName(job.id) });
      if (!state.exists || !state.running) { await this.reconcile(job); return; }
      // Once published, startedAt is stable across later observations and recovery.
      if (state.startedAt && !job.started_at) {
        this.db.prepare('UPDATE code_jobs SET started_at=COALESCE(started_at,?) WHERE id=?').run(state.startedAt, job.id);
        job = this.row(job.owner, job.id);
      }
      await this.collect(job);
      const timeout = JSON.parse(job.request_json).timeoutSeconds;
      // Enforce the runtime's actual deadline even when its start preceded our acknowledgement.
      const runtimeStartedAt = state.startedAt ?? job.started_at;
      const expired = runtimeStartedAt && Date.parse(this.clock()) >= Date.parse(runtimeStartedAt) + timeout * 1000;
      const latest = this.row(job.owner, job.id);
      if (latest.cancel_requested || expired) {
        const reason = latest.cancel_requested ? 'cancelled' : 'timeout';
        this.db.prepare("UPDATE code_jobs SET status='canceling',termination_reason=?,updated_at=? WHERE id=?").run(reason, this.clock(), job.id);
        await this.runner.stop({ name: containerName(job.id) });
        await this.reconcile(this.row(job.owner, job.id));
      }
    } catch (error) {
      if (job) {
        this.db.prepare('UPDATE code_jobs SET execution_error=?,updated_at=? WHERE id=?').run(error.code ?? 'RUNNER_UNAVAILABLE', this.clock(), job.id);
        try { await this.reconcile(this.row(job.owner, job.id)); } catch { /* Leave active and locked until runtime state is known. */ }
      } else throw error;
    } finally { this.busy = false; PROCESS_WORK.delete(this.dataDirectory); }
  }
}
