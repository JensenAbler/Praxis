import express from 'express';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { requireBearerAuth, hostHeaderValidation, originValidation } from '@modelcontextprotocol/express';
import { createAuth } from './auth.js';
import { JobStore } from './jobs.js';
import { AuditStore } from './audit.js';
import { createProbeServer, VERSION } from './mcp.js';
import { createCodingClient } from './code/client.js';

export async function createApp(config) {
  const base = new URL(config.baseUrl);
  const prefix = base.pathname.replace(/\/$/, '');
  const resourceUrl = `${base.origin}${prefix}/mcp`;
  const issuer = `${base.origin}${prefix}/oauth`;
  const resourceMetadata = `${base.origin}/.well-known/oauth-protected-resource${prefix}/mcp`;
  const bootId = randomUUID();
  const release = config.release || 'development';
  mkdirSync(config.dataDirectory, { recursive: true, mode: 0o700 });
  const jobs = new JobStore(config.dataDirectory);
  const audit = new AuditStore(config.dataDirectory);
  const coding = config.coding ? createCodingClient(config.coding) : undefined;
  const auth = await createAuth({ issuer, resourceUrl, ...config.auth, dataDirectory: join(config.dataDirectory, 'oauth'), allowLoopback: config.allowLoopback ?? false, codingEnabled: !!coding });
  const app = express();
  app.disable('x-powered-by');
  // Only loopback nginx may supply proxy headers in production.
  app.set('trust proxy', 'loopback');
  app.use(hostHeaderValidation([base.hostname, ...(config.allowLoopback ? ['localhost', '127.0.0.1'] : [])]));
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get(`${prefix}/healthz`, (_req, res) => res.json({ ok: true, name: coding ? 'Praxis' : 'Praxis Probe', version: coding ? '0.2.0' : VERSION, release, bootId }));
  app.get(`${prefix}/`, (_req, res) => res.type('text').send(coding ? 'Praxis: authenticated source, isolated coding, and durable jobs. Connect using the /mcp endpoint.' : 'Praxis Probe: an authenticated diagnostic MCP fixture. Connect using the /mcp endpoint.'));
  app.get(`/.well-known/oauth-protected-resource${prefix}/mcp`, (_req, res) => res.json({
    resource: resourceUrl, authorization_servers: [issuer], scopes_supported: ['praxis:probe', ...(coding ? ['praxis:code'] : []), 'offline_access'], resource_name: coding ? 'Praxis' : 'Praxis Probe',
    bearer_methods_supported: ['header']
  }));
  // Path-qualified discovery preserves the existing Apocrypha root metadata.
  app.get([`/.well-known/oauth-authorization-server${prefix}/oauth`, `/.well-known/openid-configuration${prefix}/oauth`], (req, res) => {
    req.url = '/.well-known/openid-configuration';
    req.baseUrl = `${prefix}/oauth`;
    req.originalUrl = `${prefix}/oauth/.well-known/openid-configuration`;
    return auth.provider.callback()(req, res);
  });
  app.use(`${prefix}/oauth`, auth.router);
  const handler = createMcpHandler(ctx => createProbeServer({ jobs, audit, resourceUrl, bootId, release, authInfo: ctx.authInfo, era: ctx.era, coding }), {
    legacy: 'stateless', onerror: () => console.error(JSON.stringify({ event: 'mcp_protocol_error' }))
  });
  app.use(`${prefix}/mcp`, originValidation([base.hostname, 'chatgpt.com', 'chat.openai.com', 'claude.ai', ...(config.allowLoopback ? ['localhost', '127.0.0.1'] : [])]));
  app.use(`${prefix}/mcp`, requireBearerAuth({ verifier: { verifyAccessToken: auth.verifyAccessToken }, requiredScopes: coding ? [] : ['praxis:probe'], resourceMetadataUrl: resourceMetadata }));
  app.use(`${prefix}/mcp`, express.json({ limit: coding ? '512kb' : '64kb' }));
  app.all(`${prefix}/mcp`, async (req, res, next) => {
    const requestId = randomUUID();
    const started = performance.now();
    let logged = false;
    const record = (aborted) => {
      if (logged) return;
      logged = true;
      audit.record(req.auth.extra.subject, { requestId, kind: 'http', method: req.method, status: res.statusCode, aborted,
        protocol: String(req.get('mcp-protocol-version') || 'unspecified').slice(0, 40), durationMs: Math.round(performance.now() - started) });
    };
    res.once('finish', () => record(false));
    res.once('close', () => record(!res.writableFinished));
    try { await toNodeHandler(handler)(req, res, req.body); } catch (error) { next(error); }
  });
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return res.end();
    res.status(error.type === 'entity.too.large' ? 413 : error instanceof SyntaxError ? 400 : 500)
      .json({ error: error.type === 'entity.too.large' ? 'request_too_large' : error instanceof SyntaxError ? 'invalid_json' : 'internal_error' });
  });
  return { app, jobs, audit, auth, resourceUrl, close: async () => { await handler.close(); auth.close?.(); jobs.close(); audit.close(); } };
}

export function configFromEnvironment() {
  const credentialDirectory = process.env.CREDENTIALS_DIRECTORY || process.env.PRAXIS_CREDENTIALS_DIR;
  if (!credentialDirectory) throw new Error('Protected credential directory is required');
  const read = name => readFileSync(join(credentialDirectory, name), 'utf8').trim();
  return {
    baseUrl: process.env.PRAXIS_BASE_URL || 'https://mcp.jensenabler.com/praxis-probe',
    dataDirectory: process.env.PRAXIS_DATA_DIR || '/var/lib/praxis-probe',
    release: process.env.PRAXIS_RELEASE || VERSION,
    ...(process.env.PRAXIS_CODING_URL ? { coding: { url: process.env.PRAXIS_CODING_URL } } : {}),
    auth: { passwordHash: read('password-hash'), jwks: JSON.parse(read('jwks.json')), cookieKeys: JSON.parse(read('cookie-keys.json')) }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const service = await createApp(configFromEnvironment());
  const http = service.app.listen(Number(process.env.PORT || 8790), '127.0.0.1', () => console.log(JSON.stringify({ event: 'listening', version: VERSION })));
  const shutdown = () => { http.close(async () => { await service.close(); process.exit(0); }); setTimeout(() => process.exit(1), 10000).unref(); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
