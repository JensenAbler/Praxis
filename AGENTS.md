# Praxis

## Required source workflow

Required source workflow: recover the registered project and existing Praxis workspaces; sync main and create a managed workspace only when a fresh base is needed. Make source changes and run checks inside that Praxis workspace, review the diff, then commit and push from that workspace. Fast-forward the registered deployment on Alpha to the published commit and verify it. Do not edit deployed source in place or create ad hoc clones, repositories, or worktrees under /opt or elsewhere. Create a new repository only when the user explicitly requests one; a request to fix or improve an existing project is not that authorization. This workflow applies to Praxis itself. Native root access remains available for read-only diagnosis and authorized operations; it does not waive the source workflow.

This owner requirement supersedes earlier instructions that describe direct host source editing as the primary workflow. Root access is an execution capability, not permission to bypass workspace provenance.

The owner now explicitly authorizes native root access on Alpha: remove container execution and the previous filesystem, networking, production-inspection, and host-administration restrictions. Implement supervised native processes, persistent homes/caches, ordinary networking and dependency installation, and generic project/host access to source and operational data. This supersedes the earlier sandbox and protected-adapter-only requirements. The existing probe remains a bounded regression fixture.

- Keep the probe's built-in heartbeat tools bounded. Owner-authenticated native commands run as root with normal host access; do not recreate the removed restrictions in another layer.
- Keep credentials, private runtime data, and other repositories' source out of the public Git repository and routine tool diagnostics. Root access is authorized; credentials must not be printed or copied without a task need.
- Preserve Apocrypha, VPS Observer, podcast-production, and unrelated services/source revisions. Isolated Praxis coding services, protected Git publication configuration, fixed podcast-discord service adoption, disposable fixtures, and validated graceful nginx reloads are within the owner's bootstrap authority.
- The owner explicitly authorizes commit/push to `main`, native root host commands, unrestricted host file access, production diagnosis/maintenance, ordinary dependencies and full Praxis maintenance. Preserve uncertain outcomes without blind repetition. Existing fixed adapters remain conveniences, not the exclusive authority path.
- Preserve authenticated access, durable job identity/logs/exit evidence, cancellation, optional deadlines, and recovery independent of a phone connection or coding-service restart. Root jobs may maintain all Praxis components. Retain a known working release during deployment; never restore databases over accepted work.
- Use normal host networking and persistent dependency caches. Keep source/runtime provenance where useful, without requiring container images or sandbox-only dependency paths.
- Compare a small historical coding task with independent behavioral checks; keep expected solutions out of the worker's task context. Distinguish automated client evaluation from an actual phone run.
- Keep jobs independent of MCP requests and application restarts. Never rerun an ambiguously completed job.
- Run `npm test` and exercise authenticated MCP calls before deploying.
- Record actual evidence and distinguish native-client, API-client, fixture, and production results.
- The owner now requests a public Praxis GitHub repository. Commit and push reviewable increments as work proceeds. This supersedes the original specification's private-repository default; keep credentials, private runtime data, and other repositories' source out of publication.
- The owner requests the canonical public endpoint `https://mcp.jensenabler.com/praxis/mcp` and `/praxis/oauth` issuer. This supersedes the earlier stable `/praxis-probe` URL assumption. Preserve stored jobs, workspaces, credentials, and unrelated services during migration.
