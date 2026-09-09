# Praxis acceptance

The first coding workflow is deployed on runtime `coding-8e25c6cf9000`. Automated local, Linux, and authenticated-client evidence are recorded separately from native ChatGPT and iPhone observations. The full original specification and later roadmap are not represented as complete.

## Coding workflow

| Check | Status | Evidence and scope |
| --- | --- | --- |
| Complete candidate test suite | Passed on Linux | Runtime `coding-8e25c6cf9000`: 59 tests passed, zero failures/skips, under the separate build UID before installation. Includes authenticated HTTP MCP integration with test credentials and startup/health/shutdown through the release symlink. |
| Source snapshots, isolated workspaces, edits, diffs, receipts | Passed in automated tests | `test/workspaces.test.js` and `test/coding-mcp.test.js` cover all edit actions, ownership, hash/revision conflicts, path/link rejection, mutation recovery, and bounded pagination. |
| Stable command identity and start timestamp | Passed in regression tests | `test/code-jobs.test.js` observes a response while runtime inspection is pending, reopens SQLite, recovers/completes the same command, and verifies unchanged `startedAt` without another launch. Runtime deadlines still use actual observed start time. |
| Real Linux command lifecycle and isolation policy | Passed in the recorded host fixture | [Host fixture evidence](evidence/coding-host-bootstrap.json): real fail/edit/pass, cgroup files, network/mount policy, recovery, artifacts, cancellation, independent timeout, bounded output, and filesystem capacity. The receipt identifies the exact source/image scope; deliberate resource exhaustion is not claimed. |
| Full authenticated MCP with actual Podman | Passed on the deployed runtime | [MCP host evidence](evidence/coding-mcp-host.json): fixture `95f95917-78b7-434b-baf8-24361d07da64` passed all six groups, covering permission boundaries, discovery/create, edits/conflicts, real command across gateway recreation, fresh-client recovery/idempotency, and paginated logs/artifacts/diff/receipts. Artifact hash was independently verified. The earlier timestamp failure and read-only recovery remain recorded. Temporary fixture authority is distinct from live owner OAuth. |
| Prepared dependencies and clean project checks | Mixed baseline results | [Project validation](evidence/project-validation.json) records isolated, offline checks without candidate edits. The historical replay passed 75 tests, production snapshot passed 35 Python tests, and the registered Praxis snapshot passed. Current Discord snapshot reported 93 passed/2 failed and is not accepted as passing. Runtime release and registered source revisions differ intentionally. |
| Current Discord native media failure investigation | Reproduced and narrowed | [Synthetic media diagnostic](evidence/native-media-diagnostic.json): short silent input with `dynaudnorm` crashed, including with one-thread settings; omitting the filter or using longer input succeeded. Observed events do not support PID-limit or OOM causation. This is not a validated fix or a passing Discord baseline. |
| Independent historical task checker | Base rejected; historical reference accepted in local mocked checks | [Checker baseline](evidence/replay-checker-baseline.json). Reference source stays outside candidate context. This is not a new agent implementation, real-provider evaluation, or OS-isolation result. |
| Public coding activation | Passed | At `2026-09-09T16:01:07Z`, public health reported Praxis 0.2.0 on `coding-8e25c6cf9000`; the separate coding backend was active and enabled with its configured cgroup bounds. [Operations](operations.md) records release, archive, backup, and boot identities. |
| Native ChatGPT coding discovery | Passed | Refresh on the existing Praxis connection loaded 31 actions: 22 coding and nine probe tools, with the coding scope required. Discovery is not proof of phone execution. |
| Native ChatGPT `praxis:code` grant | Confirmed; actual coding execution pending | [Connection evidence](evidence/chatgpt-coding-connection.json): native consent explicitly described isolated coding, and the existing connection reports OAuth with zero reconnect-needed labels. Read-only server counts at `2026-09-09T16:05:09.253960+00:00` found two active refresh-token records containing `praxis:code`; token values were not exposed. An expired authorization attempt was resolved by a fresh reconnect using the existing owner session, without password entry. This does not establish native coding-tool execution. |
| Actual iPhone coding task and fresh-conversation recovery | Pending owner run | [Coding phone prompts](coding-phone-test.md). Record actual workspace/job/operation IDs, complete test summaries, diff recovery, and tooling friction. |
| Actual Claude coding connection | Not exercised | Separate account/client acceptance remains necessary. |
| Host restart/loss and off-host backup | Not exercised | Local persistence and application recreation do not establish host-loss recovery. |
| GitHub tools, production deployment/maintenance, browser use, self-update | Later milestones | No success-returning placeholders are exposed. Public development of this repository is owner bootstrap work, separate from Praxis agent capabilities. |

