import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { createAdmission, annotateTransport, transportPolicy, structuralMemory } from '../src/transport.js';
async function fixture(t, memory=()=>64*1024*1024) {
  const admission=createAdmission({availableMemory:memory});
  const app=express(); let unblock;
  app.use((req,res,next)=>req.headers.authorization==='Bearer test'?next():res.sendStatus(401));
  app.use(admission.middleware);
  app.post('/hold',async(req,res)=>{await new Promise(resolve=>{unblock=resolve});res.json({ok:true})});
  app.post('/',(req,res)=>res.json({length:JSON.stringify(req.body).length}));
  app.use((err,req,res,next)=>res.status(err.status||400).json({error:'invalid_json'}));
  const server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
  t.after(()=>{unblock?.();server.closeAllConnections();server.close()});
  const url='http://127.0.0.1:'+server.address().port;
  return {admission,url,release:()=>unblock?.()};
}
const headers={authorization:'Bearer test','content-type':'application/json'};
test('budget derives from live resources, not fixed body or total file cap',()=>{
 let memory=64*1024*1024;const a=createAdmission({availableMemory:()=>memory});
 assert.equal(a.budget(),1024*1024);memory/=2;assert.equal(a.budget(),524288);
 assert.equal(transportPolicy(a.budget()).totalFileBytes,null);
});
test('authenticated JSON above former 512KiB is accepted and budget advertised',async t=>{
 const {url,admission}=await fixture(t,()=>512*1024*1024);
 const body=JSON.stringify({content:'😀é\n"'.repeat(350000)});
 assert.ok(Buffer.byteLength(body)>2027125);
 const r=await fetch(url,{method:'POST',headers,body});
 assert.equal(r.status,200);assert.ok(+r.headers.get('x-praxis-request-budget-bytes')>Buffer.byteLength(body));
 await r.json();assert.equal(admission.reservedBytes,0);
});
test('oversized and compressed requests reject before parse, ordinary calls survive',async t=>{
 const {url,admission}=await fixture(t);
 for(const [body,extra,status] of [['x'.repeat(1100000),{},413],[gzipSync('{"x":1}'),{'content-encoding':'gzip'},415]]) {
 const r=await fetch(url,{method:'POST',headers:{...headers,...extra},body});assert.equal(r.status,status);await r.text();
 assert.equal(admission.reservedBytes,0);
 }
 const r=await fetch(url,{method:'POST',headers,body:'{"x":1}'});assert.equal(r.status,200);
});
test('auth precedes allocation, unsupported JSON and malformed input retain semantics',async t=>{
 const {url,admission}=await fixture(t);
 for(const [h,b,status] of [[{'content-type':'application/json'},'x'.repeat(1100000),401],
 [{...headers,'content-type':'text/plain'},'{}',415],[headers,'{',400]]) {
 const r=await fetch(url,{method:'POST',headers:h,body:b});assert.equal(r.status,status);await r.text();
 assert.equal(admission.reservedBytes,0);
 }
});
test('concurrent reservations reduce available budget until response finishes',async t=>{
 const {url,admission,release}=await fixture(t);
 const pending=fetch(url+'/hold',{method:'POST',headers,body:JSON.stringify({x:'a'.repeat(700000)})});
 while(!admission.reservedBytes) await new Promise(r=>setTimeout(r,5));
 assert.ok(admission.budget()<400000);
 const r=await fetch(url,{method:'POST',headers,body:JSON.stringify({x:'b'.repeat(400000)})});assert.equal(r.status,413);await r.text();
 release();await (await pending).text();assert.equal(admission.reservedBytes,0);
});
test('chunked bodies are counted and aborts release reservations',async t=>{
 const {url,admission}=await fixture(t);
 const status=await new Promise((resolve,reject)=>{
 const req=http.request(url,{method:'POST',headers},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});
 req.on('error',reject);req.write('{"x":"');req.write('a'.repeat(1100000));req.end('"}');
 });assert.equal(status,413);
 const req=http.request(url,{method:'POST',headers});req.on('error',()=>{});req.write('{"x":"');
 while(!admission.reservedBytes)await new Promise(r=>setTimeout(r,5));
 req.destroy();
 for(let i=0;i<100&&admission.reservedBytes;i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(admission.reservedBytes,0);
});
test('no headroom returns retryable 503 and front annotation is advisory minimum',async t=>{
 const {url}=await fixture(t,()=>0);
 const r=await fetch(url,{method:'POST',headers,body:'{}'});assert.equal(r.status,503);
 const data=annotateTransport({limits:{requestBytes:2000,transport:transportPolicy(2000)}},transportPolicy(1000));
 assert.equal(data.limits.transport.requestBytes,1000);assert.equal(data.limits.transport.advisory,true);
});

test('structural accounting ignores escaped punctuation and handles Unicode JSON',()=>{
 const value={x:'{}[], \\" \\\\ 😀é'.repeat(100)};
 assert.equal(structuralMemory(Buffer.from(JSON.stringify(value))),256);
 assert.equal(structuralMemory(Buffer.from('[{},[],{}]')),256*4+32*2);
 assert.equal(structuralMemory(Buffer.from(JSON.stringify(value),'utf16le'),'utf-16le'),256);
});
test('dense object graph is rejected before parse without breaking later requests',async t=>{
 const {url,admission}=await fixture(t);
 const body='['+'{},'.repeat(150000)+'{}]';
 const r=await fetch(url,{method:'POST',headers,body});assert.equal(r.status,413);
 assert.equal((await r.json()).error.code,'RESOURCE_BUDGET');
 assert.equal(admission.reservedBytes,0);
 const good=await fetch(url,{method:'POST',headers,body:'{"x":"{}[],\\\""}'});
 assert.equal(good.status,200);
});

test('small genuine chunked JSON succeeds and returns all reservation capacity',async t=>{
 const {url,admission}=await fixture(t);
 const status=await new Promise((resolve,reject)=>{
  const req=http.request(url,{method:'POST',headers},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});
  req.on('error',reject);req.write('{"x":');req.end('"ok"}');
 });assert.equal(status,200);assert.equal(admission.reservedBytes,0);
});
