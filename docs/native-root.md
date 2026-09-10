# Native root workflow — 0.6.0

Praxis 0.6 uses native root jobs and direct host files as its primary interface to Alpha. The owner requested full host access so a conversational model can build projects, diagnose production, install dependencies, publish changes, and maintain Praxis without a separate Codex operator.

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

Alpha now has discoverable `podcast-discord` and `Praxis` host registrations. The podcast registration points to the deployed source and names its content, recordings, episode plans, and log directories. The Praxis registration points to the installed application and names its control, state, job, and home directories. These are live directories; registration does not create a development copy. An agent can create an ordinary Git checkout wherever appropriate and attach it separately.

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
    "cwd": "/srv/example",
    "argv": ["bash", "-lc", "npm test && git diff --check"],
    "timeoutSeconds": 0
  }
}
```

Jobs run as root under independent systemd supervision with normal host networking and persistent home/cache directories. There is no Praxis CPU, memory, process-count, storage, concurrency, or elapsed-time quota. A positive `timeoutSeconds` requests a deadline; zero means none. Operating-system capacity and the requested deadline still determine actual execution outcomes.

Use `hostProjectId` to select an attached project, with optional `dataRoot` and relative `cwd`. Omitting both an attached project and an absolute path uses the persistent native job home. Explicit environment overrides are supported and persisted in the job request. Installed credential files can be used directly by ordinary tools.

New project creation uses ordinary filesystem and Git commands, followed by an optional attachment for discovery. Native jobs can run package managers, Git, SSH, service managers, database tools, and installed browser automation. Browser operation is a host-program capability, not a claim that a separate browser viewer or native browser tool exists.

## Dependencies, publication, and operation

Use ordinary `npm install`, `npm ci`, Python environments and `pip`, system package managers, or other project tools. Host networking supports private registries, Git dependencies, and package-script downloads using available credentials. Caches and dependency trees persist. No copied container dependency tree or prepared bundle is needed to run or deploy a native project directly.

The optional `dependency_prepare` adapter still seals a workspace's installed npm tree and exact manifest hashes. Native preparation records `executionMode: "native"` and the host execution identity while retaining the legacy manifest fields. It has no legacy file-size, archive-size, file-count, or retained-bundle quota. Legitimate installed hardlinks are copied as independent regular archive members. A deployment adapter can still require its own portable archive layout and runtime compatibility; direct native commands do not require that adapter.

Review with ordinary Git commands, commit, and push to `main` by default. Deploy using the project's real procedure, including service commands as needed. Saved source, process output, and job status provide recoverable evidence. A successful service start establishes process state; application-level checks establish the corresponding live behavior.

Native root jobs can maintain all of Praxis: its application, tool schemas, gateway, authentication, configuration, deployment helpers, and updater. Existing staged release tools are an optional activation and recovery workflow. They no longer define an authority boundary for native execution.

## Recovery and output

Record the job ID returned by `job_start`. In a fresh conversation, use `host_projects_list`, `jobs_list`, and `job_status` to recover existing work. After an uncertain submission, preserve the original idempotency key and arguments. Existing terminal or ambiguous executions are not automatically launched again.

`job_status` reports lifecycle timestamps, actual exit status, recent output, and raw log paths. `job_logs` provides indexed head/tail excerpts and literal filtering. These indexed excerpts retain bounded sizes so routine inspection stays usable.

Native workers also persist complete stdout, stderr, and ordered event files without a retention-size cap. Use the `rawLogs` paths returned by status with `host_file_read` or `host_search` when excerpts are insufficient. Raw files and jobs survive phone disconnects and backend restarts. Missing or ambiguous execution evidence remains an uncertain outcome; it is not proof that rerunning a command is harmless.

## Legacy compatibility

Immutable snapshots, workspace edits, historical replay tools, Git publication receipts, fixed deployment adapters, and the original bounded probe remain available. Existing receipts keep their historical identity and execution facts. Legacy workspace commands use `workspaceId` plus `expectedRevision`; direct host jobs do not require a workspace revision.

Snapshot tooling retains its source-format and revision semantics. Use direct host files and jobs for unrestricted live project work. The earlier [operations guide](operations.md), [dependency adapter](dependencies.md), [production recovery adapter](production-recovery.md), and [self-update adapter](self-improvement.md) describe those specific workflows and historical deployment arrangements.
