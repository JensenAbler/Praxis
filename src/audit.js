import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeObservation, summarizeUsage } from './usage-telemetry.js';

export class AuditStore {
  constructor(directory, { maxRecords = 10000, maxAgeDays = 30 } = {}) {
    if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 10000 || !Number.isFinite(maxAgeDays) || maxAgeDays <= 0 || maxAgeDays > 30) throw new RangeError('Invalid telemetry retention');
    this.maxRecords = maxRecords; this.maxAgeDays = maxAgeDays;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'observations.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=50; PRAGMA journal_size_limit=1048576; PRAGMA wal_autocheckpoint=256; PRAGMA max_page_count=8192;
      CREATE TABLE IF NOT EXISTS observations (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL,
        request_id TEXT NOT NULL, recorded_at TEXT NOT NULL, body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS observations_age ON observations(recorded_at);`);
  }
  prune() {
    this.db.prepare('DELETE FROM observations WHERE recorded_at < ?').run(new Date(Date.now()-this.maxAgeDays*86400000).toISOString());
    this.db.prepare('DELETE FROM observations WHERE seq <= (SELECT COALESCE(MAX(seq),0)-? FROM observations)').run(this.maxRecords);
  }
  record(owner, record) {
    record = sanitizeObservation(record);
    this.db.prepare('INSERT INTO observations(owner,request_id,recorded_at,body) VALUES(?,?,?,?)')
      .run(owner, record.requestId, new Date().toISOString(), JSON.stringify(record));
    // Bounded diagnostic telemetry; job evidence has its own retention policy.
    this.prune();
  }
  // view=tail starts at the newest record and pages backward (cursor 0 = newest;
  // otherwise records before that sequence), each page in chronological order.
  list(owner, cursor = 0, limit = 20, view = 'head') {
    this.prune();
    limit = Math.max(1, Math.min(100, Math.floor(limit) || 20));
    const tail = view === 'tail';
    const rows = tail
      ? this.db.prepare('SELECT seq,recorded_at,body FROM observations WHERE owner=? AND (?=0 OR seq<?) ORDER BY seq DESC LIMIT ?').all(owner, cursor, cursor, limit + 1)
      : this.db.prepare('SELECT seq,recorded_at,body FROM observations WHERE owner=? AND seq>? ORDER BY seq LIMIT ?').all(owner, cursor, limit + 1);
    const page = tail ? rows.slice(0, limit).reverse() : rows.slice(0, limit);
    return {
      observations: page.map(row => ({ sequence: row.seq, recordedAt: row.recorded_at, ...sanitizeObservation(JSON.parse(row.body)) })),
      nextCursor: (tail ? page[0]?.seq : page.at(-1)?.seq) ?? cursor, view,
      hasMore: rows.length > limit,
      retention: 'Most recent 10000 observations, at most 30 days; diagnostic telemetry only.'
    };
  }
  summary(owner, { days = 7, limit = 20 } = {}) {
    if (!Number.isInteger(days) || days < 1 || days > 30 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new RangeError('Invalid report bounds');
    this.prune();
    const since = new Date(Date.now()-days*86400000).toISOString();
    const rows = this.db.prepare('SELECT recorded_at,body FROM observations WHERE owner=? AND recorded_at>=? ORDER BY seq LIMIT 10000').all(owner, since);
    return { usage: summarizeUsage(rows, limit), window: { requestedDays: days, since, oldestRetainedAt: rows[0]?.recorded_at ?? null,
      newestRetainedAt: rows.at(-1)?.recorded_at ?? null, observationsScanned: rows.length },
      retention: { maxRecords: this.maxRecords, maxAgeDays: this.maxAgeDays },
      privacy: 'Local only. No arguments, command/file contents, tokens, user payloads, identifiers for workflows, or third-party analytics.' };
  }
  close() { this.db.close(); }
}
