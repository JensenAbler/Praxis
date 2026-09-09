# Diagnostic acceptance

This matrix covers the agreed capability probe. The complete original Praxis specification is not implemented or represented as complete.

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
| Full coding, browser, protected adapters, self-update, replay eval | Deferred | Original specification and constraints.md |

Release `probe-4abf8f3604cb` passed all 16 then-existing tests on the VPS as the separate build user. A subsequent local test explicitly verified the legacy 2025-11-25 MCP protocol, in addition to the SDK client. No runtime source changed for that added test.

The Codex in-app browser initially showed Security and login → Developer mode disabled/off, with no create control. After the owner toggled Developer mode off and on in their normal browser, reloading the in-app page exposed **Create app** at ChatGPT Plugins. The cause of the earlier state is unknown.

The web form used name **Praxis Probe**, URL `https://mcp.jensenabler.com/praxis-probe/mcp`, and OAuth. Advanced settings discovered dynamic client registration and the correct authorization/token endpoints and resource. Discovered scopes were `praxis:probe offline_access`; base scope was set to `offline_access`. Optional OIDC/email lookup was disabled because the fixture does not provide email or userinfo; OAuth remained enabled. The unreviewed-server notice was accepted and **Create** produced connector `asdk_app_6aa0d8a46ad08191b05827a9824cd295`. The owner completed native sign-in. Reconnecting the existing plugin after an invalid/expired prior attempt succeeded. ChatGPT reported the OAuth connection, and Refresh loaded all nine tools and their required scopes. The subsequent owner-supplied iPhone reports and independent server checks are recorded above.

The first native browser sign-in returned `Invalid form origin`. `Referrer-Policy: no-referrer` suppressed the native form's Origin header. Release `probe-d78e02c44615` changes this to `strict-origin` while retaining exact-origin and CSRF checks. All 17 tests passed locally and on the VPS, including rejection of Origin:null. Native OAuth connection subsequently succeeded as described above. Scripted HTTP tests supplying Origin explicitly had missed this browser behavior.

Both podcast repositories retained their original deployed HEADs and clean working trees after bootstrap, recorded in the SSH evidence. The only intentional service restart in the durability check was praxis-probe.service.

Do not interpret the heartbeat fixture as proof of arbitrary coding-job isolation or deployment safety. All checks concern this bounded diagnostic service.
