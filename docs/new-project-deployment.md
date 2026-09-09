# Publishing new projects as managed applications

The protected project deployer stages exact published source, runs the app as a
restricted dynamic system user, and serves it at
`https://praxis-apps.jensenabler.com/apps/<projectId>/`. It never executes the candidate
application, its package scripts, hooks, installers, or health commands as root.

The trusted Git broker supplies the registered runtime and an immutable source
export after checking owner access and publication on GitHub main. The root
helper independently validates the export's project, commit, revision, every
file hash/size, ownership and path safety. It does not accept caller source
paths, arbitrary services, ports, environment variables, hostnames or commands.

## Fixed helper contract

Install `deploy-project.py` as root-owned executable
`/usr/local/libexec/praxis-deploy-project` and permit the trusted Git broker to
sudo that exact executable with no command-line arguments. JSON stdin:

```json
{
  "action": "apply",
  "operationId": "<canonical UUID>",
  "projectId": "p-<owner hash>-<safe project name>",
  "exportId": "<canonical UUID>",
  "targetCommit": "<published Git commit>",
  "expectedHead": null,
  "runtime": "node"
}
```

Use `expectedHead: null` only for the first deployment; later requests must name
the exact current deployed commit. Node projects with runtime dependencies must
also provide `preparedDependenciesId`, a sealed artifact from the sandbox.
To replace a failed or uncertain deployment with a repaired published revision,
provide `recoverOperationId` naming that deployment and its exact current commit
as `expectedHead`. The older outcome is preserved with a `resolvedBy` link.
Source comes only from
`/srv/praxis-git-exchange/exports/<exportId>/{manifest.json,files/}`.

`{"action":"status","projectId":"<id>"}` observes current source and service
state. Add `operationId` to recover an operation. Identical mutation inputs use
the same operation ID. Conflicting input reuse is rejected; interrupted restart
or nginx reload outcomes are observed rather than blindly repeated.

## Host bootstrap

Create root-owned, non-worker-writable directories:

- `/var/lib/praxis-deploy/projects` for registry, lock, and durable journals.
- `/srv/praxis-apps` for immutable application releases.
- `/etc/nginx/praxis-apps` for the fixed per-project proxy includes.

A dedicated `praxis-apps.jensenabler.com` HTTPS server block must include
`/etc/nginx/praxis-apps/*.conf`. The helper writes only derived project includes,
runs `nginx -t`, and reloads nginx after successful validation. A newly-created
include is removed if validation fails; existing routes and unrelated service
configuration are preserved.

The application origin must remain separate from `mcp.jensenabler.com`, which
hosts Praxis authentication. A URL path is not an origin isolation boundary:
untrusted application JavaScript must not share the OAuth service's origin.

The host supports five managed apps, allocated ports 18700–18704 under one
protected lock. Templates use these fixed entrypoints:

| Runtime | Service command | Health |
| --- | --- | --- |
| Node | `/usr/bin/node server.js` | `GET /healthz` |
| Python | `/usr/bin/python3 app.py` | `GET /healthz` |
| Static | Isolated Python standard-library HTTP server | Static `healthz` file |

The proxy strips `/apps/<projectId>/` before forwarding requests. Apps receive
`PORT` and should use relative asset links or account for their public prefix.
Custom domains and arbitrary runtime commands are outside this fixed adapter.
Python applications currently use the host standard library; deployment of
third-party Python environments is not included. Prepared Node dependencies use
the same verified archive extractor as podcast-discord, with no root installers.

Each service has `DynamicUser`, strict filesystem protection, private temporary
files/devices, no ambient capabilities, no privilege escalation, a fixed
allowed bind port, 256 MiB memory, 25% CPU,
64 tasks, and bounded journal rate. App source is root-owned and immutable to the
runtime user. This initial adapter supports stateless HTTP applications. Writable
storage is limited to memory-backed `/tmp` (64 MiB) and `/var/tmp` (16 MiB), which
does not survive service restart. Persistent databases, uploads and app secrets
require a later separately provisioned storage/secret capability. The helper
limits retained releases to 2 GiB per app and 6 GiB total and preserves at least
1 GiB host free space while staging, including dependency extraction reserves.

## Persistence and health evidence

Releases live at `/srv/praxis-apps/<id>/releases/<commit>/files`, with a protected
attestation for the source revision/runtime/dependency artifact. Activation swaps
one controlled symlink and retains previous releases. Service restart and nginx
reload intentions are persisted before those effects. Lost responses can be
recovered from the resulting invocation and HTTP observations. An unproven
outcome remains explicitly uncertain and blocks further deployment of that app.

Completion requires a new stable service invocation and successful `/healthz`
responses both on its loopback port and through the dedicated HTTPS nginx host.
Health bodies are discarded. This checks routing and the app's own readiness
endpoint, not every application feature or external dependency. Units are
enabled for boot before activation. Failed or uncertain operations remain
visible, and no unrelated app is restarted.

The Linux fixture tests use fake systemd, nginx and health responses. They verify
source hashes, controlled privileges, exact-head updates, retained releases,
operation recovery, configuration restoration, port limits and fixed templates.
Real systemd unit syntax is separately checked using `systemd-analyze verify`;
these checks do not claim a live app deployment or phone run.
