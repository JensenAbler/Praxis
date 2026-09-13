import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPublic,resolvePublic,safeURL,displayURL } from '../src/patronus/network.js';
import { extract } from '../src/patronus/extract.js';
import { Patronus } from '../src/patronus/engine.js';
import { patronusTools } from '../src/patronus/schema.js';
test('Patronus rejects internal addresses and mixed DNS answers',async()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','::1','::ffff:127.0.0.1','fc00::1','0.0.0.0','192.168.2.3'])assert.equal(isPublic(ip),false,ip);
 assert.equal(isPublic('1.1.1.1'),true);
 await assert.rejects(resolvePublic('https://test.example',async()=>[{address:'1.1.1.1',family:4},{address:'127.0.0.1',family:4}]),{code:'NETWORK_POLICY'});
 for(const u of ['file:///etc/passwd','http://u:p@example.com','http://example.com:22'])assert.throws(()=>safeURL(u));
 assert.equal(displayURL('https://e.com/x?token=secret#secret'),'https://e.com/x?token=%5Bredacted%5D');
});
test('Patronus preserves relationships and excludes executable content',()=>{
 const r=extract('<html><head><title>Sample</title></head><body><h1>Heading</h1><figure><img src="/a.png" alt="A"><figcaption>Caption</figcaption></figure><table><tr><th>A</th></tr><tr><td>B</td></tr></table><a href="/next">Next</a><script>steal()</script></body></html>','https://example.com/');
 assert.match(r.markdown,/# Heading/);assert.match(r.markdown,/patronus-image:0/);assert.equal(r.images[0].caption,'Caption');assert.equal(r.images[0].url,'https://example.com/a.png');assert.doesNotMatch(r.markdown,/steal/);assert.equal(r.links[0].url,'https://example.com/next');
});
test('Patronus idempotency cancellation and recovery never wait for a person',async()=>{
 const root=mkdtempSync(join(tmpdir(),'patronus-test-'));let e=new Patronus(root);
 try{
 const args=patronusTools.patronus_start.schema.parse({urls:['https://example.com'],idempotencyKey:'test-reader-1'});
 const a=e.start(args);assert.equal(e.start(args).jobId,a.jobId);
 assert.throws(()=>e.start({...args,maxPages:4}),{code:'IDEMPOTENCY_CONFLICT'});
 assert.equal(e.cancel({jobId:a.jobId}).state,'cancelled');
 const b=e.start({...args,idempotencyKey:'test-reader-2'});const d=e.get(b.jobId).data;d.state='running';e.save(d);
 await e.close();e=new Patronus(root);assert.equal(e.status({jobId:b.jobId}).state,'failed');assert.equal(e.status({jobId:b.jobId}).obstacles[0].code,'INTERRUPTED');
 const c=e.start({...args,urls:['http://127.0.0.1'],rendering:'http',idempotencyKey:'test-reader-3'});await e.tick();assert.equal(e.status({jobId:c.jobId}).state,'failed');assert.equal(e.status({jobId:c.jobId}).obstacles[0].code,'NETWORK_POLICY');
 }finally{await e.close();rmSync(root,{recursive:true,force:true});}
});

test('Patronus resumes unchanged files and rejects changed validators',async()=>{
 const {Readable}=await import('node:stream');
 const {readFileSync,writeFileSync}=await import('node:fs');
 const root=mkdtempSync(join(tmpdir(),'patronus-resume-'));
 let etag='"same"';
 const e=new Patronus(root,{requestFn:async(raw,{headers})=>{
  assert.equal(headers.range,'bytes=3-');assert.equal(headers['if-range'],'"same"');
  const response=Readable.from([Buffer.from('def')]);
  response.statusCode=206;response.headers={'content-type':'application/octet-stream','content-length':'3',etag,'content-range':'bytes 3-5/6'};
  return {response,url:raw};
 }});
 try{
  const args=patronusTools.patronus_start.schema.parse({urls:['https://example.com/file'],mode:'download',idempotencyKey:'resume-test-1'});
  const d=e.start(args);const original=join(root,'original');writeFileSync(original,'abc');
  const r=await e.bytes(args.urls[0],d,args,new AbortController().signal,{file:true,resume:{etag:'"same"',bytes:3,path:original}});
  assert.equal(readFileSync(join(root,'jobs',d.jobId,r.artifact.artifactId),'utf8'),'abcdef');
  assert.equal(r.artifact.bytes,6);assert.equal(r.artifact.sha256,'bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721');
  etag='"changed"';
  await assert.rejects(e.bytes(args.urls[0],d,args,new AbortController().signal,{file:true,resume:{etag:'"same"',bytes:3,path:original}}),{code:'RESUME_UNAVAILABLE'});
 }finally{await e.close();rmSync(root,{recursive:true,force:true});}
});
