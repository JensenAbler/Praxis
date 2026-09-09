# Production diagnosis, recovery, and prepared dependencies

The protected `deploy-discord.py` helper controls only the registered
`podcast-discord.service` and `/opt/podcast-discord` checkout. It accepts JSON on
stdin through the existing trusted Git broker. Requests cannot choose a path,
service, repository, command, shell, installer, or health executable.

## Observations

- `{"action":"diagnosis","limit":40}` returns current HEAD, cleanliness,
  systemd process state, restart count, and at most 100 operational log events.
  It scans at most the latest 256 KiB of the fixed bot stdout log. Log access
  requires a root-owned regular file with no group/other write access; symlinks
  are rejected. Missing logs are reported as unavailable.
- Events are an allowlist: startup, Discord login and command registration,
  websocket disconnect, shutdown, and classified application failures. Error
  codes come from a fixed vocabulary. Arbitrary messages, stack arguments,
  Discord usernames, transcripts, prompts, provider responses, and unknown
  lines are never returned. Omitted line/event counts and tail truncation are
  explicit. This deliberately provides operational evidence rather than an
  unrestricted export of private application logs.
- Health distinguishes a running process, a login timestamp observed after the
  current systemd invocation started, and actual live Discord/voice/provider
  checks. The latter remain unverified. A historical login is not a current
  connectivity probe; absence in a bounded log tail is not proof of disconnect.
- `{"action":"history","limit":20,"cursor":"<optional operation UUID>"}`
  returns bounded deployment/recovery summaries newest first. Follow the last
  returned operation ID in `nextCursor`; `null` means completion. Newer records
  do not shift an existing cursor. Individual `status` requests still recover
  durable operation evidence.

## Recovery mutations

Every mutation uses a caller-generated operation UUID, exact expected HEAD, and
the same persisted journal/lock used by deployment. Repeating identical inputs
recovers the operation; altered inputs fail with `IDEMPOTENCY_CONFLICT`.

`restart` accepts `operationId`, `expectedHead`, and optional
`recoverOperationId`. It can recover a failed/inactive fixed service without
changing source. It requires a clean checkout. The helper records restart intent
before invoking systemd, and observes a new stable service invocation afterward.
An interrupted restart with no proof of replacement becomes uncertain and is
never automatically reissued.

An explicit new recovery operation may name a failed or uncertain activation in
`recoverOperationId`, provided that operation targeted the exact current HEAD.
The old outcome stays failed/uncertain; its journal records `resolvedBy` and the
new recovery has its own independent result. Merely inspecting status does not
restart anything or turn an uncertain outcome into an assumed failure.

`rollback` accepts `operationId`, `expectedHead`, `deploymentOperationId`, and
optional `recoverOperationId`. Its target comes only from the prior HEAD of a
recorded deployment that reached activation at the exact expected current HEAD.
The caller cannot choose an arbitrary target commit. The helper uses an atomic
Git compare-and-swap and protected two-tree checkout, then observes activation
using the same durable restart protocol. GitHub main is not rewound. Credentials,
ignored recording/runtime files, unrelated services, and external repositories
are preserved. Dirty worktrees and runtime-path collisions are rejected.

## Dependency changes

An `apply` request may include `preparedDependenciesId`, a SHA-256 ID sealed by a
completed sandbox dependency preparation job. The helper reads only fixed
`/srv/praxis-git-exchange/dependencies/<id>.json` and `<id>.tar` files owned by the
trusted coding backend, outside ordinary worker access.

The version 1 manifest contains `archiveSha256`, `packageJsonSha256`,
`packageLockSha256`, `shrinkwrapSha256`, `platform`, `arch`, `nodeMajor`, and
provenance (`workspaceId`, `revision`, `jobId`, `image`). Hashes are checked against
the exact published Git commit. At least one lockfile is required. Linux x64 and
the managed Node major must match. Neither a build success message nor a caller
path is accepted as an artifact attestation.

The helper copies and hashes the archive, extracts it into a root-private stage,
and accepts only `node_modules` regular files/directories and confined relative
symlinks. Hardlinks, devices, absolute paths, traversal, duplicate names, symlink
ancestors, escaping symlink chains, and oversized archives are rejected. Limits
are 512 MiB archive, 1 GiB expanded data, 100,000 entries, 256 MiB per file.
Permissions and ownership are set by the helper. No dependency installer,
package script, candidate hook, or candidate health command runs as root.

Source and dependencies are prepared before service restart. Dependency trees
are activated using recorded atomic renames on the deployment filesystem;
interrupted swaps reconcile exact old/new path observations. The previous tree
is retained in the protected operation state. Rolling back that deployment
restores its previous tree along with source, without reinstalling packages or
touching credentials/runtime data. Missing retained rollback material is an
explicit error. Incomplete/ambiguous swaps are not silently repeated.

The production bot itself retains its existing root runtime identity in this
milestone. This helper does not claim to sandbox production application code.

## Qualification

`python3 -m unittest discover -s test -p test_deploy_discord.py` exercises real Git
repositories with fake systemd in disposable Linux directories. It tests
publication-head checks, exact rollback, preserved runtime data, failed and
interrupted activation, explicit recovery, bounded/redacted observations,
prepared artifact hashes/runtime compatibility, malicious archive paths, and
dependency-swap interruption. These tests are fixture evidence, not a claim that
a production rollback, live Discord health probe, or phone recovery has run.
