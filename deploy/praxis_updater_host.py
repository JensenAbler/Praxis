"""Fixed Linux effects for the independently installed Praxis updater."""
import contextlib
import hashlib
import json
import os
import pathlib
import pwd
import shutil
import sqlite3
import stat
import subprocess
import time


def require(value, message):
    if not value:
        raise RuntimeError(message)


def atomic_json(path, value, mode=0o600):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.next')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, mode)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(os.dup(fd), 'w') as output:
            json.dump(value, output, indent=2)
            output.write('\n')
            output.flush()
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)


def file_hash(path):
    h = hashlib.sha256()
    with open(path, 'rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''): h.update(chunk)
    return h.hexdigest()


def safe_tree(root, allow_dependency_links=False):
    root = pathlib.Path(root)
    require(root.is_dir() and not root.is_symlink(), 'Expected an ordinary source tree.')
    entries, total = {}, 0
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root).as_posix()
        require(not any(part in ('.git', '.ssh') or part == '.env' or part.startswith('.env.') for part in path.relative_to(root).parts), 'Release contains a protected path.')
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode): continue
        if stat.S_ISLNK(info.st_mode):
            require(allow_dependency_links and relative.startswith('node_modules/') and path.resolve(strict=True).is_relative_to(root / 'node_modules'), 'Release link escapes its dependency tree.')
            entries[relative] = {'link': os.readlink(path)}
            continue
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'Release contains a special or hard-linked file.')
        total += info.st_size
        require(total <= 1024 * 1024 * 1024 and len(entries) < 100000, 'Release exceeds bounded storage limits.')
        entries[relative] = {'sha256': file_hash(path), 'bytes': info.st_size, 'mode': '100755' if info.st_mode & 0o111 else '100644'}
    return entries


