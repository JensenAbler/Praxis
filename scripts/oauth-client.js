import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Verification client only. Tokens stay in a private, ignored local file.
export async function authorize({ baseUrl = 'https://mcp.jensenabler.com/praxis', passwordFile, stateFile, scope = 'praxis:probe offline_access' }) {
  const base = new URL(baseUrl);
  const resource = `${base.href.replace(/\/$/, '')}/mcp`;
  const issuer = `${base.href.replace(/\/$/, '')}/oauth`;
  const expectedOrigin = base.origin;
  const metadata = await (await fetch(`${expectedOrigin}/.well-known/oauth-authorization-server${base.pathname.replace(/\/$/, '')}/oauth`)).json();
  if (metadata.issuer !== issuer) throw new Error('Unexpected OAuth issuer');
  for (const field of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
    if (new URL(metadata[field]).origin !== expectedOrigin) throw new Error('Unexpected OAuth endpoint origin');
  }
  let state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
  if (state.resource && state.resource !== resource) throw new Error('Client state belongs to another resource');
  if (state.client && (state.requestedScope || 'praxis:probe offline_access') !== scope) throw new Error('Use a separate private client state for a different permission grant');
  state.requestedScope = scope;
  const save = () => { mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 }); writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 }); };
  if (state.accessToken && state.expiresAt > Date.now() + 30000) return { token: state.accessToken, resource, state, save };
  async function tokenRequest(params) {
    const response = await fetch(metadata.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
    const token = await response.json();
    if (!response.ok) throw new Error(`OAuth token exchange failed: HTTP ${response.status}, ${token.error || 'unknown'}`);
    state.accessToken = token.access_token; state.refreshToken = token.refresh_token;
    state.expiresAt = Date.now() + Number(token.expires_in) * 1000; state.resource = resource; save();
  }
  if (state.refreshToken) {
    await tokenRequest({ grant_type: 'refresh_token', client_id: state.client.client_id, refresh_token: state.refreshToken, resource });
    return { token: state.accessToken, resource, state, save };
  }
  const callback = 'https://client.example/praxis-callback';
  const registration = await fetch(metadata.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Praxis deployment verification', redirect_uris: [callback], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
  if (registration.status !== 201) throw new Error(`Client registration failed: HTTP ${registration.status}`);
  state.client = await registration.json();
  const verifier = randomBytes(32).toString('base64url');
  const nonce = randomBytes(24).toString('base64url');
  const params = new URLSearchParams({ client_id: state.client.client_id, redirect_uri: callback, response_type: 'code', scope, resource, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: nonce, prompt: 'consent' });
  const cookies = new Map();
  async function browser(url, options = {}) {
    if (new URL(url).origin !== expectedOrigin) throw new Error('Refusing to send credentials outside the configured issuer');
    const response = await fetch(url, { redirect: 'manual', ...options, headers: { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...options.headers } });
    for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0]; const at = pair.indexOf('='); cookies.set(pair.slice(0, at), pair.slice(at + 1)); }
    return response;
  }
  let response = await browser(`${metadata.authorization_endpoint}?${params}`);
  for (let step = 0; step < 16; step++) {
    if (response.status >= 300 && response.status < 400) {
      const target = new URL(response.headers.get('location'), issuer);
      if (`${target.origin}${target.pathname}` === callback) {
        if (target.searchParams.get('state') !== nonce || target.searchParams.get('iss') !== issuer || !target.searchParams.get('code')) throw new Error('Invalid OAuth callback');
        await tokenRequest({ grant_type: 'authorization_code', client_id: state.client.client_id, code: target.searchParams.get('code'), code_verifier: verifier, redirect_uri: callback, resource });
        return { token: state.accessToken, resource, state, save };
      }
      response = await browser(target.href);
    } else if (response.status === 200) {
      const html = await response.text();
      const action = html.match(/<form method="post" action="([^"]+)"/)?.[1];
      const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
      if (!action || !csrf) throw new Error('Unexpected owner authorization form');
      const fields = { csrf, action: 'allow' };
      if (html.includes('name="password"')) fields.password = readFileSync(passwordFile, 'utf8').trim();
      response = await browser(action, { method: 'POST', headers: { origin: expectedOrigin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
    } else throw new Error(`Owner authorization failed: HTTP ${response.status}`);
  }
  throw new Error('Owner authorization exceeded redirect limit');
}
