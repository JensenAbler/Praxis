# First native coding replay and fresh-conversation recovery

The first coding workflow passed for the owner's reported iPhone ChatGPT sessions on Praxis `coding-a41abbbbb51e`: discover source, create an isolated workspace, inspect/search, edit, validate, review the diff, and recover the same results in a fresh conversation. Success required editing-tool workarounds. It does not establish general Codex parity or a smooth workflow.

The implementation report came from the owner's pasted attachment; the recovery report and elapsed times came from the owner in this development conversation. Device state, model identity, app version, and subagent execution were not independently observed. The owner reported **9 minutes 36 seconds** for implementation and **3 minutes 12 seconds**, with two subagents, for recovery. These are client elapsed times, not measured server execution times.

## Corroborated results

[Read-only server evidence](iphone-coding-server.json) matches exactly one workspace labeled `iPhone coding replay v1`, ID `4851843f-e8af-43c3-a828-33dbd417bf0f`. Its immutable base is `06fb2784454e3641960a1e1782a0c92a68a341b7`; its final revision is `825ad886c35ea466e0a801d43c69972fe29f3559359129892e79ddc8f57deb1f`.

| Result | Persisted job | Outcome | Log records |
| --- | --- | --- | --- |
| Baseline validation | `aca0f11a-9936-47ae-9702-df1b016efa69` | 75 passed, 0 failed; completed, exit 0 | 577 |
| Hash-checked source edit command | `8309f589-0277-4215-bf3a-df06e0ae38d4` | Two files edited; completed, exit 0 | 7 |
| Final validation | `6359cc6a-4586-47b3-9539-0fc31e25e219` | 76 passed, 0 failed; completed, exit 0 | 582 |

Each log has contiguous sequences, no duplicates, no partial records or persisted truncation, and an explicit completion record. Both validations match the registered prepared-dependency command. The completed creation receipt is `e3890f5e-a07e-4b3f-b38c-a1ceb9977f97`. There is no apply receipt: the two apply attempts were rejected, and the eventual edits were a command job.

The persisted diff contains 11,715 bytes and changes only `podcast-generator.js` and `test.js`. Its hash is `d23b8cdc34270d5958af3781fe9d60f13edbc26b70955a348d4b5ee1f2ebc96d`. The recovery report describes three pages pinned to the final revision. All three artifact listings were empty, so this phone case verifies artifact discovery, not recovery of nonempty artifact contents. The recovery audit contains no mutation tool handlers, and no additional workspace job or mutation receipt appeared.

## Independent assessment

The pre-existing trusted checker passed **all five checks** against the completed candidate in a separate rootless container, with candidate and checker mounted read-only, no network or credentials, and bounded time/resources. [Checker receipt](iphone-coding-independent-check.json) records exact module hashes, schema order, prompt coherence, both reader orders and silence, mocked streaming liveness, and mocked JSON-object fallback. It did not use the candidate's edited test suite as its authority. The candidate module hashes and workspace revision stayed unchanged, and the original three jobs were not rerun.

A review of the two-file diff found no actionable issue. It changes schema order and prompt guidance, preserves existing parser logic, and adds regression coverage. The earlier [base/reference comparison](replay-checker-baseline.json) remains separate historical evidence. No live Anthropic emission order, TTS latency, Discord behavior, deployment, Claude compatibility, or host-loss recovery is established.

## Efficiency and friction

| Measurement | Implementation | Recovery |
| --- | --- | --- |
| Owner-reported elapsed time | 576 seconds | 192 seconds |
| Recorded tool handlers | 78 | 70 |
| Aggregate time inside tool handlers | 2.249 seconds | 0.397 seconds |
| Failed tool handlers | Two `workspace_apply` validation errors | Zero |
| First-to-last recorded tool span | 530.539 seconds | 181.508 seconds |

The three original jobs took 12.857 seconds in total from queueing to terminal updates. This and handler timing do not partition the client's elapsed time: network, authorization, client scheduling, model work, subagent coordination, and uninstrumented stages are not separately measured. The recovery prompt deliberately required complete logs and diff; its time is an audit baseline, not minimum ordinary resume latency. Of 70 recovery handlers, 31 were log reads and 11 read diagnostic observations. Schema rejections before handler dispatch are absent from these counts.

The implementation exposed two source-confirmed restrictions: one change per path in each batch, and a small patch to the 351 KB test file being rejected because the reconstructed file was checked against the 131,072-character write-content limit. A separate 2 MiB source-file ceiling already exists. The model compensated with an isolated, hash-checked command; success alone would have hidden the editing-tool problem.

The recovery report also records rejected pagination arguments, local response truncation/parsing friction, and transient `-32603` errors that succeeded on retry. Diff limits are bytes (minimum 256), while log limits are records (maximum 100). Bounds exist in schemas but are insufficiently explained in tool descriptions. The server audit recorded no failed recovery handlers and only HTTP 200 responses; neither observation rules out JSON-RPC, encoding, client, or transport failures. The cause of `-32603` remains unresolved. No approval prompts were reported.

## Recommended next increment

Fix small patches to large files and support multiple patches to one file under a clear hash precondition. Then make page units/ranges explicit, keep routine job status compact, offer bounded response sizes and an efficient recovery overview, and add sanitized error-stage correlation. Preserve complete inspectable logs, diffs, commands, and receipts behind bounded reads.

Evaluate these improvements against the same evidence: fewer failed calls and less custom workaround code, successful direct edits, complete recovery, preserved hashes/IDs, and independent behavioral correctness. Broader historical tasks and matched client/model comparisons are still needed before drawing a Codex-replacement efficiency conclusion. These improvements are proposed, not implemented by this evidence update.
