/** One-time owner-authorized migration. Dry-run by default; never prints credentials. */
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

export function migrateAuthSessions(db, resource, { apply = false, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  if (new URL(resource).href !== resource) throw new Error('Expected canonical resource URL');
  db.exec('BEGIN IMMEDIATE');
  try {
    const candidates = db.prepare(`SELECT token.id, token.payload FROM records token
      JOIN records authorization ON authorization.model='Grant' AND authorization.id=token.grant_id
      WHERE token.model='RefreshToken' AND token.expires>? AND authorization.expires>?
        AND json_extract(token.payload,'$.expiresWithSession')=1
        AND json_extract(token.payload,'$.accountId')='jensen'
        AND json_extract(authorization.payload,'$.accountId')='jensen'
        AND json_extract(token.payload,'$.clientId')=json_extract(authorization.payload,'$.clientId')
        AND json_extract(token.payload,'$.resource')=?
        AND json_extract(token.payload,'$.grantId')=authorization.id`).all(timestamp, timestamp, resource);
    let eligible = 0;
    for (const row of candidates) {
      const token = JSON.parse(row.payload);
      const grant = JSON.parse(db.prepare("SELECT payload FROM records WHERE model='Grant' AND id=?").get(token.grantId).payload);
      const granted = new Set((grant.resources?.[resource] || '').split(' '));
      const scopes = (token.scope || '').split(' ').filter(scope => scope.startsWith('praxis:'));
      if (!scopes.length || !scopes.every(scope => granted.has(scope))) continue;
      eligible++;
      // Retain consumed records too: token reuse must still revoke the family after session expiry.
      if (apply) db.prepare("UPDATE records SET payload=json_set(payload,'$.expiresWithSession',json('false')) WHERE model='RefreshToken' AND id=?").run(row.id);
    }
    db.exec('COMMIT');
    return { eligible, updated: apply ? eligible : 0, dryRun: !apply };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [database, resource, flag] = process.argv.slice(2);
  if (!database || !resource || (flag && flag !== '--apply')) throw new Error('Usage: migrate-auth-sessions.js DATABASE RESOURCE [--apply]');
  const db = new DatabaseSync(database);
  db.exec('PRAGMA busy_timeout=5000');
  try { console.log(JSON.stringify(migrateAuthSessions(db, resource, { apply: flag === '--apply' }))); }
  finally { db.close(); }
}
