# Praxis — implementation specification

## 1. Build the working system

Build **Praxis**, a new personal ChatGPT plugin and VPS-hosted development service. Plugin name: **Praxis**. Slug: **praxis**.

Praxis lets Jensen Abler work on software by talking to ChatGPT on his iPhone. ChatGPT supplies the reasoning and code; Praxis supplies source access, editing, execution, GitHub, deployment, diagnosis, and maintenance tools.

Build this as a fresh application, repository, service, and authenticated connection. The laptop is available for bootstrap and exceptional recovery. Routine operation, including ordinary improvements to Praxis itself, must run without it. Do not introduce another AI agent, Codex daemon, model subscription, or laptop relay.

This is an implementation request. Build, test, deploy, and document the system. Continue through routine implementation decisions without repeated confirmation. Ask only for necessary sign-in, genuinely missing information, additional access, or a consequential decision outside this specification. Do not stop at scaffolding or a proposal.

Apocrypha remains the memory system. Praxis owns operational state and execution.

## 2. Environment and setup authority

Known inputs:

* GitHub owner: JensenAbler.
* Hostinger VPS: 31.97.135.128.
* Bootstrap SSH: existing laptop configuration; observed user root and identity file `%USERPROFILE%\.ssh\alphaclawd`.
* Podcast Discord: JensenAbler/podcast-discord, previously located at /opt/podcast-discord.
* Podcast Production: JensenAbler/podcast-production, previously located at /opt/podcast-production.
* OpenClaw runs on this VPS. The owner reports it was last updated around February 2026.
* Big Brain connects Podcast Discord to the OpenClaw harness.

Verify paths, versions, service names, ownership, ports, Git state, deployment procedures, and available capacity. Do not assume clean working trees, current branches, or vulnerability status. Inspect applicable repository instructions and preserve unrelated work.

Create or reuse an owner-designated Praxis Git repository. Default a new GitHub repository to private visibility. Version the application, schemas, tests, deployment templates, documentation, and this specification. Keep credentials and private runtime data out of Git.

You are authorized to create and deploy Praxis, its isolated execution environment, protected adapters, and independent updater; configure their narrowly scoped access; create disposable fixtures; and test GitHub writes in the private Praxis repository. Back up configuration before edits and record restoration steps. A validated graceful proxy reload for Praxis is within setup scope.

During bootstrap, do not change either podcast application's source or deployed revision, upgrade OpenClaw, alter Big Brain, delete production data, merge into the podcast repositories, or restart unrelated services. Test production-facing mechanisms using fixtures and generate read-only plans for the real applications.

Use existing resources. Do not purchase services or domains. Keep the existing owner SSH access working. Never paste private keys or tokens into chat.

## 3. Architecture

Use maintained components and a small architecture appropriate to the measured VPS resources. These are responsibility and privilege boundaries, not a demand for a large microservice system.

| Component                          | Responsibility                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Connection and authorization layer | Stable HTTPS MCP endpoint, owner authentication, and authoritative operation grants.                           |
| Praxis application                 | Tool definitions, project workflows, orchestration, and useful results. Its running releases are immutable.    |
| Development executor               | Isolated workspaces and command/build/test jobs, without production secrets or host administration privileges. |
| Protected adapters                 | Scoped GitHub, deployment, backup, and service operations, independently validating identity and permissions.  |
| Independent updater                | Stage, activate, inspect, and roll back Praxis releases even when the Praxis application cannot run.           |

Store authoritative permissions, credentials, installed updater code, and host service configuration outside ordinary development access.

Treat repository scripts, dependencies, build commands, and candidate Praxis releases as untrusted relative to host administration. Enforce separation using OS permissions and execution isolation. Redacting terminal output alone is insufficient.

Do not provide an unrestricted root shell, broad sudo, host Docker socket access, or caller-selected privileged scripts. Keep development execution useful: support general commands and scripts inside its sandbox, including dependency installation under explicit network and resource policy.

