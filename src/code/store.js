import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Private local state. All cooperating writers share BEGIN IMMEDIATE locks. */
export class CodeStore {
  constructor(dataDirectory) {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDirectory, 'coding.sqlite'));
    this.db.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;`);
    this.depth = 0;
  }

  transaction(action) {
    if (this.depth) return action();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const result = action();
      if (result && typeof result.then === 'function') throw new TypeError('CodeStore transactions must be synchronous.');
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.depth--;
    }
  }

  close() { this.db.close(); }
}
