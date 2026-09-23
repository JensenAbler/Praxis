// OAuth authorization server used by the Claude compatibility facade.
//
// Claude's connector speaks the MCP SDK's OAuth flavour (dynamic client
// registration, opaque bearer tokens, a password approval page). Praxis
// backends only accept short-lived owner JWTs from the canonical issuer, so
// each facade access token carries a backend JWT minted with the same signing
// key after a successful owner authorization. Moved from an out-of-tree
// install at /opt/praxis-claude-facade/oauth-sdk.mjs without behavior changes.
import { randomBytes, randomUUID, timingSafeEqual, scrypt as scryptCallback } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import express from 'express';
import { SignJWT, importJWK } from 'jose';
import { clientHostFromRedirects } from '../client-host.js';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';

const scrypt = promisify(scryptCallback);
const ACCESS_TOKEN_SECONDS = 3600;
const PENDING_SECONDS = 600;
export const OAUTH_SCOPES = ['praxis','praxis:code','offline_access'];

const opaque = () => randomBytes(32).toString('base64url');
const esc = v => String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function parsePasswordHash(encoded) {
  const parts=String(encoded).split('$');
  if(parts.length!==3 || parts[0]!=='scrypt') throw new Error('Invalid Praxis password credential');
  return {salt:Buffer.from(parts[1],'base64url'), expected:Buffer.from(parts[2],'base64url')};
}
function headers(redirectUri) {
  const origin=new URL(redirectUri).origin;
  return {
    'content-type':'text/html; charset=utf-8',
    'content-security-policy':`default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${origin}; base-uri 'none'; frame-ancestors 'none'`,
    'referrer-policy':'no-referrer',
    'x-frame-options':'DENY',
  };
}
function html({pendingId,clientName,redirectHost,error=''}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Praxis</title>
<style>body{font:16px system-ui;background:#151515;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}.card{max-width:34rem;padding:2rem;border:1px solid #555;border-radius:16px;background:#202020}h1{margin-top:0}label{display:block;margin:1.25rem 0 .4rem}input{box-sizing:border-box;width:100%;padding:.8rem;border:1px solid #777;border-radius:8px;background:#111;color:#fff}button{margin-top:1.25rem;padding:.8rem 1rem;border:0;border-radius:8px;font-weight:700}.approve{background:#fff;color:#111}.deny{background:#555;color:#fff;margin-left:.5rem}.error{color:#ff9b9b}</style>
</head><body><main class="card"><h1>Authorize Praxis</h1><p><strong>${esc(clientName)}</strong> is requesting access to Praxis through <code>${esc(redirectHost)}</code>.</p>
<p>This grants access to Praxis, including code tools.</p>${error?`<p class="error">${esc(error)}</p>`:''}
<form method="post" action="/oauth/approve"><input type="hidden" name="pending" value="${esc(pendingId)}">
<label for="key">Praxis password</label><input id="key" name="access_key" type="password" required autocomplete="current-password">
<button class="approve" name="decision" value="approve" type="submit">Authorize Praxis</button><button class="deny" name="decision" value="deny" type="submit">Deny</button></form></main></body></html>`;
}
class State {
  constructor(dir){ this.file=path.join(dir,'OAUTH.json'); this.data={clients:{},accessTokens:{},refreshTokens:{}}; try{const p=JSON.parse(fs.readFileSync(this.file,'utf8'));this.data={clients:p.clients??{},accessTokens:p.accessTokens??{},refreshTokens:p.refreshTokens??{}}}catch(e){if(e.code!=='ENOENT')throw e;} }
  save(){ const t=`${this.file}.${process.pid}.${randomUUID()}.tmp`; const fd=fs.openSync(t,'wx',0o600); try{fs.writeFileSync(fd,JSON.stringify(this.data,null,2)+'\n');fs.fsyncSync(fd)}finally{fs.closeSync(fd)} fs.renameSync(t,this.file);fs.chmodSync(this.file,0o600);}
  prune(){const n=Math.floor(Date.now()/1000);for(const [k,v] of Object.entries(this.data.accessTokens))if(v.expiresAt<=n)delete this.data.accessTokens[k];}
}
export class PraxisSdkOAuthProvider {
  constructor({directory,passwordHash,resourceUrl,jwks}) {
    this.resourceUrl=new URL(resourceUrl); this.state=new State(directory); this.pending=new Map(); this.codes=new Map();
    this.password=parsePasswordHash(passwordHash);
    this.signingJwk=jwks?.keys?.find(k=>k.kty==='RSA'&&k.d&&k.kid);
    if(!this.signingJwk) throw new Error('Praxis signing key unavailable');
    this.clientsStore={
      getClient:async id=>this.state.data.clients[id],
      registerClient:async client=>{
        for(const redirect of client.redirect_uris){const u=new URL(redirect);const loop=u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname);if(u.protocol!=='https:'&&!loop)throw new InvalidClientMetadataError('Redirect URIs must use HTTPS or loopback HTTP.');}
        this.state.data.clients[client.client_id]=client;this.state.save();return client;
      }
    };
  }
  validResource(r){return r===undefined||r.href===this.resourceUrl.href;}
  async authorize(client,params,res){
    if(!this.validResource(params.resource))throw new InvalidRequestError('Invalid resource audience.');
    if(params.scopes.some(s=>!OAUTH_SCOPES.includes(s)))throw new InvalidScopeError('Requested scope is not supported.');
    const id=opaque(); this.pending.set(id,{clientId:client.client_id,params,expiresAt:Date.now()+PENDING_SECONDS*1000});
    res.status(200).set(headers(params.redirectUri)).send(html({pendingId:id,clientName:client.client_name||'An MCP client',redirectHost:new URL(params.redirectUri).host}));
  }
  async passwordOk(value){const actual=await scrypt(value,this.password.salt,64,{N:16384,r:8,p:1});return actual.length===this.password.expected.length&&timingSafeEqual(actual,this.password.expected);}
  async completeAuthorization(id,key,decision,res){
    const req=this.pending.get(id); if(!req||req.expiresAt<Date.now()){this.pending.delete(id);return res.status(400).send('Authorization request expired.');}
    const client=this.state.data.clients[req.clientId]; if(!client){this.pending.delete(id);return res.status(400).send('OAuth client no longer registered.');}
    if(decision==='deny'){this.pending.delete(id);const t=new URL(req.params.redirectUri);t.searchParams.set('error','access_denied');if(req.params.state)t.searchParams.set('state',req.params.state);return res.redirect(302,t.href);}
    if(!(await this.passwordOk(key))){return res.status(401).set(headers(req.params.redirectUri)).send(html({pendingId:id,clientName:client.client_name||'An MCP client',redirectHost:new URL(req.params.redirectUri).host,error:'Incorrect Praxis password.'}));}
    this.pending.delete(id); const code=opaque(); this.codes.set(code,{...req,expiresAt:Date.now()+PENDING_SECONDS*1000}); const t=new URL(req.params.redirectUri);t.searchParams.set('code',code);if(req.params.state)t.searchParams.set('state',req.params.state);return res.redirect(302,t.href);
  }
  async challengeForAuthorizationCode(client,code){const r=this.codes.get(code);if(!r||r.clientId!==client.client_id||r.expiresAt<Date.now())throw new InvalidGrantError('Invalid or expired authorization code.');return r.params.codeChallenge;}
  async makeBackendToken(clientId){
    const now=Math.floor(Date.now()/1000), key=await importJWK(this.signingJwk,'RS256');
    const host=clientHostFromRedirects(this.state.data.clients[clientId]?.redirect_uris);
    return new SignJWT({client_id:clientId,scope:'praxis:probe praxis:code',...(host?{praxis_client_host:host}:{})})
      .setProtectedHeader({alg:'RS256',kid:this.signingJwk.kid,typ:'at+jwt'})
      .setIssuer('https://mcp.jensenabler.com/praxis/oauth').setSubject('jensen')
      .setAudience('https://mcp.jensenabler.com/praxis/mcp').setIssuedAt(now)
      .setExpirationTime(now+ACCESS_TOKEN_SECONDS).sign(key);
  }
  async issueTokens(clientId,scopes,resource){
    const now=Math.floor(Date.now()/1000),access=opaque(),refresh=opaque(),normalized=scopes?.length?scopes:['praxis'],aud=resource?.href??this.resourceUrl.href;
    const backendToken=await this.makeBackendToken(clientId);
    this.state.prune();this.state.data.accessTokens[access]={clientId,scopes:normalized,resource:aud,expiresAt:now+ACCESS_TOKEN_SECONDS,backendToken};this.state.data.refreshTokens[refresh]={clientId,scopes:normalized,resource:aud};this.state.save();
    return {access_token:access,token_type:'bearer',expires_in:ACCESS_TOKEN_SECONDS,scope:normalized.join(' '),refresh_token:refresh};
  }
  async exchangeAuthorizationCode(client,code,_verifier,redirectUri,resource){const r=this.codes.get(code);if(!r||r.clientId!==client.client_id||r.expiresAt<Date.now())throw new InvalidGrantError('Invalid or expired authorization code.');if(redirectUri&&redirectUri!==r.params.redirectUri)throw new InvalidGrantError('redirect_uri mismatch.');if(!this.validResource(resource)||!this.validResource(r.params.resource))throw new InvalidGrantError('Invalid resource audience.');this.codes.delete(code);return await this.issueTokens(client.client_id,r.params.scopes,r.params.resource??resource);}
  async exchangeRefreshToken(client,token,scopes,resource){const r=this.state.data.refreshTokens[token];if(!r||r.clientId!==client.client_id)throw new InvalidGrantError('Invalid refresh token.');if(resource&&resource.href!==r.resource)throw new InvalidGrantError('Invalid resource audience.');const requested=scopes?.length?scopes:r.scopes;if(requested.some(s=>!r.scopes.includes(s)))throw new InvalidGrantError('Cannot expand scopes.');delete this.state.data.refreshTokens[token];return await this.issueTokens(client.client_id,requested,new URL(r.resource));}
  async verifyAccessToken(token){const r=this.state.data.accessTokens[token],now=Math.floor(Date.now()/1000);if(!r||r.expiresAt<=now||r.resource!==this.resourceUrl.href)throw new Error('Invalid or expired access token.');if(!r.backendToken){r.backendToken=await this.makeBackendToken(r.clientId);this.state.save();}return {token,backendToken:r.backendToken,clientId:r.clientId,scopes:r.scopes,expiresAt:r.expiresAt,resource:new URL(r.resource)};}
  async revokeToken(client,request){const a=this.state.data.accessTokens[request.token],r=this.state.data.refreshTokens[request.token];if(a?.clientId===client.client_id)delete this.state.data.accessTokens[request.token];if(r?.clientId===client.client_id)delete this.state.data.refreshTokens[request.token];this.state.save();}
}
export function createApprovalRouter(provider){const router=express.Router();router.post('/oauth/approve',express.urlencoded({extended:false}),async(req,res,next)=>{try{await provider.completeAuthorization(req.body.pending,req.body.access_key,req.body.decision,res)}catch(e){next(e)}});return router;}
