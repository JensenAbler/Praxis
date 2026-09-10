/** Owner-run API qualification. Never run automatically from tests or bootstrap.
 * node scripts/autonomy-self-update.js prepare|publish|plan|apply|recover PRIVATE_STATE.json
 * PRAXIS_PASSWORD_FILE and PRAXIS_CLIENT_STATE must point to private files.
 * Each invocation polls for at most 45 seconds, then returns pending. Resume the
 * SAME phase and state file. A failed/ambiguous job is observed, never recreated.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { authorize } from './oauth-client.js';

export const SOURCE_FRESHNESS = 'Run project_sync before creating a workspace when you need current GitHub main, and inspect its completed sync receipt. Existing workspaces retain their immutable base and cannot be rebased in place; create a new workspace from the fresh snapshot to reconcile newer source.';
const SOURCE_PATH = 'src/code/server.js';
const PHASES = ['prepare', 'publish', 'plan', 'apply', 'recover'];
const GIT_TERMINAL = new Set(['completed', 'failed', 'uncertain']);
const JOB_ACTIVE = new Set(['queued', 'starting', 'running', 'canceling']);
const RELEASE_TERMINAL = new Set(['ready', 'completed', 'failed', 'rolled_back']);
const timestamp = () => new Date().toISOString();
const sha256 = value => createHash('sha256').update(value).digest('hex');
class Pending extends Error { constructor(message) { super(message); this.code = 'PENDING'; } }

export function releaseOperationId(key) {
  // The independently installed broker deterministically names release calls.
  // This allows read-only recovery even if admission's response was lost.
  const bytes = createHash('sha256').update(`praxis-release\0jensen\0${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50; bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class SelfUpdateQualification {
  constructor({ state, save, rpc, budgetMs = 45000, log = value => console.log(JSON.stringify(value)) }) {
    this.state = state; this.save = save; this.rpc = rpc; this.log = log;
    this.deadline = Date.now() + budgetMs;
  }
  key(label) { return `self-update-v05:${this.state.runId}:${label}`; }
  ensureTime() { if (Date.now() >= this.deadline) throw new Pending('Invocation polling budget reached; resume the same phase and state file.'); }
  async call(name, args = {}) {
    this.ensureTime();
    const record = { name, args, intendedAt: timestamp() };
    this.state.calls.push(record); this.save();
    try {
      const response = await this.rpc(name, args);
      record.response = response; record.returnedAt = timestamp(); this.save();
      if (response?.ok !== true) {
        const error = new Error(`${name} returned ${response?.error?.code || 'INVALID_RESPONSE'}; full response saved privately.`);
        error.code = response?.error?.code || 'INVALID_RESPONSE'; throw error;
      }
      return response;
    } catch (error) {
      record.error = { code: error.code || 'TRANSPORT_ERROR', message: String(error.message).slice(0, 1000) };
      record.returnedAt = timestamp(); this.save(); throw error;
    }
  }
  async step(label, name, makeArgs) {
    let saved = this.state.steps[label];
    if (!saved) {
      const args = await makeArgs();
      saved = this.state.steps[label] = { name, args, intendedAt: timestamp(), attempts: 0 };
      if (name.startsWith('praxis_release_')) saved.expectedOperationId = releaseOperationId(args.idempotencyKey);
      this.save();
    }
    assert.equal(saved.name, name, 'Saved phase belongs to a different tool');
    if (!saved.result && saved.expectedOperationId && saved.attempts > 0) {
      // An identical release_apply retry can explicitly resume restoration.
      // Qualification must first observe its known ID instead of triggering it.
      try {
        const observed = await this.call('praxis_release_status', { operationId: saved.expectedOperationId });
        assert.equal(observed.operation?.operationId, saved.expectedOperationId);
        saved.result = observed.operation; saved.recoveredAdmission = true; this.save();
      } catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
    }
    if (!saved.result) {
      saved.attempts++; this.save();
      saved.result = await this.call(name, saved.args); this.save();
      if (saved.expectedOperationId) assert.equal(saved.result.operationId, saved.expectedOperationId);
    }
    return saved.result;
  }
  async observe(label, kind, identifier) {
    const tool = kind === 'git' ? 'git_operation_status' : kind === 'job' ? 'job_status' : 'praxis_release_status';
    for (;;) {
      const response = await this.call(tool, kind === 'job' ? { jobId: identifier } : { operationId: identifier });
      const result = kind === 'release' ? response.operation : response;
      assert.ok(result && typeof result.status === 'string', 'Expected durable status response');
      this.state.steps[label].observed = response; this.save();
      const terminal = kind === 'git' ? GIT_TERMINAL.has(result.status)
        : kind === 'job' ? !JOB_ACTIVE.has(result.status) : RELEASE_TERMINAL.has(result.status);
      if (terminal) {
        const expected = kind === 'release' && label === 'release-plan' ? 'ready' : 'completed';
        assert.equal(result.status, expected, `${label} is ${result.status}; inspect saved result and do not recreate it.`);
        if (kind === 'job') { assert.equal(result.exitCode, 0); assert.equal(result.revisionVerified, true); }
        this.log({ step: label, kind, id: identifier, status: result.status, ...(kind === 'job' ? { exitCode: result.exitCode } : {}) });
        return result;
      }
      this.ensureTime();
      await delay(Math.min(2000, Math.max(0, this.deadline - Date.now())));
    }
  }
  async operation(label, name, args) {
    const receipt = await this.step(label, name, args);
    assert.ok(receipt.operationId, 'Durable Git operation ID required');
    return this.observe(label, 'git', receipt.operationId);
  }
  async job(label, args) {
    const receipt = await this.step(label, 'job_start', args);
    assert.ok(receipt.id, 'Durable job ID required');
    return this.observe(label, 'job', receipt.id);
  }
  async source(workspaceId) {
    const page = await this.call('file_read', { workspaceId, path: SOURCE_PATH, lineCount: 200 });
    assert.equal(page.nextPosition, null, 'Expected bounded single-page server source; inspect changes before adapting this client.');
    assert.ok(page.lines.every((line, index) => line.number === index + 1 && !line.truncated && !line.column));
    const text = page.lines.map(line => line.text).join('\n');
    // Git source uses LF. Refuse alternate encodings instead of guessing patch bytes.
    assert.equal(sha256(text), page.sha256, 'Reconstructed source bytes differ from the returned file hash');
    return { ...page, text };
  }
  async readDiff(revision) {
    let cursor = 0; const pages = [], seen = new Set();
    do {
      assert.ok(!seen.has(cursor) && pages.length < 20, 'Diff pagination did not finish'); seen.add(cursor);
      const page = await this.call('workspace_diff', { workspaceId: this.state.workspaceId, expectedRevision: revision, cursor });
      assert.equal(page.revision, revision); pages.push(page);
      cursor = page.nextCursor;
      assert.ok(cursor === null || Number.isSafeInteger(cursor), 'Expected supplied diff cursor');
    } while (cursor !== null);
    assert.equal(pages[0].changedFileCount, 1);
    assert.deepEqual(pages[0].changes.map(change => change.path), [SOURCE_PATH]);
    const text = pages.map(page => page.diff).join('');
    assert.equal(Buffer.byteLength(text), pages[0].totalBytes);
    assert.ok(text.includes(SOURCE_FRESHNESS));
    this.state.observations.diff = pages; this.state.diffSha256 = sha256(text); this.save();
  }
  async prepare() {
    const validationStep = this.state.validationStep || 'validate';
    const validationRetry = validationStep !== 'validate';
    if (validationRetry) {
      assert.match(validationStep, /^validate-[a-z0-9]+(?:-[a-z0-9]+)*$/, 'An explicit validation retry needs a dedicated validate-<suffix> label');
      assert.ok(validationStep.length <= 96, 'Validation retry label is too long');
      assert.ok(typeof this.state.validationImage === 'string' && this.state.validationImage.length > 0,
        'An explicit validation retry must select the corrected executor image');
    }
    const caps = await this.call('capabilities');
    assert.equal(caps.dependencies?.registryAccessEnabled, true);
    assert.equal(caps.selfImprovement?.enabled, true);
    if (this.state.validationImage) assert.equal(caps.execution?.imageDigest, this.state.validationImage,
      'The explicitly selected validation image has not been activated');
    this.state.observations.capabilitiesBefore ??= caps; this.save();
    const synced = await this.operation('sync-base', 'project_sync', async () => ({ projectId: 'praxis', idempotencyKey: this.key('sync-base') }));
    assert.match(synced.result.commit, /^[a-f0-9]{40}$/);
    this.state.baseCommit = synced.result.commit; this.save();
    const created = await this.step('workspace', 'workspace_create', async () => {
      const project = await this.call('project_inspect', { projectId: 'praxis' });
      assert.equal(project.revision, this.state.baseCommit, 'Registered main changed since sync; do not silently change this run\'s base');
      this.state.observations.projectBefore = project; this.save();
      return { projectId: 'praxis', baseRevision: project.revision, label: `Self-update qualification ${this.state.runId.slice(0, 8)}`,
        idempotencyKey: this.key('workspace') };
    });
    assert.equal(created.status, 'completed');
    this.state.workspaceId = created.workspaceId; this.save();
    const edited = await this.step('edit', 'workspace_apply', async () => {
      const source = await this.source(this.state.workspaceId);
      const oldText = '        usage: {';
      assert.equal(source.text.split(oldText).length, 2, 'Expected exactly one capabilities usage object');
      assert.ok(!source.text.includes('sourceFreshness:'), 'Source freshness guidance already exists; inspect before choosing another self-update');
      const newText = `${oldText}\n          sourceFreshness: ${JSON.stringify(SOURCE_FRESHNESS)},`;
      this.state.expectedSourceSha256 = sha256(source.text.replace(oldText, newText));
      this.state.observations.sourceBefore = source; this.save();
      return { workspaceId: this.state.workspaceId, expectedRevision: source.revision, idempotencyKey: this.key('edit'),
        changes: [{ action: 'patch', path: SOURCE_PATH, expectedSha256: source.sha256, oldText, newText }] };
    });
    assert.equal(edited.status, 'completed');
    const installed = await this.job('install', async () => ({ workspaceId: this.state.workspaceId,
      expectedRevision: edited.result.revision, argv: ['npm', 'ci', '--ignore-scripts', '--include=dev', '--no-audit', '--no-fund'],
      network: 'registries', env: { CI: 'true', NODE_ENV: 'test' }, timeoutSeconds: 900,
      label: 'Install Praxis test dependencies', idempotencyKey: this.key('install') }));
    assert.equal(installed.revisionAfter, edited.result.revision, 'npm ci unexpectedly changed tracked source');
    const validationArgs = { workspaceId: this.state.workspaceId,
      expectedRevision: installed.revisionAfter, argv: ['npm', 'test'], network: 'none', env: { CI: 'true', NODE_ENV: 'test' },
      timeoutSeconds: 900, label: 'Offline Praxis full suite', idempotencyKey: this.key(validationStep) };
    if (validationRetry) {
      const original = this.state.steps.validate;
      assert.equal(original?.name, 'job_start', 'Recover the original validation submission before selecting a retry');
      assert.ok(original.result?.id, 'Recover the original validation job ID before selecting a retry');
      assert.equal(original.args.workspaceId, validationArgs.workspaceId, 'Original validation belongs to another workspace');
      assert.equal(original.args.expectedRevision, validationArgs.expectedRevision, 'Retry must retain the original validation source revision');
      assert.deepEqual(original.args.argv, ['npm', 'test'], 'Original validation must be the full offline suite');
      assert.equal(original.args.network, 'none');
      assert.notEqual(original.args.idempotencyKey, validationArgs.idempotencyKey, 'An explicit retry needs its own job key');
      for (const [label, saved] of Object.entries(this.state.steps)) {
        if (label !== validationStep) assert.notEqual(saved.args?.idempotencyKey, validationArgs.idempotencyKey,
          'Validation retry key collides with another saved operation');
      }
      const retry = this.state.steps[validationStep];
      if (retry) {
        assert.equal(retry.name, 'job_start', 'Validation retry label collides with another saved operation');
        assert.deepEqual(retry.args, validationArgs, 'Saved validation retry inputs changed; recover the original retry');
      }
      const failed = await this.call('job_status', { jobId: original.result.id });
      assert.equal(failed.id, original.result.id);
      assert.equal(failed.status, 'failed', 'Only a confirmed failed validation may receive an explicit new job');
      assert.ok(Number.isInteger(failed.exitCode) && failed.exitCode !== 0, 'Original validation must have an explicit nonzero exit');
      assert.equal(failed.workspaceId, validationArgs.workspaceId);
      assert.equal(failed.expectedRevision, validationArgs.expectedRevision);
      assert.equal(failed.revisionVerified, true, 'Original failed validation source must be recoverable');
      assert.equal(failed.revisionAfter, validationArgs.expectedRevision, 'Original failed validation changed tracked source');
      this.state.observations.validationRetry = { originalJob: failed, validationStep,
        expectedRevision: validationArgs.expectedRevision, imageDigest: caps.execution.imageDigest, observedAt: timestamp() };
      this.save();
    }
    const tested = await this.job(validationStep, async () => validationArgs);
    assert.equal(tested.revisionAfter, edited.result.revision, 'Tests unexpectedly changed tracked source');
    const source = await this.source(this.state.workspaceId);
    assert.equal(source.sha256, this.state.expectedSourceSha256);
    this.state.validatedRevision = tested.revisionAfter; this.save();
    this.state.validatedJobId = tested.id; this.save();
    await this.readDiff(this.state.validatedRevision);
    this.state.prepared = true; this.save();
  }
  async publish() {
    assert.equal(this.state.prepared, true, 'Complete prepare and review the private saved diff first');
    const committed = await this.operation('commit', 'git_commit', async () => ({ workspaceId: this.state.workspaceId,
      expectedRevision: this.state.validatedRevision, message: 'Explain immutable source freshness in coding capabilities', idempotencyKey: this.key('commit') }));
    assert.equal(committed.result.parentCommit, this.state.baseCommit);
    assert.equal(committed.result.expectedRemoteHead, this.state.baseCommit, 'Expected remote main must match the original sync');
    const pushed = await this.operation('push', 'git_push', async () => ({ commitOperationId: committed.operationId, idempotencyKey: this.key('push') }));
    assert.equal(pushed.result.publishedCommit, committed.result.commit);
    assert.equal(pushed.result.observedRemoteHead, committed.result.commit);
    this.state.publishedCommit = committed.result.commit; this.save();
  }
  async plan() {
    assert.match(this.state.publishedCommit || '', /^[a-f0-9]{40}$/, 'Publish the prepared change first');
    const synced = await this.operation('sync-published', 'project_sync', async () => ({ projectId: 'praxis', idempotencyKey: this.key('sync-published') }));
    assert.equal(synced.result.commit, this.state.publishedCommit, 'Main advanced; do not prepare a different source release silently');
    const initial = await this.step('release-plan', 'praxis_release_plan', async () => {
      const status = await this.call('praxis_release_status');
      assert.ok(status.active?.release, 'Expected protected active release response');
      this.state.observations.releaseBefore = status; this.save();
      return { syncOperationId: synced.operationId, expectedRelease: status.active.release, idempotencyKey: this.key('release-plan') };
    });
    const ready = await this.observe('release-plan', 'release', initial.operationId);
    assert.equal(ready.result.sourceCommit, this.state.publishedCommit);
    assert.match(ready.result.planDigest, /^[a-f0-9]{64}$/);
    assert.equal(ready.result.testEvidence.npmTestPassed, true);
    assert.equal(ready.result.testEvidence.authenticatedMcpPassed, true);
    this.state.readyPlan = ready; this.save();
  }
  async apply() {
    const ready = this.state.readyPlan;
    assert.equal(ready?.status, 'ready', 'Complete and review release preparation first');
    const initial = await this.step('release-apply', 'praxis_release_apply', async () => ({ planId: ready.operationId,
      planDigest: ready.result.planDigest, expectedRelease: ready.result.expectedRelease, idempotencyKey: this.key('release-apply') }));
    const completed = await this.observe('release-apply', 'release', initial.operationId);
    assert.equal(completed.result.release, ready.result.release);
    this.state.applied = completed; this.save();
  }
  async recover() {
    // Protected status comes first: backend failure must not hide activation.
    const results = {};
    const read = async (label, name, args = {}) => {
      try { results[label] = await this.call(name, args); }
      catch (error) { if (error instanceof Pending) throw error; results[label] = { unavailable: true, code: error.code || 'READ_FAILED' }; }
      this.state.observations.recovery = results; this.save();
    };
    await read('activeRelease', 'praxis_release_status');
    for (const label of ['release-plan', 'release-apply']) {
      const saved = this.state.steps[label], id = saved?.result?.operationId || saved?.expectedOperationId;
      if (id) await read(label, 'praxis_release_status', { operationId: id });
    }
    if (this.state.workspaceId) await read('workspace', 'workspace_inspect', { workspaceId: this.state.workspaceId });
    for (const label of new Set(['install', 'validate', this.state.validationStep || 'validate'])) {
      const id = this.state.steps[label]?.result?.id;
      if (id) await read(label, 'job_status', { jobId: id });
    }
    for (const label of ['sync-base', 'commit', 'push', 'sync-published']) {
      const id = this.state.steps[label]?.result?.operationId;
      if (id) await read(label, 'git_operation_status', { operationId: id });
    }
    for (const label of ['workspace', 'edit']) {
      const id = this.state.steps[label]?.result?.operationId;
      if (id) await read(label + '-receipt', 'operation_read', { operationId: id });
    }
    await read('capabilities', 'capabilities');
    const activation = results['release-apply']?.operation;
    if (activation?.status === 'completed') {
      assert.equal(results.activeRelease.active?.release, this.state.readyPlan.result.release);
      if (!results.capabilities.unavailable) {
        assert.equal(results.capabilities.release, this.state.readyPlan.result.release);
        assert.equal(results.capabilities.usage.sourceFreshness, SOURCE_FRESHNESS);
      }
    }
    this.state.observations.recoveredAt = timestamp(); this.save();
    this.log({ recovery: true, releaseStatus: activation?.status || 'not-yet-applied',
      unavailable: Object.entries(results).filter(([, value]) => value.unavailable).map(([label]) => label) });
  }
}

async function main() {
  const [phase, filename] = process.argv.slice(2);
  assert.ok(PHASES.includes(phase) && filename, 'Use prepare|publish|plan|apply|recover PRIVATE_STATE.json');
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const outsideRepository = filename => {
    assert.ok(filename && isAbsolute(filename), 'Credential and result paths must be absolute private paths');
    const rel = relative(repository, resolve(filename));
    assert.ok(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel), 'Private state must remain outside the repository');
  };
  for (const path of [filename, process.env.PRAXIS_PASSWORD_FILE, process.env.PRAXIS_CLIENT_STATE]) outsideRepository(path);
  assert.ok(existsSync(filename) || phase === 'prepare', 'Resume requires the original private state file');
  const state = existsSync(filename) ? JSON.parse(readFileSync(filename, 'utf8')) : {
    version: 1, evidenceKind: 'owner-authenticated-API-self-update', nativePhoneRun: false, runId: randomUUID(),
    projectId: 'praxis', steps: {}, observations: {}, calls: [], createdAt: timestamp()
  };
  assert.equal(state.version, 1); assert.equal(state.projectId, 'praxis');
  const save = () => {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    const fd = openSync(filename + '.next', 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify(state, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(filename + '.next', filename);
  };
  save();
  const session = await authorize({ baseUrl: process.env.PRAXIS_BASE_URL || 'https://mcp.jensenabler.com/praxis',
    passwordFile: process.env.PRAXIS_PASSWORD_FILE, stateFile: process.env.PRAXIS_CLIENT_STATE, scope: 'praxis:code offline_access' });
  const client = new Client({ name: 'Praxis owner self-update qualification', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(session.resource), {
      requestInit: { headers: { authorization: `Bearer ${session.token}` } }
    }));
    const qualification = new SelfUpdateQualification({ state, save,
      rpc: async (name, args) => (await client.callTool({ name, arguments: args }, { timeout: 20000 })).structuredContent });
    try {
      await qualification[phase]();
      state.lastInvocation = { phase, status: 'completed', finishedAt: timestamp() }; save();
    } catch (error) {
      state.lastInvocation = { phase, status: error instanceof Pending ? 'pending' : 'needs-inspection',
        code: error.code || 'CHECK_FAILED', message: String(error.message).slice(0, 1000), finishedAt: timestamp() }; save();
      if (!(error instanceof Pending)) process.exitCode = 1;
    }
    console.log(JSON.stringify({ phase, status: state.lastInvocation.status, code: state.lastInvocation.code,
      workspaceId: state.workspaceId, publishedCommit: state.publishedCommit,
      planId: state.steps['release-plan']?.result?.operationId,
      applyId: state.steps['release-apply']?.result?.operationId, privateStateFile: filename }));
  } finally { await client.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ status: 'needs-inspection', code: error.code || 'CLIENT_FAILED',
    message: String(error.message).slice(0, 300) })); process.exitCode = 1; });
}
