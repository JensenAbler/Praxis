/** Owner verification client. Input, results and OAuth state stay in private files. */
import { readFileSync, writeFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { authorize } from './oauth-client.js';

const [requestFile, resultFile] = process.argv.slice(2);
if (!requestFile || !resultFile || !process.env.PRAXIS_PASSWORD_FILE || !process.env.PRAXIS_CLIENT_STATE) {
  throw new Error('Supply private request/result files and PRAXIS_PASSWORD_FILE/PRAXIS_CLIENT_STATE paths.');
}
const request = JSON.parse(readFileSync(requestFile, 'utf8'));
const session = await authorize({ baseUrl: process.env.PRAXIS_BASE_URL || 'https://mcp.jensenabler.com/praxis',
  passwordFile: process.env.PRAXIS_PASSWORD_FILE, stateFile: process.env.PRAXIS_CLIENT_STATE, scope: 'praxis:code offline_access' });
const client = new Client({ name: 'Praxis owner API verification', version: '1' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(session.resource), {
    requestInit: { headers: { authorization: `Bearer ${session.token}` } }
  }));
  const result = request.listTools ? await client.listTools() : await client.callTool(request);
  writeFileSync(resultFile, JSON.stringify({ observedAt: new Date().toISOString(), request, result }, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ saved: resultFile, tool: request.listTools ? 'listTools' : request.name,
    isError: Boolean(result.isError), ...(result.structuredContent ? { outcome: result.structuredContent.status || result.structuredContent.ok } : {}) }));
} finally { await client.close(); }
