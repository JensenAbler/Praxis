# Praxis

The current authorized milestone is the first complete coding workflow: inspect/search source, create an isolated workspace, edit, run checks, review a diff, and recover workspace/jobs from a fresh phone conversation. The existing probe remains a regression fixture.

- Keep the probe's built-in heartbeat tools bounded. General coding commands belong only in a separate development sandbox without production secrets or host administration privileges.
- Keep OAuth credentials and runtime state outside Git and outside ordinary development access.
- Preserve the existing Apocrypha, VPS Observer, and podcast services and source revisions. Isolated Praxis coding services, protected configuration, disposable evaluation fixtures, and validated graceful nginx reloads are within the user's bootstrap authority.
- Publish, deploy, maintain production applications, and independent Praxis self-update are later milestones. Do not add success-returning stubs for them.
- Compare a small historical coding task with independent behavioral checks; keep expected solutions out of the worker's task context. Distinguish automated client evaluation from an actual phone run.
- Keep jobs independent of MCP requests and application restarts. Never rerun an ambiguously completed job.
- Run `npm test` and exercise authenticated MCP calls before deploying.
- Record actual evidence and distinguish native-client, API-client, fixture, and production results.
- The owner now requests a public Praxis GitHub repository. Commit and push reviewable increments as work proceeds. This supersedes the original specification's private-repository default; keep credentials, private runtime data, and other repositories' source out of publication.
