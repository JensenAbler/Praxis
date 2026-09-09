#!/usr/bin/env bash
# Owner qualification only; this never changes live services or configuration.
# Usage: qualify-autonomy.sh ROOT_OWNED_GIT_ARCHIVE EXPECTED_COMMIT
# Produce the archive with: git archive --format=tar COMMIT > source.tar
# Output: /srv/praxis-qualified/<unique-run>/{release,acceptance.json,evidence}
set -euo pipefail
exec /usr/bin/python3 - "$@" <<'QUALIFY_PYTHON'
import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import time
import uuid

MAX_BYTES = 1024 * 1024 * 1024
MAX_ENTRIES = 100000
BUILDER = 'praxis-probe-build'
MASKED = ('/etc/praxis-probe', '/var/lib/praxis-probe', '/etc/praxis-code', '/var/lib/praxis-code',
          '/etc/praxis-git', '/var/lib/praxis-git', '/etc/praxis-updater', '/var/lib/praxis-updater',
          '/etc/praxis-control', '/var/lib/praxis-control', '/etc/letsencrypt', '/srv/praxis-code',
          '/srv/praxis-git-exchange', '/srv/praxis-app', '/srv/praxis-control', '/srv/praxis-stage',
          '/srv/praxis-apps', '/srv/praxis-probe', '/srv/apocrypha', '/opt', '/run/user', '/run/docker.sock',
          '/run/podman', '/run/praxis-control', '/run/praxis-dependencies')


def require(value, message):
    if not value:
        raise RuntimeError(message)


def file_hash(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def safe_tree(root, allow_dependency_links=False):
    """Same receipt format as the protected updater, without importing it."""
    root = pathlib.Path(root)
    require(root.is_dir() and not root.is_symlink(), 'Expected an ordinary source tree.')
    entries, total = {}, 0
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root).as_posix()
        require(not any(part in ('.git', '.ssh') or part == '.env' or part.startswith('.env.')
                        for part in path.relative_to(root).parts), 'Release contains a protected path.')
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode):
            continue
        if stat.S_ISLNK(info.st_mode):
            require(allow_dependency_links and relative.startswith('node_modules/')
                    and path.resolve(strict=True).is_relative_to(root / 'node_modules'),
                    'Release link escapes its dependency tree.')
            entries[relative] = {'link': os.readlink(path)}
            continue
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'Release contains a special or hard-linked file.')
        total += info.st_size
        require(total <= MAX_BYTES and len(entries) < MAX_ENTRIES, 'Release exceeds bounded storage limits.')
        entries[relative] = {'sha256': file_hash(path), 'bytes': info.st_size,
                             'mode': '100755' if info.st_mode & 0o111 else '100644'}
    return entries


def artifact_hash(tree):
    return hashlib.sha256(json.dumps(tree, sort_keys=True).encode()).hexdigest()


def archive_entries(archive, commit):
    require(re.fullmatch('[0-9a-f]{40}', commit), 'Expected an exact lowercase Git commit.')
    require(archive.pax_headers.get('comment') == commit, 'Git archive commit differs from expected commit.')
    members, names, total = [], set(), 0
    for member in archive:
        name = member.name.rstrip('/')
        parts = pathlib.PurePosixPath(name).parts
        require(name and not name.startswith('/') and '\\' not in name and '\x00' not in name
                and all(part not in ('', '.', '..') for part in name.split('/')),
                'Archive path is not a canonical relative path.')
        require(not any(part in ('.git', '.ssh', 'node_modules') or part == '.env' or part.startswith('.env.')
                        for part in parts) and name != 'coding-tools.json', 'Archive contains a protected or generated path.')
        require(name not in names, 'Archive contains duplicate entries.')
        require(member.isdir() or member.isfile(), 'Archive contains a link or special entry.')
        require(not member.issparse() and member.mode & 0o7000 == 0, 'Archive contains sparse or privileged data.')
        require(member.size >= 0, 'Archive has a negative entry size.')
        names.add(name)
        total += member.size
        require(total <= MAX_BYTES and len(names) <= MAX_ENTRIES, 'Archive exceeds bounded storage limits.')
        members.append((name, member))
    files = {name for name, member in members if member.isfile()}
    require(all(not any(parent.as_posix() in files for parent in pathlib.PurePosixPath(name).parents)
                for name, _ in members), 'Archive path has a file as its parent.')
    needed = {'package.json', 'package-lock.json', 'scripts/export-tool-manifest.js',
              'scripts/release-candidate-check.js', 'src/code/server.js', 'deploy/registry-proxy.py',
              'deploy/registry-relay.mjs', 'deploy/praxis_updater_host.py', 'deploy/bootstrap-autonomy.py'}
    require(needed.issubset(files), 'Archive lacks required qualification entrypoints.')
    return members


