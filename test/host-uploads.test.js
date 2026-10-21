import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, mkdirSync, writeFileSync, readFileSync, statSync, symlinkSync, rmSync, appendFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { HostAccess } from '../src/code/host.js';
import { isCanonicalBase64 } from '../src/code/host-uploads.js';
import { hostTools } from '../src/code/host-schema.js';

const sha = data => createHash('sha256').update(data).digest('hex');
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'praxis-upload-test-'));
  const directory = join(base, 'state'), path = join(base, 'target'); let host = new HostAccess({ dataDirectory: directory });
  t.after(() => { host.close(); rmSync(base, { recursive: true, force: true }); });
  return { base, path, directory, get host() { return host; }, reopen() { host.close(); host = new HostAccess({ dataDirectory: directory }); },
    async call(transferAction, transferId, rest = {}) {
      let result = await host.fileWrite({ owner: 'owner', transferAction, transferId, ...rest });
      if (transferAction === 'finalize' && result.pending) {
        await Promise.all([...host.uploads.pending.values()]);
        result = await host.fileWrite({ owner: 'owner', transferAction: 'status', transferId });
        if (result.lastError) { const error = new Error(result.lastError.message); error.code = result.lastError.code; throw error; }
      }
      return result;
    } };
}
test('UTF8/base64 chunks, JSON escaping, byte offsets, retries, restart and atomic permission-preserving finalize', async t => {
  const f = fixture(t), id = randomUUID(), first = '😀"\\\n\u0000', binary = Buffer.from([255,0,13,128]);
  const whole = Buffer.concat([Buffer.from(first), binary]);
  writeFileSync(f.path, 'old', { mode: 0o640 }); chmodSync(f.path,0o640);
  const begin = { path: f.path, expectedSha256: sha('old'), totalBytes: whole.length, sha256: sha(whole) };
  await f.call('begin', id, begin);
  assert.equal((await f.call('begin', id, begin)).nextOffset, 0);
  await assert.rejects(f.call('begin', id, { ...begin, totalBytes: 1 }), { code: 'TRANSFER_CONFLICT' });
  const args = JSON.parse(JSON.stringify({ content: first, offset: 0, chunkSha256: sha(first) }));
  assert.equal((await f.call('chunk', id, args)).nextOffset, Buffer.byteLength(first));
  assert.equal((await f.call('chunk', id, args)).duplicate, true);
  assert.equal(readFileSync(f.path, 'utf8'), 'old');
  f.reopen();
  assert.equal((await f.call('status', id)).nextOffset, Buffer.byteLength(first));
  await f.call('chunk', id, { offset: Buffer.byteLength(first), content: binary.toString('base64'), encoding: 'base64' });
  const done = await f.call('finalize', id);
  assert.equal(done.transferState, 'completed'); assert.equal(done.sha256, sha(whole));
  assert.deepEqual(readFileSync(f.path), whole); assert.equal(statSync(f.path).mode & 0o777, 0o640);
  f.reopen(); assert.equal((await f.call('finalize', id)).sha256, sha(whole));
  assert.equal((await f.call('abort', id)).aborted, false); assert.deepEqual(readFileSync(f.path), whole);
});
test('out-of-order, differing retries, hashes, missing final declarations and owner scope fail safely', async t => {
  const f = fixture(t), id = randomUUID();
  await f.call('begin', id, { path: f.path });
  await assert.rejects(f.call('chunk', id, { offset: 1, content: 'x' }), { code: 'OFFSET_CONFLICT' });
  await assert.rejects(f.call('chunk', id, { offset: 0, content: 'x', chunkSha256: sha('y') }), { code: 'CHUNK_HASH_MISMATCH' });
  await assert.rejects(f.call('chunk', id, { offset: 0, content: '???', encoding: 'base64' }), { code: 'INVALID_ARGUMENT' });
  await f.call('chunk', id, { offset: 0, content: 'abc' });
  await assert.rejects(f.call('chunk', id, { offset: 0, content: 'abd' }), { code: 'CHUNK_CONFLICT' });
  await assert.rejects(f.call('finalize', id), { code: 'SIZE_MISMATCH' });
  await assert.rejects(f.call('finalize', id, { totalBytes: 3 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.call('finalize', id, { totalBytes: 3, sha256: sha('wrong') }), { code: 'HASH_CONFLICT' });
  await assert.rejects(f.host.fileWrite({ owner: 'someone-else', transferAction: 'status', transferId: id }), { code: 'NOT_FOUND' });
  await f.call('finalize', id, { totalBytes: 3, sha256: sha('abc') });
  assert.equal(readFileSync(f.path,'utf8'), 'abc');
});
test('original destination precondition is checked at finalization; abort never modifies target', async t => {
  const f = fixture(t), id = randomUUID(); writeFileSync(f.path, 'before');
  await f.call('begin', id, { path: f.path, expectedSha256: sha('before'), totalBytes: 3, sha256: sha('new') });
  await f.call('chunk', id, { offset: 0, content: 'new' }); writeFileSync(f.path, 'external');
  await assert.rejects(f.call('finalize', id), { code: 'HASH_CONFLICT' });
  assert.equal(readFileSync(f.path,'utf8'), 'external');
  assert.equal((await f.call('abort', id)).transferState, 'aborted');
  assert.equal((await f.call('abort', id)).transferState, 'aborted');
  await assert.rejects(f.call('chunk', id, { offset: 3, content: 'x' }), { code: 'TRANSFER_ABORTED' });
  assert.equal(readFileSync(f.path,'utf8'), 'external');
});
test('unacknowledged tail after crash is discarded, acknowledged bytes remain and empty files finalize', async t => {
  const f = fixture(t), id = randomUUID();
  await f.call('begin', id, { path: f.path, totalBytes: 6, sha256: sha('abcdef') });
  await f.call('chunk', id, { offset: 0, content: 'abc' });
  const record = f.host.uploads.get('owner',id); appendFileSync(record.temporary, 'uncommitted');
  f.reopen(); await f.call('chunk', id, { offset: 3, content: 'def' }); await f.call('finalize', id);
  assert.equal(readFileSync(f.path,'utf8'), 'abcdef');
  const empty = randomUUID();
  await f.call('begin', empty, { path: f.path, totalBytes: 0, sha256: sha('') });
  await f.call('finalize', empty); assert.equal(statSync(f.path).size, 0);
});
test('crash after atomic rename recovers by inode and hash, without repeating replacement', async t => {
  const f = fixture(t), id = randomUUID();
  await f.call('begin', id, { path: f.path, expectedSha256: null, totalBytes: 3, sha256: sha('new') });
  await f.call('chunk', id, { offset: 0, content: 'new' });
  const save = f.host.uploads.save.bind(f.host.uploads);
  f.host.uploads.save = record => { if (record.state === 'completed') throw new Error('simulated receipt crash'); save(record); };
  await assert.rejects(f.call('finalize', id)); const inode = statSync(f.path).ino;
  f.reopen(); assert.equal((await f.call('status', id)).resumeRequired, true);
  assert.equal((await f.call('finalize', id)).sha256, sha('new')); assert.equal(statSync(f.path).ino, inode);
});
test('crash recovery does not claim completion for a replaced destination', async t => {
  const f = fixture(t), id = randomUUID();
  await f.call('begin', id, { path: f.path, totalBytes: 3, sha256: sha('new') });
  await f.call('chunk', id, { offset: 0, content: 'new' });
  const save = f.host.uploads.save.bind(f.host.uploads);
  f.host.uploads.save = record => { if (record.state === 'completed') throw new Error('simulated crash'); save(record); };
  await assert.rejects(f.call('finalize', id));
  writeFileSync(join(f.base,'other'), 'new'); renameSync(join(f.base,'other'),f.path);
  f.reopen(); assert.equal((await f.call('status', id)).resumeRequired, true);
  await assert.rejects(f.call('finalize', id), { code: 'TRANSFER_UNCERTAIN' });
  assert.equal(readFileSync(f.path,'utf8'),'new');
});
test('symlink target is preserved; retargeting is rejected and disk failures leave original intact', async t => {
  const f = fixture(t), id = randomUUID(), alias = join(f.base,'alias'); writeFileSync(f.path,'old'); symlinkSync(f.path,alias);
  await f.call('begin',id,{ path: alias,totalBytes:3,sha256:sha('new') });
  const available=f.host.uploads.available;
  f.host.uploads.available=async()=>{ const e=new Error();e.code='ENOSPC';throw e; };
  await assert.rejects(f.call('chunk',id,{offset:0,content:'new'}),{code:'ENOSPC'});
  assert.equal((await f.call('status',id)).nextOffset,0); assert.equal(readFileSync(f.path,'utf8'),'old');
  f.host.uploads.available=available; await f.call('chunk',id,{offset:0,content:'new'});
  rmSync(alias); writeFileSync(join(f.base,'other'),'other'); symlinkSync(join(f.base,'other'),alias);
  await assert.rejects(f.call('finalize',id),{code:'HASH_CONFLICT'});
  rmSync(alias);symlinkSync(f.path,alias);await f.call('finalize',id);
  assert.equal(readFileSync(alias,'utf8'),'new');
});
test('dead-process locks recover; active locks fail rather than concurrent writes', async t => {
  const f=fixture(t),id=randomUUID();await f.call('begin',id,{path:f.path});
  f.host.db.prepare('INSERT INTO host_upload_locks VALUES(?,?,?,?,?)').run('owner',id,'dead',2147483647,'nonexistent');
  assert.equal((await f.call('status',id)).nextOffset,0);
  const proc=readFileSync('/proc/'+process.pid+'/stat','utf8');
  const start=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()+':'+proc.slice(proc.lastIndexOf(')')+2).split(' ')[19];
  f.host.db.prepare('INSERT INTO host_upload_locks VALUES(?,?,?,?,?)').run('owner',id,'active',process.pid,start);
  await assert.rejects(f.call('status',id),{code:'TRANSFER_BUSY'});
});
test('transfer schema preserves legacy calls and supports safe integer sizes without a total quota',()=>{
  const schema=hostTools.host_file_write.schema;
  assert.equal(schema.parse({path:'/tmp/a',content:'old'}).mode,'replace');
  assert.equal(schema.parse({path:'/tmp/a',transferAction:'begin',transferId:randomUUID(),totalBytes:2**42}).totalBytes,2**42);
  assert.equal(schema.parse({transferAction:'chunk',transferId:randomUUID(),offset:0}).offset,0);
});
test('128 MiB upload is bounded-memory under a 32 MiB V8 heap', t => {
  const f=fixture(t);
  const script=`
    import { HostAccess } from './src/code/host.js';
    import { createHash,randomUUID } from 'node:crypto';
    const h=new HostAccess({dataDirectory:process.argv[1]});
    const id=randomUUID(), block='x'.repeat(262144), count=512, digest=createHash('sha256');
    for(let i=0;i<count;i++)digest.update(block);
    const call=(transferAction,rest={})=>h.fileWrite({owner:'memory',transferId:id,transferAction,...rest});
    await call('begin',{path:process.argv[2],totalBytes:block.length*count,sha256:digest.digest('hex')});
    const baseline=process.memoryUsage().rss;let peak=baseline;
    for(let i=0;i<count;i++){await call('chunk',{content:block,offset:i*block.length});peak=Math.max(peak,process.memoryUsage().rss);}
    await call('finalize');await Promise.all([...h.uploads.pending.values()]);const result=await call('status');peak=Math.max(peak,process.memoryUsage().rss);
    console.log(JSON.stringify({state:result.transferState,bytes:result.nextOffset,extraRss:peak-baseline}));h.close();
  `;
  const result=spawnSync(process.execPath,['--max-old-space-size=32','--input-type=module','-e',script,join(f.base,'memory-state'),join(f.base,'large')],{encoding:'utf8',timeout:120000});
  assert.equal(result.status,0,result.stderr); const report=JSON.parse(result.stdout.trim());
  assert.equal(report.state,'completed');assert.equal(report.bytes,128*1024*1024);
  assert.ok(report.extraRss<96*1024*1024,JSON.stringify(report));
  t.diagnostic(JSON.stringify(report));
});

test('SIGKILL during verification leaves an explicit resumable receipt and stale process lock', async t => {
  const f=fixture(t), id=randomUUID();
  const script=`
    import { HostAccess } from './src/code/host.js';
    const h=new HostAccess({dataDirectory:process.argv[1]});
    const transferId=process.argv[3], call=(transferAction,rest={})=>h.fileWrite({owner:'owner',transferId,transferAction,...rest});
    await call('begin',{path:process.argv[2],totalBytes:3,sha256:'${sha('abc')}'});
    await call('chunk',{offset:0,content:'abc'});
    h.uploads.h.hashHandle=async()=>{process.kill(process.pid,'SIGKILL');await new Promise(()=>{});};
    await call('finalize');
  `;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script,f.directory,f.path,id],{encoding:'utf8',timeout:10000});
  assert.equal(child.signal,'SIGKILL',child.stderr);
  f.reopen();const state=await f.call('status',id);
  assert.equal(state.transferState,'verifying');assert.equal(state.resumeRequired,true);
  assert.equal((await f.call('finalize',id)).transferState,'completed');
  assert.equal(readFileSync(f.path,'utf8'),'abc');
});
test('close cancels active verification promptly while preserving resumable staged bytes', async t => {
  const base=mkdtempSync(join(tmpdir(),'praxis-upload-close-')),directory=join(base,'state');
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  let host=new HostAccess({dataDirectory:directory});const path=join(base,'target'),id=randomUUID();
  const call=(transferAction,rest={})=>host.fileWrite({owner:'owner',transferAction,transferId:id,...rest});
  await call('begin',{path,totalBytes:3,sha256:sha('abc')});await call('chunk',{offset:0,content:'abc'});
  let startedResolve;const started=new Promise(resolve=>startedResolve=resolve);
  host.uploads.h.hashHandle=async(handle,{signal})=>{
    startedResolve();
    await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  };
  await call('finalize');await started;
  const before=Date.now();await host.close();assert.ok(Date.now()-before<1000);
  host=new HostAccess({dataDirectory:directory});
  const receipt=await call('status');assert.equal(receipt.resumeRequired,true);assert.equal(receipt.transferState,'verifying');
  await call('finalize');await Promise.all([...host.uploads.pending.values()]);
  assert.equal((await call('status')).transferState,'completed');assert.equal(readFileSync(path,'utf8'),'abc');
  await host.close();
});

