# Rebuild Alpha when the original VPS and Praxis no longer exist

This kit is stored in Google Drive and does not call Alpha, Praxis, Patronus, or an Alpha-hosted authorization page.
Backups are unencrypted. There is no backup password or recovery key.

## What you still need
- Access to jensenabler@gmail.com and its Google Drive, including account recovery/2FA.
- A new Ubuntu 24.04 x86-64 VPS with root SSH access. Prefer at least 200 GB disk for downloaded archives plus extracted files; inspect manifest sizes first.
- Access to the DNS registrar for jensenabler.com if restoring the same service URLs.
- GitHub account access for excluded source files if the retained Git objects cannot reconstruct them. GitHub URLs and exact commits are in repositories.json.
These account logins are not replaced by a server backup.

## Step 1: start without Praxis
Use the new provider's web console or SSH. Install basic tools:

    apt-get update
    apt-get install -y python3 tar zstd rclone rsync git nginx sqlite3 postgresql-16

Get this BOOTSTRAP.md, RESTORE.md and alpha-restore.py from the Alpha-VPS-Backup folder in Drive.
Either download the folder on a computer and transfer it with scp, or configure a NEW rclone Google Drive connection on the replacement machine:

    rclone config

Create a remote named recovery using Google Drive. Use rclone's own default client (leave custom client ID/secret blank), and authorize your Google account using its documented browser/headless flow. Do not use the old Alpha setup URL. If authorization needs a browser on another computer, run the exact rclone authorize command printed by rclone on that computer, then paste its result into the new VPS.

    rclone copy recovery:Alpha-VPS-Backup /root/alpha-backup-download --progress

The backup folder is private. Never enable public sharing to download it.

## Step 2: verify and extract

    python3 /root/alpha-backup-download/alpha-restore.py /root/alpha-backup-download /root/alpha-recovery

The script verifies SHA-256 for every part and follows the full/incremental parent chain. It extracts to an empty directory and does not overwrite the new VPS.
A new ChatGPT session or a human can read these local files through SSH; no Praxis connection is required.

## Step 3: restore data and source before starting services
The recovered filesystem is under /root/alpha-recovery. Inventory:
- var/lib/alpha-backup/stage/bootstrap-services.json: an initial service inventory, not an automatically refreshed list. The copy inspected on 2026-10-22 was still dated 2026-10-15. Use the selected snapshot's actual unit files, drop-ins and stage/services.txt as the recovery source of truth.
- stage/packages.txt: package versions; stage/services.txt: unit enablement.
- stage/databases.json: consistent SQLite copies and PostgreSQL exports.
- stage/repositories.json and stage/scope.json: omitted GitHub files, original paths, exact commits.
- etc/passwd and etc/group: original service UID/GID mappings.
- etc/systemd/system: units and drop-ins. etc/nginx: proxy/domain configuration.
- srv, opt, usr/local, var/lib, root, home: source, dependencies, credentials, jobs and application state.

Restore SQLite exports into the recovered tree at their original relative paths, setting the UID, GID, and mode recorded in databases.json. Do not use raw WAL/SHM files.
Restore PostgreSQL SQL exports into fresh matching PostgreSQL versions: host version 16 and OneCLI container version 18. Recreate the container from its saved compose configuration and stage/containers.json. Do not start services against empty databases.

For omitted repo files, prefer the retained .git objects: git --git-dir=<recovered repo>/.git show <commit>:<relative-file> can recreate an omitted regular file without network access. Use scope.json to identify omitted paths, preserve executable bits and symlink types from git ls-tree, and never overwrite retained local modifications. For missing objects, clone the recorded GitHub URL at the recorded commit in a separate directory and copy only the omitted files. Worktree .git files may reference old absolute paths; repair them after installing the original directory layout.

The existing PNG sequence is in Drive folder:
https://drive.google.com/drive/folders/1xPlS6QMEDT4cL3crAJLqWqsS_7bIwEc4
Restore it separately if needed and compare hashes in stage/png-exclusion.json.

