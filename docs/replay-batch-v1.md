# Replay batch v1

This batch is complete. The owner supplied six implementation/recovery pairs covering three coding problems, two independent repeats, and recovery of a nonempty artifact. All six saved candidates subsequently passed the calibrated independent behavioral checks. [Results and recurring friction](evidence/replay-batch-v1-results.md) distinguish owner-reported phone behavior, preserved server state, and operator grading. The four buffer/provider full suites retained the documented baseline recording failure.

The batch used `coding-a41abbbbb51e` and its pinned container image throughout. Its manifest remains the historical baseline for the subsequent [0.3 tool improvements](tool-quality-v03.md); do not reuse its completed run IDs for new attempts. The [batch manifest](../eval/batch-v1.json) records stable run identities and actual workspace revisions; the [case catalog](../eval/catalog.json) pins starting commits and prompt hashes. The remaining sections preserve the original batch procedure and preparation evidence.

## Readiness evidence

[Historical calibration](evidence/replay-batch-v1-calibration.json) rejects all three old implementations and accepts their references (9 buffer, 6 provider, 6 audio checks). An initial provider grader run was incomplete because of a CLI import cycle in the evaluator. The cycle was fixed and a CLI regression test added before the recorded successful calibration; this was an evaluator defect, not a Praxis agent failure.

[Clean baseline runs](evidence/replay-batch-v1-baselines.json) used the unchanged container image and source snapshots:

| Case | Existing tests | Exit | Baseline qualification |
| --- | --- | --- | --- |
| Buffer | 93 passed, 1 failed | 1 | Known native recording failure below. |
| Provider | 86 passed, 1 failed | 1 | Same known native recording failure. |
| Audio | 22 passed, 0 failed | 0 | Suite completed successfully with the explicit dependency adaptation. |

The two nonzero baselines fail **Recording metadata stores selected episode plan pointer** after FFmpeg exits with a null code and the metadata file is absent. The recorded signal/cause is unavailable. This exact pre-existing failure is disclosed in project instructions. Preserve and report it; the full suite is not green. Excluding it from regression attribution requires the same test and signature, not merely an unchanged failure count.

The prepared command sets the application's supported `CLAWCAST_CONTENT_ROOT` to writable `/tmp/praxis-content`. This removes a separate default-path failure without editing source or changing the image. Buffer/provider lockfiles match existing dependency bundles; their package scripts differ. Audio uses a different historical lock with the frozen speech-first dependency bundle, so its passing suite qualifies an adapted environment, not exact historical dependencies.

[Authenticated MCP fixture evidence](evidence/replay-batch-v1-mcp.json) verifies all three project revisions, complete instructions and prepared commands, plus the existing container/recovery checks using a temporary authority. [Registration evidence](evidence/replay-batch-v1-registration.json) records the subsequent configuration-only update: runtime and image unchanged, with stored workspace/job/operation/log/artifact rows unchanged across the idle restart. No owner sign-in or native phone run is represented by these fixture checks.

## What the cases exercise

| Case | Coding challenge | Historical request | Independent assessment |
| --- | --- | --- | --- |
| `buffer-settling` | Remove duration-dependent waiting while preserving overlapping speakers, ASR, holds, cooldown, and requeue behavior. | Exact first implementation prompt from **Remove adaptive buffer grace**; later deployment request excluded. | Controlled time and event sequences; review preservation of receiver policy and documentation. |
| `provider-stream-errors` | Distinguish an HTTP 200 stream containing a provider error from a successful silent response; preserve normal streamed output. | Adapted from **Reorder response schema**: a context-dependent production investigation becomes a self-contained synthetic failure report. | Errors before/after partial speech, fragmented input, EOF, text/JSON deltas, and intentional silence. |
| `vad-flap` | Prevent non-speech audio from contaminating a later utterance while preserving real speech and receiver cleanup. | Adapted historical task with offline evidence and explicit scope. | Deterministic mocked receiver/audio events and lifecycle regression checks. |
| `speech-first` | Stream speech before a later decision field while preserving silence. | Existing seed replay. | Previously accepted coding and fresh-conversation recovery; retained as historical control. |

The first three begin from their own clean Git parents. Historical uncommitted files, production state, and the original machines are not reconstructed. Adapted requests are labeled because they supply context the old conversation took for granted. Original and adapted prompt hashes remain separately recorded where applicable.

The accepted `speech-first` workspace is `4851843f-e8af-43c3-a828-33dbd417bf0f`. Its [native report](evidence/iphone-coding-report.md), server observations, and independent checker evidence stay intact. It is not a seventh new run and must not be restarted to manufacture a repeat.

The [isolated historical calibration](evidence/replay-batch-v1-calibration.json) distinguished all three changes: each clean base failed its case, and each reference passed, covering 21 behavioral checks across the three reference revisions. These are fixture results, not new agent attempts.

## Six bounded runs

| Run | Case and variant | Specific question |
| --- | --- | --- |
| 01 | Buffer, standard | Can the agent make a constrained state/timing change without breaking synchronization? |
| 02 | Provider, standard | Can it diagnose a false-success failure and test asynchronous error propagation? |
| 03 | VAD, standard | Can it work across audio/lifecycle boundaries with mocks and prepared dependencies? |
| 04 | Provider, independent repeat | Does a fresh attempt encounter the same friction with matched client/model settings? |
| 05 | Buffer, independent repeat | Does a fresh attempt reproduce the same state/timing successes and friction? |
| 06 | VAD, nonempty artifact recovery | Can a new conversation retrieve complete artifact bytes as well as jobs, logs, and diff? |

