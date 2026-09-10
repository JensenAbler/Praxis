#!/usr/bin/python3
"""Owner-only maintenance for the two fixed deployment helpers; no MCP API.

Usage: update-control.py QUALIFIED_ROOT_TREE PRIVATE_ACCEPTANCE EXPECTED_CONTROL_BASENAME
The current coding application, its release config, databases and credentials
are preserved. The installed bootstrap transaction supplies guarded rollback.
"""
import contextlib
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import sqlite3
import stat
import sys
import uuid

CONTROL = pathlib.Path('/srv/praxis-control/current')
APP = pathlib.Path('/srv/praxis-app/current')
UPDATER_CONFIG = pathlib.Path('/etc/praxis-updater/config.json')
GIT_CONFIG = pathlib.Path('/etc/praxis-git/config.json')
CONTROL_ENV = pathlib.Path('/etc/praxis-updater/control.env')
HELPERS = {'deploy/deploy-discord.py': '/usr/local/libexec/praxis-deploy-discord',
           'deploy/deploy-project.py': '/usr/local/libexec/praxis-deploy-project'}
UTILITY = 'deploy/update-control.py'
OWNER_CLIENT = 'scripts/autonomy-live-qualification.js'


def check(value, message):
    if not value: raise RuntimeError(message)


def protected_file(path, private=False):
    info = path.lstat()
    check(path.resolve() == path and stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
          and info.st_mode & (0o077 if private else 0o022) == 0, 'Expected protected ordinary file: ' + str(path))
    return info


def accepted_changes(before, after, protected):
    for name, expected in protected.items():
        check(before.get(name, {}).get('sha256') == expected, 'Installed protected source differs from recorded policy: ' + name)
        if name not in HELPERS:
            check(after.get(name, {}).get('sha256') == expected, 'Candidate changes a protected component outside the helper allowlist: ' + name)
    changed = sorted(name for name in before.keys() | after.keys() if before.get(name) != after.get(name))
    for name in changed:
        documentation = name.startswith(('docs/', 'test/')) or ('/' not in name and name.endswith('.md'))
        check(name in HELPERS or name in (UTILITY, OWNER_CLIENT) or documentation,
              'Candidate changes frozen runtime or an unapproved owner component: ' + name)
    for name in HELPERS:
        check('sha256' in after.get(name, {}) and after[name].get('bytes', 0) > 0, 'Required deployment helper is missing.')
    check(any(name in HELPERS for name in changed), 'No allowed deployment helper change is present.')
    return changed


def ensure_idle(bs, updater):
    bs.ensure_idle(updater['codingDatabase'], updater['gitDatabase'])
    for filename, query in [
        (updater['codingDatabase'], "SELECT COUNT(*) FROM operations WHERE status='prepared'"),
        (str(pathlib.Path(updater['dataDirectory']) / 'releases.sqlite'),
         "SELECT COUNT(*) FROM releases WHERE status IN ('queued','running','waiting') OR phase='restoration_failed'")
    ]:
        with contextlib.closing(sqlite3.connect(pathlib.Path(filename).as_uri() + '?mode=ro', uri=True)) as db:
            check(db.execute(query).fetchone()[0] == 0, 'Pending edits or updater operations require recovery before control maintenance.')


