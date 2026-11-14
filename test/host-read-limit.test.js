import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPageLimit } from '../src/code/host.js';
import { hostTools } from '../src/code/host-schema.js';

test('host_file_read pageBytes has no fixed ceiling; maxBytes keeps its legacy schema', () => {
  const parsed = hostTools.host_file_read.schema.parse({ path: '/tmp/x', pageBytes: 64 * 1024 * 1024, encoding: 'base64' });
  assert.equal(parsed.pageBytes, 64 * 1024 * 1024);
  assert.equal(parsed.maxBytes, 16384);
  assert(!hostTools.host_file_read.schema.safeParse({ path: '/tmp/x', maxBytes: 262145 }).success);
});

test('page limit follows available memory, not a constant', () => {
  const gib = 1024 ** 3;
  // 4 GiB free -> half for headroom, /9 wire amplification, 3/4 for base64.
  assert.equal(readPageLimit('base64', 4 * gib), Math.floor(Math.floor(4 * gib * 0.5 / 9) * 3 / 4));
  assert.ok(readPageLimit('base64', 4 * gib) > 100 * 1024 * 1024);
  assert.ok(readPageLimit('utf8', 4 * gib) < readPageLimit('base64', 4 * gib));
  assert.equal(readPageLimit('base64', 0), 4);
});

test('a pageBytes read returns more than the legacy 256 KiB in one page', async () => {
  const { HostAccess } = await import('../src/code/host.js');
  const dir = mkdtempSync(join(tmpdir(), 'praxis-read-')), file = join(dir, 'big.bin');
  writeFileSync(file, Buffer.alloc(1024 * 1024, 7));
  const host = Object.create(HostAccess.prototype);
  host.resolvePath = args => args.path;
  const page = await host.fileRead({ path: file, pageBytes: 1024 * 1024, encoding: 'base64' });
  assert.equal(page.bytesRead, Math.min(1024 * 1024, readPageLimit('base64')));
  assert.equal(page.effectiveMaxBytes, Math.min(1024 * 1024, readPageLimit('base64')));
  assert(hostTools.host_file_read.schema.safeParse({ path: file, pageSize: '1048576' }).success);
  assert(!hostTools.host_file_read.schema.safeParse({ path: file, pageSize: '12abc' }).success);
  const viaString = await host.fileRead({ path: file, pageSize: '1048576', encoding: 'base64' });
  assert.equal(viaString.bytesRead, page.bytesRead);
});
