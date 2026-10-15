import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import http from 'node:http';
import {createHandler,SCOPE} from '../scripts/alpha-backup-oauth.mjs';
test('backup auth requires private link, session, correct account and exact scope',async()=>{
 const dir=fs.mkdtempSync(os.tmpdir()+'/alpha-auth-');
 fs.writeFileSync(dir+'/rclone.conf','[seed]\nclient_id = fixture.apps.googleusercontent.com\nclient_secret = fixture\n');
 let email='wrong@example.test';
 const h=createHandler({dir,origin:'http://localhost',key:'fixture',expectedEmail:'owner@example.test',fetcher:async u=>({ok:true,json:async()=>u.includes('/token')?{access_token:'test',refresh_token:'test',scope:SCOPE,expires_in:3600}:{user:{emailAddress:email},storageQuota:{limit:'100000000000'}}})});
 const s=http.createServer(h);await new Promise(r=>s.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+s.address().port;
 try{
 assert.equal((await fetch(base+'/drive-audit/setup/no')).status,404);
 const init=await fetch(base+'/drive-audit/setup/fixture',{redirect:'manual'});const cookie=init.headers.get('set-cookie').split(';')[0];
 const page=await(await fetch(base+'/drive-audit/setup',{headers:{cookie}})).text();assert.match(page,/Connect Alpha backups/);
 const csrf=/name="csrf" value="([^"]+)"/.exec(page)[1];
 async function begin(){const r=await fetch(base+'/drive-audit/setup',{method:'POST',redirect:'manual',headers:{cookie,origin:'http://localhost','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf})});assert.equal(r.status,303);const u=new URL(r.headers.get('location'));assert.equal(u.searchParams.get('scope'),SCOPE);assert.equal(u.searchParams.get('code_challenge_method'),'S256');return u.searchParams.get('state');}
 // Privacy-preserving browsers may omit Origin or send null. Session-bound CSRF remains mandatory.
 for(const origin of [undefined,'null','http://localhost','https://foreign.example']){
  for(const token of [csrf,'wrong']){
   const headers={cookie,'content-type':'application/x-www-form-urlencoded'};
   if(origin!==undefined)headers.origin=origin;
   const r=await fetch(base+'/drive-audit/setup',{method:'POST',redirect:'manual',headers,body:new URLSearchParams({csrf:token})});
   assert.equal(r.status,token===csrf && origin!=='https://foreign.example'?303:403);
  }
 }
 assert.equal((await fetch(base+'/drive-audit/setup',{method:'POST',redirect:'manual',headers:{cookie,origin:'null','sec-fetch-site':'cross-site','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf})})).status,403);
 let state=await begin();
 assert.equal((await fetch(base+'/drive-audit/callback?code=x&state=invalid',{headers:{cookie}})).status,400);
 assert.equal((await fetch(base+'/drive-audit/callback?code=x&state='+state,{headers:{cookie}})).status,403);
 assert.equal(fs.existsSync(dir+'/authorized.json'),false);
 email='owner@example.test';state=await begin();
 assert.equal((await fetch(base+'/drive-audit/callback?code=x&state='+state,{headers:{cookie}})).status,200);
 assert.match(fs.readFileSync(dir+'/rclone.conf','utf8'),/\[alpha-backup\]/);
 assert.equal(fs.statSync(dir+'/rclone.conf').mode&0o777,0o600);
 assert.equal((await fetch(base+'/drive-audit/setup/fixture')).status,410);
 }finally{await new Promise(r=>s.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
