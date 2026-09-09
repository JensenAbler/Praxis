import { requestContext } from '../diagnostics.js';
import { WorkspaceError } from './paths.js';

export function createGitClient({ url = 'http://127.0.0.1:8793/call' } = {}) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/call' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Publishing client requires a fixed loopback endpoint');
  const call = async (action, { owner: _owner, ...args }) => {
    const token = requestContext.getStore()?.token;
    if (!token) throw new WorkspaceError('AUTHORIZATION_REQUIRED', 'Publishing requires the original authenticated owner token.');
    const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action, args }) });
    const data = await response.json();
    if (!data.ok) {
      const error = new WorkspaceError(data.error?.code || 'BROKER_UNAVAILABLE', data.error?.message || 'Publishing could not confirm this operation.');
      error.brokerRejected = response.status === 400 && ['sync', 'commit', 'push', 'deploy'].includes(action);
      throw error;
    }
    return data.data;
  };
  return Object.fromEntries(['sync', 'commit', 'push', 'deploy', 'get', 'list', 'deploymentStatus'].map(action => [action, args => call(action, args)]));
}
