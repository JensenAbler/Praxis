import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditStore } from '../src/audit.js';
import { usageSignals } from '../src/usage-telemetry.js';
function fixture(t, options) {
  const root=mkdtempSync(join(tmpdir(),'praxis-usage-'));
  const store=new AuditStore(root,options);
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  return {store,root};
}
test('storage allowlist strips sensitive payloads and unknown error text', t=>{
  const {store}=fixture(t);
  store.record('jensen',{requestId:'r1',kind:'tool',tool:'file_read',ok:false,errorCode:'SECRET_TOKEN',
    args:{token:'SECRET'},command:'SECRET',content:'SECRET',error:{message:'SECRET'},durationMs:Infinity});
  const text=JSON.stringify(store.list('jensen'));
  assert.ok(!text.includes('SECRET'));
  assert.equal(store.summary('jensen').usage.tools[0].errors.OTHER_ERROR,1);
});
test('report counts failures, percentiles, pagination, waits and isolates owner/window',t=>{
  const {store}=fixture(t);
  for(let i=1;i<=20;i++) store.record('jensen',{requestId:'r'+i,kind:'tool',tool:'file_read',ok:i!==1,
    errorCode:i===1?'HASH_CONFLICT':null,retryStrategy:i===1?'refresh_state':undefined,durationMs:i,resultJsonBytes:100,
    ...usageSignals({cursor:i>1?12:0},{hasMore:true,nextCursor:42,wait:{terminal:false},truncated:true})});
  store.record('other',{requestId:'x',kind:'tool',tool:'private',ok:true});
  store.record('jensen',{requestId:'old',kind:'tool',tool:'old'});
  store.db.prepare('UPDATE observations SET recorded_at=? WHERE request_id=?').run(new Date(Date.now()-8*86400000).toISOString(),'old');
  const report=store.summary('jensen',{days:7,limit:1});
  assert.equal(report.usage.calls,20);assert.equal(report.usage.failures,1);
  const g=report.usage.tools[0];
  assert.equal(g.p50DurationMs,10);assert.equal(g.p95DurationMs,19);
  assert.equal(g.continuations,19);assert.equal(g.pagesWithMore,20);
  assert.equal(g.pendingWaits,20);assert.equal(g.truncatedResults,20);
  assert.deepEqual(g.recoveryStrategies,[{strategy:'refresh_state',count:1}]);
  assert.throws(()=>store.summary('jensen',{days:31}),RangeError);
});
test('retention is exact, expires on reads, storage stabilizes and persists after reopen',t=>{
  const {store,root}=fixture(t,{maxRecords:25});
  for(let i=0;i<500;i++)store.record('jensen',{requestId:'r'+i,kind:'tool',tool:'file_read',ok:true,content:'x'.repeat(100000)});
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM observations').get().n,25);
  const bytes=statSync(join(root,'observations.sqlite')).size;
  assert.ok(bytes<1024*1024);
  store.db.prepare('UPDATE observations SET recorded_at=?').run('2000-01-01T00:00:00.000Z');
  assert.equal(store.list('jensen').observations.length,0);
  store.record('jensen',{requestId:'new',kind:'tool',tool:'file_read',ok:true});
  const reopened=new AuditStore(root);assert.equal(reopened.summary('jensen').usage.calls,1);reopened.close();
});
test('legacy missing timings do not create fake latency; output tool list stays bounded',t=>{
  const {store}=fixture(t);
  for(let i=0;i<60;i++) store.record('jensen',{requestId:'r'+i,kind:'tool',tool:'t'+i,ok:true});
  const r=store.summary('jensen',{limit:5});
  assert.equal(r.usage.tools.length,5);assert.equal(r.usage.omittedTools,55);
  assert.equal(r.usage.tools[0].p95DurationMs,null);
});

test('continuation-only responses and actual recovery strategies are reported accurately', t=>{
  assert.equal(usageSignals({}, {nextCursor:42}).moreAvailable,true);
  assert.equal(usageSignals({cursor:'opaque-page'}, {nextCursor:'next-opaque'}).continuation,true);
  assert.equal(usageSignals({}, {nextCursor:'next-opaque'}).moreAvailable,true);
  assert.equal(usageSignals({cursor:''}, {nextCursor:''}).continuation,false);
  assert.equal(usageSignals({}, {nextCursor:''}).moreAvailable,false);
  assert.equal(usageSignals({}, {nextCursor:null}).moreAvailable,false);
  assert.equal(usageSignals({}, {nextCursor:42,hasMore:false}).moreAvailable,false);
  const {store}=fixture(t);
  store.record('jensen',{requestId:'r',kind:'tool',tool:'file_read',ok:false,errorCode:'INTERNAL_ERROR',retryStrategy:'retry_read'});
  store.record('jensen',{requestId:'s',kind:'tool',tool:'workspace_apply',ok:false,errorCode:'INTERNAL_ERROR',retryStrategy:'recover_before_retry'});
  store.record('jensen',{requestId:'legacy',kind:'tool',tool:'legacy_read',ok:false,errorCode:'INTERNAL_ERROR'});
  const tools=store.summary('jensen').usage.tools;
  assert.deepEqual(tools.find(g=>g.tool==='file_read').recoveryStrategies,[{strategy:'retry_read',count:1}]);
  assert.deepEqual(tools.find(g=>g.tool==='workspace_apply').recoveryStrategies,[{strategy:'recover_before_retry',count:1}]);
  assert.deepEqual(tools.find(g=>g.tool==='legacy_read').recoveryStrategies,[{strategy:'legacy_unspecified',count:1}]);
});
