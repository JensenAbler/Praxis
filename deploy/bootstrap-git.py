#!/usr/bin/python3 -I
"""Prepare fixed Praxis Git/deployment infrastructure; never activate it.

Run the reviewed copy as root without arguments. Existing credentials, config,
repository contents, and runtime databases are preserved. This bootstrap refuses
replacement of differing privileged executables/units; release updates use the
separate reviewed update procedure. Service enable/start/restart and adoption of
the existing orphan bot are intentionally outside this script.
"""
import fcntl
import grp
import hashlib
import json
import os
from pathlib import Path
import pwd
import socket
import stat
import subprocess
import sys
import tempfile

ACCOUNT = 'praxis-git'
GROUP = 'praxis-source'
STATE = Path('/var/lib/praxis-git')
HOME = STATE / 'home'
CONFIG = Path('/etc/praxis-git')
EXCHANGE = Path('/srv/praxis-git-exchange')
DEPLOY_STATE = Path('/var/lib/praxis-deploy')
HELPER = Path('/usr/local/libexec/praxis-deploy-discord')


class Refused(Exception):
    pass


def run(argv):
    result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin',
                                                        'HOME': '/root', 'LANG': 'C.UTF-8'})
    if result.returncode:
        raise Refused('A fixed bootstrap command failed; preserved state needs inspection.')
    return result.stdout


def safe_path(path, owner=0, directory=False, mode=None, group=None):
    path = Path(path)
    value = path.lstat()
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if (not kind(value.st_mode) or value.st_uid != owner or path.resolve() != path.absolute()
            or value.st_mode & 0o022 or (mode is not None and stat.S_IMODE(value.st_mode) != mode)
            or (group is not None and value.st_gid != group)):
        raise Refused('A bootstrap path has unexpected ownership, type, or permissions.')
    return value


def directory(path, owner, group, mode):
    path = Path(path)
    safe_path(path.parent, directory=True, owner=path.parent.stat().st_uid)
    if path.exists() or path.is_symlink():
        safe_path(path, owner=owner, group=group, directory=True, mode=mode)
        return
    path.mkdir(mode=mode)
    os.chown(path, owner, group)
    path.chmod(mode)  # mkdir is affected by umask and setgid inheritance.


def install_same(content, destination, mode=0o644):
    destination = Path(destination)
    safe_path(destination.parent, directory=True)
    if destination.exists() or destination.is_symlink():
        safe_path(destination, mode=mode, group=0)
        if destination.read_bytes() != content:
            raise Refused('A privileged bootstrap file already differs; use the reviewed update procedure.')
        return
    fd, temporary = tempfile.mkstemp(prefix='.praxis-bootstrap-', dir=destination.parent)
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(content)
            out.flush()
            os.fsync(out.fileno())
        os.chmod(temporary, mode)
        os.chown(temporary, 0, 0)
        # Link provides exclusive creation: never overwrite a file that appeared
        # after validation, including a symlink.
        os.link(temporary, destination, follow_symlinks=False)
    finally:
        os.unlink(temporary)


