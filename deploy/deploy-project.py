#!/usr/bin/python3 -I
"""Fixed, root-owned deployment helper for explicitly published Praxis projects.

The trusted broker authenticates project ownership, publication and runtime.
This helper accepts no commands, source paths, domains, environment values or
service names. Candidate code runs only in a restricted DynamicUser service.
"""
import contextlib
import datetime
import hashlib
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import shutil
import stat
import subprocess
import sys
import time
import uuid
try:
    import fcntl
except ImportError:
    fcntl = None

PROJECT = re.compile(r'^p-[a-f0-9]{16}-[a-z][a-z0-9-]{0,39}$')
OID = re.compile(r'^[a-f0-9]{40}$')
DIGEST = re.compile(r'^[a-f0-9]{64}$')
STATE = Path('/var/lib/praxis-deploy/projects')
APPLICATIONS = Path('/srv/praxis-apps')
EXPORTS = Path('/srv/praxis-git-exchange/exports')
UNITS = Path('/etc/systemd/system')
ROUTES = Path('/etc/nginx/praxis-apps')
PUBLIC_ORIGIN = 'https://praxis-apps.jensenabler.com'
TERMINAL = {'completed', 'failed', 'uncertain'}


class ProjectDeploymentError(Exception):
    def __init__(self, code, message, exit_code=None):
        super().__init__(message)
        self.code, self.exit_code = code, exit_code


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def validate(value):
    if not isinstance(value, dict) or value.get('action') not in ('apply', 'status'):
        raise ProjectDeploymentError('INVALID_ARGUMENT', 'action must be apply or status.')
    required = {'action', 'projectId'}
    allowed = required | {'operationId'}
    if value['action'] == 'apply':
        required |= {'operationId', 'exportId', 'targetCommit', 'expectedHead', 'runtime'}
        allowed = required | {'preparedDependenciesId', 'recoverOperationId'}
    if not required <= value.keys() or value.keys() - allowed or not PROJECT.fullmatch(str(value.get('projectId', ''))):
        raise ProjectDeploymentError('INVALID_ARGUMENT', 'The project deployment request has missing or unsupported fields.')
    for key in ('operationId', 'exportId', 'recoverOperationId'):
        if key in value:
            try:
                if str(uuid.UUID(value[key])) != value[key]:
                    raise ValueError()
            except (TypeError, AttributeError, ValueError):
                raise ProjectDeploymentError('INVALID_ARGUMENT', key + ' must be a canonical UUID.') from None
    for key in ('targetCommit', 'expectedHead'):
        if key in value and not (key == 'expectedHead' and value[key] is None):
            if not isinstance(value[key], str) or not OID.fullmatch(value[key]):
                raise ProjectDeploymentError('INVALID_ARGUMENT', 'Deployment commit IDs must be exact lowercase Git object IDs.')
    if 'runtime' in value and value['runtime'] not in ('node', 'python', 'static'):
        raise ProjectDeploymentError('INVALID_ARGUMENT', 'The runtime must be a registered node, python, or static template.')
    if 'preparedDependenciesId' in value and (not isinstance(value['preparedDependenciesId'], str)
            or not DIGEST.fullmatch(value['preparedDependenciesId'])):
        raise ProjectDeploymentError('INVALID_ARGUMENT', 'The dependency ID must be a SHA-256 digest.')
    if value.get('preparedDependenciesId') and value.get('runtime') != 'node':
        raise ProjectDeploymentError('DEPENDENCIES_UNSUPPORTED', 'Prepared dependency deployment currently supports Node projects.')
    return value


