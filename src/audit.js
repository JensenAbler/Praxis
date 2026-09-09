import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class AuditStore {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'observations.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS observations (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL,
        request_id TEXT NOT NULL, recorded_at TEXT NOT NULL, body TEXT NOT NULL
      );`);
  }
  record(owner, record) {
    this.db.prepare('INSERT INTO observations(owner,request_id,recorded_at,body) VALUES(?,?,?,?)')
      .run(owner, record.requestId, new Date().toISOString(), JSON.stringify(record));
    // Bounded diagnostic telemetry; job evidence has its own retention policy.
    this.db.exec('DELETE FROM observations WHERE seq < (SELECT COALESCE(MAX(seq),0)-10000 FROM observations)');
  }
  list(owner, cursor = 0, limit = 20) {
    const rows = this.db.prepare('SELECT seq,recorded_at,body FROM observations WHERE owner=? AND seq>? ORDER BY seq LIMIT ?')
      .all(owner, cursor, limit + 1);
    const page = rows.slice(0, limit);
    return {
      observations: page.map(row => ({ sequence: row.seq, recordedAt: row.recorded_at, ...JSON.parse(row.body) })),
      nextCursor: page.at(-1)?.seq ?? cursor,
      hasMore: rows.length > limit,
      retention: 'Most recent 10001 observations; diagnostic telemetry only.'
    };
  }
  close() { this.db.close(); }
}
