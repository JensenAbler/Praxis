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
| Public HTTPS authenticated client session | Blocked by automatic execution review | The automated owner sign-in command was rejected twice, including after explicit user authorization; only "blocked by policy" was returned. No password or tokens were printed. |
| Deployed MCP application restart during real worker job | Passed through SSH administration | evidence/host-worker-restart.json; original job 10579cb0-e7a5-4d8d-bc86-95a7f833fb7d completed with 10 sequential heartbeats. Web PID changed; worker PID did not. This is not public authenticated MCP evidence. |
| Actual iPhone custom connection and fresh conversation | Pending owner account test | phone-test.md |
| Actual Claude connection | Not exercised | Separate account/client experiment |
| Host restart/loss and off-host backup | Not exercised | No reboot or production disruption |
| Full coding, browser, protected adapters, self-update, replay eval | Deferred | Original specification and constraints.md |

Release `probe-4abf8f3604cb` passed all 16 then-existing tests on the VPS as the separate build user. A subsequent local test explicitly verified the legacy 2025-11-25 MCP protocol, in addition to the SDK client. No runtime source changed for that added test.

The available signed-in ChatGPT web interface showed Security and login → Developer mode disabled/off, and no create control in Personal plugins. Existing Apocrypha and VPS Observer connections were visible. No setting was changed and no Praxis account connection was created. This observation does not establish the reason or availability in the owner's normal browser/iPhone.

Both podcast repositories retained their original deployed HEADs and clean working trees after bootstrap, recorded in the SSH evidence. The only intentional service restart in the durability check was praxis-probe.service.

Do not interpret the heartbeat fixture as proof of arbitrary coding-job isolation or deployment safety. All checks concern this bounded diagnostic service.
