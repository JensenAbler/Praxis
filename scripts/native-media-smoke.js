#!/usr/bin/env node
// One synthetic diagnostic job under the installed hardened coding-unit policy.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodeStore } from '../src/code/store.js';
import { WorkspaceManager } from '../src/code/workspaces.js';
import { CodeJobs } from '../src/code/jobs.js';
import { PodmanRunner } from '../src/code/runner.js';

assert.equal(process.platform, 'linux'); assert.notEqual(process.getuid(), 0);
assert.equal(process.argv.length, 4, 'Supply protected configuration and a new explicit run ID.');
const runId = process.argv[3];
assert.match(runId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const config = JSON.parse(readFileSync(process.argv[2]));
const root = `/var/lib/praxis-code/native-media-${runId}`;
assert.equal(existsSync(root), false, 'Existing diagnostic state must be recovered and inspected, never rerun.');
mkdirSync(join(root, 'source'), { recursive: true, mode: 0o700 });
writeFileSync(join(root, 'source/README.txt'), 'Disposable synthetic native media diagnosis.\n');
const workspaceDirectory = `/srv/praxis-code/storage/workspaces/media-${runId}`;
const dataDirectory = join(root, 'state');
const store = new CodeStore(dataDirectory);
const runner = new PodmanRunner({ ...config.runnerConfig, workspaceRoot: workspaceDirectory,
  logDirectory: `/srv/praxis-code/storage/container-logs/media-${runId}` });
const jobs = new CodeJobs({ store, dataDirectory, runner });
const workspaces = new WorkspaceManager({ store, dataDirectory, workspaceDirectory,
  projects: [{ id: 'media', name: 'Synthetic media diagnostic', repository: 'fixture://media', revision: 'v1', snapshotPath: join(root, 'source') }] });
jobs.workspaces = workspaces;
const evidence = { evidenceKind: 'actual-rootless-container-synthetic-native-media-diagnostic', runId,
  startedAt: new Date().toISOString(), release: config.release, image: config.runnerConfig.image, hostUid: process.getuid() };
function pidEvents() {
  const member = readFileSync('/proc/self/cgroup', 'utf8').trim().split('\n').find(line => line.startsWith('0::')).slice(3);
  const prefix = `/sys/fs/cgroup${member}`;
  return Object.fromEntries(['pids.current', 'pids.peak', 'pids.max', 'pids.events', 'memory.events'].map(name => {
    try { return [name, readFileSync(`${prefix}/${name}`, 'utf8').trim()]; } catch { return [name, null]; }
  }));
}
const program = `
  import { spawn } from 'node:child_process'; import fs from 'node:fs';
  const cases = [
    {name:'short-default',duration:0.1,normalize:true,threads:false},
    {name:'short-one-thread',duration:0.1,normalize:true,threads:true},
    {name:'short-no-normalizer',duration:0.1,normalize:false,threads:true},
    {name:'longer-one-thread',duration:2,normalize:true,threads:true}
  ];
  for (const c of cases) {
    const argv = ['-y',...(c.threads?['-threads','1','-filter_threads','1','-filter_complex_threads','1']:[]),
      '-f','lavfi','-t',String(c.duration),'-i','anullsrc=r=48000:cl=stereo',
      '-filter_complex','[0:a]amix=inputs=1:duration=longest:dropout_transition=0.5:normalize=0'+(c.normalize?',dynaudnorm=p=0.95':'')+'[out]',
      '-map','[out]','-c:a','libmp3lame','-b:a','192k','-ar','48000','-ac','2',c.name+'.mp3'];
    const start=Date.now(); let stderr='',maxThreads=0,timedOut=false;
    const child=spawn('ffmpeg',argv,{stdio:['ignore','ignore','pipe']});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4096);});
    const poll=setInterval(()=>{try{maxThreads=Math.max(maxThreads,+/^Threads:\\s+(\\d+)/m.exec(fs.readFileSync('/proc/'+child.pid+'/status','utf8'))[1]);}catch{}},5);
    const deadline=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},10000);
    const result=await new Promise(resolve=>{child.once('error',error=>resolve({error:error.code}));child.once('close',(code,signal)=>resolve({code,signal}));});
    clearInterval(poll);clearTimeout(deadline);
    const output=c.name+'.mp3';
    console.log('PRAXIS_MEDIA_CASE '+JSON.stringify({...c,argv,...result,timedOut,elapsedMs:Date.now()-start,maxThreads,
      outputBytes:fs.existsSync(output)?fs.statSync(output).size:null,stderrTail:stderr.slice(-1200)}));
  }
  console.log('PRAXIS_MEDIA_DIAGNOSTIC_COMPLETED');
`;
try {
  const owner = 'jensen';
  const created = workspaces.create({ owner, projectId: 'media', baseRevision: 'v1', idempotencyKey: `media-workspace-${runId}` });
  const workspaceId = created.result.workspaceId;
  evidence.pidsBefore = pidEvents();
  const job = jobs.start({ owner, workspaceId, expectedRevision: workspaces.getExecutionWorkspace({ owner, workspaceId }).revision,
    idempotencyKey: `media-job-${runId}`, label: 'Synthetic native media diagnosis', argv: ['node', '--input-type=module', '-e', program], timeoutSeconds: 60 });
  evidence.jobId = job.id; writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  const deadline = Date.now() + 210000;
  for (;;) {
    await jobs.tick();
    const status = jobs.get({ owner, jobId: job.id });
    if (!['queued', 'starting', 'running', 'canceling'].includes(status.status)) {
      evidence.job = { status: status.status, exitCode: status.exitCode, terminationReason: status.terminationReason, truncated: status.truncated };
      break;
    }
    assert.ok(Date.now() < deadline, 'Inspect this same persisted job; do not rerun the diagnostic.');
    await delay(100);
  }
  let cursor = 0, output = '';
  for (;;) {
    const page = jobs.logs({ owner, jobId: job.id, cursor, limit: 100 });
    output += page.records.filter(row => row.stream !== 'system').map(row => row.text).join('');
    cursor = page.nextCursor; if (!page.hasMore) break;
  }
  evidence.pidsAfter = pidEvents();
  evidence.cases = [...output.matchAll(/^PRAXIS_MEDIA_CASE (.+)$/gm)].map(match => JSON.parse(match[1]));
  evidence.completed = output.includes('PRAXIS_MEDIA_DIAGNOSTIC_COMPLETED') && evidence.cases.length === 4;
  assert.equal(evidence.completed, true);
} catch (error) {
  evidence.failure = { name: error.name, code: error.code ?? null, message: error.message.slice(0, 500) }; process.exitCode = 1;
} finally {
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  store.close(); process.stdout.write(JSON.stringify(evidence) + '\n');
}
