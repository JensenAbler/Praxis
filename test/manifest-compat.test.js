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

test('routing migration preserves legacy meaning and routine updates cannot retarget tools', () => {
  const previous = { tools: [base] };
  const routed = { ...base, route: { target: 'coding', action: 'demo' } };
  assert.deepEqual(manifestProblems(previous, { tools: [routed] }), []);
  assert.deepEqual(manifestProblems({ tools: [routed] }, previous), [], 'legacy shorthand has identical meaning');
  for (const route of [{ target: 'git', action: 'list' }, { target: 'coding', action: 'other' }])
    assert.match(manifestProblems(previous, { tools: [{ ...routed, route }] }).join(), /route changed/);
  for (const route of [{ target: 'updater', action: 'apply' }, { target: 'git', action: 'releaseApply' },
    { target: 'coding', action: 'praxis_release_apply' }, { target: 'git', action: 'list', url: 'http://other' }])
    assert.match(manifestProblems({ tools: [] }, { tools: [{ ...base, route }] }).join(), /Invalid tool route/);
});
