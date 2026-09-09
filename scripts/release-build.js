/** Installed build driver. Execute only in the separate staging unit. */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

if (process.getuid?.() === 0) throw new Error('Candidate builds cannot run as root');
const cwd = resolve(process.argv[2] || '');
for (const [command, args] of [
  [process.execPath, ['/usr/local/lib/praxis/registry-relay.mjs', 'npm', 'ci', '--no-audit', '--no-fund']],
  ['npm', ['test']],
  [process.execPath, ['scripts/export-tool-manifest.js', 'coding-tools.json']]
]) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', timeout: 750000, env: { ...process.env, NODE_ENV: 'test', CI: 'true' } });
  if (result.error || result.status !== 0) process.exit(1);
}
