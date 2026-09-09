#!/usr/bin/python3 -I
"""Narrow, root-owned podcast-discord deployment entrypoint.

Install this file outside a worker-writable release and grant praxis-git sudo for
this executable with NO command-line arguments. All deployment choices are fixed
here; stdin selects bounded observations, exact revisions and recorded operations. Candidate
scripts, hooks, dependency installers, and health commands never run as helper
steps. The already-authorized production service runs its normal bot entrypoint.
"""
import contextlib
import datetime
import hashlib
import json
import os
from pathlib import Path
import posixpath
import re
import signal
import stat
import subprocess
import sys
import tarfile
import time
import uuid

try:
    import fcntl
except ImportError:  # Importable for static inspection on Windows.
    fcntl = None

REPOSITORY = Path('/opt/podcast-discord')
STATE = Path('/var/lib/praxis-deploy/discord')
ORIGIN = 'git@github-podcast-discord:JensenAbler/podcast-discord.git'
UNIT = 'podcast-discord.service'
COMMIT = re.compile(r'^[0-9a-f]{40}$')
TERMINAL = {'completed', 'failed', 'uncertain'}
DEPENDENCIES = Path('/srv/praxis-git-exchange/dependencies')
DEPENDENCY_ID = re.compile(r'^[0-9a-f]{64}$')
LOG = Path('/tmp/alpha-clawd-bot-stdout.log')
MAX_LOG_BYTES = 256 * 1024


class DeploymentError(Exception):
    def __init__(self, code, message, exit_code=None):
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def validate_request(value):
    if not isinstance(value, dict) or value.get('action') not in ('apply', 'status', 'diagnosis', 'history', 'restart', 'rollback'):
        raise DeploymentError('INVALID_ARGUMENT', 'Unknown fixed deployment action.')
    required = {
        'apply': {'operationId', 'expectedHead', 'targetCommit'},
        'restart': {'operationId', 'expectedHead'},
        'rollback': {'operationId', 'expectedHead', 'deploymentOperationId'},
        'status': set(), 'diagnosis': set(), 'history': set(),
    }[value['action']] | {'action'}
    optional = {
        'apply': {'preparedDependenciesId'}, 'restart': {'recoverOperationId'},
        'rollback': {'recoverOperationId'}, 'status': {'operationId'},
        'diagnosis': {'limit'}, 'history': {'limit', 'cursor'},
    }[value['action']]
    allowed = required | optional
    if set(value) - allowed:
        raise DeploymentError('INVALID_ARGUMENT', 'Unexpected deployment fields.')
    if not required <= set(value):
        raise DeploymentError('INVALID_ARGUMENT', 'Required deployment fields are missing.')
    for key in ('operationId', 'deploymentOperationId', 'recoverOperationId', 'cursor'):
        if key not in value:
            continue
        try:
            if str(uuid.UUID(value[key])) != value[key]:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise DeploymentError('INVALID_ARGUMENT', key + ' must be a canonical UUID.') from None
    for key in ('expectedHead', 'targetCommit'):
        if key in value and (not isinstance(value[key], str) or not COMMIT.fullmatch(value[key])):
            raise DeploymentError('INVALID_ARGUMENT', 'Commit IDs must contain exactly 40 lowercase hexadecimal characters.')
    if 'preparedDependenciesId' in value and (not isinstance(value['preparedDependenciesId'], str)
            or not DEPENDENCY_ID.fullmatch(value['preparedDependenciesId'])):
        raise DeploymentError('INVALID_ARGUMENT', 'preparedDependenciesId must be a SHA-256 content ID.')
    if 'limit' in value and (type(value['limit']) is not int or not 1 <= value['limit'] <= 100):
        raise DeploymentError('INVALID_ARGUMENT', 'limit must be an integer from 1 to 100.')
    return value


