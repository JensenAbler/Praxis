# Restore Alpha from Google Drive

Backups are ordinary GNU tar archives compressed with zstd, split into 512 MiB parts.
There is no backup encryption, password, or recovery key. HTTPS and Google's storage protection still apply.

## Download
In the private Google Drive folder Alpha-VPS-Backup, download RESTORE.md and snapshots.
Only snapshot folders containing COMPLETE.json are complete. Ignore incomplete uploads.
Start with a full snapshot, then follow the parent links in COMPLETE.json to the desired incremental snapshot.
Keep every part and its manifest. Verify each part against its SHA-256 in COMPLETE.json before extracting.

## Extract to a clean directory
Install GNU tar and zstd on Linux. For each snapshot in parent order, run:

    cat archive.tar.zst.part* | zstd -d -c | sudo tar --extract --listed-incremental=/dev/null --acls --xattrs --numeric-owner -C /path/to/empty-recovery-root

Use an isolated recovery directory, never a running machine's root filesystem.
Incremental extraction can remove files inside the recovery directory to reproduce recorded deletions.

## Databases
The recovered var/lib/alpha-backup/stage/databases.json maps every exported database to its original path.
SQLite copies live under stage/databases/sqlite. Stop the destination service, copy the export to the original path, remove stale WAL/SHM companions, and restore the recorded uid/gid/mode before starting it.
PostgreSQL SQL exports are stage/databases/host-postgresql.sql and onecli-postgresql.sql. Restore with psql into fresh compatible PostgreSQL instances, preserving roles and database ownership. The original raw PostgreSQL data directories are excluded.
Different database exports are individually consistent, not one cross-service transaction.

## Exclusions and reconstruction
stage/scope.json records exclusions. Pseudo-filesystems, temporary directories, package cache, swap, and backup working files are excluded.
Other mounted filesystems are not followed except boot and boot/efi. stage/mounts.txt records them. In particular, /srv/praxis-code/storage and /srv/praxis-stage are not traversed; their backing images may exist under /var/lib, but a live image copy is not a verified consistent filesystem. Inspect warnings and test disposable copies offline before any read-only, no-journal-replay mount. Never repair or auto-mount the only recovered copy. See BOOTSTRAP.md for the legacy-volume caveat and current native-root paths.
stage/repositories.json records GitHub URLs and commits. Only tracked file bytes verified against a commit advertised by GitHub are omitted. Recreate those files from that commit. Local modified, untracked, ignored files and Git metadata remain in the archive.
stage/png-exclusion.json records 365 already-uploaded PNGs and their existing Drive folder, filenames, sizes and local SHA-256. The Drive listing was verified by filename and size; remote content hashes were not exposed by the connector. Download those PNGs separately and verify the SHA-256 during restore.

## Service inventory and rehearsal
The initial stage/bootstrap-services.json may predate the chosen backup. Reconcile it with that snapshot's actual unit files, drop-ins and stage/services.txt; do not enable disabled services or assume changes made after the backup are present. Follow BOOTSTRAP.md for the service-specific checks and a separately approved, isolated fresh-host rehearsal. Extraction alone does not prove that Praxis authentication or applications have been recovered.

## Verification and retention
Each archive part is compared with the MD5 returned by Drive after upload, and has a SHA-256 recorded in COMPLETE.json.
tar-warnings.txt records files that changed during capture; the filesystem is live, not an atomic machine image.
Snapshots are retained without automatic pruning. Monitor last-success.json and available Drive space.
Keep this document and the backup folder available independently of Alpha. A new machine can download files through Drive; it does not need Alpha's OAuth client or credentials.
