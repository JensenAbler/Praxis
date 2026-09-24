import { readFileSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { z } from 'zod';

const reserved = new Set(['praxis_release_plan', 'praxis_release_apply', 'praxis_release_status', 'praxis_release_history', 'praxis_release_rollback']);

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
      schema: z.fromJSONSchema(tool.inputSchema) };
  }
  return { tools, apiVersion: data.apiVersion, release: data.release };
}
