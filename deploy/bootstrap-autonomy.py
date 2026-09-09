#!/usr/bin/python3
"""Owner bootstrap only; never callable by candidate application code.

Install a qualified release's frozen control components and initial application
slot. Inputs are a root-owned prepared release and its root-owned acceptance.
"""
import contextlib
import hashlib
import importlib.util
import json
import os
import pathlib
try:
    import pwd
    import grp
except ImportError:  # Static inspection and test discovery on Windows.
    pwd = grp = None
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import time
import uuid

FENCE = pathlib.Path('/var/lib/praxis-control/activation.json')
ADMISSION_GATE = pathlib.Path('/var/lib/praxis-control/bootstrap-in-progress')
ADMISSION_DROPIN = pathlib.Path('/etc/systemd/system/praxis-probe.service.d/bootstrap-admission.conf')
MOUNT_UNIT = 'srv-praxis\\x2dstage.mount'
CORE_UNITS = ['praxis-probe.service', 'praxis-code.service', 'praxis-git.service']
ISOLATED_UNITS = ['praxis-updater.service', 'praxis-dependencies.service', MOUNT_UNIT]


def run(args, **kwargs):
    kwargs.setdefault('check', True)
    kwargs.setdefault('text', True)
    return subprocess.run(args, **kwargs)


def install_text(path, text, mode=0o644):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink(): raise RuntimeError('Refusing linked bootstrap target')
    temporary = path.parent / ('.bootstrap-' + str(uuid.uuid4()))
    fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, 'wb') as out:
            os.fchmod(out.fileno(), mode)
            os.fchown(out.fileno(), 0, 0)
            out.write(text.encode() if isinstance(text, str) else text)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, path)
        descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(descriptor)
        finally: os.close(descriptor)
    finally:
        if temporary.exists(): temporary.unlink()


def install_json(path, data, mode=0o640, group=None):
    install_text(path, json.dumps(data, indent=2) + '\n', mode)
    if group: os.chown(path, 0, grp.getgrnam(group).gr_gid)


def private_directory(path, owner='root', group='root', mode=0o700):
    path = pathlib.Path(path)
    if path.is_symlink(): raise RuntimeError('Refusing linked bootstrap directory')
    path.mkdir(parents=True, exist_ok=True)
    os.chown(path, pwd.getpwnam(owner).pw_uid, grp.getgrnam(group).gr_gid)
    os.chmod(path, mode)


def accepted_tree(root):
    """Compute the acceptance format without importing any candidate module."""
    entries, total = {}, 0
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root)
        if any(part in ('.git', '.ssh') or part == '.env' or part.startswith('.env.') for part in relative.parts):
            raise RuntimeError('Prepared release contains a protected path.')
        info = path.lstat()
        if info.st_uid != 0 or not path.is_symlink() and info.st_mode & 0o022:
            raise RuntimeError('Prepared release must be root-owned and immutable to other users.')
        if stat.S_ISDIR(info.st_mode): continue
        if stat.S_ISLNK(info.st_mode):
            if not relative.as_posix().startswith('node_modules/') or not path.resolve(strict=True).is_relative_to(root / 'node_modules'):
                raise RuntimeError('Prepared dependency link escapes the accepted tree.')
            entries[relative.as_posix()] = {'link': os.readlink(path)}
            continue
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise RuntimeError('Prepared release contains a special or hard-linked file.')
        total += info.st_size
        if total > 1024 * 1024 * 1024 or len(entries) >= 100000:
            raise RuntimeError('Prepared release exceeds bounded source limits.')
        digest = hashlib.sha256()
        with path.open('rb') as source:
            while chunk := source.read(1024 * 1024): digest.update(chunk)
        entries[relative.as_posix()] = {'sha256': digest.hexdigest(), 'bytes': info.st_size,
                                       'mode': '100755' if info.st_mode & 0o111 else '100644'}
    return entries