def extract_archive(path, commit, destination):
    with tarfile.open(path, 'r:*') as archive:
        members = archive_entries(archive, commit)
        destination.mkdir(mode=0o755)
        for name, member in members:
            target = destination / name
            target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            if member.isdir():
                target.mkdir(mode=0o755, exist_ok=True)
                continue
            with archive.extractfile(member) as source, target.open('xb') as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)
            require(target.stat().st_size == member.size, 'Archive extraction length changed.')
            target.chmod(0o755 if member.mode & 0o111 else 0o644)


def protected(path, directory=False):
    path = pathlib.Path(path)
    require(path.is_absolute() and path.resolve(strict=True) == path, 'Expected a canonical protected path.')
    for item in [path, *path.parents]:
        info = item.lstat()
        require(info.st_uid == 0 and not info.st_mode & 0o022, 'Qualification input/storage must be root-owned and protected.')
        require(stat.S_ISDIR(info.st_mode) if item != path or directory else stat.S_ISREG(info.st_mode),
                'Qualification input/storage contains a link or special path.')


def own_tree(path, uid, gid):
    for item in [path, *path.rglob('*')]:
        if item.is_symlink():
            os.lchown(item, uid, gid)
        else:
            os.chown(item, uid, gid)
            item.chmod(0o755 if item.is_dir() or item.stat().st_mode & 0o111 else 0o644)


