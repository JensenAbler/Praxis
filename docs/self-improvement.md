# Independent application updates

Praxis separates its editable coding application from the installed control components. A model can improve source inspection, editing, jobs, recovery, and coding tool descriptions through the ordinary workspace and Git workflow. Authentication, repository credentials, privileged deployment adapters, the updater, and host policy remain in the separately installed control release. A candidate that changes those protected files is rejected during preparation.

The control gateway reads a bounded JSON tool manifest from the application release. It does not import candidate JavaScript. If that manifest or the coding application fails, the gateway still offers the independently installed release status and rollback tools.

## Workflow

1. Synchronize project `praxis`, create a workspace, implement the change, run checks, and review the diff.
2. Commit and push to `main`, then synchronize `praxis` again. Save the completed sync operation.
3. Read `praxis_release_status` for the active release. Submit `praxis_release_plan` with the sync operation and expected release.
4. Recover that plan through `praxis_release_status` until it is ready or failed. Preparation builds dependencies, runs `npm test`, checks authenticated MCP behavior against a disposable database copy, and checks source and tool compatibility. Saved diagnostics explain preparation failures.
5. Submit `praxis_release_apply` with the ready plan ID, digest, expected release, and a durable idempotency key. Existing work defers activation. Read status after a disconnect; do not create a replacement operation.
6. To restore a successful activation's previous application, use `praxis_release_rollback` with that activation ID and current release. This leaves GitHub history and database contents intact.

Failed readiness triggers restoration of the previous application. A failed restoration keeps the admission fence closed. An explicit retry of the same apply/rollback inputs and key resumes restoration of that same operation; it does not reactivate the failed candidate.

## Boundaries and retention

The updater is a separate supervised worker, independent of the requesting conversation and application process. Builds run under a separate unprivileged identity, with live authority and state masked, no general network, and only the public registry proxy. Temporary storage, memory, CPU and process counts are bounded. The staging filesystem has an 8 GiB hard limit.

Candidate checks use a disposable database copy. Existing tables, columns and row values must remain readable and unchanged; additive schema changes are allowed. This initial compatibility policy deliberately excludes destructive migrations. Live database restoration is never used as rollback.

The updater retains up to four installed application releases and sixteen staging directories. Plans expire after 24 hours. Reaching retention limits requires explicit owner maintenance; an unresolved operation or known working release is never silently deleted. Changing protected components or expanding privileges uses the owner bootstrap path.

See [the autonomy milestone](autonomy-milestone.md) for deployment and qualification status. Unit/fixture success and owner API verification are distinct from a native phone acceptance run.
