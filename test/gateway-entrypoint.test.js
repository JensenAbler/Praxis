import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('gateway launched through the control release link enters startup instead of silently exiting', () => {
  const directory = mkdtempSync(join(tmpdir(), 'praxis-gateway-entry-'));
  const current = join(directory, 'current');
  try {
    symlinkSync(fileURLToPath(new URL('../', import.meta.url)), current, process.platform === 'win32' ? 'junction' : 'dir');
    const result = spawnSync(process.execPath, [join(current, 'src', 'server.js')], {
      env: { ...process.env, CREDENTIALS_DIRECTORY: '', PRAXIS_CREDENTIALS_DIR: '' },
      encoding: 'utf8', timeout: 15000, windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Protected credential directory is required/);
  } finally {
    unlinkSync(current);
    rmSync(directory, { recursive: true, force: true });
  }
});
