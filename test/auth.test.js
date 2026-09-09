import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, scryptSync, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { generateKeyPair, exportJWK, importJWK, SignJWT } from 'jose';
import { createAuth } from '../src/auth.js';
import { createApp } from '../src/server.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

async function fixture(t, { integrated = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'praxis-auth-test-'));
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...await exportJWK(privateKey), kid: 'test-key', use: 'sig', alg: 'RS256' };
  const password = 'fixture-owner-password';
  const salt = randomBytes(16);
  const passwordHash = `scrypt$${salt.toString('base64url')}$${scryptSync(password, salt, 64).toString('base64url')}`;
  const app = express();
  let auth;
  let service;
  if (integrated) app.use((req, res, next) => service.app(req, res, next));
  else app.use('/oauth', (req, res, next) => auth.router(req, res, next));
  const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const issuer = `${origin}/oauth`;
  const resource = `${origin}/mcp`;
  const options = { issuer, resourceUrl: resource, passwordHash, jwks: { keys: [jwk] }, cookieKeys: ['fixture-cookie-signing-key-that-is-very-long'], dataDirectory: directory, allowLoopback: true };
  if (integrated) {
    service = await createApp({ baseUrl: origin, dataDirectory: directory, allowLoopback: true, auth: options });
    auth = service.auth;
  } else auth = await createAuth(options);
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); if (service) await service.close(); else auth.close(); await rm(directory, { recursive: true, force: true }); });
  const request = (path, init) => fetch(new URL(path, origin), { redirect: 'manual', ...init });
  async function register(extra = {}) {
    const response = await request('/oauth/reg', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Probe test client', redirect_uris: ['https://client.example/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...extra }) });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    return body;
  }
  async function flow(client, { passwordOverride, missingCsrf = false, originOverride, scope = 'openid offline_access praxis:probe' } = {}) {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const cookies = new Map();
    async function browser(url, init = {}) {
      const headers = { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '), ...init.headers };
      const response = await fetch(url, { redirect: 'manual', ...init, headers });
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(';');
        const index = pair.indexOf('='); cookies.set(pair.slice(0, index), pair.slice(index + 1));
      }
      return response;
    }
    const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code', scope, resource, code_challenge: challenge, code_challenge_method: 'S256', state: 'test-state', prompt: 'consent' });
    let response = await browser(`${issuer}/auth?${params}`);
    for (let turn = 0; turn < 12; turn++) {
      if (response.status >= 300 && response.status < 400) {
        const target = new URL(response.headers.get('location'), issuer);
        if (target.origin !== origin) {
          assert.equal(target.searchParams.get('error'), null, target.href);
          assert.equal(target.searchParams.get('iss'), issuer);
          assert.equal(target.searchParams.get('state'), 'test-state');
          return { code: target.searchParams.get('code'), verifier };
        }
        response = await browser(target.href);
      } else if (response.status === 200) {
        // The browser's native form submission must retain its real Origin header.
        assert.equal(response.headers.get('referrer-policy'), 'strict-origin');
        const html = await response.text();
        const action = html.match(/<form method="post" action="([^"]+)"/)?.[1];
        const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
        assert.ok(action && csrf, html);
        response = await browser(action, { method: 'POST', headers: { origin: originOverride ?? origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: missingCsrf ? 'wrong' : csrf, action: 'allow', ...(html.includes('name="password"') ? { password: passwordOverride ?? password } : {}) }) });
        if (passwordOverride || missingCsrf || originOverride) return response;
      } else {
        assert.fail(`Unexpected authorization HTTP ${response.status}: ${await response.text()}`);
      }
    }
    assert.fail('Authorization did not complete');
  }
  async function exchange(client, grant, extra = {}) {
    const body = { grant_type: 'authorization_code', client_id: client.client_id, code: grant.code, code_verifier: grant.verifier, redirect_uri: client.redirect_uris[0], resource, ...extra };
    return request('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  }
  return { origin, issuer, resource, jwk, request, register, flow, exchange, get auth() { return auth; }, async restart() { auth.close(); auth = await createAuth(options); } };
}

test('OAuth discovery, owner login, PKCE, JWT verification and persistent rotating refresh', async (t) => {
  const f = await fixture(t);
  const discovery = await (await f.request('/oauth/.well-known/openid-configuration')).json();
  assert.equal(discovery.issuer, f.issuer);
  assert.deepEqual(discovery.code_challenge_methods_supported, ['S256']);
  assert.equal(discovery.authorization_response_iss_parameter_supported, true);
  const client = await f.register();
  const grant = await f.flow(client, { scope: 'praxis:probe offline_access' });
  const response = await f.exchange(client, grant);
  const token = await response.json();
  assert.equal(response.status, 200, JSON.stringify(token));
  assert.ok(token.refresh_token);
  const verified = await f.auth.verifyAccessToken(token.access_token);
  assert.equal(verified.extra.subject, 'jensen');
  assert.deepEqual(verified.scopes, ['praxis:probe']);
  assert.equal(verified.clientId, client.client_id);
  await f.restart();
  assert.equal((await f.auth.verifyAccessToken(token.access_token)).extra.subject, 'jensen');
  const refresh = await f.request('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: token.refresh_token, resource: f.resource }) });
  const refreshed = await refresh.json();
  assert.equal(refresh.status, 200, JSON.stringify(refreshed));
  assert.notEqual(refreshed.refresh_token, token.refresh_token);
  assert.equal((await f.auth.verifyAccessToken(refreshed.access_token)).extra.subject, 'jensen');
  const replay = await f.request('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: token.refresh_token, resource: f.resource }) });
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, 'invalid_grant');
});

test('owner password, CSRF and form origin are enforced', async (t) => {
  const f = await fixture(t);
  const client = await f.register();
  assert.equal((await f.flow(client, { passwordOverride: 'incorrect' })).status, 401);
  assert.equal((await f.flow(client, { missingCsrf: true })).status, 403);
  assert.equal((await f.flow(client, { originOverride: 'https://untrusted.example' })).status, 403);
  assert.equal((await f.flow(client, { originOverride: 'null' })).status, 403);
});

test('PKCE code verifier and confidential client secret are checked', async (t) => {
  const f = await fixture(t);
  const publicClient = await f.register();
  const publicGrant = await f.flow(publicClient);
  const failedPkce = await f.exchange(publicClient, publicGrant, { code_verifier: randomBytes(32).toString('base64url') });
  assert.equal(failedPkce.status, 400);
  assert.equal((await failedPkce.json()).error, 'invalid_grant');
  const privateClient = await f.register({ token_endpoint_auth_method: 'client_secret_post' });
  const privateGrant = await f.flow(privateClient);
  const failedSecret = await f.exchange(privateClient, privateGrant, { client_secret: 'wrong-secret' });
  assert.equal((await failedSecret.json()).error, 'invalid_client');
  const validSecret = await f.exchange(privateClient, privateGrant, { client_secret: privateClient.client_secret });
  assert.equal(validSecret.status, 200, await validSecret.text());
});

test('access token verification rejects invalid signature, issuer, subject, audience, expiry and scope', async (t) => {
  const f = await fixture(t);
  const key = await importJWK(f.jwk, 'RS256');
  const claims = { iss: f.issuer, aud: f.resource, sub: 'jensen', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120, scope: 'praxis:probe', client_id: 'test-client' };
  async function sign(overrides = {}, signingKey = key) { return new SignJWT({ ...claims, ...overrides }).setProtectedHeader({ alg: 'RS256', kid: 'test-key', typ: 'at+jwt' }).sign(signingKey); }
  for (const override of [{ iss: 'https://wrong.example' }, { sub: 'someone-else' }, { aud: 'https://wrong.example' }, { aud: [f.resource, 'https://wrong.example'] }, { exp: 1 }, { scope: 'unrelated' }]) {
    await assert.rejects(f.auth.verifyAccessToken(await sign(override)));
  }
  const other = await generateKeyPair('RS256');
  await assert.rejects(f.auth.verifyAccessToken(await sign({}, other.privateKey)));
  await assert.rejects(f.auth.verifyAccessToken('invalid-token'));
});

test('registration rejects unsafe callback and remote metadata inputs', async (t) => {
  const f = await fixture(t);
  for (const fields of [{ redirect_uris: ['http://untrusted.example/callback'] }, { redirect_uris: ['https://user:pass@client.example/callback'] }, { redirect_uris: ['https://client.example/callback#fragment'] }, { redirect_uris: ['https://client.example/callback'], jwks_uri: 'http://127.0.0.1/private' }]) {
    const response = await f.request('/oauth/reg', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fields) });
    assert.equal(response.status, 400, await response.text());
  }
});

test('complete app publishes discovery aliases and serves MCP only after real OAuth', async (t) => {
  const f = await fixture(t, { integrated: true });
  const metadata = await (await f.request('/.well-known/oauth-authorization-server/oauth')).json();
  assert.equal(metadata.issuer, f.issuer);
  assert.equal((await f.request('/mcp')).status, 401);
  const rejected = await f.request('/mcp', { headers: { authorization: 'Bearer invalid-token' } });
  assert.equal(rejected.status, 401);
  assert.match(rejected.headers.get('www-authenticate'), /invalid_token/);
  const registration = await f.register();
  const grant = await f.flow(registration, { scope: 'praxis:probe offline_access' });
  const response = await f.exchange(registration, grant);
  const token = await response.json();
  assert.equal(response.status, 200, JSON.stringify(token));
  const client = new Client({ name: 'authenticated-probe-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(f.resource), { requestInit: { headers: { Authorization: `Bearer ${token.access_token}` } } });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === 'probe_capabilities'));
  } finally { await client.close(); }
  assert.equal(metadata.authorization_endpoint, `${f.issuer}/auth`);
});
