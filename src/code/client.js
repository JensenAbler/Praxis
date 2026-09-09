export function createCodingClient({ url }) {
  const endpoint = new URL('/call', url);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
    throw new Error('Coding backend must be a fixed loopback HTTP service');
  }
  return {
    async call(action, args, token) {
      let response;
      try {
        response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action, args }) });
      } catch {
        throw Object.assign(new Error('Coding service response unavailable. Recover existing workspaces, jobs, or operation receipts before retrying with the original idempotency key.'), { code: 'BACKEND_UNAVAILABLE' });
      }
      let body;
      try { body = await response.json(); } catch { throw Object.assign(new Error('Coding service returned an unreadable response. Recover existing work before retrying.'), { code: 'BACKEND_UNAVAILABLE' }); }
      if (!response.ok || !body.ok) throw Object.assign(new Error(body.error?.message || 'Coding request failed'), { code: body.error?.code || 'BACKEND_ERROR' });
      return body.data;
    }
  };
}
