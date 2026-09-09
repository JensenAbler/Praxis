import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { checkProviderStreamErrors } from '../eval/checkers/provider-stream-errors.js';

// Original public fixture code, not a copy of the historical implementation.
function synthetic({ ignoreErrors = false, ignorePartial = false, silenceIsError = false, finalErrorIsIgnored = false } = {}) {
  return String.raw`
const flags=${JSON.stringify({ ignoreErrors, ignorePartial, silenceIsError, finalErrorIsIgnored })};
class PodcastGenerator {
  async generateStreaming() {
    let goodDecision,badDecision,goodFinal,badFinal,wake,ended=false,failure,raw='',sent=0;
    const queue=[];
    const shouldRespond=new Promise((a,b)=>{goodDecision=a;badDecision=b});
    const completed=new Promise((a,b)=>{goodFinal=a;badFinal=b});
    shouldRespond.catch(()=>{});completed.catch(()=>{});
    const speechStream=(async function*(){while(true){while(queue.length)yield queue.shift();if(failure)throw failure;if(ended)return;await new Promise(r=>wake=r);}})();
    function signal(){if(wake){wake();wake=null}}
    function feed(line,final=false){
      if(!line.startsWith('data:'))return;
      const event=JSON.parse(line.slice(5).trim());
      if(event.type==='error'&&!flags.ignoreErrors&&!(final&&flags.finalErrorIsIgnored))throw new Error(event.error.type+': '+event.error.message);
      const next=event.delta?.text||(!flags.ignorePartial?event.delta?.partial_json:'')||'';
      raw+=next;
      const match=raw.match(/"speech"\s*:\s*("(?:\\.|[^"\\])*"?)/);
      if(match){let token=match[1],text;for(let i=0;i<7&&token.length;i++){try{text=JSON.parse(token.endsWith('"')&&token.length>1?token:token+'"');break}catch{token=token.slice(0,-1)}}
        if(typeof text==='string'&&text.length>sent){queue.push(text.slice(sent));sent=text.length;goodDecision(true);signal();}}
    }
    (async()=>{try{
      const response=await fetch('https://api.anthropic.com/v1/messages',{body:JSON.stringify({stream:true})});
      let buffer='';const decoder=new TextDecoder();
      for await(const bytes of response.body){buffer+=decoder.decode(bytes,{stream:true});let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);feed(line);}}
      buffer+=decoder.decode();if(buffer.trim())feed(buffer,true);
      const output=raw?JSON.parse(raw):{speech:'',shouldRespond:false};
      if(flags.silenceIsError&&!output.shouldRespond)throw new Error('Silence forbidden');
      goodDecision(output.shouldRespond);goodFinal(output);
    }catch(error){failure=error;badDecision(error);badFinal(error)}finally{ended=true;signal()}})();
    return {shouldRespond,completed,speechStream};
  }
}
module.exports={PodcastGenerator};
`;
}

async function grade(t, options) {
  const workspace = mkdtempSync(join(tmpdir(), 'praxis-provider-eval-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeFileSync(join(workspace, 'podcast-generator.js'), synthetic(options));
  return checkProviderStreamErrors({ workspace, entry: { id: 'provider-stream-errors', checker: 'provider-stream-errors-v1', entrypoint: 'podcast-generator.js', allowedModules: ['podcast-generator.js'], promptSha256: 'synthetic' } });
}

test('provider checker accepts independent synthetic streaming behavior', async t => {
  const result = await grade(t);
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.checks.length, 6);
  assert.equal(result.liveServicesExercised, false);
  assert.match(result.candidateModuleSha256['podcast-generator.js'], /^[a-f0-9]{64}$/);
});

test('provider checker catches success-shaped silence on in-band errors', async t => {
  const result = await grade(t, { ignoreErrors: true });
  assert.equal(result.passed, false);
  assert.equal(result.checks.find(check => check.id === 'provider_error_before_speech').passed, false);
  assert.equal(result.checks.find(check => check.id === 'provider_error_after_partial_speech').passed, false);
  assert.equal(result.checks.find(check => check.id === 'genuine_silence_remains_silence').passed, true);
});

test('provider checker catches lost structured partial_json deltas', async t => {
  const result = await grade(t, { ignorePartial: true });
  assert.equal(result.checks.find(check => check.id === 'partial_json_deltas_preserve_speech').passed, false);
  assert.equal(result.checks.find(check => check.id === 'text_deltas_preserve_speech').passed, true);
});

test('provider checker catches unprocessed EOF errors and false failures on silence', async t => {
  const result = await grade(t, { finalErrorIsIgnored: true, silenceIsError: true });
  assert.equal(result.checks.find(check => check.id === 'fragmented_provider_error_without_final_newline').passed, false);
  assert.equal(result.checks.find(check => check.id === 'provider_error_before_speech').passed, true);
  assert.equal(result.checks.find(check => check.id === 'genuine_silence_remains_silence').passed, false);
});

test('provider checker CLI produces complete pass and fail receipts without an import cycle', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'praxis-provider-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workspace = join(directory, 'candidate');
  mkdirSync(workspace);
  const catalogPath = join(directory, 'catalog.json');
  writeFileSync(catalogPath, JSON.stringify({ cases: [{
    id: 'provider-stream-errors', checker: 'provider-stream-errors-v1',
    entrypoint: 'podcast-generator.js', allowedModules: ['podcast-generator.js'], promptSha256: 'synthetic'
  }] }));
  const checkerPath = fileURLToPath(new URL('../scripts/eval-check.js', import.meta.url));
  for (const ignoreErrors of [false, true]) {
    writeFileSync(join(workspace, 'podcast-generator.js'), synthetic({ ignoreErrors }));
    const output = await promisify(execFile)(process.execPath, [checkerPath, '--workspace', workspace,
      '--case', 'provider-stream-errors', '--catalog', catalogPath], { timeout: 10000, windowsHide: true })
      .then(result => ({ ...result, code: 0 }), error => error);
    assert.equal(output.code, ignoreErrors ? 1 : 0, output.stderr);
    const receipt = JSON.parse(output.stdout);
    assert.equal(receipt.complete, true);
    assert.equal(receipt.passed, !ignoreErrors);
    assert.equal(receipt.checks.length, 6);
    assert.equal(receipt.checks.find(check => check.id === 'provider_error_before_speech').passed, !ignoreErrors);
  }
});
