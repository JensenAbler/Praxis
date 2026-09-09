import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';

export const requestContext = new AsyncLocalStorage();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ERROR_TYPES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'AggregateError', 'WorkspaceError', 'CodeJobError', 'RunnerError']);
const SYSTEM_CODES = new Set(['ENOENT', 'ENOSPC', 'EACCES', 'EPERM', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ERR_SQLITE_ERROR', 'SQLITE_BUSY', 'SQLITE_FULL', 'SQLITE_CORRUPT']);

export function correlationId(value) { return typeof value === 'string' && UUID.test(value) ? value : randomUUID(); }

// Never log error.message, stack text, arguments, token data, or private paths.
// A fingerprint groups the same call site without exposing its stack frames.
export function diagnosticRecord(event, error, context = requestContext.getStore() || {}) {
  const frames = typeof error?.stack === 'string' ? error.stack.split('\n').filter(line => /^\s+at /.test(line)).join('\n') : '';
  return { event, requestId: correlationId(context.requestId),
    ...(context.httpRequestId && UUID.test(context.httpRequestId) ? { httpRequestId: context.httpRequestId } : {}),
    ...(context.action ? { action: context.action } : {}),
    errorType: ERROR_TYPES.has(error?.name) ? error.name : 'Error',
    ...(SYSTEM_CODES.has(error?.code) ? { systemCode: error.code } : {}),
    ...(frames ? { stackFingerprint: createHash('sha256').update(frames).digest('hex').slice(0, 24) } : {}) };
}

export function errorRecovery(code, readOnly = false) {
  const guidance = {
    INVALID_ARGUMENT: ['correct_arguments', 'Read the named field constraints or omit optional page sizes. Correct the rejected arguments before submitting again.'],
    VALIDATION_ERROR: ['correct_arguments', 'Correct the rejected source selection or arguments using the tool description before submitting again.'],
    PATH_REJECTED: ['correct_arguments', 'Use an allowed source-relative path from files_list. Absolute paths, traversal, and protected runtime paths are unavailable.'],
    UNKNOWN_ACTION: ['inspect_capabilities', 'Read capabilities and use an installed tool name.'],
    AUTHORIZATION_REQUIRED: ['reconnect', 'Reconnect and grant the required permission.'],
    FIXTURE_ERROR: ['do_not_retry', 'Continue by calling probe_capabilities; this intentional error will not succeed on retry.'],
    IDEMPOTENCY_CONFLICT: ['recover_original', 'Recover the original operation and inputs for that key. Use a new key only for an intentionally new operation.'],
    REVISION_CONFLICT: ['refresh_state', 'Inspect the current workspace and receipts before preparing a new edit against the current revision.'],
    STALE_REVISION: ['refresh_state', 'Inspect the current workspace revision and saved jobs before preparing a new command submission.'],
    HASH_CONFLICT: ['refresh_state', 'Read the current file hash and inspect receipts before preparing a new edit.'],
    PATCH_CONFLICT: ['refresh_state', 'Read the file and check each exact-text match against earlier staged patches. Prepare a corrected batch after recovering any uncertain receipt.'],
    LIMIT_EXCEEDED: ['correct_arguments', 'Inspect capabilities for the exceeded limit. Use bounded patches for large existing files and keep the resulting file within its byte limit.'],
    ACTIVE_JOB_LIMIT: ['observe_active_job', 'Use jobs_list to locate the active job across workspaces, then observe job_status. After it is terminal, recover or retry the original request with the same key and inputs.'],
    WORKSPACE_BUSY: ['observe_active_job', 'Inspect workspace jobs and wait for the existing active job to become terminal.'],
    RUNNER_BUSY: ['observe_active_job', 'Inspect existing jobs; the execution worker is still reconciling an earlier operation. Do not recreate it.'],
    NOT_FOUND: ['check_identifier', 'Recover identifiers through project, workspace, job, operation, or artifact listings; do not recreate uncertain work.'],
  };
  const [strategy, recovery] = guidance[code] || (readOnly
    ? ['retry_read', 'Retry this read-only call. If it keeps failing, retain its requestId for diagnosis.']
    : ['recover_before_retry', 'The outcome may be uncertain. Inspect existing workspaces, jobs, and mutation receipts. Retry only with the original idempotency key and identical inputs; do not recreate ambiguous work.']);
  return { recovery, retry: { strategy, automatic: false } };
}
