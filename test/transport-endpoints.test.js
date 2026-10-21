import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
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
  return {service,resourceUrl,token,request,call,records:()=>service.audit.list('jensen',0,100).observations};
}


for(const endpoint of ['canonical','claude_facade']) {
 test(endpoint+' accepts authenticated multi-megabyte MCP while preserving host/auth guards',async t=>{
  const f=await fixture(t,endpoint);
  const note='a'.repeat(2100000);
  const result=await f.call('projects_list',{note});
  assert.equal(result.response.status,200);
  assert.equal(result.data.result.structuredContent.ok,true);
  assert.ok(+result.response.headers.get('x-praxis-request-budget-bytes')>2100000);
  const unauthorized=await f.request({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'projects_list',arguments:{note}}},{authorization:'Bearer invalid'});
  assert.equal(unauthorized.response.status,401);
  const badHostStatus=await new Promise((resolve,reject)=>{
   const req=httpRequest(f.resourceUrl,{method:'POST',headers:{Host:'evil.invalid','content-type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});
   req.on('error',reject);req.end('{}');
  });
  assert.equal(badHostStatus,403);
  const malformed=await fetch(f.resourceUrl,{method:'POST',headers:{authorization:'Bearer '+f.token,'content-type':'application/json'},body:'{"private":"PRIVATE_INVALID_JSON" nope}'});
  assert.equal(malformed.status,400);
  const failure=await malformed.text();assert.doesNotMatch(failure,/PRIVATE_/);
  assert.equal(JSON.parse(failure).error,'invalid_json');
 });
}
