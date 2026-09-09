// Trusted evaluator: execute historical/candidate modules only in an OS sandbox.
// The virtual clock is a deterministic test device, not a security boundary.
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, sep, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const inside = (root, path) => { const part = relative(root, path); return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part)); };

// Independently authored harness. No test or implementation text is imported
// from the historical repository. Scheduling occurs entirely in virtual time.
const CLOCK = `
let time = 1700000000000, nextTimer = 1;
const scheduled = new Map();
const epoch = time;
const NativeDate = Date;
Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [time])); } static now() { return time; } };
globalThis.setTimeout = (callback, delay = 0, ...args) => {
  const id = nextTimer++;
  scheduled.set(id, { at: time + Math.max(0, Number(delay) || 0), callback: () => callback(...args) });
  return id;
};
globalThis.clearTimeout = id => scheduled.delete(id);
function advance(delta) {
  const end = time + delta;
  let steps = 0;
  while (true) {
    let next;
    for (const [id, timer] of scheduled) if (timer.at <= end && (!next || timer.at < next[1].at || (timer.at === next[1].at && id < next[0]))) next = [id, timer];
    if (!next) break;
    if (++steps > 10000) throw new Error('Virtual timer loop did not terminate');
    scheduled.delete(next[0]); time = next[1].at; next[1].callback();
  }
  time = end;
}
const outputs = [];
function create(options = {}) {
  globalThis.buffer = new subject.ConversationBuffer({ pendingAsrTimeout: 1000, ...options });
  buffer.onFlush(utterances => outputs.push({ at: time - epoch, utterances: JSON.parse(JSON.stringify(utterances)) }));
}
function utterance(userId, text, start = 100, duration = 25) {
  return { userId, speaker: userId, transcription: text, speechStartedAt: epoch + start, speechEndedAt: epoch + start + duration, speechDuration: duration };
}
function requireValue(condition, message) { if (!condition) throw new Error(message); }
function expectCount(count, message) { requireValue(outputs.length === count, message); }
function expectText(index, values) {
  requireValue(JSON.stringify(outputs[index]?.utterances.map(item => item.transcription)) === JSON.stringify(values), 'Flushed utterances were lost, duplicated, or reordered');
}
`;

function load(source, entrypoint, environment = {}) {
  const context = vm.createContext({ console: { log() {}, warn() {}, error() {} }, process: { env: Object.freeze({ ...environment }) } }, { codeGeneration: { strings: false, wasm: false } });
  const evaluate = code => new vm.Script(code, { filename: 'buffer-evaluation.js' }).runInContext(context, { timeout: 1000 });
  evaluate(CLOCK);
  evaluate(`globalThis.candidateModule = { exports: {} };\n(function(module, exports, require) {\n${source}\n})(candidateModule, candidateModule.exports, () => { throw new Error('This offline case permits no module dependencies'); });\nglobalThis.subject = candidateModule.exports;`);
  ensure(evaluate('typeof subject.ConversationBuffer') === 'function', `${entrypoint} must export ConversationBuffer`);
  return evaluate;
}

