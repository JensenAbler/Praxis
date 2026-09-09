# Tool quality improvements in 0.3

This update follows the [six frozen phone replays](evidence/replay-batch-v1-results.md). It reduces recurring editing workarounds and the amount of output needed to understand a job. It does not change the sandbox image, production access, or active-job policy.

## Editing

Use `workspace_apply` for small exact-text patches even when the existing file exceeds the full-write input limit. The existing 2 MiB file limit still applies. Several patches to one file can share a batch: use the original file SHA-256 for every patch, in order. Each match is checked against staged text and the entire batch is validated before any effect. An interrupted operation recovers its single final effect per file without reapplying earlier patches.

## Understanding a job

Start with `job_status`. It returns the recorded status, exit code, revision, an abbreviated command, a recent-output excerpt, and explicit retention facts. `includeCommand: true` retrieves the original full argv. The excerpt is bounded to 12 records and approximately 4 KiB of serialized record data. It does not interpret test output or turn a failed suite into success.

`job_logs` retains its default forward `head` view and original record sequences. New jobs also keep a separate rolling `tail` of at most 64 KiB or 256 output fragments. `view: "tail"` begins at the newest retained page; returned cursors retrieve older pages, each internally chronological. Tail sequences are independent of head sequences. Add a literal `query` or exact `stream` filter to read relevant retained fragments. Queries do not search omitted output or span fragment boundaries.

The original head remains bounded at 1 MiB or 8,192 output records, with lifecycle records preserved separately. Collection continues after that cap so recent final output can survive. Terminal collection has a bounded sequential-read budget followed, when necessary, by a bounded seek to the available container-log tail. `outputRetention` reports head truncation, runner loss, observed bytes, tail eviction, and skipped raw container-log bytes separately. A bounded tail cannot guarantee retention of every late message or reconstruct bytes already lost upstream.

Old completed jobs keep their original records and expose a recent head excerpt with `mode: "legacy-head-only"`. Previously lost summaries stay unavailable. No historical job is rerun or rewritten to populate a new tail.

## Tool contracts and failures

Descriptions state units, defaults, and ranges. Diff pagination adds `maxBytes`; old `limit` remains accepted. Omit optional page sizes for the defaults, then copy returned cursors exactly. A cursor is not a count of returned rows.

Authenticated argument validation now produces the normal structured error envelope, with request ID, safe field constraints, and recovery guidance. Gateway and backend use the same advertised schema, and the backend checks authorization and arguments independently. Diagnostics correlate failures without logging source, arguments, token values, raw error messages, or stack text. Diagnostic audit failure cannot hide an already completed mutation; durable operation receipts remain authoritative.

The shared one-active-job limit remains. A rejection identifies the blocking job only when it belongs to the requesting owner. Recovery guidance asks the caller to observe it and preserve the original request identity.

## Verification scope

Regression tests cover atomic edits, large Unicode files, journal interruption, legacy records, noisy-output retention, UTF-8 continuation, manager recreation, ownership, pagination bounds, precise MCP discovery, and structured errors. The authenticated Linux fixture uses disposable synthetic source, temporary signing keys, and the real fixed-image Podman runner. It exercises large-file multi-patch editing, gateway recovery, output overflow, filtered tail reads, artifacts, and the full-command opt-in.

A subsequent native phone comparison is still needed to measure changes in call count, retries, response volume, and time. API fixture evidence is not a native-client performance result.