def atomic_json(path, value):
    temporary = path.with_name(path.name + '.next')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        json.dump(value, output, indent=2)
        output.write('\n')
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class Qualification:
    def __init__(self, archive, commit):
        import pwd
        self.archive, self.commit = pathlib.Path(archive), commit
        self.run_id = 'autonomy-' + commit[:12] + '-' + uuid.uuid4().hex[:12]
        self.stage = pathlib.Path('/srv/praxis-qualification') / self.run_id
        self.output = pathlib.Path('/srv/praxis-qualified') / self.run_id
        self.source = self.stage / 'source'
        self.checker = self.stage / 'checker'
        self.state = self.stage / 'state'
        self.logs = self.stage / 'logs'
        identity, nobody = pwd.getpwnam(BUILDER), pwd.getpwnam('nobody')
        self.uid, self.gid, self.proxy_uid = identity.pw_uid, identity.pw_gid, nobody.pw_uid
        require(self.uid != 0 and self.proxy_uid != 0, 'Qualification identities cannot be root.')
        require(set(os.getgrouplist(BUILDER, self.gid)) == {self.gid}, 'Build identity has unexpected supplementary groups.')
        self.units, self.results, self.mounted = [], {}, False

    @staticmethod
    def run(argv, timeout=30, check=True):
        result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout,
                                env={'PATH': '/usr/bin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'})
        if check:
            require(result.returncode == 0, 'Qualification host command failed: ' + pathlib.Path(argv[0]).name + ': ' + result.stderr[-1000:])
        return result

    def no_build_processes(self):
        result = self.run(['/usr/bin/pgrep', '-u', str(self.uid)], check=False)
        require(result.returncode == 1 and not result.stdout.strip(), 'Build identity has another process; qualification/sealing refused.')

    def stop_unit(self, unit):
        self.run(['/usr/bin/systemctl', 'stop', unit + '.service'], timeout=30, check=False)
        result = self.run(['/usr/bin/systemctl', 'show', unit + '.service', '-p', 'LoadState', '-p', 'ActiveState',
                           '-p', 'MainPID', '-p', 'ControlGroup'], check=False)
        state = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
        require(state.get('LoadState') == 'not-found' or state.get('ActiveState') in ('inactive', 'failed')
                and state.get('MainPID') == '0', 'Qualification unit shutdown is unconfirmed; do not seal its source.')
        if state.get('ControlGroup'):
            root = pathlib.Path('/sys/fs/cgroup')
            group = root / state['ControlGroup'].lstrip('/')
            require(group.resolve().is_relative_to(root), 'Unexpected qualification control group.')
            if group.exists():
                require(all(not path.read_text().strip() for path in group.rglob('cgroup.procs')),
                        'Qualification child processes remain; do not seal its source.')

    def properties(self, user, group, log):
        return ['User=' + user, 'Group=' + group, 'NoNewPrivileges=yes', 'ProtectSystem=strict',
                'ProtectHome=yes', 'PrivateDevices=yes', 'ProtectKernelTunables=yes', 'ProtectKernelModules=yes',
                'ProtectControlGroups=yes', 'ProtectKernelLogs=yes', 'CapabilityBoundingSet=',
                'RestrictRealtime=yes', 'LockPersonality=yes', 'ProtectProc=invisible', 'ProcSubset=pid',
                'KillMode=control-group', 'TimeoutStopSec=10', 'MemorySwapMax=0', 'LimitFSIZE=134217728',
                'TemporaryFileSystem=/tmp:size=268435456,mode=1777 /var/tmp:size=67108864,mode=1777 /run:size=16777216,mode=755',
                'StandardOutput=append:' + str(log), 'StandardError=append:' + str(log),
                'InaccessiblePaths=' + ' '.join('-' + path for path in MASKED)]

    def start_proxy(self):
        directory = self.stage / 'proxy'
        directory.mkdir(mode=0o750)
        directory.chmod(0o750)
        os.chown(directory, self.proxy_uid, self.gid)
        launcher = self.stage / 'proxy-run.py'
        launcher.write_text("import importlib.util,os,sys\nspec=importlib.util.spec_from_file_location('registry_proxy',sys.argv[1])\nmodule=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(module)\nwith module.Server(sys.argv[2],module.Handler) as server:\n os.chmod(sys.argv[2],0o660)\n server.serve_forever()\n")
        launcher.chmod(0o644)
        unit = self.run_id + '-registry'
        self.units.append(unit)
        log = self.logs / 'registry.log'
        log.touch(mode=0o600)
        properties = self.properties('nobody', BUILDER, log) + ['MemoryMax=128M', 'CPUQuota=25%', 'TasksMax=24',
                      'RuntimeMaxSec=900', 'ReadWritePaths=' + str(directory), 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6']
        resolver = pathlib.Path('/etc/resolv.conf').resolve(strict=True)
        require(resolver.is_file(), 'The registry proxy requires the host DNS resolver configuration.')
        if resolver.is_relative_to(pathlib.Path('/run')):
            # Ubuntu's /etc/resolv.conf points into /run. Restore only the
            # resolver files, keeping the host bus and service sockets hidden.
            require(resolver.parent == pathlib.Path('/run/systemd/resolve'), 'Unsupported runtime DNS resolver path.')
            properties.append('BindReadOnlyPaths=/run/systemd/resolve:/run/systemd/resolve')
        argv = ['/usr/bin/systemd-run', '--quiet', '--collect', '--unit=' + unit]
        argv += ['--property=' + prop for prop in properties]
        argv += ['/usr/bin/python3', '-B', str(launcher), str(self.checker / 'deploy/registry-proxy.py'), str(directory / 'proxy.sock')]
        self.run(argv)
        for attempt in range(50):
            if (directory / 'proxy.sock').exists():
                require(stat.S_ISSOCK((directory / 'proxy.sock').lstat().st_mode), 'Expected the temporary registry socket.')
                return directory / 'proxy.sock'
            time.sleep(0.1)
        raise RuntimeError('Temporary restricted registry proxy did not become ready.')

    def phase(self, name, argv, timeout, writable_source=False, socket=None):
        unit = self.run_id + '-' + name
        self.units.append(unit)
        log = self.logs / (name + '.log')
        log.touch(mode=0o600)
        writable = [str(self.state)] + ([str(self.source)] if writable_source else [])
        properties = self.properties(BUILDER, BUILDER, log) + ['PrivateNetwork=yes', 'MemoryMax=1536M',
                      'CPUQuota=100%', 'TasksMax=256', 'RuntimeMaxSec=' + str(timeout),
                      'ReadWritePaths=' + ' '.join(writable), 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6']
        if socket:
            properties.append('BindReadOnlyPaths=' + str(socket) + ':/run/praxis-registry.sock')
        command = ['/usr/bin/systemd-run', '--quiet', '--wait', '--collect', '--unit=' + unit]
        command += ['--property=' + prop for prop in properties]
        command += ['--working-directory=' + str(self.source), '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
                    'HOME=' + str(self.state), 'LANG=C.UTF-8', 'NODE_ENV=test', 'CI=true',
                    'npm_config_cache=' + str(self.state / 'npm-cache'),
                    'npm_config_userconfig=' + str(self.state / 'npm-user.conf'),
                    'npm_config_globalconfig=' + str(self.state / 'npm-global.conf'), 'PYTHONDONTWRITEBYTECODE=1', *argv]
        try:
            result = self.run(command, timeout=timeout + 45, check=False)
            self.results[name] = {'unit': unit, 'exitCode': result.returncode, 'privateNetwork': True}
        finally:
            self.stop_unit(unit)
        self.no_build_processes()
        require(result.returncode == 0, 'Candidate ' + name + ' failed; inspect retained private qualification logs.')

    def prepare(self):
        protected(self.archive)
        require(self.archive.stat().st_size <= 256 * 1024 * 1024, 'Source archive exceeds 256 MiB.')
        self.no_build_processes()
        for parent in (self.stage.parent, self.output.parent):
            if not parent.exists():
                parent.mkdir(mode=0o711)
                parent.chmod(0o711)
            protected(parent, directory=True)
        require(self.stage.parent.stat().st_mode & 0o001, 'Qualification parent must allow build identity traversal.')
        require(len(list(self.stage.parent.iterdir())) < 4, 'Unresolved qualification retention is full; inspect earlier runs.')
        require(len(list(self.output.parent.iterdir())) < 8, 'Qualified release retention is full; explicit maintenance is required.')
        self.stage.mkdir(mode=0o711)
        self.output.mkdir(mode=0o700)
        self.run(['/usr/bin/mount', '-t', 'tmpfs', '-o', 'size=2G,mode=0711,nodev,nosuid', 'praxis-qualification', str(self.stage)])
        self.mounted = True
        self.logs.mkdir(mode=0o700)
        self.state.mkdir(mode=0o700)
        os.chown(self.state, self.uid, self.gid)
        for name in ('npm-user.conf', 'npm-global.conf'):
            path = self.state / name
            path.touch(mode=0o600)
            os.chown(path, self.uid, self.gid)
        before = file_hash(self.archive)
        extract_archive(self.archive, self.commit, self.source)
        require(file_hash(self.archive) == before, 'Source archive changed during extraction.')
        self.archive_hash = before
        self.original = safe_tree(self.source)
        shutil.copytree(self.source, self.checker)
        own_tree(self.checker, 0, 0)
        own_tree(self.source, self.uid, self.gid)

    def qualify(self):
        self.prepare()
        socket = self.start_proxy()
        self.phase('dependencies', ['/usr/bin/node', str(self.checker / 'deploy/registry-relay.mjs'), '/usr/bin/npm',
                   'ci', '--ignore-scripts', '--no-audit', '--no-fund'], 600, writable_source=True, socket=socket)
        self.stop_unit(self.run_id + '-registry')
        dependencies = safe_tree(self.source, allow_dependency_links=True)
        require({key: value for key, value in dependencies.items() if not key.startswith('node_modules/')} == self.original,
                'Dependency preparation changed candidate source.')
        require((self.source / 'node_modules/.package-lock.json').is_file(), 'npm did not produce its dependency lock.')
        shutil.copytree(self.source / 'node_modules', self.checker / 'node_modules', symlinks=True)
        own_tree(self.checker, 0, 0)
        trusted_checker = safe_tree(self.checker, allow_dependency_links=True)
        self.phase('npm-test', ['/usr/bin/npm', 'test'], 900, writable_source=True)
        require(safe_tree(self.source, allow_dependency_links=True) == dependencies, 'Tests modified source or prepared dependencies.')
        self.phase('tool-manifest', ['/usr/bin/node', 'scripts/export-tool-manifest.js', 'coding-tools.json'], 120, writable_source=True)
        built = safe_tree(self.source, allow_dependency_links=True)
        require({key: value for key, value in built.items() if key != 'coding-tools.json'} == dependencies,
                'Manifest generation modified candidate source or dependencies.')
        require('coding-tools.json' in built and built['coding-tools.json']['bytes'] <= 1024 * 1024, 'Tool manifest is unavailable or too large.')
        self.no_build_processes()
        own_tree(self.source, 0, 0)
        self.phase('authenticated-mcp', ['/usr/bin/node', str(self.checker / 'scripts/release-candidate-check.js'),
                   str(self.source), str(self.state / 'readiness')], 120)
        require(safe_tree(self.source, allow_dependency_links=True) == built, 'Candidate artifact changed during readiness.')
        require(safe_tree(self.checker, allow_dependency_links=True) == trusted_checker, 'Trusted readiness checker changed.')
        self.no_build_processes()
        release = self.output / 'release'
        required_bytes = sum(entry.get('bytes', 0) for entry in built.values()) + 128 * 1024 * 1024
        require(shutil.disk_usage(self.output).free >= required_bytes, 'Insufficient space to preserve the qualified release.')
        shutil.copytree(self.source, release, symlinks=True)
        own_tree(release, 0, 0)
        sealed = safe_tree(release, allow_dependency_links=True)
        require(sealed == built, 'Sealed candidate differs from qualified source.')
        evidence = self.output / 'evidence'
        shutil.copytree(self.logs, evidence)
        for path in evidence.iterdir():
            path.chmod(0o600)
        receipt = {'sourceCommit': self.commit, 'npmTestPassed': True, 'authenticatedMcpPassed': True,
                   'artifactSha256': artifact_hash(sealed), 'sourceArchiveSha256': self.archive_hash,
                   'sourceTreeSha256': artifact_hash(self.original), 'qualificationId': self.run_id,
                   'qualificationScript': 'deploy/qualify-autonomy.sh', 'phases': self.results,
                   'evidenceKind': 'isolated Linux API-client qualification', 'realContainerFixturePassed': False,
                   'productionCredentialsAvailable': False, 'nativePhoneRun': False}
        atomic_json(self.output / 'acceptance.json', receipt)
        print(json.dumps({'ok': True, 'releaseDirectory': str(release), 'acceptance': str(self.output / 'acceptance.json'),
                          'sourceCommit': self.commit, 'artifactSha256': receipt['artifactSha256']}), flush=True)

    def finish(self, success):
        for unit in reversed(self.units):
            self.stop_unit(unit)
        if self.mounted and success:
            self.run(['/usr/bin/umount', str(self.stage)])
            self.stage.rmdir()


def main():
    require(os.getuid() == 0 and len(sys.argv) == 3, 'Run as root with a protected Git archive and exact commit.')
    require(re.fullmatch('[0-9a-f]{40}', sys.argv[2]), 'Expected an exact lowercase Git commit.')
    import fcntl
    os.umask(0o077)
    descriptor = os.open('/run/lock/praxis-qualification.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    qualification = Qualification(sys.argv[1], sys.argv[2])
    success = False
    try:
        qualification.qualify()
        success = True
    except Exception as error:
        if qualification.output.exists():
            atomic_json(qualification.output / 'failure.json', {'ok': False, 'qualificationId': qualification.run_id,
                        'stageDirectory': str(qualification.stage), 'error': str(error), 'phases': qualification.results})
        raise
    finally:
        qualification.finish(success)


if __name__ == '__main__':
    main()
QUALIFY_PYTHON
