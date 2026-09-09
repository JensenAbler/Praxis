#!/usr/bin/python3 -I
"""Narrow, root-owned podcast-discord deployment entrypoint.

Install this file outside a worker-writable release and grant praxis-git sudo for
this executable with NO command-line arguments. All deployment choices are fixed
here; stdin can select only an operation UUID and two exact commit IDs. Candidate
scripts, hooks, dependency installers, and health commands never run as helper
steps. The already-authorized production service runs its normal bot entrypoint.
"""
import contextlib
import datetime
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
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


class DeploymentError(Exception):
    def __init__(self, code, message, exit_code=None):
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def validate_request(value):
    if not isinstance(value, dict) or value.get('action') not in ('apply', 'status'):
        raise DeploymentError('INVALID_ARGUMENT', 'action must be apply or status.')
    allowed = {'action', 'operationId'}
    if value['action'] == 'apply':
        allowed |= {'expectedHead', 'targetCommit'}
    if set(value) - allowed:
        raise DeploymentError('INVALID_ARGUMENT', 'Unexpected deployment fields.')
    if value['action'] == 'apply' and set(value) != allowed:
        raise DeploymentError('INVALID_ARGUMENT', 'apply requires operationId, expectedHead, and targetCommit.')
    if 'operationId' in value:
        try:
            if str(uuid.UUID(value['operationId'])) != value['operationId']:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise DeploymentError('INVALID_ARGUMENT', 'operationId must be a canonical UUID.') from None
    for key in ('expectedHead', 'targetCommit'):
        if key in value and (not isinstance(value[key], str) or not COMMIT.fullmatch(value[key])):
            raise DeploymentError('INVALID_ARGUMENT', 'Commit IDs must contain exactly 40 lowercase hexadecimal characters.')
    return value


class Deployment:
    """Constructor injection is used only by offline tests; the CLI is fixed."""

    def __init__(self, repository=REPOSITORY, state=STATE, origin=ORIGIN,
                 unit=UNIT, expected_uid=0, grace_seconds=5):
        self.repository = Path(repository)
        self.state = Path(state)
        self.origin = origin
        self.unit = unit
        self.expected_uid = expected_uid
        self.grace_seconds = grace_seconds
        self.lock_fd = None

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
        if not self._active(service):
            raise DeploymentError('SERVICE_NOT_ACTIVE', 'The managed podcast-discord service must be active before deployment.')
        self._git('fetch', '--no-tags', '--no-recurse-submodules', self.origin, 'refs/heads/main')
        remote_head = self._git('rev-parse', '--verify', 'FETCH_HEAD^{commit}').decode().strip()
        # Deploy the intended tip, never silently a later or earlier main commit.
        if remote_head != record['targetCommit']:
            raise DeploymentError('REMOTE_HEAD_CHANGED', 'Published main differs from targetCommit; inspect the published revision before deploying.')
        self._git('merge-base', '--is-ancestor', record['expectedHead'], record['targetCommit'])
        changed = self._git('diff', '--name-only', '--no-renames', '-z', record['expectedHead'], record['targetCommit']).split(b'\0')
        changed = [name for name in changed if name]
        if any(name in (b'package.json', b'package-lock.json', b'npm-shrinkwrap.json', b'.npmrc') for name in changed):
            raise DeploymentError('DEPENDENCY_CHANGE_UNSUPPORTED', 'This deployment path preserves installed dependencies; dependency manifest changes need a prepared deployment environment.')
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
        return self._save(record, 'prepared', serviceBefore=service, remoteHead=remote_head,
                          changedFiles=len(changed), preflightAt=utc())

    def handle(self, request):
        request = validate_request(request)
        with self._locked():
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
                if any(record[key] != request[key] for key in ('expectedHead', 'targetCommit')):
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
                    if previous and previous['phase'] not in ('completed', 'failed'):
                        raise DeploymentError('DEPLOYMENT_BUSY', 'Another deployment is incomplete or uncertain; recover that operation first.')
                record = {'operationId': request['operationId'], 'expectedHead': request['expectedHead'],
                          'targetCommit': request['targetCommit'], 'createdAt': utc(), 'phase': 'prepared'}
                self._save(record)
            try:
                if record['phase'] == 'prepared':
                    self._preflight(record)
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
                        self._git('update-ref', '-m', 'Praxis fast-forward deployment',
                                  'refs/heads/main', record['targetCommit'], record['expectedHead'])
                        self._git('read-tree', '-m', '-u', record['expectedHead'], record['targetCommit'])
                    if self._head() != record['targetCommit'] or not self._clean():
                        raise DeploymentError('CHECKOUT_UNCONFIRMED', 'The fast-forward checkout could not be confirmed.')
                    self._save(record, 'checkout_updated', checkoutUpdatedAt=utc())
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
                phase = 'uncertain' if record['phase'] in ('checkout_intent', 'restart_intent') else 'failed'
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
