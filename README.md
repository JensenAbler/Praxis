# Praxis

Praxis gives a conversational model source access, isolated editing, command execution, and durable job recovery. ChatGPT or Claude supplies the reasoning; Praxis supplies the tools. The owner develops it openly in this public repository.

The first coding workflow is deployed: registered source snapshots, disposable workspaces, content-hash edit preconditions, contextual diffs, sandboxed commands, artifacts, and persisted operation receipts. Runtime `coding-8e25c6cf9000` passed 59 Linux tests and the authenticated MCP fixture with real containers. The coding run from an actual iPhone and its fresh-conversation recovery remain pending. See [the milestone and boundaries](docs/coding-milestone.md), [acceptance evidence](docs/acceptance.md), and [workspace contracts](docs/workspace-contract.md). GitHub operations through Praxis, production deployment, browser use, and independent self-update are later milestones.

Endpoint: **https://mcp.jensenabler.com/praxis/mcp**

The public endpoint and OAuth issuer use the `/praxis` prefix. Connections created against the earlier `/praxis-probe` endpoint need to be replaced. Coding tools require an explicit `praxis:code` grant; diagnostic permissions remain `praxis:probe`. Jobs live on the VPS independently of ChatGPT scratch files and the MCP web process.

## Connect and test

**The existing OAuth connection in the owner's ChatGPT account is now named Praxis.** Its refreshed actions show 22 coding tools and nine probe tools, and the explicit coding grant is confirmed through native consent and server records; see [connection evidence](docs/evidence/chatgpt-coding-connection.json). Actual native coding-tool execution remains pending. The first actual iPhone diagnostic run and fresh-conversation recovery passed; [the probe evidence](docs/evidence/iphone-probe-report.md) covers the nine diagnostic tools. No model API key is needed. The next step is [the coding phone test](docs/coding-phone-test.md); [repeatable diagnostic prompts](docs/phone-test.md) remain available for client/version checks.

ChatGPT account/workspace availability and mobile tool exposure must be verified in the actual account. Current setup guidance is [Connect and test a plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt). If the app does not expose connection creation, create it in the web account settings first, then check its availability in a new iPhone conversation. Schema changes require refreshing connection metadata and starting a new conversation. Claude can be tested separately through its remote MCP connection flow; compatibility is not claimed until observed.

## Local verification

Node 22.22 or newer is required. Run `npm ci --ignore-scripts` and `npm test`. Tests use disposable directories and test credentials. They cover OAuth and HTTP MCP calls, source/edit/diff behavior, stale revisions, concurrent duplicate submissions, cancellation, worker crashes, and recovery. Simulated runners exercise protocol and lifecycle behavior. The separate [Linux host fixture](docs/evidence/coding-host-bootstrap.json) records actual Podman execution, effective cgroups, network and mount policy, storage capacity, cancellation, independent timeout, and recovery; it does not claim deliberate resource-exhaustion stress or a phone coding run.

[Replay evaluations](docs/replay-evals.md) compare an exact source snapshot and original task against independent checks. The public catalog contains provenance and mechanical checks. Private project source and original prompts are kept outside this repository.

The deployed verification client reads credentials from private files. Set `PRAXIS_BASE_URL`, `PRAXIS_PASSWORD_FILE`, and `PRAXIS_CLIENT_STATE`, then run `node scripts/probe-client.js smoke`. The `start` and `recover` commands verify a 45-second job across an operator-triggered MCP app restart. Never put password/token values in shell arguments or Git.

See [operations](docs/operations.md), [acceptance evidence](docs/acceptance.md), and [constraint observations](docs/constraints.md).
