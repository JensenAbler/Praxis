# Constraint observations

| Observation | Evidence and interpretation |
| --- | --- |
| Native browser and command tools available in one iPhone session | User-pasted capability report. This is a session observation, not a general account/platform guarantee. |
| Native 120-second process and original handle recoverable | User reported run e03bf7e8-a624-44e8-aca6-20fd3daa676b, 24 heartbeats, 26 readable records, exit code 0 through handle 25107. The worker completed; continued model reasoning and fresh-chat recovery were not demonstrated. |
| ChatGPT scratch can disappear | User has experienced deletion. Treat scratch as disposable; persist operational facts and artifacts in Praxis. No fixed lifetime has been inferred. |
| Remote Praxis job recovery | Separate VPS worker plus durable SQLite state. Hosted verification evidence is recorded in acceptance.md. |
| Actual ChatGPT remote connection | Native owner OAuth and all nine tools discovered in web settings. The iPhone report confirms capabilities, a 4,096-byte payload/end marker, controlled-error recovery, and an idempotent job start. VPS receipts corroborate those requests. Initial empty actions required Refresh. One run does not define universal limits or approval behavior; Claude is not yet exercised. |
| Recovery from a fresh iPhone conversation | Owner report plus server corroboration: discovery by label, same completed job, 24 heartbeats and 26 sequential records. No recreation. Server receipts show list/status and seven log calls after the original run; conversation identity itself comes from the owner's report. |
| Friction despite successful core work | First agent reported result-handling serialization failure and extra INVALID_ARGUMENT metadata alongside intentional FIXTURE_ERROR. Raw errors are unavailable; cause unresolved. Last-seen log cursors intentionally persist on empty pages, requiring an empty-page stop check. See evidence/iphone-probe-report.md. |
| Native OAuth form behavior differs from scripted HTTP clients | Actual ChatGPT connection reached the owner form, then native POST failed the origin check. The page used no-referrer, which makes browser form submissions send Origin:null. The scripted test supplied Origin explicitly and missed this. Use strict-origin for the form, retain exact-origin/CSRF checks, and verify the real browser flow. |

## Coding bootstrap observations

These are measured implementation and test observations, not a comparison of model intelligence or hidden reasoning traces.

| Observed friction | Consequence for agent tooling |
| --- | --- |
| Rootless Podman did not use the intended storage locations from configuration alone. | Pass and verify explicit runtime storage paths so commands cannot silently consume an uncapped home-directory image store. |
| The existing Docker runtime was unsuitable for the selected rootless cgroup setup. | Pin the independently installed `crun` runtime; preserve unrelated Docker configuration. Test the actual host policy rather than accepting a constructed command line as isolation evidence. |
| Cold user-mapping preparation took tens of seconds. | Return durable queued/starting state promptly, separate preparation time from command runtime, and allow observation without encouraging duplicate submissions. |
| The runtime's independent timeout produced a negative monitor exit sentinel. | Preserve unknown process exit as unknown and label timeout inference explicitly. Do not manufacture an ordinary exit code or success. |
| A job's public start timestamp changed after the first running response. | Keep published identity/timestamps stable while using observed runtime time for deadline enforcement. Exercise concurrent observation and later recovery. |
| A library-based MCP fixture passed while permanent service startup skipped its entry point through a release symlink. | Verify the real executable launch path and service lifecycle as well as imported application factories. Activation health checks and rollback caught the missing listener. |
| The historical lockfile could not be installed with default peer resolution. | Prepare and hash dependencies independently; document the narrow compatibility flag without modifying the replay's source or implying an exact historical environment. |
| Source inspection can race a running command. | Provide recoverable workspace/job metadata during execution, clearly defer source scans/diffs, and preserve an inspectable last revision if a command creates invalid source paths. |
| The unchanged historical snapshot completed 75 tests in the actual sandbox. | This establishes a usable starting environment for the phone replay. Current Discord's separate baseline failures remain recorded; passing preparation is not passing the coding task. |
| A workstation power outage left the VPS and its stored test results intact. | Recover by durable workspace/job/operation identity before deciding to submit more work. This is not evidence of VPS reboot or host-loss recovery. |

See [host evidence](evidence/coding-host-bootstrap.json), [authenticated MCP evidence](evidence/coding-mcp-host.json), [project baselines](evidence/project-validation.json), and [deployment observations](evidence/coding-deployment.json).

The replay evaluation uses historical prompts and starting revisions, keeps the expected final implementation hidden from the worker, and compares behavior and tests rather than exact diffs. Record tool calls/results/timings/errors alongside code outcomes and simulate observed restrictions and failures. A seed catalog, independent checker, prepared source/dependencies, and phone acceptance prompts exist; a broader automated model comparison harness remains future work.

## First native coding replay

The [phone coding report](evidence/iphone-coding-report.md), [server audit](evidence/iphone-coding-server.json), and [independent container checker](evidence/iphone-coding-independent-check.json) establish a completed implementation and fresh-conversation recovery for one case. They also show why a successful code outcome is insufficient as a tooling-quality measure.

| Observed friction | Next implementation target, not yet deployed |
| --- | --- |
| Repeated patches to one file in a batch were rejected; the description omitted this restriction. | Support ordered hunks under one original file hash, and describe the exact precondition semantics. |
| A small patch to a 351 KB file hit the 131,072-character full-write limit on the reconstructed result. | Bound patch input separately and allow the result up to the existing 2 MiB source-file ceiling, preserving journal and aggregate quotas. |
| Diff limits 100/5 and log limit 200 were rejected. | Describe units, ranges, defaults, cursors, and stopping rules in each schema field and in capabilities. |
| Full commands, logs, and duplicated MCP result representations produced bulky responses and reported client truncation. | Compact routine status; expose complete commands and logs through explicit bounded reads and caller-selected response byte budgets. |
| Recovery required 70 audited handlers, including 31 log reads and 11 diagnostic-observation reads. | Provide a compact recovery overview with durable IDs, statuses, revisions, and links to complete evidence; distinguish ordinary resume from a deliberately exhaustive audit. |
| Transient recovery `-32603` errors succeeded on retry, while handler audit showed no failures. | Add sanitized protocol/encoding/handler-stage correlation. Do not infer a backend or client cause from HTTP 200 or successful handler receipts alone. |

Owner-reported implementation/recovery times were 576/192 seconds. Measured handler totals were 2.249/0.397 seconds, and the three original jobs totaled 12.857 seconds from queueing to terminal updates. These measurements do not separate model, network, client, authorization, or subagent overhead. They are a baseline for subsequent matched evaluations, not a speed comparison with Codex.
