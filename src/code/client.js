import { correlationId, requestContext, errorRecovery } from '../diagnostics.js';

export function createCodingClient({ url }) {
  const endpoint = new URL('/call', url);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
    throw new Error('Coding backend must be a fixed loopback HTTP service');
  }
  return {
    async call(action, args, token) {
      const requestId = correlationId(requestContext.getStore()?.requestId);
      const unavailable = message => Object.assign(new Error(message), { code: 'BACKEND_UNAVAILABLE', requestId });
      let response;
      try {
        response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-praxis-request-id': requestId }, body: JSON.stringify({ action, args }) });
      } catch {
        throw unavailable('Coding service response unavailable. Recover existing workspaces, jobs, or operation receipts before retrying with the original idempotency key.');
      }
      let body;
      try { body = await response.json(); } catch { throw unavailable('Coding service returned an unreadable response. Recover existing work before retrying.'); }
      if (!body || typeof body !== 'object' || typeof body.ok !== 'boolean') throw unavailable('Coding service returned an invalid response. Recover existing work before retrying.');
      if (!response.ok || !body.ok) {
        const code = typeof body.error?.code === 'string' && /^[A-Z_]{1,64}$/.test(body.error.code) ? body.error.code : 'BACKEND_ERROR';
        throw Object.assign(new Error(typeof body.error?.message === 'string' ? body.error.message.slice(0, 500) : 'Coding request failed'), {
          code, requestId, ...errorRecovery(code),
          ...(Array.isArray(body.error?.issues) ? { issues: body.error.issues.slice(0, 5) } : {}),
        });
      }
      if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) throw unavailable('Coding service returned an incomplete result. Recover existing work before retrying.');
      return body.data;
    }
  };
}