def assert_idle():
    active = subprocess.run(['/usr/bin/systemctl', 'is-active', '--quiet', 'praxis-git.service'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if active:
        raise Refused('Git broker is active; bootstrap cannot replace an active service.')
    with socket.socket() as probe:
        if probe.connect_ex(('127.0.0.1', 8793)) == 0:
            raise Refused('The fixed broker port is already occupied.')
    # Query as the coding identity so SQLite never creates root-owned sidecars.
    # This is read-only discovery; no live service is restarted by bootstrap.
    query = """import sqlite3,json
db=sqlite3.connect('file:/var/lib/praxis-code/live/coding.sqlite?mode=ro',uri=True,timeout=5)
jobs=db.execute(\"SELECT COUNT(*) FROM code_jobs WHERE status IN ('queued','starting','running','canceling')\").fetchone()[0]
operations=db.execute(\"SELECT COUNT(*) FROM operations WHERE status='prepared'\").fetchone()[0]
print(json.dumps({'activeJobs':jobs,'preparedOperations':operations}))
db.close()
"""
    counts = json.loads(run(['/usr/sbin/runuser', '-u', 'praxis-code', '--', '/usr/bin/python3', '-I', '-c', query]))
    if counts['activeJobs'] or counts['preparedOperations']:
        raise Refused('Coding jobs or mutations are active; recover them before bootstrap.')
    return counts


def account():
    try:
        grp.getgrnam(GROUP)
    except KeyError:
        run(['/usr/sbin/groupadd', '--system', GROUP])
    try:
        user = pwd.getpwnam(ACCOUNT)
    except KeyError:
        run(['/usr/sbin/useradd', '--system', '--user-group', '--home-dir', str(HOME),
             '--no-create-home', '--shell', '/usr/sbin/nologin', ACCOUNT])
        user = pwd.getpwnam(ACCOUNT)
    if (user.pw_dir != str(HOME) or user.pw_shell != '/usr/sbin/nologin'
            or grp.getgrgid(user.pw_gid).gr_name != ACCOUNT
            or user.pw_uid in (0, pwd.getpwnam('praxis-code').pw_uid, pwd.getpwnam('praxis-probe').pw_uid)):
        raise Refused('The existing broker identity does not match the isolated account contract.')
    memberships = set(run(['/usr/bin/id', '-nG', ACCOUNT]).decode().split())
    if not memberships <= {ACCOUNT, GROUP}:
        raise Refused('The broker has unexpected supplementary privileges.')
    return user, grp.getgrnam(GROUP).gr_gid


def bootstrap():
    if os.geteuid() != 0 or len(sys.argv) != 1:
        raise Refused('Run this reviewed bootstrap as root with no arguments.')
    os.umask(0o077)
    source = Path(__file__).resolve().parent
    safe_path(source, directory=True)
    reviewed = {}
    for name in ('praxis-git.service', 'podcast-discord.service', 'deploy-discord.py'):
        safe_path(source / name)
        reviewed[name] = (source / name).read_bytes().replace(b'\r\n', b'\n')
    for parent in ('/opt', '/srv', '/var/lib', '/etc', '/usr/local', '/etc/systemd/system', '/etc/sudoers.d'):
        safe_path(parent, directory=True)
    counts = assert_idle()
    user, shared_gid = account()
    code_uid = pwd.getpwnam('praxis-code').pw_uid
    directory(STATE, user.pw_uid, user.pw_gid, 0o700)
    directory(HOME, user.pw_uid, user.pw_gid, 0o700)
    directory(HOME / '.ssh', user.pw_uid, user.pw_gid, 0o700)
    directory(STATE / 'repos', user.pw_uid, user.pw_gid, 0o700)
    directory(CONFIG, 0, user.pw_gid, 0o750)
    config_path = CONFIG / 'config.json'
    config_digest = None
    if config_path.exists() or config_path.is_symlink():
        safe_path(config_path, mode=0o640, group=user.pw_gid)
        config_digest = hashlib.sha256(config_path.read_bytes()).hexdigest()
    directory(EXCHANGE, 0, shared_gid, 0o750)
    directory(EXCHANGE / 'outbox', code_uid, shared_gid, 0o2750)
    directory(EXCHANGE / 'exports', user.pw_uid, shared_gid, 0o2750)
    directory(DEPLOY_STATE, 0, 0, 0o700)
    directory(DEPLOY_STATE / 'discord', 0, 0, 0o700)
    directory('/usr/local/libexec', 0, 0, 0o755)
    directory('/etc/systemd/system/praxis-code.service.d', 0, 0, 0o755)
    repo = STATE / 'repos' / 'discord.git'
    if repo.exists() or repo.is_symlink():
        safe_path(repo, owner=user.pw_uid, group=user.pw_gid, directory=True, mode=0o700)
        bare = run(['/usr/sbin/runuser', '-u', ACCOUNT, '--', '/usr/bin/env', '-i',
                    'PATH=/usr/bin:/bin', 'HOME=' + str(HOME), 'GIT_CONFIG_GLOBAL=/dev/null',
                    'GIT_CONFIG_SYSTEM=/dev/null', '/usr/bin/git', '-C', str(repo), 'rev-parse', '--is-bare-repository'])
        if bare.strip() != b'true':
            raise Refused('The retained broker repository is not bare.')
    else:
        run(['/usr/sbin/runuser', '-u', ACCOUNT, '--', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
             'HOME=' + str(HOME), 'GIT_CONFIG_GLOBAL=/dev/null', 'GIT_CONFIG_SYSTEM=/dev/null',
             '/usr/bin/git', 'init', '--bare', '--template=', '--initial-branch=main', str(repo)])
        repo.chmod(0o700)
    sudoers = ('# Fixed deployment only; no shell, interpreter arguments, or user-selected command.\n'
               'Defaults:praxis-git env_reset\n'
               'praxis-git ALL=(root) NOPASSWD: /usr/local/libexec/praxis-deploy-discord ""\n').encode()
    # Validate a temporary sudoers file before making it effective.
    fd, temporary = tempfile.mkstemp(prefix='praxis-sudoers-', dir='/run')
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(sudoers)
        os.chmod(temporary, 0o440)
        run(['/usr/sbin/visudo', '-c', '-f', temporary])
    finally:
        os.unlink(temporary)
    install_same(reviewed['deploy-discord.py'], HELPER, 0o755)
    install_same(sudoers, '/etc/sudoers.d/praxis-git-deployment', 0o440)
    for name in ('praxis-git.service', 'podcast-discord.service'):
        install_same(reviewed[name], '/etc/systemd/system/' + name)
    code_dropin = b'[Service]\nSupplementaryGroups=praxis-source\nReadWritePaths=/srv/praxis-git-exchange/outbox\nReadOnlyPaths=/srv/praxis-git-exchange/exports\n'
    install_same(code_dropin, '/etc/systemd/system/praxis-code.service.d/git-exchange.conf')
    run(['/usr/bin/systemd-analyze', 'verify', '/etc/systemd/system/praxis-git.service',
         '/etc/systemd/system/podcast-discord.service', '/etc/systemd/system/praxis-code.service'])
    # Even daemon-reload is left to the controlled release/adoption procedure.
    # Installed files do not change the running coding or bot processes.
    return {'prepared': True, 'servicesStarted': False, 'servicesRestarted': False,
            'daemonReloaded': False, 'productionCheckoutChanged': False,
            'brokerUid': user.pw_uid, 'brokerGid': user.pw_gid, 'sourceGid': shared_gid,
            'existingConfigPreserved': config_digest is not None, 'existingConfigSha256': config_digest,
            'credentialProvisioningRequired': not (HOME / '.ssh' / 'id_ed25519').exists(),
            'initialCodingState': counts,
            'nextSteps': ['Provision protected broker configuration and a repository-scoped GitHub key.',
                          'Run authenticated broker/container fixtures in the reviewed release.',
                          'Adopt the existing bot only during a known quiet interval.',
                          'Activate the broker and coding integration through the controlled release procedure.']}


if __name__ == '__main__':
    try:
        fd = os.open('/run/lock/praxis-probe-deploy.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            print(json.dumps(bootstrap(), separators=(',', ':')))
        finally:
            os.close(fd)
    except Refused as error:
        print(json.dumps({'prepared': False, 'error': str(error)}, separators=(',', ':')))
        sys.exit(1)
    except Exception:
        print(json.dumps({'prepared': False, 'error': 'Bootstrap stopped without activating services; inspect the preserved preparation state.'}, separators=(',', ':')))
        sys.exit(1)