Each run has its own label and workspace-creation idempotency key in the manifest. These identify the intended run; real workspace IDs are recorded after creation. Find and inspect an existing match before creating anything. Ambiguous responses require recovery of the original operation, with identical inputs and key for any submission retry. Multiple matches require resolving the ambiguity, not choosing one silently.

Run sequentially because the frozen service allows one active coding job. Keep the prompt, base, prepared dependencies, client, model, and settings matched for runs 02/04 and 01/05 where the client exposes them. Give repeat runs no earlier solution or critique. Mark unavailable settings as unknown.

Deliver exactly one iPhone prompt per assistant response, with no preamble or extra commentary. Advance when the owner says **next**. Deliver task prompts 01–06 first, then read-only recovery prompts 01–06, using the explicit order in the manifest. Each goes into a fresh phone conversation. Recovery inspects the original results; it must not restart a completed or uncertain job.

For run 06, request a bounded nonempty text artifact from a validation command using `artifactPaths`. Retain its job ID, byte count, and hash. The recovery conversation lists the stored artifact, reads all pages, and independently checks the reconstructed bytes/hash when capable. Otherwise record that hash verification was not independently performed. Do not recreate the artifact to make recovery pass. Keep evaluation-only output distinguishable in the diff review.

## Preparing and running a packet

Use the private packet generator described below once the registered fixtures and their prepared validation commands have been checked. It combines a generic workflow wrapper with the canonical private task text; it must not include reference code, historical diffs, or grader internals. Keep generated packets outside the public repository.

For example, from the Praxis checkout:

```powershell
python scripts/prepare-replay-packet.py --case buffer-settling --run-id batch-v1-01-buffer --scenario standard --private-root C:\Users\Jensen\.codex\praxis-evals-private --output C:\Users\Jensen\.codex\praxis-evals-private\packets\batch-v1-01-buffer
```

Use each manifest run's `id`, `caseId`, and `packetScenario`. The output directory contains `worker-prompt.txt`, `recovery-prompt.txt`, and a hash receipt. Paste the appropriate private file into the actual client; generating it does not run the task. Repeating identical generation inputs reuses the same complete packet, while conflicting or partial output is preserved and rejected. The generator's optional handoff scenario remains available for later experiments and is outside this six-run batch; any earlier unused handoff packet stays unused.

The [first phone workflow](coding-phone-test.md) documents the existing implementation/recovery shape. [Replay evaluator instructions](replay-evals.md) describe the trusted read-only checker mount and required OS isolation. The batch adds case diversity, repeats, and artifact recovery; it does not authorize production deployment, live providers, or independent Praxis self-update.

An automated client can exercise the same registered tools, but record it as an automated-client run. Only a run actually performed through the native phone app supports a native-phone claim. A desktop simulation of phone constraints remains a simulation.

## What counts as a result

For every run retain the starting commit, private prompt hash, release/image, observed client/model/settings, final revision, complete diff, workspace/job/receipt IDs, and the actual test summary plus exit code. Run the trusted independent checker against the final revision in its separate OS sandbox, and review the diff for semantic correctness, scope, and useful tests.

A valid solution can use different code and tests from the historical commit. Behavioral requirements and review determine correctness; matching a commit diff does not. Passing a fixture checker alone does not establish full task correctness or real Discord/provider behavior. A base/reference calibration only demonstrates what the checker distinguishes on those two known revisions.

Prepared baseline suite results must be recorded before attributing suite failures to a candidate. The offline command uses the supported `CLAWCAST_CONTENT_ROOT=/tmp/praxis-content` setting. A known native FFmpeg/recording-metadata baseline failure is a limitation: exclude it from candidate regressions only when its exact recorded signature is unchanged. Any new or changed failure requires investigation; a broadly similar error is insufficient.

| Measure | Record |
| --- | --- |
| Correctness | Independent checks, candidate test summary, diff review, and unresolved requirements. |
| Recovery | Same IDs/revisions, terminal results, contiguous log pages, complete diff, artifact bytes/hash where requested. |
| Tool friction | Calls by operation, argument failures, transient failures, repeated reads, and custom workarounds. |
| Lost output | Separate local display truncation from persisted truncation or missing server records. |
| Human help | Every rescue, what was needed, and whether the agent could continue afterward. |
| Time | Client elapsed time, server handler time, and job queue/execution time as separate observations. |

Record ordinary expected calls separately from calls made to recover from friction; do not invent an ideal call count. Client reports and server audit may see different error stages. Preserve both and mark unexplained discrepancies. Unmeasured elapsed time cannot all be assigned to model reasoning, network, or backend execution.

## When to change the tools

Keep recoverable argument mistakes, pagination surprises, editing workarounds, and transient failures in a friction log while finishing the batch. Successful compensation is itself evidence of a tool cost.

Stop early to preserve evidence and fix the immediate problem if there is data loss/corruption, an unexpected duplicate mutation, a security-boundary violation, or evidence too inconsistent to trust. Record the reason and any version change. Subsequent runs belong to a new runtime cohort; they cannot silently be compared as if the tool surface were unchanged.

After the six runs, group friction by repeated cause and impact, choose the highest-value fixes, and repeat affected cases with matched conditions. This small batch maps failure modes; it does not provide a reliable pass-rate estimate or establish Codex parity.

Possible later cases include disconnecting before recording finalization and free/paid provider-key routing under rate limits. These are selected historical directions, not implemented or validated members of this batch.
