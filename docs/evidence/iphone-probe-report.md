# iPhone probe v1 — reported experience and independent verification

The owner supplied two agent reports from actual iPhone ChatGPT conversations. The second was reported as a new conversation with no copied job ID. Server records independently corroborate the job, timestamps, record contents, and request receipts; the server does not record conversation IDs, phone lock state, model identity, or client approval dialogs.

## First conversation

- Reported release `probe-d78e02c44615`, version `0.1.0`.
- Received a 4,096-byte synthetic payload and end marker `iphone-probe-v1-end`; hash not independently verified by the reporting agent.
- Intentional `FIXTURE_ERROR`, followed by successful `probe_capabilities` recovery. Extra `INVALID_ARGUMENT` metadata was reported; its origin is unresolved.
- Started job `7ec860cd-9558-44ed-b5a6-74421006bf96`, label `iPhone recovery probe v1`, duration 120 seconds, interval 5 seconds.
- Repeated the identical request with key `iphone-probe-v1-20260909T041122604Z-6c8e102b-59d4-4f02-a739-219e87b1a630`; same job returned, progressing from queued to running.
- Reporting agent saw no approval prompts. It reported a local result-handling serialization error after successful start, recovered the saved response, then made the requested repeat. No raw error or result-handling trace was supplied, so this issue is not yet diagnosed.

| Call | Reported request ID |
| --- | --- |
| Capabilities | 7fa84c7f-efa6-4146-b610-b97964e7d26d |
| Response | d1083a5e-bd00-47ef-8eee-ed4628191918 |
| Failure | 992d7fff-16b9-4ed9-abf6-97ae0173de18 |
| Recovery | b8bbe6d1-e494-4c13-bc3e-70e6a74d8b73 |
| Start | 0f85cd4a-712e-45cf-847d-a7c787a90d9f |
| Repeat | 9c47967b-fff9-4bf5-a97b-569dc78bfa27 |

## Fresh conversation

The reporting agent found exactly one matching job through `probe_jobs_list`, then read status and all logs without creating work. The job started at `2026-09-09T04:11:33.834Z` and completed at `2026-09-09T04:13:33.924Z`. The final record was sequence 26, event COMPLETED, with `elapsedSeconds: 120.086503`.

Seven log calls with limit 5 followed cursors `0 → 5 → 10 → 15 → 20 → 25 → 26`; six pages contained all 26 records and the seventh was empty with cursor still 26. Heartbeats numbered 1–24 and record sequences 1–26 had no gaps or duplicates. The agent reported no authorization prompts, ambiguous arguments, tool errors, or lost/truncated results during recovery.

## Server corroboration

[iphone-recovery-server.json](iphone-recovery-server.json) was extracted over owner SSH using read-only SQLite connections under the unprivileged `praxis-probe` account. No job was started/recreated, service restarted, or credential read during this check.

- Exactly one persisted job matched the reported key and exactly one matched the label.
- All six first-conversation request IDs were present; start and repeat were successful. The sole intentional failure receipt was FIXTURE_ERROR.
- All 26 records, 24 heartbeat numbers, run IDs, and exact final record matched.
- The subsequent receipts show capabilities, list, status, and seven log calls, all successful. No new start was recorded in that recovery sequence.
- The calls used the SDK's modern protocol path. Each recorded tool-handler duration was under four milliseconds; these timings exclude client/model/network time and do not diagnose the reported serialization error.

## Interpretation and follow-up

This run supports actual iPhone tool use, bounded remote work, retry recovery using a stable key, and discovery/retrieval in a reported fresh conversation. It does not establish universal output/time limits, continued model reasoning while away, different model/mode behavior, Claude compatibility, or arbitrary coding execution.

The empty-page cursor is the current log contract: a last-seen record sequence retained for later polling. It differs from the job-list end sentinel. A future explicit `hasMore`/`caughtUp` indication plus terminal job status could remove the extra empty-page call and make stopping clearer, while preserving resumable cursors.

Praxis source emits FIXTURE_ERROR and `isError:true`; the installed SDK source review did not locate an INVALID_ARGUMENT mapping. The extra label and result-handling serialization issue need exact client-visible errors before assigning cause or changing response format. Keep them as separate friction observations alongside the successful workflow.
