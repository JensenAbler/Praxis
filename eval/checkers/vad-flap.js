// Execute candidate modules only inside the caller's unprivileged OS sandbox.
// The VM supplies deterministic dependencies; it is not a security boundary.
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, sep, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import vm from 'node:vm';

const ensure = (value, message) => { if (!value) throw new Error(message); };
const inside = (root, path) => { const part = relative(root, path); return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part)); };
const deadline = async promise => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Receiver work did not settle')), 1000); })]); }
  finally { clearTimeout(timer); }
};

function loadReceiver(workspace, entry) {
  workspace = realpathSync(workspace);
  const hashes = {}, cache = new Map(), timers = new Map();
  let clock = Date.parse('2026-01-01T00:00:00Z'), nextTimer = 1;
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const context = vm.createContext({
    Buffer, Date: ClockDate, console: { log() {}, warn() {}, error() {} },
    process: { env: Object.freeze({}) },
    setTimeout(fn, delay = 0, ...args) { const id = nextTimer++; timers.set(id, { at: clock + Math.max(1, Number(delay) || 0), fn: () => fn(...args) }); return id; },
    clearTimeout(id) { timers.delete(id); }
  }, { codeGeneration: { strings: false, wasm: false } });
  const mocks = {
    '@discordjs/voice': { EndBehaviorType: { Manual: 'manual' } },
    'prism-media': { opus: { Decoder: PassThrough } },
    stream: { Writable }, 'node:stream': { Writable },
    './elevenlabs-integration': { ElevenLabsIntegration: class { constructor() { throw new Error('Live ASR construction is prohibited'); } } }
  };
  function load(name) {
    ensure(entry.allowedModules.includes(name), 'Module is outside the evaluation allowlist');
    if (cache.has(name)) return cache.get(name).exports;
    const path = realpathSync(resolve(workspace, name));
    ensure(inside(workspace, path), 'Candidate module escapes its workspace');
    const source = readFileSync(path, 'utf8');
    ensure(Buffer.byteLength(source) <= 2 * 1024 * 1024, 'Candidate module exceeds the size limit');
    hashes[name] = createHash('sha256').update(source).digest('hex');
    const module = { exports: {} }; cache.set(name, module);
    const token = `__module${cache.size}`;
    context[token] = { module, require(request) {
      if (Object.hasOwn(mocks, request)) return mocks[request];
      ensure(typeof request === 'string' && request.startsWith('./') && !request.includes('..'), 'Only allowlisted relative modules may load');
      return load(request.slice(2).endsWith('.js') ? request.slice(2) : `${request.slice(2)}.js`);
    } };
    try { new vm.Script(`(function(require,module,exports){\n${source}\n})(${token}.require,${token}.module,${token}.module.exports)`, { filename: name }).runInContext(context, { timeout: 1000 }); }
    finally { delete context[token]; }
    return module.exports;
  }
  const { AudioReceiver } = load(entry.entrypoint);
  ensure(typeof AudioReceiver === 'function', 'AudioReceiver export is missing');
  return { AudioReceiver, hashes, now: () => clock,
    async advance(milliseconds) {
      const until = clock + milliseconds;
      for (let count = 0; ; count++) {
        const next = [...timers].filter(([, item]) => item.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        ensure(count < 1000, 'Receiver scheduled unbounded timer work');
        clock = next[1].at; timers.delete(next[0]); next[1].fn();
        await Promise.resolve(); await Promise.resolve();
      }
      clock = until;
      await Promise.resolve();
    },
    close() { timers.clear(); }
  };
}

function pcm(frames, amplitude = 0) {
  const result = Buffer.alloc(frames * 960 * 2 * 2);
  for (let offset = 0; offset < result.length; offset += 2) result.writeInt16LE(amplitude, offset);
  return result;
}

function fixture(candidate, { blocked = false } = {}) {
  const emitted = [], requests = [], endpoints = [], errors = [], subscriptions = [];
  let unblock;
  const pending = blocked ? new Promise(resolve => { unblock = resolve; }) : null;
  const receiver = new candidate.AudioReceiver({
    botUserId: 'fixture-bot', endpointingDebounce: 40, silenceDuration: 2000,
    stt: { async transcribe(bytes) {
      const index = requests.length; requests.push(Buffer.from(bytes));
      if (blocked && index === 0) await pending;
      return { text: `fixture utterance ${index + 1}`, confidence: 1, words: [] };
    } },
    onUtterance: utterance => emitted.push(utterance),
    onEndpointing: (userId, metadata) => endpoints.push({ userId, ...metadata }),
    onError: error => errors.push(error)
  });
  receiver.start({ receiver: {
    speaking: { on() {} },
    subscribe(userId) { const stream = new PassThrough(); subscriptions.push({ userId, stream }); return stream; }
  } });
  return {
    receiver, emitted, requests, endpoints, errors, subscriptions, unblock,
    begin(userId, bytes) { receiver.handleUserStartSpeaking(userId); receiver.handleAudioChunk(userId, bytes); },
    stop(userId) { receiver.handleUserStopSpeaking(userId); },
    async drain() { await candidate.advance(60); await deadline(receiver.waitForPendingUtterances()); ensure(errors.length === 0, 'Receiver reported a processing error'); },
    close() { unblock?.(); receiver.destroy(); }
  };
}

export async function checkVadFlap({ workspace, entry }) {
  const checks = [], moduleHashes = {};
  async function run(id, task) {
    let candidate, fixtureState;
    try {
      candidate = loadReceiver(workspace, entry); Object.assign(moduleHashes, candidate.hashes);
      fixtureState = fixture(candidate, { blocked: id === 'queued_asr_snapshots_remain_distinct' });
      await deadline(task(candidate, fixtureState));
      checks.push({ id, passed: true });
    } catch (error) { checks.push({ id, passed: false, reason: String(error.message).slice(0, 300) }); }
    finally { fixtureState?.close(); candidate?.close(); }
  }
  await run('silent_stops_drop_audio_keep_subscription', async (c, f) => {
    for (let i = 0; i < 3; i++) { f.begin('a', pcm(2)); f.stop('a'); await f.drain(); }
    const buffered = f.receiver.speakerBuffers.get('a');
    ensure(buffered && buffered.chunks.length === 0 && buffered.startTime === null, 'A non-speech stop retained audio or its old start time');
    ensure(f.requests.length === 0 && f.emitted.length === 0, 'Non-speech stops produced ASR or recorded utterances');
    ensure(!f.endpoints.some(item => item.active), 'Non-speech stops armed an endpoint timer');
    ensure(f.subscriptions.length === 1 && !f.subscriptions[0].stream.destroyed, 'Discarding noise tore down the persistent receive subscription');
  });
  await run('next_speech_has_only_its_own_bytes_and_time', async (c, f) => {
    f.begin('a', pcm(3)); f.stop('a'); await f.drain();
    const startedAt = c.now(), speech = pcm(4, 1800);
    f.begin('a', speech); f.stop('a'); await f.drain();
    ensure(f.requests.length === 1 && f.requests[0].equals(speech), 'Old flap bytes leaked into the next ASR request');
    ensure(f.emitted.length === 1 && Buffer.from(f.emitted[0].audioBuffer).equals(speech), 'Recorded speech lost or duplicated audio');
    ensure(f.emitted[0].startTime === startedAt, 'Recorded speech inherited the previous noise timestamp');
  });
  await run('manual_flush_rejects_noise_but_keeps_short_speech', async (c, f) => {
    f.begin('a', pcm(1)); await deadline(f.receiver.flushAll('recording finalization')); await f.drain();
    ensure(f.requests.length === 0 && f.emitted.length === 0, 'Manual finalization emitted non-speech audio');
    const short = pcm(1, 2200);
    f.receiver.handleAudioChunk('a', short);
    await deadline(f.receiver.flushUser('a', 'manual short utterance')); await f.drain();
    ensure(f.requests.length === 1 && f.requests[0].equals(short) && f.emitted.length === 1, 'A legitimate one-frame utterance was dropped or contaminated');
  });
  await run('silence_rollover_drops_noise_resets_detector', async (c, f) => {
    f.begin('a', pcm(2));
    await deadline(f.receiver.handleSilenceDetected('a')); await f.drain();
    ensure(f.requests.length === 0 && f.emitted.length === 0, 'Silence rollover transcribed or recorded a noise-only buffer');
    const speech = pcm(2, 1400);
    f.receiver.handleAudioChunk('a', speech);
    await deadline(f.receiver.handleSilenceDetected('a')); await f.drain();
    ensure(f.requests.length === 1 && f.requests[0].equals(speech), 'Detector or audio state was not reset for the following speech');
  });
  await run('speaker_isolation_and_resume_preserve_audio', async (c, f) => {
    const first = pcm(1, 1200), second = pcm(2, 2600);
    f.begin('a', pcm(1)); f.begin('b', first); f.stop('b');
    await c.advance(15); f.stop('a'); f.begin('b', second); f.stop('b'); await f.drain();
    const combined = Buffer.concat([first, second]);
    ensure(f.requests.length === 1 && f.requests[0].equals(combined), 'Noise cleanup affected another speaker or resumed speech was split/lost');
    ensure(f.emitted.length === 1 && f.emitted[0].userId === 'b', 'The wrong speaker was recorded');
    ensure(f.subscriptions.length === 2 && f.subscriptions.every(item => !item.stream.destroyed), 'Utterance rollover closed a receive subscription');
  });
  await run('queued_asr_snapshots_remain_distinct', async (c, f) => {
    const first = pcm(2, 3100), second = pcm(1, 4500);
    f.begin('a', first);
    const firstWork = f.receiver.flushUser('a', 'first snapshot');
    await Promise.resolve(); await Promise.resolve();
    f.receiver.handleAudioChunk('a', pcm(2)); f.stop('a');
    f.begin('a', second);
    const secondWork = f.receiver.flushUser('a', 'second snapshot');
    f.unblock();
    await deadline(Promise.all([firstWork, secondWork])); await f.drain();
    ensure(f.requests.length === 2 && f.requests[0].equals(first) && f.requests[1].equals(second), 'ASR snapshots were reordered, duplicated, or contaminated while the first request was pending');
    ensure(f.emitted.length === 2 && Buffer.from(f.emitted[0].audioBuffer).equals(first) && Buffer.from(f.emitted[1].audioBuffer).equals(second), 'Queued recording results lost their snapshot audio');
  });
  return { caseId: entry.id, checker: entry.checker, complete: true,
    passed: checks.length === 6 && checks.every(item => item.passed), checks,
    candidateModuleSha256: moduleHashes, promptSha256: entry.promptSha256,
    evidenceType: 'offline-mocked-module-evaluation', liveServicesExercised: false, semanticReviewRequired: true,
    isolation: 'Caller must enforce an unprivileged OS sandbox; VM restrictions are not a security boundary.',
    limitations: ['Synthetic PCM and mocked Discord/ASR only; no codec, provider, live recording, or perceptual audio verification.'] };
}
