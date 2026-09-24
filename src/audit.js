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
  // view=tail starts at the newest record and pages backward (cursor 0 = newest;
  // otherwise records before that sequence), each page in chronological order.
  list(owner, cursor = 0, limit = 20, view = 'head') {
    const tail = view === 'tail';
    const rows = tail
      ? this.db.prepare('SELECT seq,recorded_at,body FROM observations WHERE owner=? AND (?=0 OR seq<?) ORDER BY seq DESC LIMIT ?').all(owner, cursor, cursor, limit + 1)
      : this.db.prepare('SELECT seq,recorded_at,body FROM observations WHERE owner=? AND seq>? ORDER BY seq LIMIT ?').all(owner, cursor, limit + 1);
    const page = tail ? rows.slice(0, limit).reverse() : rows.slice(0, limit);
    return {
      observations: page.map(row => ({ sequence: row.seq, recordedAt: row.recorded_at, ...JSON.parse(row.body) })),
      nextCursor: (tail ? page[0]?.seq : page.at(-1)?.seq) ?? cursor, view,
      hasMore: rows.length > limit,
      retention: 'Most recent 10001 observations; diagnostic telemetry only.'
    };
  }
  close() { this.db.close(); }
}
