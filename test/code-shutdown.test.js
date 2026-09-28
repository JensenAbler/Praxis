import test from 'node:test';
import assert from 'node:assert/strict';
import { gracefulShutdown } from '../src/code/server.js';

const quiet = { error() {} };
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

function fakeHttp({ inFlight = false } = {}) {
  const calls = [];
  let onClosed;
  return {
    calls,
    close(callback) { calls.push('close'); onClosed = callback; if (!inFlight) setImmediate(callback); },
    closeIdleConnections() { calls.push('idle'); },
    closeAllConnections() { calls.push('all'); if (onClosed) setImmediate(onClosed); }
  };
}

test('a requested stop exits 0 once the server and service close', async () => {
  const exits = [], http = fakeHttp();
  let closed = 0;
  const stop = gracefulShutdown({ http, service: { async close() { closed++; } }, exit: code => exits.push(code), log: quiet, graceMs: 50, deadlineMs: 200 });
  stop(); stop();
  await tick(20);
  assert.deepEqual(exits, [0]); assert.equal(closed, 1); assert.deepEqual(http.calls, ['close', 'idle']);
  await tick(250);
  assert.deepEqual(exits, [0], 'the deadline is cancelled after a clean close');
});

test('an open long poll is cut after the grace period instead of hitting the deadline', async () => {
  const exits = [], http = fakeHttp({ inFlight: true });
  gracefulShutdown({ http, service: { async close() {} }, exit: code => exits.push(code), log: quiet, graceMs: 30, deadlineMs: 300 })();
  await tick(10);
  assert.deepEqual(exits, []);
  await tick(60);
  assert.deepEqual(exits, [0]); assert.ok(http.calls.includes('all'));
});

test('a failing service close is logged and still exits 0', async () => {
  const exits = [], logged = [];
  gracefulShutdown({ http: fakeHttp(), service: { async close() { throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' }); } },
    exit: code => exits.push(code), log: { error: line => logged.push(JSON.parse(line)) }, graceMs: 50, deadlineMs: 200 })();
  await tick(20);
  assert.deepEqual(exits, [0]); assert.equal(logged[0].event, 'coding_close_failed');
});

test('only a genuine hang past the deadline exits 1', async () => {
  const exits = [];
  const http = { close() {}, closeIdleConnections() {}, closeAllConnections() {} };
  gracefulShutdown({ http, service: { async close() {} }, exit: code => exits.push(code), log: quiet, graceMs: 10, deadlineMs: 40 })();
  await tick(80);
  assert.deepEqual(exits, [1]);
});