class Deployment:
    """Constructor injection is used only by offline tests; the CLI is fixed."""

    def __init__(self, repository=REPOSITORY, state=STATE, origin=ORIGIN,
                 unit=UNIT, expected_uid=0, grace_seconds=5, log_path=LOG,
                 dependencies=DEPENDENCIES, dependency_uid=None):
        self.repository = Path(repository)
        self.state = Path(state)
        self.origin = origin
        self.unit = unit
        self.expected_uid = expected_uid
        self.grace_seconds = grace_seconds
        self.lock_fd = None
        self.log_path = Path(log_path)
        self.dependencies = Path(dependencies)
        self.dependency_uid = dependency_uid

    def _trusted_path(self, path, directory=False, private=False):
        path = Path(path)
        value = path.lstat()
        kind = stat.S_ISDIR if directory else stat.S_ISREG
        if (not kind(value.st_mode) or value.st_uid != self.expected_uid
                or value.st_mode & 0o022 or (private and value.st_mode & 0o077)
                or path.resolve() != path.absolute()):
            raise DeploymentError('UNTRUSTED_PATH', 'A deployment control path has unsafe ownership or permissions.')

    @contextlib.contextmanager
    def _locked(self):
        if fcntl is None:
            raise DeploymentError('UNSUPPORTED_HOST', 'Deployment requires Linux flock.')
        self._trusted_path(self.repository.parent, directory=True)
        self._trusted_path(self.repository, directory=True)
        self._trusted_path(self.repository / '.git', directory=True)
        self._trusted_path(self.repository / '.git' / 'config')
        self.state.mkdir(mode=0o700, parents=True, exist_ok=True)
        self._trusted_path(self.state.parent, directory=True)
        self._trusted_path(self.state, directory=True, private=True)
        lock = self.state / 'deployment.lock'
        fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            self._trusted_path(lock, private=True)
            fcntl.flock(fd, fcntl.LOCK_EX)
            self.lock_fd = fd
            yield
        finally:
            self.lock_fd = None
            os.close(fd)

    def _run(self, argv, timeout=60, input_bytes=None):
        # Do not inherit caller-controlled Git, SSH, PATH, HOME, or loader flags.
        env = {'PATH': '/usr/bin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8',
               'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_SYSTEM': '/dev/null',
               'GIT_CONFIG_NOSYSTEM': '1', 'GIT_TERMINAL_PROMPT': '0',
               'GIT_SSH_COMMAND': '/usr/bin/ssh -F /root/.ssh/config -o BatchMode=yes -o StrictHostKeyChecking=yes'}
        proc = subprocess.Popen(argv, cwd=self.repository, env=env,
                                stdin=subprocess.PIPE if input_bytes is not None else subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                start_new_session=True,
                                pass_fds=(() if self.lock_fd is None else (self.lock_fd,)))
        try:
            out, _ = proc.communicate(input_bytes, timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.communicate()
            raise DeploymentError('COMMAND_TIMEOUT', 'A fixed deployment command timed out; inspect this operation before continuing.') from None
        if proc.returncode != 0:
            # Never echo stderr, configuration, URLs, source, or credential paths.
            raise DeploymentError('COMMAND_FAILED', 'A fixed deployment command failed; no automatic rollback was attempted.', proc.returncode)
        if len(out) > 8 * 1024 * 1024:
            raise DeploymentError('OUTPUT_LIMIT', 'Repository metadata exceeded the deployment inspection limit.')
        return out

    def _git(self, *args, input_bytes=None):
        return self._run(['/usr/bin/git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
                          '-c', 'credential.helper=', '-c', 'fetch.recurseSubmodules=false',
                          '-c', 'submodule.recurse=false', '-c', 'protocol.file.allow=never',
                          '-c', 'core.protectNTFS=true', *args], input_bytes=input_bytes)

    def _head(self):
        return self._git('rev-parse', '--verify', 'HEAD').decode().strip()

    def _clean(self):
        return not self._git('status', '--porcelain=v1', '-z', '--untracked-files=all')

    def _service(self):
        properties = ['LoadState', 'ActiveState', 'SubState', 'MainPID', 'InvocationID', 'Result',
                      'ExecMainCode', 'ExecMainStatus', 'ExecMainStartTimestampMonotonic',
                      'NRestarts',
                      'WorkingDirectory', 'ExecStart', 'User', 'FragmentPath']
        output = self._run(['/usr/bin/systemctl', 'show', self.unit,
                            '--property=' + ','.join(properties)]).decode()
        values = dict(line.split('=', 1) for line in output.splitlines() if '=' in line)
        if values.get('LoadState') != 'loaded':
            raise DeploymentError('SERVICE_NOT_MANAGED', 'The fixed podcast-discord service has not been adopted yet.')
        if (values.get('WorkingDirectory') != str(self.repository)
                or values.get('User') not in ('', 'root')
                or not re.search(r'path=/usr/bin/node\s*;\s*argv\[\]=/usr/bin/node bot\.js\s*;', values.get('ExecStart', ''))):
            raise DeploymentError('SERVICE_CONFIGURATION_CHANGED', 'The fixed service entrypoint no longer matches its registered deployment contract.')
        self._trusted_path(values['FragmentPath'])
        return {key: values.get(key, '') for key in properties
                if key not in ('WorkingDirectory', 'ExecStart', 'User', 'FragmentPath', 'LoadState')}

    @staticmethod
    def _active(service):
        return (service.get('ActiveState') == 'active' and service.get('SubState') == 'running'
                and service.get('MainPID', '0').isdigit() and int(service.get('MainPID', '0')) > 0
                and bool(service.get('InvocationID')))

    @staticmethod
    def _operational_event(line):
        """Export an allowlisted event vocabulary, never application free text.

        Logs contain conversation transcripts, provider bodies and credentials.
        Blacklisting secret patterns cannot safely redact that content. Unknown
        lines therefore contribute only to an omitted count; errors expose safe
        classifications and codes, never their message or stack arguments.
        """
        match = re.match(r'^\[([0-9T:.+Z-]+)\] \[([A-Z]+)\] (.*)$', line)
        if not match:
            return None
        timestamp, level, message = match.groups()
        try:
            datetime.datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
        except ValueError:
            return None
        patterns = [
            ('bot-starting', r'^Bot starting\.\.\.$'),
            ('discord-login-observed', r'^\[Bot\] Logged in as '),
            ('discord-commands-registering', r'^\[Bot\] Registering slash commands\.\.\.$'),
            ('discord-commands-registered', r'^\[Bot\] Commands registered (?:for guild |globally)'),
            ('websocket-disconnected', r'^\[Bot\] WebSocket disconnected$'),
            ('shutdown-started', r'^\[Shutdown\] SIG(?:TERM|INT) received; awaiting bot cleanup$'),
            ('shutdown-completed', r'^\[Shutdown\] SIG(?:TERM|INT): cleanup complete; exiting with code [01]$'),
            ('shutdown-timeout', r'^\[Shutdown\] SIG(?:TERM|INT): cleanup timed out after \d+ms; exiting with code 1$'),
            ('shutdown-failed', r'^\[Shutdown\] SIG(?:TERM|INT): cleanup failed;'),
            ('startup-failed', r'^Bot failed to start:'),
            ('unhandled-rejection', r'^UNHANDLED REJECTION:'),
            ('uncaught-exception', r'^UNCAUGHT EXCEPTION:'),
        ]
        event = next((name for name, pattern in patterns if re.search(pattern, message)), None)
        if event is None and level not in ('ERROR', 'FATAL', 'WARN', 'WARNING'):
            return None
        result = {'utc': timestamp, 'level': level if level in ('INFO', 'ERROR', 'FATAL', 'WARN', 'WARNING') else 'OTHER',
                  'event': event or ('application-warning' if level in ('WARN', 'WARNING') else 'application-error')}
        # Only a fixed diagnostic code vocabulary is allowed through.
        codes = re.findall(r'\b(?:ENOENT|EACCES|EPERM|EADDRINUSE|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|ENOMEM|ERR_STREAM_PREMATURE_CLOSE|ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM|ERR_SOCKET_CLOSED|ERR_INVALID_ARG_TYPE)\b', message)
        if codes:
            result['codes'] = sorted(set(codes))[:8]
        return result

    def _logs(self, limit):
        try:
            fd = os.open(self.log_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            return {'available': False, 'reason': 'log-not-created', 'events': []}
        except OSError:
            raise DeploymentError('UNTRUSTED_LOG', 'The fixed application log cannot be opened safely.') from None
        try:
            meta = os.fstat(fd)
            if not stat.S_ISREG(meta.st_mode) or meta.st_uid != self.expected_uid or meta.st_mode & 0o022:
                raise DeploymentError('UNTRUSTED_LOG', 'The fixed application log has unsafe ownership or permissions.')
            start = max(0, meta.st_size - MAX_LOG_BYTES)
            os.lseek(fd, start, os.SEEK_SET)
            data = os.read(fd, MAX_LOG_BYTES)
        finally:
            os.close(fd)
        lines = data.decode('utf-8', errors='replace').splitlines()
        if start and lines:
            lines = lines[1:]  # Never parse a partial first line as a full event.
        events = [event for line in lines if (event := self._operational_event(line)) is not None]
        return {'available': True, 'source': 'fixed-bot-stdout', 'redaction': 'operational-event-allowlist',
                'scannedBytes': len(data), 'totalBytes': meta.st_size, 'tailTruncated': bool(start),
                'omittedLines': len(lines) - len(events), 'omittedEvents': max(0, len(events) - limit),
                'events': events[-limit:]}

    def _diagnosis(self, limit):
        service = self._service()
        logs = self._logs(limit)
        started = int(service.get('ExecMainStartTimestampMonotonic') or '0') / 1_000_000
        started_wall = time.time() - time.monotonic() + started if started else None
        login = None
        for event in logs['events']:
            if event['event'] == 'discord-login-observed' and started_wall is not None:
                observed = datetime.datetime.fromisoformat(event['utc'].replace('Z', '+00:00')).timestamp()
                if started_wall <= observed <= time.time() + 5:
                    login = event['utc']
        return {'repository': 'JensenAbler/podcast-discord', 'currentHead': self._head(),
                'clean': self._clean(), 'service': service, 'logs': logs,
                'health': {'processRunning': self._active(service),
                           'discordLoginObservedForCurrentInvocation': login is not None,
                           'discordLoginObservedAt': login, 'discordConnectionVerified': False,
                           'voiceRecordingAndProviderBehaviorVerified': False,
                           'observation': 'A login log is historical evidence for this invocation, not a live Discord connectivity test.'}}

    def _history(self, limit, cursor=None):
        records = [self._load(path.stem) for path in self.state.glob('*.json')
                   if re.fullmatch(r'[0-9a-f-]{36}', path.stem)]
        records.sort(key=lambda row: (row.get('createdAt', ''), row['operationId']), reverse=True)
        if cursor is not None:
            index = next((i for i, row in enumerate(records) if row['operationId'] == cursor), None)
            if index is None:
                raise DeploymentError('INVALID_CURSOR', 'The deployment history cursor was not found.')
            records = records[index + 1:]
        keys = ('operationId', 'action', 'expectedHead', 'targetCommit', 'phase', 'createdAt', 'updatedAt',
                'completedAt', 'error', 'health', 'deploymentOperationId', 'recoverOperationId', 'resolvedBy')
        page = [{key: row[key] for key in keys if key in row} for row in records[:limit]]
        return {'operations': page, 'nextCursor': page[-1]['operationId'] if len(records) > limit else None}

    def _dependency_manifest_hashes(self, commit):
        result = {}
        for filename, key in [('package.json', 'packageJsonSha256'), ('package-lock.json', 'packageLockSha256'),
                              ('npm-shrinkwrap.json', 'shrinkwrapSha256')]:
            try:
                content = self._git('show', commit + ':' + filename)
            except DeploymentError as error:
                if error.exit_code is None:
                    raise
                content = None
            result[key] = hashlib.sha256(content).hexdigest() if content is not None else None
        return result

    def _dependency_file(self, path, maximum):
        if self.dependency_uid is None:
            import pwd
            owner = pwd.getpwnam('praxis-code').pw_uid
        else:
            owner = self.dependency_uid
        # Neither rootless commands nor candidate package scripts can reach the
        # trusted backend's artifact directory. Pin files with no-follow opens.
        parent = self.dependencies.lstat()
        if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid not in (owner, self.expected_uid)
                or parent.st_mode & 0o022 or self.dependencies.resolve() != self.dependencies.absolute()):
            raise DeploymentError('DEPENDENCIES_UNTRUSTED', 'The prepared dependency registry is not trusted.')
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        value = os.fstat(fd)
        if (not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_uid != owner or value.st_mode & 0o022
                or value.st_size > maximum):
            os.close(fd)
            raise DeploymentError('DEPENDENCIES_UNTRUSTED', 'A prepared dependency artifact is unsafe or oversized.')
        return os.fdopen(fd, 'rb')

    def _prepare_dependencies(self, record):
        artifact = record.get('preparedDependenciesId')
        if not artifact:
            return
        stage = self.state / (record['operationId'] + '.dependencies')
        ready = stage / 'ready.json'
        if ready.exists():
            self._trusted_path(stage, directory=True, private=True)
            self._trusted_path(ready, private=True)
            saved = json.loads(ready.read_text())
            if saved.get('artifactId') != artifact or saved.get('targetCommit') != record['targetCommit']:
                raise DeploymentError('DEPENDENCIES_CONFLICT', 'The prepared dependency stage belongs to another request.')
            return
        if stage.exists():
            raise DeploymentError('DEPENDENCIES_PREPARATION_INTERRUPTED', 'An incomplete dependency stage exists; no deployment effect was applied.')
        try:
            with self._dependency_file(self.dependencies / (artifact + '.json'), 65536) as source:
                manifest = json.load(source)
            if (not isinstance(manifest, dict) or manifest.get('version') != 1 or manifest.get('archiveSha256') != artifact
                    or any(manifest.get(key) != value for key, value in self._dependency_manifest_hashes(record['targetCommit']).items())):
                raise DeploymentError('DEPENDENCIES_MISMATCH', 'The prepared dependencies do not match the exact target package manifests.')
            if not manifest.get('packageLockSha256') and not manifest.get('shrinkwrapSha256'):
                raise DeploymentError('DEPENDENCIES_LOCK_REQUIRED', 'Production dependencies require a locked dependency manifest.')
            if manifest.get('platform') != 'linux' or manifest.get('arch') != 'x64':
                raise DeploymentError('DEPENDENCIES_RUNTIME_MISMATCH', 'The dependency artifact must target Linux x64.')
            node_major = self._run(['/usr/bin/node', '--version']).decode().strip().split('.')[0].lstrip('v')
            if str(manifest.get('nodeMajor')) != node_major:
                raise DeploymentError('DEPENDENCIES_RUNTIME_MISMATCH', 'The dependency artifact Node major does not match the managed runtime.')
            stage.mkdir(mode=0o700)
            archive_path = stage / 'archive.tar'
            digest = hashlib.sha256()
            copied = 0
            with self._dependency_file(self.dependencies / (artifact + '.tar'), 512 * 1024 * 1024) as source:
                with archive_path.open('xb') as destination:
                    os.chmod(archive_path, 0o600)
                    while chunk := source.read(1024 * 1024):
                        copied += len(chunk)
                        if copied > 512 * 1024 * 1024:
                            raise DeploymentError('DEPENDENCIES_ARCHIVE_LIMIT', 'The dependency archive grew beyond its bounded copy limit.')
                        digest.update(chunk)
                        destination.write(chunk)
                    destination.flush()
                    os.fsync(destination.fileno())
            if digest.hexdigest() != artifact:
                raise DeploymentError('DEPENDENCIES_HASH_MISMATCH', 'The prepared dependency archive digest does not match its ID.')
            with tarfile.open(archive_path, mode='r:') as archive:
                members, links, seen, expanded = [], set(), set(), 0
                for member in archive:
                    name = member.name.rstrip('/')
                    if (not name or '\\' in name or name.startswith('/') or '\x00' in name
                            or any(part in ('', '.', '..') for part in name.split('/'))
                            or not (name == 'node_modules' or name.startswith('node_modules/'))
                            or name in seen or not (member.isfile() or member.isdir() or member.issym())):
                        raise DeploymentError('DEPENDENCIES_ARCHIVE_INVALID', 'The dependency archive contains an unsafe entry.')
                    seen.add(name)
                    expanded += member.size
                    if len(seen) > 100000 or expanded > 1024 * 1024 * 1024 or not 0 <= member.size <= 256 * 1024 * 1024:
                        raise DeploymentError('DEPENDENCIES_ARCHIVE_LIMIT', 'The dependency archive exceeds bounded extraction limits.')
                    if member.issym():
                        target = posixpath.normpath(posixpath.join(posixpath.dirname(name), member.linkname))
                        if (member.linkname.startswith('/') or '\\' in member.linkname
                                or not target.startswith('node_modules/') or '\x00' in member.linkname):
                            raise DeploymentError('DEPENDENCIES_ARCHIVE_INVALID', 'A dependency symlink escapes node_modules.')
                        links.add(name)
                    members.append((name, member))
                if 'node_modules' in links or not members:
                    raise DeploymentError('DEPENDENCIES_ARCHIVE_INVALID', 'The dependency archive has no safe module root.')
                for name, member in members:
                    if any('/'.join(name.split('/')[:i]) in links for i in range(1, len(name.split('/')))):
                        raise DeploymentError('DEPENDENCIES_ARCHIVE_INVALID', 'A dependency entry has a symlink ancestor.')
                    if member.issym():
                        continue
                    destination = stage / name
                    destination.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                    parent = destination.parent
                    while parent != stage:
                        os.chmod(parent, 0o755)
                        parent = parent.parent
                    if member.isdir():
                        destination.mkdir(mode=0o755, exist_ok=True)
                        os.chmod(destination, 0o755)
                    else:
                        with archive.extractfile(member) as source, destination.open('xb') as out:
                            while chunk := source.read(1024 * 1024):
                                out.write(chunk)
                            out.flush()
                            os.fsync(out.fileno())
                        os.chmod(destination, 0o755 if member.mode & 0o111 else 0o644)
                module_root = stage / 'node_modules'
                module_root.mkdir(mode=0o755, exist_ok=True)
                os.chmod(module_root, 0o755)
                for name, member in members:
                    if member.issym():
                        destination = stage / name
                        destination.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                        parent = destination.parent
                        while parent != stage:
                            os.chmod(parent, 0o755)
                            parent = parent.parent
                        destination.symlink_to(member.linkname)
                for name in links:
                    try:
                        (stage / name).resolve().relative_to(module_root.resolve())
                    except (ValueError, RuntimeError):
                        raise DeploymentError('DEPENDENCIES_ARCHIVE_INVALID', 'A dependency symlink chain escapes the module root.') from None
            current = self.repository / 'node_modules'
            if current.exists() or current.is_symlink():
                self._trusted_path(current, directory=True)
            if stage.stat().st_dev != self.repository.stat().st_dev:
                raise DeploymentError('DEPENDENCIES_FILESYSTEM_MISMATCH', 'Dependency activation requires an atomic rename on the deployment filesystem.')
            ready.write_text(json.dumps({'artifactId': artifact, 'targetCommit': record['targetCommit']}))
            os.chmod(ready, 0o600)
            with ready.open('rb') as source:
                os.fsync(source.fileno())
            archive_path.unlink()  # Only this operation's verified temporary copy.
            directory = os.open(stage, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        except (FileNotFoundError, KeyError, OSError, tarfile.TarError, ValueError) as error:
            raise DeploymentError('DEPENDENCIES_UNAVAILABLE', 'The prepared dependency artifact could not be safely materialized.') from None

    def _dependency_activation(self, record):
        if not record.get('preparedDependenciesId') and not record.get('restoreDependenciesFrom'):
            return
        target_stage = (self.state / (record['operationId'] + '.dependencies') / 'node_modules'
                        if record.get('preparedDependenciesId') else
                        self.state / (record['restoreDependenciesFrom'] + '.previous-dependencies'))
        previous = self.state / (record['operationId'] + '.previous-dependencies')
        current = self.repository / 'node_modules'
        restore_empty = record.get('restoreDependenciesEmpty', False)
        if record['phase'] == 'checkout_updated':
            self._save(record, 'dependencies_intent', dependencyHadPrevious=current.exists(), dependenciesIntentAt=utc())
        # Each rename has its own durable intent. Recovery inspects both paths;
        # it never swaps again after a completed activation.
        if record['phase'] == 'dependencies_intent':
            if current.exists():
                os.rename(current, previous)
                self._sync_directories(current.parent, previous.parent)
            self._save(record, 'dependencies_previous_saved')
        if record['phase'] == 'dependencies_previous_saved':
            if not restore_empty:
                os.rename(target_stage, current)
                self._sync_directories(target_stage.parent, current.parent)
            identity = {'device': current.stat().st_dev, 'inode': current.stat().st_ino} if current.exists() else None
            self._save(record, 'dependencies_updated', dependenciesUpdatedAt=utc(), dependencyActiveIdentity=identity)

    @staticmethod
    def _sync_directories(*paths):
        for path in set(paths):
            descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)

    def _journal_path(self, operation_id):
        return self.state / (operation_id + '.json')

    def _load(self, operation_id):
        path = self._journal_path(operation_id)
        if not path.exists():
            return None
        self._trusted_path(path, private=True)
        if path.stat().st_size > 65536:
            raise DeploymentError('JOURNAL_INVALID', 'The deployment journal cannot be safely read.')
        return json.loads(path.read_text())

    def _save(self, record, phase=None, **values):
        if phase is not None:
            record['phase'] = phase
        record.update(values)
        record['updatedAt'] = utc()
        path = self._journal_path(record['operationId'])
        temporary = self.state / ('.' + record['operationId'] + '-' + str(uuid.uuid4()))
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, 'w') as out:
                json.dump(record, out, sort_keys=True)
                out.write('\n')
                out.flush()
                os.fsync(out.fileno())
            os.replace(temporary, path)
            directory = os.open(self.state, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if temporary.exists():
                temporary.unlink()
        return record

    def _service_observation(self, record):
        before = record['serviceBefore']
        after = self._service()
        # A new active systemd invocation proves the old process was replaced.
        # Preserve the same invocation throughout the bounded health window.
        if (not self._active(after) or after['InvocationID'] == before['InvocationID']
                or int(after.get('ExecMainStartTimestampMonotonic') or '0') <= int(before.get('ExecMainStartTimestampMonotonic') or '0')):
            raise DeploymentError('ACTIVATION_UNCONFIRMED', 'The replacement service invocation is not active; inspect deployment status.')
        identity = after['InvocationID']
        deadline = time.monotonic() + self.grace_seconds
        while time.monotonic() < deadline:
            time.sleep(min(0.5, max(0, deadline - time.monotonic())))
            after = self._service()
            if not self._active(after) or after['InvocationID'] != identity:
                raise DeploymentError('ACTIVATION_UNSTABLE', 'The replacement service exited or restarted during the health observation.')
        if self._head() != record['targetCommit'] or not self._clean():
            raise DeploymentError('DEPLOYMENT_DRIFT', 'The checkout changed while deployment activation was being observed.')
        return self._save(record, 'completed', serviceAfter=after, completedAt=utc(),
                          health={'kind': 'systemd-process-stability', 'observedSeconds': self.grace_seconds,
                                  'discordConnectionVerified': False})

    def _recover(self, record):
        if record['phase'] in TERMINAL:
            return record
        head = self._head()
        if record['phase'] == 'prepared':
            return record  # No checkout effect was ever scheduled.
        if record['phase'] == 'checkout_intent':
            if head == record['targetCommit'] and self._clean():
                return self._save(record, 'checkout_updated', recoveredCheckout=True)
            if head == record['expectedHead'] and self._clean() and not (self.repository / '.git' / 'index.lock').exists():
                return self._save(record, 'prepared', recoveredNoCheckoutEffect=True)
            return self._save(record, 'uncertain', error={'code': 'CHECKOUT_AMBIGUOUS',
                              'message': 'Checkout outcome is uncertain; no repeated checkout or automatic rollback was attempted.'})
        if record['phase'] == 'checkout_updated':
            if head == record['targetCommit'] and self._clean():
                return record
            return self._save(record, 'uncertain', error={'code': 'DEPLOYMENT_DRIFT',
                              'message': 'Checkout changed after its recorded update; no restart was attempted.'})
        if record['phase'] in ('dependencies_intent', 'dependencies_previous_saved', 'dependencies_updated'):
            current = self.repository / 'node_modules'
            previous = self.state / (record['operationId'] + '.previous-dependencies')
            target = (self.state / (record['operationId'] + '.dependencies') / 'node_modules'
                      if record.get('preparedDependenciesId') else
                      self.state / (record['restoreDependenciesFrom'] + '.previous-dependencies'))
            clean = head == record['targetCommit'] and self._clean()
            restored_empty = record.get('restoreDependenciesEmpty', False)
            prior_saved = previous.exists() if record['dependencyHadPrevious'] else not previous.exists()
            if clean and prior_saved and (restored_empty and not current.exists() or current.exists() and not target.exists()):
                identity = {'device': current.stat().st_dev, 'inode': current.stat().st_ino} if current.exists() else None
                if record['phase'] == 'dependencies_updated' and identity != record.get('dependencyActiveIdentity'):
                    clean = False
                else:
                    return self._save(record, 'dependencies_updated', recoveredDependencyActivation=True,
                                      dependencyActiveIdentity=identity)
            if clean and prior_saved and not current.exists() and target.exists():
                return self._save(record, 'dependencies_previous_saved', recoveredPreviousDependencies=True)
            if (clean and record['phase'] == 'dependencies_intent' and not previous.exists() and target.exists()
                    and current.exists() == record['dependencyHadPrevious']):
                return record  # Neither atomic rename occurred.
            return self._save(record, 'uncertain', error={'code': 'DEPENDENCIES_AMBIGUOUS',
                              'message': 'Dependency activation paths do not prove an exact outcome; no swap or restart was repeated.'})
        if record['phase'] == 'restart_intent':
            try:
                return self._service_observation(record)
            except DeploymentError as error:
                return self._save(record, 'uncertain', error={'code': error.code,
                                  'message': 'Restart outcome is uncertain. This operation will never issue another restart.'})
        raise DeploymentError('JOURNAL_INVALID', 'The deployment journal contains an unknown phase.')

    def _preflight(self, record):
        if self._git('symbolic-ref', '--short', 'HEAD').decode().strip() != 'main':
            raise DeploymentError('BRANCH_MISMATCH', 'The production checkout must be on main.')
        if self._head() != record['expectedHead']:
            raise DeploymentError('DEPLOYMENT_CONFLICT', 'Production HEAD differs from expectedHead; inspect it and make a new explicit deployment request.')
        if not self._clean():
            raise DeploymentError('DIRTY_DEPLOYMENT', 'The production checkout has local or untracked changes.')
        # Repository config is root-owned. Refuse executable/config-inclusion
        # extensions rather than allow new .gitattributes to activate a filter.
        names = self._git('config', '--local', '--name-only', '--list').decode().splitlines()
        if any(name.lower().startswith(('filter.', 'include.', 'includeif.', 'core.sshcommand', 'core.worktree')) for name in names):
            raise DeploymentError('UNSUPPORTED_GIT_CONFIGURATION', 'The production repository has an unsupported Git extension.')
        service = self._service()
        action = record.get('action', 'apply')
        if action == 'apply' and not self._active(service):
            raise DeploymentError('SERVICE_NOT_ACTIVE', 'The managed podcast-discord service must be active before deployment.')
        remote_head = None
        if action == 'apply':
            self._git('fetch', '--no-tags', '--no-recurse-submodules', self.origin, 'refs/heads/main')
            remote_head = self._git('rev-parse', '--verify', 'FETCH_HEAD^{commit}').decode().strip()
            # Deploy the intended tip, never silently a later or earlier main commit.
            if remote_head != record['targetCommit']:
                raise DeploymentError('REMOTE_HEAD_CHANGED', 'Published main differs from targetCommit; inspect the published revision before deploying.')
            self._git('merge-base', '--is-ancestor', record['expectedHead'], record['targetCommit'])
        changed = self._git('diff', '--name-only', '--no-renames', '-z', record['expectedHead'], record['targetCommit']).split(b'\0')
        changed = [name for name in changed if name]
        if any(name in (b'package.json', b'package-lock.json', b'npm-shrinkwrap.json', b'.npmrc') for name in changed):
            if action != 'rollback' and not record.get('preparedDependenciesId'):
                raise DeploymentError('DEPENDENCY_CHANGE_UNSUPPORTED', 'Dependency manifest changes require an exact preparedDependenciesId from a completed sandbox preparation job.')
            if action == 'rollback' and not record.get('restoreDependenciesFrom'):
                raise DeploymentError('DEPENDENCIES_ROLLBACK_UNAVAILABLE', 'This historic deployment has no retained dependency tree for rollback.')
        tree = self._git('ls-tree', '-r', '-z', record['targetCommit']).split(b'\0')
        if any(item and not item.startswith((b'100644 ', b'100755 ')) for item in tree):
            raise DeploymentError('UNSUPPORTED_TREE_ENTRY', 'Production deployment accepts regular files only, without symlinks or submodules.')
        for raw in changed:
            try:
                path = raw.decode('utf-8', errors='strict')
            except UnicodeDecodeError:
                raise DeploymentError('UNSUPPORTED_TREE_ENTRY', 'Production deployment requires UTF-8 file names.') from None
            if path == '.env' or path.startswith(('.env.', 'node_modules/')) or '/.git/' in '/' + path.lower() + '/':
                if path != '.env.example':
                    raise DeploymentError('PROTECTED_DEPLOYMENT_PATH', 'The change touches a protected runtime or credential path.')
            candidate = self.repository / path
            # Files newly tracked by the target must not overwrite ignored data.
            try:
                tracked = self._git('ls-files', '--error-unmatch', '--', path)
            except DeploymentError:
                tracked = b''
            if not tracked and (candidate.exists() or candidate.is_symlink()):
                raise DeploymentError('RUNTIME_PATH_COLLISION', 'A new tracked file collides with existing runtime data.')
        self._prepare_dependencies(record)
        return self._save(record, 'prepared', serviceBefore=service, remoteHead=remote_head,
                          changedFiles=len(changed), preflightAt=utc())

    def handle(self, request):
        request = validate_request(request)
        with self._locked():
            if request['action'] == 'history':
                return self._history(request.get('limit', 20), request.get('cursor'))
            if request['action'] == 'diagnosis':
                return self._diagnosis(request.get('limit', 40))
            if request['action'] == 'status' and 'operationId' not in request:
                try:
                    service = self._service()
                    service_error = None
                except DeploymentError as error:
                    service, service_error = None, {'code': error.code, 'message': str(error)}
                return {'repository': 'JensenAbler/podcast-discord', 'branch': 'main',
                        'currentHead': self._head(), 'clean': self._clean(), 'service': service,
                        'serviceError': service_error, 'healthKind': 'systemd-process-stability'}
            record = self._load(request['operationId'])
            if request['action'] == 'status':
                if record is None:
                    raise DeploymentError('OPERATION_NOT_FOUND', 'The deployment operation was not found.')
                return self._recover(record)
            if record is not None:
                saved_request = record.get('request', {'action': 'apply', 'operationId': record['operationId'],
                                                      'expectedHead': record['expectedHead'], 'targetCommit': record['targetCommit']})
                if saved_request != request:
                    raise DeploymentError('IDEMPOTENCY_CONFLICT', 'The deployment operation ID already has different inputs.')
                record = self._recover(record)
                if record['phase'] in TERMINAL:
                    return record
            else:
                journals = list(self.state.glob('*.json'))
                if len(journals) >= 1000:
                    raise DeploymentError('RETENTION_LIMIT', 'Deployment operation retention is full; an operator must archive records.')
                for path in journals:
                    previous = self._load(path.stem)
                    if (previous and previous['phase'] not in ('completed', 'failed') and not previous.get('resolvedBy')
                            and previous['operationId'] != request.get('recoverOperationId')):
                        raise DeploymentError('DEPLOYMENT_BUSY', 'Another deployment is incomplete or uncertain; recover that operation first.')
                if request.get('recoverOperationId'):
                    previous = self._load(request['recoverOperationId'])
                    if (not previous or previous['phase'] not in ('failed', 'uncertain')
                            or previous.get('resolvedBy') or previous.get('targetCommit') != request['expectedHead']
                            or not previous.get('restartIntentAt')):
                        raise DeploymentError('RECOVERY_REFERENCE_INVALID', 'Explicit recovery must reference an unresolved activation attempt at expectedHead.')
                target = request.get('targetCommit', request['expectedHead'])
                source = None
                if request['action'] == 'rollback':
                    source = self._load(request['deploymentOperationId'])
                    if (not source or source.get('action', 'apply') != 'apply'
                            or source.get('targetCommit') != request['expectedHead']
                            or not source.get('checkoutUpdatedAt') or not source.get('restartIntentAt')):
                        raise DeploymentError('ROLLBACK_REFERENCE_INVALID', 'Rollback requires a recorded deployment activation at the exact current head.')
                    target = source['expectedHead']
                    if target == request['expectedHead']:
                        raise DeploymentError('ROLLBACK_NOT_AVAILABLE', 'This deployment did not change the source revision; use explicit restart recovery.')
                record = {'operationId': request['operationId'], 'expectedHead': request['expectedHead'],
                          'targetCommit': target, 'createdAt': utc(), 'phase': 'prepared',
                          'action': request['action'], 'request': request}
                for key in ('deploymentOperationId', 'recoverOperationId', 'preparedDependenciesId'):
                    if key in request:
                        record[key] = request[key]
                if source and source.get('preparedDependenciesId'):
                    previous_dependencies = self.state / (source['operationId'] + '.previous-dependencies')
                    if source.get('dependencyHadPrevious'):
                        if not previous_dependencies.exists():
                            raise DeploymentError('DEPENDENCIES_ROLLBACK_UNAVAILABLE', 'The recorded previous dependency tree is no longer retained.')
                        self._trusted_path(previous_dependencies, directory=True)
                    record['restoreDependenciesFrom'] = source['operationId']
                    record['restoreDependenciesEmpty'] = not source.get('dependencyHadPrevious')
                self._save(record)
            try:
                if record['phase'] == 'prepared':
                    self._preflight(record)
                    if record.get('recoverOperationId'):
                        previous = self._load(record['recoverOperationId'])
                        self._save(previous, resolvedBy=record['operationId'], resolution='explicit-new-recovery-operation')
                    if record['targetCommit'] == record['expectedHead']:
                        self._save(record, 'checkout_updated', checkoutAlreadyCurrent=True)
                    else:
                        # Compare again after network I/O, immediately before checkout.
                        if self._head() != record['expectedHead'] or not self._clean():
                            raise DeploymentError('DEPLOYMENT_CONFLICT', 'Production changed during deployment preflight.')
                        self._save(record, 'checkout_intent', checkoutIntentAt=utc())
                        # update-ref supplies a true compare-and-swap against an
                        # external operator's concurrent Git update. read-tree then
                        # performs Git's protected two-tree checkout. A crash between
                        # them leaves an explicit uncertain operation, never a reset.
                        self._git('update-ref', '-m', 'Praxis ' + record.get('action', 'apply') + ' deployment',
                                  'refs/heads/main', record['targetCommit'], record['expectedHead'])
                        self._git('read-tree', '-m', '-u', record['expectedHead'], record['targetCommit'])
                    if self._head() != record['targetCommit'] or not self._clean():
                        raise DeploymentError('CHECKOUT_UNCONFIRMED', 'The fast-forward checkout could not be confirmed.')
                    self._save(record, 'checkout_updated', checkoutUpdatedAt=utc())
                self._dependency_activation(record)
                # A resumed completed checkout can restart only if no restart was
                # ever intended, and the original service invocation is intact.
                current = self._service()
                if current['InvocationID'] != record['serviceBefore']['InvocationID']:
                    raise DeploymentError('SERVICE_CHANGED', 'The service changed after checkout; inspect before issuing a new deployment.')
                if (self._head() != record['targetCommit'] or not self._clean()
                        or self._git('symbolic-ref', '--short', 'HEAD').decode().strip() != 'main'):
                    raise DeploymentError('DEPLOYMENT_DRIFT', 'The checkout changed before activation; no restart was attempted.')
                self._save(record, 'restart_intent', restartIntentAt=utc())
                try:
                    self._run(['/usr/bin/systemctl', 'restart', self.unit], timeout=90)
                except DeploymentError as error:
                    if error.exit_code is not None:
                        # A returned failure is a known terminal result. Retain
                        # the target checkout and report failed activation.
                        return self._save(record, 'failed', activationFailed=True,
                                          error={'code': 'SERVICE_RESTART_FAILED',
                                                 'message': 'systemctl restart returned failure; the target checkout is preserved and was not rolled back.'})
                    raise
                return self._service_observation(record)
            except DeploymentError as error:
                phase = 'uncertain' if record['phase'] in ('checkout_intent', 'restart_intent', 'dependencies_intent', 'dependencies_previous_saved') else 'failed'
                return self._save(record, phase, error={'code': error.code, 'message': str(error)})


def main():
    try:
        if os.geteuid() != 0 or len(sys.argv) != 1:
            raise DeploymentError('FORBIDDEN', 'Use the installed deployment helper without command-line arguments.')
        raw = sys.stdin.buffer.read(4097)
        if len(raw) > 4096:
            raise DeploymentError('INVALID_ARGUMENT', 'Deployment request exceeds 4096 bytes.')
        result = Deployment().handle(json.loads(raw))
        print(json.dumps({'ok': True, 'data': result}, separators=(',', ':')))
    except DeploymentError as error:
        print(json.dumps({'ok': False, 'code': error.code, 'message': str(error)}, separators=(',', ':')))
        return 1
    except Exception:
        print(json.dumps({'ok': False, 'code': 'DEPLOYMENT_INTERNAL_ERROR',
                          'message': 'Deployment did not return a confirmed result. Recover its operation before continuing.'}, separators=(',', ':')))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
