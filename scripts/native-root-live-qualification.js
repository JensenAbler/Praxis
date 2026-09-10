/** Explicit owner API acceptance. Never invoked by tests/bootstrap automatically.
 * node scripts/native-root-live-qualification.js prepare|restart|controls|recover|all PRIVATE_STATE.json
 * Each invocation uses a 45-second polling budget. Pending means resume the SAME
 * phase and state file; saved job IDs and idempotency keys are never replaced.
 * Remote effects: one unique fixture directory, ordinary npm cache use, and one
 * restart of praxis-code.service. No actual project source or transcripts read.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { authorize } from './oauth-client.js';

const ACTIVE = new Set(['queued', 'starting', 'running', 'canceling']);
const TRANSIENT = new Set(['BACKEND_UNAVAILABLE', 'INTERNAL_ERROR', 'SERVICE_UNAVAILABLE', 'TRANSPORT_ERROR', 'MCP_ERROR', 'REQUEST_TIMEOUT']);
const PHASES = ['prepare', 'restart', 'controls', 'recover', 'all'];
const SIZE = 2 * 1024 * 1024 + 37;
const now = () => new Date().toISOString();
const sha256 = value => createHash('sha256').update(value).digest('hex');
export class QualificationPending extends Error { constructor() { super('Resume the same phase and private state file.'); this.code = 'PENDING'; } }
function artifactBytes() { return Buffer.from(Array.from({ length: SIZE }, (_, index) => index % 251)); }
function stdoutBytes(runId) { return Buffer.concat([Buffer.alloc(SIZE, 88), Buffer.from(`\nRAW_END_${runId}\n`)]); }
function compact(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(compact);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if ((key === 'content' || key === 'text') && typeof item === 'string') return [key, { omitted: true, stringBytes: Buffer.byteLength(item), sha256: sha256(item) }];
    return [key, compact(item)];
  }));
}

export class NativeRootQualification {
  constructor({ state, save, rpc, reconnect = async () => false, captureDirectory, budgetMs = 45000, log = value => console.log(JSON.stringify(value)) }) {
    this.state = state; this.save = save; this.rpc = rpc; this.log = log;
    this.captureDirectory = captureDirectory; this.reconnect = reconnect; this.deadline = Date.now() + budgetMs;
    assert.match(state.runId, /^[a-f0-9-]{36}$/);
    assert.equal(state.fixtureRoot, `/var/lib/praxis-root/acceptance/${state.runId}`);
  }
  time() { if (Date.now() >= this.deadline) throw new QualificationPending(); }
  key(label) { return `native-v06:${this.state.runId}:${label}`; }
  async pause() { this.time(); await delay(Math.min(1500, Math.max(1, this.deadline - Date.now()))); }
  async call(name, args = {}) {
    let attempt = 0;
    for (;;) {
      this.time();
      const record = { name, args, intendedAt: now() }; this.state.calls.push(record); this.save();
      try {
        const response = await this.rpc(name, args);
        record.response = compact(response); record.returnedAt = now(); this.save();
        if (response?.ok !== true) throw Object.assign(new Error('Tool returned an unsuccessful response; metadata saved privately.'), { code: response?.error?.code || 'INVALID_RESPONSE' });
        return response;
      } catch (error) {
        const code = typeof error.code === 'string' ? error.code : 'TRANSPORT_ERROR';
        record.error = { code }; record.returnedAt = now(); this.save();
        if (TRANSIENT.has(code) && ['host_file_write', 'host_file_patch'].includes(name)) throw new QualificationPending();
        if (!TRANSIENT.has(code) || ++attempt >= 8) throw Object.assign(new Error(`Tool ${name} failed (${code}); recover existing saved work.`), { code });
        await delay(Math.min(1000 * attempt, 4000, Math.max(1, this.deadline - Date.now())));
      }
    }
  }
  async step(label, name, args) {
    let saved = this.state.steps[label];
    if (!saved) { saved = this.state.steps[label] = { name, args, intendedAt: now() }; this.save(); }
    assert.equal(saved.name, name);
    if (!saved.result) {
      // Every retried mutation here is job_start with the SAME key, the same
      // project attachment, or job_cancel for an already-known job ID.
      saved.result = await this.call(name, saved.args); this.save();
    }
    return saved.result;
  }
  async observe(label, expected = 'completed') {
    const id = this.state.steps[label]?.result?.id; assert.ok(id, 'The original job ID must be saved before observation.');
    for (;;) {
      const result = await this.call('job_status', { jobId: id });
      this.state.steps[label].observed = compact(result); this.save();
      if (!ACTIVE.has(result.status)) {
        assert.equal(result.status, expected, `Existing ${label} job is ${result.status}; it will not be recreated.`);
        if (expected === 'completed') assert.equal(result.exitCode, 0);
        this.log({ job: label, id, status: result.status, exitCode: result.exitCode });
        return result;
      }
      await this.pause();
    }
  }
  async startJob(label, argv, extra = {}) {
    return this.step(label, 'job_start', { idempotencyKey: this.key(label), label: `Native acceptance ${label} ${this.state.runId}`,
      ...(this.state.hostProjectId ? { hostProjectId: this.state.hostProjectId } : {}), cwd: this.state.fixtureRoot, argv, ...extra });
  }
  async job(label, argv, extra = {}) { await this.startJob(label, argv, extra); return this.observe(label); }
  async capabilities() {
    const value = await this.call('capabilities');
    assert.equal(value.apiVersion, '0.6.0'); assert.equal(value.execution.user, 'root');
    assert.equal(value.execution.containers, false); assert.equal(value.execution.maxActiveJobs, null);
    assert.equal(value.execution.maxTimeoutSeconds, null); assert.equal(value.execution.defaultTimeoutSeconds, 0);
    assert.deepEqual(value.disabled, []);
    this.state.observations.capabilities = value; this.save();
    return value;
  }
  async smallFile(path) {
    assert.ok(path.startsWith(this.state.fixtureRoot + '/'), 'Only fixture content may be read through this helper.');
    const result = await this.call('host_file_read', { path, maxBytes: 262144, includeSha256: true });
    assert.equal(result.hasMore, false, 'Expected a bounded fixture report.');
    assert.equal(result.sha256, sha256(Buffer.from(result.content)));
    return result;
  }
  async writeFixture(label, path, before, content, patch = false) {
    assert.ok(path.startsWith(this.state.fixtureRoot + '/'));
    const expected = sha256(content);
    const existing = await this.call('host_path_info', { path, includeSha256: true });
    if (existing.sha256 === expected) {
      this.state.steps[label] ??= { name: patch ? 'host_file_patch' : 'host_file_write', recoveredByHash: true };
      this.state.steps[label].result = { path, sha256: expected, recoveredByHash: true }; this.save(); return;
    }
    const name = patch ? 'host_file_patch' : 'host_file_write';
    const args = patch ? { path, oldText: before, newText: content, expectedSha256: sha256(before) }
      : { path, content, expectedSha256: null };
    const saved = this.state.steps[label] ??= { name, args, intendedAt: now() }; this.save();
    assert.equal(existing.exists, patch, 'Unexpected fixture file state; do not overwrite it.');
    // Hash recovery above handles an earlier successful write whose reply was lost.
    const result = await this.call(name, saved.args); assert.equal(result.sha256, expected);
    saved.result = result; this.save();
  }
  async capture(label, expected, makeCall) {
    mkdirSync(this.captureDirectory, { recursive: true, mode: 0o700 });
    const path = join(this.captureDirectory, `${label}.bin`);
    const capture = this.state.captures[label] ??= { cursor: 0, pages: 0, expectedBytes: expected.length, expectedSha256: sha256(expected) };
    this.save();
    assert.equal(capture.expectedSha256, sha256(expected));
    if (capture.complete) {
      assert.equal(sha256(readFileSync(path)), capture.expectedSha256); return capture;
    }
    if (capture.cursor > 0) assert.ok(existsSync(path) && statSync(path).size >= capture.cursor, 'Saved local capture is missing; inspect before recovery.');
    const fd = openSync(path, existsSync(path) ? 'r+' : 'w+', 0o600);
    try {
      for (;;) {
        this.time();
        const result = await makeCall(capture.cursor), bytes = Buffer.from(result.content, 'base64');
        assert.equal(result.encoding, 'base64');
        assert.equal(result.cursor, capture.cursor);
        assert.deepEqual(bytes, expected.subarray(capture.cursor, capture.cursor + bytes.length), 'Recovered fixture bytes differ.');
        if (result.hasMore) assert.ok(bytes.length > 0, 'A nonterminal page must advance.');
        for (let written = 0; written < bytes.length;) written += writeSync(fd, bytes, written, bytes.length - written, capture.cursor + written);
        fsyncSync(fd); capture.cursor += bytes.length; capture.pages++; this.save();
        if (!result.hasMore) { assert.equal(capture.cursor, expected.length); break; }
        assert.equal(result.nextCursor, capture.cursor);
      }
    } finally { closeSync(fd); }
    const actual = readFileSync(path); assert.equal(actual.length, expected.length);
    capture.sha256 = sha256(actual); assert.equal(capture.sha256, capture.expectedSha256);
    capture.complete = true; capture.completedAt = now(); this.save();
    this.log({ captured: label, bytes: actual.length, sha256: capture.sha256, pages: capture.pages });
    return capture;
  }
  async prepare() {
    const caps = await this.capabilities();
    if (this.state.prepared) return;
    await this.job('create', ['node', '-e', `const fs=require('fs');fs.mkdirSync(${JSON.stringify(this.state.fixtureRoot)},{recursive:true});`], { cwd: '/var/lib/praxis-root' });
    const attached = await this.step('attach', 'host_project_attach', { name: `Native acceptance ${this.state.runId}`, path: this.state.fixtureRoot });
    this.state.hostProjectId = attached.hostProjectId; this.save();
    const installed = await this.job('install', ['node', '-e', `const fs=require('fs'),cp=require('child_process');const root=${JSON.stringify(this.state.fixtureRoot)};if(process.cwd()!==root||process.getuid()!==0)throw Error('Host identity mismatch');if(process.env.PRAXIS_QUAL_CUSTOM!==${JSON.stringify(this.state.runId)})throw Error('Environment mismatch');fs.writeFileSync('package.json',JSON.stringify({name:'praxis-native-fixture',private:true,version:'1.0.0'}));const r=cp.spawnSync('npm',['install','--save-exact','--no-audit','--no-fund','is-number@7.0.0'],{stdio:'inherit'});if(r.status!==0)process.exit(r.status||1);if(!require('is-number')(42))throw Error('Dependency failed');fs.writeFileSync('install-report.json',JSON.stringify({uid:process.getuid(),cwd:process.cwd(),home:process.env.HOME,customEnvironment:true,cache:cp.execFileSync('npm',['config','get','cache'],{encoding:'utf8'}).trim(),packageVersion:require('is-number/package.json').version}));`], { env: { PRAXIS_QUAL_CUSTOM: this.state.runId } });
    assert.equal(installed.timeoutSeconds, 0); assert.equal(installed.network, 'host');
    const report = JSON.parse((await this.smallFile(this.state.fixtureRoot + '/install-report.json')).content);
    assert.equal(report.uid, 0); assert.equal(report.cwd, this.state.fixtureRoot); assert.equal(report.home, caps.execution.home);
    assert.equal(report.packageVersion, '7.0.0'); assert.equal(report.customEnvironment, true); assert.ok(report.cache.startsWith(report.home + '/'));
    this.state.observations.install = report; this.save();
    const hidden = this.state.fixtureRoot + '/.env';
    // If the patch already happened on an earlier invocation, do not restore its prior content.
    if (!this.state.steps['hidden-patch']?.result) {
      const current = await this.call('host_path_info', { path: hidden, includeSha256: true });
      if (current.sha256 !== sha256('FIXTURE_VALUE=patched\n')) await this.writeFixture('hidden-write', hidden, null, 'FIXTURE_VALUE=original\n');
      await this.writeFixture('hidden-patch', hidden, 'FIXTURE_VALUE=original\n', 'FIXTURE_VALUE=patched\n', true);
    }
    assert.equal((await this.smallFile(hidden)).content, 'FIXTURE_VALUE=patched\n');
    const binaryPath = this.state.fixtureRoot + '/small.bin', binary = Buffer.from([0, 255, 128, 17, 13, 10]);
    const binaryInfo = await this.call('host_path_info', { path: binaryPath, includeSha256: true });
    if (binaryInfo.sha256 !== sha256(binary)) await this.step('binary-write', 'host_file_write', { path: binaryPath, content: binary.toString('base64'), encoding: 'base64', expectedSha256: null });
    const binaryRead = await this.call('host_file_read', { path: binaryPath, encoding: 'base64', includeSha256: true });
    assert.deepEqual(Buffer.from(binaryRead.content, 'base64'), binary);
    const listing = await this.call('host_files_list', { path: this.state.fixtureRoot });
    assert.ok(listing.entries.some(entry => entry.name === '.env'));
    const found = await this.call('host_search', { path: hidden, query: 'patched' }); assert.equal(found.matches.length, 1);
    const large = await this.job('large-output', ['node', '-e', `const fs=require('fs');if(!require('is-number')(42))throw Error('Dependency did not persist');const b=Buffer.alloc(${SIZE});for(let i=0;i<b.length;i++)b[i]=i%251;fs.writeFileSync('large.bin',b);fs.writeFileSync('persistence.json',JSON.stringify({home:process.env.HOME,dependency:true}));process.stdout.write(Buffer.concat([Buffer.alloc(${SIZE},88),Buffer.from(${JSON.stringify(`\nRAW_END_${this.state.runId}\n`)})]));process.stderr.write(${JSON.stringify('fixture stderr\n')});`], { artifactPaths: ['large.bin'] });
    const persisted = JSON.parse((await this.smallFile(this.state.fixtureRoot + '/persistence.json')).content);
    assert.equal(persisted.home, report.home); assert.equal(persisted.dependency, true);
    const artifacts = await this.call('artifact_list', { jobId: large.id });
    assert.equal(artifacts.artifacts.length, 1); const artifact = artifacts.artifacts[0];
    assert.equal(artifact.name, 'large.bin');
    assert.equal(artifact.bytes, SIZE); assert.equal(artifact.sha256, sha256(artifactBytes()));
    this.state.observations.artifact = artifact; this.save();
    const stdout = large.outputRetention.rawLogs.stdout;
    assert.equal(stdout, `${caps.execution.jobsDirectory}/praxis-code-${large.id}/stdout.raw`);
    await this.capture('stdout', stdoutBytes(this.state.runId), cursor => this.call('host_file_read', { path: stdout, cursor, maxBytes: 262144, encoding: 'base64' }));
    await this.capture('artifact', artifactBytes(), cursor => this.call('artifact_read', { jobId: large.id, artifactId: artifact.id, cursor, limit: 32768 }));
    this.state.prepared = true; this.state.observations.preparedAt = now(); this.save();
  }
  async restart() {
    assert.equal(this.state.prepared, true, 'Complete prepare first.');
    await this.capabilities();
    if (this.state.restarted) return;
    const runId = this.state.runId;
    if (!this.state.observations.restartBefore) { this.state.observations.restartBefore = await this.capabilities(); this.save(); }
    await this.startJob('heartbeat', ['node', '-e', `const fs=require('fs'),start=process.hrtime.bigint();let n=0;const fd=fs.openSync('heartbeat.jsonl','a');function record(event,extra={}){const r={event,runId:${JSON.stringify(runId)},elapsedSeconds:Number(process.hrtime.bigint()-start)/1e9,...extra};const line=JSON.stringify(r)+${JSON.stringify('\n')};fs.writeSync(fd,line);fs.fsyncSync(fd);process.stdout.write(line);}record('START');const timer=setInterval(()=>{record('HEARTBEAT',{sequence:++n});if(n===30){clearInterval(timer);record('COMPLETED',{heartbeatCount:n});fs.closeSync(fd);}},1000);`]);
    if (!this.state.steps.restart?.result) {
      // A saved submission intent may already have restarted the backend. Its
      // same-key replay recovers that job even if the heartbeat has since ended.
      for (; !this.state.steps.restart;) {
        const heartbeat = await this.call('job_status', { jobId: this.state.steps.heartbeat.result.id });
        assert.ok(ACTIVE.has(heartbeat.status), 'Heartbeat finished before restart submission; inspect the saved run without recreating it.');
        if (heartbeat.status === 'running') break;
        await this.pause();
      }
      await this.startJob('restart', ['systemctl', 'restart', 'praxis-code.service']);
    }
    const restarted = await this.observe('restart');
    const completed = await this.observe('heartbeat');
    assert.ok(Date.parse(restarted.startedAt) < Date.parse(completed.finishedAt), 'The backend restart must occur while the original heartbeat job is active.');
    const after = await this.capabilities();
    assert.notEqual(after.bootId, this.state.observations.restartBefore.bootId, 'Backend boot ID did not change.');
    const file = await this.smallFile(this.state.fixtureRoot + '/heartbeat.jsonl');
    const events = file.content.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.filter(event => event.event === 'START').length, 1);
    assert.equal(events.filter(event => event.event === 'COMPLETED').length, 1);
    assert.deepEqual(events.filter(event => event.event === 'HEARTBEAT').map(event => event.sequence), Array.from({ length: 30 }, (_, index) => index + 1));
    assert.ok(events.every(event => event.runId === runId)); assert.ok(events.at(-1).elapsedSeconds >= 29);
    this.state.observations.restart = { beforeBootId: this.state.observations.restartBefore.bootId, afterBootId: after.bootId,
      restartJobId: restarted.id, heartbeatJobId: completed.id, heartbeatRecords: events.length, heartbeatSha256: file.sha256,
      starts: 1, completions: 1, heartbeats: 30, elapsedSeconds: events.at(-1).elapsedSeconds, completedAt: now() };
    this.state.restarted = true; this.save();
  }
  async controls() {
    assert.equal(this.state.prepared, true); await this.capabilities();
    if (this.state.controlsComplete) return;
    await this.startJob('cancel-worker', ['node', '-e', 'console.log("FIXTURE_CANCEL_STARTED");setInterval(()=>{},1000);']);
    if (!this.state.steps.cancel?.result) {
      for (;;) {
        const value = await this.call('job_status', { jobId: this.state.steps['cancel-worker'].result.id });
        if (value.status === 'cancelled') { this.state.steps.cancel = { name: 'job_cancel', result: value, recoveredByStatus: true }; this.save(); break; }
        assert.ok(ACTIVE.has(value.status)); if (value.status === 'running') break; await this.pause();
      }
      if (!this.state.steps.cancel?.result) await this.step('cancel', 'job_cancel', { jobId: this.state.steps['cancel-worker'].result.id });
    }
    await this.observe('cancel-worker', 'cancelled');
    await this.startJob('deadline', ['node', '-e', 'console.log("FIXTURE_DEADLINE_STARTED");setInterval(()=>{},1000);'], { timeoutSeconds: 2 });
    const expired = await this.observe('deadline', 'timed_out'); assert.equal(expired.terminationReason, 'timeout');
    this.state.controlsComplete = true; this.save();
  }
  async recover() {
    assert.equal(this.state.prepared, true); assert.equal(this.state.restarted, true);
    this.time(); const freshClient = await this.reconnect();
    const caps = await this.capabilities();
    let cursor = 0, found = false;
    do {
      const projects = await this.call('host_projects_list', { cursor });
      found = projects.projects.some(project => project.hostProjectId === this.state.hostProjectId && project.path === this.state.fixtureRoot);
      cursor = projects.nextCursor;
    } while (!found && cursor !== null);
    assert.ok(found, 'The original host project registration must remain recoverable.');
    const recovered = {};
    for (const label of ['create', 'install', 'large-output', 'heartbeat', 'restart']) recovered[label] = await this.observe(label);
    if (this.state.controlsComplete) { await this.observe('cancel-worker', 'cancelled'); await this.observe('deadline', 'timed_out'); }
    const artifact = await this.call('artifact_list', { jobId: recovered['large-output'].id });
    assert.equal(artifact.artifacts[0].sha256, this.state.captures.artifact.sha256);
    const raw = await this.call('host_path_info', { path: recovered['large-output'].outputRetention.rawLogs.stdout, includeSha256: true });
    assert.equal(raw.sha256, this.state.captures.stdout.sha256);
    const heartbeat = await this.smallFile(this.state.fixtureRoot + '/heartbeat.jsonl');
    assert.equal(heartbeat.sha256, this.state.observations.restart.heartbeatSha256);
    this.state.observations.recovery = { observedAt: now(), freshClient: Boolean(freshClient), release: caps.release, bootId: caps.bootId,
      jobIds: Object.fromEntries(Object.entries(recovered).map(([label, value]) => [label, value.id])),
      artifactSha256: artifact.artifacts[0].sha256, stdoutSha256: raw.sha256, heartbeatSha256: heartbeat.sha256 };
    this.state.recovered = true; this.save();
  }
}

async function main() {
  const [phase, filename] = process.argv.slice(2);
  assert.ok(PHASES.includes(phase) && filename, 'Use prepare|restart|controls|recover|all PRIVATE_STATE.json');
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  for (const path of [filename, process.env.PRAXIS_PASSWORD_FILE, process.env.PRAXIS_CLIENT_STATE]) {
    assert.ok(path && isAbsolute(path), 'State and credential file paths must be absolute.');
    const rel = relative(repository, resolve(path)); assert.ok(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel), 'Private state must remain outside Git.');
  }
  assert.ok(existsSync(filename) || ['prepare', 'all'].includes(phase), 'Resume needs the original private state file.');
  const runId = randomUUID();
  const state = existsSync(filename) ? JSON.parse(readFileSync(filename, 'utf8')) : {
    version: 1, evidenceKind: 'owner-authenticated-API-native-root-fixture', nativePhoneRun: false,
    runId, fixtureRoot: `/var/lib/praxis-root/acceptance/${runId}`, steps: {}, captures: {}, calls: [], observations: {}, createdAt: now()
  };
  assert.equal(state.version, 1); assert.equal(state.evidenceKind, 'owner-authenticated-API-native-root-fixture');
  const save = () => {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    const fd = openSync(filename + '.next', 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify(state, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(filename + '.next', filename);
  };
  save(); let client;
  async function disconnect() {
    const previous = client; client = null;
    if (previous) await Promise.race([previous.close().catch(() => {}), delay(2000)]);
  }
  async function connect() {
    await disconnect();
    const session = await authorize({ baseUrl: process.env.PRAXIS_BASE_URL || 'https://mcp.jensenabler.com/praxis',
      passwordFile: process.env.PRAXIS_PASSWORD_FILE, stateFile: process.env.PRAXIS_CLIENT_STATE, scope: 'praxis:code offline_access' });
    client = new Client({ name: 'Praxis native root owner API qualification', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(session.resource), { requestInit: { headers: { authorization: `Bearer ${session.token}` } } }), { timeout: 20000 });
    state.connections = (state.connections || 0) + 1; save();
    return true;
  }
  try {
    const qualification = new NativeRootQualification({ state, save, reconnect: connect, captureDirectory: filename + '.captures',
      rpc: async (name, args) => {
        try {
          if (!client) await connect();
          const result = await client.callTool({ name, arguments: args }, { timeout: 20000 });
          if (!result.structuredContent) throw Object.assign(new Error('Missing structured tool response'), { code: 'MCP_ERROR' });
          if (result.structuredContent.error?.code === 'BACKEND_UNAVAILABLE') await disconnect();
          return result.structuredContent;
        } catch (error) {
          await disconnect();
          throw Object.assign(new Error('MCP transport failed; reconnect with saved job identities.'), { code: 'TRANSPORT_ERROR' });
        }
      } });
    try {
      if (phase === 'all') for (const selected of ['prepare', 'restart', 'controls', 'recover']) await qualification[selected]();
      else await qualification[phase]();
      state.lastInvocation = { phase, status: 'completed', finishedAt: now() };
    } catch (error) {
      state.lastInvocation = { phase, status: error instanceof QualificationPending ? 'pending' : 'needs-inspection', code: error.code || 'CHECK_FAILED', message: String(error.message).slice(0, 500), finishedAt: now() };
      if (!(error instanceof QualificationPending)) process.exitCode = 1;
    }
    save(); console.log(JSON.stringify({ ...state.lastInvocation, runId: state.runId, hostProjectId: state.hostProjectId,
      prepared: Boolean(state.prepared), backendRestartVerified: Boolean(state.restarted), controlsComplete: Boolean(state.controlsComplete), recovered: Boolean(state.recovered) }));
  } finally { await disconnect(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ status: 'needs-inspection', code: error.code || 'CLIENT_FAILED', message: String(error.message).slice(0, 300) })); process.exitCode = 1; });
}
