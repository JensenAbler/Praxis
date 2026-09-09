// Isolated Linux executor qualification. Run as praxis-code with a private,
// operator-prepared fixture config; never point workspace at a registered job.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PodmanRunner } from '../src/code/runner.js';
import { dependencyPackCommand, sealDependencies } from '../src/code/dependencies.js';

assert.notEqual(process.getuid(), 0, 'The executor fixture must be rootless');
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.match(config.workspacePath, /registry-qualification-[a-f0-9]{16}$/);
const runner = new PodmanRunner(config.runner);
const evidence = { kind: 'real-linux-rootless-executor-fixture', authenticatedMcp: false, image: runner.image, cases: [] };
mkdirSync(config.workspacePath, { recursive: true });
writeFileSync(join(config.workspacePath, 'package.json'), JSON.stringify({ name: 'praxis-registry-qualification', version: '1.0.0', private: true }));

async function run(label, argv, network = 'none', timeoutSeconds = 90) {
  const job = { id: randomUUID(), label, argv, cwd: '.', env: {}, network, timeoutSeconds };
  const created = await runner.create({ job, workspacePath: config.workspacePath });
  let output = '', state;
  const deadline = Date.now() + (timeoutSeconds + 30) * 1000;
  try {
    await runner.start({ name: created.name });
    while (Date.now() < deadline) {
      state = await runner.inspect({ name: created.name });
      if (!state.running) break;
      await delay(200);
    }
    assert.equal(state?.running, false, `${label} did not stop`);
    let cursor = created.logCursor, fingerprint = created.logFingerprint, continuation = null;
    for (let count = 0; count < 8; count++) {
      const page = await runner.logs({ name: created.name, cursor, fingerprint, continuation, final: true });
      output += page.records.map(row => row.text).join('');
      cursor = page.cursor; fingerprint = page.fingerprint; continuation = page.continuation;
      assert.equal(Boolean(page.truncated), false, `${label} output was truncated`);
      if (!page.hasMore) break;
    }
    evidence.cases.push({ label, jobId: job.id, network, exitCode: state.exitCode, output: output.slice(-8000) });
    assert.equal(state.exitCode, 0, `${label}: ${output}`);
    console.log(JSON.stringify({ completed: label, jobId: job.id, exitCode: state.exitCode }));
    return job;
  } finally {
    const observed = await runner.inspect({ name: created.name });
    if (observed.running) await runner.stop({ name: created.name });
    await runner.remove({ name: created.name });
  }
}

try {
  await run('npm-public-registry-install', ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0', '--fetch-timeout=20000', 'is-number@7.0.0'], 'registries');
  await run('npm-persistence-offline', ['node', '-e', "const assert=require('node:assert/strict'); assert.equal(require('is-number')(42),true); console.log('OFFLINE_NPM_OK')"]);
  await run('pypi-venv-install', ['bash', '-c', 'python3 -m venv .venv && .venv/bin/python -m pip install --no-input --disable-pip-version-check --no-cache-dir --retries 0 --timeout 20 idna==3.10'], 'registries');
  await run('python-persistence-offline', ['.venv/bin/python', '-c', 'import idna; assert idna.__version__ == "3.10"; print("OFFLINE_PYTHON_OK")']);
  const denial = `
const net=require('node:net'), assert=require('node:assert/strict'), fs=require('node:fs');
async function deniedAuthority(authority) {
 const proxy=new URL(process.env.HTTPS_PROXY);
 const response=await new Promise((resolve,reject)=>{
  const socket=net.connect(Number(proxy.port),proxy.hostname,()=>socket.write('CONNECT '+authority+' HTTP/1.1\\r\\nHost: '+authority+'\\r\\n\\r\\n'));
  let text=''; socket.setTimeout(4000,()=>socket.destroy(new Error('proxy timeout')));
  socket.on('data',data=>{ text+=data; if(text.includes('\\r\\n\\r\\n')){socket.destroy();resolve(text);} });
  socket.on('error',reject);
 });
 assert.match(response,/^HTTP\\/1\\.1 403 /); console.log('DENIED_CONNECT '+authority);
}
async function deniedDirect(host,port) {
 await new Promise((resolve,reject)=>{
  const socket=net.connect({host,port}); socket.setTimeout(2000,()=>{socket.destroy();resolve();});
  socket.on('connect',()=>{socket.destroy();reject(new Error('unexpected direct access '+host));});
  socket.on('error',()=>resolve());
 }); console.log('DENIED_DIRECT '+host+':'+port);
}
(async()=>{
 for(const authority of ['127.0.0.1:443','169.254.169.254:443','github.com:443','registry.npmjs.org.evil.example:443']) await deniedAuthority(authority);
 for(const [host,port] of [['1.1.1.1',443],['169.254.169.254',80],['127.0.0.1',8793]]) await deniedDirect(host,port);
 assert.notEqual(process.getuid(),0);
 for(const path of ['/etc/praxis-git/config.json','/etc/praxis-probe/config.json','/opt/podcast-discord/.env']) assert.equal(fs.existsSync(path),false);
 console.log('ISOLATION_OK uid='+process.getuid());
})().catch(error=>{console.error(error.message);process.exitCode=1;});`;
  await run('registry-authority-and-direct-network-denial', ['node', '-e', denial], 'registries');
  const script = `const fs=require('node:fs'),assert=require('node:assert/strict'); assert.notEqual(process.getuid(),0); for(const path of ['/etc/praxis-git/config.json','/opt/podcast-discord/.env']) assert.equal(fs.existsSync(path),false); fs.writeFileSync('script-proof.json',JSON.stringify({uid:process.getuid(),productionFilesVisible:false})); console.log('PACKAGE_SCRIPT_UNPRIVILEGED')`;
  const pack = JSON.parse(readFileSync(join(config.workspacePath, 'package.json'), 'utf8'));
  pack.scripts = { postinstall: `node -e ${JSON.stringify(script)}` };
  writeFileSync(join(config.workspacePath, 'package.json'), JSON.stringify(pack));
  await run('package-script-remains-unprivileged', ['npm', 'install', '--ignore-scripts=false', '--no-audit', '--no-fund', '--fetch-retries=0', '--fetch-timeout=20000'], 'registries');
  evidence.scriptProof = JSON.parse(readFileSync(join(config.workspacePath, 'script-proof.json'), 'utf8'));
  const prepared = await run('offline-dependency-preparation', dependencyPackCommand(runner.image));
  evidence.bundle = sealDependencies({ workspacePath: config.workspacePath, directory: config.dependencyDirectory,
    workspaceId: 'isolated-registry-qualification', revision: 'fixture-only', jobId: prepared.id, image: runner.image });
  evidence.ok = true;
} catch (error) {
  evidence.ok = false; evidence.error = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  writeFileSync(config.evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence));
}
