/** Explicit owner API qualification. All state/results belong in a private file. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { authorize } from './oauth-client.js';

const [phase, stateFile, projectName] = process.argv.slice(2);
assert.ok(['prepare', 'publish', 'deploy', 'recover'].includes(phase));
assert.match(projectName || '', /^[a-z][a-z0-9-]{0,39}$/);
assert.ok(stateFile && process.env.PRAXIS_PASSWORD_FILE && process.env.PRAXIS_CLIENT_STATE);
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8'))
  : { evidenceKind: 'owner-authenticated-API-live-fixture', projectName, steps: {}, observations: {} };
assert.equal(state.projectName, projectName);
const save = () => {
  writeFileSync(stateFile + '.next', JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  renameSync(stateFile + '.next', stateFile);
};
const key = suffix => `autonomy-v05:${projectName}:${suffix}`;
const session = await authorize({ baseUrl: process.env.PRAXIS_BASE_URL || 'https://mcp.jensenabler.com/praxis',
  passwordFile: process.env.PRAXIS_PASSWORD_FILE, stateFile: process.env.PRAXIS_CLIENT_STATE, scope: 'praxis:code offline_access' });
const client = new Client({ name: 'Praxis autonomy owner API qualification', version: '1' });
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent || result.content));
  assert.equal(result.structuredContent?.ok, true, name);
  return result.structuredContent;
}
async function step(label, name, args) {
  let saved = state.steps[label];
  if (!saved) { saved = state.steps[label] = { name, args, intendedAt: new Date().toISOString() }; save(); }
  assert.equal(saved.name, name);
  // A resume uses the original persisted request, including its old revision.
  if (!saved.result) { saved.result = await call(name, saved.args); save(); }
  return saved.result;
}
async function completedOperation(label, name, args) {
  const initial = await step(label, name, args);
  return observeOperation(label, initial.operationId);
}
async function observeOperation(label, operationId) {
  for (let i = 0; i < 180; i++) {
    const result = await call('git_operation_status', { operationId });
    state.steps[label].observed = result; save();
    if (['completed', 'failed', 'uncertain'].includes(result.status)) {
      assert.equal(result.status, 'completed', JSON.stringify(result));
      console.log(JSON.stringify({ step: label, operationId: result.operationId, status: result.status }));
      return result;
    }
    await delay(2000);
  }
  throw new Error(`Observe existing operation ${operationId}; qualification polling deadline reached.`);
}
async function completedJob(label, name, args) {
  const initial = await step(label, name, args), jobId = initial.id;
  assert.ok(jobId, 'Job response must preserve its ID');
  for (let i = 0; i < 300; i++) {
    const result = await call('job_status', { jobId });
    state.steps[label].observed = result; save();
    if (!['queued', 'starting', 'running', 'canceling'].includes(result.status)) {
      assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.exitCode, 0);
      console.log(JSON.stringify({ step: label, jobId, status: result.status, exitCode: result.exitCode }));
      return result;
    }
    await delay(2000);
  }
  throw new Error(`Observe existing job ${jobId}; qualification polling deadline reached.`);
}
async function diff(workspaceId, revision) {
  const pages = []; let cursor = 0;
  do {
    const page = await call('workspace_diff', { workspaceId, expectedRevision: revision, cursor }); pages.push(page);
    cursor = page.nextCursor;
    if (cursor === null || page.hasMore === false) break;
    assert.ok(Number.isSafeInteger(cursor), 'Diff must supply its next cursor');
  } while (pages.length < 100);
  state.observations.diff = pages; save();
}
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(session.resource), { requestInit: { headers: { authorization: `Bearer ${session.token}` } } }));
  state.observations.capabilities = await call('capabilities'); save();
  if (phase === 'prepare') {
    assert.equal(state.observations.capabilities.dependencies.registryAccessEnabled, true);
    const created = await completedOperation('create', 'project_create', { name: projectName, template: 'node', idempotencyKey: key('create') });
    state.projectId = created.projectId; save();
    const repeated = await call('project_create', state.steps.create.args);
    assert.equal(repeated.operationId, created.operationId);
    const project = await call('project_inspect', { projectId: state.projectId });
    const workspace = await step('workspace', 'workspace_create', { projectId: state.projectId, baseRevision: project.revision,
      label: 'Autonomy v0.5 live qualification', idempotencyKey: key('workspace') });
    state.workspaceId = workspace.workspaceId; save();
    const inspected = await call('workspace_inspect', { workspaceId: state.workspaceId });
    const installed = await completedJob('install', 'job_start', { workspaceId: state.workspaceId, expectedRevision: inspected.revision,
      argv: ['npm', 'install', '--save-exact', '--no-audit', '--no-fund', 'is-number@7.0.0'], network: 'registries', timeoutSeconds: 180,
      label: 'Install public npm dependency', idempotencyKey: key('install') });
    const app = await call('file_read', { workspaceId: state.workspaceId, path: 'app.js' });
    const test = await call('file_read', { workspaceId: state.workspaceId, path: 'app.test.js' });
    const edited = await step('edit', 'workspace_apply', { workspaceId: state.workspaceId, expectedRevision: app.revision,
      idempotencyKey: key('edit'), changes: [
        { action: 'write', path: 'app.js', expectedSha256: app.sha256,
          content: "import isNumber from 'is-number';\nexport function handler(request, response) {\n  response.writeHead(200, { 'content-type': 'application/json' });\n  response.end(JSON.stringify(request.url === '/healthz' ? { ok: true } : { message: 'Praxis independent project workflow', dependencyVerified: isNumber(42) }));\n}\n" },
        { action: 'write', path: 'app.test.js', expectedSha256: test.sha256,
          content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { handler } from './app.js';\nfor (const [url, expected] of [['/healthz', { ok: true }], ['/', { message: 'Praxis independent project workflow', dependencyVerified: true }]]) {\n  test('response for ' + url, () => {\n    let status, body;\n    handler({ url }, { writeHead(value) { status = value; }, end(value) { body = value; } });\n    assert.equal(status, 200);\n    assert.deepEqual(JSON.parse(body), expected);\n  });\n}\n" }
      ] });
    const validated = await completedJob('validate', 'job_start', { workspaceId: state.workspaceId, expectedRevision: edited.result.revision,
      argv: ['npm', 'test'], network: 'none', timeoutSeconds: 180, label: 'Offline new app validation', idempotencyKey: key('validate') });
    const prepared = await completedJob('dependencies', 'dependency_prepare', { workspaceId: state.workspaceId,
      expectedRevision: validated.revisionAfter, idempotencyKey: key('dependencies') });
    assert.match(prepared.preparedDependenciesId || '', /^[a-f0-9]{64}$/);
    state.preparedDependenciesId = prepared.preparedDependenciesId; state.validatedRevision = validated.revisionAfter; save();
    await diff(state.workspaceId, state.validatedRevision);
    state.prepared = true; save();
  } else if (phase === 'publish') {
    assert.equal(state.prepared, true, 'Prepare and inspect the saved source diff first');
    const committed = await completedOperation('commit', 'git_commit', { workspaceId: state.workspaceId, expectedRevision: state.validatedRevision,
      message: 'Qualify independent project and dependency deployment', idempotencyKey: key('commit') });
    const published = await completedOperation('publish', 'project_publish', { projectId: state.projectId, visibility: 'private',
      commitOperationId: committed.operationId, idempotencyKey: key('publish') });
    state.publishedCommit = published.result.commit; state.publicationOperationId = published.operationId; save();
  } else if (phase === 'deploy') {
    assert.ok(state.publicationOperationId);
    const before = await call('deployment_status', { projectId: state.projectId });
    state.observations.deploymentBefore ??= before; save();
    const deployed = await completedOperation('deploy', 'project_deploy', { publicationOperationId: state.publicationOperationId,
      expectedHead: before.currentHead, preparedDependenciesId: state.preparedDependenciesId, idempotencyKey: key('deploy') });
    state.deployment = deployed; save();
  }
  if (phase === 'recover' || phase === 'deploy') {
    if (!state.deployment) {
      const operationId = state.steps.deploy?.result?.operationId;
      assert.ok(operationId, 'No deployment ID was saved; resume deploy with the existing state and original idempotency key.');
      state.deployment = await observeOperation('deploy', operationId); save();
    }
    state.observations.workspace = await call('workspace_inspect', { workspaceId: state.workspaceId });
    state.observations.project = await call('project_inspect', { projectId: state.projectId });
    state.observations.deployment = await call('deployment_status', { projectId: state.projectId });
    assert.equal(state.observations.deployment.currentHead, state.publishedCommit);
    const url = state.observations.deployment.url;
    assert.equal(new URL(url).origin, 'https://praxis-apps.jensenabler.com');
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) }); assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, { message: 'Praxis independent project workflow', dependencyVerified: true });
    state.observations.https = { url, status: response.status, body, observedAt: new Date().toISOString() };
    for (const label of ['create', 'commit', 'publish', 'deploy']) {
      const operation = await call('git_operation_status', { operationId: state.steps[label].result.operationId });
      assert.equal(operation.status, 'completed'); state.steps[label].recovered = operation;
    }
    const bundle = await call('job_status', { jobId: state.steps.dependencies.result.id });
    assert.equal(bundle.preparedDependenciesId, state.preparedDependenciesId);
    state.observations.recoveredAt = new Date().toISOString(); save();
  }
  console.log(JSON.stringify({ phase, succeeded: true, stateFile, projectId: state.projectId, workspaceId: state.workspaceId }));
} finally { await client.close(); }
