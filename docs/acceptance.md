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
| Public HTTPS OAuth and MCP | Pending deployment verification | evidence/ |
| MCP application restart during real worker job | Pending deployment verification | evidence/ |
| Actual iPhone custom connection and fresh conversation | Pending owner account test | phone-test.md |
| Actual Claude connection | Not exercised | Separate account/client experiment |
| Host restart/loss and off-host backup | Not exercised | No reboot or production disruption |
| Full coding, browser, protected adapters, self-update, replay eval | Deferred | Original specification and constraints.md |

Do not interpret the heartbeat fixture as proof of arbitrary coding-job isolation or deployment safety. All checks concern this bounded diagnostic service.
