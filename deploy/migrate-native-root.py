#!/usr/bin/python3
"""Explicit owner migration to native root execution. Never runs on import.

plan/apply QUALIFIED_TREE ACCEPTANCE EXPECTED_APP EXPECTED_CONTROL
recover PRIVATE_BACKUP

Candidate qualification precedes this command. No source install scripts run.
Rollback restores configuration and service state, never operational databases.
"""
import contextlib
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import sqlite3
import stat
import sys
import uuid

CONTROL = Path('/srv/praxis-control/current')
APP = Path('/srv/praxis-app/current')
UPDATER_CONFIG = Path('/etc/praxis-updater/config.json')
GIT_CONFIG = Path('/etc/praxis-git/config.json')
CONTROL_ENV = Path('/etc/praxis-updater/control.env')
UNIT_ROOT = Path('/etc/systemd/system')
NATIVE_ROOT = Path('/var/lib/praxis-root')
BACKUP_ROOT = Path('/root/praxis-probe-backups')
UNITS = ('praxis-code.service', 'praxis-updater.service')
INSTALLED = {
    'deploy/praxis-updater.py': Path('/usr/local/libexec/praxis-updater'),
    'deploy/praxis_updater_host.py': Path('/usr/local/libexec/praxis_updater_host.py'),
    'deploy/deploy-discord.py': Path('/usr/local/libexec/praxis-deploy-discord'),
    'deploy/deploy-project.py': Path('/usr/local/libexec/praxis-deploy-project'),
}


def check(value, message):
    if not value: raise RuntimeError(message)


def protected_file(path, private=False):
    path = Path(path); info = path.lstat()
    check(path.resolve() == path and stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
          and info.st_mode & (0o077 if private else 0o022) == 0, 'Expected protected ordinary file: ' + str(path))
    return info


def native_unit(kind):
    check(kind in ('code', 'updater'), 'Unknown native service.')
    service = ('WorkingDirectory=/srv/praxis-app/current\n'
               'Environment=NODE_ENV=production\n'
               'Environment=PRAXIS_CODING_CONFIG=/etc/praxis-code/config.json\n'
               'ExecStart=/usr/bin/node /srv/praxis-app/current/src/code/server.js\n') if kind == 'code' else (
               'ExecStart=/usr/bin/python3 /usr/local/libexec/praxis-updater --worker\n')
    # Full replacement plus masks for old drop-ins. Explicit resets also cancel
    # inherited manager defaults; an empty CapabilityBoundingSet would remove all.
    return ('[Unit]\nDescription=Praxis native root ' + kind + '\nAfter=network.target\n\n'
            '[Service]\nType=simple\nUser=root\nGroup=root\n' + service +
            'Environment=HOME=/var/lib/praxis-root/home\n'
            'Environment=XDG_CACHE_HOME=/var/lib/praxis-root/home/.cache\n'
            'Environment=npm_config_cache=/var/lib/praxis-root/home/.npm\n'
            'Restart=on-failure\nRestartSec=3\nTimeoutStopSec=30\nKillMode=control-group\nUMask=0077\n'
            'ProtectSystem=no\nProtectHome=no\nPrivateNetwork=no\nPrivateTmp=no\nPrivateDevices=no\n'
            'ProtectKernelTunables=no\nProtectKernelModules=no\nProtectKernelLogs=no\n'
            'ProtectControlGroups=no\nProtectClock=no\nNoNewPrivileges=no\nRestrictRealtime=no\n'
            'RestrictSUIDSGID=no\nLockPersonality=no\nRestrictNamespaces=no\n'
            'CapabilityBoundingSet=~\nSystemCallFilter=\nSystemCallArchitectures=\nRestrictAddressFamilies=\n'
            'ReadOnlyPaths=\nReadWritePaths=\nInaccessiblePaths=\nIPAddressDeny=\nIPAddressAllow=\n'
            'MemoryMax=infinity\nMemoryHigh=infinity\nMemorySwapMax=infinity\nTasksMax=infinity\nCPUQuota=\n'
            'LimitCPU=infinity\nLimitAS=infinity\nLimitFSIZE=infinity\nLimitDATA=infinity\n'
            'LimitNPROC=infinity\nLimitRSS=infinity\nLimitMEMLOCK=infinity\nLimitNOFILE=infinity\n'
            '\n[Install]\nWantedBy=multi-user.target\n')


