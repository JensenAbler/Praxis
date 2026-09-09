import express from 'express';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createTokenVerifier } from '../token-verifier.js';
import { diagnosticRecord } from '../diagnostics.js';
import { TrustedGit } from './git.js';
import { GitBroker, BrokerError, brokerSchemas, fixedDeploymentClient } from './broker.js';
import { GitHubProvisioningClient, ProjectError } from './projects.js';

export function createGitService(config) {
  const git = config.git || new TrustedGit(config);
  const broker = new GitBroker({ ...config, git,
    projectProvisioning: config.projectProvisioning ? { ...config.projectProvisioning,
      github: config.projectProvisioning.github || new GitHubProvisioningClient({ account: config.projectProvisioning.account, tokenFile: config.projectProvisioning.tokenFile }) } : undefined,
    deployment: config.deployment || (config.enableDeployment ? fixedDeploymentClient() : undefined),
    releaseControl: config.releaseControl || (config.enableSelfUpdate ? fixedDeploymentClient({ executable: '/usr/local/libexec/praxis-updater' }) : undefined),
    projectDeployment: config.projectDeployment || (config.enableProjectDeployment ? fixedDeploymentClient({ executable: '/usr/local/libexec/praxis-deploy-project' }) : undefined) });
  const verify = createTokenVerifier({ issuer: config.issuer, resourceUrl: config.resourceUrl, jwks: config.publicJwks,
    allowedScopes: ['praxis:code'], requiredScope: 'praxis:code' });
  const app = express(), bootId = randomUUID();
  app.disable('x-powered-by');
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/healthz', (_req, res) => res.json({ ok: true, release: config.release, bootId }));
  app.post('/call', async (req, res, next) => {
    try { req.principal = await verify(/^Bearer ([^\s]+)$/.exec(req.get('authorization') || '')?.[1] || ''); next(); }
    catch { res.status(401).json({ ok: false, error: { code: 'AUTHORIZATION_REQUIRED', message: 'An owner token with praxis:code is required.' } }); }
  }, express.json({ limit: '32kb' }), async (req, res) => {
    try {
      const { action, args } = req.body || {}, schema = Object.hasOwn(brokerSchemas, action || '') && brokerSchemas[action];
      const parsed = schema?.safeParse(args);
      if (!parsed?.success || Object.keys(req.body).some(key => !['action', 'args'].includes(key))) throw new BrokerError('INVALID_ARGUMENT', 'Invalid publishing action or arguments.');
      const input = { ...parsed.data, owner: req.principal.extra.subject };
      const data = action.startsWith('release') ? await broker.release(action, input) : action === 'get' ? await broker.observe(input)
        : ['list', 'deploymentStatus', 'diagnosis', 'deploymentHistory'].includes(action) ? await broker[action](input) : broker.submit(action, input);
      res.json({ ok: true, data });
    } catch (error) {
      const safe = error instanceof BrokerError || error instanceof ProjectError;
      if (!safe) console.error(JSON.stringify(diagnosticRecord('publishing_request_failed', error)));
      res.status(safe ? 400 : 500).json({ ok: false, error: { code: safe ? error.code : 'INTERNAL_ERROR', message: safe ? error.message : 'Publishing could not finish this request. Recover the saved operation.' } });
    }
  });
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((_error, _req, res, _next) => res.status(400).json({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Malformed or oversized publishing request.' } }));
  const timer = setInterval(() => broker.tick().catch(error => console.error(JSON.stringify(diagnosticRecord('publishing_tick_failed', error)))), config.pollIntervalMs || 500);
  timer.unref();
  return { app, broker, async close() { clearInterval(timer); await broker.close(); } };
}

let entry = false;
try { entry = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch {}
if (entry) {
  if (!process.env.PRAXIS_GIT_CONFIG) throw new Error('Protected publishing configuration is required');
  const config = JSON.parse(readFileSync(process.env.PRAXIS_GIT_CONFIG, 'utf8'));
  const service = createGitService(config);
  const http = service.app.listen(config.port || 8793, '127.0.0.1');
  const shutdown = () => http.close(async () => { await service.close(); process.exit(0); });
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
