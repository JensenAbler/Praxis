import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { currentManifest, manifestProblems, LIVE_MANIFEST } from '../scripts/check-manifest-compat.js';

const tool = (properties, required = []) => ({ name: 'demo', write: false, destructive: false, inputSchema: { type: 'object', properties, required } });
const base = tool({ id: { type: 'string' }, limit: { type: 'integer' } }, ['id']);

test('manifest gate matches the updater: additions pass, changes and new requirements fail', () => {
  assert.deepEqual(manifestProblems({ tools: [base] }, { tools: [tool({ limit: { type: 'integer' }, id: { type: 'string' }, extra: { type: 'boolean' } }, ['id']), { ...base, name: 'other' }] }), []);
  assert.match(manifestProblems({ tools: [base] }, { tools: [tool({ id: { type: 'string' }, limit: { type: 'integer', maximum: 5 } }, ['id'])] })[0], /changed: demo.limit/);
  assert.match(manifestProblems({ tools: [base] }, { tools: [tool({ id: { type: 'string' }, limit: { type: 'integer' }, extra: { type: 'boolean', default: false } }, ['id', 'extra'])] })[0], /required.*demo.extra/);
  assert.match(manifestProblems({ tools: [base] }, { tools: [] })[0], /disappeared: demo/);
  assert.match(manifestProblems({ tools: [base] }, { tools: [{ ...base, write: true }] })[0], /annotation/);
});

// On Alpha (a Praxis workspace job or a release-plan build) this is the updater's
// own check against the live release, run before anything is pushed or built.
test('current tool schemas are a routine update of the live release manifest', { skip: !existsSync(LIVE_MANIFEST) && 'no live manifest on this host' }, () => {
  assert.deepEqual(manifestProblems(JSON.parse(readFileSync(LIVE_MANIFEST, 'utf8')), currentManifest()), []);
});