def native_config(coding, release):
    result = copy.deepcopy(coding)
    previous = result.get('workspaceDirectory')
    legacy = list(result.get('legacyWorkspaceDirectories', []))
    workspace = str(NATIVE_ROOT / 'workspaces')
    if previous and previous != workspace and previous not in legacy: legacy.append(previous)
    result.update(release=release, executionMode='native-root', workspaceDirectory=workspace,
                  legacyWorkspaceDirectories=legacy,
                  runtimeDescription='Native root Linux execution with host files, network, administration and persistent home/caches.')
    if result.get('runnerConfig', {}).get('type') != 'native-root':
        result['legacyRunnerConfig'] = copy.deepcopy(result.get('runnerConfig', {}))
    result['runnerConfig'] = {'type': 'native-root', 'jobsDirectory': str(NATIVE_ROOT / 'jobs'),
        'homeDirectory': str(NATIVE_ROOT / 'home'), 'workerPath': str(APP / 'src/code/native-worker.py'),
        'systemdRunPath': '/usr/bin/systemd-run', 'systemctlPath': '/usr/bin/systemctl', 'pythonPath': '/usr/bin/python3'}
    return result


def dropin_masks(command):
    result = []
    for unit in UNITS:
        existing = command(['systemctl', 'show', unit, '--property=DropInPaths', '--value'], capture_output=True)
        names = {path.name for path in (UNIT_ROOT / (unit + '.d')).glob('*.conf')}
        for value in shlex.split(existing.stdout): names.add(Path(value).name)
        for name in sorted(names):
            check(re.fullmatch(r'[A-Za-z0-9_.-]+\.conf', name), 'Unrecognized unit drop-in name.')
            result.append(UNIT_ROOT / (unit + '.d') / name)
    return result


def ensure_idle(bs, updater):
    bs.ensure_idle(updater['codingDatabase'], updater['gitDatabase'])
    for filename, query in [
        (updater['codingDatabase'], "SELECT COUNT(*) FROM operations WHERE status='prepared'"),
        (str(Path(updater['dataDirectory']) / 'releases.sqlite'),
         "SELECT COUNT(*) FROM releases WHERE status IN ('queued','running','waiting') OR phase='restoration_failed'")
    ]:
        with contextlib.closing(sqlite3.connect(Path(filename).as_uri() + '?mode=ro', uri=True)) as db:
            check(db.execute(query).fetchone()[0] == 0, 'Pending edits or updater operations must finish or be recovered before migration.')


def check_source(bs, source, acceptance):
    check(source.resolve() == source and source.is_dir() and source.stat().st_uid == 0
          and source.stat().st_mode & 0o022 == 0, 'Expected canonical root-owned qualified source.')
    check(re.fullmatch('[a-f0-9]{40}', acceptance.get('sourceCommit', '')) and
          all(acceptance.get(name) is True for name in ('npmTestPassed', 'authenticatedMcpPassed')), 'Qualification is incomplete.')
    tree = bs.accepted_tree(source)
    check(hashlib.sha256(json.dumps(tree, sort_keys=True).encode()).hexdigest() == acceptance.get('artifactSha256'),
          'Prepared artifact differs from its acceptance.')
    for name in [*INSTALLED, 'src/code/native-worker.py', 'src/code/native-runner.js', 'coding-tools.json',
                 'scripts/release-live-check.js', 'deploy/migrate-native-root.py']:
        check(tree.get(name, {}).get('bytes', 0) > 0, 'Qualified native source is missing: ' + name)
    check('release.json' not in tree, 'Qualified source must not contain an existing application release marker.')
    return tree


def current_state(bs, updater, expected_app, expected_control):
    code_path = Path(updater['codingConfig']); protected_file(code_path)
    coding = json.loads(code_path.read_text())
    check(APP.is_symlink() and APP.resolve(strict=True).parent == Path(updater['releasesRoot'])
          and APP.resolve().name == expected_app == coding['release'], 'Application release precondition changed.')
    check(CONTROL.is_symlink() and CONTROL.resolve(strict=True).parent == CONTROL.parent / 'releases'
          and CONTROL.resolve().name == expected_control, 'Control release precondition changed.')
    check(not bs.ADMISSION_GATE.exists(), 'An unfinished owner migration guard requires recovery first.')
    check(json.loads(bs.FENCE.read_text()).get('state') == 'active', 'An existing generation fence requires recovery first.')
    return coding


def fixed_paths(bs, updater, masks):
    return [Path(updater['codingConfig']), UPDATER_CONFIG, GIT_CONFIG, CONTROL_ENV, APP, CONTROL,
            bs.FENCE, bs.ADMISSION_GATE, bs.ADMISSION_DROPIN, *INSTALLED.values(),
            *(UNIT_ROOT / unit for unit in UNITS), *masks]


