import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { z } from 'zod';
import { createApp } from '../src/server.js';
import { createFacadeApp } from '../src/claude-facade/server.js';
import { observeMcpHttp } from '../src/mcp.js';
import { requestContext } from '../src/diagnostics.js';

async function fixture(t, endpoint) {
  const directory=mkdtempSync(join(tmpdir(),'praxis-endpoint-telemetry-'));
  const {privateKey}=await generateKeyPair('RS256',{extractable:true});
  const jwk={...await exportJWK(privateKey),kid:'telemetry-test',use:'sig',alg:'RS256'};
  const salt=randomBytes(16);
  const passwordHash=`scrypt$${salt.toString('base64url')}$${scryptSync('fixture-password',salt,64).toString('base64url')}`;
  let service;
  const http=createServer((req,res)=>service.app(req,res));
  const backend=createServer(async(req,res)=>{
    let body=''; for await (const chunk of req) body+=chunk;
    const {args}=JSON.parse(body);
    if(args.note==='PRIVATE_SLOW') await new Promise(resolve=>setTimeout(resolve,30));
    res.setHeader('content-type','application/json');
    if(args.mode==='returned') res.end(JSON.stringify({ok:true,data:{ok:false,error:{code:'NOT_FOUND',message:'PRIVATE_BACKEND_MESSAGE'}}}));
    else if(args.mode==='thrown') { res.statusCode=503; res.end('PRIVATE_NON_JSON_BACKEND_ERROR'); }
    else res.end(JSON.stringify({ok:true,data:{payload:'PRIVATE_RESULT_CONTENT'}}));
  });
  for(const server of [http,backend]) await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const baseUrl=`http://127.0.0.1:${http.address().port}/praxis`;
  const resourceUrl=endpoint==='canonical' ? baseUrl+'/mcp' : `http://127.0.0.1:${http.address().port}/mcp`;
  const coding={url:`http://127.0.0.1:${backend.address().port}`};
  const applicationTools={projects_list:{title:'Fixture',description:'Telemetry fixture',schema:z.object({mode:z.enum(['success','returned','thrown']).default('success'),note:z.string().optional()}),
    route:{target:'coding',action:'projects_list'}}};
  const token=await new SignJWT({scope:'praxis:code',client_id:'fixture-client'}).setProtectedHeader({alg:'RS256',kid:jwk.kid,typ:'at+jwt'})
    .setIssuer(baseUrl+'/oauth').setAudience(baseUrl+'/mcp').setSubject('jensen').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  if(endpoint==='canonical') service=await createApp({baseUrl,allowLoopback:true,dataDirectory:directory,release:'fixture',coding,applicationTools,
    auth:{passwordHash,jwks:{keys:[jwk]},cookieKeys:['fixture-cookie-signing-key-at-least-32-characters']}});
  else service=createFacadeApp({env:{FACADE_DATA_DIRECTORY:directory,FACADE_CODING_URL:coding.url,FACADE_PUBLIC_HOSTNAME:'localhost'},
    // Test the actual facade HTTP adapter with an authenticated-provider fixture;
    // production OAuth behavior remains covered by claude-facade.test.js.
    provider:{clientsStore:{},verifyAccessToken:async value=>{
      if(value!==token) throw new Error('invalid fixture credential');
      return {backendToken:token,clientId:'fixture-client',scopes:['praxis:code'],resource:new URL(resourceUrl),expiresAt:Math.floor(Date.now()/1000)+300};
    }},applicationTools:()=>applicationTools});
  t.after(async()=>{
    for(const server of [http,backend]) { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
    await service.close();rmSync(directory,{recursive:true,force:true});
  });
  async function request(body,extraHeaders={}) {
    const response=await fetch(resourceUrl,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',
      accept:'application/json, text/event-stream','mcp-protocol-version':'2025-03-26',...extraHeaders},body:JSON.stringify(body)});
    const text=await response.text();
    const data=text.startsWith('event:') || text.startsWith('data:') ? JSON.parse(text.split('\n').find(line=>line.startsWith('data:')).slice(5)) : text ? JSON.parse(text) : null;
    return {response,data};
  }
  const call=(name,args={},id=1)=>request({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}});
  return {service,request,call,records:()=>service.audit.list('jensen',0,100).observations};
}

