# Praxis

Praxis gives a conversational model source access, isolated editing, command execution, and durable job recovery. ChatGPT or Claude supplies the reasoning; Praxis supplies the tools. The owner develops it openly in this public repository.

The coding milestone is implemented and under deployment verification. It adds registered source snapshots, disposable workspaces, content-hash edit preconditions, contextual diffs, sandboxed commands, artifacts, and persisted operation receipts. The existing heartbeat probe is the verified hosted baseline. See [the milestone and boundaries](docs/coding-milestone.md) and [workspace contracts](docs/workspace-contract.md) for current scope; GitHub operations through Praxis, deployment, browser use, and independent self-update are later milestones.

Endpoint: **https://mcp.jensenabler.com/praxis-probe/mcp**

The endpoint and OAuth issuer stay stable. Coding tools require an explicit `praxis:code` grant; an existing `praxis:probe` token retains its original diagnostic permissions. Jobs live on the VPS independently of ChatGPT scratch files and the MCP web process.

## Connect and test

**Praxis Probe is connected through OAuth in the owner's ChatGPT account.** The first actual iPhone diagnostic run and reported fresh-conversation recovery passed, corroborated by server records; see [the evidence and remaining friction](docs/evidence/iphone-probe-report.md). That evidence covers the nine probe tools. Coding tool activation and actual phone acceptance are being verified separately. No model API key is needed. [Setup details and repeatable diagnostic prompts](docs/phone-test.md) remain available for later client/version checks.

ChatGPT account/workspace availability and mobile tool exposure must be verified in the actual account. Current setup guidance is [Connect and test a plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt). If the app does not expose connection creation, create it in the web account settings first, then check its availability in a new iPhone conversation. Schema changes require refreshing connection metadata and starting a new conversation. Claude can be tested separately through its remote MCP connection flow; compatibility is not claimed until observed.

## Local verification

Node 22.22 or newer is required. Run `npm ci --ignore-scripts` and `npm test`. Tests use disposable directories and test credentials. They cover actual OAuth and HTTP MCP calls, source/edit/diff behavior, stale revisions, concurrent duplicate submissions, cancellation, worker crashes, and recovery. Fixture runners exercise protocol and lifecycle behavior; separate Linux host evidence is required for actual Podman isolation and resource enforcement.

[Replay evaluations](docs/replay-evals.md) compare an exact source snapshot and original task against independent checks. The public catalog contains provenance and mechanical checks. Private project source and original prompts are kept outside this repository.

The deployed verification client reads credentials from private files. Set `PRAXIS_BASE_URL`, `PRAXIS_PASSWORD_FILE`, and `PRAXIS_CLIENT_STATE`, then run `node scripts/probe-client.js smoke`. The `start` and `recover` commands verify a 45-second job across an operator-triggered MCP app restart. Never put password/token values in shell arguments or Git.

See [operations](docs/operations.md), [acceptance evidence](docs/acceptance.md), and [constraint observations](docs/constraints.md).
