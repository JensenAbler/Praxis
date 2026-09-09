import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const TERMINAL = new Set(['completed', 'cancelled', 'interrupted', 'failed']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class JobError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobError';
    this.code = code;
  }
}

function requireValue(condition, message) {
  if (!condition) throw new JobError('VALIDATION_ERROR', message);
}

function validateOwner(owner) {
  requireValue(typeof owner === 'string' && owner.length > 0 && owner.length <= 100, 'A valid owner is required.');
}

function validateJobId(jobId) {
  requireValue(typeof jobId === 'string' && UUID.test(jobId), 'jobId must be a UUID.');
}

function validatePage(cursor, limit, maximum) {
  requireValue(Number.isSafeInteger(cursor) && cursor >= 0, 'cursor must be a non-negative safe integer.');
  requireValue(Number.isSafeInteger(limit) && limit >= 1 && limit <= maximum, `limit must be between 1 and ${maximum}.`);
}

function publicJob(row) {
  return {
    id: row.id,
    label: row.label,
    status: row.status,
    durationSeconds: row.duration_seconds,
    intervalSeconds: row.interval_seconds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    cancellationRequested: Boolean(row.cancellation_requested),
  };
}

/** One host, one shared local SQLite database; never place this directory on NFS. */
export class JobStore {
  constructor(dataDirectory) {
    requireValue(typeof dataDirectory === 'string' && dataDirectory.length > 0, 'A data directory is required.');
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDirectory, 'probe.sqlite'));
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS jobs (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        owner TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_json TEXT NOT NULL,
        label TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL,
        interval_seconds INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued','running','completed','cancelled','interrupted','failed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        cancellation_requested INTEGER NOT NULL DEFAULT 0,
        worker_id TEXT,
        UNIQUE(owner, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS jobs_owner_recent ON jobs(owner, row_id DESC);
      CREATE TABLE IF NOT EXISTS records (
        job_id TEXT NOT NULL REFERENCES jobs(id),
        sequence INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        PRIMARY KEY(job_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS worker_lock (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        pid INTEGER NOT NULL,
        token TEXT NOT NULL
      );
    `);
  }

  close() { this.db.close(); }

  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  ownedRow(owner, jobId) {
    validateOwner(owner);
    validateJobId(jobId);
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ? AND owner = ?').get(jobId, owner);
    if (!row) throw new JobError('NOT_FOUND', 'Job not found.');
    return row;
  }

  start({ owner, idempotencyKey, label = '', durationSeconds = 120, intervalSeconds = 5 }) {
    validateOwner(owner);
    requireValue(typeof idempotencyKey === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey), 'idempotencyKey must contain 1–128 letters, numbers, dots, underscores, colons, or hyphens.');
    requireValue(typeof label === 'string' && label.length <= 80 && !/[\x00-\x1f\x7f]/.test(label), 'label must be at most 80 characters without control characters.');
    requireValue(Number.isInteger(durationSeconds) && durationSeconds >= 1 && durationSeconds <= 180, 'durationSeconds must be an integer between 1 and 180.');
    requireValue(Number.isInteger(intervalSeconds) && intervalSeconds >= 1 && intervalSeconds <= 10, 'intervalSeconds must be an integer between 1 and 10.');
    const request = JSON.stringify({ label, durationSeconds, intervalSeconds });
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM jobs WHERE owner = ? AND idempotency_key = ?').get(owner, idempotencyKey);
      if (previous) {
        if (previous.request_json !== request) throw new JobError('IDEMPOTENCY_CONFLICT', 'This idempotency key was already used with different arguments.');
        return publicJob(previous);
      }
      if (this.db.prepare("SELECT 1 FROM jobs WHERE status IN ('queued','running') LIMIT 1").get()) {
        throw new JobError('ACTIVE_JOB_LIMIT', 'One probe job is already active. Wait for completion or cancel it.');
      }
      if (this.db.prepare('SELECT COUNT(*) AS count FROM jobs').get().count >= 1000) {
        throw new JobError('JOB_QUOTA_EXCEEDED', 'The diagnostic fixture has reached its 1,000-job retention limit. An operator must archive it before more jobs can start.');
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO jobs
        (id, owner, idempotency_key, request_json, label, duration_seconds, interval_seconds, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`)
        .run(id, owner, idempotencyKey, request, label, durationSeconds, intervalSeconds, now, now);
      return publicJob(this.ownedRow(owner, id));
    });
  }

  get({ owner, jobId }) { return publicJob(this.ownedRow(owner, jobId)); }

  list({ owner, limit = 20, cursor = 0 }) {
    validateOwner(owner);
    validatePage(cursor, limit, 50);
    const rows = this.db.prepare('SELECT * FROM jobs WHERE owner = ? AND (? = 0 OR row_id < ?) ORDER BY row_id DESC LIMIT ?')
      .all(owner, cursor, cursor, limit + 1);
    const selected = rows.slice(0, limit);
    return { jobs: selected.map(publicJob), nextCursor: rows.length > limit ? selected.at(-1).row_id : null };
  }

  logs({ owner, jobId, cursor = 0, limit = 50 }) {
    validatePage(cursor, limit, 100);
    // Capture status and records from one SQLite snapshot, including across worker writes.
    return this.transaction(() => {
      const row = this.ownedRow(owner, jobId);
      const records = this.db.prepare('SELECT record_json FROM records WHERE job_id = ? AND sequence > ? ORDER BY sequence LIMIT ?')
        .all(jobId, cursor, limit).map((record) => JSON.parse(record.record_json));
      return { jobId, status: row.status, records, nextCursor: records.at(-1)?.sequence ?? cursor };
    });
  }

  cancel({ owner, jobId }) {
    return this.transaction(() => {
      const row = this.ownedRow(owner, jobId);
      if (TERMINAL.has(row.status) || row.cancellation_requested) return publicJob(row);
      const now = new Date().toISOString();
      if (row.status === 'queued') {
        this.db.prepare("UPDATE jobs SET status = 'cancelled', cancellation_requested = 1, updated_at = ?, finished_at = ? WHERE id = ?")
          .run(now, now, jobId);
        this.appendRecord(jobId, 'CANCELLED', 0, { reason: 'Cancelled before execution.' });
      } else {
        this.db.prepare('UPDATE jobs SET cancellation_requested = 1, updated_at = ? WHERE id = ?').run(now, jobId);
      }
      return publicJob(this.ownedRow(owner, jobId));
    });
  }

  // Worker-only methods below are deliberately not MCP tools. Call under a transaction.
  acquireWorker(workerId) {
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM worker_lock WHERE singleton = 1').get();
      if (previous) {
        let alive = true;
        try { process.kill(previous.pid, 0); } catch (error) {
          if (error.code === 'ESRCH') alive = false;
          else throw new JobError('WORKER_BUSY', 'The previous worker process could not be inspected.');
        }
        if (alive) throw new JobError('WORKER_BUSY', 'Another worker process already holds this data directory.');
      }
      this.db.prepare('INSERT OR REPLACE INTO worker_lock (singleton, pid, token) VALUES (1, ?, ?)').run(process.pid, workerId);
    });
  }

  releaseWorker(workerId) {
    this.db.prepare('DELETE FROM worker_lock WHERE singleton = 1 AND token = ?').run(workerId);
  }

  appendRecord(jobId, event, elapsedSeconds, extra = {}) {
    const sequence = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM records WHERE job_id = ?').get(jobId).next;
    const record = { sequence, event, runId: jobId, utc: new Date().toISOString(), elapsedSeconds: Number(elapsedSeconds.toFixed(6)), ...extra };
    this.db.prepare('INSERT INTO records (job_id, sequence, record_json) VALUES (?, ?, ?)').run(jobId, sequence, JSON.stringify(record));
    return record;
  }

  interruptRunning() {
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM jobs WHERE status = 'running'").all();
      for (const row of rows) {
        const now = new Date().toISOString();
        const elapsed = Math.max(0, (Date.now() - Date.parse(row.started_at)) / 1000);
        this.db.prepare("UPDATE jobs SET status = 'interrupted', updated_at = ?, finished_at = ? WHERE id = ?").run(now, now, row.id);
        this.appendRecord(row.id, 'INTERRUPTED', elapsed, { reason: 'The previous worker exited without recording a terminal result.' });
      }
      return rows.length;
    });
  }

  claimNext(workerId) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY row_id LIMIT 1").get();
      if (!row) return null;
      const now = new Date().toISOString();
      this.db.prepare("UPDATE jobs SET status = 'running', worker_id = ?, started_at = ?, updated_at = ? WHERE id = ?")
        .run(workerId, now, now, row.id);
      this.appendRecord(row.id, 'STARTED', 0);
      return publicJob(this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(row.id));
    });
  }

  workerStep({ jobId, workerId, elapsedSeconds, heartbeat = null, finish = null, reason = undefined }) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM jobs WHERE id = ? AND worker_id = ? AND status = 'running'").get(jobId, workerId);
      if (!row) return { active: false };
      if (row.cancellation_requested) finish = 'cancelled';
      if (heartbeat !== null && finish !== 'cancelled' && finish !== 'interrupted' && finish !== 'failed') {
        this.appendRecord(jobId, 'HEARTBEAT', elapsedSeconds, { heartbeat });
      }
      const now = new Date().toISOString();
      if (finish) {
        if (!TERMINAL.has(finish)) throw new Error('Invalid worker terminal status.');
        this.appendRecord(jobId, finish.toUpperCase(), elapsedSeconds, reason ? { reason } : {});
        this.db.prepare('UPDATE jobs SET status = ?, updated_at = ?, finished_at = ? WHERE id = ?').run(finish, now, now, jobId);
      } else if (heartbeat !== null) {
        this.db.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').run(now, jobId);
      }
      return { active: !finish, status: finish || 'running' };
    });
  }
}
