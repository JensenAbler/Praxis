import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
export const agent = 'Patronus/0.1 (+https://github.com/JensenAbler/Praxis)';
export function fault(code, message = code) { return Object.assign(new Error(message), { code }); }
export function safeURL(raw) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || (u.port && !['80','443'].includes(u.port))) throw fault('URL_POLICY');
  return u;
}
export function displayURL(raw) {
  try { const u = new URL(raw); u.username='';u.password='';u.hash=''; for(const k of [...u.searchParams.keys()]) u.searchParams.set(k,'[redacted]'); return u.href; } catch { return '[invalid URL]'; }
}
export function isPublic(address) {
  try { let a=ipaddr.parse(address); if(a.kind()==='ipv6' && a.isIPv4MappedAddress()) a=a.toIPv4Address(); return a.range()==='unicast'; } catch { return false; }
}
export async function resolvePublic(raw, resolver=lookup) {
  const u=safeURL(raw), hostname=u.hostname.replace(/^\[|\]$/g,'');
  const rows=await resolver(hostname,{all:true});
  if (!rows.length || rows.some(r=>!isPublic(r.address))) throw fault('NETWORK_POLICY','Destination is not a public address.');
  return {u,address:rows[0].address,family:rows[0].family};
}
export async function request(raw,{signal,headers={},trace=()=>{},redirects=8}={}) {
  let current=raw;
  for(let n=0;n<=redirects;n++) {
    const {u,address,family}=await resolvePublic(current);
    const response=await new Promise((resolve,reject)=>{
      const req=(u.protocol==='https:'?https:http).request(u,{
        method:'GET',signal,headers:{'user-agent':agent,'accept-encoding':'identity',...headers},
        lookup:(_h,opts,cb)=> opts?.all ? cb(null,[{address,family}]) : cb(null,address,family)
      },resolve);
      req.once('error',reject);req.setTimeout(30000,()=>req.destroy(fault('TIMEOUT')));req.end();
    });
    trace({url:displayURL(current),status:response.statusCode,client:agent});
    if([301,302,303,307,308].includes(response.statusCode)&&response.headers.location) {
      const next=new URL(response.headers.location,u).href;
      if(new URL(next).origin!==u.origin) headers={};
      response.resume();current=next;continue;
    }
    return {response,url:current};
  }
  throw fault('REDIRECT_LIMIT');
}
// DNS is resolved and checked once, then the socket is pinned to that address.
// Both ordinary HTTP and CONNECT traffic use this same policy.
export async function startProxy({signal,maxBytes,onBytes=()=>{}}={}) {
  const sockets=new Set();let total=0;
  const count=chunk=>{total+=chunk.length;onBytes(total);if(total>maxBytes) for(const s of sockets)s.destroy();};
  const server=http.createServer(async(req,res)=>{
    try {
      if(!['GET','HEAD'].includes(req.method))throw fault('METHOD_POLICY');
      const {u,address,family}=await resolvePublic(req.url);
      const upstream=http.request(u,{method:req.method,headers:{...req.headers,host:u.host},lookup:(_h,o,cb)=>o?.all?cb(null,[{address,family}]):cb(null,address,family)},r=>{
        res.writeHead(r.statusCode,r.headers);r.on('data',count);r.pipe(res);
      });
      upstream.on('error',()=>{res.destroy();});req.pipe(upstream);
    }catch{res.writeHead(403);res.end();}
  });
  server.on('connect',async(req,client,head)=>{
    try{
      const {address,u}=await resolvePublic('https://'+req.url);
      if(u.port && u.port!=='443')throw fault('PORT_POLICY');
      const upstream=net.connect({host:address,port:443});
      sockets.add(upstream);upstream.on('close',()=>sockets.delete(upstream));
      upstream.setTimeout(30000,()=>upstream.destroy());
      upstream.on('error',()=>client.destroy());
      upstream.on('connect',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);upstream.on('data',count);upstream.pipe(client);client.pipe(upstream);});
      client.on('error',()=>upstream.destroy());client.on('close',()=>upstream.destroy());
    }catch{client.end('HTTP/1.1 403 Forbidden\r\n\r\n');}
  });
  server.on('connection',s=>{sockets.add(s);s.on('error',()=>{});s.on('close',()=>sockets.delete(s));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const close=()=>{for(const s of sockets)s.destroy();server.close();};
  signal?.addEventListener('abort',close,{once:true});
  return {url:'http://127.0.0.1:'+server.address().port,close,bytes:()=>total};
}
