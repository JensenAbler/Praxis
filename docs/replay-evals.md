# Historical replay evaluations

`eval/catalog.json` identifies four cases, their clean starting commits, reference outcomes, and private worker-prompt hashes. It includes no copied private source or original prompts. The [six-run batch](replay-batch-v1.md) adds buffer synchronization, provider stream errors, and audio contamination to the accepted speech-first control. Original requests that depend on missing incident context are explicitly adapted, with separate original and worker-prompt hashes. Keep reference source outside the candidate workspace.

The private packet generator verifies canonical UTF-8 text with LF endings and a final newline, then creates worker and recovery prompts outside this public repository. Packet generation, historical checker calibration, clean baseline validation, automated client runs, and native phone runs are distinct steps; none substitutes for another.

Each case is a clean parent-commit replay, not an exact reconstruction of historical dirty files or the original machine. Its reference commit is an outcome example. The grader checks behavior, not the reference diff or exact prompt wording.

The historical package lock omits peers in an optional WASM dependency branch. Default `npm ci` rejects it under both the initial Linux image's npm and a Windows npm 11.6.2 dry run. The Windows dry run succeeds with `--legacy-peer-deps`, preserving the original lock hash. Dependency-image preparation uses that explicit compatibility flag for this replay project only; it does not repair or edit the candidate's lockfile. Linux installation subsequently succeeded, and the unchanged historical snapshot completed 75 tests with a final summary and exit 0 in the actual offline sandbox; [project validation evidence](evidence/project-validation.json) records the exact image, manifests, source, and runtime versions. This preparation reproduces a usable offline dependency bundle, not the exact historical machine or its unrecorded local lock changes.

## Run the trusted checker

Mount a trusted Praxis release read-only at `/checker` and the candidate source read-only at `/candidate` in an unprivileged evaluation container. Give it no credentials, network, production mounts, host socket, or administrator rights. Set memory, process, CPU, and time limits. The trusted launcher selects these fixed mounts; candidate code must not choose them.

Run inside that sandbox:

```sh
node /checker/scripts/eval-check.js --workspace /candidate --case speech-first
```

The checker and catalog must be outside the editable candidate workspace. The candidate's own `test.js` is never the authority for this result. The command starts a bounded child process with a minimal environment and requires a complete JSON receipt. Exit codes are 0 for passing mechanical checks, 1 for a failed check, and 2 for an incomplete execution or setup failure.

The module VM has an empty environment, mocked HTTP responses, limited dependency loading, and bounded evaluation. **Node's VM is not a security sandbox.** These controls make tests repeatable; OS isolation must protect the host when evaluating candidate code. Do not invoke this checker on untrusted source from a privileged web/backend process.

## What it measures

The checks below describe `speech-first`. The batch guide describes the three additional graders. Select their catalog IDs with the same `--case` argument. [Calibration evidence](evidence/replay-batch-v1-calibration.json) records the exact grader/module hashes, complete receipts, and exit codes for all three historical base/reference pairs in the frozen rootless container. Each old implementation fails and each reference passes. This qualifies the graders on those examples; it is not an agent result.

- Speech-first property and required-field order.
- Obvious contradictions in generated system, decision, and user prompt output-order instructions.
- Both reader field orders, true and false decisions, long speech, and empty speech preceding a false decision.
- Mocked streaming: speech and the true decision must become usable while the later decision field is withheld. Empty speech must leave the decision pending until false arrives.
- The JSON-object request path and complete silence normalization using mocked responses.

Prompt coherence is a conservative text heuristic, not proof that every prompt preserves its meaning. Unrecognized wording is recorded without rejecting a potentially valid alternative. Review the diff for semantic changes, unnecessary edits, and test quality. The JSON-object check does not simulate every provider's automatic format-rejection fallback.

Every receipt includes hashes of loaded candidate modules, the private prompt hash, check outcomes, and the explicit offline/mocked evidence type. Keep it with the workspace base and resulting diff. Passing does not prove real provider emission order, TTS latency, Discord behavior, deployment health, or full task correctness.

The historical session exposed a testing pitfall: the speech sanitizer retains a short lookbehind, so a tiny mock fragment may not yield immediately. The grader uses a longer fragment and bounded waits. Never count process exit 0 alone as a completed test run.