### Reconcile services against the backup cutoff

Do not infer that a service is present in a snapshot merely because it is running now. Compare the selected manifest's started/finished times with the files actually recovered. On 2026-10-22 the newest completed backup started at 2026-10-21 11:04 UTC; the following inventory was checked later and is guidance, not evidence that all of it is in that snapshot:
- patronus-mirror.service: enabled/active; Node entry point /srv/patronus-mirror/server.js; state directory /var/lib/patronus-mirror. The checked unit file postdates that backup; verify that a later completed snapshot contains it. Recover the state directory's real target when systemd uses /var/lib/private; do not restore only its symlink.
- plaid-mcp.service: enabled/active; /srv/plaid-readonly-mcp/remote/server.js; working directory /srv/plaid-readonly-mcp; configuration /etc/plaid-mcp and state /var/lib/plaid-mcp. The checked unit file postdates that backup; verify that a later completed snapshot contains it. Restore its referenced credential files without printing their contents.
- vfx-demand-dashboard.service: enabled/active; /srv/vfx-demand-barometer/current/dashboard_server.py; auth/data under /var/lib/vfx-dashboard. This older service is absent from the initial bootstrap inventory.
- praxis-dependencies.service: disabled/inactive. It references /usr/local/lib/praxis/registry-proxy.py and /run/praxis-dependencies; do not enable it just because its unit is present. The native-root runtime does not require restoring the old registry-proxy workflow.

Recreate users/groups and directories from each recovered unit, its StateDirectory/tmpfiles configuration and the recovered UID/GID mappings. Preserve the selected snapshot's enabled/disabled state, but enable no timers or application workers until their effects are reviewed. Patronus gateway is ordered after patronus.service; recover its matching release, browser dependencies, state and unit drop-ins first. Egress/Tailscale configuration may refer to another device and must be deliberately re-established, not assumed portable.

### Mounted legacy and staging storage

The archive does not traverse /srv/praxis-code/storage or /srv/praxis-stage. Their backing files are /var/lib/praxis-code-disk/storage.ext4 and /var/lib/praxis-stage.img; their mount units are in etc/systemd/system. These are live filesystem-image captures, not guaranteed consistent snapshots. The 2026-10-19 tar warnings reported both images changing during capture. A later successful tar exit does not establish filesystem integrity.

Do not auto-mount these images on the replacement host or assume they are required for basic Praxis recovery. First inspect disposable copies offline with an appropriate read-only filesystem check. If content is needed, use a disposable isolated VM and a read-only, no-journal-replay mount; never repair or write to the only recovered copy. Document any unrecoverable content before proceeding. The active native-root state and jobs were on the main filesystem in /var/lib/praxis-code/live and /var/lib/praxis-root at the 2026-10-22 check. praxis-code.service had ordering after the old storage mount, not a requirement that the mount succeed; verify the restored version rather than relying on that observation forever.

## Step 4: bring Praxis back first
Recreate praxis-probe and praxis-git service users/groups using the recorded UID/GID; resolve collisions rather than blindly replacing the new system's passwd/group files.
Install Node 22.22.0 (the captured version) and required libraries. The backup includes /usr/bin/node and installed application dependencies; use matching Ubuntu/architecture or reinstall the recorded version.
Restore these paths to their original absolute locations, preserving ownership, symlinks, ACLs, and extended attributes:
- /srv/praxis-app, /srv/praxis-control, /srv/praxis-probe and /opt/praxis where present.
- /var/lib/praxis* data directories.
- /etc/praxis* configuration and /usr/local/libexec/praxis-updater.
- Praxis systemd unit files and their drop-in directories, plus referenced tmpfiles/sudoers configuration.
Check each recovered unit and its drop-ins for ExecStart, EnvironmentFiles, LoadCredential, StateDirectory, ReadWritePaths, Requires, After and RequiresMountsFor. Treat bootstrap-services.json only as a cross-check. Recreate runtime directories through the reviewed tmpfiles/unit configuration. Check credential-file presence and ownership without displaying secret values.
Do not overwrite the new VPS's network configuration, fstab, machine-id, SSH host keys, or provider agents.

    systemctl daemon-reload
    systemctl start praxis-git.service praxis-code.service praxis-probe.service
    systemctl status praxis-git.service praxis-code.service praxis-probe.service --no-pager

