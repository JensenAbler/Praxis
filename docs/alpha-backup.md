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