def load_accepted_helper(source, receipt):
    tree = accepted_tree(source)
    if receipt.get('artifactSha256') != hashlib.sha256(json.dumps(tree, sort_keys=True).encode()).hexdigest():
        raise RuntimeError('Candidate artifact differs from the accepted tree.')
    spec = importlib.util.spec_from_file_location('updater_host', source / 'deploy/praxis_updater_host.py')
    helper = importlib.util.module_from_spec(spec)
    previous = sys.dont_write_bytecode
    try:
        sys.dont_write_bytecode = True  # Import must not add unaccepted pyc files.
        spec.loader.exec_module(helper)
    finally:
        sys.dont_write_bytecode = previous
    return helper


def copy_release(source, target):
    if target.exists(): raise RuntimeError('Bootstrap release already exists; inspect prior bootstrap before retrying.')
    shutil.copytree(source, target, symlinks=True)
    for path in [target, *target.rglob('*')]:
        if path.is_symlink(): os.lchown(path, 0, 0)
        else:
            os.chown(path, 0, 0)
            os.chmod(path, 0o755 if path.is_dir() or path.stat().st_mode & 0o111 else 0o644)


def ensure_idle(coding='/var/lib/praxis-code/live/coding.sqlite', git='/var/lib/praxis-git/git.sqlite'):
    with contextlib.closing(sqlite3.connect(pathlib.Path(coding).as_uri() + '?mode=ro', uri=True)) as db:
        if db.execute("SELECT COUNT(*) FROM code_jobs WHERE status IN ('queued','starting','running','canceling')").fetchone()[0]:
            raise RuntimeError('Existing coding jobs must finish before bootstrap; ingress will be restored.')
    with contextlib.closing(sqlite3.connect(pathlib.Path(git).as_uri() + '?mode=ro', uri=True)) as db:
        if db.execute("SELECT COUNT(*) FROM git_operations WHERE status IN ('queued','running','uncertain')").fetchone()[0]:
            raise RuntimeError('Existing publication operations must be recovered before bootstrap; ingress will be restored.')


def bootstrap_targets():
    return [pathlib.Path(path) for path in [
        '/etc/praxis-code/config.json', '/etc/praxis-git/config.json',
        '/etc/systemd/system/praxis-probe.service.d/autonomy.conf',
        '/etc/systemd/system/praxis-code.service.d/autonomy.conf',
        '/etc/systemd/system/praxis-code.service.d/dependencies.conf',
        '/etc/systemd/system/praxis-git.service.d/autonomy.conf',
        '/etc/systemd/system/praxis-updater.service', '/etc/systemd/system/praxis-dependencies.service',
        '/etc/systemd/system/' + MOUNT_UNIT,
        '/etc/sudoers.d/praxis-autonomy', '/etc/tmpfiles.d/praxis-control.conf',
        '/usr/local/libexec/praxis-updater', '/usr/local/libexec/praxis_updater_host.py',
        '/usr/local/libexec/praxis-deploy-discord', '/usr/local/libexec/praxis-deploy-project',
        '/usr/local/lib/praxis/registry-proxy.py', '/usr/local/lib/praxis/registry-relay.mjs',
        '/etc/praxis-updater/config.json', '/etc/praxis-updater/health-public.json', '/etc/praxis-updater/control.env',
        '/srv/praxis-app/current', '/srv/praxis-control/current', str(FENCE),
        str(ADMISSION_GATE), str(ADMISSION_DROPIN),
    ]]


