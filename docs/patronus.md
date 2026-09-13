# Patronus v1
Patronus is a persistent web reader on Alpha, exposed through the existing authenticated Praxis MCP connection. It runs as its own unprivileged service. Source remains in this repository; no new repository is required.

Tools: patronus_capabilities, patronus_start, patronus_status, patronus_jobs, patronus_result, patronus_artifact, patronus_cancel.

Runs never wait for human input. Use a previously provisioned profile or receive a terminal access diagnostic. Content is untrusted data. Reads and same-origin exploration preserve Markdown, source links and up to ten image artifacts per page. Screenshot output is optional. Downloads are streamed, hashed, bounded and available as authenticated byte pages. Concurrent browser work is limited to one job globally. Browser profiles persist in /var/lib/patronus/profiles.

Browser workers enable Chromium sandboxing, block service workers and WebSockets, restrict page requests to GET/HEAD, and send traffic through a DNS-pinning public-address proxy. Internal IP addresses are rejected on requests, redirects and browser subrequests. An agent does not evaluate page-provided instructions. No arbitrary script or shell input is accepted by the tools.

The API listens on /run/patronus/api.sock with mode 0600. Only Patronus and root can access it; the existing Praxis backend verifies owner OAuth before forwarding. The browser service has no Praxis credentials or root execution capability.

Operational defaults: 10 GiB artifact quota, 2 GiB disk reserve, 50 queued jobs, one active job, 120-second default deadline and 50 MiB default run budget. Administrators configure access outside runs. No credentials may be sent through tool arguments. Clear profile directories only while the service is stopped and after explicit owner direction.

Known boundaries: no Mega decryption adapter, no general clicking/forms or account modification, no human challenge solving, no automatic replay after service interruption, and no promise of X access. Public direct file downloads are supported. Query parameters are redacted in output metadata; full URLs needed for execution remain in the private job database. Page content may itself contain personal information and must be treated accordingly.

Install only from a published, reviewed Praxis source revision using scripts/install-patronus.py. It retains versioned deployments, installs dependencies and a Chromium build, writes the dedicated systemd unit, and verifies service start. Updating the Praxis tool manifest/backend still follows the normal Praxis release flow.

For an explicit retry of an interrupted download, pass resumeJobId with the same single URL and profile. Resume requires a stored strong ETag and a matching 206/Content-Range response; it never appends an unvalidated different object. Incomplete artifacts remain labeled incomplete. Import cookie-based access outside runs using scripts/patronus-profile.js while the service is stopped; local-storage authentication is not yet imported.


Validation checkpoint: 209 automated tests passed with no failures or skips. A temporary, unprivileged Chromium test on Alpha retrieved the podcast robots.txt with HTTP 200 and chromiumSandbox=true. It required a temporary AppArmor userns grant for the exact root-owned browser binary; that grant was removed after the test. Persistent installation of the corresponding scoped grant is pending owner approval following automatic approval review. Patronus and its MCP tools have not been deployed. Full transcript/image, JavaScript, authenticated-resource, X, and large-download acceptance journeys remain to be verified on the installed service.

Deployment prerequisite on Alpha: approve and configure a version-specific AppArmor rule granting userns to Patronus's exact root-owned Chromium executable paths. Do not disable Chromium sandboxing or change the global user-namespace restriction. The installer does not currently provision this rule. Retain the current Praxis release until Patronus passes its operational checks.

Owner approved the scoped persistent AppArmor exception on 2026-09-13. The installer now provisions exact executable-path grants for its versioned, root-owned browser build. Global user-namespace policy and Chromium sandboxing remain enabled. Deployment and live acceptance checks follow this checkpoint.
