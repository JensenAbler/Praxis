// Trusted, independently authored black-box checks. Run candidate modules only in an OS sandbox.
import { bounded, loadCandidate } from './support.js';

const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const observe = promise => Promise.resolve(promise).then(value => ({ ok: true, value }), error => ({ ok: false, error }));
const errorEvent = { type: 'error', error: { type: 'overloaded_error', message: 'Synthetic provider capacity failure' }, request_id: 'fixture-request' };
const delta = (text, partial = false) => ({ type: 'content_block_delta', index: 0, delta: partial ? { type: 'input_json_delta', partial_json: text } : { type: 'text_delta', text } });
const frame = (event, ending = '\n\n') => `event: ${event.type}\ndata: ${JSON.stringify(event)}${ending}`;

function responseFixture() {
  let controller, closed = false;
  const encoder = new TextEncoder();
  const body = new ReadableStream({ start(value) { controller = value; } });
  return {
    response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    send(text, fragmented = false) {
      const bytes = encoder.encode(text);
      if (fragmented) for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
      else controller.enqueue(bytes);
    },
    close() { if (!closed) { closed = true; controller.close(); } }
  };
}

function hasProviderCause(result) {
  return !result.ok && /overloaded_error|capacity failure/i.test(`${result.error?.type || ''} ${result.error?.message || ''}`);
}

export async function checkProviderStreamErrors({ workspace, entry }) {
  const checks = [], hashes = {};
  async function run(id, task) {
    let candidate, response;
    try {
      candidate = loadCandidate(workspace, entry);
      Object.assign(hashes, candidate.hashes);
      response = responseFixture();
      let requests = 0;
      candidate.mockFetch(async (url, options) => {
        requests++;
        ensure(String(url) === 'https://api.anthropic.com/v1/messages', 'Streaming request used an unexpected endpoint');
        ensure(JSON.parse(options.body).stream === true, 'Request must retain streaming mode');
        return response.response;
      });
      candidate.evaluate("globalThis.generator = new subject.PodcastGenerator({apiKey:'offline-fixture',baseUrl:'https://api.anthropic.com/v1',model:'claude-offline',timeout:2000})");
      const turn = await bounded(candidate.evaluate("generator.generateStreaming({transcript:'Guest: Please continue.',remember:false})"));
      // Attach all consumers before releasing bytes, so the evaluator itself introduces no unhandled rejection.
      const decision = observe(turn.shouldRespond), completed = observe(turn.completed);
      const iterator = turn.speechStream[Symbol.asyncIterator]();
      await bounded(task({ response, decision, completed, iterator }), 3500);
      ensure(requests === 1, 'An in-band stream failure unexpectedly restarted the provider request');
      checks.push({ id, passed: true });
    } catch (error) { checks.push({ id, passed: false, reason: String(error.message).slice(0, 300) }); }
    finally { response?.close(); candidate?.close(); }
  }

  async function earlyError({ response, decision, completed, iterator }, ending, fragmented) {
    const speech = observe(iterator.next());
    response.send(frame(errorEvent, ending), fragmented); response.close();
    const results = await Promise.all([decision, completed, speech]);
    ensure(results.every(hasProviderCause), 'HTTP 200 provider error must reject decision, completion, and speech with the provider cause');
  }
  await run('provider_error_before_speech', ctx => earlyError(ctx, '\n\n', false));
  await run('fragmented_provider_error_without_final_newline', ctx => earlyError(ctx, '', true));
  await run('provider_error_after_partial_speech', async ({ response, decision, completed, iterator }) => {
    const first = observe(iterator.next());
    const prefix = 'These words reached the consumer before the provider failed. '.repeat(4);
    response.send(frame(delta(`{"speech":"${prefix}`)), true);
    const initial = await bounded(first);
    ensure(initial.ok && !initial.value.done && initial.value.value.length > 0, 'Partial speech did not reach its consumer before the later failure');
    ensure((await bounded(decision)).value === true, 'Already spoken text should establish a responding turn');
    const remainder = observe((async () => { for await (const unused of { [Symbol.asyncIterator]: () => iterator }) { void unused; } })());
    response.send(frame(errorEvent), true); response.close();
    ensure((await Promise.all([completed, remainder])).every(hasProviderCause), 'An error after partial speech must reject completion and the remaining speech stream');
  });

  for (const partial of [false, true]) await run(partial ? 'partial_json_deltas_preserve_speech' : 'text_deltas_preserve_speech', async ({ response, decision, completed, iterator }) => {
    const text = 'A café story with a quoted "hello" and an ending.';
    const payload = JSON.stringify({ speech: text, shouldRespond: true, chosenAngle: '', bigBrain: { requested: false }, bigHeart: { requested: false } });
    const speech = observe((async () => { let value = ''; for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) value += chunk; return value; })());
    for (let i = 0; i < payload.length; i += 7) response.send(frame(delta(payload.slice(i, i + 7), partial)), true);
    response.send(frame({ type: 'message_stop' })); response.close();
    const [chosen, final, spoken] = await Promise.all([decision, completed, speech]);
    ensure(chosen.ok && chosen.value === true && final.ok && final.value.shouldRespond === true, 'Valid provider output did not complete as speech');
    ensure(spoken.ok && spoken.value === text && final.value.speech === text, 'Fragmented structured deltas lost, duplicated, or altered speech');
  });

  await run('genuine_silence_remains_silence', async ({ response, decision, completed, iterator }) => {
    const speech = observe((async () => { let value = ''; for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) value += chunk; return value; })());
    response.send(frame(delta('{"speech":"","shouldRespond":false,"bigBrain":{"requested":false},"bigHeart":{"requested":false}}')), true);
    response.send(frame({ type: 'message_stop' })); response.close();
    const [chosen, final, spoken] = await Promise.all([decision, completed, speech]);
    ensure(chosen.ok && chosen.value === false && final.ok && final.value.shouldRespond === false && final.value.speech === '' && spoken.ok && spoken.value === '', 'An intentional silence turn must remain a successful empty response');
  });

  return { caseId: entry.id, checker: entry.checker, complete: true, passed: checks.length === 6 && checks.every(check => check.passed), checks,
    candidateModuleSha256: hashes, promptSha256: entry.promptSha256, evidenceType: 'offline-mocked-module-evaluation',
    liveServicesExercised: false, semanticReviewRequired: true,
    isolation: 'Caller must enforce an unprivileged OS sandbox; VM restrictions are not a security boundary.' };
}