def fingerprints(filename, before=None):
    with contextlib.closing(sqlite3.connect(pathlib.Path(filename).as_uri() + '?mode=ro', uri=True)) as db:
        tables = before or {row[0]: None for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('code_runner_lock')")}
        output = {}
        quote = lambda name: '"' + name.replace('"', '""') + '"'
        for table, expected in tables.items():
            columns = expected['columns'] if expected else [row[1] for row in db.execute('PRAGMA table_info(' + quote(table) + ')')]
            rows = []
            for row in db.execute('SELECT ' + ','.join(map(quote, columns)) + ' FROM ' + quote(table)):
                rows.append(json.dumps([{'bytes': value.hex()} if isinstance(value, bytes) else value for value in row], sort_keys=True))
            output[table] = {'columns': columns, 'count': len(rows), 'sha256': hashlib.sha256('\n'.join(sorted(rows)).encode()).hexdigest()}
        return output


class Host:
    def __init__(self, config):
        self.config = config
        self.root = pathlib.Path(config['releasesRoot'])
        self.current = pathlib.Path(config['currentLink'])
        self.stages = pathlib.Path(config['stagingRoot'])
        self.staging_mount = pathlib.Path(config.get('stagingMount', self.stages.parent))
        self.state = pathlib.Path(config['dataDirectory'])
        self.fence = pathlib.Path(config['generationFencePath'])
        self.control = pathlib.Path(config['controlRoot'])
        self.code_config = pathlib.Path(config['codingConfig'])
        self.stage_user = config.get('stageUser', 'praxis-stage')
        self.health_user = config.get('healthUser', 'praxis-health')
        self.uid = pwd.getpwnam(self.stage_user).pw_uid
        self.gid = pwd.getpwnam(self.stage_user).pw_gid

    @staticmethod
    def run(argv, timeout=60, check=True):
        result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        if check and result.returncode:
            raise RuntimeError('Fixed updater command failed: ' + pathlib.Path(argv[0]).name + ': ' + result.stderr[-800:])
        return result

    def release_path(self, name):
        target = self.root / name
        require(target.parent == self.root and target.is_dir() and not target.is_symlink(), 'Unknown installed application release.')
        return target

    def active(self):
        target = self.current.resolve(strict=True)
        require(self.current.is_symlink() and target.parent == self.root, 'Unexpected active application target.')
        service = self.run(['systemctl', 'show', 'praxis-code.service', '-p', 'ActiveState', '-p', 'SubState', '-p', 'InvocationID'], check=False)
        return {'release': target.name, 'service': dict(line.split('=', 1) for line in service.stdout.splitlines() if '=' in line)}

    def release_source(self, name):
        return json.loads((self.release_path(name) / 'release.json').read_text())['sourceCommit']

    def diagnostics(self, operation):
        # operation is an already-owned durable row ID, never a caller path.
        require(isinstance(operation, str) and len(operation) == 36 and all(char in '0123456789abcdef-' for char in operation),
                'Invalid preparation identifier.')
        result = []
        for phase in ('build', 'readiness'):
            path = self.state / (operation + '-' + phase + '.json')
            if not path.exists() and not path.is_symlink():
                continue
            try:
                require(path.resolve() == path.absolute(), 'Linked preparation evidence.')
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                try:
                    value = os.fstat(fd)
                    require(stat.S_ISREG(value.st_mode) and value.st_uid == 0 and value.st_nlink == 1
                            and value.st_mode & 0o022 == 0 and value.st_size <= 131072, 'Unsafe preparation evidence.')
                    with os.fdopen(fd, 'rb', closefd=False) as source:
                        raw = source.read(131073)
                    require(len(raw) <= 131072, 'Oversized preparation evidence.')
                finally:
                    os.close(fd)
                saved = json.loads(raw)
                require(isinstance(saved, dict), 'Invalid preparation evidence.')
                tail = saved.get('tail') if isinstance(saved.get('tail'), str) else ''
                exit_code = saved.get('exitCode')
                item = {'phase': phase, 'exitCode': exit_code if type(exit_code) is int and -255 <= exit_code <= 255 else None,
                        'tail': tail[-4096:], 'excerpt': True, 'truncated': len(tail) > 4096}
                if saved.get('controlError'):
                    item['controlError'] = 'Candidate process control did not return a confirmed outcome.'
                while len(json.dumps(item).encode()) > 4800:
                    item['tail'] = item['tail'][max(1, len(item['tail']) // 4):]
                    item['truncated'] = True
                result.append(item)
            except (OSError, ValueError, RuntimeError):
                result.append({'phase': phase, 'unavailable': 'Saved preparation evidence could not be safely read.'})
        return result

    def stage_unit(self, operation, phase, source, argv, timeout=900, writable=False):
        unit = 'praxis-stage-' + operation + '-' + phase
        log_directory = self.staging_mount / 'logs'
        log_directory.mkdir(mode=0o700, exist_ok=True)
        require(log_directory.stat().st_uid == 0 and not log_directory.is_symlink(), 'Expected protected staging logs.')
        log_path = log_directory / (operation + '-' + phase + '.log')
        descriptor = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.close(descriptor)
        properties = [
            'User=' + self.stage_user, 'Group=' + self.stage_user, 'PrivateNetwork=yes',
            'TemporaryFileSystem=/tmp:size=268435456,mode=1777 /var/tmp:size=134217728,mode=1777',
            'NoNewPrivileges=yes', 'ProtectSystem=strict', 'ProtectHome=yes', 'PrivateDevices=yes',
            'ProtectKernelTunables=yes', 'ProtectKernelModules=yes', 'ProtectControlGroups=yes',
            'CapabilityBoundingSet=', 'RestrictSUIDSGID=yes', 'LockPersonality=yes',
            'MemoryMax=1536M', 'MemorySwapMax=0', 'CPUQuota=100%', 'TasksMax=256',
            'RuntimeMaxSec=' + str(timeout), 'TimeoutStopSec=10', 'KillMode=control-group',
            'StandardOutput=append:' + str(log_path), 'StandardError=append:' + str(log_path),
            'LogRateLimitIntervalSec=30', 'LogRateLimitBurst=1000',
            'InaccessiblePaths=/etc/praxis-probe /var/lib/praxis-probe /etc/praxis-code /var/lib/praxis-code /etc/praxis-git /var/lib/praxis-git /etc/praxis-updater /var/lib/praxis-updater /srv/praxis-code /srv/praxis-git-exchange /opt/podcast-discord /opt/podcast-production -/srv/apocrypha',
            'ReadWritePaths=' + str(source),
            'BindReadOnlyPaths=/run/praxis-dependencies/proxy.sock:/run/praxis-registry.sock',
            'SupplementaryGroups=praxis-code',
        ]
        # Only the temporary preparation/smoke directory is writable, never the
        # immutable candidate artifact or any live operational state.
        args = ['systemd-run', '--quiet', '--wait', '--collect', '--unit=' + unit]
        for prop in properties: args.append('--property=' + prop)
        args += ['--setenv=HOME=/tmp', '--setenv=NODE_ENV=test', '--setenv=CI=true', '--working-directory=' + str(source), *argv]
        result = None
        run_error = None
        try:
            result = self.run(args, timeout=timeout + 30, check=False)
        except Exception as error:
            run_error = error
        finally:
            # Even a lost systemd-run response must not leave a same-UID build
            # running while root copies or changes ownership of another stage.
            try:
                self.stop_stage(unit)
            except Exception as error:
                run_error = error
        with log_path.open('rb') as log_file:
            log_file.seek(max(0, log_path.stat().st_size - 20000))
            log = log_file.read(20000).decode('utf-8', errors='replace')
        atomic_json(self.state / (operation + '-' + phase + '.json'), {'unit': unit,
            'exitCode': result.returncode if result is not None else None, 'tail': log, 'controlError': run_error is not None})
        if run_error:
            raise run_error
        require(result.returncode == 0, 'Candidate ' + phase + ' failed; inspect the saved preparation evidence.')

    def stop_stage(self, unit):
        self.run(['systemctl', 'stop', unit + '.service'], timeout=20, check=False)
        observed = self.run(['systemctl', 'show', unit + '.service', '-p', 'LoadState', '-p', 'ActiveState',
                             '-p', 'SubState', '-p', 'MainPID', '-p', 'ControlGroup'], timeout=20, check=False)
        values = dict(line.split('=', 1) for line in observed.stdout.splitlines() if '=' in line)
        absent = values.get('LoadState') == 'not-found'
        inactive = values.get('ActiveState') in ('inactive', 'failed') and values.get('MainPID', '0') == '0'
        require(absent or inactive, 'Candidate unit shutdown is unconfirmed; do not copy or seal its writable source.')
        group = values.get('ControlGroup')
        if group:
            cgroups = pathlib.Path('/sys/fs/cgroup')
            directory = cgroups / group.lstrip('/')
            require(directory.resolve().is_relative_to(cgroups), 'Unexpected candidate control group.')
            if directory.exists():
                for processes in directory.rglob('cgroup.procs'):
                    require(not processes.read_text().strip(), 'Candidate child processes remain; do not copy or seal its writable source.')
                direct = directory / 'cgroup.procs'
                require(not direct.exists() or not direct.read_text().strip(), 'Candidate child processes remain; do not copy or seal its writable source.')

    def stage_capacity(self):
        mount = self.staging_mount
        require(mount.is_dir() and not mount.is_symlink() and mount.resolve() == mount.absolute()
                and os.path.ismount(mount), 'Preparation requires the configured dedicated staging mount.')
        info = mount.stat()
        require(info.st_uid == 0 and info.st_mode & 0o022 == 0
                and info.st_dev != pathlib.Path('/').stat().st_dev, 'Staging must be a separate protected filesystem.')
        require(self.stages.absolute().is_relative_to(mount) and self.stages.absolute() != mount,
                'Staging directories must remain below their dedicated mount.')
        for directory in (self.stages, self.root):
            if directory.exists() or directory.is_symlink():
                current = directory.lstat()
                require(stat.S_ISDIR(current.st_mode) and current.st_uid == 0 and current.st_mode & 0o022 == 0
                        and directory.resolve() == directory.absolute(), 'Release storage is not a protected canonical directory.')
        usage = os.statvfs(mount)
        require(usage.f_blocks * usage.f_frsize <= 8 * 1024 * 1024 * 1024,
                'Staging filesystem must have a hard capacity of at most 8 GiB.')
        require(usage.f_bavail * usage.f_frsize >= 2 * 1024 * 1024 * 1024,
                'Staging has less than 2 GiB free; retain unresolved operations and perform explicit owner maintenance.')
        running = self.run(['systemctl', 'list-units', '--all', '--plain', '--no-legend',
                            '--state=active,activating,deactivating', 'praxis-stage-*'], timeout=20)
        require(not running.stdout.strip(), 'A previous candidate unit remains active; recover it before another preparation.')
        stages = list(self.stages.iterdir()) if self.stages.exists() else []
        releases = list(self.root.iterdir()) if self.root.exists() else []
        require(len(stages) <= 14 and len(releases) < 4,
                'Preparation retention is full (16 staging directories or 4 releases); recover references before owner maintenance.')

    def _own_stage(self, path):
        for item in [path, *path.rglob('*')]:
            if not item.is_symlink(): os.chown(item, self.uid, self.gid)

    def _source(self, args):
        export = pathlib.Path(self.config['exportDirectory']) / args['exportId']
        require(export.is_dir() and not export.is_symlink(), 'Source export is unavailable.')
        manifest_path = export / 'manifest.json'
        require(manifest_path.is_file() and not manifest_path.is_symlink() and manifest_path.stat().st_size < 16 * 1024 * 1024, 'Invalid export manifest.')
        manifest = json.loads(manifest_path.read_text())
        require(manifest.get('version') == 1 and manifest.get('projectId') == 'praxis' and manifest.get('commit') == args['sourceCommit'] and manifest.get('revision') == args['sourceDigest'], 'Release source differs from synchronized Praxis commit.')
        source = export / 'files'
        entries = safe_tree(source)
        require(set(entries) == set(manifest['entries']), 'Source export file set changed.')
        for name, value in entries.items():
            expected = manifest['entries'][name]
            require(value['sha256'] == expected['sha256'] and value['bytes'] == expected['size'] and value['mode'] == expected['mode'], 'Source export bytes changed.')
        for name, expected_hash in self.config.get('protectedFiles', {}).items():
            require(name in entries and entries[name]['sha256'] == expected_hash, 'Candidate changes protected installed code: ' + name)
        return source, entries

    def prepare(self, operation, args):
        self.stage_capacity()
        prepared = self.state / (operation + '-prepared.json')
        require(not prepared.exists(), 'Preparation result already exists; recover the original operation.')
        source, original = self._source(args)
        self.stages.mkdir(parents=True, exist_ok=True, mode=0o711)
        stage = self.stages / operation
        require(not stage.exists(), 'A preparation directory already exists; an ambiguous build is not repeated.')
        shutil.copytree(source, stage)
        self._own_stage(stage)
        self.stage_unit(operation, 'build', stage,
                        ['/usr/bin/node', str(self.control / 'scripts/release-build.js'), str(stage)], timeout=900, writable=True)
        built = safe_tree(stage, allow_dependency_links=True)
        source_after = {name: value for name, value in built.items() if name != 'coding-tools.json' and not name.startswith('node_modules/')}
        require(source_after == original, 'Candidate build changed the source being released.')
        tool_path = stage / 'coding-tools.json'
        require(tool_path.is_file() and tool_path.stat().st_size <= 1024 * 1024, 'Candidate did not produce a bounded tool manifest.')
        manifest = json.loads(tool_path.read_text())
        self.validate_manifest(manifest)
        release = 'app-' + args['sourceCommit'][:12] + '-' + operation[:8]
        installed = self.root / release
        self.root.mkdir(parents=True, exist_ok=True)
        require(not installed.exists(), 'Candidate release name already exists.')
        shutil.copytree(stage, installed, symlinks=True)
        for path in [installed, *installed.rglob('*')]:
            if path.is_symlink():
                os.lchown(path, 0, 0)
            else:
                os.chown(path, 0, 0)
                os.chmod(path, 0o755 if path.is_dir() or path.stat().st_mode & 0o111 else 0o644)
        sealed = safe_tree(installed, allow_dependency_links=True)
        artifact_hash = hashlib.sha256(json.dumps(sealed, sort_keys=True).encode()).hexdigest()
        metadata = {'sourceCommit': args['sourceCommit'], 'artifactSha256': artifact_hash, 'sourceDigest': args['sourceDigest'], 'release': release}
        atomic_json(installed / 'release.json', metadata, mode=0o644)
        smoke = self.stages / (operation + '-smoke')
        smoke.mkdir(mode=0o700)
        with contextlib.closing(sqlite3.connect(self.config['codingDatabase'])) as live, contextlib.closing(sqlite3.connect(smoke / 'coding.sqlite')) as copy:
            live.backup(copy)
        before = fingerprints(smoke / 'coding.sqlite')
        self._own_stage(smoke)
        self.stage_unit(operation, 'readiness', smoke,
                        ['/usr/bin/node', str(self.control / 'scripts/release-candidate-check.js'), str(installed), str(smoke)], timeout=120)
        require(fingerprints(smoke / 'coding.sqlite', before) == before, 'Candidate readiness changed existing operational data in the disposable compatibility copy.')
        value = {**metadata, 'testEvidence': {'npmTestPassed': True, 'authenticatedMcpPassed': True, 'operationalDataPreservedInCopy': True,
                    'stagingPrivateNetwork': True, 'liveAuthorityAvailable': False}, 'scope': 'Coding application and data-only tool manifest; protected gateway/adapters/updater unchanged.'}
        atomic_json(prepared, value)
        return value

    def recover_preparation(self, operation, args):
        path = self.state / (operation + '-prepared.json')
        require(path.exists(), 'Preparation was interrupted. Its candidate/build was not restarted; inspect the recorded unit and prepare a new operation after diagnosis.')
        value = json.loads(path.read_text())
        require(value['sourceCommit'] == args['sourceCommit'], 'Stored preparation source changed.')
        self.release_path(value['release'])
        return value

    def validate_manifest(self, candidate):
        require(candidate.get('version') == 1 and isinstance(candidate.get('tools'), list) and 1 <= len(candidate['tools']) <= 100, 'Unsupported tool manifest.')
        previous = json.loads((self.current.resolve() / 'coding-tools.json').read_text())
        next_tools = {tool['name']: tool for tool in candidate['tools']}
        require(len(next_tools) == len(candidate['tools']), 'Duplicate tool name.')
        for tool in previous['tools']:
            require(tool['name'] in next_tools, 'Existing tools cannot disappear during routine self-update.')
            newer = next_tools[tool['name']]
            require(newer['write'] == tool['write'] and newer['destructive'] == tool['destructive'], 'An existing tool permission annotation changed.')
            old_schema, new_schema = tool['inputSchema'], newer['inputSchema']
            require(set(new_schema.get('required', [])) <= set(old_schema.get('required', [])), 'An existing tool gained a required argument.')
            for name, schema in old_schema.get('properties', {}).items():
                require(new_schema.get('properties', {}).get(name) == schema, 'An existing argument changed incompatibly: ' + tool['name'] + '.' + name)

    def reserve(self, operation):
        if self.fence.exists():
            fence = json.loads(self.fence.read_text())
            require(fence.get('state') == 'active' or fence.get('operationId') == operation, 'Another activation holds the generation fence.')
        atomic_json(self.fence, {'state': 'draining', 'operationId': operation}, 0o644)
        with contextlib.ExitStack() as stack:
            code = stack.enter_context(contextlib.closing(sqlite3.connect(self.config['codingDatabase'], timeout=10, isolation_level=None)))
            broker = stack.enter_context(contextlib.closing(sqlite3.connect(self.config['gitDatabase'], timeout=10, isolation_level=None)))
            code.execute('BEGIN IMMEDIATE')
            broker.execute('BEGIN IMMEDIATE')
            jobs = code.execute("SELECT COUNT(*) FROM code_jobs WHERE status IN ('queued','starting','running','canceling')").fetchone()[0]
            edits = code.execute("SELECT COUNT(*) FROM operations WHERE status='prepared'").fetchone()[0]
            publication = broker.execute("SELECT COUNT(*) FROM git_operations WHERE status IN ('queued','running','uncertain')").fetchone()[0]
            if jobs or edits or publication:
                self.open(operation)
                return False
            self.run(['systemctl', 'stop', 'praxis-code.service'], timeout=30)
            require(self.active()['service'].get('ActiveState') == 'inactive', 'Coding application did not drain.')
            return True

    def reservation_held(self, operation):
        if not self.fence.exists():
            return False
        fence = json.loads(self.fence.read_text())
        return fence.get('state') == 'draining' and fence.get('operationId') == operation

    def switch(self, target, operation):
        release = self.release_path(target)
        metadata = json.loads((release / 'release.json').read_text())
        sealed = safe_tree(release, allow_dependency_links=True)
        sealed.pop('release.json', None)
        require(hashlib.sha256(json.dumps(sealed, sort_keys=True).encode()).hexdigest() == metadata['artifactSha256'], 'Immutable candidate artifact changed.')
        next_link = self.current.with_name('next-' + operation)
        if next_link.is_symlink(): next_link.unlink()
        next_link.symlink_to(release)
        os.replace(next_link, self.current)
        config_stat = self.code_config.stat()
        config = json.loads(self.code_config.read_text())
        config['release'] = target
        atomic_json(self.code_config, config, stat.S_IMODE(config_stat.st_mode))
        os.chown(self.code_config, config_stat.st_uid, config_stat.st_gid)
        self.run(['systemctl', 'start', 'praxis-code.service'], timeout=30)

    def restore(self, target, operation):
        self.run(['systemctl', 'stop', 'praxis-code.service'], timeout=30)
        self.switch(target, operation)

    def health(self, target):
        for attempt in range(12):
            result = self.run(['runuser', '-u', self.health_user, '--', '/usr/bin/node', str(self.control / 'scripts/release-live-check.js'),
                               self.config['healthConfig'], target], timeout=20, check=False)
            if result.returncode == 0:
                try:
                    value = json.loads(result.stdout)
                    if value.get('ok') and value.get('release') == target: return value
                except (ValueError, TypeError): pass
            time.sleep(1)
        return {'ok': False, 'release': target, 'checks': 'authenticated coding reads through protected MCP gateway'}

    def open(self, operation):
        if self.fence.exists():
            fence = json.loads(self.fence.read_text())
            require(fence.get('state') == 'active' or fence.get('operationId') == operation, 'Cannot open another activation fence.')
            if fence.get('state') == 'active' and fence.get('operationId') == operation:
                return
        atomic_json(self.fence, {'state': 'active', 'release': self.active()['release'], 'operationId': operation}, 0o644)

    def release_reservation(self, operation):
        if self.fence.exists() and json.loads(self.fence.read_text()).get('operationId') == operation:
            self.open(operation)
