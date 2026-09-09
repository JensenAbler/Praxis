# Praxis operations

## Deployment status

Runtime release `coding-a41abbbbb51e`, source `a41abbbbb51ee8f68d8968f5ef3971495b1bf0b6`, is active at the canonical Praxis endpoint. All 60 tests passed on Linux under the separate build identity, with zero failures/skips. The authenticated MCP fixture passed all six groups using the real fixed container image before publication. The archive SHA-256 is `b2e3614beb8ca83ecad7089ee399e1980f0a3a98970cc65d6f03315b8e8e603c`; the endpoint migration backup is `/root/praxis-probe-backups/endpoint-migration-h8gJA3N3`. See [migration evidence](evidence/endpoint-migration.json).

At `2026-09-09T16:47:45.339275+00:00`, public health reported Praxis 0.2.0 on this release, gateway boot `20ee53fa-eaad-404a-952d-6ae15f1dc37b`; backend health reported boot `7ad8335f-4eff-4a9f-8150-94a1247cab9a`. New OAuth discovery passed, unauthenticated MCP returned 401 with the new metadata URL, and the old MCP endpoint returned 410 with reconnection guidance. The two stored probe jobs and 38 records remained present, with an identical aggregate job-row hash; live coding jobs, workspaces, and operations were empty before and after. The diagnostic worker and measured Apocrypha, Observer, and OpenClaw listener PIDs stayed unchanged. Both podcast repositories retained their deployed revisions and clean working trees.

The canonical native ChatGPT connection is named **Praxis**, uses the new endpoint, and reports OAuth with no reconnect-needed labels. Refresh exposed 30 actions: 21 coding and nine diagnostic tools, verified by a DOM count and the source registry. Native consent used the existing owner session without password entry. Read-only server counts at `2026-09-09T16:52:47.513611+00:00` found one active grant and three active refresh-token records for the canonical resource with `praxis:code`; values were not exposed. The old connection was uninstalled; its definition remains under Created by me as **Praxis Legacy**. [Canonical connection evidence](evidence/chatgpt-praxis-connection.json) records the creation/consent retries, successful recovery, and final installed state.

The first [native iPhone coding task and fresh-conversation recovery](evidence/iphone-coding-report.md) subsequently passed on this runtime. [Server evidence](evidence/iphone-coding-server.json) confirms workspace `4851843f-e8af-43c3-a828-33dbd417bf0f`, three completed jobs, 76 passed/0 failed after a 75/0 baseline, and preserved 577/7/582 log records. Recovery issued no audited mutation calls. Two rejected apply attempts were followed by a hash-checked command edit; no apply receipt exists. Empty artifact lists did not exercise native artifact reads. A separate [read-only container check](evidence/iphone-coding-independent-check.json) passed five independent checks without changing candidate hashes. Preserve this workspace and its receipts; the successful case does not establish live-provider behavior, Claude acceptance, host-loss recovery, or later milestones.

The runtime release and registered project source revisions are separate: the registered Praxis source remains `53cf0cdab55c0262f3cf8fa9246db5f3681cbe1a`. The fixed dependency image remains `sha256:a807793c27f53bf93480fc3dcfe73b2ab1b6bdf8b3aa1aca820118fd43767170`.

The endpoint is `https://mcp.jensenabler.com/praxis/mcp`; the issuer is `https://mcp.jensenabler.com/praxis/oauth`. The owner requested this public-prefix migration after initial coding activation. Internal service names and storage directories retain their historical names so existing jobs, workspaces, and credentials stay in place. The ChatGPT connection is named **Praxis** and must use the new URL. Its diagnostic authorization alone does not confer coding rights.

## Services and protected storage

| Component | Boundary and location |
| --- | --- |
| HTTPS gateway | nginx routes forward `/praxis/` and its path-qualified OAuth metadata to loopback port 8790. The old public prefix returns a migration response. Apocrypha and VPS Observer routes remain intact. |
| OAuth/MCP application | `praxis-probe.service`, user `praxis-probe` (UID 995), 256 MiB memory and 25% CPU. Root-owned immutable releases live under `/srv/praxis-probe/releases/`, selected by `/srv/praxis-probe/current`. |
| Bounded diagnostic worker | `praxis-probe-worker.service`, same diagnostic UID, 96 MiB memory and 15% CPU, no network. It runs only the fixed heartbeat fixture. |
| Coding backend/supervisor | `praxis-code.service`, separate user `praxis-code` (UID 993, GID 983), loopback port 8792. It independently validates original bearer tokens and has no OAuth private keys or owner password. |
| OAuth credentials and state | Root-only originals under `/etc/praxis-probe/credentials`; systemd loads credentials only for the web service. Private OAuth, probe job, and audit data live under `/var/lib/praxis-probe`. |
| Coding configuration and metadata | Root-owned `/etc/praxis-code/config.json` contains registered source paths, fixed runner settings, and public verification keys. Private coding journals, copied log records, and artifacts live under `/var/lib/praxis-code`. Commands never mount these directories. |
| Source exports | Root-owned immutable tracked-file exports under `/srv/praxis-code/projects/<project>/<commit>`. Exporting excludes Git internals, credential/runtime paths, links, and nonregular files. This filter supplements review; it is not a complete secret detector. |
| Command-writable disk | `/srv/praxis-code/storage`, an ext4 filesystem backed by a preallocated, root-owned 8 GiB file. Workspaces, container images, and container log files share approximately 7.8 GiB of usable capacity. |

