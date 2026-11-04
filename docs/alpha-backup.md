# Alpha backup setup
The standalone scripts/alpha-backup-oauth.mjs helper reuses the registered
/drive-audit/callback route but stores state in /var/lib/alpha-backup.
Keep the old audit credentials intact. The helper binds only to loopback.
Authenticate the intended account with drive.file, verify identity and quota,
then configure the scheduled uploader. Authorization alone never starts uploads.

## Required backup policy
- Preserve databases using engine-native consistent exports.
- Preserve Linux ownership, permissions, symlinks and extended attributes in archives.
- Exclude the recovered PNG bytes only after remote hashes match; retain their
  manifest, checksums and existing Drive folder reference for restoration.
- Exclude GitHub-recoverable repository content only after confirming the remote
  contains the commit. Preserve unpushed commits, dirty files, untracked and
  ignored runtime data, LFS data not confirmed remotely, and configuration.
- Record clone URLs and exact commits, without credentials.
- Retain old backup versions; do not mirror local deletions into Drive.
- Verify an uploaded backup and a sample restore before enabling a daily timer.
- Record failure and last successful backup independently from process status.
- Do not call setup complete before account capacity and restore are verified.
- Check the Google OAuth app publishing status to avoid Testing-mode expiry.

## Ephemeral archive inputs
The archive excludes only the generated six-character scratch directories
./var/lib/apocrypha/codex/summary-?????? and
./var/lib/apocrypha/codex/tmp/arg0-linux/codex-arg0??????.
These anchored, fixed-depth patterns prevent live compactor/CLI cleanup from
aborting the archive. They are recorded separately in stage/scope.json.
Persistent Codex state, sessions, authentication, shell snapshots, databases,
and similarly named paths remain in scope. Repository and PNG exclusions
continue to use literal matching, not wildcard matching.

Never add --ignore-failed-read or accept tar exit 2: missing non-temporary inputs,
permission errors, and other archive failures must still prevent publication of
COMPLETE.json and advancement of the incremental checkpoint. Existing tar exit 1
warnings remain recorded. Run npm test and python3 test/alpha_restore_test.py
before publishing a change to the backup script.
