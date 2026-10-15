// Isolated owner-only backup OAuth helper. Reuses the registered callback URL.
// Credentials live outside Git; drive.file limits access to app-authorized files.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
export const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const BASE='/drive-audit';
export function validClient(c, redirect) {
  return c && typeof c.client_id==='string' && c.client_id.endsWith('.apps.googleusercontent.com')
    && typeof c.client_secret==='string' && c.client_secret.length>0
    && c.redirect_uris?.includes(redirect);
}
export function createHandler({dir, origin, key, expectedEmail, activityMode=false, cleanupMode=false, fetcher=fetch}) {
  activityMode=true; cleanupMode=false;
  const scope=SCOPE;
  const redirect=origin+BASE+'/callback';
  const sessions=new Map();
  let complete=fs.existsSync(dir+'/authorized.json');
  const equal=(a,b)=>typeof a==='string' && typeof b==='string' && a.length===b.length && crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
  const save=(name,value)=>{const p=dir+'/'+name;fs.writeFileSync(p+'.new',value,{mode:0o600});fs.renameSync(p+'.new',p);};
  const page=(res,status,text)=>{res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'"});res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><title>Alpha backups</title><style>body{font:18px system-ui;max-width:650px;margin:40px auto;padding:20px}input,textarea,button{font:inherit;max-width:100%;margin:12px 0}textarea{width:100%;height:160px}</style>'+text);};
  return async(req,res)=>{
    try {
      const u=new URL(req.url,origin);
      if(u.pathname===BASE+'/health' && req.method==='GET') return page(res,200,'Drive audit callback is running.');
      if(complete) return page(res,410,'Authorization has already completed. You can close this page.');
      for(const [id,s] of sessions) if(s.exp<Date.now()) sessions.delete(id);
      const sid= /(?:^|; *)drive_audit=([a-f0-9]+)/.exec(req.headers.cookie||'')?.[1];
      const s=sessions.get(sid);
      if(req.method==='GET' && u.pathname.startsWith(BASE+'/setup/')) {
        if(!equal(u.pathname.slice((BASE+'/setup/').length),key)) return page(res,404,'Not found.');
        const id=crypto.randomBytes(32).toString('hex');
        sessions.set(id,{exp:Date.now()+1800000,csrf:crypto.randomBytes(32).toString('hex')});
        res.writeHead(303,{'Location':BASE+'/setup','Set-Cookie':'drive_audit='+id+'; Secure; HttpOnly; SameSite=Lax; Path='+BASE,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});return res.end();
      }
      if(u.pathname===BASE+'/setup' && req.method==='GET') {
        if(!s) return page(res,403,'Open the private setup link again.');
        if(cleanupMode) return page(res,200,'<h1>Authorize duplicate cleanup</h1><p>Google will request full Drive access, including permanent deletion. The cleanup is limited to the verified duplicate list; the 11 retained recordings are excluded.</p><form method="post" action="'+BASE+'/setup"><input type="hidden" name="csrf" value="'+s.csrf+'"><button>Continue to Google</button></form>');
        if(activityMode) return page(res,200,'<h1>Connect Alpha backups</h1><p>Connect the requested Google account for automatic Alpha backups. Access is limited to files created or opened with this app. This step connects Drive; it does not start a backup.</p><form method="post" action="'+BASE+'/setup"><input type="hidden" name="csrf" value="'+s.csrf+'"><button>Continue to Google</button></form>');
        return page(res,200,'<h1>Connect read-only Drive metadata</h1><p>Paste the downloaded Web OAuth client JSON here. It stays on Alpha. Google will ask you to approve metadata-only access next.</p><form method="post" action="'+BASE+'/setup"><input type="hidden" name="csrf" value="'+s.csrf+'"><textarea name="client" required autocomplete="off" placeholder="OAuth client JSON"></textarea><br><button>Continue to Google</button></form>');
      }
      if(u.pathname===BASE+'/setup' && req.method==='POST') {
        if(!s) return page(res,403,'Setup session expired or cookies are unavailable. Reopen the private setup link in Safari and try again.');
        if(req.headers.origin!==origin) return page(res,403,'Browser origin was missing or incorrect. Reopen the private setup link, reload the form, and try again.');
        if(!(req.headers['content-type']||'').startsWith('application/x-www-form-urlencoded')) return page(res,415,'Unsupported form format. Reload the setup form.');
        let body=''; for await(const chunk of req){body+=chunk;if(body.length>20000)return page(res,413,'Upload too large.');}
        const form=new URLSearchParams(body);
        if(!equal(form.get('csrf'),s.csrf)) return page(res,403,'Invalid setup session.');
        let c;
        if(activityMode) {
          const ini=fs.readFileSync(dir+'/rclone.conf','utf8');
          const field=n=>new RegExp('^'+n+' = (.+)$','m').exec(ini)?.[1];
          c={client_id:field('client_id'),client_secret:field('client_secret'),redirect_uris:[redirect]};
        } else c=JSON.parse(form.get('client')||'{}').web;
        if(!validClient(c,redirect))return page(res,400,'Use a Web client JSON whose authorized redirect URI includes '+redirect);
        s.client={client_id:c.client_id,client_secret:c.client_secret};
        s.state=crypto.randomBytes(32).toString('hex');
        s.verifier=crypto.randomBytes(48).toString('base64url');
        const auth=new URL('https://accounts.google.com/o/oauth2/v2/auth');
        auth.search=new URLSearchParams({client_id:c.client_id,redirect_uri:redirect,response_type:'code',scope,access_type:'offline',prompt:'consent',login_hint:expectedEmail,state:s.state,code_challenge:crypto.createHash('sha256').update(s.verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
        res.writeHead(303,{'Location':auth.href,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});return res.end();
      }
      if(u.pathname===BASE+'/callback' && req.method==='GET') {
        if(!s || !s.state || !equal(u.searchParams.get('state'),s.state)) return page(res,400,'No matching authorization session. Open the private setup link to begin.');
        s.state=null; // Single-use, including provider error responses.
        if(u.searchParams.has('error') || !u.searchParams.get('code')) return page(res,400,'Google authorization was not completed. Open the private setup link to retry.');
        const response=await fetcher('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...s.client,code:u.searchParams.get('code'),redirect_uri:redirect,grant_type:'authorization_code',code_verifier:s.verifier}),signal:AbortSignal.timeout(20000)});
        if(!response.ok) return page(res,502,'Google could not exchange the authorization code. No credentials were saved.');
        const t=await response.json();
        if(!t.access_token || !t.refresh_token || [...new Set((t.scope||'').trim().split(/\s+/))].sort().join(' ')!==scope.split(' ').sort().join(' ')) return page(res,403,'Google did not return the expected backup authorization. No credentials were saved.');
        const profile=await fetcher('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress),storageQuota',{headers:{Authorization:'Bearer '+t.access_token},signal:AbortSignal.timeout(20000)});
        if(!profile.ok) return page(res,502,'Could not verify the Drive account. No credentials were saved.');
        const p=await profile.json();
        if(p.user?.emailAddress?.toLowerCase()!==expectedEmail.toLowerCase())return page(res,403,'Please authorize the requested Google account. No credentials were saved.');
        const token={access_token:t.access_token,token_type:t.token_type||'Bearer',refresh_token:t.refresh_token,expiry:new Date(Date.now()+t.expires_in*1000).toISOString()};
        // Reject newlines before constructing the isolated rclone INI.
        if(Object.values(s.client).some(v=>/[\r\n]/.test(v))) return page(res,400,'Invalid client metadata.');
        save('rclone.conf','[alpha-backup]\ntype = drive\nscope = drive.file\nclient_id = '+s.client.client_id+'\nclient_secret = '+s.client.client_secret+'\ntoken = '+JSON.stringify(token)+'\n');
        save('authorized.json',JSON.stringify({email:p.user.emailAddress,scope,at:new Date().toISOString(),storageQuota:p.storageQuota}));
        complete=true;sessions.clear();
        return page(res,200,'<h1>Connected</h1><p>Drive authorization is ready. Return to ChatGPT to finish backup verification and scheduling.</p>');
      }
      return page(res,404,'Not found.');
    } catch { if(!res.headersSent)page(res,500,'Setup could not complete. No details or credentials have been logged.');else res.end(); }
  };
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
 const dir=process.env.DRIVE_AUDIT_DIR||'/var/lib/alpha-backup';
 const key=fs.readFileSync(dir+'/setup-key','utf8').trim();
 const handler=createHandler({dir,key,origin:process.env.DRIVE_AUDIT_ORIGIN,expectedEmail:process.env.DRIVE_AUDIT_EMAIL,activityMode:process.env.DRIVE_AUDIT_ACTIVITY==='1',cleanupMode:process.env.DRIVE_AUDIT_CLEANUP==='1'});
 http.createServer(handler).listen(Number(process.env.PORT||8796),'127.0.0.1');
}
