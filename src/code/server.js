import express from 'express';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createTokenVerifier, createHealthVerifier } from '../token-verifier.js';
import { CodeStore } from './store.js';
import { WorkspaceManager, WorkspaceError, LIMITS as WORKSPACE_LIMITS } from './workspaces.js';
import { CodeJobs, CodeJobError, CODE_JOB_LIMITS } from './jobs.js';
import { PodmanRunner, RunnerError } from './runner.js';
import { DEPENDENCY_LIMITS } from './dependencies.js';
import { codeTools, parseCodeCall } from './schema.js';
import { CodeGit } from './git.js';
import { createGitClient } from './git-client.js';
import { correlationId, diagnosticRecord, errorRecovery, requestContext } from '../diagnostics.js';

export async function createCodingService(config) {
  for (const path of [config.dataDirectory, config.workspaceDirectory]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const store = new CodeStore(config.dataDirectory);
  const runner = config.runner || new PodmanRunner(config.runnerConfig);
  const jobs = new CodeJobs({ store, dataDirectory: config.dataDirectory, runner, dependencyDirectory: config.dependencyDirectory });
  const workspaces = new WorkspaceManager({ store, dataDirectory: config.dataDirectory, workspaceDirectory: config.workspaceDirectory, projects: config.projects });
  jobs.workspaces = workspaces;
  const git = config.git ? new CodeGit({ store, workspaces, ...config.git, broker: config.git.broker || createGitClient(config.git) }) : null;
  // Staging is additionally isolated by a different OS identity, private
  // network, disposable state and inaccessible live paths. This switch only
  // avoids changing the compatible copy while the external checker reads it.
  if (!config.staging) await jobs.recover();
  const verify = createTokenVerifier({ issuer: config.issuer, resourceUrl: config.resourceUrl, jwks: config.publicJwks,
    allowedScopes: ['praxis:probe', 'praxis:code'], requiredScope: 'praxis:code' });
  const verifyHealth = config.healthPublicJwks ? createHealthVerifier({ issuer: config.issuer, resourceUrl: config.resourceUrl, jwks: config.healthPublicJwks }) : null;
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
    try {
      try { req.principal = await verify(match?.[1] || ''); }
      catch (error) { if (!verifyHealth) throw error; req.principal = await verifyHealth(match?.[1] || ''); }
      return next();
    }
    catch { return res.status(401).json({ ok: false, requestId: requestContext.getStore().requestId, error: { code: 'AUTHORIZATION_REQUIRED', message: 'An owner access token with praxis:code permission is required.', ...errorRecovery('AUTHORIZATION_REQUIRED') } }); }
  }, express.json({ limit: '512kb' }), async (req, res) => {
    try {
      if (!req.body || Object.keys(req.body).some(key => !['action', 'args'].includes(key))) throw Object.assign(new Error('Expected action and args'), { code: 'INVALID_ARGUMENT' });
      const { tool, args } = parseCodeCall(req.body.action, req.body.args);
      if (req.principal.scopes.includes('praxis:health') && (tool.write || !['capabilities', 'projects_list', 'project_inspect', 'file_read', 'jobs_list', 'job_status'].includes(req.body.action))) {
        throw new WorkspaceError('AUTHORIZATION_REQUIRED', 'The independent health grant allows only its fixed diagnostic reads.');
      }
      if (tool.write && config.generationFencePath) {
        const fence = JSON.parse(readFileSync(config.generationFencePath, 'utf8'));
        if (fence.state !== 'active') throw new WorkspaceError('UPDATE_IN_PROGRESS', 'Application activation is draining mutations. Existing work remains recoverable.');
      }
      requestContext.getStore().action = req.body.action;
      const owner = req.principal.extra.subject;
      requestContext.getStore().token = req.principal.token;
      const data = req.body.action === 'capabilities' ? {
        name: 'Praxis', apiVersion: '0.5.0', schemaVersion: 5, release: config.release, bootId,
        scope: 'Registered immutable source snapshots and isolated coding workspaces. ChatGPT or Claude supplies reasoning.',
        workflow: ['projects_list', 'project_inspect', 'workspace_create', 'file_read/code_search', 'workspace_apply', 'job_start', 'job_status/job_logs', 'workspace_diff'],
        recovery: 'Use workspaces_list, jobs_list, and operations_list in a fresh conversation. Keep the same idempotency key and inputs after uncertain responses. A terminal or ambiguous command is never automatically rerun.',
        usage: {
          pagination: 'Omit optional page sizes initially. Copy nextCursor exactly; cursors are opaque and may not equal the number of returned rows. Diff maxBytes is a byte budget, while list/log limits count records.',
          edits: 'Use exact-text patches for large files. Multiple patches to a file run in order with the original file hash; a rejected batch does not partially apply.',
          jobRecovery: 'Read job_status first for actual exit status, recent output, and retention facts. Use job_logs view=tail for recent output or query/stream for targeted retained records; complete log scans are optional.',
          diagnostics: 'Errors include a requestId and retry strategy. Preserve the requestId for diagnosis. A retry strategy never authorizes recreating ambiguous work.'
        },
        execution: { network: 'none by default; optional registries policy when dependencies.registryAccessEnabled is true', runtime: config.runtimeDescription || 'Fixed container image', imageDigest: config.runnerConfig?.image,
          maxTimeoutSeconds: 900, maxActiveJobs: 1, cpuCores: 1, aggregateMemoryMiB: 1536, maxProcesses: 256,
          storage: 'Workspaces and container storage share an 8 GiB dedicated filesystem; writable root is disabled.' },
        dependencies: { registryAccessEnabled: Boolean(runner.registryAccessEnabled), preparationEnabled: Boolean(config.dependencyDirectory),
          registries: ['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org'],
          workflow: 'Use job_start network=registries for npm install/update/ci or pip in a workspace venv. Run checks, then dependency_prepare for npm deployment bundles. Read job_status for preparedDependenciesId. Installs persist in ignored node_modules/.venv; source manifests remain revision checked.',
          isolation: 'The container stays networkless. A restricted Unix-socket proxy allows public registry HTTPS only; package scripts receive no host credentials or administration rights.',
          limits: DEPENDENCY_LIMITS,
          unsupported: 'Private registries, Git dependencies, and package scripts downloading from other hosts are unavailable. Deployable bundles currently cover root npm node_modules on compatible Linux/Node runtimes; Python environments are development only.' },
        authorization: { requiredScope: 'praxis:code', identity: 'jensen', productionAccess: !!git },
        publication: git ? { defaultBranch: 'main', projects: config.git.projectIds || ['discord'],
          newProjects: { templates: ['node', 'python', 'static'], defaultVisibility: 'private',
            workflow: ['project_create', 'git_operation_status', 'workspace_create', 'edit/check/review', 'git_commit', 'git_operation_status', 'project_publish', 'git_operation_status'],
            authorization: 'Local creation needs only the configured project broker. GitHub repository creation additionally requires a protected provisioning credential; GITHUB_SETUP_REQUIRED means local coding is still available.' },
          workflow: ['project_sync', 'git_operation_status', 'workspace_create', 'edit/check/review', 'git_commit', 'git_operation_status', 'git_push', 'git_operation_status', 'deployment_status', 'deployment_fast_forward', 'git_operation_status'],
          recovery: 'Each write returns a durable operationId. Poll git_operation_status until terminal. Commit captures the exact idle workspace revision; push publishes that commit with an expected remote-head precondition. Remote conflicts require source reconciliation. Recover uncertain operations; do not recreate them.',
          deployment: 'Podcast-discord supports exact-main fast-forward, matched npm dependency bundles, operational diagnosis, recorded restart and rollback. Owner-created projects deploy as stateless Node/Python/static HTTP services on a separate origin, with at most five apps and bounded resources. Production observations distinguish process health, recorded login and live provider behavior.' } : { enabled: false },
        selfImprovement: { enabled: Boolean(config.selfUpdateEnabled),
          workflow: ['project_sync(praxis)', 'edit/check/review', 'git_commit/git_push', 'project_sync(praxis)', 'praxis_release_plan', 'praxis_release_status', 'praxis_release_apply'],
          boundary: 'Only the coding application and data-only tool manifest change. Installed gateway, authentication, Git/deployment adapters, updater and privileged policies require the independent owner path.',
          recovery: 'Protected release tools remain reachable when the coding backend fails. Exact-input retry of a restoration_failed activation explicitly resumes its recorded restoration. No database restore or blind job restart.' },
        limits: { jobs: CODE_JOB_LIMITS, workspaces: WORKSPACE_LIMITS, requestBytes: 524288, fileReadLines: 200,
          argumentCharacters: 8192, commandArgumentBytes: 32768, environmentValueCharacters: 1000,
          environmentKeys: ['CI', 'NODE_ENV', 'TZ', 'LANG', 'LC_ALL', 'FORCE_COLOR', 'NO_COLOR', 'PYTHONHASHSEED', 'PYTHONDONTWRITEBYTECODE'] },
        disabled: [
          { operation: 'unrestricted network access and private package registries', reason: 'Development egress is limited to configured public package registry hosts.' },
          { operation: 'Unregistered production services, arbitrary host administration and browser operation', reason: 'Only configured adapters and typed actions are exposed.' },
          { operation: 'Persistent storage and third-party Python dependencies in new deployed apps', reason: 'The first new-project deployment adapter is stateless; Python package installation is available in development workspaces.' }
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
  const timer = config.staging ? null : setInterval(() => {
    if (stopped || pending) return;
    pending = Promise.resolve().then(() => jobs.tick()).catch(error => console.error(JSON.stringify(diagnosticRecord('coding_tick_failed', error)))).finally(() => { pending = undefined; });
  }, config.pollIntervalMs || 500);
  timer?.unref();
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
