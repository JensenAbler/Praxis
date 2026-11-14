import test from 'node:test';
import assert from 'node:assert/strict';
import { readPageLimit } from '../src/code/host.js';
import { hostTools } from '../src/code/host-schema.js';

test('host_file_read has no fixed page ceiling in its schema', () => {
  const parsed = hostTools.host_file_read.schema.parse({ path: '/tmp/x', maxBytes: 64 * 1024 * 1024, encoding: 'base64' });
  assert.equal(parsed.maxBytes, 64 * 1024 * 1024);
});

test('page limit follows available memory, not a constant', () => {
  const gib = 1024 ** 3;
  // 4 GiB free -> half for headroom, /9 wire amplification, 3/4 for base64.
  assert.equal(readPageLimit('base64', 4 * gib), Math.floor(Math.floor(4 * gib * 0.5 / 9) * 3 / 4));
  assert.ok(readPageLimit('base64', 4 * gib) > 100 * 1024 * 1024);
  assert.ok(readPageLimit('utf8', 4 * gib) < readPageLimit('base64', 4 * gib));
  assert.equal(readPageLimit('base64', 0), 4);
});
