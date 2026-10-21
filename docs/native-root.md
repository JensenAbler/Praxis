# Native root workflow — 0.6.0

Required source workflow: recover the registered project and existing Praxis workspaces; sync main and create a managed workspace only when a fresh base is needed. Make source changes and run checks inside that Praxis workspace, review the diff, then commit and push from that workspace. Fast-forward the registered deployment on Alpha to the published commit and verify it. Do not edit deployed source in place or create ad hoc clones, repositories, or worktrees under /opt or elsewhere. Create a new repository only when the user explicitly requests one; a request to fix or improve an existing project is not that authorization. This workflow applies to Praxis itself. Native root access remains available for read-only diagnosis and authorized operations; it does not waive the source workflow.

This is a required agent workflow, not an OS sandbox around root commands. Praxis 0.6 provides native root jobs for Alpha. The owner requested full host access so a conversational model can build projects, diagnose production, install dependencies, publish changes, and maintain Praxis without a separate Codex operator.

**Qualification status:** `app-native-d75788a6e2e6` is deployed on Alpha. Exact-source Linux qualification passed 200 Node tests, 157 Python tests, and authenticated MCP checks. Separate real systemd tests and [owner-authenticated live acceptance](evidence/native-root-live.json) passed, including backend restart survival and fresh-client recovery. ChatGPT's Praxis tool definitions were refreshed. A new native iPhone task remains untested.

## Projects and paths

`host_project_attach` stores an existing absolute directory and optional named data roots. The returned `hostProjectId` is a separate UUID from legacy project IDs and workspace IDs. `host_projects_list` recovers those registrations in a later conversation. Registrations live in the server data directory, outside source control.

For example, attach existing directories with:

```json
{
  "name": "host_project_attach",
  "arguments": {
    "name": "Example",
    "path": "/srv/example",
    "dataRoots": {
      "recordings": "/srv/example-data/recordings",
      "logs": "/var/log/example"
    }
  }
}
```

The same name and paths returns the existing registration. A name already pointing elsewhere requires `replace: true` to change it. This updates discovery only; it does not move files or change Git state.

Host file calls accept either an absolute `path`, or `hostProjectId` with a project-relative `path`. Add `dataRoot` to resolve relative paths from a named data directory. Parent paths and symlinks resolve normally; attached directories are not access boundaries. Native commands can also use an absolute `cwd` without any registration.

Alpha now has discoverable `podcast-discord` and `Praxis` host registrations. The podcast registration points to the deployed source and names its content, recordings, episode plans, and log directories. The Praxis registration points to the installed application and names its control, state, job, and home directories. These are live directories; registration does not create a development copy. Develop source only in a managed Praxis workspace; these deployment attachments are for operations and diagnosis.

## File tools

| Tool | Behavior |
| --- | --- |
| `host_files_list` | Paginated directory entries; optional recursion and symlink traversal. |
| `host_path_info` | Existence, resolved path, type, size, permissions, timestamps, and optional file hash. |
| `host_file_read` | UTF-8 or base64 byte pages from files of any size. |
| `host_search` | Literal byte search with file/byte scan budgets, byte offsets, and bounded excerpts. |
| `host_file_write` | Replace or append text/binary content; optional hash, append-offset, and permission preconditions. |
| `host_file_patch` | Streamed exact-text replacement requiring one matching occurrence. |

No filename or extension filter excludes `.env`, `.git`, transcripts, recordings, logs, images, or generated output. Requested content is returned without redaction. Tool implementations do not copy that content into diagnostic logs.

Copy returned pagination cursors exactly. File reads use byte offsets; UTF-8 pages avoid splitting valid characters. Use `encoding: "base64"` when exact arbitrary bytes matter. `includeSha256: true` streams the complete file without a source-size ceiling. Hashing a large file performs a complete read, even when the returned content page is small.

Writes follow a symlink's target. Regular-file replacement uses a temporary sibling and atomic rename, preserving existing mode and ownership. Exact-text patching streams the file rather than loading it all into memory. `expectedSha256` rejects stale content; `null` on a write requires a missing file. Append uploads can supply the expected current `offset` so repeating a chunk after success is rejected instead of duplicating its bytes. Each request still fits within the transport's message budget; chunked reads, appends, patches, and native commands handle larger work.

Observations are marked `live-unverified`. Other processes may change files during reads, between pages, or around a precondition check. These tools do not claim a repository snapshot or lock external processes. Reads remain available while coding jobs are active.

## Native command jobs

`job_start` accepts exact `argv`. It does not imply a shell. Use an explicit shell when shell syntax is needed:

```json
{
  "name": "job_start",
  "arguments": {
    "idempotencyKey": "example:validate:01",
    "label": "Validate example",
    "workspaceId": "<returned-workspace-uuid>",
    "expectedRevision": "<current-workspace-revision>",
    "argv": ["bash", "-lc", "npm test && git diff --check"],
    "timeoutSeconds": 0
  }
}
```

Jobs run as root under independent systemd supervision with normal host networking and persistent home/cache directories. There is no Praxis CPU, memory, process-count, storage, concurrency, or elapsed-time quota. A positive `timeoutSeconds` requests a deadline; zero means none. Operating-system capacity and the requested deadline still determine actual execution outcomes.

Use `hostProjectId` to select an attached project, with optional `dataRoot` and relative `cwd`. Omitting both an attached project and an absolute path uses the persistent native job home. Explicit environment overrides are supported and persisted in the job request. Installed credential files can be used directly by ordinary tools.

New repository creation requires an explicit user request and the registered project creation workflow. Native jobs can run package managers, Git, SSH, service managers, database tools, and installed browser automation. Browser operation is a host-program capability, not a claim that a separate browser viewer or native browser tool exists.

## Dependencies, publication, and operation

Use ordinary `npm install`, `npm ci`, Python environments and `pip`, system package managers, or other project tools. Host networking supports private registries, Git dependencies, and package-script downloads using available credentials. Caches and dependency trees persist. No copied container dependency tree or prepared bundle is needed to run or deploy a native project directly.

The optional `dependency_prepare` adapter still seals a workspace's installed npm tree and exact manifest hashes. Native preparation records `executionMode: "native"` and the host execution identity while retaining the legacy manifest fields. It has no legacy file-size, archive-size, file-count, or retained-bundle quota. Legitimate installed hardlinks are copied as independent regular archive members. A deployment adapter can still require its own portable archive layout and runtime compatibility; direct native commands do not require that adapter.

Review, commit, and push from the managed Praxis workspace to `main` by default. Fast-forward the deployment to that published commit using the project's deployment procedure. Saved source, process output, and job status provide recoverable evidence. A successful service start establishes process state; application-level checks establish the corresponding live behavior.

Native root jobs can maintain all of Praxis: its application, tool schemas, gateway, authentication, configuration, deployment helpers, and updater. Existing staged release tools are an optional activation and recovery workflow. They no longer define an authority boundary for native execution.

## Recovery and output

Record the job ID returned by `job_start`. In a fresh conversation, use `host_projects_list`, `jobs_list`, and `job_status` to recover existing work. After an uncertain submission, preserve the original idempotency key and arguments. Existing terminal or ambiguous executions are not automatically launched again.

`job_wait` returns the same compact status once the job is terminal, or after at most 15 seconds with `wait.terminal: false`; call it again rather than polling `job_status`. `git_operation_wait` and `praxis_release_wait` do the same for Git operations (sync, commit, push, deploy) and release plan/apply/rollback operations. The bound stays inside the gateway's 20-second backend timeout. `job_status` reports lifecycle timestamps, actual exit status, recent output, and raw log paths. `job_logs` provides indexed head/tail excerpts and literal filtering. These indexed excerpts retain bounded sizes so routine inspection stays usable.

Native workers also persist complete stdout, stderr, and ordered event files without a retention-size cap. Use the `rawLogs` paths returned by status with `host_file_read` or `host_search` when excerpts are insufficient. Raw files and jobs survive phone disconnects and backend restarts. Missing or ambiguous execution evidence remains an uncertain outcome; it is not proof that rerunning a command is harmless.

## Legacy compatibility

Immutable snapshots, workspace edits, historical replay tools, Git publication receipts, fixed deployment adapters, and the original bounded probe remain available. Existing receipts keep their historical identity and execution facts. Legacy workspace commands use `workspaceId` plus `expectedRevision`; direct host jobs do not require a workspace revision.

Snapshot tooling retains its source-format and revision semantics. Use managed workspaces for source work and direct host tools for operational data. The earlier [operations guide](operations.md), [dependency adapter](dependencies.md), [production recovery adapter](production-recovery.md), and [self-update adapter](self-improvement.md) describe those specific workflows and historical deployment arrangements.

## Tool compatibility gate

Routine self-update refuses a release whose tool manifest removes a tool, changes a permission annotation, changes an existing argument's schema, or adds a required argument (a zod `.default()` exports as required). `scripts/check-manifest-compat.js` applies the same rule, and `npm test` runs it against `/srv/praxis-app/current/coding-tools.json` whenever that file exists, so checks inside a Praxis workspace and the release-plan build both fail early. Elsewhere, run `npm run check:manifest -- <manifest.json>` against the live release's manifest.

## Control plane activation

The gateway, Claude facade, and Git broker run from `/srv/praxis-control/current`, which routine releases do not replace. Both MCP entry points re-read `/srv/praxis-app/current/coding-tools.json` when it changes, so new application tools reach ChatGPT and Claude without touching the control slot. The facade keeps its last good tool list if a new manifest is unreadable.

