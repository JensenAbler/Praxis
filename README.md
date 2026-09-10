# Praxis

Praxis gives a conversational model source access, isolated editing, command execution, durable recovery, and controlled Git publication and deployment. ChatGPT or Claude supplies the reasoning; Praxis supplies the tools. The owner develops it openly in this public repository.

Praxis **0.5.0** is deployed with application `app-5c1b8996c7e2-fb3fad80` and protected control release `b8975385bc4f`. An authenticated API client completed the new-project workflow: create a project, install an npm dependency, validate offline, seal its dependency bundle, commit and publish a private GitHub repository, deploy an HTTPS app, and recover the result from a fresh client. The helper patch at `b8975385bc4f` passed 169 Linux Node tests and 142 Python helper tests. See the [live evidence](docs/evidence/autonomy-v05-live.json) and [milestone record](docs/autonomy-milestone.md).

The first real phone-driven task on 0.4 published and deployed podcast-discord commit `5f6a212646f6fbe95b99135a2f918f9edc54eb90`. That deployment remains unchanged during the 0.5 qualification. Earlier phone runs completed the [first coding workflow](docs/evidence/iphone-coding-report.md) and [six varied replay implementations and recoveries](docs/evidence/replay-batch-v1-results.md); all six saved candidates passed independent behavioral checks. The new 0.5 capabilities have not yet been exercised from an actual iPhone conversation.

The deployed tools cover [new projects](docs/new-projects.md), [isolated app hosting](docs/new-project-deployment.md), [production recovery](docs/production-recovery.md), [dependency changes](docs/dependencies.md), and [independent application updates](docs/self-improvement.md). Praxis completed its first live self-update: it committed and pushed source-freshness guidance, prepared and activated that exact application release, and recovered the result through a fresh authenticated API client. Production diagnosis and history reads also work. New bot restart/rollback and application self-rollback remain fixture-qualified; this milestone has not performed those live actions.

New-app hosting supports stateless Node services, Python standard-library services, and static sites. Sealed npm dependency bundles can accompany deployments; Python virtual environments currently support development only. Private registries, Git-based dependency downloads, browser operation, and unrelated production administration are unsupported. Changes to authentication, protected control components, or privileged helpers use a separate owner maintenance path.

Endpoint: **https://mcp.jensenabler.com/praxis/mcp**

The public endpoint and OAuth issuer use the `/praxis` prefix. Connections created against the earlier `/praxis-probe` endpoint need to be replaced. Coding tools require an explicit `praxis:code` grant; diagnostic permissions remain `praxis:probe`. Jobs live on the VPS independently of ChatGPT scratch files and the MCP web process.

## Connect and test

**Praxis is connected in the owner's ChatGPT account at the canonical endpoint.** Its existing connection was refreshed to expose 50 tools, including the new project, dependency, production recovery, and release tools. The same OAuth connection and grant remain in use; see the [0.5 refresh evidence](docs/evidence/autonomy-v05-chatgpt-refresh.json). This verifies stored web metadata; native-phone 0.5 acceptance is still pending. Earlier iPhone coding and diagnostic runs recovered their existing work from fresh conversations. [The coding prompts and acceptance scope](docs/coding-phone-test.md) and [repeatable diagnostic prompts](docs/phone-test.md) remain available for client/version checks. [Probe evidence](docs/evidence/iphone-probe-report.md) covers the nine diagnostic tools. No model API key is needed.

ChatGPT account/workspace availability and mobile tool exposure must be verified in the actual account. Current setup guidance is [Connect and test a plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt). If the app does not expose connection creation, create it in the web account settings first, then check its availability in a new iPhone conversation. Schema changes require refreshing connection metadata and starting a new conversation. Claude can be tested separately through its remote MCP connection flow; compatibility is not claimed until observed.

## Local verification

Node 22.22 or newer is required. Run `npm ci --ignore-scripts` and `npm test`. Tests use disposable directories and test credentials. They cover OAuth and HTTP MCP calls, source/edit/diff behavior, stale revisions, concurrent duplicate submissions, cancellation, worker crashes, and recovery. Simulated runners exercise protocol and lifecycle behavior. The separate [Linux host fixture](docs/evidence/coding-host-bootstrap.json) records actual Podman execution, effective cgroups, network and mount policy, storage capacity, cancellation, independent timeout, and recovery; it does not claim deliberate resource-exhaustion stress or a phone coding run.

[Replay evaluations](docs/replay-evals.md) compare clean historical snapshots and private tasks against independent checks. The [completed first batch](docs/replay-batch-v1.md) covered three varied cases and six coding/recovery runs with a frozen tool release. Context-dependent historical requests are labeled as adapted. Private project source and original prompts stay outside this repository.

The deployed verification client reads credentials from private files. Set `PRAXIS_BASE_URL`, `PRAXIS_PASSWORD_FILE`, and `PRAXIS_CLIENT_STATE`, then run `node scripts/probe-client.js smoke`. The `start` and `recover` commands verify a 45-second job across an operator-triggered MCP app restart. Never put password/token values in shell arguments or Git.

See [operations](docs/operations.md), [acceptance evidence](docs/acceptance.md), and [constraint observations](docs/constraints.md).
