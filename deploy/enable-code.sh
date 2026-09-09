#!/usr/bin/env bash
# Independent owner bootstrap only, after the candidate passed authenticated fixture tests.
# Ordinary protected-service updates are a later updater milestone.
set -euo pipefail
[[ $(id -u) == 0 ]] || exit 2
release=${1:?Supply the installed release name}
[[ $release =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || exit 2
[[ $(readlink -f /srv/praxis-probe/current) == "/srv/praxis-probe/releases/$release" ]] || exit 2
[[ -f /etc/praxis-code/config.json && ! -L /etc/praxis-code/config.json ]] || exit 2
if systemctl is-active --quiet praxis-code.service; then
  echo 'Coding is already active. Use a reviewed update procedure, not first-activation bootstrap.' >&2
  exit 2
fi
exec 9>/run/lock/praxis-probe-deploy.lock
flock -n 9 || exit 2
dropin=/etc/systemd/system/praxis-probe.service.d
[[ ! -L $dropin && ! -L $dropin/coding.conf ]] || exit 2
install -d -o root -g root -m 0755 "$dropin"
backup=$(mktemp -d /root/praxis-probe-backups/coding-activation-XXXXXXXX)
if [[ -f $dropin/coding.conf ]]; then cp -a "$dropin/coding.conf" "$backup/coding.conf"; fi
committed=0
restore() {
  result=$?
  trap - EXIT
  if [[ $committed == 0 ]]; then
    if [[ -f $backup/coding.conf ]]; then cp -a "$backup/coding.conf" "$dropin/coding.conf"; else rm -f -- "$dropin/coding.conf"; fi
    systemctl daemon-reload
    systemctl restart praxis-probe.service
    # Preserve any command accepted before the gateway rollback. The coding worker
    # may finish it independently; do not interpret a failed health check as idleness.
    echo "Coding activation failed; gateway configuration restored. Inspect backend before stopping it. Backup: $backup" >&2
  fi
  exit "$result"
}
trap restore EXIT
systemctl start praxis-code.service
for attempt in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:8792/healthz > "$backup/coding-health.json"; then break; fi
  sleep 1
done
node - "$backup/coding-health.json" "$release" <<'JS'
const fs = require('node:fs');
const health = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!health.ok || health.release !== process.argv[3]) process.exit(1);
JS
printf '[Service]\nEnvironment=PRAXIS_CODING_URL=http://127.0.0.1:8792\n' > "$dropin/coding.conf"
chmod 0644 "$dropin/coding.conf"
systemctl daemon-reload
systemctl restart praxis-probe.service
for attempt in $(seq 1 20); do
  if curl -fsS -H 'Host: mcp.jensenabler.com' http://127.0.0.1:8790/praxis-probe/healthz > "$backup/gateway-health.json"; then break; fi
  sleep 1
done
curl -fsS -H 'Host: mcp.jensenabler.com' http://127.0.0.1:8790/.well-known/oauth-protected-resource/praxis-probe/mcp > "$backup/metadata.json"
node - "$backup/gateway-health.json" "$backup/metadata.json" "$release" <<'JS'
const fs = require('node:fs');
const health = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const metadata = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
if (!health.ok || health.name !== 'Praxis' || health.release !== process.argv[4] || !metadata.scopes_supported.includes('praxis:code')) process.exit(1);
JS
systemctl enable praxis-code.service
committed=1
printf 'Coding activated. Exact release: %s. Gateway rollback backup: %s\n' "$release" "$backup"
