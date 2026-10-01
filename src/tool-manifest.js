import { readFileSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { z } from 'zod';

const reserved = new Set(['usage_summary', 'observations_list', 'praxis_release_plan', 'praxis_release_apply', 'praxis_release_status', 'praxis_release_history', 'praxis_release_rollback']);

// Routing is data, never executable configuration. Only these two fixed clients
// exist in the gateway. Broker action existence and policy belong to the broker.
export function manifestRoute(name, value) {
  const route = value === undefined ? { target: 'coding', action: name } : value;
  if (!route || typeof route !== 'object' || Array.isArray(route)
    || Object.keys(route).length !== 2 || !['coding', 'git'].includes(route.target)
    || typeof route.action !== 'string' || !/^[a-z][a-zA-Z0-9_]{0,63}$/.test(route.action)
    || reserved.has(name) || name.startsWith('probe_')
    || reserved.has(route.action) || route.action.startsWith('probe_')
    || /^release/i.test(route.action)) throw new Error('Invalid application tool route');
  return { target: route.target, action: route.action };
}

export function healthRoute(name, route) {
  return route?.target === 'coding' && route.action === name
    && ['capabilities', 'projects_list', 'project_inspect', 'file_read', 'jobs_list', 'job_status'].includes(name);
}

/**
 * Reload the manifest whenever the file behind `path` changes, e.g. when a
 * release swaps /srv/praxis-app/current. A broken new manifest keeps the last
 * good tools, so a bad release cannot remove them from a long-running process.
 */
export function watchToolManifest(path, { onError = () => {} } = {}) {
  let key, tools;
  return () => {
    try {
      const real = realpathSync(path), stat = statSync(real), next = `${real}:${stat.mtimeMs}:${stat.size}`;
      if (next !== key) { tools = loadToolManifest(path).tools; key = next; }
    } catch (error) { onError(error); }
    return tools;
  };
}

/** Data only: the protected gateway never imports application candidate code. */
export function loadToolManifest(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Invalid application tool manifest');
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (data.version !== 1 || !Array.isArray(data.tools) || data.tools.length < 1 || data.tools.length > 100) throw new Error('Invalid application tool manifest');
  const tools = Object.create(null);
  for (const tool of data.tools) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name) || tool.name.startsWith('probe_') || reserved.has(tool.name) || Object.hasOwn(tools, tool.name)
      || typeof tool.title !== 'string' || tool.title.length > 160 || typeof tool.description !== 'string' || tool.description.length > 4000
      || tool.inputSchema?.type !== 'object' || typeof tool.write !== 'boolean' || typeof tool.destructive !== 'boolean') throw new Error('Invalid application tool definition');
    tools[tool.name] = { title: tool.title, description: tool.description, write: tool.write, destructive: tool.destructive,
      route: manifestRoute(tool.name, tool.route), schema: z.fromJSONSchema(tool.inputSchema) };
  }
  return { tools, apiVersion: data.apiVersion, release: data.release };
}
