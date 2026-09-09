# Independent publication and deployment

The owner authorizes Praxis to handle the full podcast-discord workflow without a Codex handoff. The default branch is `main`. Other production applications and independent Praxis self-update remain excluded. Version 0.4.0 is active as `coding-abc97268f6d9`; [deployment evidence](evidence/publication-v04-deployment.json) distinguishes configured production capabilities from fixture execution. Actual feature publication and deployment from a phone remain to be exercised.

## Phone workflow

1. `project_sync` fetches registered GitHub main. Recover its operation until completed, then inspect the new project snapshot and create a workspace. Existing workspaces retain their original source and base.
2. Inspect, edit, run the registered checks, and review the exact diff. A pre-existing failing suite remains a failed suite; report its actual baseline and final outcomes.
3. `git_commit` captures an idle workspace at its exact revision. After completion, `git_push` publishes that commit to main. A later commit in the same workspace uses its preceding completed commit as parent.
4. `deployment_status` reads the VPS checkout and service. `deployment_fast_forward` accepts a completed push operation and the observed deployment HEAD. It fast-forwards to the exact current main tip and restarts only the fixed podcast service.
5. `git_operations_list` and `git_operation_status` recover these operations from a fresh conversation. An operation ID and idempotency key identify one attempt; missing output is not permission to create a replacement attempt.

## Boundaries

The coding service captures source into an exchange directory inaccessible to command containers. A separate `praxis-git` identity validates the original owner JWT, independently verifies staged paths, hashes, modes, parent lineage and resulting revision, and constructs Git objects in a protected bare repository. It does not check out candidate source or execute hooks, filters, build scripts, or arbitrary Git commands. GitHub authentication uses a dedicated single-repository write deploy key, outside coding access.

Publication checks both ancestry and the exact expected remote head. The transport uses the explicitly expected form of Git's lease to make the comparison atomic; it rejects non-descendants before invoking push. It never permits history rewriting. See the [Git push contract](https://git-scm.com/docs/git-push) and [GitHub deploy-key API](https://docs.github.com/en/rest/deploy-keys/deploy-keys).

A root-owned helper accepts bounded JSON through a narrowly scoped sudo rule. Its repository, service, branch, paths, and commands are fixed. It checks a clean checkout, exact expected HEAD, exact remote main tip, and fast-forward ancestry. Runtime credentials and ignored data are preserved. Dependency-manifest changes, source symlinks/submodules, runtime-path collisions, hooks, and filters are rejected rather than guessed around. The initial deployment workflow supports code changes using existing prepared dependencies.

The existing bot runs with its existing root identity and production configuration after service adoption. Publishing code grants that code the application's production authority when activated. The development sandbox and Git credential boundary do not sandbox deployed application code. No general production shell is exposed.

## Recovery and health

The broker persists operations before effects and processes them independently of HTTP calls. Commit timestamps and source inputs are fixed for deterministic reconstruction. After an interrupted push, recovery observes whether the exact commit is present on remote main; it does not repeat an ambiguous push. Deployment journals record checkout and restart intent. A lost restart response is reconciled from systemd invocation identity; an unresolved restart remains uncertain and is not repeated automatically.

Deployment health verifies a new stable managed process. It does not prove Discord connectivity, provider behavior, or preservation of an in-flight recording. The current bot has no application signal handler; its restart is a process replacement, not an application-level drain. A restart failure preserves the updated checkout and reports failure; the helper does not automatically roll back external work.

Immutable exported source is bounded to 512 MiB, and coding transfer stages are separately bounded to 512 MiB. Terminal commit stages are removed after their durable result is integrated; uncertain stages remain. Receipt limits are explicit. An operator must archive exhausted protected storage; the tool does not silently delete recoverable evidence.
