# First coding acceptance from an iPhone

This client acceptance test passed for one actual iPhone task and fresh-conversation recovery on `coding-a41abbbbb51e`. [The report](evidence/iphone-coding-report.md) separates owner-supplied native results, [server corroboration](evidence/iphone-coding-server.json), and the [independent checker](evidence/iphone-coding-independent-check.json). Implementation took a reported 9 minutes 36 seconds; recovery took 3 minutes 12 seconds with two subagents. Validation improved from 75 passed/0 failed to 76/0, all 577/7/582 job log records survived, and the independent checker passed five checks.

The workflow succeeded despite two rejected `workspace_apply` attempts; a hash-checked command performed the edits, with no apply receipt. Empty artifact lists establish listing only, not native artifact-content retrieval. Pagination, transient errors, and local result handling remain friction. The prompts below preserve the original test; the existing workspace and jobs must not be recreated to repeat an ambiguously completed operation. The historical task and private source remain registered on the server and outside this public document.

## Before starting

The connection is named **Praxis** and uses `https://mcp.jensenabler.com/praxis/mcp`. Use the connection at this URL; the earlier `/praxis-probe` connection has been superseded. Coding requires an explicit `praxis:code` OAuth grant. An old probe grant is insufficient. If the client offers only `probe_*` actions, stop and refresh the connection rather than attempting the coding task with diagnostic tools.

Start a new iPhone ChatGPT conversation with Praxis available. Paste this first prompt:

```text
Use the connected Praxis tools to perform our first real coding replay.

Read capabilities, then discover and inspect the registered project
discord-replay-speech-first. Its project instructions contain the original
coding request and the prepared validation commands. Follow that request.

First look for an existing workspace labeled "iPhone coding replay v1",
following workspaces_list pagination if necessary.
If exactly one exists, inspect its state, jobs, and mutation receipts and
continue the existing work. If more than one matches, report the ambiguity
before making changes. If none exists, create one at the exact registered
base revision, using that label and idempotency key iphone-coding-replay-v1.

I authorize source edits and sandboxed validation commands in this isolated
workspace. Read the relevant source, implement the registered task, run the
relevant checks, and review the complete paginated diff. Use the prepared
dependencies and registered validation commands; commands have no network.
Check the final test-suite summary as well as the command exit code. Clearly
report incomplete or failing checks and any live-provider checks that are
unavailable. Do not read a reference solution, publish, deploy, or remove
the workspace.

Keep durable job and operation IDs. If a response is uncertain, inspect
existing receipts and jobs; any retry of a submission must use identical
inputs and the same idempotency key. Do not recreate an ambiguous job.

When finished, report the workspace ID and base revision, what changed,
validation job IDs and actual outcomes, remaining limitations, and concrete
tooling friction observed in this session. Include brief operational
observations; do not provide private reasoning traces. Leave the workspace
and results available for recovery from a fresh conversation.
```

After that conversation finishes, open a separate fresh conversation with Praxis available and paste:

```text
Use the connected Praxis tools to recover our existing coding replay.
Do not create a workspace, start a command, apply edits, or remove anything.

Read capabilities and use workspaces_list to find the workspace labeled
"iPhone coding replay v1", following pagination if necessary. If exactly
one exists, inspect it and recover its jobs and mutation receipts. If zero
or multiple matches exist, report that clearly without guessing.

Read the existing validation jobs and their persisted logs, following all
pages needed to verify the reported outcomes. List and inspect any stored
artifacts. Review the workspace diff against its immutable base, using a
consistent revision across pages. If a job is active, recover metadata and
logs and defer source/diff inspection until it is terminal. A running job
must not be restarted; report an interrupted or ambiguous result as it stands.

Report the recovered workspace ID, base and current revision, changed files,
validation job IDs/statuses/exit codes and final test summaries, and whether
the persisted receipts and diff were readable. Describe any concrete tool
errors, approval friction, missing results, or pagination surprises. Do not
claim continued model reasoning while the original conversation was away.
```

## Evidence to retain

Record each conversation's observed result separately from server corroboration. Compare the recovered workspace/job/operation IDs, base and resulting revisions, terminal results, log sequence continuity, and artifact hashes when independently checked. A successful phone run demonstrates this workflow for this client, account, release, and task; it does not establish universal client limits, Claude compatibility, host-loss recovery, or the later deployment and self-update milestones.