Build the initial project registry around discord, production, and praxis. Resolve repository roots, remote URLs, services, and deployment targets from validated configuration.

## 4. Hosted connection and authentication

Provide a persistent HTTPS MCP endpoint with Streamable HTTP transport. Choose and configure an owner-controlled hostname, TLS, persistent storage, service supervision, and startup behavior. Discover existing infrastructure before selecting ports or routes.

Implement ChatGPT-compatible authentication using maintained components and current official guidance. Restrict use to the owner. Validate token issuer, audience, expiry, and operation scopes. Enforce authorization on every request and again at protected adapters.

Normal credential renewal and reauthorization must be possible from the phone. Do not depend on laptop credential helpers or localhost callbacks for ongoing operation.

Keep secrets out of URLs, tool arguments, metadata, source repositories, logs, and results. Do not increase access simply because a new tool appears.

Create the actual Praxis connection/plugin in the supported account interface. Include concise instructions explaining project discovery, isolated editing, job handling, review, deployment, and self-update. A local MCP registration does not complete this requirement.

Keep endpoint and authentication identity stable across ordinary releases. Document the actual steps to refresh tool metadata or reconnect after schema changes. If a new conversation is necessary, say so. Do not assume tools appear automatically after server deployment.

Verify implementation against current primary documentation:

* [Build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
* [Authenticate users](https://developers.openai.com/plugins/build/auth)
* [Connect and test a plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)

## 5. Required tools

The following names define the intended interface. Small naming changes are acceptable if documented. Every required capability must work or be explicitly reported as blocked; do not expose success-returning stubs.

### A. Discover projects and inspect source

* `capabilities`: API version, tool-schema version, active release, supported operations, permission limits, and disabled capabilities with reasons.
* `projects_list` and `project_inspect`: project IDs, repository information, dirty state, validation commands, deployment associations, and applicable project instructions.
* `files_list` and `code_search`: paginated file listings and bounded code search.
* `file_read`: bounded source reads with line numbers, revision, and content hash.

Distinguish live deployment, immutable commit, and task workspace. Exclude credential files and runtime secrets. Return references to configuration where useful, never credential values.

### B. Create and edit isolated workspaces

* `workspace_create`: create a task branch/worktree pinned to a resolved base commit.
* `workspaces_list` and `workspace_inspect`: recover ownership, base revision, dirty files, associated jobs, and current state.
* `workspace_apply`: create, patch, rename, and delete source files.
* `workspace_diff`: return the complete or paginated diff, including new/deleted files and mode changes.
* `workspace_remove`: preview and remove an identified disposable workspace, preserving active jobs and uncommitted work unless explicitly authorized.

Writes require expected content hashes or equivalent revision preconditions. Reject stale edits. Validate multi-file batches before applying them; make them atomic where practical. Otherwise return per-file outcomes and resulting hashes so partial changes are recoverable.

Reject path traversal, escaping symlinks, unauthorized absolute paths, and writes to protected Git internals. Workspace-controlled hooks, filters, configuration, and credential helpers must not execute in privileged or credential-bearing processes.

### C. Execute work and retrieve results

* `job_start`: run a validation task or general command in an identified development workspace.
* `jobs_list`, `job_status`, `job_logs`, and `job_cancel`: inspect, resume observation, retrieve output, and cancel jobs.
* `artifact_list` and `artifact_read`: retrieve reports, patches, generated files, and other bounded outputs through authenticated access.
* `operations_list` and `operation_read`: recover mutation receipts and previous outcomes.

Commands use argument arrays, a workspace-relative working directory, permitted environment overrides, and bounded resource/time limits. Shell scripts may run inside the development sandbox; host administration remains outside it.

Return a durable job ID promptly. Persist state outside the MCP request process. Jobs must survive chat disconnection and ordinary Praxis application restarts.

Expose timestamps, status, progress where available, output cursors, truncation, exit code/signal, cancellation results, and artifact references. After a runner or host failure, report interrupted work accurately and resume only when supported. Never blindly rerun a possibly completed side effect.

Initially allow one heavy build at a time. Set measured CPU, memory, disk, concurrency, and timeout limits that leave capacity for existing applications. Document quotas and retention. Preserve unresolved failures for diagnosis.

### D. Git and GitHub

* `git_fetch`, `git_status`, `git_diff`, and `git_commit`: fetch approved remotes, inspect changes, and commit selected files against an expected workspace revision.
* `git_push`: push an explicit branch and commit to an authorized repository.
* `pull_request_upsert` and `pull_request_read`: create/update PRs and retrieve checks and review feedback.
* `pull_request_merge`: merge the reviewed head only within granted policy and required checks.

Support bringing task branches up to date, resolving conflicts, and continuing or aborting merges/rebases through Praxis tools or sandbox Git. Return conflicted paths and operation state. Ordinary branch synchronization must not require SSH.

Detect remote divergence; never silently force-push, discard work, override branch protection, or merge a different revision than the one reviewed.

Use least-privilege server-side GitHub authentication through a protected adapter. Keep credentials outside development jobs. Verify actual account identity and permissions rather than assuming laptop access transfers to the VPS.

### E. Deploy applications

* `deployment_inspect`: report the actual release procedure, current revision, target services, and relevant state.
* `deployment_plan`: create a persisted plan for an exact commit/artifact and target.
* `deployment_apply` and `deployment_status`: execute an authorized plan and report its steps and outcome.
* `deployment_history` and `deployment_rollback`: inspect releases and restore an identified prior release where supported.

Plans identify the source commit, artifact digest where applicable, expected current target state, actions, checks, downtime expectations, and rollback limitations.

Inspect runtime data, environment references, volumes, mutable dependencies, dirty live checkouts, and database migrations before implementing application-specific adapters.

Serialize conflicting deployments. Distinguish started, healthy, failed, and rolled back. A listening port is not sufficient application-health evidence.

Code rollback does not necessarily undo database changes or external effects. Do not advertise automatic rollback where the data or migration behavior makes it unsafe.

### F. Inspect and maintain the VPS

* `server_status`: uptime, resource usage, disk capacity, and relevant version information.
* `services_list` and `service_inspect`: registered service/container state and associations.
* `logs_read`: bounded, redacted logs with cursors.
* `maintenance_plan`, `maintenance_apply`, and `maintenance_status`: typed operations for registered targets.
* `backups_list` and `backup_inspect`: backup scope, timestamps, integrity evidence, retention, and recovery limitations.
* `integration_inspect` and `integration_check`: inspect registered integration wiring and perform explicitly described checks.

Maintenance operations cover scoped service restarts, application updates, backups/restores, and cleanup of identified eligible files or caches. Implement these as predefined operations with validated inputs, not arbitrary privileged commands.

Cleanup previews enumerate targets and expected impact. Restoration identifies the backup, destination, and state that would be overwritten. Identify whether a backup shares the VPS's failure domain; a local copy is not protection against loss of the whole server.

Start integration support with Big Brain. Inspect its actual request path between Podcast Discord and OpenClaw. Distinguish configuration inspection, TCP reachability, simulation, and a real end-to-end check. Use correlation IDs where practical.

A real integration check may send messages, invoke a model, or incur cost. Describe those effects and require corresponding authorization. Bootstrap testing must not send Discord messages or trigger model calls without explicit scope.

OS-wide permission changes, new privileged targets, and protected-control updates use the independent owner-controlled maintenance path.

## 6. Operation contracts and permissions

Return compact structured results and a readable summary. Include applicable request, operation, job, workspace, project, and revision IDs; timestamps; pagination; truncation; and actionable next steps.

Successful mutations return persisted receipts describing what changed. Failures have stable error codes and recovery guidance. Partial success must remain visible.

Mutations accept an idempotency key bound to the principal, operation, and payload. Persist it before side effects. Reusing the key with different inputs is an error. Reconcile ambiguous remote outcomes before retrying. Do not promise universal exactly-once execution.

Use locks and revision preconditions for workspace changes, commits, merges, deployments, and maintenance. Persisted action plans carry a digest, expiry, expected target state, and explicit operations. Execution references that exact plan; changed inputs require a new plan.

Honor authenticated standing grants for routine reads, workspace edits, validation, and agreed Git operations. Avoid repeated approvals for already-authorized work. Actions beyond those grants require a supported owner authorization step.

Apply accurate read-only, destructive, and external-effect annotations. An `approved=true` argument, natural-language claim, or token minted solely by editable Praxis code is not independent owner authorization. Protected adapters enforce authenticated grants themselves.

Never bypass denied operations, platform restrictions, branch protection, or missing scopes to pass a test.

## 7. Self-maintenance: Praxis develops Praxis

Register the Praxis application repository as the third managed project. Its own tools must be able to create branches, edit source, run tests, review diffs, and prepare releases.

Provide:

* `praxis_release_plan`
* `praxis_release_apply`
* `praxis_release_status`
* `praxis_release_history`
* `praxis_release_rollback`

These use an independently supervised updater. Restarting the application from inside its own request handler is insufficient.

### Release lifecycle

1. Build and test an exact source revision inside the unprivileged sandbox. Produce an artifact, digest, schema manifest, and test evidence. Never run candidate code or build scripts as root.
2. The updater validates the request against protected policy and snapshots the application artifact into an immutable release directory. Bind the release plan to the expected currently installed version.
3. Start a candidate in an internal slot while the current version remains available. Use two lightweight slots or an equivalent proven arrangement with bounded resource overhead.
4. Enforce staging outside candidate-controlled code. Candidates cannot acquire live job leases, start live schedulers, perform production mutations, or migrate live state. Readiness tests use read-only state or a disposable compatible copy.
5. Test authenticated MCP initialization, tool discovery, existing schema compatibility, a harmless source read, job-status retrieval, and rejection of invalid authorization. HTTP 200 alone is insufficient.
6. Drain or serialize affected mutations. Keep durable jobs supervised independently. Defer activation when incompatible work cannot safely continue.
7. Promote through an updater-controlled active-generation fence. Protected adapters accept new mutations only from the active release; revoke the old generation after draining.
8. Switch only the fixed Praxis route. Record the operation before switching and expose an operation ID early enough to recover after disconnection.
9. Run bounded post-switch checks. If activation or health fails, the updater restores the previous route and release without requiring the application to call it.
10. Persist updater transactions so an interrupted updater or host restart recovers deterministically.

Retain at least the previous known-good artifact and compatible configuration. Routine self-updates preserve backward compatibility of operational state. Destructive or incompatible migrations require a separate backup, migration, and recovery procedure.

Protect the installed updater, authentication authority, credentials, service identities, and privileged policy from ordinary editing and deployment. Their source/templates may be versioned and proposed for review, but application releases cannot install or modify them.

The updater accepts only application artifacts and fixed release targets. Reject archive traversal, escaping links, privileged file modes, caller-selected services, arbitrary paths, and executable deployment scripts supplied by the caller.

Routine self-updates remain within preauthorized rights. Expanding those rights or replacing protected components requires an independent owner-controlled path.

Rollback cannot undo arbitrary external side effects, Git pushes, deleted data, or incompatible migrations. Preserve existing SSH access and document exact recovery commands that work when Praxis is unavailable.

## 8. Continuity and memory

Praxis persists operational facts: workspaces, jobs, receipts, artifacts, commits, release history, and pending actions.

A new authorized conversation must be able to discover what is running, what changed, what failed, and what remains pending through Praxis tools alone. Do not depend on the previous chat transcript or a person copying terminal logs.

Apocrypha remains responsible for memory. Praxis may return architectural discoveries and decisions as optional memory candidates for ChatGPT to ingest through that system. Do not create a second memory service or make memory connectivity a prerequisite for development.

Document the ordinary inspect → edit → validate → review → publish → deploy workflow and its Praxis self-update equivalent.

## 9. Acceptance tests

Maintain a matrix with evidence IDs, actual outcomes, and passed, failed, blocked, or not exercised for every required capability. Test through authenticated MCP calls, not only internal functions.

Required tests:

1. **Hosted connection:** stable endpoint, owner authentication, discovered tools, persistent VPS service, and no laptop runtime dependency.
2. **Source access:** list/search/read all three projects, correctly distinguishing deployed source and isolated workspaces.
3. **Editing:** create a disposable workspace; add, patch, rename, and delete fixture files; inspect the diff; reject stale hashes and escaping paths.
4. **Execution:** passing/failing commands, timeout, cancellation, logs, artifacts, and resource limits.
5. **Isolation:** demonstrate that development jobs and staged candidates cannot access production secrets or host administration.
6. **Durability:** restart the MCP application during a job, reconnect, and retrieve its outcome. Test duplicate submission and interrupted-operation reconciliation.
7. **Git:** branch synchronization and conflict resolution without SSH; selected-file commit and divergence detection.
8. **GitHub:** real branch, commit, push, and draft PR in the private Praxis repository. Read checks/reviews. Test merge on a designated disposable target or label it unexercised.
9. **Deployment:** exact-artifact deployment to a fixture service, stale-plan rejection, application health failure, history, and rollback. Produce read-only plans for the actual podcast applications.
10. **Maintenance:** fixture restart, backup integrity, restoration into a disposable destination, and cleanup preview/apply. Reject protected or unregistered targets.
11. **Big Brain:** document real wiring and safe observations. Clearly label simulations and any real external round trip left unexercised.
12. **Self-update:** use live Praxis tools to make a harmless Praxis change, test it, prepare and apply the release, reconnect, and retrieve the persisted result.
13. **Failed update:** reject an unhealthy candidate before promotion; separately force a bounded post-switch failure and demonstrate automatic restoration of authenticated tools.
14. **Recovery:** interrupt a dedicated updater worker at recorded checkpoints and demonstrate deterministic recovery. Verify the independent SSH recovery procedure read-only. Do not reboot the VPS or deliberately interrupt the podcast applications.
15. **ChatGPT workflow:** after the owner connects Praxis, read source, make an isolated edit, run validation, and review the diff from ChatGPT.

Complete all safely testable work before the final owner handoff. Where testing uses an authenticated MCP client rather than ChatGPT itself, identify that accurately. Do not claim an iPhone test was performed without evidence.

Production deployment and maintenance actions may remain intentionally unexercised during bootstrap. Report that distinction clearly. A fixture demonstrates a mechanism, not the health of the existing applications.

Investigate genuine blockers, finish the remaining work, and explain the exact missing access or platform capability. Do not declare completion while a core development or self-update path remains a stub.

## 10. Deliverables and final handoff

Commit and provide:

* Application source, dependency lockfiles, tool schemas, focused tests, and plugin metadata/instructions.
* Reproducible bootstrap and release scripts, updater source, service templates, and ownership/permission documentation.
* Redacted project, deployment, service, storage, and integration inventory.
* Operator guide for routine development, job recovery, authentication renewal, connection refresh, backups, retention, and independent rollback.
* Completed acceptance matrix with evidence and clearly identified limitations.
* Inventory of resources and configuration changed during bootstrap.
* Concise handoff for Jensen's ChatGPT conversation: how to select Praxis, available project IDs, the capabilities call, useful receipt IDs, and any remaining account action. No credentials.

The first routine development task should be possible immediately after connection: inspect a project, create an isolated change, run validation, and review the diff.

Ordinary improvements to Praxis then use its own development tools and independent updater. Minimize future compulsory laptop work, while documenting the exceptional recovery and privilege changes that still require independent access.
