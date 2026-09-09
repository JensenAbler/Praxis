/** Protected read-only signer: its separate key cannot authorize publication. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importJWK, SignJWT } from 'jose';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8')), expected = process.argv[3];
const key = await importJWK(config.jwk, 'RS256');
const token = await new SignJWT({ scope: 'praxis:health', client_id: 'praxis-health' })
  .setProtectedHeader({ alg: 'RS256', kid: config.jwk.kid, typ: 'at+jwt' }).setIssuer(config.issuer).setAudience(config.resourceUrl)
  .setSubject('jensen').setIssuedAt().setExpirationTime('30s').sign(key);
const client = new Client({ name: 'praxis-independent-health', version: '1' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(config.resourceUrl), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const listed = await client.listTools();
  assert.ok(listed.tools.some(tool => tool.name === 'praxis_release_status'), 'Independent recovery tools missing');
  const call = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); assert.equal(result.structuredContent?.ok, true, name); return result.structuredContent; };
  const capabilities = await call('capabilities'); assert.equal(capabilities.release, expected);
  await call('projects_list');
  await call('file_read', { projectId: 'praxis', path: 'README.md' });
  const jobs = await call('jobs_list');
  if (jobs.jobs?.[0]) await call('job_status', { jobId: jobs.jobs[0].id });
  const rejected = await fetch(config.resourceUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer invalid' }, body: '{}' });
  assert.equal(rejected.status, 401);
  console.log(JSON.stringify({ ok: true, release: expected, authenticatedMcpPassed: true, recoveryToolsPresent: true, sourceRead: true, jobStatusRead: Boolean(jobs.jobs?.[0]), invalidAuthorizationRejected: true }));
} catch { process.exitCode = 1; }
finally { await client.close(); }