The mount is persisted by `srv-praxis\x2dcode-storage.mount`, with `nosuid,nodev`; the coding unit requires it. Runtime state is under `/run/praxis-code`. Explicit Podman graphroot/runroot arguments prevent fallback into a home-directory image store. Application quotas separately bound metadata, receipts, artifacts, and diff caches on the host filesystem; the 8 GiB workspace/image cap does not describe total host disk usage.

Apocrypha, VPS Observer, both live podcast repositories and services, OpenClaw, and Docker remain outside ordinary coding access. Preserve their deployed revisions and configurations. Source exports and test workspaces are independent copies.

## Command execution policy

The service selects an exact local image digest and fixed Podman/crun arguments. Callers supply bounded argv, an allowed environment subset, and workspace-relative paths. They cannot select another image, host mount, socket, network mode, or container policy. Commands run in rootless Podman with `keep-id` user mapping, no network, a read-only image root, dropped capabilities, and container `no-new-privileges`. Only the selected workspace is bound writable; bounded temporary filesystems are also available. No host Docker socket or production credentials are mounted.

The enclosing coding systemd unit enforces aggregate limits across its backend and commands: 1.5 GiB memory, zero swap, one CPU, and 256 tasks. Per-container cgroups are disabled; the effective ancestor cgroup is the measured boundary. The outer service permits the required setuid `newuidmap`/`newgidmap` helpers, so its `NoNewPrivileges` setting is false. Container `no-new-privileges` remains true. A separate distro `crun` is pinned without changing Docker's runtime.

One coding command may be active at a time. Command runtime is 1–900 seconds with independent runtime timeout enforcement; image/user-mapping preparation has a separate 120-second control-call deadline. Cold preparation can take tens of seconds. Persisted status remains available during that work. Registered validation instructions use dependencies prepared in the read-only image; commands cannot install from the network. The historical replay alone uses a bundle installed with `--legacy-peer-deps` to accommodate its unchanged lockfile; see [replay evaluations](replay-evals.md).

## Authentication and grants

Authorization code + PKCE S256, owner password and consent, dynamic registration, and rotating refresh tokens are implemented using oidc-provider. The principal is `jensen`; the resource audience is the exact MCP URL. Each tool enforces its scope: `praxis:probe` for diagnostics and `praxis:code` for coding. The backend independently requires `praxis:code` using public signing keys. Refreshing an old probe grant does not add coding permission; the client must obtain a new, explicit coding grant.

Access JWTs last ten minutes; refresh tokens last 30 days. Offline verification means issued access tokens can remain valid for up to ten minutes after grant revocation. Preserve the password hash, signing key, and cookie keys across releases. Password renewal and key rotation require reviewed operator work. The owner password is outside Git, including the private local `C:\Users\Jensen\.codex\praxis-probe-private\login.txt`; never paste it into chat or command arguments. Other files in that private directory may contain credentials and are not deliverables.

## Jobs, recovery, and quotas

Coding jobs and mutation intents are persisted before effects. Identical principal/idempotency-key/payload retries recover existing receipts; changed input returns `IDEMPOTENCY_CONFLICT`. Use workspace, job, and operation lists after a missing response or fresh conversation. A missing client response does not establish that a command did not run.

The coding supervisor is independent of MCP requests and the gateway process. Gateway-only restart leaves coding supervision running. Recovery inspects deterministic container identities and preserves ambiguous work without launching it again. A prepared container is not started during recovery. A runtime outage leaves the job active and its workspace locked until observed state resolves the uncertainty. The PID lease treats possible PID reuse conservatively as still owned.

`startedAt` retains its first non-null public value. Observed runtime start time still controls deadlines. Confirmed worker timeout is `timed_out`; a stopped container with the runtime's negative monitor sentinel and matching elapsed time is reported as `interrupted` with `timeout_inferred` and an unknown process exit code. Unknown terminal containers are retained for operator diagnosis.

The coding unit uses `KillMode=control-group` and `OOMPolicy=kill`. Restarting that unit or losing the host can interrupt its commands. Recovery must report observed outcomes without rerunning ambiguous commands. The probe worker behaves separately: its previously running heartbeat is marked interrupted if that worker is killed. A phone or gateway disconnect is not equivalent to stopping either worker.

| Retention/control | Coding limit |
| --- | --- |
| Active/retained command jobs | 1 active, 200 retained |
| Stored command output | 1 MiB and 8,192 output records per job; explicit truncation |
| Artifacts | 16 per job, 512 KiB each, 2 MiB aggregate per job |
| Live workspaces | 20 |
| Mutation receipts | 10,000; 128 MiB aggregate stored request/plan data |
| Diff cache | One private cache, at most 600 MiB |

