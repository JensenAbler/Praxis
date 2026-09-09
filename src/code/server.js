import express from 'express';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createTokenVerifier } from '../token-verifier.js';
import { CodeStore } from './store.js';
import { WorkspaceManager, LIMITS as WORKSPACE_LIMITS } from './workspaces.js';
import { CodeJobs, CODE_JOB_LIMITS } from './jobs.js';
import { PodmanRunner } from './runner.js';
import { parseCodeCall } from './schema.js';

export async function createCodingService(config) {
  for (const path of [config.dataDirectory, config.workspaceDirectory]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const store = new CodeStore(config.dataDirectory);
  const runner = config.runner || new PodmanRunner(config.runnerConfig);
  const jobs = new CodeJobs({ store, dataDirectory: config.dataDirectory, runner });
  const workspaces = new WorkspaceManager({ store, dataDirectory: config.dataDirectory, workspaceDirectory: config.workspaceDirectory, projects: config.projects });
  jobs.workspaces = workspaces;
  await jobs.recover();
  const verify = createTokenVerifier({ issuer: config.issuer, resourceUrl: config.resourceUrl, jwks: config.publicJwks,
    allowedScopes: ['praxis:probe', 'praxis:code'], requiredScope: 'praxis:code' });
  const bootId = randomUUID();
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/healthz', (_req, res) => res.json({ ok: true, release: config.release, bootId }));
  app.post('/call', async (req, res, next) => {
    const match = /^Bearer ([^\s]+)$/.exec(req.get('authorization') || '');
    try { req.principal = await verify(match?.[1] || ''); return next(); }
    catch { return res.status(401).json({ ok: false, error: { code: 'AUTHORIZATION_REQUIRED', message: 'An owner access token with praxis:code permission is required.' } }); }
  }, express.json({ limit: '512kb' }), async (req, res) => {
    try {
      if (!req.body || Object.keys(req.body).some(key => !['action', 'args'].includes(key))) throw Object.assign(new Error('Expected action and args'), { code: 'INVALID_ARGUMENT' });
      const { tool, args } = parseCodeCall(req.body.action, req.body.args);
      const owner = req.principal.extra.subject;
      const data = req.body.action === 'capabilities' ? {
        name: 'Praxis', apiVersion: '0.2.0', schemaVersion: 2, release: config.release, bootId,
        scope: 'Registered immutable source snapshots and isolated coding workspaces. ChatGPT or Claude supplies reasoning.',
        workflow: ['projects_list', 'project_inspect', 'workspace_create', 'file_read/code_search', 'workspace_apply', 'job_start', 'job_status/job_logs', 'workspace_diff'],
        recovery: 'Use workspaces_list, jobs_list, and operations_list in a fresh conversation. Keep the same idempotency key and inputs after uncertain responses. A terminal or ambiguous command is never automatically rerun.',
        execution: { network: 'none', runtime: config.runtimeDescription || 'Fixed container image', imageDigest: config.runnerConfig?.image,
          maxTimeoutSeconds: 900, maxActiveJobs: 1, cpuCores: 1, aggregateMemoryMiB: 1536, maxProcesses: 256,
          storage: 'Workspaces and container storage share an 8 GiB dedicated filesystem; writable root is disabled.' },
        authorization: { requiredScope: 'praxis:code', identity: 'jensen', productionAccess: false },
        limits: { jobs: CODE_JOB_LIMITS, workspaces: WORKSPACE_LIMITS, requestBytes: 524288, fileReadLines: 200,
          argumentCharacters: 8192, commandArgumentBytes: 32768, environmentValueCharacters: 1000,
          environmentKeys: ['CI', 'NODE_ENV', 'TZ', 'LANG', 'LC_ALL', 'FORCE_COLOR', 'NO_COLOR', 'PYTHONHASHSEED', 'PYTHONDONTWRITEBYTECODE'] },
        disabled: [
          { operation: 'network access and dependency downloads', reason: 'Network-denial baseline is the first deployed execution policy. Runtime dependencies must already be available.' },
          { operation: 'GitHub publication, deployment, maintenance, self-update, and browser operation', reason: 'Later milestones; these tools are not exposed.' }
        ]
      } : await (tool.target === 'jobs' ? jobs : workspaces)[tool.method]({ ...args, owner });
      res.json({ ok: true, data });
    } catch (error) {
      const code = /^[A-Z_]+$/.test(error.code || '') ? error.code : 'INTERNAL_ERROR';
      res.status(code === 'INTERNAL_ERROR' ? 500 : 400).json({ ok: false, error: { code,
        message: code === 'INTERNAL_ERROR' ? 'The coding service could not finish this operation. Inspect persisted receipts before retrying.' : error.message } });
    }
  });
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((error, _req, res, _next) => res.status(error.type === 'entity.too.large' ? 413 : 400).json({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Malformed or oversized coding request' } }));
  let stopped = false;
  let pending;
  const timer = setInterval(() => {
    if (stopped || pending) return;
    pending = Promise.resolve().then(() => jobs.tick()).catch(() => console.error(JSON.stringify({ event: 'coding_tick_failed' }))).finally(() => { pending = undefined; });
  }, config.pollIntervalMs || 500);
  timer.unref();
  return { app, jobs, workspaces, store, async close() { stopped = true; clearInterval(timer); await pending; store.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const configPath = process.env.PRAXIS_CODING_CONFIG;
  if (!configPath) throw new Error('Protected coding configuration is required');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const service = await createCodingService(config);
  const http = service.app.listen(config.port || 8792, '127.0.0.1', () => console.log(JSON.stringify({ event: 'coding_listening', release: config.release })));
  const shutdown = () => { http.close(async () => { await service.close(); process.exit(0); }); setTimeout(() => process.exit(1), 10000).unref(); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