test('unexpected staging symlink is never followed by chunks or finalize', async t => {
 const f=fixture(t),id=randomUUID(),victim=join(f.base,'victim');writeFileSync(victim,'untouched');
 await f.call('begin',id,{path:f.path,totalBytes:3,sha256:sha('new')});
 const record=f.host.uploads.get('owner',id);rmSync(record.temporary);symlinkSync(victim,record.temporary);
 await assert.rejects(f.call('chunk',id,{offset:0,content:'new'}),{code:'ELOOP'});
 assert.equal(readFileSync(victim,'utf8'),'untouched');await f.call('abort',id);
 assert.equal(readFileSync(victim,'utf8'),'untouched');
});

test('begin defers destination SHA work to asynchronous finalize and reports unverified precondition', async t => {
 const f=fixture(t),id=randomUUID();writeFileSync(f.path,'old');
 const original=f.host.uploads.h.precondition;let calls=0;
 f.host.uploads.h.precondition=async(...args)=>{calls++;return original(...args);};
 const begun=await f.call('begin',id,{path:f.path,expectedSha256:sha('old'),totalBytes:3,sha256:sha('new')});
 assert.equal(calls,0);assert.equal(begun.preconditionVerified,false);
 await f.call('chunk',id,{offset:0,content:'new'});
 const pending=await f.host.fileWrite({owner:'owner',transferId:id,transferAction:'finalize'});
 assert.equal(pending.pending,true);assert.equal(pending.preconditionVerified,false);
 await Promise.all([...f.host.uploads.pending.values()]);
 assert.equal((await f.call('status',id)).preconditionVerified,true);assert.ok(calls>=2);
 const absent=randomUUID();
 await assert.rejects(f.call('begin',absent,{path:f.path,expectedSha256:null}),{code:'HASH_CONFLICT'});
 await assert.rejects(f.call('begin',randomUUID(),{path:join(f.base,'missing'),expectedSha256:sha('old')}),{code:'HASH_CONFLICT'});
});

