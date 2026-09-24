// Mirrors validate_manifest in deploy/praxis_updater_host.py so an incompatible
// tool change fails in `npm test` (in a Praxis workspace or here) instead of
// after a two-minute release build. Keep the two rules identical.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { codeTools } from '../src/code/schema.js';

export const LIVE_MANIFEST = '/srv/praxis-app/current/coding-tools.json';

/** The manifest scripts/export-tool-manifest.js would write for the current source. */
export function currentManifest() {
  return { version: 1, tools: Object.entries(codeTools).map(([name, tool]) => ({ name, write: !!tool.write, destructive: !!tool.destructive,
    inputSchema: z.toJSONSchema(tool.schema, { target: 'draft-7', unrepresentable: 'any' }) })) };
}

/** Reasons the updater would refuse `next` as a routine update of `previous`; empty when compatible. */
export function manifestProblems(previous, next) {
  const problems = [], tools = new Map(next.tools.map(tool => [tool.name, tool]));
  if (tools.size !== next.tools.length) problems.push('Duplicate tool name.');
  for (const tool of previous.tools) {
    const newer = tools.get(tool.name);
    if (!newer) { problems.push(`Existing tool disappeared: ${tool.name}`); continue; }
    if (newer.write !== tool.write || newer.destructive !== tool.destructive) problems.push(`Permission annotation changed: ${tool.name}`);
    const before = tool.inputSchema, after = newer.inputSchema, required = new Set(before.required ?? []);
    for (const name of after.required ?? []) if (!required.has(name)) problems.push(`New required argument (a default counts): ${tool.name}.${name}`);
    for (const [name, schema] of Object.entries(before.properties ?? {})) {
      if (!isDeepStrictEqual(after.properties?.[name], schema)) problems.push(`Existing argument changed: ${tool.name}.${name}`);
    }
  }
  return problems;
}

function isDeepStrictEqual(a, b) {
  // Python's == on parsed JSON: key order is irrelevant, everything else must match.
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && isDeepStrictEqual(a[key], b[key]));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const path = process.argv[2] ?? LIVE_MANIFEST;
  const problems = manifestProblems(JSON.parse(readFileSync(path, 'utf8')), currentManifest());
  console.log(problems.length ? problems.join('\n') : `Compatible with ${path}`);
  process.exitCode = problems.length ? 1 : 0;
}
