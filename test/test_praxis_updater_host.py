"""Linux host-policy fixtures; no service, mount, account, or live path is changed."""
import contextlib
import importlib.util
import hashlib
import json
import os
import pathlib
import sqlite3
import stat
import tempfile
import types
import unittest
import uuid
from unittest.mock import patch

module = None
if os.name == 'posix':
    spec = importlib.util.spec_from_file_location('praxis_updater_host_test', pathlib.Path(__file__).parents[1] / 'deploy' / 'praxis_updater_host.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)


@unittest.skipUnless(os.name == 'posix', 'Production host policy requires Linux; Windows runs the updater state-machine fixtures.')
class HostPolicy(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='praxis-updater-host-')
        self.addCleanup(self.temp.cleanup)
        self.base = pathlib.Path(self.temp.name)
        self.host = object.__new__(module.Host)
        self.host.staging_mount = self.base / 'volume'
        self.host.staging_mount.mkdir()
        self.host.stages = self.host.staging_mount / 'stages'
        self.host.stages.mkdir()
        self.host.root = self.base / 'releases'
        self.host.root.mkdir()
        self.host.state = self.base / 'state'
        self.host.state.mkdir()
        self.host.fence = self.base / 'activation.json'
        self.host.stage_user = 'fixture-stage'
        self.commands = []
        self.unit_state = 'LoadState=not-found\n'
        def run(argv, **kwargs):
            self.commands.append(argv)
            output = self.unit_state if argv[:2] == ['systemctl', 'show'] else ''
            return types.SimpleNamespace(returncode=0, stdout=output, stderr='')
        self.host.run = run

    @contextlib.contextmanager
    def capacity(self, free_gib=4, total_gib=8, same_device=False):
        old_stat = pathlib.Path.stat
        old_lstat = pathlib.Path.lstat
        root_device = pathlib.Path('/').stat().st_dev
        protected = {self.host.staging_mount, self.host.stages, self.host.root}
        def altered(path, original, *args, **kwargs):
            result = original(path, *args, **kwargs)
            if path in protected:
                fields = list(result)
                fields[stat.ST_UID] = 0
                fields[stat.ST_MODE] = stat.S_IFDIR | 0o755
                if path == self.host.staging_mount:
                    fields[stat.ST_DEV] = root_device if same_device else root_device + 1
                return os.stat_result(fields)
            return result
        with patch.object(pathlib.Path, 'stat', lambda path, *args, **kwargs: altered(path, old_stat, *args, **kwargs)), \
             patch.object(pathlib.Path, 'lstat', lambda path, *args, **kwargs: altered(path, old_lstat, *args, **kwargs)), \
             patch.object(module.os.path, 'ismount', return_value=True), \
             patch.object(module.os, 'statvfs', return_value=types.SimpleNamespace(f_blocks=total_gib * 1024 * 1024 // 4, f_bavail=free_gib * 1024 * 1024 // 4, f_frsize=4096)):
            yield

    def test_dedicated_mount_free_space_and_retention_are_admission_requirements(self):
        with self.capacity():
            self.host.stage_capacity()
        for args in ({'same_device': True}, {'total_gib': 9}, {'free_gib': 1}):
            with self.capacity(**args), self.assertRaises(RuntimeError):
                self.host.stage_capacity()
        for index in range(4):
            (self.host.root / f'app-{index}').mkdir()
        with self.capacity(), self.assertRaisesRegex(RuntimeError, 'retention'):
            self.host.stage_capacity()

    def test_previous_active_stage_blocks_new_preparation(self):
        original_run = self.host.run
        def run(argv, **kwargs):
            if argv[:2] == ['systemctl', 'list-units']:
                return types.SimpleNamespace(returncode=0, stdout='praxis-stage-existing.service loaded active running\n', stderr='')
            return original_run(argv, **kwargs)
        self.host.run = run
        with self.capacity(), self.assertRaisesRegex(RuntimeError, 'previous candidate unit'):
            self.host.stage_capacity()

    def test_shutdown_requires_observed_absence_or_inactivity(self):
        self.host.stop_stage('praxis-stage-fixture-build')
        self.unit_state = 'LoadState=loaded\nActiveState=inactive\nMainPID=0\nControlGroup=\n'
        self.host.stop_stage('praxis-stage-fixture-build')
        self.unit_state = 'LoadState=loaded\nActiveState=active\nMainPID=1234\n'
        with self.assertRaisesRegex(RuntimeError, 'shutdown is unconfirmed'):
            self.host.stop_stage('praxis-stage-fixture-build')
        self.unit_state = ''
        with self.assertRaisesRegex(RuntimeError, 'shutdown is unconfirmed'):
            self.host.stop_stage('praxis-stage-fixture-build')

    def test_source_scanner_refuses_hardlinks_and_escaping_dependency_links(self):
        tree = self.base / 'tree'
        tree.mkdir()
        (tree / 'source.js').write_text('fixture')
        (tree / 'node_modules').mkdir()
        (tree / 'node_modules' / 'module.js').write_text('fixture module')
        link = tree / 'node_modules' / 'link.js'
        link.symlink_to('module.js')
        self.assertIn('node_modules/link.js', module.safe_tree(tree, allow_dependency_links=True))
        link.unlink()
        link.symlink_to('../source.js')
        with self.assertRaisesRegex(RuntimeError, 'escapes'):
            module.safe_tree(tree, allow_dependency_links=True)
        link.unlink()
        os.link(tree / 'source.js', tree / 'copy.js')
        with self.assertRaisesRegex(RuntimeError, 'hard-linked'):
            module.safe_tree(tree)

    def test_artifact_tampering_refuses_switch_before_any_service_effect(self):
        release = self.host.root / 'app-candidate'
        release.mkdir()
        source = release / 'server.js'
        source.write_text('original fixture')
        sealed = module.safe_tree(release, allow_dependency_links=True)
        metadata = {'artifactSha256': hashlib.sha256(json.dumps(sealed, sort_keys=True).encode()).hexdigest()}
        (release / 'release.json').write_text(json.dumps(metadata))
        source.write_text('tampered fixture')
        with self.assertRaisesRegex(RuntimeError, 'artifact changed'):
            self.host.switch('app-candidate', 'fixture')
        self.assertEqual(self.commands, [])

    def test_drain_holds_both_admission_leases_through_service_stop(self):
        code, broker = self.base / 'code.sqlite', self.base / 'broker.sqlite'
        for path, ddl in ((code, 'CREATE TABLE code_jobs(status TEXT); CREATE TABLE operations(status TEXT);'),
                          (broker, 'CREATE TABLE git_operations(status TEXT);')):
            with sqlite3.connect(path) as db: db.executescript(ddl)
        self.host.config = {'codingDatabase': str(code), 'gitDatabase': str(broker)}
        self.host.active = lambda: {'release': 'old', 'service': {'ActiveState': 'inactive'}}
        operation = str(uuid.uuid4())
        original_run = self.host.run
        def run(argv, **kwargs):
            if argv[:2] == ['systemctl', 'stop']:
                self.assertTrue(self.host.reservation_held(operation))
                for filename in (code, broker):
                    with contextlib.closing(sqlite3.connect(filename, timeout=0, isolation_level=None)) as other:
                        with self.assertRaisesRegex(sqlite3.OperationalError, 'locked'):
                            other.execute('BEGIN IMMEDIATE')
            return original_run(argv, **kwargs)
        self.host.run = run
        self.assertTrue(self.host.reserve(operation))
        for filename in (code, broker):
            with contextlib.closing(sqlite3.connect(filename, timeout=0, isolation_level=None)) as other:
                other.execute('BEGIN IMMEDIATE')
                other.rollback()
        self.assertFalse(self.host.reservation_held(str(uuid.uuid4())))
        self.host.open(operation)
        self.assertFalse(self.host.reservation_held(operation))

    @unittest.skipUnless(hasattr(os, 'geteuid') and os.geteuid() == 0, 'Protected evidence fixtures run as root only in isolated Linux qualification.')
    def test_diagnostics_are_bounded_fixed_phase_excerpts_and_reject_linked_files(self):
        operation = str(uuid.uuid4())
        build = self.host.state / (operation + '-build.json')
        readiness = self.host.state / (operation + '-readiness.json')
        module.atomic_json(build, {'exitCode': 1, 'tail': '\u2603\x00' * 9000 + 'build error'})
        module.atomic_json(readiness, {'exitCode': 2, 'tail': '\n' * 20000 + 'readiness error'})
        result = self.host.diagnostics(operation)
        self.assertEqual([item['phase'] for item in result], ['build', 'readiness'])
        self.assertEqual([item['exitCode'] for item in result], [1, 2])
        self.assertTrue(all(item['truncated'] for item in result))
        self.assertTrue(result[0]['tail'].endswith('build error'))
        self.assertLessEqual(len(json.dumps(result).encode()), 10000)
        build.unlink()
        build.symlink_to(readiness)
        self.assertIn('unavailable', self.host.diagnostics(operation)[0])
        build.unlink()
        os.link(readiness, build)
        self.assertTrue(all('unavailable' in item for item in self.host.diagnostics(operation)))
        self.assertEqual(self.host.diagnostics(str(uuid.uuid4())), [])
        with self.assertRaises(RuntimeError): self.host.diagnostics('../../etc/passwd')

    @unittest.skipUnless(hasattr(os, 'geteuid') and os.geteuid() == 0, 'Root-owned log fixture is exercised in Linux host qualification.')
    def test_lost_stage_run_response_still_checks_cleanup_before_returning(self):
        original_run = self.host.run
        def run(argv, **kwargs):
            if argv[0] == 'systemd-run':
                self.commands.append(argv)
                raise TimeoutError('Fixture lost systemd-run response')
            return original_run(argv, **kwargs)
        self.host.run = run
        source = self.host.stages / 'fixture'
        source.mkdir()
        operation = str(uuid.uuid4())
        with self.assertRaises(TimeoutError):
            self.host.stage_unit(operation, 'build', source, ['node', 'fixture.js'])
        self.assertTrue(any(command[:2] == ['systemctl', 'stop'] for command in self.commands))
        self.assertTrue(any(command[:2] == ['systemctl', 'show'] for command in self.commands))
        args = self.commands[0]
        self.assertIn('--property=PrivateNetwork=yes', args)
        self.assertTrue(any('TemporaryFileSystem=/tmp:size=' in argument for argument in args))
        self.assertTrue(any('StandardOutput=append:' + str(self.host.staging_mount / 'logs') in argument for argument in args))
        diagnostic = self.host.diagnostics(operation)[0]
        self.assertIsNone(diagnostic['exitCode'])
        self.assertIn('controlError', diagnostic)


if __name__ == '__main__':
    unittest.main()
