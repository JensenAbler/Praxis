import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT, decodeJwt } from 'jose';
import { clientHostFromRedirects, commitAuthorFor } from '../src/client-host.js';
import { createTokenVerifier } from '../src/token-verifier.js';
import { PraxisSdkOAuthProvider } from '../src/claude-facade/oauth-provider.js';
import { brokerSchemas } from '../src/git/broker.js';

test('redirect host is taken only when every redirect agrees', () => {
  assert.equal(clientHostFromRedirects(['https://claude.ai/api/mcp/auth_callback']), 'claude.ai');
  assert.equal(clientHostFromRedirects(['https://ChatGPT.com/a', 'https://chatgpt.com/b']), 'chatgpt.com');
  assert.equal(clientHostFromRedirects(['https://claude.ai/a', 'https://evil.example/b']), undefined);
  assert.equal(clientHostFromRedirects([]), undefined);
  assert.equal(clientHostFromRedirects(undefined), undefined);
  assert.equal(clientHostFromRedirects(['not a url']), undefined);
});

test('commit authors name known clients and describe others factually', () => {
  assert.deepEqual(commitAuthorFor('claude.ai'), { name: 'Claude (via Praxis)', email: 'claude.ai@clients.praxis.invalid' });
  assert.equal(commitAuthorFor('chatgpt.com').name, 'ChatGPT (via Praxis)');
  assert.equal(commitAuthorFor('tool.example').name, 'MCP client at tool.example');
  assert.equal(commitAuthorFor('127.0.0.1:9000').email, '127.0.0.1-9000@clients.praxis.invalid');
  assert.equal(commitAuthorFor(undefined).name, 'Unknown Praxis client');
  assert.equal(commitAuthorFor('bad host <x>').name, 'Unknown Praxis client');
  for (const host of ['claude.ai', 'tool.example', undefined]) {
    const schema = brokerSchemas.commit.shape.author;
    assert.equal(schema.safeParse(commitAuthorFor(host)).success, true);
  }
});

test('token verifier exposes the signed client host claim', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k', alg: 'RS256' }] };
  const issuer = 'https://issuer.test/praxis/oauth', resourceUrl = 'https://issuer.test/praxis/mcp';
  const sign = claims => new SignJWT({ client_id: 'c1', scope: 'praxis:code', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k', typ: 'at+jwt' }).setIssuer(issuer).setSubject('jensen')
    .setAudience(resourceUrl).setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const verify = createTokenVerifier({ issuer, resourceUrl, jwks, allowedScopes: ['praxis:code'], requiredScope: 'praxis:code' });
  assert.equal((await verify(await sign({ praxis_client_host: 'claude.ai' }))).extra.clientHost, 'claude.ai');
  const without = await verify(await sign({}));
  assert.deepEqual(without.extra, { subject: 'jensen' });
});

test('facade backend tokens carry the registered client host', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'client-host-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const salt = randomBytes(16);
  const hash = `scrypt$${salt.toString('base64url')}$${scryptSync('pw', salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64url')}`;
  const provider = new PraxisSdkOAuthProvider({ directory, passwordHash: hash, resourceUrl: 'https://facade.test/mcp',
    jwks: { keys: [{ ...(await exportJWK(privateKey)), kid: 'k' }] } });
  await provider.clientsStore.registerClient({ client_id: 'claude-client', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
  assert.equal(decodeJwt(await provider.makeBackendToken('claude-client')).praxis_client_host, 'claude.ai');
  assert.equal(decodeJwt(await provider.makeBackendToken('unregistered')).praxis_client_host, undefined);
});
