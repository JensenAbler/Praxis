#!/usr/bin/env bash
set -euo pipefail
# Run via bootstrap SSH only. The candidate contains fixed fixture code, no user jobs.
release="${1:?Supply the exact release directory name}"
[[ "$release" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || exit 2
test "$(id -u)" -eq 0
exec 9>/run/lock/praxis-probe-deploy.lock
flock -n 9 || { printf 'Another Praxis Probe deployment is running.\n' >&2; exit 2; }
if systemctl is-active --quiet praxis-code.service || test -e /etc/systemd/system/praxis-probe.service.d/coding.conf; then
  printf 'Coding has been activated. Use a reviewed coding-service update procedure; this probe bootstrap does not coordinate coding jobs.\n' >&2
  exit 2
fi
root=/srv/praxis-probe
candidate="$root/releases/$release"
builder=praxis-probe-build
test -d "$candidate"
test "$(realpath -e -- "$candidate")" = "$candidate"
test -f "$candidate/package-lock.json"
test -d /etc/praxis-probe/credentials
test -f /etc/nginx/sites-available/mcp
test ! -L /etc/nginx/sites-available/mcp
if test -e "$root/current" || test -L "$root/current"; then
  test -L "$root/current"
  if test "$(realpath -e -- "$root/current")" = "$candidate"; then
    printf 'Use a new immutable release directory; the candidate is already current.\n' >&2
    exit 2
  fi
fi
nginx -t
if ! id praxis-probe >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/lib/praxis-probe --shell /usr/sbin/nologin praxis-probe
fi
if ! id "$builder" >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/cache/praxis-probe-build --shell /usr/sbin/nologin "$builder"
fi
test "$(id -u "$builder")" != "$(id -u praxis-probe)"
test "$(id -u "$builder")" != 0
install -d -o praxis-probe -g praxis-probe -m 700 /var/lib/praxis-probe
install -d -o "$builder" -g "$builder" -m 700 /var/cache/praxis-probe-build
# Build/test code must not inherit the service identity, credentials, or environment.
runuser -u "$builder" -- sh -c 'test ! -x /var/lib/praxis-probe && test ! -x /etc/praxis-probe/credentials'
install -d -m 700 /root/praxis-probe-backups
backup="$(mktemp -d "/root/praxis-probe-backups/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"
candidate_writable=0
activation_started=0
web_quiesced=0
worker_touched=0
nginx_reload_attempted=0
enablement_touched=0
committed=0
web_was_active=0
worker_was_active=0
systemctl is-active --quiet praxis-probe.service && web_was_active=1
systemctl is-active --quiet praxis-probe-worker.service && worker_was_active=1
web_was_enabled="$(systemctl is-enabled praxis-probe.service 2>/dev/null || true)"
worker_was_enabled="$(systemctl is-enabled praxis-probe-worker.service 2>/dev/null || true)"

save_path() {
  if test -e "$2" || test -L "$2"; then cp -a -- "$2" "$backup/$1"; fi
}
restore_path() {
  rm -f -- "$2"
  if test -e "$backup/$1" || test -L "$backup/$1"; then cp -a -- "$backup/$1" "$2"; fi
}
restore_enablement() {
  systemctl disable "$1" >/dev/null 2>&1
  case "$2" in
    enabled) systemctl enable "$1" ;;
    enabled-runtime) systemctl enable --runtime "$1" ;;
  esac
}
finish() {
  result=$?
  trap - EXIT INT TERM
  set +e
  if test "$candidate_writable" -eq 1; then
    chown -R root:root "$candidate"
    chmod -R go-w "$candidate"
  fi
  if test "$committed" -eq 0 && { test "$activation_started" -eq 1 || test "$web_quiesced" -eq 1; }; then
    printf 'Activation failed; restoring the previous probe deployment. Backup: %s\n' "$backup" >&2
    if test "$activation_started" -eq 1; then
      systemctl stop praxis-probe.service
      if test "$worker_touched" -eq 1; then systemctl stop praxis-probe-worker.service; fi
      restore_path nginx-mcp /etc/nginx/sites-available/mcp
      restore_path nginx-snippet /etc/nginx/snippets/praxis-probe.conf
      restore_path release.env /etc/praxis-probe/release.env
      restore_path current "$root/current"
      restore_path praxis-probe.service /etc/systemd/system/praxis-probe.service
      restore_path praxis-probe-worker.service /etc/systemd/system/praxis-probe-worker.service
      systemctl daemon-reload
      if test "$enablement_touched" -eq 1; then
        restore_enablement praxis-probe.service "$web_was_enabled"
        restore_enablement praxis-probe-worker.service "$worker_was_enabled"
      fi
    fi
    if test "$worker_touched" -eq 1 && test "$worker_was_active" -eq 1; then systemctl start praxis-probe-worker.service; fi
    if test "$web_was_active" -eq 1; then systemctl start praxis-probe.service; fi
    if test "$nginx_reload_attempted" -eq 1; then
      if nginx -t; then systemctl reload nginx; else printf 'Restored nginx configuration failed validation; nginx was not reloaded.\n' >&2; fi
    fi
  fi
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

save_path nginx-mcp /etc/nginx/sites-available/mcp
save_path nginx-snippet /etc/nginx/snippets/praxis-probe.conf
save_path release.env /etc/praxis-probe/release.env
save_path current "$root/current"
save_path praxis-probe.service /etc/systemd/system/praxis-probe.service
save_path praxis-probe-worker.service /etc/systemd/system/praxis-probe-worker.service

# Dependency installation and tests run with a separate UID and a clean environment.
candidate_writable=1
chown -R "$builder:$builder" "$candidate"
runuser -u "$builder" -- env -i PATH=/usr/bin:/bin HOME=/var/cache/praxis-probe-build npm_config_cache=/var/cache/praxis-probe-build npm ci --ignore-scripts --prefix "$candidate"
runuser -u "$builder" -- env -i PATH=/usr/bin:/bin HOME=/var/cache/praxis-probe-build npm_config_cache=/var/cache/praxis-probe-build sh -c 'cd "$1" && npm test' sh "$candidate"
chown -R root:root "$candidate"
chmod -R go-w "$candidate"
candidate_writable=0

# Close ingress before checking so another MCP request cannot enqueue a job in the gap.
# A rejected upgrade leaves the independent worker running and restores the old web service.
if test "$web_was_active" -eq 1; then
  web_quiesced=1
  systemctl stop praxis-probe.service
fi
python3 - <<'PY'
from pathlib import Path
import sqlite3
path = Path('/var/lib/praxis-probe/probe.sqlite')
if path.exists():
    with sqlite3.connect(f'{path.as_uri()}?mode=ro', uri=True, timeout=5) as db:
        count = db.execute("SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')").fetchone()[0]
    if count:
        raise SystemExit('Upgrade rejected: a queued or running probe job exists. Wait for its terminal result and retry.')
PY
activation_started=1
worker_touched=1
if test "$worker_was_active" -eq 1; then systemctl stop praxis-probe-worker.service; fi
install -m 644 "$candidate/deploy/praxis-probe.service" /etc/systemd/system/praxis-probe.service
install -m 644 "$candidate/deploy/praxis-probe-worker.service" /etc/systemd/system/praxis-probe-worker.service
install -m 644 "$candidate/deploy/praxis-probe.nginx.conf" /etc/nginx/snippets/praxis-probe.conf
printf 'PRAXIS_RELEASE=%s\n' "$release" > /etc/praxis-probe/release.env
ln -sfn "$candidate" "$root/current"
python3 - <<'PY'
from pathlib import Path
p = Path('/etc/nginx/sites-available/mcp')
text = p.read_text()
line = '    include /etc/nginx/snippets/praxis-probe.conf;'
if line not in text:
    marker = '    include /etc/nginx/snippets/vps-observer.conf;'
    if text.count(marker) != 1:
        raise SystemExit('Expected unique existing HTTPS include; inspect nginx configuration manually.')
    p.write_text(text.replace(marker, marker + '\n' + line, 1))
PY
nginx -t
systemctl daemon-reload
systemctl start praxis-probe-worker.service praxis-probe.service
healthy=0
for attempt in $(seq 1 20); do
  if health="$(curl -fsS --max-time 2 -H 'Host: mcp.jensenabler.com' http://127.0.0.1:8790/praxis-probe/healthz)" &&
    python3 -c 'import json,sys; result=json.load(sys.stdin); sys.exit(0 if result.get("ok") is True and result.get("release")==sys.argv[1] else 1)' "$release" <<<"$health" &&
    systemctl is-active --quiet praxis-probe-worker.service; then
    healthy=1
    break
  fi
  sleep 1
done
test "$healthy" -eq 1
nginx -t
nginx_reload_attempted=1
systemctl reload nginx
enablement_touched=1
systemctl enable praxis-probe-worker.service praxis-probe.service
committed=1
printf '%s\nBackup directory: %s\n' "$health" "$backup"
