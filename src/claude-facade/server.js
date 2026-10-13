// Claude compatibility facade for Praxis.
//
// Serves the MCP SDK's OAuth endpoints and a stateless streamable-HTTP /mcp
// endpoint on praxis-apps.jensenabler.com, then hands each authorized request
// to the same createProbeServer used by the canonical Praxis endpoint. Runs
// from the active control release (see deploy/praxis-claude-facade.service),
// so its Praxis modules always match the deployed commit.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { PraxisSdkOAuthProvider, OAUTH_SCOPES, createApprovalRouter } from './oauth-provider.js';
import { JobStore } from '../jobs.js';
import { AuditStore } from '../audit.js';
import { diagnosticRecord, requestContext } from '../diagnostics.js';
import { createProbeServer, observeMcpHttp } from '../mcp.js';
import { createGatewayClient, createReleaseClient } from '../gateway-client.js';
import { loadToolManifest, watchToolManifest } from '../tool-manifest.js';

export function createFacadeApp({ env = process.env, provider: suppliedProvider, jobs: suppliedJobs,
  audit: suppliedAudit, coding: suppliedCoding, git: suppliedGit, releaseClient: suppliedRelease,
  applicationTools: suppliedTools } = {}) {
const host = env.FACADE_HOST ?? '127.0.0.1';
const publicHostname = env.FACADE_PUBLIC_HOSTNAME ?? 'praxis-apps.jensenabler.com';
const dataDirectory = env.FACADE_DATA_DIRECTORY ?? '/var/lib/praxis-claude-facade';
const codingUrl = env.FACADE_CODING_URL ?? 'http://127.0.0.1:8792';
const releaseUrl = env.FACADE_RELEASE_URL ?? 'http://127.0.0.1:8793/call';
const toolManifestPath = env.FACADE_TOOL_MANIFEST ?? '/srv/praxis-app/current/coding-tools.json';

const origin=new URL(`https://${publicHostname}`);
const resourceUrl=new URL('/mcp',origin);
const credentials=env.CREDENTIALS_DIRECTORY;
if(!credentials && !suppliedProvider) throw new Error('CREDENTIALS_DIRECTORY is required (systemd LoadCredential).');
const read=name=>readFileSync(join(credentials,name),'utf8').trim();
const provider=suppliedProvider || new PraxisSdkOAuthProvider({directory:dataDirectory,passwordHash:read('password-hash'),jwks:JSON.parse(read('jwks.json')),resourceUrl});
const app=createMcpExpressApp({host,allowedHosts:['127.0.0.1','localhost',publicHostname]});
const metadataUrl=getOAuthProtectedResourceMetadataUrl(resourceUrl);
const jobs=suppliedJobs || new JobStore(dataDirectory), audit=suppliedAudit || new AuditStore(dataDirectory);
const coding=suppliedCoding || createGatewayClient({url:codingUrl});
const git=suppliedGit || createGatewayClient({url:releaseUrl});
const releaseClient=suppliedRelease || createReleaseClient({url:releaseUrl});
if (!suppliedTools) loadToolManifest(toolManifestPath); // fail fast at startup, as before
// Releases swap the manifest under a running facade; re-read it when it changes.
const applicationTools=suppliedTools || watchToolManifest(toolManifestPath,{onError:e=>console.error(JSON.stringify({event:'facade_manifest_unavailable',type:e?.name,code:e?.code}))});

app.get('/healthz',(_req,res)=>res.json({ok:true,name:'Praxis SDK OAuth facade'}));
app.use(createApprovalRouter(provider));
app.use(mcpAuthRouter({
  provider,
  issuerUrl:origin,
  resourceServerUrl:resourceUrl,
  scopesSupported:OAUTH_SCOPES,
  resourceName:'Praxis',
  clientRegistrationOptions:{clientSecretExpirySeconds:0},
}));

async function requireBearer(req,res,next){
  const m=/^Bearer +(.+)$/i.exec(req.get('authorization')||'');
  if(m){try{req.auth=await provider.verifyAccessToken(m[1]);return next()}catch{}}
  res.set('WWW-Authenticate',`Bearer resource_metadata="${metadataUrl}", scope="praxis praxis:code"`).status(401).json({error:'Unauthorized'});
}
app.use('/mcp',(_req,res,next)=>{
  const requestId=randomUUID();
  res.set('X-Praxis-Request-Id',requestId);
  requestContext.run({requestId,httpRequestId:requestId},next);
});
app.use('/mcp',requireBearer);
app.use('/mcp',(req,res,next)=>{observeMcpHttp(req,res,audit,'jensen');next()});
app.post('/mcp',async(req,res)=>{
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  // Claude sees the compatibility token. Praxis backends receive a short-lived
  // owner JWT minted from the same successful owner authorization.
  const authInfo={token:req.auth.backendToken,clientId:req.auth.clientId,scopes:['praxis:probe','praxis:code'],expiresAt:req.auth.expiresAt,resource:req.auth.resource,extra:{subject:'jensen'}};
  const server=createProbeServer({endpoint:'claude_facade',jobs,audit,resourceUrl:resourceUrl.href,bootId:randomUUID(),release:'claude-sdk-oauth-facade',authInfo,coding,applicationTools:applicationTools(),releaseClient,git});
  let closed=false;const close=()=>{if(closed)return;closed=true;Promise.allSettled([transport.close(),server.close()]).catch(()=>{})};res.once('close',close);
  try{await server.connect(transport);await transport.handleRequest(req,res,req.body)}catch(e){console.error(JSON.stringify(diagnosticRecord('facade_mcp_error',e)));if(!res.headersSent)res.status(500).json({jsonrpc:'2.0',error:{code:-32603,message:'Internal server error'},id:null})}
});
app.get('/mcp',(_req,res)=>res.status(405).set('Allow','POST').send('Method Not Allowed'));
app.delete('/mcp',(_req,res)=>res.status(405).set('Allow','POST').send('Method Not Allowed'));

return { app, jobs, audit, provider, close: () => { jobs.close(); audit.close(); } };
}

let entry=false;
try { entry=process.argv[1] && realpathSync(process.argv[1])===realpathSync(fileURLToPath(import.meta.url)); } catch {}
if(entry){
  const service=createFacadeApp();
  const listener=service.app.listen(Number(process.env.FACADE_PORT ?? 8791),process.env.FACADE_HOST ?? '127.0.0.1',
    ()=>console.log(JSON.stringify({event:'sdk_facade_listening',issuer:`https://${process.env.FACADE_PUBLIC_HOSTNAME ?? 'praxis-apps.jensenabler.com'}/`,
      resource:`https://${process.env.FACADE_PUBLIC_HOSTNAME ?? 'praxis-apps.jensenabler.com'}/mcp`})));
  const stop=()=>listener.close(()=>{service.close();process.exit(0)});
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
