import http from 'node:http';
import { mkdirSync, chmodSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Patronus } from './engine.js';
import { patronusTools } from './schema.js';
export async function serve({root='/var/lib/patronus',socket='/run/patronus/api.sock'}={}) {
 const engine=new Patronus(root);
 mkdirSync(dirname(socket),{recursive:true,mode:0o700});if(existsSync(socket))unlinkSync(socket);
 const server=http.createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  try{
   if(req.method!=='POST'||req.url!=='/call')throw new Error('BAD_REQUEST');
   let body='';for await(const b of req){body+=b;if(body.length>100000)throw new Error('REQUEST_LIMIT');}
   const {action,args}=JSON.parse(body),tool=patronusTools[action];if(!tool)throw new Error('UNKNOWN_ACTION');
   const parsed=tool.schema.safeParse(args);if(!parsed.success)throw new Error('INVALID_ARGUMENT');
   const data=await engine[tool.method](parsed.data);res.end(JSON.stringify({ok:true,data}));
  }catch(e){res.statusCode=400;res.end(JSON.stringify({ok:false,error:{code:/^[A-Z_]+$/.test(e.code||e.message)?e.code||e.message:'PATRONUS_ERROR',message:'Patronus could not complete this operation.'}}));}
 });
 await new Promise(r=>server.listen(socket,r));chmodSync(socket,0o600);
 const timer=setInterval(()=>engine.tick().catch(()=>console.error('patronus_tick_failed')),500);
 return {engine,server,close:async()=>{clearInterval(timer);server.close();await engine.close();}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const svc=await serve({root:process.env.PATRONUS_DATA_DIR,socket:process.env.PATRONUS_SOCKET});let closing=false;
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{if(closing)return;closing=true;const deadline=setTimeout(()=>process.exit(1),20000);await svc.close();clearTimeout(deadline);process.exit(0);});
 console.log('Patronus listening');
}
