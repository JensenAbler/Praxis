import { chromium } from 'playwright';
import { startProxy } from '../src/patronus/network.js';
const proxy=await startProxy({maxBytes:5242880});let browser;
try{browser=await chromium.launch({channel:'chromium',chromiumSandbox:true,headless:true,proxy:{server:proxy.url,bypass:'<-loopback>'}});const p=await browser.newPage();const r=await p.goto('https://clawcast.jensenabler.com/robots.txt',{timeout:30000});console.log(JSON.stringify({status:r.status(),text:await p.innerText('body'),sandbox:true,uid:process.getuid()}));}finally{await browser?.close();proxy.close();}