def replace_link(path, target):
    temporary = path.with_name('.native-next-' + str(uuid.uuid4()))
    temporary.symlink_to(target); os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)


def stopped(command, unit):
    result = command(['systemctl', 'show', unit, '-p', 'ActiveState', '-p', 'MainPID'], capture_output=True)
    values = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    check(values.get('ActiveState') in ('inactive', 'failed') and values.get('MainPID') == '0', 'Service shutdown unconfirmed: ' + unit)


def snapshot_databases(updater, backup):
    metadata = []
    for name, filename in [('coding', updater['codingDatabase']), ('git', updater['gitDatabase']),
                           ('updater', str(Path(updater['dataDirectory']) / 'releases.sqlite'))]:
        destination = backup / (name + '.sqlite')
        check(not destination.exists(), 'Database backup already exists.')
        with contextlib.closing(sqlite3.connect(Path(filename).as_uri() + '?mode=ro', uri=True)) as source, \
             contextlib.closing(sqlite3.connect(destination)) as target: source.backup(target)
        os.chmod(destination, 0o600)
        info = Path(filename).stat()
        metadata.append({'path': filename, 'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode)})
    return metadata


def restore_database_ownership(metadata):
    # SQLite contents remain current. Failed root startup may leave root-owned
    # WAL/SHM files which the previous service UID must be able to recover.
    for item in metadata:
        for suffix in ('', '-wal', '-shm', '-journal'):
            path = Path(item['path'] + suffix)
            if path.exists() or path.is_symlink():
                info = path.lstat()
                check(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and not path.is_symlink(), 'Unsafe database recovery sidecar.')
                os.chown(path, item['uid'], item['gid']); os.chmod(path, item['mode'])


def transaction_type(bs, metadata, command):
    class NativeTransaction(bs.BootstrapTransaction):
        def rollback(self):
            if self.changed:
                command(['systemctl', 'stop', *bs.CORE_UNITS, 'praxis-updater.service'])
                for unit in (*bs.CORE_UNITS, 'praxis-updater.service'): stopped(command, unit)
                restore_database_ownership(metadata)
            return super().rollback()
    return NativeTransaction


def initialize_native_home(bs, git):
    # No storage mount, filesystem image, history move, or retention deletion.
    for relative in ('', 'home', 'home/.cache', 'home/.npm', 'home/.config', 'workspaces', 'jobs', 'stages', 'logs'):
        path = NATIVE_ROOT / relative
        check(not path.is_symlink() and path.resolve() == path, 'Unexpected link in native storage.')
        bs.private_directory(path)
        check(path.stat().st_dev == NATIVE_ROOT.parent.stat().st_dev, 'Native storage must stay on ordinary host storage, outside old loop mounts.')
    config = NATIVE_ROOT / 'home/.gitconfig'
    if not config.exists():
        author = next((repo.get('author', {}) for repo in git.get('repositories', []) if repo.get('projectId') == 'praxis'), {})
        name, email = author.get('name', 'Jensen Abler'), author.get('email', '20964948+JensenAbler@users.noreply.github.com')
        check(all(isinstance(value, str) and '\n' not in value and '\r' not in value for value in (name, email)), 'Invalid configured Git identity.')
        quoted = lambda value: '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'
        bs.install_text(config, '[user]\n\tname = ' + quoted(name) + '\n\temail = ' + quoted(email) + '\n[init]\n\tdefaultBranch = main\n', 0o600)


def verify_native_service(command):
    properties = ['User', 'Group', 'ProtectSystem', 'ProtectHome', 'PrivateNetwork', 'PrivateTmp', 'NoNewPrivileges',
                  'InaccessiblePaths', 'IPAddressDeny', 'MemoryMax', 'MemoryHigh', 'MemorySwapMax', 'TasksMax', 'CPUQuotaPerSecUSec']
    result = command(['systemctl', 'show', 'praxis-code.service', *sum((['-p', value] for value in properties), [])], capture_output=True)
    state = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    check(state.get('User') == state.get('Group') == 'root', 'Coding service is not running as root.')
    for name in ('ProtectSystem', 'ProtectHome', 'PrivateNetwork', 'PrivateTmp', 'NoNewPrivileges'):
        check(state.get(name) == 'no', 'Inherited restriction remains: ' + name)
    for name in ('InaccessiblePaths', 'IPAddressDeny'): check(state.get(name) == '', 'Inherited restriction remains: ' + name)
    for name in ('MemoryMax', 'MemoryHigh', 'MemorySwapMax', 'TasksMax', 'CPUQuotaPerSecUSec'):
        check(state.get(name) == 'infinity', 'Inherited resource limit remains: ' + name)
    return {'user': 'root', 'configuredRestrictionsRemoved': True}


def plan(bs, source, acceptance, expected_app, expected_control, updater, command=None):
    command = command or bs.run
    tree = check_source(bs, source, acceptance)
    coding = current_state(bs, updater, expected_app, expected_control)
    ensure_idle(bs, updater)
    version = command(['systemctl', '--version'], capture_output=True).stdout.splitlines()[0]
    check(re.match(r'systemd (\d+)', version) and int(re.match(r'systemd (\d+)', version)[1]) >= 250,
          'Native job ExitType=cgroup requires systemd 250 or newer.')
    masks = dropin_masks(command)
    release = 'app-native-' + acceptance['sourceCommit'][:12]
    for target in (CONTROL.parent / 'releases' / acceptance['sourceCommit'][:12], Path(updater['releasesRoot']) / release):
        check(not target.exists() and not target.is_symlink(), 'Native release target exists; inspect the saved migration instead of repeating it.')
    return {'sourceCommit': acceptance['sourceCommit'], 'artifactSha256': acceptance['artifactSha256'],
            'previousApplication': expected_app, 'previousControl': expected_control, 'applicationRelease': release,
            'controlRelease': acceptance['sourceCommit'][:12], 'executionMode': 'native-root',
            'workspaceDirectory': str(NATIVE_ROOT / 'workspaces'), 'legacyWorkspaceDirectory': coding['workspaceDirectory'],
            'maskedDropIns': [str(path) for path in masks], 'disabledService': 'praxis-dependencies.service',
            'databasesRestored': False, 'historicalStoragePreserved': True}, tree, masks


def apply(bs, source, acceptance, expected_app, expected_control, backup, updater, command=None):
    command = command or bs.run
    receipt, tree, masks = plan(bs, source, acceptance, expected_app, expected_control, updater, command)
    code_path = Path(updater['codingConfig']); code_bytes = code_path.read_bytes()
    operation = str(uuid.uuid4()); receipt.update(operationId=operation, phase='intent')
    bs.install_json(backup / 'native-migration.json', receipt, 0o600)
    # The old staging mount stays mounted/enabled for historical evidence.
    bs.ISOLATED_UNITS = ['praxis-updater.service', 'praxis-dependencies.service']
    database_metadata = []
    with transaction_type(bs, database_metadata, command)(backup, paths=fixed_paths(bs, updater, masks), command=command,
                                 idle=lambda: ensure_idle(bs, updater)) as transaction:
        transaction.quiesce()
        transaction.changed = True
        command(['systemctl', 'stop', 'praxis-updater.service']); stopped(command, 'praxis-updater.service')
        ensure_idle(bs, updater)
        check(APP.resolve().name == expected_app and CONTROL.resolve().name == expected_control and code_path.read_bytes() == code_bytes,
              'A release/configuration precondition changed during drain.')
        database_metadata.extend(snapshot_databases(updater, backup))
        receipt['databaseOwnership'] = database_metadata
        bs.install_json(backup / 'native-migration.json', receipt, 0o600)
        bs.install_json(bs.FENCE, {'state': 'draining', 'operationId': operation}, 0o644)
        command(['systemctl', 'stop', 'praxis-dependencies.service']); stopped(command, 'praxis-dependencies.service')
        command(['systemctl', 'disable', 'praxis-dependencies.service'])
        git = json.loads(GIT_CONFIG.read_text()); git_info = protected_file(GIT_CONFIG)
        initialize_native_home(bs, git)
        control = CONTROL.parent / 'releases' / receipt['controlRelease']
        app = Path(updater['releasesRoot']) / receipt['applicationRelease']
        for target in (control, app):
            bs.copy_release(source, target)
            check(bs.accepted_tree(target) == tree, 'Installed artifact differs from accepted source.')
        bs.install_json(app / 'release.json', {'release': receipt['applicationRelease'], 'sourceCommit': receipt['sourceCommit'],
                                             'artifactSha256': receipt['artifactSha256']}, 0o644)
        for name, destination in INSTALLED.items(): bs.install_text(destination, (control / name).read_bytes(), 0o755)
        for unit in UNITS: bs.install_text(UNIT_ROOT / unit, native_unit('code' if unit == 'praxis-code.service' else 'updater'))
        for target in masks:
            target.parent.mkdir(parents=True, exist_ok=True)
            replace_link(target, Path('/dev/null'))
        coding = native_config(json.loads(code_bytes), receipt['applicationRelease'])
        info = protected_file(code_path)
        bs.install_json(code_path, coding, stat.S_IMODE(info.st_mode)); os.chown(code_path, info.st_uid, info.st_gid)
        updated = copy.deepcopy(updater)
        updated.update(executionMode='native-root', stagingRoot=str(NATIVE_ROOT / 'stages'), stagingMount=str(NATIVE_ROOT),
                       stageUser='root', nativeHome=str(NATIVE_ROOT / 'home'))
        updated['protectedFiles'] = {name: value['sha256'] for name, value in tree.items() if 'sha256' in value and
            (name.startswith(('deploy/', 'src/git/', 'scripts/release-')) or name in updater.get('protectedFiles', {}))}
        bs.install_json(UPDATER_CONFIG, updated, 0o600)
        git['release'] = 'control-' + receipt['controlRelease']
        bs.install_json(GIT_CONFIG, git, stat.S_IMODE(git_info.st_mode)); os.chown(GIT_CONFIG, 0, git_info.st_gid)
        bs.install_text(CONTROL_ENV, 'PRAXIS_RELEASE=' + git['release'] + '\n')
        replace_link(CONTROL, control); replace_link(APP, app)
        command(['systemctl', 'daemon-reload'])
        command(['systemd-analyze', 'verify', *(str(UNIT_ROOT / unit) for unit in UNITS)])
        transaction.release_bootstrap_guard()
        command(['systemctl', 'start', 'praxis-git.service', 'praxis-code.service', 'praxis-updater.service', 'praxis-probe.service'])
        bs.confirm_startup(coding, git, command=command)
        receipt['nativeService'] = verify_native_service(command)
        receipt['liveHealth'] = bs.confirm_authenticated_startup(updater['healthConfig'], receipt['applicationRelease'], command=command)
        receipt['phase'] = 'activation_confirmed'
        bs.install_json(backup / 'native-migration.json', receipt, 0o600)
        # A lost response after opening admission must not roll back newly issued jobs.
        transaction.committed = True
        bs.install_json(bs.FENCE, {'state': 'active', 'operationId': operation, 'release': receipt['applicationRelease']}, 0o644)
        receipt['phase'] = 'completed'; bs.install_json(backup / 'native-migration.json', receipt, 0o600)
    return receipt


def load_bootstrap(updater, control=None):
    bootstrap = (control or CONTROL.resolve(strict=True)) / 'deploy/bootstrap-autonomy.py'; protected_file(bootstrap)
    check(hashlib.sha256(bootstrap.read_bytes()).hexdigest() == updater['protectedFiles']['deploy/bootstrap-autonomy.py'],
          'Installed bootstrap implementation differs from its recorded hash.')
    spec = importlib.util.spec_from_file_location('native_installed_bootstrap', bootstrap)
    module = importlib.util.module_from_spec(spec)
    sys.dont_write_bytecode = True; spec.loader.exec_module(module)
    return module


def recovery_bootstrap(backup):
    # A crash may leave new updater configuration with the old control pointer,
    # or the opposite. Load the old trusted pair from the transaction snapshot.
    check(backup.parent == BACKUP_ROOT and backup.resolve() == backup and backup.stat().st_uid == 0
          and backup.stat().st_mode & 0o077 == 0, 'Expected a private owner migration backup.')
    protected_file(backup / 'rollback.json', private=True)
    saved = json.loads((backup / 'rollback.json').read_text())
    previous_config = next(item for item in saved['files'] if item['path'] == str(UPDATER_CONFIG))
    previous_control = next(item for item in saved['files'] if item['path'] == str(CONTROL))
    check(re.fullmatch(r'file-\d+', previous_config.get('backupFile', '')), 'Invalid saved updater configuration.')
    filename = backup / previous_config['backupFile']; protected_file(filename, private=True)
    updater = json.loads(filename.read_text())
    control = Path(previous_control.get('link', ''))
    if not control.is_absolute(): control = CONTROL.parent / control
    check(control.resolve(strict=True) == control and control.parent == CONTROL.parent / 'releases', 'Invalid saved control release.')
    return load_bootstrap(updater, control), updater


def recover(bs, backup, updater, command=None):
    command = command or bs.run
    check(backup.parent == BACKUP_ROOT and backup.resolve() == backup and backup.stat().st_uid == 0
          and backup.stat().st_mode & 0o077 == 0, 'Expected a private owner migration backup.')
    protected_file(backup / 'native-migration.json', private=True)
    receipt = json.loads((backup / 'native-migration.json').read_text())
    fence = json.loads(bs.FENCE.read_text())
    check(fence.get('operationId') == receipt['operationId'] or bs.ADMISSION_GATE.exists(), 'Migration no longer owns admission; do not restore over subsequent work.')
    if receipt['phase'] in ('activation_confirmed', 'completed'):
        check(APP.resolve().name == receipt['applicationRelease'] and CONTROL.resolve().name == receipt['controlRelease'], 'Confirmed migration pointers changed.')
        bs.confirm_authenticated_startup(updater['healthConfig'], receipt['applicationRelease'], command=command)
        bs.install_json(bs.FENCE, {'state': 'active', 'operationId': receipt['operationId'], 'release': receipt['applicationRelease']}, 0o644)
        receipt['phase'] = 'completed'; bs.install_json(backup / 'native-migration.json', receipt, 0o600)
        return receipt
    check(fence.get('state') != 'active' or bs.ADMISSION_GATE.exists(), 'Admission is open; automatic rollback is no longer safe.')
    ensure_idle(bs, updater)
    protected_file(backup / 'rollback.json', private=True)
    saved = json.loads((backup / 'rollback.json').read_text())
    bs.ISOLATED_UNITS = ['praxis-updater.service', 'praxis-dependencies.service']
    transaction = transaction_type(bs, receipt.get('databaseOwnership', []), command)(backup, command=command)
    transaction.saved, transaction.services = saved['files'], saved['services']
    transaction.changed = transaction.guard_installed = transaction.ingress_stopped = transaction.backends_stopped = True
    transaction.rollback()
    receipt['phase'] = 'rolled_back'; bs.install_json(backup / 'native-migration.json', receipt, 0o600)
    return receipt


def main():
    check(os.getuid() == 0, 'Owner root must run this migration.')
    check(len(sys.argv) >= 2 and sys.argv[1] in ('plan', 'apply', 'recover'), 'Use plan/apply QUALIFIED_TREE ACCEPTANCE EXPECTED_APP EXPECTED_CONTROL, or recover PRIVATE_BACKUP.')
    mode = sys.argv[1]
    if mode == 'recover':
        check(len(sys.argv) == 3, 'Recovery requires one private migration backup.')
        bs, updater = recovery_bootstrap(Path(sys.argv[2]))
    else:
        protected_file(UPDATER_CONFIG, private=True); updater = json.loads(UPDATER_CONFIG.read_text())
        bs = load_bootstrap(updater)
    if mode == 'plan':
        check(len(sys.argv) == 6, 'Qualified source, acceptance and both expected releases are required.')
        source, accepted = map(Path, sys.argv[2:4]); protected_file(accepted, private=True)
        check(accepted.stat().st_size <= 131072, 'Acceptance is oversized.')
        print(json.dumps(plan(bs, source, json.loads(accepted.read_text()), sys.argv[4], sys.argv[5], updater)[0]))
        return  # A plan creates no lock, backup, directories, or runtime state.
    import fcntl
    fd = os.open('/var/lib/praxis-bootstrap.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as lock:
        info = os.fstat(lock.fileno())
        check(info.st_uid == 0 and info.st_mode & 0o077 == 0 and stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'Unsafe migration lock.')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if mode == 'recover':
            check(len(sys.argv) == 3, 'Recovery requires one private migration backup.')
            result = recover(bs, Path(sys.argv[2]), updater)
        else:
            check(len(sys.argv) == 6, 'Qualified source, acceptance and both expected releases are required.')
            source, accepted = map(Path, sys.argv[2:4]); expected_app, expected_control = sys.argv[4:6]
            protected_file(accepted, private=True); check(accepted.stat().st_size <= 131072, 'Acceptance is oversized.')
            acceptance = json.loads(accepted.read_text())
            if mode == 'plan': result = plan(bs, source, acceptance, expected_app, expected_control, updater)[0]
            else:
                backup = BACKUP_ROOT / ('native-root-' + str(uuid.uuid4())); backup.mkdir(mode=0o700)
                os.chmod(backup, 0o700)
                result = apply(bs, source, acceptance, expected_app, expected_control, backup, updater)
                result['backup'] = str(backup)
        print(json.dumps(result))


if __name__ == '__main__': main()
