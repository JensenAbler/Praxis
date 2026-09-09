# First coding milestone

Status: implementation in progress. The deployed heartbeat probe remains the verified baseline.

The next acceptance case is an authenticated phone conversation that discovers a project, creates an isolated workspace at an exact revision, reads/searches/edits source, runs checks, and reviews its diff. A fresh conversation must recover the same workspace, jobs, logs, artifacts, and mutation receipts. GitHub publication through Praxis, production deployment, browser use, and independent self-update are subsequent milestones.

The owner has requested public development of Praxis. The public repository contains the service and its tests; private project source, credentials, runtime databases, and evaluation solutions remain outside it.

## Implementation boundaries

- Keep the existing HTTPS endpoint and OAuth issuer. Add an explicit `praxis:code` grant; existing `praxis:probe` tokens do not acquire coding rights automatically.
- A separate coding service validates the original access token with public signing keys. It has no OAuth signing keys or owner password.
- Registered project snapshots are immutable source exports at exact commits. Git metadata and runtime secrets are excluded from editable workspaces. Protected baseline manifests determine the review diff.
- Development commands run in rootless Podman under a dedicated OS identity. Only the selected workspace is mounted. The image and container options are fixed by the service. Start with network disabled; enable any broader mode only after its controls have been exercised.
- The coding service persists jobs before launching containers and returns immediately. Container names are deterministic. Recovery inspects existing execution, never silently reruns an ambiguous command. MCP application restarts do not restart the coding service.
- One active command at a time; edits are blocked while a workspace has queued or running work. Apply operations use hash preconditions and persistent idempotency receipts. File operations reject escaping paths, links, and protected internals.
- Bound process time, memory, CPU, process count, writable storage, log retention, and result pages. Report limits and interruptions accurately.

## Shared module contract

The coding service owns one synchronous `CodeStore` (`src/code/store.js`) with public `db` (Node SQLite), `transaction(fn)`, and `close()` methods. Workspace operations own `workspaces` and `operations` tables; the job manager owns `code_jobs` and `code_records`. Construct the job manager before the workspace manager so job tables exist. Schema changes must be additive.

`WorkspaceManager({ store, dataDirectory, workspaceDirectory, projects })` owns filesystem/source operations. `projects` is a protected array of `{ id, name, repository, revision, snapshotPath, validationCommands, instructions }`. Snapshot paths never come from tool arguments. Methods accept `{ owner, ...args }`: `projectsList`, `projectInspect`, `create`, `list`, `inspect`, `filesList`, `read`, `search`, `apply`, `diff`, `remove`, `operationsList`, `operationRead`. Internal `getExecutionWorkspace({owner, workspaceId})` returns `{path, workspaceId, revision}` only after ownership and health checks. Public methods never expose host paths. General read/list/search accept exactly one of `projectId` or `workspaceId`. Workspace rows include `id`, `owner`, `revision`, `status`, `path`; status is `ready`, `recovering`, or `removed`. `revision` is an opaque manifest digest and is refreshed after commands before publishing completion.

`CodeJobs({ store, dataDirectory, runner, workspaces })` owns durable command lifecycle. Set `jobs.workspaces` after constructing both managers. Methods accept `{owner,...args}`: `start`, `list`, `get`, `logs`, `cancel`, `artifactList`, `artifactRead`; `tick()` advances supervised jobs and `recover()` reconciles on startup. Active statuses are `queued`, `starting`, `running`, `canceling`. `code_jobs` must have `id`, `owner`, `workspace_id`, `status`. `start` checks `expectedRevision` and the workspace lock inside the shared transaction, then persists before any container action. `workspaces.refreshAfterJob({owner,workspaceId})` recomputes the public revision without running workspace code. Only this internal method may inspect while its own job is active.

The backend exports a fixed POST `/call` action allowlist, authenticates every request, and never accepts paths, Podman arguments, image names, or host commands from callers. MCP wrappers validate arguments and forward the bearer token to the backend. Detailed API schemas live with the implementations; no success-returning placeholder tools are exposed.

## Evidence to collect

Authenticated source/edit/diff/recovery flow; stale hash and path-escape rejection; idempotency replay and conflict; passing/failing/timeout/cancelled commands; bounded logs and artifact recovery; denied secret/host/other-workspace access; application restart during a job; interrupted-run reconciliation; actual cgroup and disk boundaries. Keep automated client tests distinct from the eventual iPhone run.