def activate(bs, source, acceptance, expected, backup, updater, paths=None, command=None):
    command = command or bs.run
    control = CONTROL.resolve(strict=True)
    check(CONTROL.is_symlink() and control.parent == CONTROL.parent / 'releases' and control.name == expected,
          'Current control release changed; inspect its exact basename before maintenance.')
    check(control.stat().st_uid == 0 and control.stat().st_mode & 0o022 == 0, 'Installed control root is not protected.')
    check(not bs.ADMISSION_GATE.exists(), 'An unfinished owner bootstrap guard requires recovery first.')
    check(json.loads(bs.FENCE.read_text()).get('state') == 'active', 'The generation fence is already held; recover its owner operation first.')
    code_path = pathlib.Path(updater['codingConfig'])
    code_bytes, app_target = code_path.read_bytes(), os.readlink(APP)
    coding = json.loads(code_bytes)
    check(APP.is_symlink() and APP.resolve().parent == pathlib.Path(updater['releasesRoot']) and APP.resolve().name == coding['release'],
          'Application pointer and configured release disagree.')
    before, after = bs.accepted_tree(control), bs.accepted_tree(source)
    check(hashlib.sha256(json.dumps(after, sort_keys=True).encode()).hexdigest() == acceptance['artifactSha256'],
          'Prepared artifact differs from its acceptance.')
    changes = accepted_changes(before, after, updater['protectedFiles'])
    commit = acceptance['sourceCommit']; target = control.parent / commit[:12]
    check(not target.exists() and not target.is_symlink(), 'Control target already exists; inspect saved maintenance evidence instead of repeating effects.')
    operation = str(uuid.uuid4())
    with bs.BootstrapTransaction(backup, paths=paths, command=command, idle=lambda: ensure_idle(bs, updater)) as transaction:
        transaction.quiesce()
        transaction.changed = True
        command(['systemctl', 'stop', 'praxis-updater.service'])
        stopped = command(['systemctl', 'show', 'praxis-updater.service', '-p', 'ActiveState', '-p', 'MainPID'], capture_output=True)
        state = dict(line.split('=', 1) for line in stopped.stdout.splitlines() if '=' in line)
        check(state.get('ActiveState') in ('inactive', 'failed') and state.get('MainPID') == '0', 'Updater shutdown is unconfirmed.')
        ensure_idle(bs, updater)
        check(CONTROL.resolve() == control and code_path.read_bytes() == code_bytes and os.readlink(APP) == app_target,
              'An application/control precondition changed during drain.')
        bs.install_json(bs.FENCE, {'state': 'draining', 'operationId': operation}, 0o644)
        bs.copy_release(source, target)
        check(bs.accepted_tree(target) == after, 'Installed control bytes differ from the accepted tree.')
        for name, destination in HELPERS.items(): bs.install_text(destination, (target / name).read_bytes(), 0o755)
        updated = {**updater, 'protectedFiles': dict(updater['protectedFiles'])}
        for name in [*HELPERS, UTILITY]:
            if name in after: updated['protectedFiles'][name] = after[name]['sha256']
        bs.install_json(UPDATER_CONFIG, updated, 0o600)
        git_path = GIT_CONFIG
        info = protected_file(git_path); git = json.loads(git_path.read_text())
        git['release'] = 'control-' + commit[:12]
        bs.install_json(git_path, git, stat.S_IMODE(info.st_mode)); os.chown(git_path, 0, info.st_gid)
        bs.install_text(CONTROL_ENV, 'PRAXIS_RELEASE=' + git['release'] + '\n')
        link = CONTROL.with_name('next-' + operation); link.symlink_to(target); os.replace(link, CONTROL)
        descriptor = os.open(CONTROL.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(descriptor)
        finally: os.close(descriptor)
        transaction.release_bootstrap_guard()
        command(['systemctl', 'start', *bs.CORE_UNITS[1:], bs.CORE_UNITS[0], 'praxis-updater.service'])
        bs.confirm_startup(coding, git, command=command)
        health = bs.confirm_authenticated_startup(updater['healthConfig'], coding['release'], command=command)
        check(code_path.read_bytes() == code_bytes and os.readlink(APP) == app_target, 'Maintenance changed the application slot.')
        receipt = {'operationId': operation, 'phase': 'activation_confirmed', 'sourceCommit': commit,
                   'previousControl': expected, 'controlRelease': target.name, 'applicationRelease': coding['release'],
                   'changedFiles': changes, 'liveHealth': health, 'databasesRestored': False}
        bs.install_json(backup / 'control-maintenance-receipt.json', receipt, 0o600)
        # After this durable decision, a lost fence-write response must never
        # roll back over newly admitted work. Owner recovery uses this receipt.
        transaction.committed = True
        bs.install_json(bs.FENCE, {'state': 'active', 'release': coding['release'], 'operationId': operation}, 0o644)
        receipt['phase'] = 'completed'
        bs.install_json(backup / 'control-maintenance-receipt.json', receipt, 0o600)
    return receipt


def main():
    check(os.getuid() == 0 and len(sys.argv) == 4, 'Owner root must supply qualified source, acceptance, and expected control basename.')
    source, receipt_file = map(pathlib.Path, sys.argv[1:3]); expected = sys.argv[3]
    check(re.fullmatch('[a-f0-9]{12}', expected), 'Expected control basename must be its twelve-character source prefix.')
    check(source.resolve() == source and source.is_dir() and source.stat().st_uid == 0 and source.stat().st_mode & 0o022 == 0, 'Expected immutable root-owned source.')
    protected_file(receipt_file, private=True); protected_file(UPDATER_CONFIG, private=True)
    check(receipt_file.stat().st_size <= 131072, 'Acceptance is oversized.')
    acceptance = json.loads(receipt_file.read_text()); updater = json.loads(UPDATER_CONFIG.read_text())
    check(re.fullmatch('[a-f0-9]{40}', acceptance.get('sourceCommit', '')) and
          all(acceptance.get(name) is True for name in ['npmTestPassed', 'authenticatedMcpPassed']), 'Candidate qualification is incomplete.')
    # Import only the frozen installed transaction, never a candidate helper.
    bootstrap = CONTROL.resolve(strict=True) / 'deploy/bootstrap-autonomy.py'; protected_file(bootstrap)
    check(hashlib.sha256(bootstrap.read_bytes()).hexdigest() == updater['protectedFiles']['deploy/bootstrap-autonomy.py'], 'Installed bootstrap implementation changed.')
    spec = importlib.util.spec_from_file_location('installed_praxis_bootstrap', bootstrap)
    bs = importlib.util.module_from_spec(spec); sys.dont_write_bytecode = True; spec.loader.exec_module(bs)
    import fcntl
    descriptor = os.open('/var/lib/praxis-bootstrap.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'a') as lock:
        info = os.fstat(lock.fileno())
        check(info.st_uid == 0 and info.st_mode & 0o077 == 0 and stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'Unsafe owner maintenance lock.')
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        backup = pathlib.Path('/root/praxis-probe-backups') / ('control-maintenance-' + str(uuid.uuid4()))
        backup.mkdir(mode=0o700)
        receipt = activate(bs, source, acceptance, expected, backup, updater)
        print(json.dumps({'configured': True, 'controlRelease': receipt['controlRelease'], 'applicationRelease': receipt['applicationRelease'], 'backup': str(backup)}))


if __name__ == '__main__': main()
