#!/usr/bin/env bash
# Reviewed manual owner activation only, never an agent self-updater.
# Usage: update-coding-release.sh <immutable-release> <root-owned-0600-acceptance.json>
# Acceptance fields: release, sourceCommit (40 hex), treeSha256,
# fixtureReceiptSha256 (64 hex), npmTestPassed:true, authenticatedMcpPassed:true.
# Compute treeSha256 after preparation with: update-coding-release.sh --tree-hash DIR
# The hash includes every source file except the top-level node_modules subtree;
# package-lock.json remains included. No candidate build/code executes as root.
set -euo pipefail
umask 077

tree_hash() {
  python3 - "$1" <<'TREE_HASH'
import hashlib, json, pathlib, stat, sys
root = pathlib.Path(sys.argv[1])
if not root.is_dir() or root.is_symlink():
    raise SystemExit('Expected an ordinary candidate directory.')
records = []
for path in sorted(root.rglob('*'), key=lambda path: path.relative_to(root).as_posix()):
    name = path.relative_to(root).as_posix()
    if name == 'node_modules' or name.startswith('node_modules/'):
        continue
    info = path.lstat()
    if stat.S_ISDIR(info.st_mode):
        continue
    if not stat.S_ISREG(info.st_mode):
        raise SystemExit('Source manifest contains a nonregular entry.')
    records.append(dict(path=name, bytes=info.st_size, sha256=hashlib.sha256(path.read_bytes()).hexdigest(), executable=bool(info.st_mode & 0o111)))
payload = json.dumps(records, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('ascii')
print(hashlib.sha256(payload).hexdigest())
TREE_HASH
}
if [[ ${1:-} == --tree-hash ]]; then
  [[ $# == 2 ]] || exit 2
  tree_hash "$2"
  exit
fi
[[ $(id -u) == 0 && $# == 2 ]] || exit 2
release=$1
acceptance=$2
[[ $release =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || exit 2
[[ -f $acceptance && ! -L $acceptance && $(stat -c '%u:%a' -- "$acceptance") == 0:600 ]] || exit 2
exec 9>/run/lock/praxis-probe-deploy.lock
flock -n 9 || { echo 'Another Praxis deployment is running.' >&2; exit 2; }
root=/srv/praxis-probe
candidate="$root/releases/$release"
config=/etc/praxis-code/config.json
git_config=/etc/praxis-git/config.json
snippet=/etc/nginx/snippets/praxis.conf
release_env=/etc/praxis-probe/release.env
[[ -d $candidate && $(realpath -e -- "$candidate") == "$candidate" && -L $root/current ]] || exit 2
previous=$(readlink -f -- "$root/current")
[[ $previous == "$root/releases/"* && $previous != "$candidate" ]] || exit 2
[[ -f $candidate/node_modules/.package-lock.json && -f $candidate/deploy/praxis.nginx.conf ]] || exit 2
[[ -d $candidate/node_modules && ! -L $candidate/node_modules ]] || exit 2
git_enabled=0
git_previous_active=0
if [[ -e $git_config || -L $git_config ]]; then
  [[ -f $git_config && ! -L $git_config && $(stat -c '%U:%G:%a' -- "$git_config") == root:praxis-git:640 && -f $candidate/src/git/server.js ]] || exit 2
  git_enabled=1
  if systemctl is-active --quiet praxis-git.service; then
    [[ -f $previous/src/git/server.js ]] || exit 2
    git_previous_active=1
  elif [[ -f $previous/src/git/server.js ]]; then
    echo 'Existing Git-enabled release has an inactive broker; inspect it before update.' >&2
    exit 2
  fi
elif systemctl is-active --quiet praxis-git.service; then
  echo 'Active Git broker has no registered protected configuration.' >&2
  exit 2
fi
[[ -z $(find "$candidate" -xdev \( ! -user root -o -perm /022 \) ! -type l -print -quit) ]] || exit 2
python3 - "$candidate" <<'DEPENDENCY_LINKS'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
for path in root.rglob('*'):
    if path.is_symlink():
        if path.lstat().st_uid != 0 or not path.resolve(strict=True).is_relative_to(root):
            raise SystemExit('Dependency links must be root-owned and resolve inside the immutable candidate.')
DEPENDENCY_LINKS
for path in "$config" "$snippet" "$release_env" /etc/nginx/sites-available/mcp; do
  [[ -f $path && ! -L $path && $(stat -c %u -- "$path") == 0 ]] || exit 2
done
# This updater changes no routes, project registrations, or runner image. A
# separately bootstrapped optional Git broker can join the existing services.
# Both templates and the actual live snippet must agree byte-for-byte.
cmp -s -- "$snippet" "$candidate/deploy/praxis.nginx.conf" || { echo 'Candidate nginx differs from live configuration; separate review required.' >&2; exit 2; }
cmp -s -- "$snippet" "$previous/deploy/praxis.nginx.conf" || exit 2
for unit in praxis-probe.service praxis-code.service praxis-probe-worker.service; do
  systemctl is-active --quiet "$unit" || { echo "Expected active service: $unit" >&2; exit 2; }
done
nginx -t
source_hash=$(tree_hash "$candidate")
install -d -o root -g root -m 0700 /root/praxis-probe-backups
backup=$(mktemp -d /root/praxis-probe-backups/coding-update-XXXXXXXX)
cp -a -- "$acceptance" "$backup/acceptance.json"
cp -a -- "$config" "$backup/config.json"
if [[ $git_enabled == 1 ]]; then cp -a -- "$git_config" "$backup/git-config.json"; fi
cp -a -- "$snippet" "$backup/nginx-snippet"
cp -a -- "$release_env" "$backup/release.env"
cp -a -- "$root/current" "$backup/current"

python3 - "$backup" "$release" "$previous" "$source_hash" <<'PREPARE'
import json, pathlib, re, sys
backup, release, previous, tree_hash = pathlib.Path(sys.argv[1]), *sys.argv[2:]
acceptance = json.loads((backup / 'acceptance.json').read_text())
if not (acceptance.get('release') == release and acceptance.get('treeSha256') == tree_hash
        and acceptance.get('npmTestPassed') is True and acceptance.get('authenticatedMcpPassed') is True
        and re.fullmatch('[0-9a-f]{40}', acceptance.get('sourceCommit', ''))
        and re.fullmatch('[0-9a-f]{64}', acceptance.get('fixtureReceiptSha256', ''))):
    raise SystemExit('The owner acceptance receipt does not attest this tested candidate.')
config = json.loads((backup / 'config.json').read_text())
if config.get('release') != pathlib.Path(previous).name or (backup / 'release.env').read_text().strip() != 'PRAXIS_RELEASE=' + pathlib.Path(previous).name:
    raise SystemExit('Existing release/configuration disagree.')
canonical = 'https://mcp.jensenabler.com/praxis'
if config.get('issuer') != canonical + '/oauth' or config.get('resourceUrl') != canonical + '/mcp' or config.get('dataDirectory') != '/var/lib/praxis-code/live':
    raise SystemExit('Unexpected canonical configuration or private state path.')
config['release'] = release
(backup / 'config.next.json').write_text(json.dumps(config, indent=2) + '\n')
if (backup / 'git-config.json').exists():
    git_config = json.loads((backup / 'git-config.json').read_text())
    if (git_config.get('release') != pathlib.Path(previous).name
            or git_config.get('issuer') != canonical + '/oauth'
            or git_config.get('resourceUrl') != canonical + '/mcp'
            or git_config.get('dataDirectory') != '/var/lib/praxis-git'
            or git_config.get('port', 8793) != 8793):
        raise SystemExit('Unexpected protected Git broker identity or state path.')
    git_config['release'] = release
    (backup / 'git-config.next.json').write_text(json.dumps(git_config, indent=2) + '\n')
snippet = (backup / 'nginx-snippet').read_text()
proxy = '    proxy_pass http://127.0.0.1:8790;'
if snippet.count(proxy) != 4 or snippet.count('proxy_pass') != 4 or 'allow 127.0.0.1;' in snippet:
    raise SystemExit('Expected exactly four ungated canonical proxy locations.')
gate = '    allow 127.0.0.1;\n    allow ::1;\n    deny all;\n'
(backup / 'nginx-snippet.gated').write_text(snippet.replace(proxy, gate + proxy))
PREPARE

# The helper is trusted updater code, not code loaded from the candidate.
# Receipts contain hashes/counts/column names only, never stored row contents.
cat > "$backup/state-helper.py" <<'STATE_HELPER'
import base64, contextlib, grp, hashlib, json, pathlib, pwd, signal, sqlite3, stat, subprocess, sys

DATABASES = {
    'coding': ('/var/lib/praxis-code/live/coding.sqlite', 'praxis-code', ('workspaces', 'operations', 'code_jobs', 'code_records', 'code_artifacts')),
    'probe': ('/var/lib/praxis-probe/probe.sqlite', 'praxis-probe', ('jobs', 'records')),
    'git': ('/var/lib/praxis-git/git.sqlite', 'praxis-git', ('git_operations',)),
}
OPTIONAL_DATABASES = {'git'}

def table_fingerprint(db, table, columns=None):
    quote = lambda text: '"' + text.replace('"', '""') + '"'
    available = [row[1] for row in db.execute('PRAGMA table_info(' + quote(table) + ')')]
    if not available or (columns is not None and not set(columns).issubset(available)):
        raise RuntimeError('A preserved table or original column is missing.')
    columns = available if columns is None else columns
    rows = []
    for row in db.execute('SELECT ' + ','.join(map(quote, columns)) + ' FROM ' + quote(table)):
        values = [['blob', base64.b64encode(value).decode('ascii')] if isinstance(value, bytes)
                  else [type(value).__name__, value] for value in row]
        rows.append(json.dumps(values, ensure_ascii=True, separators=(',', ':')).encode('ascii'))
    digest = hashlib.sha256()
    for row in sorted(rows):
        digest.update(str(len(row)).encode('ascii') + b':' + row)
    return dict(columns=columns, rows=len(rows), sha256=digest.hexdigest())

def private_file(path, owner, sidecars=False):
    path = pathlib.Path(path)
    uid, gid = pwd.getpwnam(owner).pw_uid, grp.getgrnam(owner).gr_gid
    for item in [path] + ([pathlib.Path(str(path) + suffix) for suffix in ('-wal', '-shm')] if sidecars else []):
        info = item.lstat()
        if not stat.S_ISREG(info.st_mode) or (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (uid, gid, 0o600):
            raise RuntimeError('Expected an existing private database and correctly owned WAL sidecars.')
    info = path.stat()
    return dict(device=info.st_dev, inode=info.st_ino, uid=info.st_uid, gid=info.st_gid, mode=stat.S_IMODE(info.st_mode))

def credential_fingerprint():
    root = pathlib.Path('/etc/praxis-probe/credentials')
    if not root.is_dir() or root.is_symlink():
        raise RuntimeError('Expected the protected credential directory.')
    rows = []
    for path in sorted(root.rglob('*')):
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode):
            continue
        if not stat.S_ISREG(info.st_mode):
            raise RuntimeError('Unexpected credential filesystem entry.')
        rows.append([path.relative_to(root).as_posix(), info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode), hashlib.sha256(path.read_bytes()).hexdigest()])
    return hashlib.sha256(json.dumps(rows, separators=(',', ':')).encode()).hexdigest()

def git_credential_fingerprint():
    root = pathlib.Path('/var/lib/praxis-git/home/.ssh')
    if not root.exists():
        if pathlib.Path('/etc/praxis-git/config.json').exists():
            raise RuntimeError('Configured Git broker has no protected credential directory.')
        return None
    info = root.lstat()
    if (not stat.S_ISDIR(info.st_mode) or root.is_symlink()
            or info.st_uid != pwd.getpwnam('praxis-git').pw_uid or stat.S_IMODE(info.st_mode) != 0o700):
        raise RuntimeError('Expected the private Git credential directory.')
    rows = []
    for path in sorted(root.rglob('*')):
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode):
            continue
        if not stat.S_ISREG(info.st_mode):
            raise RuntimeError('Unexpected Git credential filesystem entry.')
        rows.append([path.relative_to(root).as_posix(), info.st_uid, info.st_gid,
                     stat.S_IMODE(info.st_mode), hashlib.sha256(path.read_bytes()).hexdigest()])
    return hashlib.sha256(json.dumps(rows, separators=(',', ':')).encode()).hexdigest()

def existing_tables(db):
    return {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}

def pending_code_git_requests(db):
    if 'code_git_requests' not in existing_tables(db):
        return 0
    count = 0
    for receipt_json, integrated, kind in db.execute('SELECT receipt_json, integrated, kind FROM code_git_requests'):
        receipt = json.loads(receipt_json)
        status = receipt.get('status')
        if status not in ('completed', 'failed') or (status == 'completed' and not integrated and kind in ('sync', 'commit')):
            count += 1
    return count

def state_snapshot(original=None):
    result = {'databases': {}, 'credentialSha256': credential_fingerprint(),
              'gitCredentialSha256': git_credential_fingerprint(),
              'oauthDatabase': private_file('/var/lib/praxis-probe/oauth/auth.sqlite', 'praxis-probe')}
    for name, (filename, owner, tables) in DATABASES.items():
        path = pathlib.Path(filename)
        if path.is_symlink():
            raise RuntimeError('A registered database path is a symlink.')
        if name in OPTIONAL_DATABASES and not path.exists():
            if original and name in original['databases']:
                raise RuntimeError('An existing optional database disappeared.')
            continue
        identity = private_file(path, owner, sidecars=True)
        with contextlib.closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=5)) as db:
            if db.execute('PRAGMA journal_mode').fetchone()[0] != 'wal':
                raise RuntimeError('Expected the existing WAL database.')
            db.execute('BEGIN')
            available = existing_tables(db)
            if not set(tables).issubset(available):
                raise RuntimeError('A required preserved database table is missing.')
            if original is not None and name in OPTIONAL_DATABASES and name not in original['databases']:
                # First Git-enabled startup may create only an empty operation
                # store. No publication/deployment is allowed during activation.
                if any(db.execute('SELECT COUNT(*) FROM "' + table.replace('"', '""') + '"').fetchone()[0] for table in available):
                    raise RuntimeError('A newly created optional database contains unexpected operation data.')
                continue
            preserved = original['databases'][name]['tables'] if original else {
                table: None for table in sorted(available - {'code_runner_lock', 'worker_lock'})}
            fingerprints = {table: table_fingerprint(db, table, preserved[table]['columns'] if original else None) for table in preserved}
        result['databases'][name] = dict(identity=identity, tables=fingerprints)
    return result

def stop_idle_services(before_path):
    coding_path = pathlib.Path(DATABASES['coding'][0])
    # Existing sidecars are verified before root opens a writable connection.
    private_file(coding_path, 'praxis-code', sidecars=True)
    interrupted = []
    for name in (signal.SIGINT, signal.SIGTERM):
        signal.signal(name, lambda number, frame: interrupted.append(number))
    db = sqlite3.connect(coding_path.as_uri() + '?mode=rw', uri=True, timeout=5, isolation_level=None)
    git_db = None
    try:
        if db.execute('PRAGMA journal_mode').fetchone()[0] != 'wal':
            raise RuntimeError('Expected the existing WAL database.')
        db.execute('BEGIN IMMEDIATE')
        jobs = db.execute("SELECT COUNT(*) FROM code_jobs WHERE status IN ('queued','starting','running','canceling')").fetchone()[0]
        operations = db.execute("SELECT COUNT(*) FROM operations WHERE status='prepared'").fetchone()[0]
        pending_git = pending_code_git_requests(db)
        git_jobs = 0
        git_path = pathlib.Path(DATABASES['git'][0]) if 'git' in DATABASES else None
        if git_path is not None and git_path.exists():
            private_file(git_path, 'praxis-git', sidecars=True)
            git_db = sqlite3.connect(git_path.as_uri() + '?mode=rw', uri=True, timeout=5, isolation_level=None)
            if git_db.execute('PRAGMA journal_mode').fetchone()[0] != 'wal':
                raise RuntimeError('Expected the existing Git WAL database.')
            git_db.execute('BEGIN IMMEDIATE')
            git_jobs = git_db.execute("SELECT COUNT(*) FROM git_operations WHERE status IN ('queued','running','uncertain')").fetchone()[0]
        probe = pathlib.Path(DATABASES['probe'][0])
        private_file(probe, 'praxis-probe', sidecars=True)
        with contextlib.closing(sqlite3.connect(probe.as_uri() + '?mode=ro', uri=True, timeout=5)) as probe_db:
            probe_jobs = probe_db.execute("SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')").fetchone()[0]
        if jobs or operations or probe_jobs or pending_git or git_jobs:
            raise RuntimeError(f'Update rejected: {jobs} active coding jobs, {operations} prepared operations, {probe_jobs} active probe jobs, {pending_git} pending coding Git requests, {git_jobs} unfinished broker operations. Recover existing work first.')
        before_path.write_text(json.dumps(state_snapshot(), indent=2) + '\n')
        if interrupted:
            raise SystemExit(128 + interrupted[-1])
        # Hold admission reservation through normal shutdown, including signals.
        # No job is active, and the stopped gateway cannot enqueue probe work.
        units = (['praxis-git.service'] if git_db is not None else []) + ['praxis-code.service', 'praxis-probe-worker.service']
        for unit in units:
            subprocess.run(['systemctl', 'stop', unit], check=True, start_new_session=True)
            state = subprocess.check_output(['systemctl', 'show', unit, '-p', 'ActiveState', '--value'], text=True, start_new_session=True).strip()
            if state != 'inactive':
                raise RuntimeError('Service shutdown did not reach inactive state.')
    finally:
        if git_db is not None:
            if git_db.in_transaction:
                git_db.rollback()
            git_db.close()
        if db.in_transaction:
            db.rollback()
        db.close()
    if interrupted:
        raise SystemExit(128 + interrupted[-1])

if __name__ == '__main__':
    mode, before_path = sys.argv[1], pathlib.Path(sys.argv[2])
    if mode == 'stop-idle':
        stop_idle_services(before_path)
        print('Queues and mutation intents idle; coding, heartbeat, and any existing Git broker stopped under admission reservation.')
    elif mode == 'verify':
        before = json.loads(before_path.read_text())
        after = state_snapshot(before)
        pathlib.Path(sys.argv[3]).write_text(json.dumps(after, indent=2) + '\n')
        if before != after:
            raise SystemExit('Preserved state changed while ingress was gated; reopening refused. Database rollback is prohibited.')
        print('Original job, workspace, receipt, record, artifact, credential and database identity evidence matches.')
    else:
        raise SystemExit('Unknown state-helper mode.')
STATE_HELPER

cat > "$backup/nginx-drain.py" <<'NGINX_DRAIN'
import json, pathlib, subprocess, sys, time

def identity(pid):
    try:
        # Fields after the final parenthesis start at state (field 3).
        return pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()[19]
    except FileNotFoundError:
        return None

mode, path = sys.argv[1], pathlib.Path(sys.argv[2])
if mode == 'capture':
    master = int(subprocess.check_output(['systemctl', 'show', 'nginx.service', '-p', 'MainPID', '--value'], text=True).strip())
    if master <= 1 or identity(master) is None:
        raise SystemExit('Expected the existing nginx master.')
    children = pathlib.Path(f'/proc/{master}/task/{master}/children').read_text().split()
    workers = []
    for child in children:
        try:
            command = pathlib.Path(f'/proc/{child}/cmdline').read_bytes()
            started = identity(child)
            if command.startswith(b'nginx: worker process') and started is not None:
                workers.append(dict(pid=int(child), started=started))
        except FileNotFoundError:
            pass
    if not workers:
        raise SystemExit('Could not identify existing nginx workers; activation refused.')
    path.write_text(json.dumps(dict(master=master, masterStarted=identity(master), workers=workers)) + '\n')
elif mode == 'wait':
    prior = json.loads(path.read_text())
    deadline = time.monotonic() + 30
    while True:
        if identity(prior['master']) != prior['masterStarted']:
            raise SystemExit('The nginx master changed unexpectedly; activation refused.')
        remaining = [worker for worker in prior['workers'] if identity(worker['pid']) == worker['started']]
        if not remaining:
            print('Previous nginx workers exited naturally; no ungated worker can reach the candidate.')
            break
        if time.monotonic() >= deadline:
            raise SystemExit('Previous nginx workers still have connections after 30 seconds; candidate not started. No nginx workers were killed.')
        time.sleep(0.2)
else:
    raise SystemExit('Unknown nginx drain mode.')
NGINX_DRAIN

restore() {
  cp -a -- "$backup/$1" "$2.restore.$$"
  mv -Tf -- "$2.restore.$$" "$2"
}
install_gate() {
  install -o root -g root -m 0644 "$backup/nginx-snippet.gated" "$snippet.next.$$"
  mv -Tf -- "$snippet.next.$$" "$snippet"
  nginx -t
  systemctl reload nginx
}
gateway_stopped=0
workers_touched=0
touched=0
candidate_started=0
committed=0
finish() {
  result=$?
  trap - EXIT INT TERM
  set +e
  if [[ $committed == 0 && $gateway_stopped == 1 ]]; then
    rollback_ok=1
    if [[ $touched == 1 ]]; then
      # Once a candidate starts, the prior workers are proven drained and the
      # public gate stays installed until the old services and state pass.
      if [[ $candidate_started == 1 ]]; then install_gate || rollback_ok=0; fi
      systemctl stop praxis-probe.service praxis-code.service praxis-probe-worker.service || rollback_ok=0
      if [[ $git_enabled == 1 ]]; then systemctl stop praxis-git.service || rollback_ok=0; fi
      restore config.json "$config" || rollback_ok=0
      if [[ $git_enabled == 1 ]]; then restore git-config.json "$git_config" || rollback_ok=0; fi
      restore release.env "$release_env" || rollback_ok=0
      restore current "$root/current" || rollback_ok=0
      if [[ $candidate_started == 0 && $rollback_ok == 1 ]]; then
        # Drain refusal happens before candidate startup. Restore old ingress
        # before old services restart; later legitimate work must not be stopped
        # or mistaken for candidate effects by a post-restart equality check.
        restore nginx-snippet "$snippet" && nginx -t && systemctl reload nginx || rollback_ok=0
      fi
    fi
    if [[ $workers_touched == 1 && $rollback_ok == 1 ]]; then
      if [[ $git_previous_active == 1 ]]; then systemctl start praxis-git.service || rollback_ok=0; fi
      systemctl start praxis-code.service praxis-probe-worker.service || rollback_ok=0
    fi
    if [[ $rollback_ok == 1 ]]; then systemctl start praxis-probe.service || rollback_ok=0; fi
    if [[ $candidate_started == 1 && $rollback_ok == 1 ]]; then
      sleep 2
      curl --noproxy '*' --resolve mcp.jensenabler.com:443:127.0.0.1 -fsS --max-time 5 https://mcp.jensenabler.com/praxis/healthz > "$backup/rollback-gateway-health.json" || rollback_ok=0
      curl -fsS --max-time 5 http://127.0.0.1:8792/healthz > "$backup/rollback-coding-health.json" || rollback_ok=0
      if [[ $git_previous_active == 1 ]]; then curl -fsS --max-time 5 http://127.0.0.1:8793/healthz > "$backup/rollback-git-health.json" || rollback_ok=0; fi
      python3 - "$backup" "$(basename -- "$previous")" "$git_previous_active" <<'ROLLBACK_HEALTH' || rollback_ok=0
import json, pathlib, sys
base = pathlib.Path(sys.argv[1])
names = ['rollback-gateway-health.json', 'rollback-coding-health.json']
if sys.argv[3] == '1':
    names.append('rollback-git-health.json')
for name in names:
    health = json.loads((base / name).read_text())
    assert health.get('ok') is True and health.get('release') == sys.argv[2]
ROLLBACK_HEALTH
      python3 "$backup/state-helper.py" verify "$backup/state-before.json" "$backup/state-rollback.json" || rollback_ok=0
      if [[ $rollback_ok == 1 ]]; then
        restore nginx-snippet "$snippet" && nginx -t && systemctl reload nginx || rollback_ok=0
      fi
    fi
    if [[ $rollback_ok == 1 ]]; then
      echo "Update did not commit; previous services restored. No database restored. Backup: $backup" >&2
    else
      echo "Rollback needs owner inspection; keep ingress gated. No database restored. Backup: $backup" >&2
    fi
  elif [[ $committed == 1 && $result != 0 ]]; then
    echo "Release committed; inspect nginx state without stopping possibly accepted work. Automatic rollback is prohibited. Backup: $backup" >&2
  fi
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

gateway_stopped=1
systemctl stop praxis-probe.service
[[ $(systemctl show praxis-probe.service -p ActiveState --value) == inactive ]]
workers_touched=1
python3 "$backup/state-helper.py" stop-idle "$backup/state-before.json"
touched=1
python3 "$backup/nginx-drain.py" capture "$backup/nginx-workers-before.json"
install_gate
python3 "$backup/nginx-drain.py" wait "$backup/nginx-workers-before.json"
install -o root -g praxis-code -m 0640 "$backup/config.next.json" "$config.next.$$"
mv -Tf -- "$config.next.$$" "$config"
if [[ $git_enabled == 1 ]]; then
  install -o root -g praxis-git -m 0640 "$backup/git-config.next.json" "$git_config.next.$$"
  mv -Tf -- "$git_config.next.$$" "$git_config"
fi
printf 'PRAXIS_RELEASE=%s\n' "$release" > "$release_env.next.$$"
chmod 0644 "$release_env.next.$$"
mv -Tf -- "$release_env.next.$$" "$release_env"
ln -s -- "$candidate" "$root/current.next.$$"
mv -Tf -- "$root/current.next.$$" "$root/current"
candidate_started=1
# Apply previously reviewed bootstrap unit/drop-in files while admission is
# reserved. This does not install or modify any service definitions.
systemctl daemon-reload
if [[ $git_enabled == 1 ]]; then systemctl start praxis-git.service; fi
systemctl start praxis-code.service praxis-probe-worker.service praxis-probe.service
public_curl=(curl --noproxy '*' --resolve mcp.jensenabler.com:443:127.0.0.1 --connect-timeout 3 --max-time 5 -fsS)
healthy=0
for attempt in $(seq 1 20); do
  if "${public_curl[@]}" https://mcp.jensenabler.com/praxis/healthz > "$backup/gateway-health.json" &&
    curl -fsS --max-time 2 http://127.0.0.1:8792/healthz > "$backup/coding-health.json"; then
    if [[ $git_enabled == 0 ]] || curl -fsS --max-time 2 http://127.0.0.1:8793/healthz > "$backup/git-health.json"; then healthy=1; break; fi
  fi
  sleep 1
done
[[ $healthy == 1 ]]
"${public_curl[@]}" https://mcp.jensenabler.com/.well-known/oauth-protected-resource/praxis/mcp > "$backup/resource.json"
"${public_curl[@]}" https://mcp.jensenabler.com/.well-known/oauth-authorization-server/praxis/oauth > "$backup/issuer.json"
status=$(curl --noproxy '*' --resolve mcp.jensenabler.com:443:127.0.0.1 --max-time 5 -sS -D "$backup/unauthorized.headers" -o "$backup/unauthorized.json" -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data '{}' https://mcp.jensenabler.com/praxis/mcp)
[[ $status == 401 ]]
old_status=$(curl --noproxy '*' --resolve mcp.jensenabler.com:443:127.0.0.1 --max-time 5 -sS -o "$backup/old-endpoint.json" -w '%{http_code}' -X POST https://mcp.jensenabler.com/praxis-probe/mcp)
[[ $old_status == 410 ]]
python3 - "$backup" "$release" <<'VERIFY_HEALTH'
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
old_config, new_config = read('config.json'), json.loads(pathlib.Path('/etc/praxis-code/config.json').read_text())
old_config['release'] = sys.argv[2]
assert old_config == new_config
if (base / 'git-config.json').exists():
    git_health = read('git-health.json')
    assert git_health.get('ok') is True and git_health.get('release') == sys.argv[2]
    old_git = read('git-config.json')
    old_git['release'] = sys.argv[2]
    assert old_git == json.loads(pathlib.Path('/etc/praxis-git/config.json').read_text())
print('Canonical HTTPS health, release, OAuth metadata, scope, 401, 410, and configuration preservation passed.')
VERIFY_HEALTH
for unit in praxis-probe.service praxis-code.service praxis-probe-worker.service; do systemctl is-active --quiet "$unit"; done
if [[ $git_enabled == 1 ]]; then systemctl is-active --quiet praxis-git.service; fi
python3 "$backup/state-helper.py" verify "$backup/state-before.json" "$backup/state-after.json"
[[ $(tree_hash "$candidate") == "$source_hash" ]]
python3 - "$backup" "$release" "$(basename -- "$previous")" "$git_enabled" "$git_previous_active" <<'RECEIPT'
import datetime, hashlib, json, pathlib, sys
base = pathlib.Path(sys.argv[1])
acceptance = json.loads((base / 'acceptance.json').read_text())
receipt = dict(schemaVersion=1, kind='manual-coding-release-update', stage='verified-before-reopening',
    release=sys.argv[2], previousRelease=sys.argv[3], sourceCommit=acceptance['sourceCommit'], treeSha256=acceptance['treeSha256'],
    fixtureReceiptSha256=acceptance['fixtureReceiptSha256'], npmTestPassed=True, authenticatedMcpPassed=True,
    verifiedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
    canonicalEndpoint='https://mcp.jensenabler.com/praxis/mcp', canonicalIssuer='https://mcp.jensenabler.com/praxis/oauth',
    coreStatePreserved=True, credentialsPreserved=True, databaseIdentitiesPreserved=True, additiveTablesAllowed=True,
    noDatabaseRestore=True, noJobsStartedOrRerun=True, noProjectOrImageChanges=True,
    gitBrokerEnabled=sys.argv[4] == '1', gitBrokerPreviouslyActive=sys.argv[5] == '1',
    stateBeforeSha256=hashlib.sha256((base / 'state-before.json').read_bytes()).hexdigest(),
    stateAfterSha256=hashlib.sha256((base / 'state-after.json').read_bytes()).hexdigest())
(base / 'update-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
RECEIPT

# Restore exactly the existing nginx bytes. No endpoint/site/drop-in changes.
restore nginx-snippet "$snippet"
nginx -t
# Commit immediately before the reload can admit work. Never rollback after this.
committed=1
systemctl reload nginx
python3 - "$backup/update-receipt.json" <<'COMMITTED'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
receipt = json.loads(path.read_text())
receipt.update(stage='committed', ingressReopened=True)
path.write_text(json.dumps(receipt, indent=2) + '\n')
COMMITTED
printf 'Praxis release updated: %s\nExisting jobs/workspaces and canonical OAuth preserved.\nSanitized receipt: %s/update-receipt.json\n' "$release" "$backup"
