// Commit authorship for work arriving through Praxis's OAuth clients.
//
// An authorization code is only ever delivered to a client's registered
// redirect URI, so the redirect host identifies which application completed
// the owner's authorization. Both token issuers (the canonical endpoint and the
// Claude facade) sign that host into access tokens as `praxis_client_host`, and
// the git service derives the commit author from it. The committer remains the
// repository owner identity.
const KNOWN = new Map([
  ['claude.ai', 'Claude'],
  ['chatgpt.com', 'ChatGPT'],
  ['chat.openai.com', 'ChatGPT'],
]);
const HOST = /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/;

/** The single host shared by every redirect URI, or undefined when absent or mixed. */
export function clientHostFromRedirects(redirectUris) {
  if (!Array.isArray(redirectUris) || !redirectUris.length) return undefined;
  const hosts = new Set();
  for (const uri of redirectUris) {
    try { hosts.add(new URL(uri).host.toLowerCase()); } catch { return undefined; }
  }
  return hosts.size === 1 ? [...hosts][0] : undefined;
}

/** Git author identity for a verified client host claim. */
export function commitAuthorFor(clientHost) {
  if (typeof clientHost !== 'string' || !HOST.test(clientHost)) {
    return { name: 'Unknown Praxis client', email: 'unknown-client@clients.praxis.invalid' };
  }
  const known = KNOWN.get(clientHost);
  return {
    name: known ? `${known} (via Praxis)` : `MCP client at ${clientHost}`,
    email: `${clientHost.replace(/:/g, '-')}@clients.praxis.invalid`,
  };
}
