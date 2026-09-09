// Runs INSIDE the networkless development container. Only this Unix socket
// crosses its network namespace; the separate service enforces destinations.
import net from 'node:net';
import { spawn } from 'node:child_process';

const connections = new Set();
const server = net.createServer(client => {
  const upstream = net.connect('/run/praxis-registry.sock');
  connections.add(client); connections.add(upstream);
  client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
  client.on('close', () => { connections.delete(client); upstream.destroy(); });
  upstream.on('close', () => { connections.delete(upstream); client.destroy(); });
  client.pipe(upstream).pipe(client);
});
server.listen(0, '127.0.0.1', () => {
  const proxy = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy,
    ALL_PROXY: proxy, all_proxy: proxy, NO_PROXY: '', no_proxy: '',
    NPM_CONFIG_PROXY: proxy, NPM_CONFIG_HTTPS_PROXY: proxy, NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
    PIP_PROXY: proxy, PIP_INDEX_URL: 'https://pypi.org/simple', PIP_EXTRA_INDEX_URL: '', PIP_CONFIG_FILE: '/dev/null' };
  const child = spawn(process.argv[2], process.argv.slice(3), { env, stdio: 'inherit' });
  const finish = code => { for (const socket of connections) socket.destroy(); server.close(); process.exitCode = code; };
  child.on('error', error => { console.error(`Dependency command could not start: ${error.code}`); finish(127); });
  child.on('exit', (code, signal) => finish(code ?? (signal === 'SIGTERM' ? 143 : 1)));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  process.on('SIGINT', () => child.kill('SIGINT'));
});
server.on('error', error => { console.error(`Registry relay failed: ${error.code}`); process.exitCode = 1; });
