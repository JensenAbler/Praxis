import { randomUUID, createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { codeTools } from './code/schema.js';

export const VERSION = '0.1.0';
const SCOPE = 'praxis:probe';
const jobId = z.string().uuid();
const cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0);
const pageLimit = z.number().int().min(1).max(100).default(20);

export function createProbeServer({ jobs, audit, resourceUrl, bootId, release, authInfo, era, coding }) {
  const owner = authInfo?.extra?.subject;
  if (owner !== 'jensen') throw new Error('Authenticated owner required');
  const server = new McpServer({ name: 'Praxis', version: coding ? '0.2.0' : VERSION }, {
    instructions: coding
      ? 'Praxis supplies coding tools; you supply reasoning. Start with capabilities and projects_list. Inspect a project, create one workspace at its exact base revision, read/search, edit with content hashes, run validation using job_start, and review workspace_diff. General commands are sandboxed with network disabled. Use existing workspace/job/operation IDs to recover work in a fresh conversation. NEVER recreate an ambiguously completed operation; repeat its original idempotency key and inputs or inspect receipts. Probe tools are separate bounded diagnostics. No production, GitHub publication, or self-update tools are available in this milestone.'
      : 'This is an isolated diagnostic fixture. Call probe_capabilities first. Start only a bounded heartbeat job using a unique idempotencyKey, save its job ID, and inspect it through probe_job_status/logs. In a fresh conversation, probe_jobs_list recovers existing jobs. These tools provide no source access, arbitrary commands, production access, or model execution. Never recreate a job merely because a response was lost; repeat the same idempotency key or list existing jobs. Results describe only this fixture.'
  });
  const register = (name, title, description, inputSchema, handler, readOnly = true, destructive = false, scope = SCOPE) => {
    server.registerTool(name, {
      title, description, inputSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: true, openWorldHint: false },
      _meta: { securitySchemes: [{ type: 'oauth2', scopes: [scope] }] }
    }, async (args) => {
      const requestId = randomUUID();
      const started = performance.now();
      let result;
      try {
        if (!authInfo.scopes?.includes(scope)) throw Object.assign(new Error(`Reconnect and grant ${scope} to use this tool.`), { code: 'AUTHORIZATION_REQUIRED' });
        const data = await handler(args);
        result = { ok: true, requestId, observedAt: new Date().toISOString(), ...data };
      } catch (error) {
        const code = /^[A-Z_]+$/.test(error.code ?? '') ? error.code : 'INTERNAL_ERROR';
        result = { ok: false, requestId, observedAt: new Date().toISOString(), error: {
          code, message: code === 'INTERNAL_ERROR' ? 'Praxis could not complete this operation.' : error.message,
          recovery: code === 'FIXTURE_ERROR' ? 'Continue by calling probe_capabilities; this intentional error will not succeed on retry.' : code === 'IDEMPOTENCY_CONFLICT' ? 'Use the original inputs with that key, or a new key for a new operation.' : 'Inspect existing jobs and the supplied identifiers before retrying; do not recreate ambiguous work.'
        } };
      }
      const text = JSON.stringify(result);
      audit.record(owner, { requestId, kind: 'tool', tool: name, era, durationMs: Math.round((performance.now() - started) * 1000) / 1000,
        resultJsonBytes: Buffer.byteLength(text), ok: result.ok, errorCode: result.error?.code ?? null });
      return { content: [{ type: 'text', text }], structuredContent: result, ...(result.ok ? {} : { isError: true }),
        ...(result.error?.code === 'AUTHORIZATION_REQUIRED' ? { _meta: { 'mcp/www_authenticate': [`Bearer scope="${scope}", error="insufficient_scope"`] } } : {}) };
    });
  };
  register('probe_capabilities', 'Inspect Praxis diagnostics', 'Read the exact probe version, limits, scope, and available experiments. Start here.', z.object({}), () => ({
    version: VERSION, schemaVersion: 1, release, bootId, resourceUrl,
    scope: 'Isolated heartbeat fixtures and synthetic response measurements only.',
    limits: { maxDurationSeconds: 180, maxActiveJobs: 1, logPageRecords: 100, maxSyntheticPayloadBytes: 65536 },
    persistence: 'Jobs and logs are stored on the VPS. A separate worker survives MCP app restarts. Worker interruption is reported, not blindly retried. Host-loss recovery and backups are not demonstrated by this probe.',
    nextSteps: ['probe_job_start', 'probe_job_status', 'probe_job_logs', 'probe_jobs_list'],
    excluded: ['source editing', 'arbitrary execution', 'production operations', 'browser operation', 'model reasoning']
  }));
  register('probe_job_start', 'Start a bounded probe job', 'Create one durable heartbeat fixture (1–180 seconds). It returns a job ID promptly. Reuse exactly the same idempotency key and inputs after an uncertain response.', z.object({
    idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/), label: z.string().max(80).default(''),
    durationSeconds: z.number().int().min(1).max(180).default(120),
    intervalSeconds: z.number().int().min(1).max(10).default(5)
  }), args => ({ job: jobs.start({ owner, ...args }) }), false);
  register('probe_jobs_list', 'Recover existing probe jobs', 'List your persisted probe jobs, newest first. Use this to recover work in a fresh conversation. Cursor 0 begins the list.', z.object({ cursor, limit: z.number().int().min(1).max(50).default(20) }), args => jobs.list({ owner, ...args }));
  register('probe_job_status', 'Inspect a probe job', 'Read the existing job status and timestamps. Does not restart the job.', z.object({ jobId }), args => ({ job: jobs.get({ owner, ...args }) }));
  register('probe_job_logs', 'Read probe job evidence', 'Read bounded ordered job records. Cursor is the last record sequence already read; use returned nextCursor to continue.', z.object({ jobId, cursor, limit: pageLimit }), args => jobs.logs({ owner, ...args }));
  register('probe_job_cancel', 'Cancel a probe job', 'Request cancellation of an existing fixture. The separate worker records the outcome; completed jobs are unchanged.', z.object({ jobId }), args => ({ job: jobs.cancel({ owner, ...args }) }), false, true);
  register('probe_response', 'Measure a synthetic tool result', 'Return bounded synthetic text with payload byte count, SHA-256, and an end marker to observe client truncation. Byte counts exclude the MCP envelope and duplicated structured content. Begin small; this does not find a universal platform limit.', z.object({
    bytes: z.number().int().min(0).max(65536).default(1024), marker: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).default('praxis-probe'),
    delayMs: z.number().int().min(0).max(5000).default(0)
  }), async ({ bytes, marker, delayMs }) => {
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    const payload = '0123456789abcdef'.repeat(Math.ceil(bytes / 16)).slice(0, bytes);
    return { payloadBytes: Buffer.byteLength(payload), sha256: createHash('sha256').update(payload).digest('hex'), payload, endMarker: marker, requestedDelayMs: delayMs };
  });
  register('probe_failure', 'Inspect a controlled error', 'Return an intentional FIXTURE_ERROR with a recovery instruction. It makes no job or external changes.', z.object({}), () => {
    throw Object.assign(new Error('Intentional fixture error. Continue by calling probe_capabilities; do not retry this tool to make it succeed.'), { code: 'FIXTURE_ERROR' });
  });
  register('probe_observations', 'Read server observation receipts', 'Read sanitized server-side tool/HTTP observations in sequence. Includes measured result sizes and durations, never tokens or request bodies.', z.object({ cursor, limit: pageLimit }), ({ cursor, limit }) => audit.list(owner, cursor, limit));
  if (coding) for (const [name, tool] of Object.entries(codeTools)) {
    register(name, tool.title, tool.description, tool.schema, args => coding.call(name, args, authInfo.token), !tool.write, !!tool.destructive, 'praxis:code');
  }
  return server;
}