test('shared verification worker queues across instances and abort cancels queued and active hashes', async t => {
  const first=fixture(t),second=fixture(t),id1=randomUUID(),id2=randomUUID();
  for(const [f,id] of [[first,id1],[second,id2]]) {
    await f.call('begin',id,{path:f.path,totalBytes:3,sha256:sha('abc')});
    await f.call('chunk',id,{offset:0,content:'abc'});
  }
  let startedResolve;const started=new Promise(resolve=>startedResolve=resolve);let secondHashes=0;
  first.host.uploads.h.hashHandle=async(handle,{signal})=>{
    startedResolve();
    await new Promise((resolve,reject)=>{ if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true}); });
  };
  const original=second.host.uploads.h.hashHandle;
  second.host.uploads.h.hashHandle=async(...args)=>{secondHashes++;return original(...args);};
  await first.host.fileWrite({owner:'owner',transferId:id1,transferAction:'finalize'});await started;
  const queued=await second.host.fileWrite({owner:'owner',transferId:id2,transferAction:'finalize'});
  assert.equal(queued.pending,true);assert.equal(queued.queued,true);assert.equal(secondHashes,0);
  assert.equal((await second.call('status',id2)).queued,true);
  assert.equal((await second.call('abort',id2)).transferState,'aborted');
  assert.equal(secondHashes,0);
  assert.equal((await first.call('abort',id1)).transferState,'aborted');
  await Promise.all([...first.host.uploads.pending.values(),...second.host.uploads.pending.values()]);
  assert.equal((await first.call('status',id1)).transferState,'aborted');
  const id3=randomUUID();await second.call('begin',id3,{path:second.path,totalBytes:3,sha256:sha('abc')});
  await second.call('chunk',id3,{offset:0,content:'abc'});
  assert.equal((await second.call('finalize',id3)).transferState,'completed');assert.equal(secondHashes,1);
});
test('large base64 validation is linear and enforces padding bits without regex stack exhaustion', async t => {
  assert.equal(isCanonicalBase64('A'.repeat(16*1024*1024)),true);
  for(const value of ['', 'AA==','AAA=','AAAA','/w==','//8='])assert.equal(isCanonicalBase64(value),true,value);
  for(const value of ['A','A===','AA=A','AB==','AAB=','AA\n=','====','/x=='])assert.equal(isCanonicalBase64(value),false,value);
  const f=fixture(t);await assert.rejects(f.host.fileWrite({owner:'owner',path:f.path,content:'AB==',encoding:'base64'}),{code:'INVALID_ARGUMENT'});
  const id=randomUUID();await f.call('begin',id,{path:f.path});
  await assert.rejects(f.call('chunk',id,{offset:Number.MAX_SAFE_INTEGER+1,content:'abc'}),{code:'INVALID_ARGUMENT'});
});

test('zero-offset staging loss recreates staging identity safely', async t => {
 const f=fixture(t),id=randomUUID();
 await f.call('begin',id,{path:f.path,totalBytes:3,sha256:sha('abc')});
 rmSync(f.host.uploads.get('owner',id).temporary);f.reopen();
 await f.call('chunk',id,{offset:0,content:'abc'});await f.call('finalize',id);
 assert.equal(readFileSync(f.path,'utf8'),'abc');
 const empty=randomUUID();await f.call('begin',empty,{path:f.path,totalBytes:0,sha256:sha('')});
 rmSync(f.host.uploads.get('owner',empty).temporary);f.reopen();
 assert.equal((await f.call('finalize',empty)).transferState,'completed');assert.equal(statSync(f.path).size,0);
});
