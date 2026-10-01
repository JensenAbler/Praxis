# Local usage telemetry

Call `usage_summary` (default last 7 days, top 20 tools; maximum 30 days/50 tools) on each Praxis endpoint. Compare failures/recovery strategies, p95 server handling time, response bytes, continuation counts, truncated results and pending waits to prioritize improvements. Use `observations_list` for individual sanitized receipts. ChatGPT and Claude endpoint stores are separate; reports do not claim global coverage.

Telemetry reuses local observations.sqlite, keeps at most 10,000 records and 30 days, and never sends analytics externally. New records pass a storage allowlist. No arguments, tokens, command/file contents, payloads or workflow IDs are collected. Read continuations are boolean signals, never cursor values. Error codes are classified; messages are excluded. Recovery counts indicate retry friction but do not establish actual retries or distinct workflows. Old records without durations are excluded from latency percentiles. HTTP records share retention but do not count as tool calls.

Recording failure cannot change a completed tool outcome. SQLite uses a short 50ms busy timeout. Retention is pruned on writes and reads; reusable database pages and WAL checkpoints keep storage stable under continuous usage. Reports disclose retained coverage and omitted tools, so a busy period is not misrepresented as a complete historical sample.
