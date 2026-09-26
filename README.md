# Praxis

Praxis gives a conversational model a persistent computer.

You bring the reasoning (ChatGPT, Claude, or any MCP client). Praxis supplies remote MCP tools and durable execution, so the model can write code, run it, publish it, operate the services it deploys, and keep improving Praxis itself, all from a chat window, including one on a phone.

**Endpoint:** <https://mcp.jensenabler.com/praxis/mcp> (see [Connecting](#connecting) for per-client details)

## What the model gets

**Managed workspaces** for changing source. A workspace is a disposable copy of an immutable snapshot of a registered repo. The model edits, tests, and diffs there, then commits and pushes from it. Deployed code is never edited in place.

**Host tools** for everything that already lives on the machine: listing, reading (text or binary, paginated), literal search, writing, and exact-text patching. They follow symlinks and see hidden files, Git metadata, env files, logs, transcripts, and recordings. Optional SHA-256 preconditions catch files that changed underneath you.

**Jobs** for running commands such as tests, `npm`, `pip`, Git, SSH, service management, or browser automation. Jobs run concurrently, keep running if the MCP backend restarts or the phone disconnects, and have no deadline unless you set one. Each job returns a durable ID; `job_wait` blocks for up to 15 seconds per call until it finishes, so clients don't need to poll. Complete stdout, stderr, and event logs stay on disk.

**Deployment tools** that fast-forward a registered service to a published commit, restart it, report its status, and roll back if needed.

## The source workflow

This applies to every registered project, **including Praxis itself**.

1. Recover state first: `capabilities`, `projects_list`, `workspaces_list`.
2. Reuse an existing workspace, or `project_sync` and `workspace_create` if you need a fresh base.
3. Make changes with `workspace_apply` and run checks with `job_start` inside that workspace.
4. Review with `workspace_diff`.
5. Publish with `git_commit`, then `git_push` (target: `main`).
6. Deploy with `deployment_fast_forward` and verify with `deployment_status` / `production_diagnosis`.

A few rules follow from this:

- Don't edit deployed source in place.
- Don't create ad hoc clones, repos, or worktrees (under `/opt` or anywhere else).
- Root access is still available for read-only diagnosis and authorized operations. It doesn't replace this workflow.

Full details: [native workflow and recovery contract](docs/native-root.md).

## Picking up where you left off

Everything durable lives on the host, not in the conversation. In a fresh chat:

- Find projects with `host_projects_list` (live files) and `projects_list` (source snapshots).
- Find work with `jobs_list`, `workspaces_list`, and `git_operations_list`.
- Read `job_status` or `git_operation_status` before doing anything else.

If a submission's response got lost, **retry with the same inputs and idempotency key.** That returns the existing job or operation instead of starting a second copy. A lost reply is never a reason to run a command again.

Log pages from `job_logs` are excerpts. For the full output, read the `rawLogs` paths from `job_status` with `host_file_read` or `host_search`.

## Working with live host data

`host_project_attach` saves a directory, plus optional named data roots like `recordings` or `logs`, so later calls can use short relative paths. It's only a shortcut: jobs and host tools accept any absolute path without registration, and attaching a directory doesn't authorize source edits.

## Commit authorship

Every commit made through Praxis records which client wrote it, and the client can't lie about it.

An OAuth authorization code is only ever delivered to a client's registered redirect URI, so the redirect host identifies which application completed the owner's authorization. Both token issuers sign that host into the access token as `praxis_client_host`. When a workspace is committed, the Git service derives the author from that verified claim, never from the request body.

| Redirect host | Git author |
| --- | --- |
| `claude.ai` | `Claude (via Praxis) <claude.ai@clients.praxis.invalid>` |
| `chatgpt.com`, `chat.openai.com` | `ChatGPT (via Praxis) <chatgpt.com@clients.praxis.invalid>` |
| any other single host | `MCP client at HOST <HOST@clients.praxis.invalid>` |
| missing, invalid, or redirect URIs spanning several hosts | `Unknown Praxis client` |

The committer is always the repository owner, so `git log --format='%an | %cn'` shows both who wrote a change and who is accountable for it. The `.invalid` domain guarantees the author addresses never reach a real mailbox. See [src/client-host.js](src/client-host.js).

## Connecting

Each client connects through its own OAuth client:

- **ChatGPT** uses the canonical endpoint, <https://mcp.jensenabler.com/praxis/mcp>, whose OAuth issuer lives under the same `/praxis` prefix.
- **Claude** uses a separate facade endpoint with its own issuer.

Coding tools require the owner's `praxis:code` grant; the original bounded diagnostic tools use `praxis:probe`.

Clients may need to refresh their connection metadata after tools change. `capabilities` reports the running version and release, so check it in the client rather than trusting any document.

## Development

Requires Node 22.22+.

```sh
npm ci --ignore-scripts
npm test
python -m unittest discover -s test -p 'test_*.py'
```

Tests use disposable directories and fixture credentials. Native qualification additionally runs real Linux/systemd jobs, backend-independent recovery, cancellation, output persistence, and authenticated MCP calls.

For live verification, `scripts/coding-client.js` takes a JSON tool request file and a result path, reading credentials from files named by `PRAXIS_PASSWORD_FILE` and `PRAXIS_CLIENT_STATE`. Keep request and result files out of Git.

This repo contains implementation and reviewed evidence only: no credentials, runtime state, or other projects' source.

## Further reading

Optional adapters (still supported, but they describe their own assumptions, not the limits of native access):

- [Creating new projects](docs/new-projects.md)
- [Deploying new projects](docs/new-project-deployment.md)
- [Production recovery](docs/production-recovery.md)
- [Staged self-update](docs/self-improvement.md)

`dependency_prepare` is only needed when a deployment adapter wants sealed package provenance; normal native installs don't need it.

Evidence (each record keeps its original client, release, and scope; container-era results don't qualify native execution):

- [Native root acceptance](docs/evidence/native-root-live.json): root execution, dependency installation, output and artifact recovery, cancellation, deadlines, and a job surviving a live backend restart
- [Phone coding and recovery](docs/evidence/iphone-coding-report.md)
- [Six historical replay implementations](docs/evidence/replay-batch-v1-results.md)
- [0.5 autonomy milestone](docs/autonomy-milestone.md)