Resolve missing dependencies using the saved units and package inventory. Then start praxis-claude-facade.service and praxis-updater.service if needed.
Verify local health endpoints using the listen addresses/routes from the restored configuration. A running process alone is not proof of recovery.

## Step 5: restore public access
Restore relevant nginx virtual hosts and their certificate files from /etc/letsencrypt, or issue fresh certificates after pointing DNS to the new IP.
Check all includes and referenced upstream services before reloading nginx. Avoid enabling unrelated sites whose services are not restored yet.

    nginx -t
    systemctl reload nginx

Update A/AAAA records for the Praxis hostnames and other app domains to the new VPS. Remove stale IPv6 records if the new host has no IPv6.
Test HTTPS, OAuth sign-in, and an authenticated Praxis read-only command from ChatGPT. Reconnect the plugin if its saved session has expired.
Bring other services back from the selected snapshot's reviewed units, drop-ins and restored data, with the service reconciliation above. Do not start Discord, scheduled refreshes, backup uploaders, browser jobs, or other externally acting workers merely to check whether their processes run. Existing API tokens may require provider reauthorization.

## Scoped fresh-host rehearsal (requires separate approval)

This is a plan, not a record of a completed rehearsal. Obtain approval for the specific disposable host, any cost, and storing the private backup there before copying it. It must be separate from Alpha, with no production volumes or shared writable directories. Do not change production DNS, OAuth registrations, credentials, services, timers, or backup files.

1. Prepare a fresh Ubuntu 24.04 x86-64 host through its console/SSH, using independently downloaded tools. Establish its own Drive access or transfer the downloaded files without using an Alpha-hosted login page. Record the chosen full/incremental chain, its compressed size and sufficient free space for extraction and disposable test copies.
2. Download and verify every part's SHA-256, then run alpha-restore.py into an empty recovery directory. Preserve that verified result unchanged; conduct further tests on disposable copies. Record extraction exit status, missing files, each SQLite export's read-only integrity check, and PostgreSQL import results in isolated instances.
3. Before executing recovered software, restrict the rehearsal host's network and services so it cannot contact production or third-party APIs. Use approved test-only credentials/configuration and loopback listeners or an SSH tunnel. Do not import production timers, cron jobs, pending jobs or worker queues into an active execution path. Review startup behavior before starting any service; stop if background execution cannot be safely isolated.
4. Restore only the core Praxis service users, required paths, selected data copies and reviewed units. Keep the updater, autonomous workers, Discord, browser jobs, backup uploader and unrelated apps stopped. Test local health, an authenticated read-only MCP operation, and an explicitly selected harmless native command in the isolated environment. Use no live provider tokens. Check required app data separately without running their outbound workers.
5. Save a non-secret report: backup cutoff, selected snapshot IDs, checksums, restore time/disk usage, database checks, exact service versions, local authentication/MCP result, and unresolved dependencies. An isolated local-authentication pass is not proof of real external OAuth or public HTTPS recovery. Stop at this report and request a separate decision for public cutover, live credentials, DNS/OAuth changes or third-party access. Retain or dispose of the rehearsal host/data only as authorized.

## Limits and completion criteria
The archive/Drive round-trip and incremental restore mechanics have been tested. A complete new-VPS rebuild has NOT yet been rehearsed.
This is a recoverable filesystem and consistent database-export backup, not a bootable disk image or a promise of one-click migration.
Recovery is complete only when Praxis authenticates and executes a read-only command, databases pass checks, and required applications serve their data.
Daily backup activation and the latest completed backup are recorded separately. Read last-success.json; ignore snapshot folders without COMPLETE.json.
