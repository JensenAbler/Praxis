#!/usr/bin/env node
// Run only inside an OS-isolated evaluation job. node:vm is NOT a security boundary.
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, dirname, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { bounded, loadCandidate } from '../eval/checkers/support.js';
export { bounded, loadCandidate } from '../eval/checkers/support.js';

const SELF = fileURLToPath(import.meta.url);
const DEFAULT_CATALOG = resolve(dirname(SELF), '../eval/catalog.json');
const ORDER = ['speech', 'shouldRespond', 'bigBrain', 'bigHeart'];
const inside = (root, path) => { const part = relative(root, path); return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part)); };
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const plain = value => JSON.parse(JSON.stringify(value));

// Conservative mechanical checks; semantic preservation still needs a diff review.
export function inspectPromptOrder(text) {
  const normalized = String(text).replace(/[`"']/g, '');
  const list = /\bspeech\s*,\s*shouldRespond\s*,\s*bigBrain\s*,\s*bigHeart\b/i.test(normalized);
  const jsonShape = /\{\s*speech\s*:[^}\n]*\bshouldRespond\s*:/i.test(normalized);
  const contradiction = /\bshouldRespond\s*,\s*speech\s*,\s*bigBrain\s*,\s*bigHeart\b/i.test(normalized)
    || /\{\s*shouldRespond\s*:[^}\n]*\bspeech\s*:/i.test(normalized)
    || /\b(?:emit|output|serialize|write)\s+(?:the\s+)?shouldRespond\s+(?:field\s+)?(?:first|before\s+speech)\b/i.test(normalized);
  return { recognizedSpeechFirstShape: list || jsonShape, contradiction };
}

function controlledResponse() {
  let controller;
  const encoder = new TextEncoder();
  const body = new ReadableStream({ start(value) { controller = value; } });
  return { response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    send(content) { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)); },
    finish() { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); } };
}

export async function checkReplay({ workspace, caseId = 'speech-first', catalogPath = DEFAULT_CATALOG }) {
  workspace = realpathSync(workspace);
  catalogPath = realpathSync(catalogPath);
  ensure(!inside(workspace, realpathSync(SELF)) && !inside(workspace, catalogPath), 'Trusted checker and catalog must be outside the editable candidate workspace');
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const entry = catalog.cases.find(item => item.id === caseId);
  const extensions = {
    'buffer-settling-v1': ['../eval/checkers/buffer-settling.js', 'checkBufferSettling'],
    'provider-stream-errors-v1': ['../eval/checkers/provider-stream-errors.js', 'checkProviderStreamErrors'],
    'vad-flap-v1': ['../eval/checkers/vad-flap.js', 'checkVadFlap'],
  };
  ensure(entry && (entry.checker === 'speech-first-v1' || Object.hasOwn(extensions, entry.checker)), 'Unknown evaluation case or checker');
  if (entry.checker !== 'speech-first-v1') {
    const [modulePath, exportName] = extensions[entry.checker];
    const checkerPath = realpathSync(fileURLToPath(new URL(modulePath, import.meta.url)));
    ensure(!inside(workspace, checkerPath), 'Trusted checker must be outside the editable candidate workspace');
    return (await import(modulePath))[exportName]({ workspace, entry });
  }
  const checks = [];
  const run = async (id, task) => {
    try { const detail = await bounded(Promise.resolve().then(task), 4500); checks.push({ id, passed: true, ...(detail || {}) }); }
    catch (error) { checks.push({ id, passed: false, reason: String(error.message).slice(0, 300) }); }
  };
  let candidate;
  try {
    candidate = loadCandidate(workspace, entry);
    const evaluate = code => candidate.evaluate(code);
    const createGenerator = extra => evaluate(`globalThis.generator = new subject.PodcastGenerator({apiKey:'offline-fixture',baseUrl:'https://offline.invalid/v1',model:'offline',timeout:1500,${extra || ''}})`);
    createGenerator();
    await run('schema_field_order', () => {
      const schema = plain(evaluate('generator.getResponseSchema()'));
      ensure(Object.keys(schema.properties || {}).join(',') === ORDER.join(','), 'Schema properties must put speech before shouldRespond and retain both handoff fields');
      ensure(Array.isArray(schema.required) && schema.required.join(',') === ORDER.join(','), 'Required fields must retain the specified speech-first order');
    });
    await run('prompt_order_coherence', () => {
      const prompts = plain(evaluate(`[generator.buildSystemPrompt(),generator.buildDecisionPrompt(),generator.buildUserPrompt('Guest: Please continue.',undefined,{})]`));
      const findings = prompts.map(inspectPromptOrder);
      ensure(!findings.some(item => item.contradiction), 'A generated prompt still describes a decision-first output shape');
      return { recognizedSpeechFirstShape: findings.some(item => item.recognizedSpeechFirstShape), semanticReviewRequired: true };
    });
    await run('reader_orders_and_silence', () => {
      const result = plain(evaluate(`(() => {
        const long = 'A useful streamed sentence. '.repeat(20);
        const fields = {bigBrain:{requested:false,reason:'',consumedRunId:''},bigHeart:{requested:false,reason:'',consumedRunId:''}};
        const results = [];
        for (const decision of [true,false]) for (const first of [true,false]) {
          const speech = decision ? long : '';
          const payload = first ? {speech,shouldRespond:decision,...fields} : {shouldRespond:decision,speech,...fields};
          const reader = new subject.IncrementalSpeechReader(); let chunks='';
          const raw=JSON.stringify(payload); for(let i=0;i<raw.length;i+=7) chunks+=reader.push(raw.slice(i,i+7)).chunks.join('');
          const final=reader.finalize(); results.push(chunks===speech && final.speech===speech && final.shouldRespond===decision);
        }
        const silent=new subject.IncrementalSpeechReader(); const a=silent.push('{"speech":""'); const b=silent.push(',"shouldRespond":false}');
        const spoken=new subject.IncrementalSpeechReader().push('{"speech":"The opening words');
        return {results,silence:a.speechComplete && a.chunks.length===0 && a.shouldRespond===null && b.shouldRespond===false && b.chunks.length===0,
          early:spoken.shouldRespond===null && spoken.chunks.join('')==='The opening words'};
      })()`));
      ensure(result.results.every(Boolean) && result.silence && result.early, 'Reader must preserve both orders, long speech, and the empty-speech decision boundary');
    });
    await run('mock_stream_decision_liveness', async () => {
      createGenerator();
      const streams = [];
      candidate.mockFetch(async url => { ensure(String(url) === 'https://offline.invalid/v1/chat/completions', 'Unexpected mock request endpoint'); const stream = controlledResponse(); streams.push(stream); return stream.response; });
      const suffix = ',"bigBrain":{"requested":false,"reason":"","consumedRunId":""},"bigHeart":{"requested":false,"reason":"","consumedRunId":""}}';
      const turn = await bounded(evaluate(`generator.generateStreaming({transcript:'Guest: Please continue.',remember:false})`));
      await new Promise(resolve => setImmediate(resolve)); ensure(streams.length === 1, 'Streaming did not request its mocked response');
      const text = 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(8);
      streams[0].send(`{"speech":"${text}`);
      ensure(await bounded(turn.shouldRespond) === true, 'Nonempty speech did not resolve the decision before its field arrived');
      const iterator = turn.speechStream[Symbol.asyncIterator]();
      const first = await bounded(iterator.next()); ensure(!first.done && first.value.length > 0, 'Speech did not stream before the decision field arrived');
      streams[0].send(`","shouldRespond":true${suffix}`); streams[0].finish();
      const collect = async () => { let speech = first.value; for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) speech += chunk; return speech; };
      ensure(await bounded(collect()) === text, 'Stream lost or duplicated speech');
      const final = await bounded(turn.completed); ensure(final.shouldRespond === true && final.speech === text, 'Completed streamed response is inconsistent');
      const silent = await bounded(evaluate(`generator.generateStreaming({transcript:'Guest: Hold on.',remember:false})`));
      await new Promise(resolve => setImmediate(resolve)); ensure(streams.length === 2, 'Silence turn did not request its mocked response');
      let settled = false; silent.shouldRespond.then(() => { settled = true; }, () => { settled = true; });
      streams[1].send('{"speech":""');
      const empty = await bounded(silent.speechStream[Symbol.asyncIterator]().next());
      await new Promise(resolve => setImmediate(resolve));
      ensure(empty.done && !settled, 'Empty speech must produce no chunks and leave the decision pending');
      streams[1].send(`,"shouldRespond":false${suffix}`); streams[1].finish();
      ensure(await bounded(silent.shouldRespond) === false, 'Silence decision did not settle false');
      const end = await bounded(silent.completed); ensure(end.shouldRespond === false && end.speech === '', 'Completed silence result is inconsistent');
    });
    await run('mock_json_object_fallback', async () => {
      createGenerator("responseFormat:'json_object'");
      let request;
      candidate.mockFetch(async (url, init) => {
        ensure(String(url) === 'https://offline.invalid/v1/chat/completions', 'Unexpected mock request endpoint');
        request = JSON.parse(init.body);
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ speech: '', shouldRespond: false, bigBrain: { requested: false }, bigHeart: { requested: false } }) } }] }), { headers: { 'content-type': 'application/json' } });
      });
      const output = await bounded(evaluate(`generator.generate({transcript:'Guest: Hold on.',remember:false})`));
      ensure(output.shouldRespond === false && output.speech === '', 'Complete JSON silence normalization changed');
      ensure(request?.response_format?.type === 'json_object', 'JSON-object request mode was not preserved');
      const findings = request.messages.map(message => inspectPromptOrder(message.content));
      ensure(!findings.some(item => item.contradiction), 'JSON-object prompt contradicts speech-first ordering');
      return { recognizedSpeechFirstShape: findings.some(item => item.recognizedSpeechFirstShape), semanticReviewRequired: true };
    });
  } catch (error) { checks.push({ id: 'candidate_load', passed: false, reason: String(error.message).slice(0, 300) }); }
  finally { candidate?.close(); }
  return { caseId, checker: entry.checker, complete: true, passed: checks.length === 5 && checks.every(item => item.passed), checks,
    candidateModuleSha256: candidate?.hashes || {}, promptSha256: entry.promptSha256,
    evidenceType: 'offline-mocked-module-evaluation', liveServicesExercised: false, semanticReviewRequired: true,
    isolation: 'Caller must enforce an unprivileged OS sandbox; VM restrictions are not a security boundary.' };
}

