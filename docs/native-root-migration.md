# Native root execution

The owner has explicitly authorized Praxis to run directly on Alpha as root, including access to host files, network, credentials and administration. This replaces the earlier development sandbox boundary. OAuth still authenticates access to the tools. Ordinary root jobs can maintain any Praxis component; the independent release tools remain available as a convenient tested activation and recovery path.

The owner migration is `deploy/migrate-native-root.py`. Importing it has no effects. Its `plan` command is read-only. Before using `apply`, qualify the exact source with `npm test` and authenticated candidate MCP checks, review the migration, and independently capture the current production service identities and repository revisions. The existing isolated owner qualifier can prepare this transition while the old registry proxy remains active. Native runner verification is a separate real-systemd check; the candidate MCP qualification uses an inert executor.

Run the helper from the sealed qualified tree. Substitute its returned acceptance path and the observed current application/control release basenames:

```sh
python3 QUALIFIED_TREE/deploy/migrate-native-root.py plan QUALIFIED_TREE ACCEPTANCE EXPECTED_APP EXPECTED_CONTROL
python3 QUALIFIED_TREE/deploy/migrate-native-root.py apply QUALIFIED_TREE ACCEPTANCE EXPECTED_APP EXPECTED_CONTROL
```

The helper verifies the accepted source digest before copying or installing it. It imports the existing installed bootstrap transaction only after checking that helper against the recorded installed hash. A changed release, active coding job, prepared edit, unresolved publication, or unfinished updater operation blocks migration. It stops admission before its final idle checks. It does not cancel or repeat work.

The migration installs matching application/control releases and the reviewed deployment/updater helpers. It replaces the coding and updater units, masks their old inherited drop-ins, and checks the effective native service properties after startup. It backs up configuration, unit files, symlinks, enabled/running states and fresh SQLite snapshots. A failed startup restores the old configuration and service state. Operational databases are never restored from snapshots; SQLite file and sidecar ownership is repaired so the previous service UID can recover current data.

New execution uses normal host storage:

| Purpose | Location |
| --- | --- |
| New workspaces | `/var/lib/praxis-root/workspaces` |
| Independent job records/logs | `/var/lib/praxis-root/jobs` |
| Persistent home and caches | `/var/lib/praxis-root/home` |
| Self-update preparations | `/var/lib/praxis-root/stages` |

Old workspace paths, terminal job records, container logs, images and loop mounts remain in place. The coding configuration retains the former workspace roots and runner settings for history. Terminal historical jobs are read from persisted records; they are not rerun through Podman. The migration disables only the obsolete `praxis-dependencies.service` registry proxy. It does not change podcast-discord, podcast-production, Apocrypha, VPS Observer, nginx, Docker, or their data and source revisions. Attached project registration is a separate authenticated operation after activation.

The native service and new job units have root identity, host network/filesystem access, and no container filesystem quota or configured CPU, memory or task limits. The persistent home starts with the registered Git identity and `main` as the default branch; existing native home configuration is preserved. OpenSSH continues to resolve the root account's SSH configuration normally. Jobs may also explicitly access other host configuration as authorized root work.

The existing self-update path uses ordinary native `npm ci`, tests, and authenticated readiness against a disposable database copy. Its old protected-source hash map becomes an inventory in native mode. Exact export/artifact checks, activation fencing, health checks and application rollback remain. That convenience command switches the coding application and tool manifest; full root jobs can independently replace controls and host configuration. Native build/readiness code has actual root authority, which is recorded explicitly in preparation evidence.

Successful migration records a durable `activation_confirmed` decision before opening admission. If the response is lost, inspect the private backup returned by the owner command. Recover that exact transaction with:

```sh
python3 QUALIFIED_TREE/deploy/migrate-native-root.py recover PRIVATE_BACKUP
```

Recovery completes a confirmed activation without repeating jobs, or restores an unfinished migration while it still owns admission and no work is active. It refuses to restore over a later operation. Newly prepared files remain available for diagnosis. Do not retry `apply` against an existing release target or restore a database snapshot over subsequently accepted work.

These are implementation and qualification instructions. They do not by themselves claim an actual production migration or a native iPhone run has completed.
