#!/usr/bin/env bash
# Run as root from a reviewed release. This prepares the isolated executor;
# it never starts the coding backend or changes nginx/other application services.
set -euo pipefail
umask 077
[[ $(id -u) == 0 ]] || { echo 'Run this bootstrap as root.' >&2; exit 1; }
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
account=praxis-code
disk_dir=/var/lib/praxis-code-disk
disk_image=$disk_dir/storage.ext4
storage=/srv/praxis-code/storage
metadata=/var/lib/praxis-code
config_dir=/etc/praxis-code
runtime=/run/praxis-code
disk_bytes=8589934592
mount_unit='srv-praxis\x2dcode-storage.mount'
stamp=$(date -u +%Y%m%dT%H%M%SZ)

die() { echo "Bootstrap refused: $*" >&2; exit 1; }
fixed_directory() {
  local path=$1 parent
  [[ $path == /* && $path != / && ! -L $path ]] || die "unsafe directory: $path"
  parent=$(dirname -- "$path")
  [[ $(realpath -e -- "$parent") == "$parent" ]] || die "noncanonical parent: $path"
  if [[ -e $path ]]; then [[ -d $path ]] || die "not a directory: $path"; fi
  install -d -o root -g root -m 0755 -- "$path"
}
install_protected() {
  local source=$1 target=$2 mode=$3 group=${4:-root}
  [[ ! -L $target ]] || die "symlink target: $target"
  if [[ -e $target ]] && ! cmp -s -- "$source" "$target"; then
    cp --preserve=mode,ownership,timestamps -- "$target" "$disk_dir/backups/$(basename -- "$target").$stamp"
  fi
  install -o root -g "$group" -m "$mode" -- "$source" "$target"
}

[[ -f $script_dir/praxis-code.service && -f $script_dir/Containerfile.executor ]] || die 'reviewed deployment files missing'
if ss -lntH 'sport = :8792' | grep -q .; then die 'coding port 8792 is already occupied'; fi
if systemctl is-active --quiet praxis-code.service; then die 'coding service is already active; this is bootstrap, not deployment'; fi
for path in "$disk_dir" /srv/praxis-code "$metadata" "$config_dir"; do fixed_directory "$path"; done
chmod 0700 "$disk_dir"
install -d -o root -g root -m 0700 "$disk_dir/backups"

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
apt-get update
apt-get install -y --no-install-recommends podman uidmap fuse-overlayfs crun
if ! getent passwd "$account" >/dev/null; then
  useradd --system --user-group --home-dir "$metadata" --no-create-home --shell /usr/sbin/nologin "$account"
fi
[[ $(getent passwd "$account" | cut -d: -f6) == "$metadata" ]] || die 'unexpected existing account home'
[[ $(id -u "$account") != $(id -u praxis-probe) ]] || die 'coding and OAuth identities overlap'
[[ $(id -Gn "$account") == "$account" ]] || die 'unexpected coding supplementary groups'
code_uid=$(id -u "$account")
code_gid=$(id -g "$account")
cp --preserve=mode,ownership,timestamps /etc/subuid "$disk_dir/backups/subuid.$stamp"
cp --preserve=mode,ownership,timestamps /etc/subgid "$disk_dir/backups/subgid.$stamp"
# Pick one 65536-ID interval unused in BOTH maps. Existing allocations are
# preserved and checked rather than silently replaced.
subid=$(python3 - "$account" <<'PY'
import sys
name=sys.argv[1]
maps=[]
for path in ('/etc/subuid','/etc/subgid'):
    rows=[]
    for line in open(path):
        if line.strip():
            owner,start,count=line.strip().split(':')
            rows.append((owner,int(start),int(count)))
    maps.append(rows)
own=[[row for row in rows if row[0] == name] for rows in maps]
if any(own):
    if any(len(rows)!=1 for rows in own) or own[0][0][1:] != own[1][0][1:] or own[0][0][2] != 65536:
        raise SystemExit('Existing coding sub-ID allocations need review')
    candidate=own[0][0][1]
else:
    candidate=100000
    while any(candidate < start+count and start < candidate+65536 for rows in maps for _,start,count in rows):
        candidate+=65536
    if candidate+65536 > 4294967294:
        raise SystemExit('No bounded sub-ID allocation available')
if any(owner!=name and candidate < start+count and start < candidate+65536 for rows in maps for owner,start,count in rows):
    raise SystemExit('Coding sub-ID allocation overlaps another account')
print(candidate)
PY
)
if ! grep -q "^$account:" /etc/subuid; then usermod --add-subuids "$subid-$((subid + 65535))" "$account"; fi
if ! grep -q "^$account:" /etc/subgid; then usermod --add-subgids "$subid-$((subid + 65535))" "$account"; fi

[[ ! -L $disk_image ]] || die 'disk image is a symlink'
if [[ ! -e $disk_image ]]; then
  available=$(df --output=avail -B1 "$disk_dir" | tail -1 | tr -d ' ')
  (( available > disk_bytes + 2147483648 )) || die 'insufficient free disk for hard allocation and reserve'
  # Exclusive creation is essential: mkfs is permitted only on this exact NEW
  # regular file. A failed partial creation is retained for explicit inspection.
  ( set -o noclobber; : > "$disk_image" ) || die 'disk image appeared during creation'
  chmod 0600 "$disk_image"
  fallocate -l "$disk_bytes" "$disk_image"
  [[ -f $disk_image && ! -L $disk_image && $(stat -c %s "$disk_image") == "$disk_bytes" ]] || die 'new disk image validation failed'
  mkfs.ext4 -q -F -m 0 -L PRAXIS_CODE "$disk_image"
else
  [[ -f $disk_image && $(stat -c %s "$disk_image") == "$disk_bytes" ]] || die 'unexpected existing disk image'
  [[ $(blkid -p -s TYPE -o value "$disk_image") == ext4 && $(blkid -p -s LABEL -o value "$disk_image") == PRAXIS_CODE ]] || die 'existing image is not the expected filesystem; never reformat it'
fi
chown root:root "$disk_image"
chmod 0600 "$disk_image"
fixed_directory "$storage"
mount_source=$(mktemp "$disk_dir/mount-unit.XXXXXX")
cat > "$mount_source" <<EOF
[Unit]
Description=Hard-bounded Praxis coding storage
Before=praxis-code.service

[Mount]
What=$disk_image
Where=$storage
Type=ext4
Options=loop,nodev,nosuid
TimeoutSec=30

[Install]
WantedBy=multi-user.target
EOF
install_protected "$mount_source" "/etc/systemd/system/$mount_unit" 0644
rm -- "$mount_source"
if mountpoint -q "$storage"; then
  loop_device=$(findmnt -n -o SOURCE --target "$storage")
  [[ $(losetup -n -O BACK-FILE "$loop_device") == "$disk_image" ]] || die 'mountpoint uses an unrelated device'
fi
systemctl daemon-reload
systemctl enable --now "$mount_unit"
[[ $(findmnt -n -o FSTYPE --target "$storage") == ext4 ]] || die 'storage mount failed'
chmod 0755 "$storage"
chown root:root "$storage"
for path in "$storage/workspaces" "$storage/containers" "$storage/container-logs" "$storage/build-tmp"; do
  [[ ! -L $path ]] || die "symlink storage directory: $path"
  install -d -o "$account" -g "$account" -m 0700 "$path"
done
chown "$account:$account" "$metadata"
chmod 0700 "$metadata"
chown "root:$account" "$config_dir"
chmod 0750 "$config_dir"
install -d -o "$account" -g "$account" -m 0700 "$runtime"
storage_conf=$(mktemp "$disk_dir/storage-conf.XXXXXX")
cat > "$storage_conf" <<EOF
[storage]
driver = "overlay"
runroot = "$runtime/storage"
graphroot = "$storage/containers"
[storage.options.overlay]
mount_program = "/usr/bin/fuse-overlayfs"
EOF
install_protected "$storage_conf" "$config_dir/storage.conf" 0640 "$account"
rm -- "$storage_conf"
install_protected "$script_dir/praxis-code.service" /etc/systemd/system/praxis-code.service 0644
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/praxis-code.service "/etc/systemd/system/$mount_unit"
cd "$storage"
# Podman 4.9 rootless mode can read storage.conf yet replace graphroot/runroot
# with HOME defaults. Select both explicitly and verify before writing layers.
actual_store=$(runuser -u "$account" -- env -i PATH=/usr/bin:/bin HOME="$metadata" XDG_RUNTIME_DIR="$runtime" CONTAINERS_STORAGE_CONF="$config_dir/storage.conf" \
  podman --events-backend=none --cgroup-manager=cgroupfs --runtime=/usr/bin/crun --root="$storage/containers" --runroot="$runtime/storage" \
  info --format '{{.Store.GraphRoot}} {{.Store.RunRoot}}')
[[ $actual_store == "$storage/containers $runtime/storage" ]] || die 'runtime selected storage outside the hard cap'

# The build is the only executor operation allowed external network access.
# It is rootless and bounded too; all downloaded layers and temporary files
# share the same hard-sized filesystem as later workspaces.
build_context=$storage/build-context
[[ ! -L $build_context ]] || die 'build context is a symlink'
install -d -o root -g "$account" -m 0750 "$build_context"
install -o root -g "$account" -m 0640 "$script_dir/Containerfile.executor" "$build_context/Containerfile"
systemd-run --unit="praxis-code-image-build-$stamp" --wait --pipe --collect \
  --property="User=$account" --property="Group=$account" --property="WorkingDirectory=$storage" \
  --property=MemoryMax=1536M --property=MemorySwapMax=0 --property=CPUQuota=100% --property=TasksMax=256 \
  --property=KillMode=control-group --property=OOMPolicy=kill --property=RuntimeMaxSec=900 \
  --setenv="HOME=$metadata" --setenv="XDG_RUNTIME_DIR=$runtime" \
  --setenv="CONTAINERS_STORAGE_CONF=$config_dir/storage.conf" --setenv="TMPDIR=$storage/build-tmp" \
  /usr/bin/podman --events-backend=none --cgroup-manager=cgroupfs --runtime=/usr/bin/crun \
  --root="$storage/containers" --runroot="$runtime/storage" build \
  --isolation=chroot --format=oci --layers=false --pull=missing \
  --build-arg NODE_BASE=docker.io/library/node:22-bookworm-slim \
  --tag localhost/praxis-executor:bootstrap --file "$build_context/Containerfile" "$build_context"
image_id=$(runuser -u "$account" -- env -i PATH=/usr/bin:/bin HOME="$metadata" XDG_RUNTIME_DIR="$runtime" CONTAINERS_STORAGE_CONF="$config_dir/storage.conf" \
  podman --events-backend=none --cgroup-manager=cgroupfs --runtime=/usr/bin/crun --root="$storage/containers" --runroot="$runtime/storage" \
  image inspect localhost/praxis-executor:bootstrap --format '{{.Id}}')
[[ $image_id =~ ^[0-9a-f]{64}$ ]] || die 'build did not return an immutable image ID'
printf '{"prepared":true,"serviceStarted":false,"image":"sha256:%s","uid":%s,"gid":%s,"subIdStart":%s,"diskBytes":%s}\n' "$image_id" "$code_uid" "$code_gid" "$subid" "$disk_bytes"