class BootstrapTransaction:
    """Rollback only fixed configuration and owned service activation effects.

    Prepared trees, backup evidence, keys, databases and filesystem images remain
    preserved for inspection. No unrelated service is stopped or restarted.
    """
    def __init__(self, backup, paths=None, command=run, idle=ensure_idle, gate_paths=None):
        self.backup, self.command, self.idle = pathlib.Path(backup), command, idle
        self.paths = bootstrap_targets() if paths is None else paths
        self.saved, self.services = [], {}
        self.ingress_stopped = self.backends_stopped = self.changed = self.committed = False
        self.gate_paths = (ADMISSION_GATE, ADMISSION_DROPIN) if gate_paths is None else gate_paths
        self.guard_installed = False

    def __enter__(self):
        for index, path in enumerate(self.paths):
            path = pathlib.Path(path)
            item = {'path': str(path), 'existed': path.exists() or path.is_symlink()}
            if item['existed']:
                info = path.lstat()
                if info.st_uid != 0 or not (stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)):
                    raise RuntimeError('Unsafe bootstrap configuration backup target.')
                item.update(mode=stat.S_IMODE(info.st_mode), uid=info.st_uid, gid=info.st_gid)
                if path.is_symlink(): item['link'] = os.readlink(path)
                else:
                    destination = self.backup / ('file-' + str(index))
                    shutil.copyfile(path, destination)
                    os.chmod(destination, 0o600)
                    item['backupFile'] = destination.name
            self.saved.append(item)
        for unit in CORE_UNITS + ISOLATED_UNITS:
            active = self.command(['systemctl', 'show', unit, '--property=ActiveState', '--value'], capture_output=True, check=False)
            enabled = self.command(['systemctl', 'is-enabled', unit], capture_output=True, check=False)
            self.services[unit] = {'active': active.stdout.strip() == 'active', 'enabled': enabled.stdout.strip() == 'enabled'}
        install_json(self.backup / 'rollback.json', {'files': self.saved, 'services': self.services,
                                                  'scope': 'Fixed Praxis configuration; operational databases and credentials preserved.'}, 0o600)
        return self

    def quiesce(self):
        # The old release does not understand the new generation fence. Stop
        # ingress before inspecting admission state, then close backend listeners.
        if self.gate_paths:
            gate, dropin = map(pathlib.Path, self.gate_paths)
            self.guard_installed = True
            private_directory(gate.parent, mode=0o755)
            install_text(dropin, '[Unit]\nConditionPathExists=!' + str(gate) + '\n')
            install_text(gate, 'Owner bootstrap is incomplete; restore its recorded configuration before admitting work.\n', 0o644)
            self.command(['systemctl', 'daemon-reload'])
        self.ingress_stopped = True
        self.command(['systemctl', 'stop', CORE_UNITS[0]])
        self.idle()
        self.backends_stopped = True
        self.command(['systemctl', 'stop', *CORE_UNITS[1:]])
        self.idle()  # Final confirmation after every old admission endpoint closed.

    def release_bootstrap_guard(self):
        # New unit/config files now all point to implementations that honor the
        # persistent draining fence. The old-release boot guard is no longer needed.
        if self.gate_paths:
            gate, _ = map(pathlib.Path, self.gate_paths)
            if gate.exists(): gate.unlink()
            descriptor = os.open(gate.parent, os.O_RDONLY | os.O_DIRECTORY)
            try: os.fsync(descriptor)
            finally: os.close(descriptor)

    def rollback(self):
        failures = []
        def attempt(function, *args, **kwargs):
            try: return function(*args, **kwargs)
            except Exception as error: failures.append(type(error).__name__)
        if self.changed or self.guard_installed:
            if self.changed:
                attempt(self.command, ['systemctl', 'stop', *CORE_UNITS])
                for unit in ISOLATED_UNITS:
                    loaded = attempt(self.command, ['systemctl', 'show', unit, '--property=LoadState', '--value'], capture_output=True, check=False)
                    if loaded and loaded.stdout.strip() not in ('', 'not-found') and (unit == 'praxis-updater.service' or not self.services[unit]['active']):
                        attempt(self.command, ['systemctl', 'stop', unit])
                    if not self.services[unit]['enabled']: attempt(self.command, ['systemctl', 'disable', unit], check=False)
            for item in reversed(self.saved):
                if not self.changed and item['path'] not in {str(path) for path in self.gate_paths}: continue
                def restore(item=item):
                    path = pathlib.Path(item['path'])
                    if not item['existed']:
                        if path.exists() or path.is_symlink():
                            if path.is_dir() and not path.is_symlink(): raise RuntimeError('Unexpected directory at a fixed bootstrap file target.')
                            path.unlink()
                    elif 'link' in item:
                        if path.exists() or path.is_symlink(): path.unlink()
                        path.symlink_to(item['link'])
                        os.lchown(path, item['uid'], item['gid'])
                    else:
                        if path.is_symlink(): path.unlink()
                        install_text(path, (self.backup / item['backupFile']).read_bytes(), item['mode'])
                        os.chown(path, item['uid'], item['gid'])
                attempt(restore)
            attempt(self.command, ['systemctl', 'daemon-reload'])
        if self.backends_stopped or self.changed:
            for unit in CORE_UNITS[1:] + ISOLATED_UNITS:
                if self.services[unit]['enabled'] and self.changed: attempt(self.command, ['systemctl', 'enable', unit])
                if self.services[unit]['active']: attempt(self.command, ['systemctl', 'start', unit])
        if self.ingress_stopped and self.services[CORE_UNITS[0]]['active']:
            attempt(self.command, ['systemctl', 'start', CORE_UNITS[0]])
        install_json(self.backup / 'rollback-result.json', {'restored': not failures, 'failures': failures,
                     'preserved': 'Operational state, credentials, new isolated filesystem data, and prepared releases.'}, 0o600)
        if failures: raise RuntimeError('Bootstrap rollback needs owner recovery; inspect ' + str(self.backup / 'rollback-result.json'))

    def __exit__(self, kind, value, traceback):
        if kind is not None and not self.committed:
            install_json(self.backup / 'bootstrap-failure.json', {'errorType': kind.__name__, 'message': str(value)}, 0o600)
            self.rollback()
        return False


