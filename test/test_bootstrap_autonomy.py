"""Owner-bootstrap fixtures: private temporary files and mocked service commands."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest

SPEC = importlib.util.spec_from_file_location('bootstrap_autonomy', Path(__file__).resolve().parents[1] / 'deploy/bootstrap-autonomy.py')
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)


@unittest.skipUnless(os.name == 'posix' and getattr(os, 'getuid', lambda: -1)() == 0, 'Owner-root Linux fixture')
class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='praxis-bootstrap-autonomy-test-')
        self.root = Path(self.temp.name)
        self.backup = self.root / 'backup'
        self.backup.mkdir(mode=0o700)
        self.commands = []

    def tearDown(self):
        self.temp.cleanup()

    def command(self, args, **kwargs):
        self.commands.append(args)
        if '--property=ActiveState' in args:
            return SimpleNamespace(stdout='active\n' if args[2] in bootstrap.CORE_UNITS else 'inactive\n', returncode=0)
        if '--property=LoadState' in args:
            return SimpleNamespace(stdout='loaded\n', returncode=0)
        if args[:2] == ['systemctl', 'is-enabled']:
            return SimpleNamespace(stdout='enabled\n' if args[2] in bootstrap.CORE_UNITS else 'disabled\n', returncode=0)
        return SimpleNamespace(stdout='', returncode=0)

    def test_ingress_stops_before_idle_check_and_active_work_abort_restores_only_ingress(self):
        def active():
            self.commands.append(['idle-check'])
            raise RuntimeError('Existing work remains active')
        with self.assertRaisesRegex(RuntimeError, 'Existing work'):
            with bootstrap.BootstrapTransaction(self.backup, paths=[], command=self.command, gate_paths=(), idle=active) as transaction:
                transaction.quiesce()
        mutations = [command for command in self.commands if command[:2] in (['systemctl', 'stop'], ['systemctl', 'start']) or command == ['idle-check']]
        self.assertEqual(mutations, [['systemctl', 'stop', 'praxis-probe.service'], ['idle-check'],
                                    ['systemctl', 'start', 'praxis-probe.service']])

    def test_final_idle_check_follows_backend_stop(self):
        def idle(): self.commands.append(['idle-check'])
        with bootstrap.BootstrapTransaction(self.backup, paths=[], command=self.command, gate_paths=(), idle=idle) as transaction:
            transaction.quiesce()
            transaction.committed = True
        filtered = [row for row in self.commands if row == ['idle-check'] or row[:2] == ['systemctl', 'stop']]
        self.assertEqual(filtered, [['systemctl', 'stop', 'praxis-probe.service'], ['idle-check'],
                                    ['systemctl', 'stop', 'praxis-code.service', 'praxis-git.service'], ['idle-check']])

    def test_power_loss_ingress_guard_is_durable_and_idle_abort_removes_only_guard(self):
        gate, dropin = self.root / 'control/bootstrap-in-progress', self.root / 'units/bootstrap-admission.conf'
        def active():
            self.assertTrue(gate.exists())
            self.assertIn('ConditionPathExists=!' + str(gate), dropin.read_text())
            raise RuntimeError('active work')
        with self.assertRaisesRegex(RuntimeError, 'active work'):
            with bootstrap.BootstrapTransaction(self.backup, paths=[gate, dropin], command=self.command,
                                                idle=active, gate_paths=(gate, dropin)) as transaction:
                transaction.quiesce()
        self.assertFalse(gate.exists())
        self.assertFalse(dropin.exists())
        self.assertNotIn(['systemctl', 'stop', 'praxis-code.service', 'praxis-git.service'], self.commands)

    def test_authenticated_startup_uses_read_only_identity_with_bounded_retry(self):
        calls = []
        def command(args, **kwargs):
            calls.append((args, kwargs))
            return SimpleNamespace(stdout='{"ok":true}', returncode=1 if len(calls) == 1 else 0)
        result = bootstrap.confirm_authenticated_startup('/private/health.json', 'app-bootstrap-fixture', command=command)
        self.assertTrue(result['passed'])
        self.assertEqual(result['attempt'], 2)
        self.assertEqual(calls[0][0][:5], ['runuser', '-u', 'praxis-health', '--', '/usr/bin/node'])
        self.assertEqual(calls[0][1]['timeout'], 20)

    def test_failed_activation_restores_original_config_and_removes_only_new_targets(self):
        config = self.root / 'config.json'
        config.write_text('{"original":true}\n')
        config.chmod(0o640)
        new_dropin = self.root / 'new-dropin.conf'
        link = self.root / 'current'
        with self.assertRaisesRegex(RuntimeError, 'startup failed'):
            with bootstrap.BootstrapTransaction(self.backup, paths=[config, new_dropin, link], command=self.command, gate_paths=(), idle=lambda: None) as transaction:
                transaction.quiesce()
                transaction.changed = True
                bootstrap.install_text(config, '{"new":true}')
                bootstrap.install_text(new_dropin, '[Service]\n')
                link.symlink_to(self.root / 'preserved-new-release')
                raise RuntimeError('startup failed')
        self.assertEqual(config.read_text(), '{"original":true}\n')
        self.assertEqual(config.stat().st_mode & 0o777, 0o640)
        self.assertFalse(new_dropin.exists())
        self.assertFalse(link.is_symlink())
        self.assertTrue(json.loads((self.backup / 'rollback-result.json').read_text())['restored'])
        self.assertIn(['systemctl', 'start', 'praxis-code.service'], self.commands)
        self.assertEqual(self.commands[-1], ['systemctl', 'start', 'praxis-probe.service'])

    def test_committed_activation_does_not_rollback_after_admission_opens(self):
        config = self.root / 'config.json'
        config.write_text('old')
        with self.assertRaisesRegex(RuntimeError, 'stdout disconnected'):
            with bootstrap.BootstrapTransaction(self.backup, paths=[config], command=self.command, gate_paths=(), idle=lambda: None) as transaction:
                transaction.quiesce()
                transaction.changed = True
                bootstrap.install_text(config, 'new')
                transaction.committed = True
                raise RuntimeError('stdout disconnected')
        self.assertEqual(config.read_text(), 'new')
        self.assertFalse((self.backup / 'rollback-result.json').exists())

    def test_candidate_helper_is_not_imported_until_complete_artifact_matches(self):
        source = self.root / 'source'
        (source / 'deploy').mkdir(parents=True)
        marker = self.root / 'imported'
        (source / 'deploy/praxis_updater_host.py').write_text('from pathlib import Path\nPath(' + repr(str(marker)) + ').write_text("executed")\n')
        with self.assertRaisesRegex(RuntimeError, 'differs from the accepted tree'):
            bootstrap.load_accepted_helper(source, {'artifactSha256': '0' * 64})
        self.assertFalse(marker.exists())
        digest = hashlib.sha256(json.dumps(bootstrap.accepted_tree(source), sort_keys=True).encode()).hexdigest()
        bootstrap.load_accepted_helper(source, {'artifactSha256': digest})
        self.assertTrue(marker.exists())
        self.assertFalse((source / 'deploy/__pycache__').exists())

    def test_installed_release_normalizes_private_modes_and_preserves_dependency_links(self):
        source = self.root / 'source'
        (source / 'node_modules/.bin').mkdir(parents=True)
        (source / 'node_modules/package').mkdir()
        (source / 'node_modules/package/cli.js').write_text('export default true;')
        (source / 'node_modules/package/cli.js').chmod(0o700)
        (source / 'node_modules/.bin/package').symlink_to('../package/cli.js')
        (source / 'server.js').write_text('// fixture')
        (source / 'server.js').chmod(0o600)
        source.chmod(0o700)
        target = self.root / 'installed'
        previous = os.umask(0o077)
        try: bootstrap.copy_release(source, target)
        finally: os.umask(previous)
        self.assertEqual(target.stat().st_mode & 0o777, 0o755)
        self.assertEqual((target / 'server.js').stat().st_mode & 0o777, 0o644)
        self.assertEqual((target / 'node_modules/.bin').stat().st_mode & 0o777, 0o755)
        self.assertEqual((target / 'node_modules/package/cli.js').stat().st_mode & 0o777, 0o755)
        self.assertTrue((target / 'node_modules/.bin/package').is_symlink())

    def test_idle_queries_do_not_change_existing_database_state(self):
        coding, git = self.root / 'coding.sqlite', self.root / 'git.sqlite'
        with sqlite3.connect(coding) as db:
            db.execute('CREATE TABLE code_jobs(status TEXT)')
            db.execute("INSERT INTO code_jobs VALUES('completed')")
        with sqlite3.connect(git) as db:
            db.execute('CREATE TABLE git_operations(status TEXT)')
            db.execute("INSERT INTO git_operations VALUES('completed')")
        before = (coding.read_bytes(), git.read_bytes())
        bootstrap.ensure_idle(coding, git)
        self.assertEqual((coding.read_bytes(), git.read_bytes()), before)

    def test_generation_fence_is_persistent_and_rollback_preserves_draining_state(self):
        self.assertEqual(str(bootstrap.FENCE), '/var/lib/praxis-control/activation.json')
        fence = self.root / 'activation.json'
        fence.write_text('{"state":"draining","operationId":"prior"}')
        with self.assertRaises(RuntimeError):
            with bootstrap.BootstrapTransaction(self.backup, paths=[fence], command=self.command, gate_paths=(), idle=lambda: None) as transaction:
                transaction.quiesce()
                transaction.changed = True
                bootstrap.install_json(fence, {'state': 'active'}, 0o644)
                raise RuntimeError('failed bootstrap')
        self.assertEqual(json.loads(fence.read_text()), {'state': 'draining', 'operationId': 'prior'})


if __name__ == '__main__': unittest.main()