The authenticated host fixture recreates a gateway application instance and HTTP listener while its coding backend remains alive in the same test process. It must not be described as a restart of an OS service process. A terminal job receipt with exit 0 is insufficient by itself: use final suite summaries, retained logs, and independent behavioral checks where available. Current limitations and failed attempts remain evidence even after a corrected run passes.

## Historical diagnostic probe

The following matrix covers the bounded heartbeat probe, including the actual iPhone diagnostic run. It does not establish coding acceptance.

| Check | Status | Evidence |
| --- | --- | --- |
| Actual OAuth owner login, PKCE, issuer/audience/scope validation | Passed locally | test/auth.test.js |
| Unsafe callback/metadata rejection, wrong password, CSRF/origin | Passed locally | test/auth.test.js |
| Refresh rotation and persistence across auth recreation | Passed locally | test/auth.test.js |
| Authenticated HTTP MCP discovery and all fixture workflows | Passed locally | test/auth.test.js, test/mcp.test.js |
| Concurrent idempotency, pagination, cancellation, worker hard-kill | Passed locally | test/jobs.test.js |
| Fresh SDK client recovers existing jobs | Passed locally | test/mcp.test.js |
| Public HTTPS, OAuth discovery, and unauthenticated MCP rejection | Passed | evidence/public-endpoint.json |
| Public HTTPS authenticated ChatGPT connection and tool discovery | Passed | evidence/chatgpt-connection.json; ChatGPT settings show Connected, Authorization used OAuth, and all nine actions after Refresh. This does not establish actual tool execution from an iPhone. |
| Separate automated verification-client sign-in | Blocked by automatic execution review | Earlier command was rejected twice, including after explicit user authorization; only "blocked by policy" was returned. This limitation was separate from the later successful native ChatGPT OAuth connection. |
| Deployed MCP application restart during real worker job | Passed through SSH administration | evidence/host-worker-restart.json; original job 10579cb0-e7a5-4d8d-bc86-95a7f833fb7d completed with 10 sequential heartbeats. Web PID changed; worker PID did not. This is not public authenticated MCP evidence. |
| Actual iPhone tool use and fresh-conversation recovery | Passed in this owner-reported run, corroborated by VPS records | evidence/iphone-probe-report.md and evidence/iphone-recovery-server.json; one job, 24 heartbeats, 26 records, all six initial request receipts matched. Client serialization/extra error-label observations remain unresolved. |
| Actual Claude connection | Not exercised | Separate account/client experiment |
| Host restart/loss and off-host backup | Not exercised | No reboot or production disruption |
| Coding workflow and replay evaluation | Tracked separately above | Probe success is not a substitute for coding acceptance. Browser, protected production adapters, and self-update remain later milestones. |

Release `probe-4abf8f3604cb` passed all 16 then-existing tests on the VPS as the separate build user. A subsequent local test explicitly verified the legacy 2025-11-25 MCP protocol, in addition to the SDK client. No runtime source changed for that added test.

The Codex in-app browser initially showed Security and login → Developer mode disabled/off, with no create control. After the owner toggled Developer mode off and on in their normal browser, reloading the in-app page exposed **Create app** at ChatGPT Plugins. The cause of the earlier state is unknown.

The web form used name **Praxis Probe**, URL `https://mcp.jensenabler.com/praxis-probe/mcp`, and OAuth. Advanced settings discovered dynamic client registration and the correct authorization/token endpoints and resource. Discovered scopes were `praxis:probe offline_access`; base scope was set to `offline_access`. Optional OIDC/email lookup was disabled because the fixture does not provide email or userinfo; OAuth remained enabled. The unreviewed-server notice was accepted and **Create** produced connector `asdk_app_6aa0d8a46ad08191b05827a9824cd295`. The owner completed native sign-in. Reconnecting the existing plugin after an invalid/expired prior attempt succeeded. ChatGPT reported the OAuth connection, and Refresh loaded all nine tools and their required scopes. The subsequent owner-supplied iPhone reports and independent server checks are recorded above.

The first native browser sign-in returned `Invalid form origin`. `Referrer-Policy: no-referrer` suppressed the native form's Origin header. Release `probe-d78e02c44615` changes this to `strict-origin` while retaining exact-origin and CSRF checks. All 17 tests passed locally and on the VPS, including rejection of Origin:null. Native OAuth connection subsequently succeeded as described above. Scripted HTTP tests supplying Origin explicitly had missed this browser behavior.

Both podcast repositories retained their original deployed HEADs and clean working trees after bootstrap, recorded in the SSH evidence. The only intentional service restart in the durability check was praxis-probe.service.

Do not interpret the heartbeat fixture as proof of arbitrary coding-job isolation or deployment safety. The historical checks in this section concern the bounded diagnostic service.
