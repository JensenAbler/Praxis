import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkBufferSettling } from '../eval/checkers/buffer-settling.js';

// Deliberately compact, independently authored public stand-in. This is not
// copied from the private historical implementation or its original tests.
function synthetic(defect = '') {
  return `
const defect = ${JSON.stringify(defect)};
class ConversationBuffer {
  constructor(options = {}) {
    this.options = options; this.queue = []; this.live = new Set(); this.ending = new Set(); this.holds = new Set();
    this.pending = new Map(); this.pendingTimers = new Map(); this.timer = null; this.cool = null;
  }
  onFlush(callback) { this.callback = callback; }
  cancel() { clearTimeout(this.timer); this.timer = null; }
  blocked() { return this.live.size || this.ending.size || this.holds.size || (defect !== 'ignore-asr' && this.pending.size) || this.cool; }
  schedule() {
    if (this.blocked() || !this.queue.length) { this.cancel(); return; }
    if (this.timer) return;
    const delay = defect === 'dynamic' && this.queue.some(value => value.speechDuration > 1000) ? 500 : 50;
    this.timer = setTimeout(() => {
      this.timer = null; if (this.blocked() || !this.queue.length) return;
      const records = this.queue.splice(0).sort((a,b) => a.speechStartedAt - b.speechStartedAt);
      this.callback(records); this.schedule();
    }, delay);
  }
  setUserSpeaking(id, value) { value ? this.live.add(id) : this.live.delete(id); this.schedule(); }
  markEndpointing(id, value) { value ? this.ending.add(id) : this.ending.delete(id); this.schedule(); }
  setFlushHold(id, value) { value ? this.holds.add(id) : this.holds.delete(id); this.schedule(); }
  arm(id) {
    clearTimeout(this.pendingTimers.get(id));
    this.pendingTimers.set(id, setTimeout(() => { this.pending.delete(id); this.pendingTimers.delete(id); this.schedule(); }, this.options.pendingAsrTimeout || 1000));
  }
  markAsrPending(id) { this.pending.set(id, (this.pending.get(id) || 0) + 1); this.arm(id); this.schedule(); }
  addUtterance(record) {
    const count = this.pending.get(record.userId) || 0;
    if (count > 1) { this.pending.set(record.userId, count - 1); this.arm(record.userId); }
    else if (count) { this.pending.delete(record.userId); clearTimeout(this.pendingTimers.get(record.userId)); this.pendingTimers.delete(record.userId); }
    if (String(record.transcription || '').trim()) this.queue.push({ ...record });
    this.schedule();
  }
  requeueUtterances(records) {
    if (defect === 'lose-requeue') return;
    this.queue.push(...records.filter(value => String(value.transcription || '').trim()).map(value => ({ ...value })));
    this.schedule();
  }
  startCooldown() {
    this.cancel(); clearTimeout(this.cool);
    this.cool = setTimeout(() => { this.cool = null; this.schedule(); }, this.options.cooldownPeriod || 50);
  }
  clear() {
    this.queue.length = 0; this.live.clear(); this.ending.clear(); this.holds.clear(); this.pending.clear();
    this.cancel(); clearTimeout(this.cool); this.cool = null;
    for (const handle of this.pendingTimers.values()) clearTimeout(handle);
    this.pendingTimers.clear();
  }
}
module.exports = { ConversationBuffer };
`;
}

function fixture(t, defect) {
  const directory = mkdtempSync(join(tmpdir(), 'praxis-buffer-eval-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'conversation-buffer.js'), synthetic(defect));
  return directory;
}

test('buffer checker accepts an independently written implementation with virtual time', async t => {
  const result = await checkBufferSettling({ workspace: fixture(t) });
  assert.equal(result.complete, true);
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.checks.length, 9);
  assert.equal(result.liveServicesExercised, false);
  assert.equal(result.semanticReviewRequired, true);
  assert.match(result.candidateModuleSha256['conversation-buffer.js'], /^[a-f0-9]{64}$/);
});

test('buffer checker detects duration latency even when every synchronization gate works', async t => {
  const result = await checkBufferSettling({ workspace: fixture(t, 'dynamic') });
  assert.equal(result.passed, false);
  assert.equal(result.checks.find(item => item.id === 'duration_never_extends_fixed_delay').passed, false);
  assert.equal(result.checks.find(item => item.id === 'all_asr_completions_gate_flush').passed, true);
});

test('buffer checker detects premature ASR flush and lost stale context independently', async t => {
  const early = await checkBufferSettling({ workspace: fixture(t, 'ignore-asr') });
  assert.equal(early.checks.find(item => item.id === 'all_asr_completions_gate_flush').passed, false);
  assert.equal(early.checks.find(item => item.id === 'duration_never_extends_fixed_delay').passed, true);
  const lost = await checkBufferSettling({ workspace: fixture(t, 'lose-requeue') });
  assert.equal(lost.checks.find(item => item.id === 'stale_requeue_preserves_asr_and_order').passed, false);
  assert.equal(lost.checks.find(item => item.id === 'all_asr_completions_gate_flush').passed, true);
});

test('buffer checker reports a missing exported contract as explicit failures', async t => {
  const workspace = fixture(t);
  writeFileSync(join(workspace, 'conversation-buffer.js'), 'module.exports = {};\n');
  const result = await checkBufferSettling({ workspace });
  assert.equal(result.complete, true);
  assert.equal(result.passed, false);
  assert.equal(result.checks.every(item => !item.passed && item.reason.includes('export ConversationBuffer')), true);
});