export async function checkBufferSettling({ workspace, entry = {} }) {
  workspace = realpathSync(workspace);
  const entrypoint = entry.entrypoint || 'conversation-buffer.js';
  const path = realpathSync(resolve(workspace, entrypoint));
  ensure(inside(workspace, path), 'Candidate entrypoint escapes its workspace');
  const source = readFileSync(path, 'utf8');
  ensure(Buffer.byteLength(source) <= 2 * 1024 * 1024, 'Candidate module exceeds the size limit');
  const checks = [];
  const run = (id, body, environment) => {
    try { load(source, entrypoint, environment)(body); checks.push({ id, passed: true }); }
    catch (error) { checks.push({ id, passed: false, reason: String(error.message).slice(0, 300) }); }
  };
  run('duration_never_extends_fixed_delay', `
    for (const duration of [25, 500, 9000, 60000]) {
      for (const options of [{}, {dynamicGrace:true}]) {
        const count = outputs.length, before = time;
        create(options);
        buffer.addUtterance(utterance('speaker', 'duration '+duration, 100, duration));
        advance(49); expectCount(count, 'The existing 50ms synchronization delay must not disappear');
        advance(1); expectCount(count + 1, 'Utterance duration or the retired dynamic flag extended the fixed delay');
        requireValue(outputs[count].at === before - epoch + 50, 'Flush did not occur at the fixed deadline');
        buffer.clear();
      }
    }
  `, { CONVERSATION_BUFFER_DYNAMIC_GRACE: 'true' });
  run('all_asr_completions_gate_flush', `
    create(); buffer.setUserSpeaking('a', true); buffer.markEndpointing('a', true);
    buffer.markAsrPending('a'); buffer.markAsrPending('a'); buffer.markAsrPending('b');
    buffer.setUserSpeaking('a', false); buffer.markEndpointing('a', false);
    buffer.addUtterance(utterance('a', 'first', 100));
    advance(100); expectCount(0, 'One of two ASR jobs for the same speaker was still pending');
    buffer.addUtterance(utterance('b', 'third', 300));
    advance(100); expectCount(0, 'Other speaker completion incorrectly cleared the remaining ASR job');
    buffer.addUtterance(utterance('a', 'second', 200));
    advance(49); expectCount(0, 'ASR completion skipped the settling delay');
    advance(1); expectCount(1, 'Final ASR completion did not schedule a flush');
    expectText(0, ['first', 'second', 'third']);
    advance(1000); expectCount(1, 'An obsolete ASR timer duplicated the flush');
  `);
  run('resumed_speech_cancels_deadline', `
    create(); buffer.addUtterance(utterance('a', 'before resuming'));
    advance(40); buffer.setUserSpeaking('b', true);
    advance(100); expectCount(0, 'A stale settling callback flushed during resumed speech');
    buffer.setUserSpeaking('b', false);
    advance(49); expectCount(0, 'Resumed speech reused the cancelled deadline');
    advance(1); expectCount(1, 'Stopping the resumed speaker did not release the buffer');
    requireValue(outputs[0].at === 190, 'Settling must restart from the end of resumed speech');
  `);
  run('closely_arriving_results_share_deadline', `
    create(); buffer.addUtterance(utterance('a', 'earlier', 100));
    advance(40); buffer.addUtterance(utterance('b', 'later', 200));
    advance(9); expectCount(0, 'Closely arriving ASR skipped the pending settling interval');
    advance(1); expectCount(1, 'A nearby completed ASR unnecessarily restarted the settling timer');
    expectText(0, ['earlier', 'later']);
  `);
  run('endpoint_and_multiple_holds_preserve_text', `
    create(); buffer.addUtterance(utterance('a', 'retained'));
    advance(20); buffer.markEndpointing('b', true);
    buffer.setFlushHold('playback', true); buffer.setFlushHold('handoff', true);
    advance(100); expectCount(0, 'Endpointing or a hold allowed a premature flush');
    buffer.markEndpointing('b', false); buffer.setFlushHold('playback', false);
    advance(100); expectCount(0, 'Releasing one hold released another outstanding hold');
    buffer.setFlushHold('handoff', false);
    advance(49); expectCount(0, 'Releasing the final hold skipped settling');
    advance(1); expectCount(1, 'Releasing all holds did not resume flushing'); expectText(0, ['retained']);
  `);
  run('cooldown_then_settling', `
    create({cooldownPeriod:80}); buffer.addUtterance(utterance('a', 'waiting'));
    advance(20); buffer.startCooldown();
    advance(79); expectCount(0, 'The cancelled settling callback escaped cooldown');
    advance(1); expectCount(0, 'Cooldown completion must evaluate the normal settling gates');
    advance(49); expectCount(0, 'Cooldown completion skipped the fixed synchronization delay');
    advance(1); expectCount(1, 'Buffered text did not flush after cooldown and settling');
    requireValue(outputs[0].at === 150, 'Cooldown or settling was extended'); expectText(0, ['waiting']);
  `);
  run('stale_requeue_preserves_asr_and_order', `
    create(); buffer.addUtterance(utterance('a', 'restored', 100)); advance(50);
    expectCount(1, 'Initial response input did not flush');
    buffer.setUserSpeaking('b', true); buffer.markAsrPending('b');
    buffer.requeueUtterances([...outputs[0].utterances, utterance('a', '   ')], 'stale response');
    buffer.setUserSpeaking('b', false); advance(100);
    expectCount(1, 'Requeue changed pending-ASR state or bypassed its gate');
    buffer.addUtterance(utterance('b', 'new context', 200));
    advance(49); expectCount(1, 'Requeue skipped settling after ASR completion');
    advance(1); expectCount(2, 'Requeued text did not return to the next generation input');
    expectText(1, ['restored', 'new context']);
    advance(1000); expectCount(2, 'Requeued text was flushed more than once');
  `);
  run('empty_asr_and_timeout_recovery', `
    create({pendingAsrTimeout:500}); buffer.markAsrPending('a'); buffer.markAsrPending('a');
    buffer.addUtterance(utterance('b', 'preserved')); advance(200);
    buffer.addUtterance(utterance('a', ''));
    advance(499); expectCount(0, 'Empty completion cleared both ASR jobs or the safety timeout was not rearmed');
    advance(1); expectCount(0, 'ASR timeout skipped the synchronization delay');
    advance(49); expectCount(0, 'ASR timeout shortened the synchronization delay');
    advance(1); expectCount(1, 'Hung-ASR safety timeout no longer releases buffered text');
    expectText(0, ['preserved']); requireValue(outputs[0].at === 750, 'ASR recovery occurred at the wrong deadline');
    buffer.clear(); create(); buffer.markAsrPending('empty');
    buffer.addUtterance(utterance('empty', '  ')); advance(1000);
    expectCount(1, 'Empty ASR created a generator request');
  `);
  run('clear_cancels_all_pending_work', `
    create({pendingAsrTimeout:500, cooldownPeriod:80});
    buffer.addUtterance(utterance('a', 'discarded')); buffer.startCooldown();
    buffer.markAsrPending('a'); buffer.markEndpointing('b', true); buffer.setUserSpeaking('c', true); buffer.setFlushHold('external', true);
    buffer.clear(); advance(1000); expectCount(0, 'Cleared timers or text leaked into a later flush');
    buffer.addUtterance(utterance('d', 'fresh')); advance(50);
    expectCount(1, 'Clear retained a synchronization gate'); expectText(0, ['fresh']);
  `);
  return {
    caseId: entry.id || 'buffer-settling', checker: entry.checker || 'buffer-settling-v1', complete: true,
    passed: checks.length === 9 && checks.every(check => check.passed), checks,
    candidateModuleSha256: { [entrypoint]: createHash('sha256').update(source).digest('hex') }, promptSha256: entry.promptSha256,
    evidenceType: 'offline-virtual-clock-module-evaluation', liveServicesExercised: false, semanticReviewRequired: true,
    isolation: 'Caller must enforce an unprivileged OS sandbox; VM restrictions are not a security boundary.',
    limitations: ['Checks the exported buffer contract with deterministic receiver events; no Discord or ASR service is contacted.', 'Documentation, environment-variable deprecation, unchanged receiver policy, and candidate-authored deterministic tests require diff review.']
  };
}
