import express from 'express';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createTokenVerifier } from '../token-verifier.js';
import { CodeStore } from './store.js';
import { WorkspaceManager, WorkspaceError, LIMITS as WORKSPACE_LIMITS } from './workspaces.js';
import { CodeJobs, CodeJobError, CODE_JOB_LIMITS } from './jobs.js';
import { PodmanRunner, RunnerError } from './runner.js';
import { codeTools, parseCodeCall } from './schema.js';
import { CodeGit } from './git.js';
import { createGitClient } from './git-client.js';
import { correlationId, diagnosticRecord, errorRecovery, requestContext } from '../diagnostics.js';

export async function createCodingService(config) {
  for (const path of [config.dataDirectory, config.workspaceDirectory]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const store = new CodeStore(config.dataDirectory);
  const runner = config.runner || new PodmanRunner(config.runnerConfig);
  const jobs = new CodeJobs({ store, dataDirectory: config.dataDirectory, runner });
  const workspaces = new WorkspaceManager({ store, dataDirectory: config.dataDirectory, workspaceDirectory: config.workspaceDirectory, projects: config.projects });
  jobs.workspaces = workspaces;
  const git = config.git ? new CodeGit({ store, workspaces, ...config.git, broker: config.git.broker || createGitClient(config.git) }) : null;
  await jobs.recover();
  const verify = createTokenVerifier({ issuer: config.issuer, resourceUrl: config.resourceUrl, jwks: config.publicJwks,
    allowedScopes: ['praxis:probe', 'praxis:code'], requiredScope: 'praxis:code' });
  const bootId = randomUUID();
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/call', (req, res, next) => {
    const requestId = correlationId(req.get('x-praxis-request-id'));
    res.set('X-Praxis-Request-Id', requestId);
    requestContext.run({ requestId }, next);
  });
  app.get('/healthz', (_req, res) => res.json({ ok: true, release: config.release, bootId }));
  app.post('/call', async (req, res, next) => {
    const match = /^Bearer ([^\s]+)$/.exec(req.get('authorization') || '');
    try { req.principal = await verify(match?.[1] || ''); return next(); }
    catch { return res.status(401).json({ ok: false, requestId: requestContext.getStore().requestId, error: { code: 'AUTHORIZATION_REQUIRED', message: 'An owner access token with praxis:code permission is required.', ...errorRecovery('AUTHORIZATION_REQUIRED') } }); }
  }, express.json({ limit: '512kb' }), async (req, res) => {
    try {
      if (!req.body || Object.keys(req.body).some(key => !['action', 'args'].includes(key))) throw Object.assign(new Error('Expected action and args'), { code: 'INVALID_ARGUMENT' });
      const { tool, args } = parseCodeCall(req.body.action, req.body.args);
      requestContext.getStore().action = req.body.action;
      const owner = req.principal.extra.subject;
      requestContext.getStore().token = req.principal.token;
      const data = req.body.action === 'capabilities' ? {
        name: 'Praxis', apiVersion: '0.4.0', schemaVersion: 4, release: config.release, bootId,
        scope: 'Registered immutable source snapshots and isolated coding workspaces. ChatGPT or Claude supplies reasoning.',
        workflow: ['projects_list', 'project_inspect', 'workspace_create', 'file_read/code_search', 'workspace_apply', 'job_start', 'job_status/job_logs', 'workspace_diff'],
        recovery: 'Use workspaces_list, jobs_list, and operations_list in a fresh conversation. Keep the same idempotency key and inputs after uncertain responses. A terminal or ambiguous command is never automatically rerun.',
        usage: {
          pagination: 'Omit optional page sizes initially. Copy nextCursor exactly; cursors are opaque and may not equal the number of returned rows. Diff maxBytes is a byte budget, while list/log limits count records.',
          edits: 'Use exact-text patches for large files. Multiple patches to a file run in order with the original file hash; a rejected batch does not partially apply.',
          jobRecovery: 'Read job_status first for actual exit status, recent output, and retention facts. Use job_logs view=tail for recent output or query/stream for targeted retained records; complete log scans are optional.',
          diagnostics: 'Errors include a requestId and retry strategy. Preserve the requestId for diagnosis. A retry strategy never authorizes recreating ambiguous work.'
        },
        execution: { network: 'none', runtime: config.runtimeDescription || 'Fixed container image', imageDigest: config.runnerConfig?.image,
          maxTimeoutSeconds: 900, maxActiveJobs: 1, cpuCores: 1, aggregateMemoryMiB: 1536, maxProcesses: 256,
          storage: 'Workspaces and container storage share an 8 GiB dedicated filesystem; writable root is disabled.' },
        authorization: { requiredScope: 'praxis:code', identity: 'jensen', productionAccess: !!git },
        publication: git ? { defaultBranch: 'main', projects: config.git.projectIds || ['discord'],
          workflow: ['project_sync', 'git_operation_status', 'workspace_create', 'edit/check/review', 'git_commit', 'git_operation_status', 'git_push', 'git_operation_status', 'deployment_status', 'deployment_fast_forward', 'git_operation_status'],
          recovery: 'Each write returns a durable operationId. Poll git_operation_status until terminal. Commit captures the exact idle workspace revision; push publishes that commit with an expected remote-head precondition. Remote conflicts require source reconciliation. Recover uncertain operations; do not recreate them.',
          deployment: 'Only the registered podcast-discord checkout and managed service. Fast-forward to the published main tip with expectedHead from deployment_status. Dependency changes are not supported yet. Health verifies process activation, not Discord or live-provider behavior.' } : { enabled: false },
        limits: { jobs: CODE_JOB_LIMITS, workspaces: WORKSPACE_LIMITS, requestBytes: 524288, fileReadLines: 200,
          argumentCharacters: 8192, commandArgumentBytes: 32768, environmentValueCharacters: 1000,
          environmentKeys: ['CI', 'NODE_ENV', 'TZ', 'LANG', 'LC_ALL', 'FORCE_COLOR', 'NO_COLOR', 'PYTHONHASHSEED', 'PYTHONDONTWRITEBYTECODE'] },
        disabled: [
          { operation: 'network access and dependency downloads', reason: 'Network-denial baseline is the first deployed execution policy. Runtime dependencies must already be available.' },
          { operation: 'Other repositories, general production administration, self-update, and browser operation', reason: 'Outside this release. Publication and fixed podcast deployment require configured trusted services.' }
        ]
      } : await (() => {
        if (tool.target === 'git' && !git) throw new WorkspaceError('PUBLICATION_DISABLED', 'Publishing is not configured on this service.');
        return (tool.target === 'git' ? git : tool.target === 'jobs' ? jobs : workspaces)[tool.method]({ ...args, owner });
      })();
      res.json({ ok: true, requestId: requestContext.getStore().requestId, data });
    } catch (error) {
      const safe = error instanceof WorkspaceError || error instanceof CodeJobError || error instanceof RunnerError ||
        ['INVALID_ARGUMENT', 'UNKNOWN_ACTION'].includes(error.code);
      const code = safe ? error.code : error.code === 'ENOENT' ? 'NOT_FOUND' : error.code === 'ENOSPC' ? 'STORAGE_FULL' : 'INTERNAL_ERROR';
      const context = requestContext.getStore();
      const knownTool = typeof req.body?.action === 'string' && Object.hasOwn(codeTools, req.body.action) ? codeTools[req.body.action] : undefined;
      if (!safe) console.error(JSON.stringify(diagnosticRecord('coding_request_failed', error, context)));
      res.status(code === 'INTERNAL_ERROR' ? 500 : 400).json({ ok: false, requestId: context.requestId, error: { code,
        message: safe ? error.message : code === 'NOT_FOUND' ? 'The requested source path no longer exists.' : code === 'STORAGE_FULL' ? 'Coding storage is full. Recover receipts and remove an eligible disposable workspace.' : 'The coding service could not finish this operation.',
        ...errorRecovery(code, knownTool && !knownTool.write),
        ...(Array.isArray(error.issues) ? { issues: error.issues.slice(0, 5) } : {}) } });
    }
  });
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((error, _req, res, _next) => res.status(error.type === 'entity.too.large' ? 413 : 400).json({ ok: false, requestId: requestContext.getStore()?.requestId,
    error: { code: 'INVALID_ARGUMENT', message: 'Malformed or oversized coding request', ...errorRecovery('INVALID_ARGUMENT') } }));
  let stopped = false;
  let pending;
  const timer = setInterval(() => {
    if (stopped || pending) return;
    pending = Promise.resolve().then(() => jobs.tick()).catch(error => console.error(JSON.stringify(diagnosticRecord('coding_tick_failed', error)))).finally(() => { pending = undefined; });
  }, config.pollIntervalMs || 500);
  timer.unref();
  return { app, jobs, workspaces, git, store, async close() { stopped = true; clearInterval(timer); await pending; store.close(); } };
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    // systemd launches through current/, while Node normally resolves the module to its immutable release.
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; } // An importing process may supply an argv[1] that is not a file.
}

if (isEntrypoint()) {
  const configPath = process.env.PRAXIS_CODING_CONFIG;
  if (!configPath) throw new Error('Protected coding configuration is required');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const service = await createCodingService(config);
  const http = service.app.listen(config.port ?? 8792, '127.0.0.1', () => console.log(JSON.stringify({ event: 'coding_listening', release: config.release, port: http.address().port })));
  const shutdown = () => { http.close(async () => { await service.close(); process.exit(0); }); setTimeout(() => process.exit(1), 10000).unref(); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