To change control code (gateway, facade, broker, probe tools), first activate the commit as an application release through `praxis_release_plan`/`praxis_release_apply`, then run as root:

    /srv/praxis-app/current/deploy/activate-control.py <live app release name>

It promotes only the live application release, which has already passed the updater's tests, authenticated MCP checks, and manifest gate. It refuses while Git operations are in flight, copies the tree to `/srv/praxis-control/releases/<commit12>`, swaps the symlink atomically, relabels `control-<commit12>` in `/etc/praxis-updater/control.env` and `/etc/praxis-git/config.json`, restarts `praxis-git`, `praxis-probe`, and `praxis-claude-facade`, and checks each service's health. A failed check restores the previous release, label, and services. Every attempt is appended to `/var/lib/praxis-control/control-history.jsonl`.

## Durable resumable uploads

Use the existing `host_file_write` tool with `transferAction`. Ordinary replace/append calls remain compatible.
Choose a client-generated UUID `transferId` once and preserve it through disconnections and retries.

1. `begin`: supply `transferId`, destination `path` (or attached project/data root), optional `expectedSha256` of the original destination, `permissions`, and `createParents`. You may declare uploaded `totalBytes` and `sha256` now or at finalize. A repeated begin with identical arguments returns the existing receipt; changed arguments conflict.
2. `chunk`: supply only `transferId`, decoded byte `offset`, `content`, optional `encoding: "base64"` and `chunkSha256`. Send contiguous chunks from returned `nextOffset`. UTF-8 offsets count encoded bytes, not characters. An exact duplicate range is acknowledged without writing twice; differing retries and gaps are rejected. Prefer base64 for binary or splitting arbitrary UTF-8 bytes.
3. `status`: supply `transferId` to recover the durable state and next acknowledged byte offset. No entire-file rehash is needed during normal upload.
4. `finalize`: supply the exact uploaded `totalBytes` and whole uploaded `sha256` unless supplied at begin. These differ from `expectedSha256`, which constrains the existing destination. Begin reports `preconditionVerified: false`: it checks target existence/type but defers whole destination hashing to finalize. Finalization returns `verifying`/`pending: true` promptly and streams verification in the background. Poll status until `completed`; a pending receipt is not success. After a process interruption, status reports `resumeRequired: true`; retry finalize with the same ID to continue safely. Failure receipts include `lastError` without payload or filesystem error details.
5. `abort`: removes only staged bytes, is repeatable, and never deletes a completed destination. Completed receipts persist for recovery and safe retries.

There is no arbitrary total-file quota. Byte positions use JavaScript safe integers (up to 2^53-1); actual filesystem capacity applies. Each request must fit the transport's resource-admitted budget. Use the advertised `recommendedChunkBytes` when present; 64 KiB decoded chunks are a conservative starting point otherwise. JSON escaping can expand text up to sixfold, and base64 expands binary by about one third. Reduce the chunk size and retry the same unacknowledged offset if a request is rejected for resource pressure.

Chunks are fsynced before the durable offset advances. Only unacknowledged crash-tail bytes may be discarded. Payloads remain in a temporary sibling on the target filesystem, not in memory or SQLite; each append checks current free space and reports ENOSPC without truncating the destination. Verification uses fixed-size read buffers. Final replacement preserves current mode/ownership unless explicit permissions were requested, rechecks the original destination hash immediately before replacement, and atomically renames then fsyncs the containing directory. The staged inode and verified hash are journaled before rename, so a crash after rename can be reconciled without replacing the file again.

Transfers support regular or missing files, not devices/FIFOs. Symlink targets are resolved at begin and a changed target is rejected at finalize. External processes are not locked; they may still race filesystem checks, just as with ordinary host writes. Receipts describe what completed, not a guarantee that another process has not subsequently changed the destination. Linux process-start identity and SQLite compare-and-delete locks prevent simultaneous upload operations and safely reclaim locks left by dead processes. Transfer records are owner-scoped and persistent; callers should abort abandoned uploads to release staging disk space.

Verification uses one shared disk worker per server process: status returns queued:true while waiting. This limits concurrent disk/CPU work, not file size. Queued verification survives as a durable resumable receipt across process restart. Abort cancels queued work and cooperatively interrupts active hash reads before replacement; an already completed rename is never undone. This scheduler does not coordinate independent server processes, whose per-transfer SQLite locks still prevent concurrent changes to the same transfer.
Completed receipts are historical completion records, not verification that the current destination is unchanged.

Graceful server shutdown cooperatively stops pending verification without aborting uploads or deleting staging; resumeRequired receipts can be resumed with finalize after restart.
