# Probe operations

## Deployment inventory and boundaries

- Existing VPS 31.97.135.128 and TLS hostname mcp.jensenabler.com; no new purchases.
- Fixed path `/praxis-probe/` and three path-qualified OAuth metadata locations, forwarded by nginx to loopback port 8790. Existing Apocrypha and observer locations remain in place.
- Immutable root-owned releases under `/srv/praxis-probe/releases/`, selected by `/srv/praxis-probe/current`.
- Separate systemd `praxis-probe.service` and `praxis-probe-worker.service`, unprivileged user `praxis-probe`. Web memory cap 256MB/25% CPU; worker 96MB/15% CPU. Worker has no network. Web accepts loopback proxy traffic only.
- SQLite jobs, audit observations, and OAuth state under private `/var/lib/praxis-probe`. This single-host fixture shares a runtime UID; it is not the future isolation boundary for arbitrary development commands.
- Root-only credential originals under `/etc/praxis-probe/credentials`; systemd loads only the web service's required credentials. Public-key material is intentionally published through OAuth JWKS.
- Initial deployed source commit `4abf8f3604cb`, archive SHA-256 `b4c40571dc74ccbd507588d502abe0550803fdc1ed8eb3e185e56f3d52ad91fc`; configuration backup `/root/praxis-probe-backups/20260909T031822Z-h2lQy3`.
- Candidate dependency installation/tests run under distinct `praxis-probe-build` identity, without runtime-directory access. This bootstrap installer is owner-run code, not an application-controlled updater.

The probe exposes only a fixed heartbeat loop. No repository access, host administration, production adapter, external model call, browser tool, or general shell is present.

## Authentication

Issuer is `https://mcp.jensenabler.com/praxis-probe/oauth`; resource audience is the exact `/mcp` endpoint. Owner principal is `jensen`, scope `praxis:probe`. Authorization code + PKCE S256, owner password and consent, dynamic registration, and rotating refresh tokens are implemented using oidc-provider. Access JWTs last ten minutes; refresh tokens last 30 days. Refresh is tested across service recreation. Offline JWT validation means already issued access tokens may remain valid for up to ten minutes after grant revocation.

Password, signing key, and cookie keys must survive normal releases. Losing or replacing them changes authorization continuity. Password renewal and key rotation are exceptional operator work for this probe; the full Praxis account-management design is deferred. Sign-in itself uses an HTTPS phone-accessible form.

The local owner password file is outside the repository, in `C:\Users\Jensen\.codex\praxis-probe-private\login.txt`, with inherited permissions removed. Transfer it to the owner's password manager; never paste it into chat. Other files in that private directory contain sensitive signing or verification-client state and are not deliverables.

## Jobs, quotas, and evidence

One active job, 1–180 seconds, heartbeat interval 1–10 seconds. Start retries with the same principal/key/payload recover the same job; changed input returns IDEMPOTENCY_CONFLICT. Fresh clients can list and inspect all owner jobs. Completed jobs are not rerun. A killed worker's previously running job is marked interrupted on recovery. A PID-only singleton check can conservatively refuse startup after PID reuse; inspect the recorded PID before operator intervention.

Jobs/logs are retained up to 1,000 jobs, then new creation stops until an operator archives data. Audit observations retain approximately the latest 10,000 records. `resultJsonBytes` measures one JSON result, not the complete MCP envelope, which also contains a text copy. Synthetic byte counts describe payload only. These fixtures measure specific calls, not a universal client output limit.

No off-host backup or host-loss recovery is claimed. SQLite WAL with synchronous FULL and process-restart tests provide local durability evidence. Do not copy only a live `.sqlite` file while ignoring its WAL; use SQLite backup or stop both probe services before a coherent backup. Never place the data directory on NFS.

## Bootstrap and independent recovery

Generate credentials with `node scripts/create-credentials.js <private-directory>` outside Git. On Windows restrict the directory ACL before generation. Copy only password-hash, jwks.json and cookie-keys.json to the root-only server credential directory. Transfer an explicitly reviewed source archive to a unique release directory. Run `bash /srv/praxis-probe/releases/<release>/deploy/install.sh <release>` through existing owner SSH. The script validates release names, tests without root, backs up changed configuration, validates nginx, activates only the two probe services, and gracefully reloads nginx. Upgrades refuse active jobs.

Use the latest repository installer for future bootstrap releases: it adds an exclusive deployment lock beyond the installer captured in the initial source archive. The application/worker source is unchanged.

Inspect without changes:

```sh
systemctl status praxis-probe.service praxis-probe-worker.service --no-pager
readlink /srv/praxis-probe/current
curl -fsS https://mcp.jensenabler.com/praxis-probe/healthz
nginx -t
```

Application-only restart (jobs stay supervised):

```sh
systemctl restart praxis-probe.service
```

Installer rollback restores previous files, release selection, and prior service activity if activation fails. Backups are under `/root/praxis-probe-backups/`. For emergency disablement, stop only `praxis-probe.service` and `praxis-probe-worker.service`; existing services need no restart. To remove the route, restore the matching backed-up nginx site/snippet, validate with `nginx -t`, then `systemctl reload nginx`. Preserve runtime data and credentials for diagnosis. Manual release rollback must use an existing known-good immutable release with compatible databases; code rollback does not undo data changes. Full independent transactional self-update is outside this probe.