def bootstrap(source, helper, receipt, commit, backup, transaction):
    transaction.changed = True
    for user in ['praxis-stage', 'praxis-health']:
        try: pwd.getpwnam(user)
        except KeyError: run(['useradd', '--system', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', user])
    run(['/bin/bash', str(source / 'deploy/enable-dependencies.sh')])
    private_directory('/srv/praxis-stage', mode=0o755)
    image = pathlib.Path('/var/lib/praxis-stage.img')
    mount_unit = pathlib.Path('/etc/systemd/system/srv-praxis\\x2dstage.mount')
    if not image.exists():
        run(['truncate', '-s', '8G', str(image)])
        os.chmod(image, 0o600)
        run(['mkfs.ext4', '-q', '-F', str(image)])
    elif image.is_symlink() or image.stat().st_uid != 0 or image.stat().st_size != 8*1024**3:
        raise RuntimeError('Unexpected staging filesystem image.')
    install_text(mount_unit, '[Unit]\nDescription=Bounded Praxis candidate staging\n\n[Mount]\nWhat=/var/lib/praxis-stage.img\nWhere=/srv/praxis-stage\nType=ext4\nOptions=loop,nosuid,nodev\n\n[Install]\nWantedBy=multi-user.target\n')
    run(['systemctl', 'daemon-reload'])
    run(['systemctl', 'enable', '--now', mount_unit.name])
    private_directory('/srv/praxis-stage/stages', mode=0o711)
    private_directory('/srv/praxis-stage/logs')
    control_root = pathlib.Path('/srv/praxis-control/releases')
    app_root = pathlib.Path('/srv/praxis-app/releases')
    for parent in [control_root.parent, control_root, app_root.parent, app_root]:
        private_directory(parent, mode=0o755)
    name = 'app-bootstrap-' + commit[:12]
    control, application = control_root / commit[:12], app_root / name
    for target in [control, application]:
        copy_release(source, target)
    helper.atomic_json(application / 'release.json', {'sourceCommit': commit, 'release': name,
        'artifactSha256': hashlib.sha256(json.dumps(helper.safe_tree(application, allow_dependency_links=True), sort_keys=True).encode()).hexdigest()}, 0o644)
    for parent, target in [(pathlib.Path('/srv/praxis-control'), control), (pathlib.Path('/srv/praxis-app'), application)]:
        link = parent / 'current'
        if link.exists() or link.is_symlink(): raise RuntimeError('Independent control/application slots already exist; use their recorded recovery procedure.')
        link.symlink_to(target)
    private_directory('/etc/praxis-updater', mode=0o755)
    private_directory('/var/lib/praxis-updater')
    # Admission state survives power loss. Never reconstruct it as active merely
    # because /run was cleared while an update was draining.
    private_directory(FENCE.parent, mode=0o755)
    health = pathlib.Path('/etc/praxis-updater/health.json')
    if not health.exists():
        code = "const f=require('fs'),c=require('crypto');const k=c.generateKeyPairSync('rsa',{modulusLength:2048});const jwk=k.privateKey.export({format:'jwk'});jwk.kid='praxis-health-'+c.randomUUID();jwk.alg='RS256';jwk.use='sig';f.writeFileSync(process.argv[1],JSON.stringify({jwk,issuer:'https://mcp.jensenabler.com/praxis/oauth',resourceUrl:'https://mcp.jensenabler.com/praxis/mcp'}));"
        run(['/usr/bin/node', '-e', code, str(health)])
        os.chown(health, pwd.getpwnam('praxis-health').pw_uid, pwd.getpwnam('praxis-health').pw_gid)
        os.chmod(health, 0o600)
    jwk = json.loads(health.read_text())['jwk']
    public = {'keys': [{key: value for key, value in jwk.items() if key not in ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth']}]}
    install_json('/etc/praxis-updater/health-public.json', public, 0o644)
    protected = {}
    for path in source.rglob('*'):
        relative = path.relative_to(source).as_posix()
        if path.is_file() and (relative.startswith('src/git/') or relative.startswith('deploy/') or relative in [
            'src/auth.js', 'src/server.js', 'src/mcp.js', 'src/token-verifier.js', 'src/release-schema.js', 'src/tool-manifest.js']
            or relative.startswith('scripts/release-')):
            protected[relative] = helper.file_hash(path)
    updater_config = {'dataDirectory': '/var/lib/praxis-updater', 'releasesRoot': str(app_root), 'currentLink': '/srv/praxis-app/current',
        'stagingRoot': '/srv/praxis-stage/stages', 'stagingMount': '/srv/praxis-stage', 'controlRoot': '/srv/praxis-control/current',
        'codingConfig': '/etc/praxis-code/config.json', 'codingDatabase': '/var/lib/praxis-code/live/coding.sqlite',
        'gitDatabase': '/var/lib/praxis-git/git.sqlite', 'exportDirectory': '/srv/praxis-git-exchange/exports',
        'generationFencePath': str(FENCE), 'healthConfig': str(health), 'protectedFiles': protected}
    install_json('/etc/praxis-updater/config.json', updater_config, 0o600)
    helper.atomic_json(FENCE, {'state': 'draining', 'operationId': 'bootstrap'}, 0o644)
    for filename, target in [('praxis-updater.py', 'praxis-updater'), ('praxis_updater_host.py', 'praxis_updater_host.py'),
                             ('deploy-discord.py', 'praxis-deploy-discord'), ('deploy-project.py', 'praxis-deploy-project')]:
        install_text('/usr/local/libexec/' + target, (source / 'deploy' / filename).read_bytes(), 0o755)
    private_directory('/srv/praxis-apps', mode=0o755)
    private_directory('/var/lib/praxis-deploy/projects')
    private_directory('/etc/nginx/praxis-apps', mode=0o755)
    policy = 'praxis-git ALL=(root) NOPASSWD: /usr/local/libexec/praxis-updater "", /usr/local/libexec/praxis-deploy-project ""\n'
    install_text('/etc/sudoers.d/praxis-autonomy', policy, 0o440)
    run(['visudo', '-cf', '/etc/sudoers.d/praxis-autonomy'])
    config = json.loads(pathlib.Path('/etc/praxis-code/config.json').read_text())
    config.update(release=name, healthPublicJwks=public, generationFencePath=str(FENCE), selfUpdateEnabled=True,
                  runtimeDescription='Node, npm, Python, Git, ripgrep and ffmpeg; offline default with opt-in public registry proxy')
    config['git']['projectIds'] = ['discord', 'praxis']
    git_config = json.loads(pathlib.Path('/etc/praxis-git/config.json').read_text())
    git_config.update(release='control-' + commit[:12], enableSelfUpdate=True, enableProjectDeployment=True, generationFencePath=str(FENCE),
        projectProvisioning={'account': 'JensenAbler', 'directory': '/var/lib/praxis-git/projects',
           'knownHostsFile': '/var/lib/praxis-git/home/.ssh/known_hosts', 'tokenFile': '/var/lib/praxis-git/project-provisioning-token', 'maximumProjects': 50})
    if not any(repo['projectId'] == 'praxis' for repo in git_config['repositories']):
        repo_path = '/var/lib/praxis-git/repos/praxis.git'
        run(['runuser', '-u', 'praxis-git', '--', 'git', '-c', 'init.templateDir=', 'init', '--bare', '--initial-branch=main', repo_path])
        git_config['repositories'].append({'projectId': 'praxis', 'directory': repo_path, 'remoteUrl': 'git@github.com:JensenAbler/Praxis.git',
          'defaultBranch': 'main', 'allowedBranches': ['main'], 'author': {'name': 'JensenAbler', 'email': '20964948+JensenAbler@users.noreply.github.com'},
          'transportEnv': {'GIT_SSH_COMMAND': 'ssh -F /dev/null -i /var/lib/praxis-git/home/.ssh/praxis_repo -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/var/lib/praxis-git/home/.ssh/known_hosts'}})
    install_text('/etc/praxis-updater/control.env', 'PRAXIS_RELEASE=control-' + commit[:12] + '\n')
    install_text('/etc/systemd/system/praxis-probe.service.d/autonomy.conf', '[Service]\nWorkingDirectory=/srv/praxis-control/current\nExecStart=\nExecStart=/usr/bin/node /srv/praxis-control/current/src/server.js\nEnvironmentFile=/etc/praxis-updater/control.env\nEnvironment=PRAXIS_TOOL_MANIFEST=/srv/praxis-app/current/coding-tools.json\nEnvironment=PRAXIS_RELEASE_CONTROL_URL=http://127.0.0.1:8793/call\nEnvironment=PRAXIS_HEALTH_JWKS=/etc/praxis-updater/health-public.json\n')
    install_text('/etc/systemd/system/praxis-code.service.d/autonomy.conf', '[Service]\nWorkingDirectory=/srv/praxis-app/current\nExecStart=\nExecStart=/usr/bin/node /srv/praxis-app/current/src/code/server.js\n')
    install_text('/etc/systemd/system/praxis-git.service.d/autonomy.conf', '[Service]\nWorkingDirectory=/srv/praxis-control/current\nExecStart=\nExecStart=/usr/bin/flock --nonblock /var/lib/praxis-git/broker.lock /usr/bin/node /srv/praxis-control/current/src/git/server.js\nPrivateTmp=no\nReadWritePaths=/var/lib/praxis-updater /var/lib/praxis-control /srv/praxis-apps /etc/nginx/praxis-apps /etc/systemd/system /var/log/nginx\n')
    install_text('/etc/systemd/system/praxis-updater.service', '[Unit]\nDescription=Independent Praxis application updater\nAfter=network.target srv-praxis\\x2dstage.mount praxis-dependencies.service\nRequires=srv-praxis\\x2dstage.mount\n\n[Service]\nType=simple\nUser=root\nExecStart=/usr/bin/python3 /usr/local/libexec/praxis-updater --worker\nRestart=on-failure\nRestartSec=3\nUMask=0077\nMemoryMax=512M\nCPUQuota=50%\nTasksMax=128\n\n[Install]\nWantedBy=multi-user.target\n')
    run(['systemd-analyze', 'verify', '/etc/systemd/system/praxis-updater.service'])
    # Every old admission endpoint is already stopped by the transaction. No
    # podcast, memory, observer or unrelated unit is touched.
    ensure_idle()
    install_json('/etc/praxis-code/config.json', config, group='praxis-code')
    install_json('/etc/praxis-git/config.json', git_config, group='praxis-git')
    run(['systemctl', 'daemon-reload'])
    transaction.release_bootstrap_guard()
    run(['systemctl', 'start', 'praxis-git.service', 'praxis-code.service', 'praxis-probe.service'])
    run(['systemctl', 'enable', '--now', 'praxis-updater.service'])
    confirm_startup(config, git_config)
    live_health = confirm_authenticated_startup(health, name)
    install_json(backup / 'authenticated-live-health.json', live_health, 0o600)
    install_json(backup / 'bootstrap-receipt.json', {'sourceCommit': commit, 'applicationRelease': name, 'controlRelease': 'control-' + commit[:12],
        'candidateTestsPassed': True, 'authenticatedCandidateMcpPassed': True, 'authenticatedLiveMcpPassed': True,
        'liveQualificationPending': True, 'backup': str(backup)}, 0o600)
    # Open admission only after all fallible activation and receipt writes. Once
    # open, never roll back automatically over newly admitted owner work.
    helper.atomic_json(FENCE, {'state': 'active', 'release': name, 'operationId': 'bootstrap'}, 0o644)
    transaction.committed = True
    print(json.dumps({'configured': True, 'applicationRelease': name, 'backup': str(backup), 'liveQualificationPending': True}))


def confirm_startup(config, git_config, command=run):
    checks = [
        ('http://127.0.0.1:' + str(config.get('port', 8792)) + '/healthz', []),
        ('http://127.0.0.1:' + str(git_config.get('port', 8793)) + '/healthz', []),
        ('http://127.0.0.1:8790/praxis/healthz', ['--header', 'Host: mcp.jensenabler.com']),
    ]
    deadline = time.monotonic() + 30
    successes = 0
    while time.monotonic() < deadline:
        ready = True
        for url, headers in checks:
            result = command(['/usr/bin/curl', '--noproxy', '*', '--fail', '--silent', '--show-error', '--max-time', '2',
                              *headers, url], capture_output=True, check=False)
            try:
                data = json.loads(result.stdout)
                ready = ready and result.returncode == 0 and data.get('ok') is True
            except (ValueError, AttributeError):
                ready = False
        if ready:
            successes += 1
            if successes >= 3: return
        else:
            successes = 0
        time.sleep(0.5)
    raise RuntimeError('New Praxis services did not stabilize; restoring previous configuration and service activation.')


def confirm_authenticated_startup(health, release, command=run):
    argv = ['runuser', '-u', 'praxis-health', '--', '/usr/bin/node',
            '/srv/praxis-control/current/scripts/release-live-check.js', str(health), release]
    for attempt in range(2):
        try:
            result = command(argv, capture_output=True, check=False, timeout=20)
            if result.returncode == 0:
                if len(result.stdout.encode()) > 65536:
                    raise RuntimeError('Authenticated live health output exceeded its bound.')
                return {'passed': True, 'release': release, 'attempt': attempt + 1,
                        'output': result.stdout.strip(), 'grant': 'Dedicated read-only health identity; no owner credential.'}
        except subprocess.TimeoutExpired:
            pass
        if attempt == 0: time.sleep(0.5)
    raise RuntimeError('Authenticated live MCP health failed while admission remained fenced; restoring previous configuration.')


def main():
    if os.getuid() != 0 or len(sys.argv) != 3:
        raise RuntimeError('Supply prepared release directory and private acceptance file as owner root.')
    source, receipt_file = map(pathlib.Path, sys.argv[1:])
    if (source.resolve() != source or not source.is_dir() or source.stat().st_uid != 0 or source.stat().st_mode & 0o022
            or receipt_file.resolve() != receipt_file or receipt_file.is_symlink() or receipt_file.stat().st_uid != 0
            or not stat.S_ISREG(receipt_file.stat().st_mode) or receipt_file.stat().st_nlink != 1
            or stat.S_IMODE(receipt_file.stat().st_mode) != 0o600):
        raise RuntimeError('Expected immutable source and protected acceptance.')
    receipt = json.loads(receipt_file.read_text())
    commit = receipt.get('sourceCommit', '')
    if not re.fullmatch('[a-f0-9]{40}', commit) or not all(receipt.get(key) is True for key in ['npmTestPassed', 'authenticatedMcpPassed']):
        raise RuntimeError('Candidate qualification is incomplete.')
    helper = load_accepted_helper(source, receipt)
    for path in ['/srv/praxis-control/current', '/srv/praxis-app/current']:
        if pathlib.Path(path).exists() or pathlib.Path(path).is_symlink():
            raise RuntimeError('Independent application/control slots already exist; inspect their recorded recovery instead of rerunning bootstrap.')
    import fcntl
    lock = os.open('/var/lib/praxis-bootstrap.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(lock)
        if info.st_uid != 0 or info.st_mode & 0o077 or not stat.S_ISREG(info.st_mode):
            raise RuntimeError('Unsafe bootstrap lock.')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        backup = pathlib.Path('/root/praxis-probe-backups') / ('autonomy-' + str(uuid.uuid4()))
        backup.mkdir(mode=0o700)
        with BootstrapTransaction(backup) as transaction:
            transaction.quiesce()
            bootstrap(source, helper, receipt, commit, backup, transaction)
    finally:
        os.close(lock)


if __name__ == '__main__': main()
