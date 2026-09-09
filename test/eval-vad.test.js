import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkVadFlap } from '../eval/checkers/vad-flap.js';

// Independent synthetic receiver contract, not historical repository source.
function synthetic({ retainNoise = false, flushNoise = false, dropShort = false, closeOnStop = false } = {}) {
  return `
class AudioReceiver {
  constructor(options) {
    this.options=options;this.speakerBuffers=new Map();this.channels=new Map();
    this.chains=new Map();this.pending=new Set();
  }
  start(connection){this.connection=connection;}
  handleUserStartSpeaking(id) {
    if(!this.channels.has(id))this.channels.set(id,this.connection.receiver.subscribe(id));
    if(!this.speakerBuffers.has(id))this.speakerBuffers.set(id,{chunks:[],startTime:null,speech:false,timer:null});
    const b=this.speakerBuffers.get(id);clearTimeout(b.timer);b.timer=null;
  }
  handleAudioChunk(id,bytes) {
    const b=this.speakerBuffers.get(id);if(!b)return;
    if(!b.chunks.length)b.startTime=Date.now();
    b.chunks.push(bytes);for(let p=0;p<bytes.length;p+=2)if(Math.abs(bytes.readInt16LE(p))>400)b.speech=true;
  }
  reset(b){b.chunks=[];b.startTime=null;b.speech=false;clearTimeout(b.timer);b.timer=null;}
  handleUserStopSpeaking(id) {
    const b=this.speakerBuffers.get(id);if(!b)return;
    ${closeOnStop ? 'this.channels.get(id).destroy();this.channels.delete(id);' : ''}
    if(!b.speech){${retainNoise ? '' : 'this.reset(b);'}return;}
    this.options.onEndpointing(id,{active:true});
    b.timer=setTimeout(()=>{b.timer=null;this.options.onEndpointing(id,{active:false});this.flushUser(id);},this.options.endpointingDebounce);
  }
  flushUser(id) {
    const b=this.speakerBuffers.get(id);if(!b)return Promise.resolve();
    const accepted=b.chunks.length&&${flushNoise ? 'true' : 'b.speech'}${dropShort ? '&&Buffer.concat(b.chunks).length>3840' : ''};
    const bytes=Buffer.concat(b.chunks),startTime=b.startTime;this.reset(b);
    if(!accepted)return Promise.resolve();
    const task=(this.chains.get(id)||Promise.resolve()).then(async()=>{
      const result=await this.options.stt.transcribe(bytes);
      this.options.onUtterance({userId:id,audioBuffer:bytes,startTime,transcription:result.text});
    });
    this.chains.set(id,task);this.pending.add(task);task.finally(()=>this.pending.delete(task));return task;
  }
  handleSilenceDetected(id){return this.flushUser(id);}
  async waitForPendingUtterances(){while(this.pending.size)await Promise.all([...this.pending]);}
  async flushAll(){await Promise.all([...this.speakerBuffers.keys()].map(id=>this.flushUser(id)));await this.waitForPendingUtterances();}
  destroy(){for(const b of this.speakerBuffers.values())clearTimeout(b.timer);for(const s of this.channels.values())s.destroy();}
}
module.exports={AudioReceiver};
`;
}

async function grade(t, options = {}) {
  const workspace = mkdtempSync(join(tmpdir(), 'praxis-vad-checker-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeFileSync(join(workspace, 'audio-receiver.js'), synthetic(options));
  return checkVadFlap({ workspace, entry: {
    id: 'vad-flap', checker: 'vad-flap-v1', entrypoint: 'audio-receiver.js',
    allowedModules: ['audio-receiver.js'], promptSha256: '0'.repeat(64)
  } });
}

test('VAD checker accepts an independently written receiver preserving audio boundaries', async t => {
  const receipt = await grade(t);
  assert.equal(receipt.passed, true, JSON.stringify(receipt));
  assert.equal(receipt.complete, true);
  assert.equal(receipt.checks.length, 6);
  assert.equal(receipt.liveServicesExercised, false);
  assert.match(receipt.candidateModuleSha256['audio-receiver.js'], /^[a-f0-9]{64}$/);
});

test('VAD checker detects noise retention even when normal speech succeeds', async t => {
  const receipt = await grade(t, { retainNoise: true });
  assert.equal(receipt.passed, false);
  for (const id of ['silent_stops_drop_audio_keep_subscription', 'next_speech_has_only_its_own_bytes_and_time', 'queued_asr_snapshots_remain_distinct']) {
    assert.equal(receipt.checks.find(check => check.id === id).passed, false, id);
  }
});

test('VAD checker requires noise rejection on manual and silence rollover paths', async t => {
  const receipt = await grade(t, { flushNoise: true });
  assert.equal(receipt.checks.find(check => check.id === 'manual_flush_rejects_noise_but_keeps_short_speech').passed, false);
  assert.equal(receipt.checks.find(check => check.id === 'silence_rollover_drops_noise_resets_detector').passed, false);
  assert.equal(receipt.checks.find(check => check.id === 'next_speech_has_only_its_own_bytes_and_time').passed, true);
});

test('VAD checker rejects duration heuristics that drop legitimate short speech', async t => {
  const receipt = await grade(t, { dropShort: true });
  assert.equal(receipt.checks.find(check => check.id === 'manual_flush_rejects_noise_but_keeps_short_speech').passed, false);
});

test('VAD checker rejects closing persistent audio subscriptions at silence', async t => {
  const receipt = await grade(t, { closeOnStop: true });
  assert.equal(receipt.checks.find(check => check.id === 'silent_stops_drop_audio_keep_subscription').passed, false);
  assert.equal(receipt.checks.find(check => check.id === 'speaker_isolation_and_resume_preserve_audio').passed, false);
});
