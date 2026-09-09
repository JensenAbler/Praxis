# Seed replay evaluation

`eval/catalog.json` identifies the first case, its clean starting commit, reference outcome, and private prompt hash. It includes no copied private source or original prompt. Authorized operators supply the prompt separately; preserve UTF-8 text with LF endings and a final newline before checking its hash. Keep reference source outside the candidate workspace.

The seed is a clean parent-commit replay, not an exact reconstruction of historical dirty files or the original machine. Its reference commit is an outcome example. The grader checks behavior, not the reference diff or exact prompt wording.

## Run the trusted checker

Mount a trusted Praxis release read-only at `/checker` and the candidate source read-only at `/candidate` in an unprivileged evaluation container. Give it no credentials, network, production mounts, host socket, or administrator rights. Set memory, process, CPU, and time limits. The trusted launcher selects these fixed mounts; candidate code must not choose them.

Run inside that sandbox:

```sh
node /checker/scripts/eval-check.js --workspace /candidate --case speech-first
```

The checker and catalog must be outside the editable candidate workspace. The candidate's own `test.js` is never the authority for this result. The command starts a bounded child process with a minimal environment and requires a complete JSON receipt. Exit codes are 0 for passing mechanical checks, 1 for a failed check, and 2 for an incomplete execution or setup failure.

The module VM has an empty environment, mocked HTTP responses, limited dependency loading, and bounded evaluation. **Node's VM is not a security sandbox.** These controls make tests repeatable; OS isolation must protect the host when evaluating candidate code. Do not invoke this checker on untrusted source from a privileged web/backend process.

## What it measures

- Speech-first property and required-field order.
- Obvious contradictions in generated system, decision, and user prompt output-order instructions.
- Both reader field orders, true and false decisions, long speech, and empty speech preceding a false decision.
- Mocked streaming: speech and the true decision must become usable while the later decision field is withheld. Empty speech must leave the decision pending until false arrives.
- The JSON-object request path and complete silence normalization using mocked responses.

Prompt coherence is a conservative text heuristic, not proof that every prompt preserves its meaning. Unrecognized wording is recorded without rejecting a potentially valid alternative. Review the diff for semantic changes, unnecessary edits, and test quality. The JSON-object check does not simulate every provider's automatic format-rejection fallback.

Every receipt includes hashes of loaded candidate modules, the private prompt hash, check outcomes, and the explicit offline/mocked evidence type. Keep it with the workspace base and resulting diff. Passing does not prove real provider emission order, TTS latency, Discord behavior, deployment health, or full task correctness.

The historical session exposed a testing pitfall: the speech sanitizer retains a short lookbehind, so a tiny mock fragment may not yield immediately. The grader uses a longer fragment and bounded waits. Never count process exit 0 alone as a completed test run.
