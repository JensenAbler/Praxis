import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { authorize } from './oauth-client.js';

const baseUrl = process.env.PRAXIS_BASE_URL;
const passwordFile = process.env.PRAXIS_PASSWORD_FILE;
const stateFile = process.env.PRAXIS_CLIENT_STATE;
if (!baseUrl || !passwordFile || !stateFile) throw new Error('Set PRAXIS_BASE_URL, PRAXIS_PASSWORD_FILE, and private PRAXIS_CLIENT_STATE path');
const command = process.argv[2] || 'smoke';
const session = await authorize({ baseUrl, passwordFile, stateFile });
const client = new Client({ name: 'Praxis deployment verification', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(session.resource), { requestInit: { headers: { Authorization: `Bearer ${session.token}` } } }));
async function call(name, args = {}, expectError = false) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(Boolean(result.isError), expectError, `${name}: unexpected error status`);
  return result.structuredContent || JSON.parse(result.content.find(item => item.type === 'text').text);
}
try {
  const capabilities = await call('probe_capabilities');
  if (command === 'smoke') {
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    assert.equal(tools.length, 9);
    const result = await call('probe_response', { bytes: 4096, marker: 'verified-end', delayMs: 25 });
    assert.equal(result.payloadBytes, 4096);
    assert.equal(result.sha256, createHash('sha256').update(result.payload).digest('hex'));
    assert.equal(result.endMarker, 'verified-end');
    const failure = await call('probe_failure', {}, true);
    assert.equal(failure.error.code, 'FIXTURE_ERROR');
    assert.equal((await call('probe_capabilities')).ok, true);
    const observations = await call('probe_observations', { limit: 100 });
    console.log(JSON.stringify({ check: 'authenticated-mcp-smoke', ok: true, release: capabilities.release, bootId: capabilities.bootId, tools, syntheticPayloadBytes: result.payloadBytes, controlledErrorRecovered: true, receiptCount: observations.observations.length }));
  } else if (command === 'start') {
    const args = { idempotencyKey: randomUUID(), label: 'Deployment: MCP app restart recovery', durationSeconds: 45, intervalSeconds: 5 };
    const { job } = await call('probe_job_start', args);
    const repeated = await call('probe_job_start', args);
    assert.equal(repeated.job.id, job.id);
    session.state.jobId = job.id; session.state.beforeBootId = capabilities.bootId; session.save();
    console.log(JSON.stringify({ check: 'durable-job-start', ok: true, job, idempotencyVerified: true, bootId: capabilities.bootId }));
  } else if (command === 'recover') {
    assert.ok(session.state.jobId, 'Start a fixture first');
    const { job } = await call('probe_job_status', { jobId: session.state.jobId });
    const records = []; let cursor = 0;
    for (let page = 0; page < 50; page++) {
      const logs = await call('probe_job_logs', { jobId: job.id, cursor, limit: 3 });
      records.push(...logs.records);
      if (!logs.records.length) break;
      assert.ok(logs.nextCursor > cursor); cursor = logs.nextCursor;
    }
    assert.equal(job.status, 'completed');
    assert.equal(records.filter(record => record.event === 'COMPLETED').length, 1);
    assert.equal(new Set(records.map(record => record.sequence)).size, records.length);
    assert.notEqual(capabilities.bootId, session.state.beforeBootId, 'App must have restarted');
    const listed = await call('probe_jobs_list');
    assert.ok(listed.jobs.some(item => item.id === job.id));
    console.log(JSON.stringify({ check: 'app-restart-recovery', ok: true, job, appBootChanged: true, records, recoveredThroughList: true }));
  } else throw new Error('Supported commands: smoke, start, recover');
} finally { await client.close(); }
