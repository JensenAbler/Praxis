import { z } from 'zod';

const id = z.string().uuid();
const projectId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const revision = z.string().min(1).max(128);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const path = z.string().min(1).max(512);
const cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0);
const page = z.number().int().min(1).max(100).default(20);
const source = { projectId: projectId.optional(), workspaceId: id.optional() };
const object = shape => z.object(shape).strict();
const change = z.discriminatedUnion('action', [
  object({ action: z.literal('write'), path, expectedSha256: hash.nullable(), content: z.string().max(131072), executable: z.boolean().optional() }),
  object({ action: z.literal('patch'), path, expectedSha256: hash, oldText: z.string().min(1).max(131072), newText: z.string().max(131072) }),
  object({ action: z.literal('rename'), path, to: path, expectedSha256: hash }),
  object({ action: z.literal('delete'), path, expectedSha256: hash })
]);

// Both adapters validate these schemas. Authentication identity is never an argument.
export const codeTools = {
  capabilities: { method: null, title: 'Inspect Praxis coding capabilities', description: 'Start here. Read the installed release, isolated coding workflow, precise limits, recovery instructions, and disabled capabilities.', schema: object({}) },
  projects_list: { method: 'projectsList', title: 'Discover registered projects', description: 'List immutable source snapshots registered for this owner, their exact commits, and validation commands. No live checkout is edited.', schema: object({}) },
  project_inspect: { method: 'projectInspect', title: 'Inspect a project snapshot', description: 'Read a registered source snapshot, its exact base revision, repository information, and applicable instructions.', schema: object({ projectId }) },
  files_list: { method: 'filesList', title: 'List source files', description: 'List bounded source paths. Supply exactly one of projectId or workspaceId. Cursor 0 begins the list; excluded runtime directories and credentials are not returned.', schema: object({ ...source, path: z.string().max(512).default(''), cursor, limit: z.number().int().min(1).max(200).default(100) }) },
  file_read: { method: 'read', title: 'Read source with a content hash', description: 'Read numbered source lines from exactly one projectId or workspaceId. Returns a SHA-256 for edit preconditions and a workspace revision where applicable. Follow pagination for remaining text.', schema: object({ ...source, path, startLine: z.number().int().min(1).max(1000000).default(1), startColumn: z.number().int().min(1).max(2097152).default(1), lineCount: z.number().int().min(1).max(200).default(100) }) },
  code_search: { method: 'search', title: 'Search source text', description: 'Search a literal string in exactly one projectId or workspaceId. Results include paths and line numbers with pagination. This is not a regular expression.', schema: object({ ...source, query: z.string().min(1).max(256), path: z.string().max(512).default(''), caseSensitive: z.boolean().default(true), cursor, limit: z.number().int().min(1).max(100).default(50) }) },
  workspace_create: { method: 'create', write: true, title: 'Create an isolated coding workspace', description: 'Copy a registered immutable source snapshot at baseRevision into a disposable workspace. Save the returned workspaceId. Repeat identical inputs and idempotencyKey after an uncertain response.', schema: object({ projectId, baseRevision: revision, idempotencyKey: key, label: z.string().max(80).default('') }) },
  workspaces_list: { method: 'list', title: 'Recover coding workspaces', description: 'List your persisted workspaces, newest first. Use this in a fresh conversation to find existing work instead of recreating it.', schema: object({ cursor, limit: page }) },
  workspace_inspect: { method: 'inspect', title: 'Inspect workspace state', description: 'Recover the workspace base, current revision, changed files, instructions, and job associations.', schema: object({ workspaceId: id }) },
  workspace_apply: { method: 'apply', write: true, destructive: true, title: 'Apply source edits with preconditions', description: 'Apply a batch of writes, exact-text patches, renames, or deletes to an idle workspace. Require its current expectedRevision and each existing file SHA-256; write with expectedSha256=null creates a file. Patches require one exact occurrence. Use a durable idempotencyKey; stale content is rejected.', schema: object({ workspaceId: id, expectedRevision: revision, idempotencyKey: key, changes: z.array(change).min(1).max(32) }) },
  workspace_diff: { method: 'diff', title: 'Review the workspace diff', description: 'Read a paginated diff against the immutable base, including new/deleted files and mode changes. Use expectedRevision to keep pages consistent.', schema: object({ workspaceId: id, expectedRevision: revision.optional(), cursor, limit: z.number().int().min(256).max(32768).default(16384) }) },
  workspace_remove: { method: 'remove', write: true, destructive: true, title: 'Preview or remove a disposable workspace', description: 'Preview removal by default. To remove, set preview=false with expectedRevision and idempotencyKey. Dirty work additionally requires discard=true. Active jobs prevent removal; stored operation and job receipts remain.', schema: object({ workspaceId: id, expectedRevision: revision, preview: z.boolean().default(true), discard: z.boolean().default(false), idempotencyKey: key.optional() }) },
  operations_list: { method: 'operationsList', title: 'Recover mutation receipts', description: 'List persisted workspace mutation receipts, optionally for one workspace. Inspect these after uncertain responses.', schema: object({ workspaceId: id.optional(), cursor, limit: page }) },
  operation_read: { method: 'operationRead', title: 'Read a mutation receipt', description: 'Read the recorded outcome of an identified mutation without repeating it.', schema: object({ operationId: id }) },
  job_start: { target: 'jobs', method: 'start', write: true, destructive: true, title: 'Run a sandboxed coding command', description: 'Queue argv in one isolated workspace at expectedRevision. Returns a durable job ID promptly; observe it with job_status and job_logs. Network is disabled. One active job at a time. Optional artifactPaths name files to preserve after completion. Retry uncertain submissions with identical inputs and the SAME idempotencyKey.', schema: object({ workspaceId: id, expectedRevision: revision, idempotencyKey: key, label: z.string().max(80).default(''), argv: z.array(z.string().max(8192)).min(1).max(64), cwd: z.string().max(512).default('.'), env: z.partialRecord(z.enum(['CI', 'NODE_ENV', 'TZ', 'LANG', 'LC_ALL', 'FORCE_COLOR', 'NO_COLOR', 'PYTHONHASHSEED', 'PYTHONDONTWRITEBYTECODE']), z.string().max(1000)).default({}), timeoutSeconds: z.number().int().min(1).max(900).default(300), artifactPaths: z.array(path).max(16).default([]) }) },
  jobs_list: { target: 'jobs', method: 'list', title: 'Recover coding jobs', description: 'List persisted coding jobs, optionally for a workspace. Completed or interrupted commands are never automatically rerun.', schema: object({ workspaceId: id.optional(), cursor, limit: page }) },
  job_status: { target: 'jobs', method: 'get', title: 'Read coding job status', description: 'Read job timestamps, command, exit status, interruption or cancellation, and resulting workspace revision.', schema: object({ jobId: id }) },
  job_logs: { target: 'jobs', method: 'logs', title: 'Read bounded command output', description: 'Read persisted ordered job output and lifecycle records. Follow nextCursor while hasMore; truncation is explicit. A caught-up running job can produce later records.', schema: object({ jobId: id, cursor, limit: z.number().int().min(1).max(100).default(50) }) },
  job_cancel: { target: 'jobs', method: 'cancel', write: true, destructive: true, title: 'Cancel a coding job', description: 'Request cancellation of an existing command. The worker records its actual outcome; terminal jobs stay terminal.', schema: object({ jobId: id }) },
  artifact_list: { target: 'jobs', method: 'artifactList', title: 'List preserved job artifacts', description: 'List files copied into protected result storage after the job ended, including sizes and hashes.', schema: object({ jobId: id }) },
  artifact_read: { target: 'jobs', method: 'artifactRead', title: 'Read a preserved artifact', description: 'Read a bounded page of a preserved artifact by its identifier. Source access is authenticated and independent of the original chat.', schema: object({ jobId: id, artifactId: z.string().min(1).max(128), cursor, limit: z.number().int().min(1).max(32768).default(16384) }) }
};

export function parseCodeCall(action, args) {
  const tool = Object.hasOwn(codeTools, action) ? codeTools[action] : undefined;
  if (!tool) throw Object.assign(new Error('Unknown coding action'), { code: 'UNKNOWN_ACTION' });
  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) throw Object.assign(new Error('Invalid coding arguments: ' + parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 500)), { code: 'INVALID_ARGUMENT' });
  return { tool, args: parsed.data };
}
