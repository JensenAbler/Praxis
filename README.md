# Praxis

Praxis gives conversational models a persistent computer they can use to build software, publish it, operate production services, and improve Praxis itself. ChatGPT or Claude supplies the reasoning; Praxis supplies remote MCP tools and durable execution. Development happens in this public repository.

**Source development uses managed Praxis workspaces.** Required source workflow: recover the registered project and existing Praxis workspaces; sync main and create a managed workspace only when a fresh base is needed. Make source changes and run checks inside that Praxis workspace, review the diff, then commit and push from that workspace. Fast-forward the registered deployment on Alpha to the published commit and verify it. Do not edit deployed source in place or create ad hoc clones, repositories, or worktrees under /opt or elsewhere. Create a new repository only when the user explicitly requests one; a request to fix or improve an existing project is not that authorization. This workflow applies to Praxis itself. Native root access remains available for read-only diagnosis and authorized operations; it does not waive the source workflow.

Version 0.6.0 provides native root execution with ordinary host networking and durable jobs. There is no container, filesystem allowlist, registry proxy, command allowlist, or Praxis resource quota in native mode. Files, package caches, and complete command logs persist on the host.

**Rollout status:** native release `app-native-d75788a6e2e6` is live on Alpha. [Recorded acceptance](docs/evidence/native-root-live.json) covers root execution, normal dependency installation, complete output/artifact recovery, cancellation, deadlines, and a job surviving a live backend restart. Existing production services and historical database contents were preserved. ChatGPT's existing Praxis connection has refreshed tool definitions; a new native iPhone task has not yet been run.

Endpoint: **https://mcp.jensenabler.com/praxis/mcp**

## Managed source work and host operations

Start with `capabilities`, `projects_list`, and `workspaces_list` for source work. Use `host_projects_list` for live operational data. Use `host_project_attach` to save an existing project directory and optional named data roots, such as recordings or logs. Attachment is a discovery shortcut; native commands also accept any absolute working directory without a project registration.

The host tools cover directory discovery, metadata, text and binary reads, literal search, writes, and exact-text patches. They follow symlinks and include hidden files, Git metadata, environment files, logs, transcripts, recordings, and generated assets. Reads are paginated so large files fit into tool responses. Files are live, and optional SHA-256 preconditions help detect intervening changes.

Use `job_start` for commands such as tests, `npm`, `pip`, Git, SSH, service operations, or installed browser automation. Jobs run as root, support concurrency, and continue independently of the MCP backend and phone connection. `timeoutSeconds: 0`, the native default, means no deadline. Each submission returns a durable ID; `job_status` provides the outcome and recent output. Its `rawLogs` paths expose complete stdout, stderr, and ordered events through the host file tools.

Commit and push the reviewed managed workspace through the Git publication tools. Fast-forward the deployment to that published commit; do not develop in the deployment checkout. The default publication target remains `main`. Native jobs can maintain every Praxis component, including its gateway, authentication, configuration, tool server, deployment helpers, and updater. See [the native workflow and recovery contract](docs/native-root.md).

## Recover an existing task

In a fresh conversation, recover the project through `host_projects_list` and the work through `jobs_list`. Read `job_status` before continuing. After an uncertain submission, reuse the original inputs and idempotency key to retrieve the existing job. A lost reply does not justify starting another copy of a command.

Indexed log pages are compact excerpts. For details beyond those excerpts, use `host_file_read` or `host_search` on the raw log paths returned by status. Source files, attached-project discovery, job receipts, and raw logs persist outside the conversation.

## Compatibility workflows and evidence

Immutable source snapshots and managed workspace tools are the required source-development workflow, including for Praxis itself. Direct host paths support operational diagnosis and authorized runtime maintenance.

The previous [project creation](docs/new-projects.md), [deployment](docs/new-project-deployment.md), [production recovery](docs/production-recovery.md), and [staged self-update](docs/self-improvement.md) adapters remain optional conveniences. Their adapter-specific assumptions describe those workflows, not the extent of native root access. Ordinary native dependency installation does not require a sealed bundle; `dependency_prepare` remains useful when a compatible deployment adapter needs package provenance.

Earlier evidence includes [phone coding and recovery](docs/evidence/iphone-coding-report.md), [six historical replay implementations](docs/evidence/replay-batch-v1-results.md), and the [0.5 autonomy milestone](docs/autonomy-milestone.md). These records retain their original client, release, and execution scope. Container qualification is historical evidence and does not qualify native execution.

## Connection and local verification

The canonical endpoint and OAuth issuer use the `/praxis` prefix. Coding access requires the owner's `praxis:code` grant; the original bounded diagnostic tools retain `praxis:probe`. Existing connection metadata may need refreshing when tools change. Verify the advertised release and tool names in the actual client. API-client tests and native phone tests are recorded separately; Claude compatibility is not claimed without its own observed run.

Node 22.22 or newer is required for the server. Install dependencies with `npm ci --ignore-scripts`, then run `npm test`. Python helper fixtures run with `python -m unittest discover -s test -p 'test_*.py'`. Tests use disposable directories and fixture credentials. Native execution qualification additionally exercises real Linux/systemd jobs, backend-independent recovery, cancellation, output persistence, and authenticated MCP calls.

The verification client reads credentials from private files through `PRAXIS_PASSWORD_FILE` and `PRAXIS_CLIENT_STATE`. `scripts/coding-client.js` accepts a JSON tool request file and a result destination; request and result files used for live verification stay outside Git. The public repository contains implementation and reviewed evidence, not credentials, runtime state, or another project's source.
