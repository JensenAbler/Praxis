import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateKeyPair, exportJWK, jwtVerify } from 'jose';
import { PraxisSdkOAuthProvider, OAUTH_SCOPES } from '../src/claude-facade/oauth-provider.js';

const RESOURCE = 'https://praxis-apps.example.test/mcp';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function passwordHash(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function fakeResponse() {
  const res = { statusCode: 200, headers: {}, body: undefined, location: undefined };
  res.status = code => { res.statusCode = code; return res; };
  res.set = values => { Object.assign(res.headers, values); return res; };
  res.send = body => { res.body = body; return res; };
  res.redirect = (code, url) => { res.statusCode = code; res.location = url; return res; };
  return res;
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'claude-facade-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(privateKey)), kid: 'test-key' };
  const provider = new PraxisSdkOAuthProvider({
    directory, passwordHash: passwordHash('correct horse'), resourceUrl: RESOURCE, jwks: { keys: [jwk] },
  });
  const client = await provider.clientsStore.registerClient({ client_id: 'claude-client', client_name: 'Claude', redirect_uris: [REDIRECT] });
  return { directory, provider, client, publicKey };
}

async function pendingId(provider, client, extra = {}) {
  const res = fakeResponse();
  await provider.authorize(client, { redirectUri: REDIRECT, scopes: ['praxis', 'praxis:code'], state: 's1', codeChallenge: 'chal', resource: new URL(RESOURCE), ...extra }, res);
  assert.equal(res.statusCode, 200);
  return /name="pending" value="([^"]+)"/.exec(res.body)[1];
}

test('facade advertises the Praxis code scope', () => {
  assert.deepEqual(OAUTH_SCOPES, ['praxis', 'praxis:code', 'offline_access']);
});

test('registration rejects non-HTTPS, non-loopback redirects', async t => {
  const { provider } = await fixture(t);
  await assert.rejects(provider.clientsStore.registerClient({ client_id: 'x', redirect_uris: ['http://evil.example/cb'] }), /HTTPS or loopback/);
  await provider.clientsStore.registerClient({ client_id: 'loop', redirect_uris: ['http://127.0.0.1:9000/cb'] });
});

test('wrong password is refused and the pending request survives', async t => {
  const { provider, client } = await fixture(t);
  const id = await pendingId(provider, client);
  const bad = fakeResponse();
  await provider.completeAuthorization(id, 'wrong', 'approve', bad);
  assert.equal(bad.statusCode, 401);
  assert.match(bad.body, /Incorrect Praxis password/);
  const good = fakeResponse();
  await provider.completeAuthorization(id, 'correct horse', 'approve', good);
  assert.equal(good.statusCode, 302);
});

test('deny redirects with access_denied', async t => {
  const { provider, client } = await fixture(t);
  const res = fakeResponse();
  await provider.completeAuthorization(await pendingId(provider, client), '', 'deny', res);
  const url = new URL(res.location);
  assert.equal(url.searchParams.get('error'), 'access_denied');
  assert.equal(url.searchParams.get('state'), 's1');
});

test('code exchange issues persisted tokens with a verifiable backend owner JWT', async t => {
  const { directory, provider, client, publicKey } = await fixture(t);
  const res = fakeResponse();
  await provider.completeAuthorization(await pendingId(provider, client), 'correct horse', 'approve', res);
  const code = new URL(res.location).searchParams.get('code');
  assert.equal(await provider.challengeForAuthorizationCode(client, code), 'chal');
  const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT, new URL(RESOURCE));
  assert.equal(tokens.scope, 'praxis praxis:code');
  await assert.rejects(provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT, new URL(RESOURCE)), /Invalid or expired/);

  const auth = await provider.verifyAccessToken(tokens.access_token);
  assert.equal(auth.clientId, 'claude-client');
  const { payload } = await jwtVerify(auth.backendToken, publicKey, {
    issuer: 'https://mcp.jensenabler.com/praxis/oauth', audience: 'https://mcp.jensenabler.com/praxis/mcp',
  });
  assert.equal(payload.sub, 'jensen');
  assert.equal(payload.client_id, 'claude-client');
  assert.equal(payload.scope, 'praxis:probe praxis:code');

  const file = join(directory, 'OAUTH.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  // A restarted facade reads the same state and still honors the token.
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const restarted = new PraxisSdkOAuthProvider({ directory, passwordHash: passwordHash('x'), resourceUrl: RESOURCE, jwks: { keys: [{ ...(await exportJWK(privateKey)), kid: 'k2' }] } });
  assert.equal((await restarted.verifyAccessToken(tokens.access_token)).clientId, 'claude-client');
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).clients['claude-client']);
});

test('refresh rotates tokens and cannot expand scopes', async t => {
  const { provider, client } = await fixture(t);
  const res = fakeResponse();
  await provider.completeAuthorization(await pendingId(provider, client, { scopes: ['praxis'] }), 'correct horse', 'approve', res);
  const tokens = await provider.exchangeAuthorizationCode(client, new URL(res.location).searchParams.get('code'), undefined, REDIRECT, new URL(RESOURCE));
  await assert.rejects(provider.exchangeRefreshToken(client, tokens.refresh_token, ['praxis', 'praxis:code']), /Cannot expand scopes/);
  const rotated = await provider.exchangeRefreshToken(client, tokens.refresh_token);
  assert.notEqual(rotated.refresh_token, tokens.refresh_token);
  await assert.rejects(provider.exchangeRefreshToken(client, tokens.refresh_token), /Invalid refresh token/);
});

test('tokens for another resource are rejected', async t => {
  const { provider, client } = await fixture(t);
  await assert.rejects(provider.authorize(client, { redirectUri: REDIRECT, scopes: ['praxis'], resource: new URL('https://other.example/mcp') }, fakeResponse()), /Invalid resource/);
  await assert.rejects(provider.verifyAccessToken('not-a-token'), /Invalid or expired/);
});

test('facade entrypoint parses and resolves its imports from the repository', () => {
  const entry = fileURLToPath(new URL('../src/claude-facade/server.js', import.meta.url));
  const check = spawnSync(process.execPath, ['--check', entry], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  const source = readFileSync(entry, 'utf8');
  assert.doesNotMatch(source, /from '\/(srv|opt)\//, 'facade must not import from deployed host paths');
});
