"""Native owner migration fixtures. Service calls are mocked; no live effects."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parents[1] / 'deploy' / filename)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


migration = load('native_migration_test', 'migrate-native-root.py')
bootstrap = load('native_migration_bootstrap', 'bootstrap-autonomy.py')


class NativeConfiguration(unittest.TestCase):
    def test_unit_replaces_privilege_network_and_resource_restrictions(self):
        unit = migration.native_unit('code')
        for line in ['User=root', 'Group=root', 'ProtectSystem=no', 'ProtectHome=no', 'PrivateNetwork=no',
                     'PrivateTmp=no', 'InaccessiblePaths=', 'IPAddressDeny=', 'CapabilityBoundingSet=~',
                     'MemoryMax=infinity', 'MemoryHigh=infinity', 'MemorySwapMax=infinity', 'TasksMax=infinity', 'CPUQuota=']:
            self.assertIn(line + '\n', unit)
        self.assertNotIn('RuntimeDirectory=', unit, 'Preserve ownership of old rootless runtime storage')
        self.assertNotIn('Requires=', unit)
        self.assertNotIn('praxis-dependencies', migration.native_unit('updater'))
        self.assertNotIn('srv-praxis', migration.native_unit('updater'))

    def test_config_preserves_credentials_and_history_but_new_execution_uses_normal_disk(self):
        original = {'release': 'old', 'workspaceDirectory': '/old-volume/workspaces', 'dataDirectory': '/old/db',
                    'publicJwks': {'keys': ['fixture']}, 'projects': [{'id': 'discord'}],
                    'runnerConfig': {'image': 'old-image', 'logDirectory': '/old-volume/logs'}, 'git': {'url': 'fixture'}}
        after = migration.native_config(original, 'new')
        self.assertEqual(after['executionMode'], 'native-root')
        self.assertEqual(after['runnerConfig']['type'], 'native-root')
        self.assertEqual(after['workspaceDirectory'], str(migration.NATIVE_ROOT / 'workspaces'))
        self.assertEqual(after['legacyWorkspaceDirectories'], ['/old-volume/workspaces'])
        self.assertEqual(after['legacyRunnerConfig'], original['runnerConfig'])
        for name in ('publicJwks', 'projects', 'dataDirectory', 'git'): self.assertEqual(after[name], original[name])
        self.assertNotIn('legacyRunnerConfig', original)
        self.assertEqual(migration.native_config(after, 'next')['legacyWorkspaceDirectories'], ['/old-volume/workspaces'])

    def test_masks_loaded_global_and_local_dropins_without_changing_global_files(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(migration, 'UNIT_ROOT', Path(tmp)):
            directory = Path(tmp) / 'praxis-code.service.d'; directory.mkdir()
            (directory / 'autonomy.conf').write_text('old')
            command = lambda *args, **kwargs: SimpleNamespace(stdout='/usr/lib/systemd/system/service.d/99-policy.conf\n')
            masks = migration.dropin_masks(command)
            self.assertEqual(set(masks), {directory / 'autonomy.conf', directory / '99-policy.conf',
                                         Path(tmp) / 'praxis-updater.service.d/99-policy.conf'})
            self.assertEqual((directory / 'autonomy.conf').read_text(), 'old')


@unittest.skipUnless(os.name == 'posix' and getattr(os, 'getuid', lambda: -1)() == 0, 'Isolated owner-root Linux fixture')
class NativeMigration(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='praxis-native-migration-')
        self.addCleanup(self.temp.cleanup); self.root = Path(self.temp.name)
        self.control = self.root / 'control/current'; self.old_control = self.control.parent / 'releases' / ('a' * 12)
        self.old_control.mkdir(parents=True); self.control.symlink_to(self.old_control)
        self.app = self.root / 'app/current'; self.old_app = self.app.parent / 'releases/app-old'
        self.old_app.mkdir(parents=True); self.app.symlink_to(self.old_app)
        self.source = self.root / 'qualified'; self.source.mkdir()
        self.installed = {name: self.root / 'installed' / target.name for name, target in migration.INSTALLED.items()}
        names = [*self.installed, 'src/code/native-worker.py', 'src/code/native-runner.js', 'coding-tools.json',
                 'scripts/release-live-check.js', 'deploy/migrate-native-root.py', 'deploy/bootstrap-autonomy.py']
        for name in names:
            for directory in (self.source, self.old_control):
                path = directory / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('new' if directory == self.source else 'old')
        for destination in self.installed.values(): destination.parent.mkdir(parents=True, exist_ok=True); destination.write_text('old installed')
        self.code = self.root / 'code.json'; self.git = self.root / 'git.json'; self.env = self.root / 'control.env'
        self.updater_path = self.root / 'updater.json'; self.unit_root = self.root / 'units'; self.unit_root.mkdir()
        self.native_root = self.root / 'native'
        self.history = self.root / 'legacy/workspaces/retained'; self.history.mkdir(parents=True)
        (self.history / 'existing.log').write_text('original legacy evidence')
        self.code.write_text(json.dumps({'release': 'app-old', 'workspaceDirectory': str(self.history.parent),
                                        'dataDirectory': str(self.root), 'publicJwks': {'keys': ['retained']},
                                        'runnerConfig': {'image': 'old-image'}}))
        self.git.write_text('{"release":"control-old","repositories":[]}'); self.env.write_text('old env')
        for unit in migration.UNITS: (self.unit_root / unit).write_text('old unit ' + unit)
        self.old_dropin = self.unit_root / 'praxis-code.service.d/autonomy.conf'; self.old_dropin.parent.mkdir()
        self.old_dropin.write_text('old restriction')
        self.fence = self.root / 'activation.json'; self.fence.write_text('{"state":"active"}')
        self.gate = self.root / 'guard'; self.admission = self.root / 'admission.conf'
        self.state_dir = self.root / 'state'; self.state_dir.mkdir()
        code_db, git_db = self.root / 'code.sqlite', self.root / 'git.sqlite'
        for filename, ddl in [(code_db, 'CREATE TABLE code_jobs(status TEXT); INSERT INTO code_jobs VALUES("completed"); CREATE TABLE operations(status TEXT);'),
                              (git_db, 'CREATE TABLE git_operations(status TEXT);'),
                              (self.state_dir / 'releases.sqlite', 'CREATE TABLE releases(status TEXT, phase TEXT);')]:
            with sqlite3.connect(filename) as db: db.executescript(ddl)
        self.updater = {'codingConfig': str(self.code), 'codingDatabase': str(code_db), 'gitDatabase': str(git_db),
                        'dataDirectory': str(self.state_dir), 'healthConfig': '/fixture/health.json', 'releasesRoot': str(self.old_app.parent),
                        'protectedFiles': {'deploy/bootstrap-autonomy.py': 'old recorded hash'}}
        self.updater_path.write_text(json.dumps(self.updater)); self.updater_path.chmod(0o600)
        self.acceptance = {'sourceCommit': 'b' * 40, 'npmTestPassed': True, 'authenticatedMcpPassed': True,
                           'artifactSha256': hashlib.sha256(json.dumps(bootstrap.accepted_tree(self.source), sort_keys=True).encode()).hexdigest()}
        self.backup = self.root / 'backups/native-fixture'; self.backup.mkdir(parents=True, mode=0o700)
        self.commands = []; self.addCleanup(patch.stopall)
        patch.multiple(migration, CONTROL=self.control, APP=self.app, UPDATER_CONFIG=self.updater_path,
                       GIT_CONFIG=self.git, CONTROL_ENV=self.env, INSTALLED=self.installed, UNIT_ROOT=self.unit_root,
                       NATIVE_ROOT=self.native_root, BACKUP_ROOT=self.backup.parent).start()
        patch.multiple(bootstrap, FENCE=self.fence, ADMISSION_GATE=self.gate, ADMISSION_DROPIN=self.admission,
                       ISOLATED_UNITS=['praxis-updater.service', 'praxis-dependencies.service']).start()
        patch.object(bootstrap, 'confirm_startup', return_value=None).start()
        patch.object(bootstrap, 'confirm_authenticated_startup', return_value={'ok': True, 'release': 'app-native-' + 'b' * 12}).start()

    def command(self, argv, **kwargs):
        self.commands.append(argv)
        if argv == ['systemctl', '--version']: return SimpleNamespace(stdout='systemd 255\n', returncode=0)
        if '--property=DropInPaths' in argv: return SimpleNamespace(stdout=str(self.old_dropin) if 'praxis-code.service' in argv else '', returncode=0)
        if 'CPUQuotaPerSecUSec' in argv:
            return SimpleNamespace(stdout='User=root\nGroup=root\nProtectSystem=no\nProtectHome=no\nPrivateNetwork=no\nPrivateTmp=no\nNoNewPrivileges=no\nInaccessiblePaths=\nIPAddressDeny=\nMemoryMax=infinity\nMemoryHigh=infinity\nMemorySwapMax=infinity\nTasksMax=infinity\nCPUQuotaPerSecUSec=infinity\n', returncode=0)
        if '-p' in argv: return SimpleNamespace(stdout='ActiveState=inactive\nMainPID=0\n', returncode=0)
        if '--property=ActiveState' in argv: return SimpleNamespace(stdout='active\n', returncode=0)
        if '--property=LoadState' in argv: return SimpleNamespace(stdout='loaded\n', returncode=0)
        if argv[:2] == ['systemctl', 'is-enabled']: return SimpleNamespace(stdout='enabled\n', returncode=0)
        return SimpleNamespace(stdout='', returncode=0)

    def apply(self):
        return migration.apply(bootstrap, self.source, self.acceptance, 'app-old', 'a' * 12, self.backup, self.updater, self.command)

    def test_plan_only_reads_and_failed_qualification_never_stops_services(self):
        before = {path: path.read_bytes() for path in self.root.rglob('*') if path.is_file()}
        result, _, _ = migration.plan(bootstrap, self.source, self.acceptance, 'app-old', 'a' * 12, self.updater, self.command)
        self.assertEqual(result['executionMode'], 'native-root')
        self.assertEqual({path: path.read_bytes() for path in before}, before)
        (self.source / 'src/code/native-worker.py').write_text('changed after acceptance')
        with self.assertRaisesRegex(RuntimeError, 'artifact differs'): self.apply()
        self.assertFalse(any(command[:2] == ['systemctl', 'stop'] for command in self.commands))
        self.assertFalse(self.native_root.exists())

    def test_active_job_blocks_without_interruption_or_history_changes(self):
        with sqlite3.connect(self.updater['codingDatabase']) as db: db.execute('INSERT INTO code_jobs VALUES("running")')
        with self.assertRaisesRegex(RuntimeError, 'Existing coding jobs'): self.apply()
        self.assertFalse(any(command[:2] == ['systemctl', 'stop'] for command in self.commands))
        self.assertEqual((self.history / 'existing.log').read_text(), 'original legacy evidence')

    def test_success_installs_native_but_preserves_every_database_and_old_workspace(self):
        databases = {path: path.read_bytes() for path in self.root.rglob('*.sqlite')}
        result = self.apply()
        self.assertEqual(result['phase'], 'completed')
        self.assertEqual(self.control.resolve().name, 'b' * 12)
        self.assertEqual(self.app.resolve().name, 'app-native-' + 'b' * 12)
        self.assertEqual(os.readlink(self.old_dropin), '/dev/null')
        self.assertEqual({path: path.read_bytes() for path in databases}, databases)
        self.assertEqual((self.history / 'existing.log').read_text(), 'original legacy evidence')
        self.assertTrue(self.old_app.exists()); self.assertTrue(self.old_control.exists())
        code = json.loads(self.code.read_text()); self.assertEqual(code['publicJwks'], {'keys': ['retained']})
        self.assertEqual(code['legacyWorkspaceDirectories'], [str(self.history.parent)])
        self.assertEqual(json.loads(self.updater_path.read_text())['executionMode'], 'native-root')
        self.assertIn('defaultBranch = main', (self.native_root / 'home/.gitconfig').read_text())
        self.assertIn(['systemctl', 'disable', 'praxis-dependencies.service'], self.commands)
        self.assertFalse(any('podman' in ' '.join(command) or 'podcast' in ' '.join(command) or '.mount' in ' '.join(command) for command in self.commands))
        self.assertEqual(json.loads(self.fence.read_text())['state'], 'active')
        for name in ('coding', 'git', 'updater'): self.assertTrue((self.backup / (name + '.sqlite')).exists())

    def test_health_failure_restores_units_dropins_configs_and_pointers_without_restoring_database(self):
        before = {path: path.read_bytes() for path in [self.code, self.git, self.env, self.updater_path, self.old_dropin,
                                                     *(self.unit_root / unit for unit in migration.UNITS), *self.installed.values()]}
        with patch.object(bootstrap, 'confirm_authenticated_startup', side_effect=RuntimeError('failed native health')):
            with self.assertRaisesRegex(RuntimeError, 'failed native health'): self.apply()
        self.assertEqual(self.app.resolve(), self.old_app); self.assertEqual(self.control.resolve(), self.old_control)
        for path, contents in before.items(): self.assertEqual(path.read_bytes(), contents)
        self.assertFalse(self.old_dropin.is_symlink())
        self.assertTrue(json.loads((self.backup / 'rollback-result.json').read_text())['restored'])
        self.assertTrue(self.native_root.exists(), 'New files stay available for diagnosis')

    def test_lost_final_receipt_never_rolls_back_newly_admitted_work(self):
        original = bootstrap.install_json
        def write(path, data, *args, **kwargs):
            if Path(path) == self.backup / 'native-migration.json' and data.get('phase') == 'completed':
                raise RuntimeError('lost final receipt')
            return original(path, data, *args, **kwargs)
        with patch.object(bootstrap, 'install_json', side_effect=write):
            with self.assertRaisesRegex(RuntimeError, 'lost final receipt'): self.apply()
        self.assertEqual(json.loads(self.fence.read_text())['state'], 'active')
        self.assertEqual(self.app.resolve().name, 'app-native-' + 'b' * 12)
        self.assertFalse((self.backup / 'rollback-result.json').exists())
        before = len(self.commands)
        migration.recover(bootstrap, self.backup, json.loads(self.updater_path.read_text()), self.command)
        self.assertFalse(any(command[:2] == ['systemctl', 'stop'] for command in self.commands[before:]))
        self.assertEqual(json.loads((self.backup / 'native-migration.json').read_text())['phase'], 'completed')

    def test_recovery_refuses_to_restore_over_newer_admission_operation(self):
        self.apply()
        self.fence.write_text('{"state":"active","operationId":"other"}')
        before = len(self.commands)
        with self.assertRaisesRegex(RuntimeError, 'no longer owns admission'):
            migration.recover(bootstrap, self.backup, self.updater, self.command)
        self.assertEqual(len(self.commands), before)

    def test_recovery_loads_saved_matching_control_config_across_partial_pointer_switch(self):
        self.apply()
        # Simulate a new config/control hash mismatch after a power loss. Recovery
        # must use the old saved pair, without importing either candidate copy.
        self.updater_path.write_text('{"protectedFiles":{"deploy/bootstrap-autonomy.py":"new-hash"}}')
        with patch.object(migration, 'load_bootstrap', return_value=bootstrap) as load_saved:
            module, config = migration.recovery_bootstrap(self.backup)
        self.assertIs(module, bootstrap)
        self.assertEqual(config, self.updater)
        load_saved.assert_called_once_with(self.updater, self.old_control)

    def test_rollback_restores_sqlite_sidecar_ownership_without_overwriting_bytes(self):
        database = Path(self.updater['codingDatabase'])
        os.chown(database, 12345, 12345)
        sidecar = Path(str(database) + '-journal')
        def fail(*args, **kwargs):
            sidecar.write_bytes(b'newer retained SQLite recovery bytes'); sidecar.chmod(0o600)
            raise RuntimeError('failed after root opened database')
        with patch.object(bootstrap, 'confirm_authenticated_startup', side_effect=fail):
            with self.assertRaisesRegex(RuntimeError, 'failed after root'): self.apply()
        self.assertEqual(sidecar.read_bytes(), b'newer retained SQLite recovery bytes')
        self.assertEqual(sidecar.stat().st_uid, 12345)
        self.assertEqual(database.stat().st_uid, 12345)


if __name__ == '__main__': unittest.main()
