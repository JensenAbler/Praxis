import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchToolManifest } from '../src/tool-manifest.js';
import { AuditStore } from '../src/audit.js';

const manifest = names => JSON.stringify({ version: 1, tools: names.map(name => ({ name, title: name, description: name, write: false, destructive: false,
  inputSchema: { type: 'object', properties: {} } })) });

test('a long-running gateway picks up a release that swaps the manifest, and keeps the last good tools', t => {
  const root = mkdtempSync(join(tmpdir(), 'praxis-manifest-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const release = (name, body) => { mkdirSync(join(root, name)); writeFileSync(join(root, name, 'coding-tools.json'), body); return join(root, name); };
  const activate = target => { symlinkSync(target, join(root, 'next')); renameSync(join(root, 'next'), join(root, 'current')); };
  activate(release('old', manifest(['job_status'])));
  const errors = [], tools = watchToolManifest(join(root, 'current', 'coding-tools.json'), { onError: error => errors.push(error) });
  assert.deepEqual(Object.keys(tools()), ['job_status']);
  activate(release('new', manifest(['job_status', 'job_wait'])));
  assert.deepEqual(Object.keys(tools()), ['job_status', 'job_wait'], 'a swapped release is visible without a restart');
  activate(release('broken', '{"version": 1, "tools": []}'));
  assert.deepEqual(Object.keys(tools()), ['job_status', 'job_wait'], 'a broken manifest keeps the last good tools');
  assert.equal(errors.length, 1);
});

test('observation tail starts at the newest records and pages backward', t => {
  const root = mkdtempSync(join(tmpdir(), 'praxis-audit-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const audit = new AuditStore(root); t.after(() => audit.close());
  for (let index = 1; index <= 7; index++) audit.record('jensen', { requestId: `r${index}`, tool: `t${index}` });
  audit.record('someone-else', { requestId: 'x', tool: 'other' });
  const newest = audit.list('jensen', 0, 3, 'tail');
  assert.deepEqual(newest.observations.map(row => row.tool), ['t5', 't6', 't7']);
  assert.equal(newest.hasMore, true);
  const older = audit.list('jensen', newest.nextCursor, 3, 'tail');
  assert.deepEqual(older.observations.map(row => row.tool), ['t2', 't3', 't4']);
  const oldest = audit.list('jensen', older.nextCursor, 3, 'tail');
  assert.deepEqual(oldest.observations.map(row => row.tool), ['t1']);
  assert.equal(oldest.hasMore, false);
  assert.deepEqual(audit.list('jensen', 0, 2).observations.map(row => row.tool), ['t1', 't2'], 'head is unchanged');
});