class ProjectDeployment:
    def __init__(self, state=STATE, applications=APPLICATIONS, exports=EXPORTS, units=UNITS,
                 routes=ROUTES, expected_uid=0, export_uid=None, dependency_adapter=None, grace_seconds=3,
                 ready_seconds=15):
        self.state, self.applications, self.exports = Path(state), Path(applications), Path(exports)
        self.units, self.routes = Path(units), Path(routes)
        self.expected_uid, self.export_uid = expected_uid, export_uid
        self.dependency_adapter, self.grace_seconds, self.lock_fd = dependency_adapter, grace_seconds, None
        self.ready_seconds = ready_seconds

    def _trusted(self, path, directory=False, owner=None):
        value = path.lstat()
        if ((not stat.S_ISDIR(value.st_mode) if directory else not stat.S_ISREG(value.st_mode))
                or value.st_uid != (self.expected_uid if owner is None else owner)
                or value.st_mode & 0o022 or path.absolute() != path.resolve()):
            raise ProjectDeploymentError('UNTRUSTED_PATH', 'A fixed deployment control path is unsafe.')

    @contextlib.contextmanager
    def _locked(self):
        if fcntl is None:
            raise ProjectDeploymentError('UNSUPPORTED_HOST', 'Project deployment requires Linux flock.')
        for root in (self.state, self.applications, self.units, self.routes):
            self._trusted(root, directory=True)
        lock = self.state / 'projects.lock'
        fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            self._trusted(lock)
            fcntl.flock(fd, fcntl.LOCK_EX)
            self.lock_fd = fd
            yield
        finally:
            self.lock_fd = None
            os.close(fd)

    def _run(self, argv, timeout=60):
        proc = subprocess.Popen(argv, env={'PATH': '/usr/bin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'},
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                start_new_session=True, pass_fds=(() if self.lock_fd is None else (self.lock_fd,)))
        try:
            output, _ = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.communicate()
            raise ProjectDeploymentError('COMMAND_TIMEOUT', 'A fixed project deployment command timed out; recover this operation.') from None
        if proc.returncode:
            raise ProjectDeploymentError('COMMAND_FAILED', 'A fixed project deployment command failed.', proc.returncode)
        if len(output) > 1024 * 1024:
            raise ProjectDeploymentError('OUTPUT_LIMIT', 'A fixed project deployment observation exceeded its limit.')
        return output

    def _write(self, path, data, mode=0o600):
        temporary = path.parent / ('.praxis-' + str(uuid.uuid4()))
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, mode)
        try:
            os.fchmod(fd, mode)
            with os.fdopen(fd, 'wb') as out:
                out.write(data)
                out.flush()
                os.fsync(out.fileno())
            os.replace(temporary, path)
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if temporary.exists():
                temporary.unlink()

    def _save(self, record, phase=None, **values):
        if phase:
            record['phase'] = phase
        record.update(values)
        record['updatedAt'] = utc()
        self._write(self.state / (record['operationId'] + '.json'), json.dumps(record, sort_keys=True).encode())
        return record

    def _load(self, operation_id):
        path = self.state / (operation_id + '.json')
        if not path.exists():
            return None
        self._trusted(path)
        if path.stat().st_size > 65536:
            raise ProjectDeploymentError('JOURNAL_INVALID', 'The operation record exceeds its bounded size.')
        return json.loads(path.read_text())

    def _registry(self):
        path = self.state / 'registry.json'
        if not path.exists():
            return {}
        self._trusted(path)
        value = json.loads(path.read_text())
        if not isinstance(value, dict) or len(value) > 5:
            raise ProjectDeploymentError('REGISTRY_INVALID', 'The fixed project registry is invalid.')
        return value

    def _allocate(self, project_id, runtime):
        registry = self._registry()
        if project_id in registry:
            if registry[project_id]['runtime'] != runtime:
                raise ProjectDeploymentError('RUNTIME_MISMATCH', 'The registered deployment runtime cannot change in place.')
            return registry[project_id]
        used = {item['port'] for item in registry.values()}
        port = next((port for port in range(18700, 18705) if port not in used), None)
        if port is None:
            raise ProjectDeploymentError('APP_LIMIT', 'The five-app deployment limit has been reached.')
        registry[project_id] = {'port': port, 'runtime': runtime}
        self._write(self.state / 'registry.json', json.dumps(registry, sort_keys=True).encode())
        return registry[project_id]

    def _head(self, project_id):
        current = self.applications / project_id / 'current'
        if not current.is_symlink():
            if current.exists():
                raise ProjectDeploymentError('UNTRUSTED_PATH', 'The application release pointer is not a controlled symlink.')
            return None
        meta = current.lstat()
        target = os.readlink(current)
        match = re.fullmatch(r'releases/([a-f0-9]{40})/files', target)
        if meta.st_uid != self.expected_uid or not match:
            raise ProjectDeploymentError('UNTRUSTED_PATH', 'The application release pointer is invalid.')
        return match[1]

    def _service_name(self, project_id):
        return 'praxis-app-' + project_id + '.service'

    def _service(self, project_id):
        output = self._run(['/usr/bin/systemctl', 'show', self._service_name(project_id),
                            '--property=LoadState,ActiveState,SubState,MainPID,InvocationID,NRestarts']).decode()
        return dict(line.split('=', 1) for line in output.splitlines() if '=' in line)

    @staticmethod
    def _active(service):
        return service.get('ActiveState') == 'active' and service.get('SubState') == 'running' and bool(service.get('InvocationID'))

    def _source_file(self, root, relative, expected_size):
        if self.export_uid is None:
            import pwd
            owner = pwd.getpwnam('praxis-git').pw_uid
        else:
            owner = self.export_uid
        self._trusted(root, directory=True, owner=owner)
        path = root
        for part in relative.split('/')[:-1]:
            path = path / part
            self._trusted(path, directory=True, owner=owner)
        path = root / relative
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            meta = os.fstat(fd)
            if (not stat.S_ISREG(meta.st_mode) or meta.st_uid != owner or meta.st_nlink != 1
                    or meta.st_mode & 0o022 or meta.st_size != expected_size):
                raise ProjectDeploymentError('SOURCE_UNTRUSTED', 'An exported source file is unsafe or changed size.')
            with os.fdopen(fd, 'rb', closefd=False) as source:
                data = source.read(expected_size + 1)
            if len(data) != expected_size:
                raise ProjectDeploymentError('SOURCE_CHANGED', 'Exported source changed during the bounded copy.')
            return data
        finally:
            os.close(fd)

    def _manifest(self, request):
        root = self.exports / request['exportId']
        size = (root / 'manifest.json').lstat().st_size
        if size > 4 * 1024 * 1024:
            raise ProjectDeploymentError('SOURCE_LIMIT', 'The source export manifest is oversized.')
        manifest = json.loads(self._source_file(root, 'manifest.json', size))
        if (not isinstance(manifest, dict) or manifest.get('version') != 1
                or manifest.get('projectId') != request['projectId'] or manifest.get('commit') != request['targetCommit']
                or not DIGEST.fullmatch(str(manifest.get('revision', ''))) or not isinstance(manifest.get('entries'), dict)):
            raise ProjectDeploymentError('SOURCE_MISMATCH', 'The trusted export does not match this exact project and published commit.')
        entries, total = manifest['entries'], 0
        if not 1 <= len(entries) <= 5000:
            raise ProjectDeploymentError('SOURCE_LIMIT', 'The application source file count exceeds its limit.')
        for name, entry in entries.items():
            if (not isinstance(name, str) or '\\' in name or name.startswith('/')
                    or any(part in ('', '.', '..', '.git', 'node_modules') for part in name.split('/'))
                    or any(ord(char) < 32 for char in name) or '%' in name
                    or name == '.env' or name.startswith('.env.') and name != '.env.example'
                    or not isinstance(entry, dict) or entry.get('kind') != 'file'
                    or entry.get('mode') not in ('100644', '100755') or not DIGEST.fullmatch(str(entry.get('sha256', '')))
                    or type(entry.get('size')) is not int or not 0 <= entry['size'] <= 16 * 1024 * 1024):
                raise ProjectDeploymentError('SOURCE_INVALID', 'The exported application contains an unsupported path or file.')
            total += entry['size']
        if total > 64 * 1024 * 1024:
            raise ProjectDeploymentError('SOURCE_LIMIT', 'The application source byte count exceeds its limit.')
        canonical = {name: entries[name] for name in sorted(entries)}
        if hashlib.sha256(json.dumps(canonical, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest() != manifest['revision']:
            raise ProjectDeploymentError('SOURCE_MISMATCH', 'The exported source revision does not match its complete manifest.')
        required = {'node': 'server.js', 'python': 'app.py', 'static': 'index.html'}[request['runtime']]
        if required not in entries or request['runtime'] == 'static' and 'healthz' not in entries:
            raise ProjectDeploymentError('ENTRYPOINT_MISSING', 'The project lacks its registered fixed entrypoint or static health document.')
        return root, manifest

    def _dependencies(self, record, files):
        if not record.get('preparedDependenciesId'):
            package = files / 'package.json'
            if package.exists() and json.loads(package.read_text()).get('dependencies'):
                raise ProjectDeploymentError('DEPENDENCIES_REQUIRED', 'This Node project requires a sealed prepared dependency artifact.')
            return
        adapter = self.dependency_adapter
        if adapter is None:
            fixed = Path('/usr/local/libexec/praxis-deploy-discord')
            self._trusted(fixed)
            loader = importlib.machinery.SourceFileLoader('praxis_fixed_dependency_deployer', str(fixed))
            specification = importlib.util.spec_from_loader(loader.name, loader)
            module = importlib.util.module_from_spec(specification)
            loader.exec_module(module)
            adapter = module.Deployment
        # Keep extraction beside this pending release, not on the separate
        # journal bind mount; Linux rename rejects moves across bind mounts even
        # when both paths report the same underlying st_dev.
        dependency_state = files.parent / '.dependency-state'
        worker = adapter(repository=files, state=self.state, dependency_state=dependency_state,
                         expected_uid=self.expected_uid)
        def hashes(_commit):
            return {key: hashlib.sha256((files / name).read_bytes()).hexdigest() if (files / name).exists() else None
                    for name, key in [('package.json', 'packageJsonSha256'), ('package-lock.json', 'packageLockSha256'),
                                      ('npm-shrinkwrap.json', 'shrinkwrapSha256')]}
        worker._dependency_manifest_hashes = hashes
        try:
            worker._prepare_dependencies(record)
            os.rename(dependency_state / (record['operationId'] + '.dependencies') / 'node_modules', files / 'node_modules')
        except Exception as error:
            if getattr(error, 'code', '').startswith('DEPENDENC'):
                raise ProjectDeploymentError(error.code, str(error)) from None
            raise

    def _stage(self, record):
        root, manifest = self._manifest(record['request'])
        app = self.applications / record['projectId']
        app.mkdir(mode=0o755, exist_ok=True)
        self._trusted(app, directory=True)
        os.chmod(app, 0o755)
        releases = app / 'releases'
        releases.mkdir(mode=0o755, exist_ok=True)
        self._trusted(releases, directory=True)
        os.chmod(releases, 0o755)
        release = releases / record['targetCommit']
        attestation = {'commit': record['targetCommit'], 'revision': manifest['revision'],
                       'preparedDependenciesId': record.get('preparedDependenciesId'), 'runtime': record['runtime']}
        if release.exists():
            self._trusted(release, directory=True)
            self._trusted(release / 'manifest.json')
            if json.loads((release / 'manifest.json').read_text()) != attestation:
                raise ProjectDeploymentError('RELEASE_CONFLICT', 'This commit already has a different immutable deployment environment.')
            return
        self._storage_budget(app, sum(entry['size'] for entry in manifest['entries'].values()), bool(record.get('preparedDependenciesId')))
        pending = releases / ('.preparing-' + record['operationId'])
        if pending.exists():
            raise ProjectDeploymentError('PREPARATION_INTERRUPTED', 'An incomplete source stage exists; no activation was attempted.')
        pending.mkdir(mode=0o755)
        os.chmod(pending, 0o755)
        files = pending / 'files'
        files.mkdir(mode=0o755)
        os.chmod(files, 0o755)
        for name, entry in manifest['entries'].items():
            data = self._source_file(root / 'files', name, entry['size'])
            if hashlib.sha256(data).hexdigest() != entry['sha256']:
                raise ProjectDeploymentError('SOURCE_CHANGED', 'Exported source bytes no longer match the trusted manifest.')
            destination = files / name
            destination.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            parent = destination.parent
            while parent != files:
                os.chmod(parent, 0o755)
                parent = parent.parent
            self._write(destination, data, 0o755 if entry['mode'] == '100755' else 0o644)
        if record['runtime'] == 'node':
            self._dependencies(record, files)
        self._write(pending / 'manifest.json', json.dumps(attestation, sort_keys=True).encode(), 0o644)
        os.rename(pending, release)
        directory = os.open(releases, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def _storage_budget(self, app, source_bytes, has_dependencies):
        def size(root):
            total = 0
            for base, directories, files in os.walk(root, followlinks=False):
                directories[:] = [name for name in directories if not (Path(base) / name).is_symlink()]
                for name in files:
                    total += (Path(base) / name).lstat().st_size
            return total
        # Artifact extraction is bounded separately. Reserve its maximum expanded
        # size plus temporary archive space before touching application releases.
        retained_addition = source_bytes + (1024 * 1024 * 1024 if has_dependencies else 0)
        peak_addition = retained_addition + (512 * 1024 * 1024 if has_dependencies else 0)
        if size(app) + retained_addition > 2 * 1024 * 1024 * 1024 or size(self.applications) + retained_addition > 6 * 1024 * 1024 * 1024:
            raise ProjectDeploymentError('RELEASE_STORAGE_LIMIT', 'Managed application release retention reached its bounded storage budget.')
        if shutil.disk_usage(self.applications).free < peak_addition + 1024 * 1024 * 1024:
            raise ProjectDeploymentError('INSUFFICIENT_DEPLOYMENT_SPACE', 'The deployment would consume the host free-space reserve.')

    def _unit(self, record):
        project, port = record['projectId'], record['port']
        current = self.applications / project / 'current'
        identity = 'pxapp-' + hashlib.sha256(project.encode()).hexdigest()[:20]
        command = {'node': '/usr/bin/node server.js', 'python': '/usr/bin/python3 app.py',
                   'static': f'/usr/bin/python3 -I -m http.server {port} --bind 127.0.0.1 --directory {current}'}[record['runtime']]
        return f'''[Unit]
Description=Praxis application {project}
After=network-online.target
[Service]
Type=simple
DynamicUser=yes
User={identity}
WorkingDirectory={current}
ExecStart={command}
Environment=PORT={port}
Environment=NODE_ENV=production
UMask=0077
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
KillMode=control-group
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
InaccessiblePaths=-/opt -/etc/letsencrypt -/srv/apocrypha
InaccessiblePaths=-/etc/praxis-code -/etc/praxis-control -/etc/praxis-git -/etc/praxis-probe -/etc/praxis-updater
InaccessiblePaths=-/var/lib/praxis-bootstrap -/var/lib/praxis-code -/var/lib/praxis-code-disk -/var/lib/praxis-control -/var/lib/praxis-deploy -/var/lib/praxis-git -/var/lib/praxis-probe -/var/lib/praxis-stage -/var/lib/praxis-updater
InaccessiblePaths=-/srv/praxis-app -/srv/praxis-code -/srv/praxis-control -/srv/praxis-git-exchange -/srv/praxis-probe -/srv/praxis-qualification -/srv/praxis-qualified -/srv/praxis-stage
InaccessiblePaths=-/run/praxis-code -/run/praxis-control -/run/praxis-dependencies -/run/praxis-git -/run/praxis-registry -/run/praxis-registry-relay
TemporaryFileSystem=/tmp:rw,size=64M,mode=1777 /var/tmp:rw,size=16M,mode=1777
ReadWritePaths=/tmp /var/tmp
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectProc=invisible
RestrictSUIDSGID=yes
RestrictRealtime=yes
LockPersonality=yes
CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SocketBindDeny=any
SocketBindAllow=ipv4:tcp:{port}
SocketBindAllow=ipv6:tcp:{port}
MemoryMax=256M
CPUQuota=25%
TasksMax=64
LimitNOFILE=1024
StandardOutput=journal
StandardError=journal
LogRateLimitIntervalSec=30s
LogRateLimitBurst=1000
[Install]
WantedBy=multi-user.target
'''.encode()

    def _route(self, record):
        project, port = record['projectId'], record['port']
        return f'''# Root-managed fixed Praxis application route.
location = /apps/{project} {{ return 308 /apps/{project}/; }}
location ^~ /apps/{project}/ {{
    proxy_pass http://127.0.0.1:{port}/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header Connection "";
    proxy_read_timeout 30s;
    client_max_body_size 1m;
    access_log off;
}}
'''.encode()

    def _health(self, record, public=False):
        if public:
            argv = ['/usr/bin/curl', '--noproxy', '*', '--resolve', 'praxis-apps.jensenabler.com:443:127.0.0.1',
                    '--fail', '--silent', '--show-error', '--max-time', '3', '--output', '/dev/null',
                    PUBLIC_ORIGIN + '/apps/' + record['projectId'] + '/healthz']
        else:
            argv = ['/usr/bin/curl', '--noproxy', '*', '--fail', '--silent', '--show-error', '--max-time', '3',
                    '--output', '/dev/null', 'http://127.0.0.1:' + str(record['port']) + '/healthz']
        self._run(argv, timeout=5)

    def _observe(self, record, public=False):
        after = self._service(record['projectId'])
        if (not self._active(after) or after.get('InvocationID') == record['serviceBefore'].get('InvocationID')
                or self._head(record['projectId']) != record['targetCommit']):
            raise ProjectDeploymentError('ACTIVATION_UNCONFIRMED', 'The new application service invocation is not confirmed.')
        identity = after['InvocationID']
        readiness = time.monotonic() + self.ready_seconds
        while True:
            try:
                self._health(record, public=public)
                break
            except ProjectDeploymentError:
                if time.monotonic() >= readiness or self._service(record['projectId']).get('InvocationID') != identity:
                    raise
                time.sleep(min(0.5, max(0, readiness - time.monotonic())))
        deadline = time.monotonic() + self.grace_seconds
        while True:
            self._health(record, public=public)
            if time.monotonic() >= deadline:
                break
            time.sleep(min(0.5, max(0, deadline - time.monotonic())))
            if self._service(record['projectId']).get('InvocationID') != identity:
                raise ProjectDeploymentError('ACTIVATION_UNSTABLE', 'The application restarted during its bounded health observation.')
        after = self._service(record['projectId'])
        if not self._active(after) or after.get('InvocationID') != identity:
            raise ProjectDeploymentError('ACTIVATION_UNSTABLE', 'The application exited during its health observation.')
        return after

    def _recover(self, record):
        if record['phase'] in ('completed', 'failed', 'prepared') or record.get('resolvedBy'):
            return record
        if record['phase'] == 'uncertain':
            if record.get('uncertainPhase') not in ('activation_intent', 'restart_intent', 'route_intent'):
                return record
            record = {**record, 'phase': record['uncertainPhase']}
        head = self._head(record['projectId'])
        if record['phase'] == 'activation_intent':
            if head == record['targetCommit']:
                return self._save(record, 'activated', recoveredActivation=True)
            if head == record['expectedHead']:
                return self._save(record, 'prepared', recoveredNoActivationEffect=True)
        if record['phase'] == 'activated' and head == record['targetCommit']:
            return record
        if record['phase'] == 'restart_intent':
            try:
                after = self._observe(record)
                return self._save(record, 'service_ready', serviceAfter=after, recoveredService=True)
            except ProjectDeploymentError:
                pass
        if record['phase'] == 'service_ready' and head == record['targetCommit']:
            return record
        if record['phase'] == 'route_intent':
            try:
                after = self._observe(record, public=True)
                return self._save(record, 'completed', serviceAfter=after, completedAt=utc(),
                                  url=PUBLIC_ORIGIN + '/apps/' + record['projectId'] + '/',
                                  health={'kind': 'https-healthz-and-process-stability', 'observedSeconds': self.grace_seconds})
            except ProjectDeploymentError:
                pass
        return self._save(record, 'uncertain', uncertainPhase=record['phase'], error={'code': 'DEPLOYMENT_AMBIGUOUS',
                          'message': 'The saved intent has no conclusive observed outcome; no restart or reload was repeated.'})

    def handle(self, request):
        request = validate(request)
        with self._locked():
            if request['action'] == 'status' and 'operationId' not in request:
                registry = self._registry().get(request['projectId'])
                return {'projectId': request['projectId'], 'currentHead': self._head(request['projectId']),
                        'registered': registry is not None, 'service': self._service(request['projectId']) if registry else None,
                        'url': PUBLIC_ORIGIN + '/apps/' + request['projectId'] + '/' if registry else None}
            record = self._load(request['operationId'])
            if record and record['projectId'] != request['projectId']:
                raise ProjectDeploymentError('OPERATION_NOT_FOUND', 'The operation does not belong to this project.')
            if request['action'] == 'status':
                if not record:
                    raise ProjectDeploymentError('OPERATION_NOT_FOUND', 'The project operation was not found.')
                return self._recover(record)
            if record:
                if record['request'] != request:
                    raise ProjectDeploymentError('IDEMPOTENCY_CONFLICT', 'The project operation has different saved inputs.')
                record = self._recover(record)
                if record['phase'] in TERMINAL:
                    return record
            else:
                journals = [path for path in self.state.glob('*.json') if path.name != 'registry.json']
                if len(journals) >= 500:
                    raise ProjectDeploymentError('RETENTION_LIMIT', 'Project operation retention is full.')
                for path in journals:
                    prior = self._load(path.stem)
                    if (prior['projectId'] == request['projectId'] and prior['phase'] not in ('completed', 'failed')
                            and not prior.get('resolvedBy') and prior['operationId'] != request.get('recoverOperationId')):
                        raise ProjectDeploymentError('DEPLOYMENT_BUSY', 'The project has an incomplete or uncertain deployment.')
                if request.get('recoverOperationId'):
                    prior = self._load(request['recoverOperationId'])
                    if (not prior or prior['projectId'] != request['projectId'] or prior['phase'] not in ('failed', 'uncertain')
                            or prior.get('resolvedBy') or prior['targetCommit'] != request['expectedHead']):
                        raise ProjectDeploymentError('RECOVERY_REFERENCE_INVALID', 'Recovery requires an unresolved failed or uncertain deployment at the exact expected head.')
                record = {**request, 'request': request, 'phase': 'prepared', 'createdAt': utc()}
                self._save(record)
            try:
                if record['phase'] == 'prepared':
                    if self._head(record['projectId']) != record['expectedHead']:
                        raise ProjectDeploymentError('DEPLOYMENT_CONFLICT', 'Current application HEAD differs from expectedHead.')
                    registration = self._allocate(record['projectId'], record['runtime'])
                    self._save(record, port=registration['port'])
                    self._stage(record)
                    before = self._service(record['projectId'])
                    self._save(record, serviceBefore=before)
                    unit = self.units / self._service_name(record['projectId'])
                    if unit.exists():
                        self._trusted(unit)
                        if unit.read_bytes() != self._unit(record):
                            raise ProjectDeploymentError('SERVICE_CONFIGURATION_CHANGED', 'The managed app unit differs from its fixed contract.')
                    else:
                        self._write(unit, self._unit(record), 0o644)
                    self._run(['/usr/bin/systemctl', 'daemon-reload'])
                    self._run(['/usr/bin/systemctl', 'enable', self._service_name(record['projectId'])])
                    if self._head(record['projectId']) != record['expectedHead']:
                        raise ProjectDeploymentError('DEPLOYMENT_CONFLICT', 'The application release pointer changed during preparation.')
                    if record.get('recoverOperationId'):
                        prior = self._load(record['recoverOperationId'])
                        self._save(prior, resolvedBy=record['operationId'], resolution='explicit-new-deployment-recovery')
                    self._save(record, 'activation_intent', activationIntentAt=utc())
                    app = self.applications / record['projectId']
                    temporary = app / ('.current-' + record['operationId'])
                    desired = 'releases/' + record['targetCommit'] + '/files'
                    if temporary.exists() or temporary.is_symlink():
                        if not temporary.is_symlink() or temporary.lstat().st_uid != self.expected_uid or os.readlink(temporary) != desired:
                            raise ProjectDeploymentError('UNTRUSTED_PATH', 'An unexpected temporary release pointer exists.')
                    else:
                        temporary.symlink_to(desired)
                    os.replace(temporary, app / 'current')
                    directory = os.open(app, os.O_RDONLY | os.O_DIRECTORY)
                    try:
                        os.fsync(directory)
                    finally:
                        os.close(directory)
                    self._save(record, 'activated')
                if record['phase'] == 'activated':
                    if self._service(record['projectId']).get('InvocationID') != record['serviceBefore'].get('InvocationID'):
                        raise ProjectDeploymentError('SERVICE_CHANGED', 'The app service changed before intended activation.')
                    self._save(record, 'restart_intent')
                    self._run(['/usr/bin/systemctl', 'restart', self._service_name(record['projectId'])], timeout=60)
                    after = self._observe(record)
                    self._save(record, 'service_ready', serviceAfter=after)
                if record['phase'] == 'service_ready':
                    route = self.routes / (record['projectId'] + '.conf')
                    route_existed = route.exists()
                    if route.exists():
                        self._trusted(route)
                        if route.read_bytes() != self._route(record):
                            raise ProjectDeploymentError('ROUTE_CONFIGURATION_CHANGED', 'The app route differs from its registered contract.')
                    self._write(route, self._route(record), 0o644)
                    try:
                        self._run(['/usr/sbin/nginx', '-t'])
                    except ProjectDeploymentError:
                        if not route_existed:
                            route.unlink()  # This request's fixed newly-created include only.
                        raise ProjectDeploymentError('ROUTE_VALIDATION_FAILED', 'nginx configuration validation failed; no reload was attempted.') from None
                    self._save(record, 'route_intent')
                    self._run(['/usr/bin/systemctl', 'reload', 'nginx'], timeout=30)
                    after = self._observe(record, public=True)
                    return self._save(record, 'completed', completedAt=utc(), serviceAfter=after,
                                      url=PUBLIC_ORIGIN + '/apps/' + record['projectId'] + '/',
                                      health={'kind': 'https-healthz-and-process-stability', 'observedSeconds': self.grace_seconds})
            except ProjectDeploymentError as error:
                phase = 'uncertain' if record['phase'] in ('activation_intent', 'restart_intent', 'route_intent') else 'failed'
                return self._save(record, phase, uncertainPhase=record['phase'] if phase == 'uncertain' else None,
                                  error={'code': error.code, 'message': str(error)})
            except (OSError, ValueError, TypeError):
                phase = 'uncertain' if record['phase'] in ('activation_intent', 'restart_intent', 'route_intent') else 'failed'
                return self._save(record, phase, uncertainPhase=record['phase'] if phase == 'uncertain' else None, error={'code': 'DEPLOYMENT_IO_FAILED',
                                  'message': 'A bounded deployment file or metadata operation failed; no private path or content was returned.'})


def main():
    try:
        if os.geteuid() != 0 or len(sys.argv) != 1:
            raise ProjectDeploymentError('FORBIDDEN', 'Use the fixed installed helper without command-line arguments.')
        data = sys.stdin.buffer.read(8193)
        if len(data) > 8192:
            raise ProjectDeploymentError('INVALID_ARGUMENT', 'The project deployment request is oversized.')
        result = ProjectDeployment().handle(json.loads(data))
        print(json.dumps({'ok': True, 'data': result}, separators=(',', ':')))
        return 0
    except ProjectDeploymentError as error:
        print(json.dumps({'ok': False, 'code': error.code, 'message': str(error)}, separators=(',', ':')))
    except Exception:
        print(json.dumps({'ok': False, 'code': 'DEPLOYMENT_INTERNAL_ERROR',
                          'message': 'No confirmed project deployment result was returned. Inspect the saved operation.'}, separators=(',', ':')))
    return 1


if __name__ == '__main__':
    sys.exit(main())
