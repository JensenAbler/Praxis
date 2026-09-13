import http from 'node:http';
export function patronusCall(action,args) {
 return new Promise((resolve,reject)=>{
 const req=http.request({socketPath:'/run/patronus/api.sock',path:'/call',method:'POST',headers:{'content-type':'application/json'},timeout:15000},res=>{
 let body='';res.setEncoding('utf8');res.on('data',s=>{body+=s;if(body.length>2000000)req.destroy();});
 res.on('end',()=>{try{const b=JSON.parse(body);if(!b.ok)reject(Object.assign(new Error(b.error.message),{code:b.error.code}));else resolve(b.data);}catch{reject(Object.assign(new Error('Patronus returned an invalid response.'),{code:'BACKEND_UNAVAILABLE'}));}});
 });
 req.on('timeout',()=>req.destroy());req.on('error',()=>reject(Object.assign(new Error('Patronus is unavailable; recover the existing job before retrying.'),{code:'BACKEND_UNAVAILABLE'})));req.end(JSON.stringify({action,args}));
 });
}
