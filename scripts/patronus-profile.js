// Administrative setup only. Stop Patronus before importing; never supply secrets via MCP.
import { readFileSync,mkdirSync,writeFileSync,chmodSync,chownSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const [name,file]=process.argv.slice(2);
if(!/^[a-z0-9_-]{1,40}$/.test(name||'')||!file)throw new Error('Usage: node scripts/patronus-profile.js PROFILE /secure/cookies.json');
let active=false;try{active=execFileSync('systemctl',['is-active','patronus'],{encoding:'utf8'}).trim()==='active';}catch{}if(active)throw new Error('Stop Patronus before profile import.');
const state=JSON.parse(readFileSync(file,'utf8'));
if(!Array.isArray(state.cookies))throw new Error('Expected Playwright storage-state JSON containing cookies.');
const path=join('/var/lib/patronus/profiles',name);mkdirSync(path,{recursive:true,mode:0o700});
writeFileSync(join(path,'access.json'),JSON.stringify({cookies:state.cookies}),{mode:0o600});
const uid=Number(execFileSync('id',['-u','patronus'],{encoding:'utf8'})),gid=Number(execFileSync('id',['-g','patronus'],{encoding:'utf8'}));
chownSync(path,uid,gid);chownSync(join(path,'access.json'),uid,gid);chmodSync(join(path,'access.json'),0o600);
console.log('Profile imported; cookie values omitted.');
