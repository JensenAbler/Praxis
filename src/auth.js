import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { Provider, errors } from 'oidc-provider';
import { createTokenVerifier } from './token-verifier.js';

const scrypt = promisify(scryptCallback);
const OWNER = 'jensen';
const SCOPE = 'praxis:probe';
const now = () => Math.floor(Date.now() / 1000);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

function readPasswordHash(encoded) {
  const parts = String(encoded).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') throw new Error('Expected scrypt$salt$hash password credential');
  const salt = Buffer.from(parts[1], 'base64url');
  const expected = Buffer.from(parts[2], 'base64url');
  if (salt.length < 16 || expected.length !== 64) throw new Error('Invalid password hash credential');
  return { salt, expected };
}

function createDatabase(dataDirectory) {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDirectory, 'auth.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS records (
      model TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, expires INTEGER,
      grant_id TEXT, uid TEXT, user_code TEXT, PRIMARY KEY(model,id)
    );
    CREATE INDEX IF NOT EXISTS records_grant ON records(grant_id);
    CREATE INDEX IF NOT EXISTS records_uid ON records(model,uid);
    CREATE TABLE IF NOT EXISTS csrf (uid TEXT PRIMARY KEY, hash TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);`);
  return db;
}

function adapterClass(db) {
  const put = db.prepare(`INSERT INTO records(model,id,payload,expires,grant_id,uid,user_code) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(model,id) DO UPDATE SET payload=excluded.payload, expires=excluded.expires,
    grant_id=excluded.grant_id,uid=excluded.uid,user_code=excluded.user_code`);
  const unpack = (row) => row && (row.expires === null || row.expires > now()) ? JSON.parse(row.payload) : undefined;
  return class SqliteAdapter {
    constructor(model) { this.model = model; }
    async upsert(id, payload, expiresIn) {
      put.run(this.model, id, JSON.stringify(payload), expiresIn ? now() + expiresIn : null,
        payload.grantId ?? null, payload.uid ?? null, payload.userCode ?? null);
    }
    async find(id) { return unpack(db.prepare('SELECT payload,expires FROM records WHERE model=? AND id=?').get(this.model, id)); }
    async findByUid(uid) { return unpack(db.prepare('SELECT payload,expires FROM records WHERE model=? AND uid=?').get(this.model, uid)); }
    async findByUserCode(code) { return unpack(db.prepare('SELECT payload,expires FROM records WHERE model=? AND user_code=?').get(this.model, code)); }
    async destroy(id) { db.prepare('DELETE FROM records WHERE model=? AND id=?').run(this.model, id); }
    async consume(id) {
      db.prepare("UPDATE records SET payload=json_set(payload,'$.consumed',?) WHERE model=? AND id=?").run(now(), this.model, id);
    }
    async revokeByGrantId(id) { db.prepare('DELETE FROM records WHERE grant_id=?').run(id); }
  };
}

/** Independent single-owner OAuth issuer. Mount router at the issuer pathname. */
export async function createAuth({ issuer, resourceUrl, passwordHash, jwks, cookieKeys, dataDirectory, allowLoopback = false, codingEnabled = false }) {
  const issuerUrl = new URL(issuer);
  const resource = new URL(resourceUrl).href;
  const isLoopback = (url) => ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (issuer.endsWith('/') || (issuerUrl.protocol !== 'https:' && !(allowLoopback && issuerUrl.protocol === 'http:' && isLoopback(issuerUrl)))) {
    throw new Error('Issuer must be HTTPS without a trailing slash');
  }
  if (!Array.isArray(cookieKeys) || !cookieKeys.length || cookieKeys.some((key) => typeof key !== 'string' || key.length < 32)) {
    throw new Error('At least one durable cookie signing key of 32 characters is required');
  }
  if (!jwks?.keys?.length || jwks.keys.some((key) => key.kty !== 'RSA' || !key.d || !key.kid)) {
    throw new Error('Private RSA signing JWKS with key IDs is required');
  }
  const { salt, expected } = readPasswordHash(passwordHash);
  const db = createDatabase(dataDirectory);
  const publicJwks = { keys: jwks.keys.map(({ d, p, q, dp, dq, qi, oth, ...key }) => key) };
  const allowedScopes = [SCOPE, ...(codingEnabled ? ['praxis:code'] : [])];
  const verifyAccessToken = createTokenVerifier({ issuer, resourceUrl: resource, jwks: publicJwks, allowedScopes });
  const provider = new Provider(issuer, {
    adapter: adapterClass(db), jwks,
    clients: [],
    clientAuthMethods: ['none', 'client_secret_basic', 'client_secret_post'],
    clientDefaults: { token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] },
    responseTypes: ['code'],
    scopes: ['openid', 'offline_access', ...allowedScopes],
    claims: { openid: ['sub'] },
    pkce: { required: () => true },
    cookies: {
      keys: cookieKeys,
      names: { interaction: 'praxis_probe_interaction', resume: 'praxis_probe_resume', session: 'praxis_probe_session' },
      long: { httpOnly: true, sameSite: 'lax', secure: issuerUrl.protocol === 'https:' },
      short: { httpOnly: true, sameSite: 'lax', secure: issuerUrl.protocol === 'https:' },
    },
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: true, issueRegistrationAccessToken: false },
      userinfo: { enabled: false },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => resource,
        getResourceServerInfo: (_ctx, indicator) => {
          if (indicator !== resource) throw new errors.InvalidTarget('Unknown resource');
          return { scope: allowedScopes.join(' '), audience: resource, accessTokenTTL: 600, accessTokenFormat: 'jwt', jwt: { sign: { alg: 'RS256' } } };
        },
      },
    },
    extraClientMetadata: {
      properties: ['praxis_redirect_policy'],
      validator: (_ctx, _key, _value, metadata) => {
        if (!Array.isArray(metadata.redirect_uris) || !metadata.redirect_uris.length || metadata.redirect_uris.length > 8) {
          throw new errors.InvalidClientMetadata('Between one and eight redirect URIs are required');
        }
        for (const callback of metadata.redirect_uris) {
          let url;
          try { url = new URL(callback); } catch { throw new errors.InvalidClientMetadata('Invalid redirect URI'); }
          if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:' && isLoopback(url)))) {
            throw new errors.InvalidClientMetadata('Redirect URIs must use HTTPS');
          }
        }
        if (metadata.jwks_uri || metadata.sector_identifier_uri || metadata.request_uris?.length) {
          throw new errors.InvalidClientMetadata('Remote client metadata is not supported by this probe');
        }
        if (metadata.grant_types?.some((grant) => !['authorization_code', 'refresh_token'].includes(grant))) {
          throw new errors.InvalidClientMetadata('Only authorization_code and refresh_token grants are supported');
        }
      },
    },
    interactions: { url: (_ctx, interaction) => `${issuer}/interaction/${interaction.uid}` },
    findAccount: (_ctx, id) => id === OWNER ? { accountId: OWNER, claims: async () => ({ sub: OWNER }) } : undefined,
    issueRefreshToken: (_ctx, client) => client.grantTypeAllowed('refresh_token'),
    rotateRefreshToken: true,
    ttl: { AccessToken: 600, IdToken: 600, AuthorizationCode: 60, Interaction: 600, RefreshToken: 30 * 24 * 3600, Session: 7 * 24 * 3600, Grant: 30 * 24 * 3600 },
    renderError: (_ctx, _out, _error) => { _ctx.type = 'html'; _ctx.body = '<!doctype html><title>Praxis sign-in</title><p>Authorization could not be completed. Return to your app and reconnect.</p>'; },
  });
  // The reverse proxy is trusted by the root application and supplies HTTPS forwarding headers.
  provider.proxy = issuerUrl.protocol === 'https:';
  const router = express.Router();
  router.use((_req, res, next) => {
    // Native form POSTs under no-referrer send Origin: null, defeating our exact-origin
    // CSRF check. strict-origin preserves the origin without leaking paths or queries.
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'strict-origin', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
    next();
  });
  function limited(key, max, seconds) {
    const row = db.prepare(`INSERT INTO attempts(key,count,expires) VALUES(?,1,?)
      ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<=? THEN 1 ELSE count+1 END,
      expires=CASE WHEN expires<=? THEN excluded.expires ELSE expires END RETURNING count`).get(key, now() + seconds, now(), now());
    return row.count > max;
  }
  router.post('/reg', (req, res, next) => {
    const count = db.prepare("SELECT count(*) AS count FROM records WHERE model='Client'").get().count;
    if (count >= 250 || limited(`register:${req.ip}`, 20, 600)) return res.status(429).json({ error: 'temporarily_unavailable' });
    return next();
  });
  function renderInteraction(res, detail, error = '') {
    const csrf = randomBytes(32).toString('base64url');
    db.prepare('INSERT OR REPLACE INTO csrf(uid,hash,expires) VALUES(?,?,?)').run(detail.uid, digest(csrf), now() + 300);
    const login = detail.prompt.name === 'login';
    const host = new URL(detail.params.redirect_uri).hostname;
    const requestedScopes = String(detail.params.scope || '').split(' ');
    const rights = requestedScopes.includes('praxis:code')
      ? 'This connection can inspect registered source, edit disposable workspaces, and run sandboxed coding commands owned by Jensen. Commands have no network or production credentials. It can retrieve stored results and reconnect later.'
      : 'This connection can start and inspect harmless test jobs owned by Jensen and reconnect later.';
    res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Praxis</title>
      <style>body{font:18px system-ui;max-width:32rem;margin:3rem auto;padding:1.5rem;line-height:1.5}input,button{font:inherit;padding:.7rem;box-sizing:border-box;width:100%;margin:.5rem 0}small{display:block;overflow-wrap:anywhere}.error{color:#a20}</style>
      <h1>${login ? 'Sign in to Praxis' : 'Connect Praxis'}</h1>
      <p>${rights}</p><small>Return to: ${escapeHtml(host)}</small>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
      <form method="post" action="${escapeHtml(issuer)}/interaction/${escapeHtml(detail.uid)}">
      <input type="hidden" name="csrf" value="${csrf}">
      ${login ? '<label>Praxis password<input name="password" type="password" required maxlength="1024" autocomplete="current-password" autofocus></label>' : '<p>Allow the permissions described above?</p>'}
      <button name="action" value="allow">${login ? 'Sign in' : 'Allow connection'}</button><button name="action" value="deny" formnovalidate>Cancel</button></form></html>`);
  }
  router.get('/interaction/:uid', async (req, res, next) => {
    try {
      const detail = await provider.interactionDetails(req, res);
      if (detail.uid !== req.params.uid || !['login', 'consent'].includes(detail.prompt.name)) return res.status(400).send('Invalid interaction');
      return renderInteraction(res, detail);
    } catch (error) { return next(error); }
  });
  router.post('/interaction/:uid', express.urlencoded({ extended: false, limit: '8kb' }), async (req, res, next) => {
    try {
      if (req.get('origin') !== issuerUrl.origin) return res.status(403).send('Invalid form origin');
      const detail = await provider.interactionDetails(req, res);
      if (detail.uid !== req.params.uid) return res.status(403).send('Invalid interaction');
      const csrf = db.prepare('DELETE FROM csrf WHERE uid=? RETURNING hash,expires').get(detail.uid);
      if (!csrf || csrf.expires <= now() || typeof req.body.csrf !== 'string' || digest(req.body.csrf) !== csrf.hash) return res.status(403).send('Invalid form token');
      if (req.body.action === 'deny') return provider.interactionFinished(req, res, { error: 'access_denied', error_description: 'Owner cancelled authorization' }, { mergeWithLastSubmission: false });
      if (req.body.action !== 'allow') return res.status(400).send('Invalid action');
      if (detail.prompt.name === 'login') {
        if (limited(`login:${req.ip}`, 10, 900) || limited('login:global', 60, 900)) return res.status(429).send('Too many attempts. Try again later.');
        const password = typeof req.body.password === 'string' ? req.body.password : '';
        const actual = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
        if (!timingSafeEqual(actual, expected)) return renderInteraction(res.status(401), detail, 'Incorrect Praxis password.');
        return provider.interactionFinished(req, res, { login: { accountId: OWNER } }, { mergeWithLastSubmission: false });
      }
      if (detail.prompt.name !== 'consent' || detail.session?.accountId !== OWNER) return res.status(403).send('Owner sign-in required');
      let grant = detail.grantId ? await provider.Grant.find(detail.grantId) : undefined;
      grant ??= new provider.Grant({ accountId: OWNER, clientId: detail.params.client_id });
      const missing = detail.prompt.details;
      if (missing.missingOIDCScope) grant.addOIDCScope(missing.missingOIDCScope.join(' '));
      if (missing.missingOIDCClaims) grant.addOIDCClaims(missing.missingOIDCClaims);
      for (const [indicator, scopes] of Object.entries(missing.missingResourceScopes ?? {})) {
        if (indicator !== resource || scopes.some((scope) => !allowedScopes.includes(scope))) return res.status(403).send('Unsupported permissions');
        grant.addResourceScope(indicator, scopes.join(' '));
      }
      const grantId = await grant.save();
      return provider.interactionFinished(req, res, { consent: { grantId } }, { mergeWithLastSubmission: true });
    } catch (error) { return next(error); }
  });
  router.use(provider.callback());
  router.use((_error, _req, res, _next) => {
    if (!res.headersSent) res.status(400).send('Authorization session expired or request invalid. Return to your app and reconnect.');
  });
  const cleanup = setInterval(() => {
    db.prepare('DELETE FROM records WHERE expires IS NOT NULL AND expires<=?').run(now());
    db.prepare('DELETE FROM csrf WHERE expires<=?').run(now());
    db.prepare('DELETE FROM attempts WHERE expires<=?').run(now());
  }, 60000);
  cleanup.unref();
  return {
    provider, router,
    verifyAccessToken,
    close() { clearInterval(cleanup); db.close(); },
  };
}
