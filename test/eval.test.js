import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkReplay, bounded, inspectPromptOrder } from '../scripts/eval-check.js';

// Independently authored public synthetic module; no historical repository source.
function synthetic({ wrongOrder = false, contradict = false, stall = false } = {}) {
  return `
const order=${JSON.stringify(wrongOrder ? ['shouldRespond', 'speech', 'bigBrain', 'bigHeart'] : ['speech', 'shouldRespond', 'bigBrain', 'bigHeart'])};
class IncrementalSpeechReader {
  constructor(){this.raw='';this.sent=0;}
  push(part){
    this.raw+=part;
    const match=this.raw.match(/"speech"\\s*:\\s*"([^"\\\\]*)("?)/);
    const speech=match?.[1]||''; const fresh=speech.slice(this.sent); this.sent=speech.length;
    const decision=this.raw.match(/"shouldRespond"\\s*:\\s*(true|false)/);
    return {chunks:fresh?[fresh]:[],speechComplete:!!match?.[2],shouldRespond:decision?decision[1]==='true':null};
  }
  finalize(){return JSON.parse(this.raw);}
}
class PodcastGenerator {
  constructor(options){this.options=options;}
  getResponseSchema(){return {required:order,properties:Object.fromEntries(order.map(key=>[key,{}]))};}
  buildSystemPrompt(){return 'Return a JSON object: speech, shouldRespond, bigBrain, bigHeart.';}
  buildDecisionPrompt(){return ${JSON.stringify(contradict ? 'Output shouldRespond first.' : 'Continue the response when appropriate.')};}
  buildUserPrompt(text){return text;}
  async generate(input){
    const result=await fetch(this.options.baseUrl+'/chat/completions',{body:JSON.stringify({response_format:{type:'json_object'},messages:[{content:this.buildSystemPrompt()},{content:this.buildDecisionPrompt()},{content:input.transcript}]})});
    return JSON.parse((await result.json()).choices[0].message.content);
  }
  async generateStreaming(){
    ${stall ? 'return new Promise(()=>{});' : ''}
    let resolveDecision,resolveComplete;const queue=[];let wake,ended=false;
    const shouldRespond=new Promise(resolve=>resolveDecision=resolve),completed=new Promise(resolve=>resolveComplete=resolve);
    const speechStream=(async function*(){while(true){while(queue.length)yield queue.shift();if(ended)return;await new Promise(resolve=>wake=resolve);}})();
    const reader=new IncrementalSpeechReader();
    (async()=>{const response=await fetch(this.options.baseUrl+'/chat/completions',{});const decoder=new TextDecoder();
      for await(const chunk of response.body){for(const line of decoder.decode(chunk).split('\\n')){
        if(!line.startsWith('data: ')||line==='data: [DONE]')continue;
        const event=JSON.parse(line.slice(6));const result=reader.push(event.choices[0].delta.content);
        if(result.shouldRespond!==null)resolveDecision(result.shouldRespond);
        if(result.chunks.length){queue.push(...result.chunks);if(result.shouldRespond===null)resolveDecision(true);}
        if(result.speechComplete)ended=true;if(wake){wake();wake=undefined;}
      }}resolveComplete(reader.finalize());
    })();
    return {shouldRespond,completed,speechStream};
  }
}
module.exports={PodcastGenerator,IncrementalSpeechReader};
`;
}

function fixture(t, options) {
  const directory = mkdtempSync(join(tmpdir(), 'praxis-eval-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'podcast-generator.js'), synthetic(options));
  return directory;
}

test('independent grader accepts a synthetic implementation with different prompt wording', async t => {
  const result = await checkReplay({ workspace: fixture(t) });
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.checks.length, 5);
  assert.equal(result.liveServicesExercised, false);
  assert.equal(result.semanticReviewRequired, true);
  assert.match(result.candidateModuleSha256['podcast-generator.js'], /^[a-f0-9]{64}$/);
});

test('grader rejects unchanged decision-first schema even when its reader works', async t => {
  const result = await checkReplay({ workspace: fixture(t, { wrongOrder: true }) });
  assert.equal(result.passed, false);
  assert.equal(result.checks.find(check => check.id === 'schema_field_order').passed, false);
  assert.equal(result.checks.find(check => check.id === 'reader_orders_and_silence').passed, true);
});

test('grader rejects contradictory output instructions without pinning exact reference prose', async t => {
  const result = await checkReplay({ workspace: fixture(t, { contradict: true }) });
  assert.equal(result.checks.find(check => check.id === 'prompt_order_coherence').passed, false);
  assert.equal(result.checks.find(check => check.id === 'mock_json_object_fallback').passed, false);
  assert.equal(inspectPromptOrder('If shouldRespond is false, speech is empty.').contradiction, false);
});

test('a stream with an unresolved promise cannot silently pass after Node becomes idle', async t => {
  const directory = fixture(t, { stall: true });
  const checker = fileURLToPath(new URL('../scripts/eval-check.js', import.meta.url));
  const result = await promisify(execFile)(process.execPath, [checker, '--workspace', directory], { timeout: 10000 }).then(() => assert.fail('Stalled evaluation should fail'), error => error);
  assert.equal(result.code, 1);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.complete, true);
  assert.equal(receipt.passed, false);
  assert.equal(receipt.checks.find(check => check.id === 'mock_stream_decision_liveness').passed, false);
  await assert.rejects(bounded(new Promise(() => {}), 20), /deadline/);
});

test('trusted checker must not be under the editable candidate root', async () => {
  const repository = fileURLToPath(new URL('..', import.meta.url));
  await assert.rejects(checkReplay({ workspace: resolve(repository) }), /outside the editable/);
});
