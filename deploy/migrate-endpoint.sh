#!/usr/bin/env bash
# One-time, reviewed owner migration after npm test and authenticated MCP fixture
# acceptance of this exact immutable release. This is not an agent updater.
set -euo pipefail
[[ $(id -u) == 0 ]] || exit 2
release=${1:?Supply the exact tested immutable release directory name}
[[ $release =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || exit 2
exec 9>/run/lock/praxis-probe-deploy.lock
flock -n 9 || { echo 'Another Praxis deployment is running.' >&2; exit 2; }
root=/srv/praxis-probe
candidate="$root/releases/$release"
[[ -d $candidate && $(realpath -e -- "$candidate") == "$candidate" ]] || exit 2
[[ -L $root/current ]] || exit 2
previous=$(readlink -f -- "$root/current")
[[ $previous == "$root/releases/"* && $previous != "$candidate" ]] || exit 2
[[ -f $candidate/node_modules/.package-lock.json && -f $candidate/deploy/praxis.nginx.conf ]] || exit 2
# Deployment preparation uses a separate build UID; activation accepts only its
# reviewed, root-owned, non-writable result. No build or candidate code runs here.
[[ -z $(find "$candidate" -xdev \( ! -user root -o -perm /022 \) ! -type l -print -quit) ]] || exit 2
config=/etc/praxis-code/config.json
site=/etc/nginx/sites-available/mcp
snippet=/etc/nginx/snippets/praxis.conf
dropin=/etc/systemd/system/praxis-probe.service.d/endpoint.conf
for path in "$config" "$site" /etc/praxis-probe/release.env; do
  [[ -f $path && ! -L $path ]] || exit 2
done
for path in "$snippet" "$dropin" /etc/systemd/system/praxis-probe.service.d; do
  [[ ! -L $path ]] || exit 2
done
# This narrowly scoped migration requires the already enabled coding deployment.
# Refuse partial/inactive deployments rather than guessing which services to start.
for unit in praxis-probe.service praxis-code.service praxis-probe-worker.service; do
  systemctl is-active --quiet "$unit" || { echo "Expected active service: $unit" >&2; exit 2; }
done
nginx -t
install -d -o root -g root -m 0700 /root/praxis-probe-backups
backup=$(mktemp -d /root/praxis-probe-backups/endpoint-migration-XXXXXXXX)
save() { if [[ -e $2 || -L $2 ]]; then cp -a -- "$2" "$backup/$1"; fi; }
restore() {
  if [[ -e $backup/$1 || -L $backup/$1 ]]; then cp -a -- "$backup/$1" "$2.restore.$$"; mv -Tf -- "$2.restore.$$" "$2";
  else rm -f -- "$2"; fi
}
save config.json "$config"
save nginx-mcp "$site"
save nginx-snippet "$snippet"
save endpoint.conf "$dropin"
save release.env /etc/praxis-probe/release.env
save current "$root/current"
touched=0
gateway_stopped=0
code_stopped=0
committed=0
finish() {
  result=$?
  trap - EXIT INT TERM
  set +e
  if [[ $committed == 0 ]]; then
    if [[ $touched == 1 ]]; then
      # Candidate ingress is still gated to loopback. The migration makes only
      # health/metadata/unauthenticated requests, so no new job can be admitted.
      systemctl stop praxis-probe.service
      if [[ $code_stopped == 1 ]]; then systemctl stop praxis-code.service; fi
      restore config.json "$config"
      restore nginx-mcp "$site"
      restore nginx-snippet "$snippet"
      restore endpoint.conf "$dropin"
      restore release.env /etc/praxis-probe/release.env
      restore current "$root/current"
      systemctl daemon-reload
      if nginx -t; then systemctl reload nginx; else echo 'Restored nginx failed validation; reload withheld.' >&2; fi
    fi
    if [[ $code_stopped == 1 ]]; then systemctl start praxis-code.service; fi
    if [[ $gateway_stopped == 1 ]]; then systemctl start praxis-probe.service; fi
    echo "Endpoint migration did not commit. Previous configuration restored where changed. Backup: $backup" >&2
  elif [[ $result != 0 ]]; then
    # Do not roll a public service back after a command might have been accepted.
    echo "The new release is committed. Inspect nginx reload state; do not stop a possibly active coding job. Backup: $backup" >&2
  fi
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Prepare bounded, reviewed changes without printing protected configuration.
python3 - "$backup" "$release" "$candidate" "$previous" <<'PY'
import json, pathlib, sys
backup, release, candidate = pathlib.Path(sys.argv[1]), sys.argv[2], pathlib.Path(sys.argv[3])
config = json.loads((backup / 'config.json').read_text())
previous = pathlib.Path(sys.argv[4]).name
if config['release'] != previous or (backup / 'release.env').read_text().strip() != f'PRAXIS_RELEASE={previous}':
    raise SystemExit('Existing release/configuration disagree; inspect before migration.')
old = 'https://mcp.jensenabler.com/praxis-probe'
new = 'https://mcp.jensenabler.com/praxis'
if config['issuer'] != old + '/oauth' or config['resourceUrl'] != old + '/mcp':
    raise SystemExit('Expected the old canonical issuer/resource. This migration is one-time only.')
if config['dataDirectory'] != '/var/lib/praxis-code/live':
    raise SystemExit('Unexpected coding data directory; inspect before migration.')
config.update(issuer=new + '/oauth', resourceUrl=new + '/mcp', release=release)
(backup / 'config.next.json').write_text(json.dumps(config, indent=2) + '\n')
site = (backup / 'nginx-mcp').read_text()
old_include = '    include /etc/nginx/snippets/praxis-probe.conf;'
new_include = '    include /etc/nginx/snippets/praxis.conf;'
if site.count(old_include) != 1 or new_include in site:
    raise SystemExit('Expected exactly one old Praxis include and no new include.')
(backup / 'nginx-mcp.next').write_text(site.replace(old_include, new_include, 1))
snippet = (candidate / 'deploy/praxis.nginx.conf').read_text()
# Gate every proxy location through verification. TLS requests to the actual
# public vhost use loopback --resolve; remote callers cannot enqueue commands.
gate = '    allow 127.0.0.1;\n    allow ::1;\n    deny all;\n'
if snippet.count('    proxy_pass http://127.0.0.1:8790;') != 4:
    raise SystemExit('Unexpected candidate nginx template.')
(backup / 'nginx-snippet.gated').write_text(snippet.replace('    proxy_pass', gate + '    proxy_pass'))
PY

# Stop gateway ingress, then hold the coding database's existing write-reservation
# lock through service shutdown. A forwarded /call may outlive the gateway: a
# read-only idle snapshot alone would allow its late admission before shutdown.
# Every coding admission and workspace mutation uses BEGIN IMMEDIATE, so this
# lock closes that race without freezing or killing a process with accepted work.
gateway_stopped=1
systemctl stop praxis-probe.service
# A failed lock/idle check leaves this service active; rollback's start is a no-op.
# Set before the helper so a failure after its successful stop still restores it.
code_stopped=1
python3 - <<'PY'
from pathlib import Path
import grp, pwd, signal, sqlite3, stat, subprocess
path = Path('/var/lib/praxis-code/live/coding.sqlite')
uid, gid = pwd.getpwnam('praxis-code').pw_uid, grp.getgrnam('praxis-code').gr_gid
# Do not let a root SQLite connection create new, wrongly owned WAL sidecars.
for item in (path, Path(str(path) + '-wal'), Path(str(path) + '-shm')):
    info = item.lstat()
    if not stat.S_ISREG(info.st_mode) or (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (uid, gid, 0o600):
        raise SystemExit('Expected existing private coding SQLite database and WAL sidecars; refusing migration.')
interrupted = []
# Once stop begins, retain the reservation until it returns. An ordinary SIGINT
# or SIGTERM must not release admission while shutdown is still in progress.
for name in (signal.SIGINT, signal.SIGTERM):
    signal.signal(name, lambda number, frame: interrupted.append(number))
db = sqlite3.connect(f'{path.as_uri()}?mode=rw', uri=True, timeout=5, isolation_level=None)
try:
    if db.execute('PRAGMA journal_mode').fetchone()[0] != 'wal':
        raise SystemExit('Expected the existing WAL database; refusing migration.')
    db.execute('BEGIN IMMEDIATE')
    count = db.execute("SELECT COUNT(*) FROM code_jobs WHERE status IN ('queued','starting','running','canceling')").fetchone()[0]
    prepared = db.execute("SELECT COUNT(*) FROM operations WHERE status='prepared'").fetchone()[0]
    if count or prepared:
        raise SystemExit(f'Migration rejected: {count} active coding job(s), {prepared} unfinished operation(s). Recover them and retry.')
    probe = Path('/var/lib/praxis-probe/probe.sqlite')
    if not probe.is_file() or probe.is_symlink():
        raise SystemExit('Expected the ordinary probe database; refusing migration.')
    with sqlite3.connect(f'{probe.as_uri()}?mode=ro', uri=True, timeout=5) as probe_db:
        count = probe_db.execute("SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')").fetchone()[0]
    if count:
        raise SystemExit(f'Migration rejected: {count} active probe job(s). Wait for a terminal result and retry.')
    if interrupted:
        raise SystemExit(128 + interrupted[-1])
    # No INSERT/UPDATE/DELETE is performed by this reservation. The unit's normal
    # 15-second stop policy completes before releasing the lock to other writers.
    subprocess.run(['systemctl', 'stop', 'praxis-code.service'], check=True)
    state = subprocess.check_output(['systemctl', 'show', 'praxis-code.service', '-p', 'ActiveState', '--value'], text=True).strip()
    if state != 'inactive':
        raise SystemExit(f'Coding shutdown did not reach inactive state: {state}')
finally:
    if db.in_transaction:
        db.rollback()
    db.close()
if interrupted:
    raise SystemExit(128 + interrupted[-1])
print('Both queues and workspace intents were idle; coding stopped while new admissions remained locked out.')
PY
touched=1
install -o root -g praxis-code -m 0640 "$backup/config.next.json" "$config.next.$$"
mv -Tf -- "$config.next.$$" "$config"
install -o root -g root -m 0644 "$backup/nginx-mcp.next" "$site.next.$$"
mv -Tf -- "$site.next.$$" "$site"
install -o root -g root -m 0644 "$backup/nginx-snippet.gated" "$snippet.next.$$"
mv -Tf -- "$snippet.next.$$" "$snippet"
printf '[Service]\nEnvironment=PRAXIS_BASE_URL=https://mcp.jensenabler.com/praxis\n' > "$dropin.next.$$"
chmod 0644 "$dropin.next.$$"
mv -Tf -- "$dropin.next.$$" "$dropin"
printf 'PRAXIS_RELEASE=%s\n' "$release" > /etc/praxis-probe/release.env.next
chmod 0644 /etc/praxis-probe/release.env.next
mv -Tf -- /etc/praxis-probe/release.env.next /etc/praxis-probe/release.env
ln -s -- "$candidate" "$root/current.next.$$"
mv -Tf -- "$root/current.next.$$" "$root/current"
nginx -t
systemctl reload nginx
systemctl daemon-reload
systemctl start praxis-code.service praxis-probe.service
public_curl=(curl --noproxy '*' --resolve mcp.jensenabler.com:443:127.0.0.1 --connect-timeout 3 --max-time 5 -fsS)
healthy=0
for attempt in $(seq 1 20); do
  if "${public_curl[@]}" https://mcp.jensenabler.com/praxis/healthz > "$backup/gateway-health.json" &&
    curl -fsS --max-time 2 http://127.0.0.1:8792/healthz > "$backup/coding-health.json"; then healthy=1; break; fi
  sleep 1
done
[[ $healthy == 1 ]]
"${public_curl[@]}" https://mcp.jensenabler.com/.well-known/oauth-protected-resource/praxis/mcp > "$backup/resource.json"
"${public_curl[@]}" https://mcp.jensenabler.com/.well-known/oauth-authorization-server/praxis/oauth > "$backup/issuer.json"
status=$(curl --noproxy '*' --resolve mcp.jensenabler.com:443:127.0.0.1 --max-time 5 -sS -D "$backup/unauthorized.headers" -o "$backup/unauthorized.json" -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data '{}' https://mcp.jensenabler.com/praxis/mcp)
[[ $status == 401 ]]
old_status=$(curl --noproxy '*' --resolve mcp.jensenabler.com:443:127.0.0.1 --max-time 5 -sS -o "$backup/old-endpoint.json" -w '%{http_code}' -X POST https://mcp.jensenabler.com/praxis-probe/mcp)
[[ $old_status == 410 ]]
python3 - "$backup" "$release" <<'PY'
import json, pathlib, sys
base = pathlib.Path(sys.argv[1])
read = lambda name: json.loads((base / name).read_text())
web, code, resource, issuer = map(read, ('gateway-health.json', 'coding-health.json', 'resource.json', 'issuer.json'))
expected = 'https://mcp.jensenabler.com/praxis'
assert web['ok'] is True and code['ok'] is True
assert web['release'] == code['release'] == sys.argv[2] and web['name'] == 'Praxis'
assert resource['resource'] == expected + '/mcp' and resource['resource_name'] == 'Praxis'
assert resource['authorization_servers'] == [expected + '/oauth'] and 'praxis:code' in resource['scopes_supported']
assert issuer['issuer'] == expected + '/oauth' and 'praxis:code' in issuer['scopes_supported']
for name in ('authorization_endpoint', 'token_endpoint', 'jwks_uri', 'registration_endpoint'):
    assert issuer[name].startswith(expected + '/oauth/')
assert '/.well-known/oauth-protected-resource/praxis/mcp' in (base / 'unauthorized.headers').read_text()
assert read('old-endpoint.json')['endpoint'] == expected + '/mcp'
print('Canonical HTTPS health, OAuth discovery, scope, 401 challenge, and old-path 410 passed.')
PY
for unit in praxis-probe.service praxis-code.service praxis-probe-worker.service; do systemctl is-active --quiet "$unit"; done

# Everything has passed with ingress gated. Publication is the commit point:
# thereafter a caller could start work, so automatic rollback must never stop it.
install -o root -g root -m 0644 "$candidate/deploy/praxis.nginx.conf" "$snippet.next.$$"
mv -Tf -- "$snippet.next.$$" "$snippet"
nginx -t
committed=1
systemctl reload nginx
printf 'Endpoint migrated: https://mcp.jensenabler.com/praxis/mcp\nRelease: %s\nBackup: %s\nReconnect the client for the new OAuth issuer/resource. Stored workspaces and jobs are preserved.\n' "$release" "$backup"
