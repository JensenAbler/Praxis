#!/usr/bin/env bash
# Trusted host setup only. Does not restart coding or touch production services.
set -euo pipefail
umask 077
[[ $(id -u) == 0 ]] || { echo 'Run as root from the reviewed release.' >&2; exit 1; }
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
getent passwd praxis-code >/dev/null
getent group praxis-source >/dev/null
if ! getent passwd praxis-dependencies >/dev/null; then
  useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --gid praxis-code praxis-dependencies
fi
[[ $(id -u praxis-dependencies) != 0 && $(id -u praxis-dependencies) != $(id -u praxis-code) ]]
for path in /usr/local/lib/praxis /srv/praxis-git-exchange /srv/praxis-git-exchange/dependencies; do
  [[ ! -L $path ]] || { echo 'Refusing linked registry/export setup path' >&2; exit 1; }
done
install -d -o root -g root -m 0755 /usr/local/lib/praxis
install -d -o praxis-code -g praxis-source -m 2750 /srv/praxis-git-exchange/dependencies
install -o root -g root -m 0644 "$script_dir/registry-proxy.py" /usr/local/lib/praxis/registry-proxy.py
install -o root -g root -m 0644 "$script_dir/registry-relay.mjs" /usr/local/lib/praxis/registry-relay.mjs
install -o root -g root -m 0644 "$script_dir/praxis-dependencies.service" /etc/systemd/system/praxis-dependencies.service
install -d -o root -g root -m 0755 /etc/systemd/system/praxis-code.service.d
printf '[Service]\nReadWritePaths=/srv/praxis-git-exchange/dependencies\n' > /etc/systemd/system/praxis-code.service.d/dependencies.conf
chmod 0644 /etc/systemd/system/praxis-code.service.d/dependencies.conf
systemd-analyze verify /etc/systemd/system/praxis-dependencies.service
systemctl daemon-reload
systemctl enable --now praxis-dependencies.service
python3 - <<'PY'
import json, os, stat, tempfile
path = '/etc/praxis-code/config.json'
st = os.lstat(path)
if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_nlink != 1:
    raise SystemExit('Unsafe coding configuration')
with open(path) as source:
    config = json.load(source)
config['dependencyDirectory'] = '/srv/praxis-git-exchange/dependencies'
config['runnerConfig']['dependencyProxySocket'] = '/run/praxis-dependencies/proxy.sock'
config['runnerConfig']['dependencyRelayPath'] = '/usr/local/lib/praxis/registry-relay.mjs'
fd, pending = tempfile.mkstemp(prefix='dependencies-', dir='/etc/praxis-code')
with os.fdopen(fd, 'w') as target:
    json.dump(config, target, indent=2)
    target.write('\n')
    target.flush()
    os.fchmod(target.fileno(), stat.S_IMODE(st.st_mode))
    os.fchown(target.fileno(), st.st_uid, st.st_gid)
    os.fsync(target.fileno())
os.replace(pending, path)
fd = os.open('/etc/praxis-code', os.O_RDONLY)
os.fsync(fd)
os.close(fd)
print(json.dumps({'configured': True, 'codingRestarted': False, 'network': 'registry CONNECT over Unix socket only'}))
PY