See [workspace contracts](workspace-contract.md) for source, edit, and page limits. Quota exhaustion requires eligible workspace cleanup or owner maintenance. Do not remove database rows or container files casually to bypass a quota. Probe limits remain separate: one active 1–180 second heartbeat job, up to 1,000 retained jobs and approximately 10,000 recent audit records.

No off-host backup, host-reboot acceptance, or host-loss recovery is claimed. SQLite WAL with synchronous FULL provides local durability; do not back up only a live `.sqlite` file and ignore its WAL. Use SQLite backup or quiesce the relevant services for coherent database/filesystem backup. Never place runtime SQLite on NFS. Preserve credentials and metadata separately from disposable workspaces.

## Bootstrap, activation, and future updates

Bootstrap is owner administration, not an agent-controlled updater. Review an exact source archive, prepare protected configuration and immutable exports, run `npm test` under the separate `praxis-probe-build` UID, and exercise authenticated MCP before activation. The build identity has no runtime credentials or runtime-directory access.

`deploy/install.sh` is the probe-era installer. Under the exclusive deployment lock, it now refuses execution when the coding service is active **or** the coding gateway drop-in exists. It does not coordinate coding jobs or backend migrations. Do not remove the guard/drop-in to force an ordinary update. Future coding-service releases require a reviewed procedure that accounts for both services, active execution, compatible metadata, exact source/image identity, and rollback. Independent self-update remains a later milestone.

For first coding activation only, `deploy/enable-code.sh <installed-release>` validates the installed release and protected configuration, starts the backend, verifies health, adds the gateway's loopback coding URL, restarts the gateway, and verifies coding metadata. The endpoint and issuer do not change. Failure restores gateway configuration but leaves the backend available for inspection so an already accepted command is not killed by a rollback assumption. Backups are under `/root/praxis-probe-backups/`.

The owner-requested public name migration has a separate one-time procedure, `deploy/migrate-endpoint.sh <tested-release>`. Prepare and test a new immutable release first. The migration preserves credentials and durable data, coordinates both services, validates the new OAuth identity through HTTPS with public ingress temporarily gated, and publishes `/praxis/mcp` after verification. The former endpoint returns an explicit 410 with reconnection guidance. A matching new native client connection is required. Before publication, failures restore protected configuration; after publication, automatic rollback is withheld because a caller could have started a job. Internal service names and data paths remain unchanged.

Read-only operator checks:

```sh
systemctl status praxis-probe.service praxis-probe-worker.service praxis-code.service --no-pager
readlink /srv/praxis-probe/current
curl -fsS https://mcp.jensenabler.com/praxis/healthz
curl -fsS http://127.0.0.1:8792/healthz
nginx -t
```

Gateway-only restart, with both workers left running:

```sh
systemctl restart praxis-probe.service
```

To stop accepting new public requests while preserving ongoing work, stop only the gateway and inspect the workers separately. Stopping the coding unit can terminate its active command; retain its database, logs, artifacts, and diagnostic container state. Any nginx removal or rollback must restore matching route configuration, pass `nginx -t`, and use a graceful reload. Code rollback does not undo database or workspace effects.

## Historical releases

The initial coding runtime `coding-8e25c6cf9000` passed all 59 Linux tests and all six authenticated real-container fixture groups. Its archive SHA-256 is `7e3ffebcafa1b913883328aa7b9146552123d33ee7c38b6f563f798a64be3377`, installation backup `/root/praxis-probe-backups/20260909T154713Z-DNFUnK`, and activation backup `/root/praxis-probe-backups/coding-activation-mRwp13JF`. At `2026-09-09T16:01:07Z`, its gateway boot was `7b54d3b6-4ea9-4b37-999c-e663d582abe1` and backend boot was `f76d9fa3-7668-4bfc-835d-d0957e0a6bc4`. Native ChatGPT discovery and the coding grant were confirmed at the old public prefix. The earlier report of 22 coding tools/31 total was a counting error; the verified count is 21 coding/30 total, explicitly corrected in the [canonical receipt](evidence/chatgpt-praxis-connection.json). Read-only counts at `2026-09-09T16:05:09.253960+00:00` found two active refresh-token records containing `praxis:code`, without exposing token values; [legacy connection evidence](evidence/chatgpt-coding-connection.json) preserves the historical record.

The initial deployed source `4abf8f3604cb` had archive SHA-256 `b4c40571dc74ccbd507588d502abe0550803fdc1ed8eb3e185e56f3d52ad91fc`, with backup `/root/praxis-probe-backups/20260909T031822Z-h2lQy3`. Release `probe-d78e02c44615` corrected native OAuth form origin handling; archive SHA-256 `c7763aa0869adae1403f181e0e5700c9f83f23a213a0b4cf864fa9ed57cb5a85`, backup `/root/praxis-probe-backups/20260909T035847Z-bevMeR`, and all 17 tests passed on the host before activation. These identify historical probe evidence, not the coding candidate.
