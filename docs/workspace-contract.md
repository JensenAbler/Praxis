# Workspace source and mutation contract

The coding service owns immutable project exports and disposable workspace directories. Public source tools never accept host paths or run Git, hooks, filters, or repository code. A workspace starts at a registered project revision; its current revision is a SHA-256 digest of a protected, sorted source manifest. The baseline manifest and operation journals stay outside the command's mounted workspace. Project discovery returns compact summaries; use `project_inspect` to read a selected project's complete instructions and validation commands.

`workspace_create`, `workspace_apply`, and confirmed `workspace_remove` return a durable receipt with `operationId`, `workspaceId`, `kind`, `status`, and `result`. The successful result contains the current `revision`. Retrying identical arguments and the same idempotency key returns the same receipt. A conflicting reuse is rejected. Mutation plans are committed before file effects; recovery accepts only the recorded before/after content hashes and replays unfinished work. A partial operation remains `prepared` and its workspace remains `recovering` until recovery completes. It is never reported as a successful edit.

Writes, exact-text patches, renames, and deletes require the current workspace revision and file hashes; a create uses `expectedSha256: null`. Each path may be touched once in a batch, ancestor/descendant conflicts are rejected, and all content and quota preconditions are checked before the journal is prepared. An exact-text patch must match once. Commands and source operations use the same database lock; queued, starting, running, and canceling jobs exclude source reads, edits, diff review, and removal. `workspace_inspect` remains available during these jobs: it returns the last stored revision with `revisionVerified: false`, `dirty: null`, and active job IDs/statuses, without scanning files that the command may be changing. After the command ends, inspection verifies the current source revision again.

Read results include numbered lines, a file SHA-256, and a source revision. Continue with `nextPosition.line` and `nextPosition.column`, supplying them as `startLine` and `startColumn`; this also recovers long lines. Columns count UTF-16 code units and generated page boundaries preserve surrogate pairs. Search is literal and returns a bounded excerpt around each matching line. Workspace and operation lists use opaque numeric row cursors, newest first. File lists and search use result offsets.

Diffs use jsdiff with three context lines, Git path quoting, executable modes, additions, deletions, and missing-newline markers. Binary and unsafe entries are identified without exposing their contents. A bounded comparison that cannot finish falls back to a complete file replacement; the response reports the fallback count. Per-file output is streamed into one private cache, reused only at the same workspace revision. Diff cursors count UTF-8 bytes; page boundaries preserve characters. Use `expectedRevision` on follow-up pages. The first page includes up to 100 change summaries; the complete patch remains pageable.

Source manifests omit `node_modules`, `.cache`, `.npm`, `.pytest_cache`, `__pycache__`, `.venv`, and `venv`, as well as Git internals, environment files, common private key files, and credential files. An omitted dependency directory may be a link to a read-only dependency tree in the runner image. File tools reject links and protected paths even when explicitly requested. Visible symlinks, hard links, and special files are review issues, never followed. An oversized or unreadable file produced by a command may prevent source inspection, but the stored revision and safe workspace root remain usable for a sandbox cleanup command.

Current manager limits:

| Resource | Limit |
| --- | --- |
| Source entries, including directories | 20,000 per workspace |
| Reviewable source | 128 MiB per workspace, 2 MiB per file |
| Read page | 200 lines and 32,768 UTF-16 code units |
| Text write | 131,072 UTF-16 code units |
| Edit batch | 32 changes and 256 KiB of serialized change arguments |
| Live workspaces | 20 across this service |
| Mutation receipts | 10,000 across this service |
| Stored request and mutation plan data | 128 MiB in aggregate |
| Diff cache | One cache, at most 600 MiB |

Quota errors are explicit and require owner maintenance or a sandbox cleanup command. Workspace removal previews by default, requires a current revision, and additionally requires `discard: true` for source changes. Stored job and mutation receipts remain recoverable after removal. Source quotas exclude the dependency/cache directories above; the runner's OS storage boundary separately bounds all writable files.

The focused workspace tests exercise ownership, source discovery, edit conflicts, path/link rejection, active-job exclusion, mutation recovery after a partial effect, contextual diff size, Unicode pagination, prototype-like filenames, and removal receipts. They are local API tests, not evidence of a completed phone coding run.
