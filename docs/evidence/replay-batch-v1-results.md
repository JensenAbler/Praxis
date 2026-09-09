# Replay batch v1 results

The owner supplied implementation and recovery reports for six unique workspaces: two buffer-settling tasks, two provider-stream-error tasks, and two receiver-boundary tasks. Extra reports for the artifact variant describe the same workspace and are not additional trials. All used the frozen `coding-a41abbbbb51e` runtime.

An operator subsequently captured immutable copies of the checker-required modules at each reported final revision and ran the previously calibrated independent checkers in the offline, unprivileged container. All six candidates passed: 9/9 checks for each buffer candidate, 6/6 for each provider candidate, and 6/6 for each receiver candidate. The [grading receipt](replay-batch-v1-independent.json) records module hashes, revisions, original job outcomes, checker hashes, image, and individual results. Original jobs were not rerun and original workspace source was not edited.

The independent result corroborates the intended behavior within the mocked test scope. It is separate from the owner-reported native phone sessions. It does not make the four buffer/provider full suites green: each retained the documented recording-metadata failure. It does not establish live provider or Discord behavior, exact historical dependency reproduction, or general parity with another coding environment.

## Observed friction

- Four implementations could not patch the large existing `test.js` through the edit API and used guarded source-edit commands. One receiver implementation also encountered the prohibition on multiple patches to one file in a batch.
- Reports repeatedly describe rejected pagination arguments: diff limits counted bytes, log limits counted records, and source reads counted lines. The workspace cursor `3` after five rows is a valid opaque continuation token, not evidence of a skipped row; following it recovered seven distinct workspaces.
- Most truncation was client display truncation, recovered from retained structured responses. One noisy receiver regression exhausted persisted output retention and lost its final test counts. Its terminal failure record remained. The recovery read 94 log pages across five jobs; consecutive saved sequences did not establish complete original output.
- Two task reports encountered the shared active-job limit. Reported retries recovered or reused the existing request rather than rerunning an ambiguous job.
- Read-only retries recovered several generic internal errors. The reports alone do not identify whether the fault was in the client, transport, gateway, or backend. No approval prompts were reported.
- All six final recoveries reported existing terminal jobs and readable revisions, diffs, and receipts. The artifact variant also recovered and independently hashed its preserved 7,416-byte report. Empty artifact lists in the other runs are expected because they did not request artifacts.

## Implication for the next tool version

Keep these results as the unchanged baseline. Prioritize direct small patches to large files, sequential same-file patches, compact status with recent output, durable bounded tail capture, and clearer argument/error contracts. Validate those behaviors using repeatable authenticated container fixtures before another native comparison. Future evaluation should measure retries, workaround jobs, tool calls, response volume, and task outcomes; this batch does not establish a controlled time or cost improvement.
