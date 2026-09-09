# Actual iPhone remote MCP test

Connect **Praxis** first. Use the same account as the iPhone. Record the model/mode and app version if available from the interface; the model must not invent these. This fixture uses the VPS, not ChatGPT's temporary execution environment.

## Complete the connection

Use the app name **Praxis**, server URL `https://mcp.jensenabler.com/praxis/mcp`, and **OAuth**. The canonical issuer is `https://mcp.jensenabler.com/praxis/oauth`; discovery advertises `praxis:probe`, `praxis:code`, and `offline_access`. Keep `offline_access` as the base scope and optional OIDC/email lookup disabled. Complete the native owner sign-in and consent flow, then refresh the available actions if needed. The nine `probe_*` tools remain diagnostic fixtures alongside the coding tools.

An existing connection to `/praxis-probe/mcp` uses the old OAuth issuer and resource. Renaming its display label alone does not migrate it to `/praxis/mcp`. Native connection to the canonical endpoint has not yet been recorded here. If owner sign-in is required, use the existing private Praxis password; the bootstrap password file remains `C:\Users\Jensen\.codex\praxis-probe-private\login.txt`. Do not paste it into a conversation.

## Historical first setup — legacy endpoint

The first iPhone run and reported fresh-conversation recovery passed using **Praxis Probe** at the old endpoint; [recorded evidence](evidence/iphone-probe-report.md) includes server corroboration and remaining friction. The setup below records what happened then. The prompts that follow use the current **Praxis** connection for future reruns.

The observed legacy web setup was:

1. Enable **Settings → Security and login → Developer mode**, then open [ChatGPT Plugins](https://chatgpt.com/plugins) and select **Create app**. During this setup, the owner toggled an already-enabled switch off/on and the Codex in-app page was reloaded before Create app appeared; the cause of the earlier stale state is unknown.
2. Enter **Praxis Probe**, server URL `https://mcp.jensenabler.com/praxis-probe/mcp`, and **OAuth**.
3. Advanced settings discovered dynamic client registration and the expected endpoints/resource. Discovered scopes were `praxis:probe offline_access`; set the base scope to `offline_access`. Disable optional OIDC/email lookup because the fixture does not provide email or userinfo. Keep OAuth enabled.
4. Accept the unreviewed-server notice and select **Create**, then complete the owner sign-in described above.
5. In Praxis Probe's settings, select **Refresh** after connection if Actions is initially empty. This loaded all nine actions during the actual setup.

## Prompt 1 — tool behavior and disconnect

```text
We are testing the connected Praxis diagnostic tools from this actual iPhone ChatGPT session. Use those tools directly. Do not simulate them with Python, shell commands, browsing, or another agent. If the connection/tools are unavailable, stop and report exactly that.

1. Call probe_capabilities and report the release and limits.
2. Call probe_response with bytes=4096, marker="iphone-probe-v1-end", delayMs=0. Report whether you received the end marker and payloadBytes. Do not copy the payload into your answer or claim you independently verified its hash without doing so.
3. Call probe_failure once. Report the error code, then follow its recovery instruction by calling probe_capabilities.
4. Generate a unique idempotencyKey and call probe_job_start with label="iPhone recovery probe v1", durationSeconds=120, intervalSeconds=5. Save the returned job ID. Repeat the same call with the same key and identical inputs once to verify it returns the same job.
5. End your response promptly after reporting the job ID, status, request IDs, and any observed tool approval prompts/errors. Do not wait for completion or start another job.

I will leave this conversation and return in a NEW conversation after at least two minutes. Do not claim continued model reasoning or persistence beyond what the tools demonstrate.
```

## Prompt 2 — paste in a fresh conversation after two minutes

```text
Use the connected Praxis diagnostic tools to recover the existing job labeled "iPhone recovery probe v1". Call probe_jobs_list to discover it; do not start or recreate any job. If more than one matches, show their IDs and timestamps before choosing rather than guessing.

Read its status and all its logs, using pagination with limit=5 and each returned cursor. Report the job ID, terminal status, start/completion times, explicit COMPLETED record, heartbeat count, and any missing/duplicate record sequences. State which observations came from tools. If access or tools are missing, report that without simulating results.

Summarize any friction: connection availability, required authorization, ambiguous arguments, errors, lost/truncated results, or inability to finish. Do not infer a universal limit from this one run and do not claim continued reasoning while the phone was away.
```

The job and tool receipts allow the developer to verify the report independently on the VPS. Screenshots and copied terminal logs are unnecessary. Further size/concurrency probes should be automated after this first account-specific check.
