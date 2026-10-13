# Endpoint-local telemetry

Both the canonical Praxis endpoint and the Claude-compatible facade already record completed tool-handler successes and errors. They use the same handler wrapper and separate local observation stores.

`observations_list` and `usage_summary` include `observationScope` with the fixed serving endpoint (`canonical` or `claude_facade`) and `history: endpoint-local`. These labels identify endpoints, not agents. Reports do not merge stores or establish who authored a request. Historical rows are not relabeled.

Both adapters return `X-Praxis-Request-Id`. The HTTP observation uses that ID; completed tool receipts include it as `httpRequestId`, alongside their own tool request ID. HTTP observations measure transport completion/status and can include aborted requests. HTTP 200 alone does not establish successful tool execution.

A separate `kind: protocol` receipt observes a completed, non-aborted, non-batch `tools/call` request with a string or finite numeric JSON-RPC ID whose registered handler never started. It contains no requested tool name, arguments, error text, or inferred tool outcome. This makes unknown-tool and malformed request boundaries visible without rewriting or inspecting response streams. Notifications, null-ID messages, batches, pre-authentication/parser failures, and requests that never reach the adapter remain outside this bounded observation. Protocol receipts are not tool calls or confirmed failures.

Tool usage counts and failure rates continue to include only `kind: tool` receipts. Schema validation errors, backend-returned errors, and thrown handler errors remain recorded by the existing shared wrapper. Telemetry writes remain best effort and do not change completed tool responses.

No arguments, result content, messages, tokens, client identities, or authentication values are added to observations. Existing storage sanitization, endpoint-local ownership, retention, and pagination remain unchanged. The 10,000-row/30-day cap covers all observation kinds together; additional HTTP/protocol rows can reduce the time span retained for tools.

Regression coverage in `test/endpoint-telemetry.test.js` exercises both actual HTTP transport adapters with disposable authentication/backend fixtures. It does not claim a live Claude client session.
