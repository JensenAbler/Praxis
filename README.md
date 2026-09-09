# Praxis

Praxis gives a conversational model source access, isolated editing, command execution, and durable job recovery. ChatGPT or Claude supplies the reasoning; Praxis supplies the tools. The owner develops it openly in this public repository.

Praxis **0.3.0**, runtime `coding-98c4f1d79036`, is deployed with large-file patching, sequential patches, compact job status, durable recent output, and clearer tool contracts. It passed [99 Linux tests](docs/evidence/tool-quality-v03-linux.json) and [authenticated MCP checks with real containers](docs/evidence/tool-quality-v03-mcp.json). [The update](docs/evidence/tool-quality-v03-deployment.json) preserved all existing evaluation workspaces and jobs. See [what changed](docs/tool-quality-v03.md).

The preceding runtime completed the [first iPhone coding workflow](docs/evidence/iphone-coding-report.md) and [six varied replay implementations and recoveries](docs/evidence/replay-batch-v1-results.md). All six saved candidates passed independent behavioral checks. A native phone comparison of the new tool version is still pending. See [the milestone and boundaries](docs/coding-milestone.md), [acceptance evidence](docs/acceptance.md), and [workspace contracts](docs/workspace-contract.md).

The next authorized milestone is [independent publication and deployment](docs/publication-milestone.md): synchronize podcast-discord, commit and push to `main`, then fast-forward its fixed VPS deployment. Version 0.4.0 implements this workflow and is under qualification. Browser operation, unrelated production administration, and independent Praxis self-update remain later milestones.

Endpoint: **https://mcp.jensenabler.com/praxis/mcp**

The public endpoint and OAuth issuer use the `/praxis` prefix. Connections created against the earlier `/praxis-probe` endpoint need to be replaced. Coding tools require an explicit `praxis:code` grant; diagnostic permissions remain `praxis:probe`. Jobs live on the VPS independently of ChatGPT scratch files and the MCP web process.

## Connect and test

**Praxis is connected in the owner's ChatGPT account at the canonical endpoint.** Its refreshed actions show 21 coding tools and nine diagnostic tools, and the explicit coding grant is confirmed through native consent and server records; see [connection evidence](docs/evidence/chatgpt-praxis-connection.json). The legacy connection was uninstalled. The actual iPhone coding and diagnostic runs both recovered their existing work from fresh conversations. [The coding prompts and acceptance scope](docs/coding-phone-test.md) and [repeatable diagnostic prompts](docs/phone-test.md) remain available for client/version checks. [Probe evidence](docs/evidence/iphone-probe-report.md) covers the nine diagnostic tools. No model API key is needed.

ChatGPT account/workspace availability and mobile tool exposure must be verified in the actual account. Current setup guidance is [Connect and test a plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt). If the app does not expose connection creation, create it in the web account settings first, then check its availability in a new iPhone conversation. Schema changes require refreshing connection metadata and starting a new conversation. Claude can be tested separately through its remote MCP connection flow; compatibility is not claimed until observed.

## Local verification

Node 22.22 or newer is required. Run `npm ci --ignore-scripts` and `npm test`. Tests use disposable directories and test credentials. They cover OAuth and HTTP MCP calls, source/edit/diff behavior, stale revisions, concurrent duplicate submissions, cancellation, worker crashes, and recovery. Simulated runners exercise protocol and lifecycle behavior. The separate [Linux host fixture](docs/evidence/coding-host-bootstrap.json) records actual Podman execution, effective cgroups, network and mount policy, storage capacity, cancellation, independent timeout, and recovery; it does not claim deliberate resource-exhaustion stress or a phone coding run.

[Replay evaluations](docs/replay-evals.md) compare clean historical snapshots and private tasks against independent checks. The [completed first batch](docs/replay-batch-v1.md) covered three varied cases and six coding/recovery runs with a frozen tool release. Context-dependent historical requests are labeled as adapted. Private project source and original prompts stay outside this repository.

The deployed verification client reads credentials from private files. Set `PRAXIS_BASE_URL`, `PRAXIS_PASSWORD_FILE`, and `PRAXIS_CLIENT_STATE`, then run `node scripts/probe-client.js smoke`. The `start` and `recover` commands verify a 45-second job across an operator-triggered MCP app restart. Never put password/token values in shell arguments or Git.

See [operations](docs/operations.md), [acceptance evidence](docs/acceptance.md), and [constraint observations](docs/constraints.md).
