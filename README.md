# Praxis capability probe

This is the diagnostic step before building the complete Praxis coding service described in [the original specification](docs/original-specification.md). It measures actual remote MCP connectivity, tool results, errors, and durable jobs. It does not yet edit repositories or execute arbitrary commands.

Endpoint: **https://mcp.jensenabler.com/praxis-probe/mcp**

Nine authenticated tools provide capability discovery, synthetic responses, a controlled error, bounded heartbeat jobs, cancellation, recovery, and sanitized observation receipts. Jobs live on the VPS independently of ChatGPT scratch files and the MCP web process.

## Connect and test

The **Praxis Probe** connection has been created in the owner's ChatGPT account; owner OAuth sign-in is pending. Complete the open sign-in using the private probe password, then allow the connection. No model API key is needed. After connection succeeds, attach it to a new conversation and use [the setup details and phone test prompts](docs/phone-test.md).

ChatGPT account/workspace availability and mobile tool exposure must be verified in the actual account. Current setup guidance is [Connect and test a plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt). If the app does not expose connection creation, create it in the web account settings first, then check its availability in a new iPhone conversation. Schema changes require refreshing connection metadata and starting a new conversation. Claude can be tested separately through its remote MCP connection flow; compatibility is not claimed until observed.

## Local verification

Node 22.22 or newer is required. Run `npm ci --ignore-scripts` and `npm test`. Tests use disposable directories and test credentials. They cover actual OAuth and HTTP MCP calls, concurrent duplicate submissions, cancellation, worker crashes, and recovery.

The deployed verification client reads credentials from private files. Set `PRAXIS_BASE_URL`, `PRAXIS_PASSWORD_FILE`, and `PRAXIS_CLIENT_STATE`, then run `node scripts/probe-client.js smoke`. The `start` and `recover` commands verify a 45-second job across an operator-triggered MCP app restart. Never put password/token values in shell arguments or Git.

See [operations](docs/operations.md), [acceptance evidence](docs/acceptance.md), and [constraint observations](docs/constraints.md).
