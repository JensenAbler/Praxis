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
- var/lib/alpha-backup/stage/bootstrap-services.json: enabled services, users, executable paths, configuration paths.
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

## Step 4: bring Praxis back first
Recreate praxis-probe and praxis-git service users/groups using the recorded UID/GID; resolve collisions rather than blindly replacing the new system's passwd/group files.
Install Node 22.22.0 (the captured version) and required libraries. The backup includes /usr/bin/node and installed application dependencies; use matching Ubuntu/architecture or reinstall the recorded version.
Restore these paths to their original absolute locations, preserving ownership, symlinks, ACLs, and extended attributes:
- /srv/praxis-app, /srv/praxis-control, /srv/praxis-probe and /opt/praxis where present.
- /var/lib/praxis* data directories.
- /etc/praxis* configuration and /usr/local/libexec/praxis-updater.
- Praxis systemd unit files and their drop-in directories, plus referenced tmpfiles/sudoers configuration.
Check each service's ExecStart, EnvironmentFiles, ReadWritePaths and dependency paths against bootstrap-services.json and its unit file.
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
Bring other services back using bootstrap-services.json, their restored data and units. Existing API tokens may require provider reauthorization.

## Limits and completion criteria
The archive/Drive round-trip and incremental restore mechanics have been tested. A complete new-VPS rebuild has NOT yet been rehearsed.
This is a recoverable filesystem and consistent database-export backup, not a bootable disk image or a promise of one-click migration.
Recovery is complete only when Praxis authenticates and executes a read-only command, databases pass checks, and required applications serve their data.
Daily backup activation and the latest completed backup are recorded separately. Read last-success.json; ignore snapshot folders without COMPLETE.json.