for(const endpoint of ['canonical','claude_facade']) {
  test(endpoint+' HTTP adapter records successful, invalid, returned and thrown tool outcomes',async t=>{
    const f=await fixture(t,endpoint);
    const cases=[['success',{mode:'success',note:'PRIVATE_ARGUMENT'},true,null],
      ['invalid',{mode:123},false,'INVALID_ARGUMENT'],['returned',{mode:'returned'},false,'NOT_FOUND'],
      ['thrown',{mode:'thrown'},false,'BACKEND_UNAVAILABLE']];
    for(const [label,args,ok,code] of cases) {
      const {response,data}=await f.call('projects_list',args);
      assert.equal(response.status,200,label);
      assert.equal(data.result.structuredContent.ok,ok,label);
      const httpId=response.headers.get('x-praxis-request-id');assert.ok(httpId);
      const rows=f.records(), tool=rows.find(row=>row.requestId===data.result.structuredContent.requestId);
      assert.equal(tool.kind,'tool');assert.equal(tool.ok,ok);assert.equal(tool.errorCode,code);
      assert.equal(tool.httpRequestId,httpId);
      assert.equal(rows.filter(row=>row.kind==='http'&&row.requestId===httpId).length,1);
      assert.equal(rows.filter(row=>row.kind==='protocol'&&row.httpRequestId===httpId).length,0);
    }
    const report=(await f.call('usage_summary')).data.result.structuredContent;
    assert.equal(report.observationScope.endpoint,endpoint);assert.equal(report.observationScope.history,'endpoint-local');
    assert.equal(report.usage.calls,4);assert.equal(report.usage.failures,3);
    const list=(await f.call('observations_list')).data.result.structuredContent;
    assert.equal(list.observationScope.endpoint,endpoint);
    assert.doesNotMatch(JSON.stringify(f.records()),/PRIVATE_|fixture-password|Bearer|fixture-client/);
  });
  test(endpoint+' unhandled tool requests are distinct from completed tool outcomes',async t=>{
    const f=await fixture(t,endpoint);
    const {response}=await f.call('PRIVATE_UNKNOWN_TOOL',{note:'PRIVATE_ARGUMENT'});
    const httpId=response.headers.get('x-praxis-request-id'), rows=f.records();
    const protocol=rows.filter(row=>row.kind==='protocol'&&row.httpRequestId===httpId);
    assert.equal(protocol.length,1);
    assert.equal(protocol[0].status,response.status);
    assert.equal(Object.hasOwn(protocol[0],'ok'),false);
    assert.equal(Object.hasOwn(protocol[0],'tool'),false);
    assert.equal(rows.filter(row=>row.kind==='tool').length,0);
    assert.equal(f.service.audit.summary('jensen').usage.calls,0);
    // A missing-id notification is not proof of rejection and is excluded.
    const notification=await f.request({jsonrpc:'2.0',method:'tools/call',params:{name:'PRIVATE_UNKNOWN_TOOL'}});
    assert.equal(f.records().filter(row=>row.kind==='protocol'&&row.httpRequestId===notification.response.headers.get('x-praxis-request-id')).length,0);
    // Missing tool name remains an unhandled request; no input value is retained.
    const malformed=await f.request({jsonrpc:'2.0',id:2,method:'tools/call',params:{arguments:{note:'PRIVATE_ARGUMENT'}}});
    assert.equal(f.records().filter(row=>row.kind==='protocol'&&row.httpRequestId===malformed.response.headers.get('x-praxis-request-id')).length,1);
    assert.doesNotMatch(JSON.stringify(f.records()),/PRIVATE_/);
  });
  test(endpoint+' concurrent requests keep HTTP and tool correlation isolated',async t=>{
    const f=await fixture(t,endpoint);
    const [known,unknown]=await Promise.all([
      f.call('projects_list',{note:'PRIVATE_SLOW'},10),f.call('PRIVATE_UNKNOWN_TOOL',{},11)
    ]);
    const knownId=known.response.headers.get('x-praxis-request-id'), unknownId=unknown.response.headers.get('x-praxis-request-id');
    assert.notEqual(knownId,unknownId);
    const rows=f.records();
    assert.equal(rows.filter(row=>row.kind==='tool'&&row.httpRequestId===knownId).length,1);
    assert.equal(rows.filter(row=>row.kind==='protocol'&&row.httpRequestId===knownId).length,0);
    assert.equal(rows.filter(row=>row.kind==='tool'&&row.httpRequestId===unknownId).length,0);
    assert.equal(rows.filter(row=>row.kind==='protocol'&&row.httpRequestId===unknownId).length,1);
    assert.equal(rows.filter(row=>row.kind==='http').length,2);
  });
  test(endpoint+' unauthenticated requests never receive owner observations',async t=>{
    const f=await fixture(t,endpoint);
    const result=await f.request({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'projects_list'}},{authorization:'Bearer PRIVATE_INVALID_TOKEN'});
    assert.equal(result.response.status,401);
    assert.equal(f.records().length,0);
  });
  test(endpoint+' audit write failure does not change a completed tool response',async t=>{
    const f=await fixture(t,endpoint), original=f.service.audit.record;
    const diagnostics=[];t.mock.method(console,'error',value=>diagnostics.push(value));
    f.service.audit.record=()=>{throw new Error('PRIVATE_AUDIT_ERROR')};
    t.after(()=>{f.service.audit.record=original});
    const {response,data}=await f.call('projects_list');
    assert.equal(response.status,200);assert.equal(data.result.structuredContent.ok,true);
    assert.equal(data.result.structuredContent.payload,'PRIVATE_RESULT_CONTENT');
    assert.ok(diagnostics.some(line=>line.includes('mcp_audit_failed')));
    assert.doesNotMatch(diagnostics.join(' '),/PRIVATE_/);
  });
}

test('HTTP observation records once and never infers dispatch failure for aborted requests, batches or null IDs',()=>{
  for(const body of [{method:'tools/call',id:1},{method:'tools/call',id:null},[{method:'tools/call',id:1}]]) {
    const rows=[],res=new EventEmitter();res.statusCode=200;res.writableFinished=false;
    const req={method:'POST',body,get:()=>undefined};
    requestContext.run({requestId:'fixture-request',httpRequestId:'fixture-request'},()=>{
      observeMcpHttp(req,res,{record:(_owner,row)=>rows.push(row)},'jensen');
      res.emit('close');res.emit('finish');
    });
    assert.equal(rows.length,1);assert.equal(rows[0].kind,'http');assert.equal(rows[0].aborted,true);
  }
});

test('completed null-ID messages and batches only receive HTTP observations',()=>{
  for(const body of [{method:'tools/call',id:null},[{method:'tools/call',id:1}]]){
    const rows=[],res=new EventEmitter();res.statusCode=200;res.writableFinished=true;
    requestContext.run({requestId:'fixture-request'},()=>{
      observeMcpHttp({method:'POST',body,get:()=>undefined},res,{record:(_owner,row)=>rows.push(row)},'jensen');
      res.emit('finish');res.emit('close');
    });
    assert.equal(rows.length,1);assert.equal(rows[0].kind,'http');assert.equal(rows[0].aborted,false);
  }
});
