import { createLocalJWKSet, jwtVerify } from 'jose';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';

/** Public-key-only verification, shared by the gateway and isolated coding adapter. */
export function createTokenVerifier({ issuer, resourceUrl, jwks, allowedScopes = ['praxis:probe'], requiredScope }) {
  if (jwks?.keys?.some(key => key.d || key.k || key.p || key.q)) throw new Error('Token verifier requires public keys only');
  const keySet = createLocalJWKSet(jwks);
  return async token => {
    try {
      const { payload } = await jwtVerify(token, keySet, {
        issuer, audience: resourceUrl, subject: 'jensen', algorithms: ['RS256'], typ: 'at+jwt',
        requiredClaims: ['exp', 'iat', 'client_id', 'scope']
      });
      const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [];
      if (payload.aud !== resourceUrl || typeof payload.client_id !== 'string' || !payload.client_id ||
          !scopes.some(scope => allowedScopes.includes(scope)) || (requiredScope && !scopes.includes(requiredScope))) {
        throw new Error('Invalid access claims');
      }
      return { token, clientId: payload.client_id, scopes, expiresAt: payload.exp, extra: { subject: 'jensen' } };
    } catch {
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid, expired, or insufficiently scoped Praxis access token');
    }
  };
}

/** Independent health keys cannot mint normal owner/production grants. */
export function createHealthVerifier({ issuer, resourceUrl, jwks }) {
  const verify = createTokenVerifier({ issuer, resourceUrl, jwks, allowedScopes: ['praxis:health'], requiredScope: 'praxis:health' });
  return async token => {
    const result = await verify(token);
    if (result.scopes.length !== 1 || result.scopes[0] !== 'praxis:health' || result.clientId !== 'praxis-health') {
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid health grant');
    }
    return result;
  };
}
