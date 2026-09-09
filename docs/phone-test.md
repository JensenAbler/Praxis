# Actual iPhone remote MCP test

Connect **Praxis Probe** first. Use the same account as the iPhone. Record the model/mode and app version if available from the interface; the model must not invent these. This fixture uses the VPS, not ChatGPT's temporary execution environment.

## Prompt 1 — tool behavior and disconnect

```text
We are testing the connected Praxis Probe tools from this actual iPhone ChatGPT session. Use those tools directly. Do not simulate them with Python, shell commands, browsing, or another agent. If the connection/tools are unavailable, stop and report exactly that.

1. Call probe_capabilities and report the release and limits.
2. Call probe_response with bytes=4096, marker="iphone-probe-v1-end", delayMs=0. Report whether you received the end marker and payloadBytes. Do not copy the payload into your answer or claim you independently verified its hash without doing so.
3. Call probe_failure once. Report the error code, then follow its recovery instruction by calling probe_capabilities.
4. Generate a unique idempotencyKey and call probe_job_start with label="iPhone recovery probe v1", durationSeconds=120, intervalSeconds=5. Save the returned job ID. Repeat the same call with the same key and identical inputs once to verify it returns the same job.
5. End your response promptly after reporting the job ID, status, request IDs, and any observed tool approval prompts/errors. Do not wait for completion or start another job.

I will leave this conversation and return in a NEW conversation after at least two minutes. Do not claim continued model reasoning or persistence beyond what the tools demonstrate.
```

## Prompt 2 — paste in a fresh conversation after two minutes

```text
Use the connected Praxis Probe tools to recover the existing job labeled "iPhone recovery probe v1". Call probe_jobs_list to discover it; do not start or recreate any job. If more than one matches, show their IDs and timestamps before choosing rather than guessing.

Read its status and all its logs, using pagination with limit=5 and each returned cursor. Report the job ID, terminal status, start/completion times, explicit COMPLETED record, heartbeat count, and any missing/duplicate record sequences. State which observations came from tools. If access or tools are missing, report that without simulating results.

Summarize any friction: connection availability, required authorization, ambiguous arguments, errors, lost/truncated results, or inability to finish. Do not infer a universal limit from this one run and do not claim continued reasoning while the phone was away.
```

The job and tool receipts allow the developer to verify the report independently on the VPS. Screenshots and copied terminal logs are unnecessary. Further size/concurrency probes should be automated after this first account-specific check.