function argumentsOf(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) { ensure(['--workspace', '--case', '--catalog'].includes(args[i]) && args[i + 1], 'Usage: node scripts/eval-check.js --workspace PATH [--case ID] [--catalog PATH]'); values[args[i]] = args[i + 1]; }
  ensure(values['--workspace'], 'An isolated candidate workspace is required');
  return { workspace: values['--workspace'], caseId: values['--case'] || 'speech-first', catalogPath: values['--catalog'] || DEFAULT_CATALOG };
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--child') {
      const result = await checkReplay(argumentsOf(args.slice(1))); process.stdout.write(`${JSON.stringify(result)}\n`); process.exit(result.passed ? 0 : 1);
    } else {
      argumentsOf(args);
      const env = Object.fromEntries(['PATH', 'SystemRoot', 'SYSTEMROOT', 'SystemDrive'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
      const child = spawn(process.execPath, [SELF, '--child', ...args], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env });
      let output = '', killed = false;
      const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, 15000);
      child.stdout.on('data', chunk => { output += chunk; if (output.length > 256 * 1024) { killed = true; child.kill('SIGKILL'); } });
      child.on('error', () => { clearTimeout(timer); process.stderr.write('Evaluation process could not start\n'); process.exitCode = 2; });
      child.on('close', code => {
        clearTimeout(timer);
        try { ensure(!killed && code !== null, 'Evaluation process exceeded its limit'); const result = JSON.parse(output); ensure(result.complete === true && Array.isArray(result.checks), 'Evaluation produced no complete receipt'); process.stdout.write(`${JSON.stringify(result)}\n`); process.exitCode = result.passed && code === 0 ? 0 : 1; }
        catch { process.stdout.write(`${JSON.stringify({ complete: false, passed: false, error: 'EVALUATION_PROCESS_FAILED' })}\n`); process.exitCode = 2; }
      });
    }
  } catch (error) { process.stderr.write(`${String(error.message).slice(0, 300)}\n`); process.exitCode = 2; }
}
