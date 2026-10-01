const CODES = new Set('INTERNAL_ERROR BACKEND_UNAVAILABLE INVALID_ARGUMENT VALIDATION_ERROR PATH_REJECTED UNKNOWN_ACTION AUTHORIZATION_REQUIRED FIXTURE_ERROR IDEMPOTENCY_CONFLICT REVISION_CONFLICT STALE_REVISION HASH_CONFLICT PATCH_CONFLICT LIMIT_EXCEEDED ACTIVE_JOB_LIMIT WORKSPACE_BUSY RUNNER_BUSY NOT_FOUND'.split(' '));
const STRATEGIES = new Set('correct_arguments inspect_capabilities reconnect do_not_retry recover_original refresh_state observe_active_job check_identifier retry_read recover_before_retry'.split(' '));
const symbol = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,80}$/.test(value) ? value : undefined;
const number = value => Number.isFinite(value) && value >= 0 ? Math.min(value, 1e12) : undefined;
// Rebuild from an allowlist at the storage boundary; never spread a payload.
export function sanitizeObservation(record) {
  const clean = {};
  for (const key of ['requestId', 'httpRequestId', 'tool', 'era', 'kind', 'method']) {
    const value = symbol(record[key]); if (value !== undefined) clean[key] = value;
  }
  for (const key of ['durationMs', 'resultJsonBytes', 'status']) {
    const value = number(record[key]); if (value !== undefined) clean[key] = value;
  }
  for (const key of ['ok', 'aborted', 'paginated', 'continuation', 'moreAvailable', 'truncated', 'waitPending']) {
    if (typeof record[key] === 'boolean') clean[key] = record[key];
  }
  if (STRATEGIES.has(record.retryStrategy)) clean.retryStrategy = record.retryStrategy;
  if (record.errorCode === null) clean.errorCode = null;
  else if (record.errorCode) clean.errorCode = CODES.has(record.errorCode) ? record.errorCode : 'OTHER_ERROR';
  if (typeof record.protocol === 'string' && /^(?:\d{4}-\d{2}-\d{2}|unspecified)$/.test(record.protocol)) clean.protocol = record.protocol;
  return clean;
}
export function usageSignals(args, result) {
  return {
    paginated: Object.hasOwn(result, 'nextCursor') || Object.hasOwn(result, 'nextPosition'),
    continuation: (typeof args?.cursor === 'string' && args.cursor.length > 0) || (typeof args?.cursor === 'number' && args.cursor > 0) ||
      (typeof args?.startLine === 'number' && args.startLine > 1) ||
      (typeof args?.startColumn === 'number' && args.startColumn > 1),
    moreAvailable: typeof result.hasMore === 'boolean' ? result.hasMore : result.nextPosition != null || (typeof result.nextCursor === 'string' ? result.nextCursor.length > 0 : result.nextCursor != null),
    truncated: result.truncated === true || result.issuesTruncated === true,
    waitPending: result.wait?.terminal === false || result.wait?.settled === false,
  };
}
export function summarizeUsage(rows, limit) {
  const groups = new Map();
  for (const row of rows) {
    const r = sanitizeObservation(JSON.parse(row.body));
    if (r.kind !== 'tool' || !r.tool) continue;
    let g = groups.get(r.tool);
    if (!g) groups.set(r.tool, g = { tool: r.tool, calls: 0, failures: 0, durations: [], resultBytes: 0,
      continuations: 0, pagesWithMore: 0, truncatedResults: 0, pendingWaits: 0, errors: {}, strategies: {} });
    g.calls++; g.failures += r.ok === false ? 1 : 0;
    if (r.durationMs !== undefined) g.durations.push(r.durationMs);
    g.resultBytes += r.resultJsonBytes || 0;
    g.continuations += r.continuation ? 1 : 0; g.pagesWithMore += r.moreAvailable ? 1 : 0;
    g.truncatedResults += r.truncated ? 1 : 0; g.pendingWaits += r.waitPending ? 1 : 0;
    if (r.errorCode) {
      g.errors[r.errorCode] = (g.errors[r.errorCode] || 0) + 1;
      const strategy = r.retryStrategy || 'legacy_unspecified';
      g.strategies[strategy] = (g.strategies[strategy] || 0) + 1;
    }
  }
  const tools = [...groups.values()].map(({ durations, strategies, ...g }) => {
    durations.sort((a,b) => a-b);
    const percentile = p => durations.length ? durations[Math.ceil(durations.length*p)-1] : null;
    return { ...g, failureRate: g.failures/g.calls, measuredDurations: durations.length,
      meanDurationMs: durations.length ? Math.round(durations.reduce((a,b)=>a+b,0)/durations.length) : null,
      p50DurationMs: percentile(.5), p95DurationMs: percentile(.95),
      recoveryStrategies: Object.entries(strategies).map(([strategy,count]) => ({ strategy, count })) };
  }).sort((a,b)=>b.calls-a.calls || a.tool.localeCompare(b.tool));
  return { calls: tools.reduce((s,g)=>s+g.calls,0), failures: tools.reduce((s,g)=>s+g.failures,0),
    distinctTools: tools.length, tools: tools.slice(0,limit), omittedTools: Math.max(0,tools.length-limit),
    interpretation: 'Failure and recovery counts indicate workflow friction, not observed retries. Continuations and pending waits are call counts, not unique workflows. Durations cover server handling only. Results describe retained endpoint-local observations, not all historical usage.' };
}
