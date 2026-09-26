"""Owner-only maintenance policy and isolated rollback fixtures; no live effects."""
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


maintenance = load('update_control_test', 'update-control.py')
bootstrap = load('update_control_bootstrap', 'bootstrap-autonomy.py')


class ChangePolicy(unittest.TestCase):
    def entry(self, text): return {'sha256': hashlib.sha256(text.encode()).hexdigest(), 'bytes': len(text), 'mode': '100644'}
    def test_only_fixed_helpers_documentation_tests_and_new_utility_can_change(self):
        before = {name: self.entry('old') for name in [*maintenance.HELPERS, 'src/server.js', 'package.json', 'node_modules/fixture.js']}
        after = {**before, 'deploy/deploy-project.py': self.entry('fixed'), maintenance.UTILITY: self.entry('owner only'),
                 maintenance.OWNER_CLIENT: self.entry('explicit operator retry fix'),
                 'test/test_update_control.py': self.entry('tests'), 'docs/maintenance.md': self.entry('docs')}
        protected = {name: value['sha256'] for name, value in before.items() if name.startswith(('src/', 'deploy/'))}
        self.assertIn(maintenance.UTILITY, maintenance.accepted_changes(before, after, protected))
        for forbidden in ['src/auth.js', 'package.json', 'node_modules/fixture.js', 'scripts/new-privileged.js', 'deploy/bootstrap-autonomy.py']:
            with self.subTest(path=forbidden), self.assertRaises(RuntimeError):
                maintenance.accepted_changes(before, {**after, forbidden: self.entry('unexpected')}, protected)
        with self.assertRaisesRegex(RuntimeError, 'Installed protected'):
            maintenance.accepted_changes(before, after, {**protected, 'src/server.js': '0' * 64})

    def test_broker_and_protected_utility_may_change_and_release_metadata_is_ignored(self):
        before = {name: self.entry('old') for name in [*maintenance.HELPERS, maintenance.UTILITY, 'src/git/broker.js',
                                                       'src/git/server.js', 'release.json']}
        protected = {name: value['sha256'] for name, value in before.items() if name != 'release.json'}
        after = {**before, 'src/git/broker.js': self.entry('project-aware broker'),
                 maintenance.UTILITY: self.entry('new utility'), 'release.json': self.entry('another release')}
        self.assertEqual(maintenance.accepted_changes(before, after, protected), sorted(['src/git/broker.js', maintenance.UTILITY]))
        with self.assertRaisesRegex(RuntimeError, 'outside the maintenance allowlist'):
            maintenance.accepted_changes(before, {**after, 'src/auth.js': self.entry('unexpected')}, {**protected, 'src/auth.js': None})
        with self.assertRaisesRegex(RuntimeError, 'No allowed helper or broker change'):
            maintenance.accepted_changes(before, {**before, 'release.json': self.entry('metadata only')}, protected)

    def test_acceptance_digest_excludes_release_metadata(self):
        tree = {'src/a.js': self.entry('a'), 'release.json': self.entry('meta')}
        self.assertEqual(maintenance.sealed_digest(tree), maintenance.sealed_digest({**tree, 'release.json': self.entry('other')}))
        self.assertNotEqual(maintenance.sealed_digest(tree), maintenance.sealed_digest({**tree, 'src/a.js': self.entry('b')}))

    def test_generated_tool_manifest_is_not_a_control_change_but_stays_in_the_digest(self):
        before = {name: self.entry('old') for name in [*maintenance.HELPERS, 'src/git/broker.js', 'coding-tools.json']}
        protected = {name: before[name]['sha256'] for name in maintenance.HELPERS}
        after = {**before, 'src/git/broker.js': self.entry('new'), 'coding-tools.json': self.entry('new tool list')}
        self.assertEqual(maintenance.accepted_changes(before, after, protected), ['src/git/broker.js'])
        self.assertNotEqual(maintenance.sealed_digest(before), maintenance.sealed_digest({**before, 'coding-tools.json': self.entry('x')}))


@unittest.skipUnless(os.name == 'posix' and getattr(os, 'getuid', lambda: -1)() == 0, 'Isolated owner-root Linux fixture')
class ActivationPolicy(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='praxis-control-maintenance-')
        self.addCleanup(self.temp.cleanup); self.root = Path(self.temp.name)
        self.control = self.root / 'control/current'; self.control.parent.mkdir()
        self.old = self.control.parent / 'releases' / ('a' * 12); self.old.mkdir(parents=True)
        for name, contents in {'deploy/deploy-discord.py': 'old discord', 'deploy/deploy-project.py': 'old project', 'src/server.js': 'export {};', 'src/claude-facade/server.js': 'export {};', 'src/git/server.js': 'export {};', 'deploy/praxis_updater_host.py': 'old host'}.items():
            path = self.old / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(contents)
        self.control.symlink_to(self.old)
        self.source = self.root / 'source'; shutil.copytree(self.old, self.source)
        (self.source / 'deploy/deploy-project.py').write_text('fixed project')
        (self.source / maintenance.UTILITY).write_text('owner utility')
        self.app = self.root / 'app/current'; self.app_release = self.app.parent / 'releases/app-existing'
        self.app_release.mkdir(parents=True); self.app.symlink_to(self.app_release)
        self.fence = self.root / 'activation.json'; self.fence.write_text('{"state":"active"}')
        self.gate = self.root / 'bootstrap-in-progress'; self.dropin = self.root / 'admission.conf'
        self.code = self.root / 'code.json'; self.code.write_text('{"release":"app-existing"}')
        self.git = self.root / 'git.json'; self.git.write_text('{"release":"control-old","retained":"fixture"}')
        self.env = self.root / 'control.env'; self.env.write_text('PRAXIS_RELEASE=control-old\n')
        self.updater_path = self.root / 'updater.json'
        self.helpers = {name: str(self.root / Path(destination).name) for name, destination in maintenance.HELPERS.items()}
        for name, destination in self.helpers.items(): Path(destination).write_text((self.old / name).read_text())
        code_db, git_db, state_dir = self.root / 'code.sqlite', self.root / 'git.sqlite', self.root / 'state'
        state_dir.mkdir()
        for filename, ddl in [(code_db, 'CREATE TABLE code_jobs(status TEXT); CREATE TABLE operations(status TEXT);'),
                              (git_db, 'CREATE TABLE git_operations(status TEXT);'),
                              (state_dir / 'releases.sqlite', 'CREATE TABLE releases(status TEXT, phase TEXT);')]:
            with sqlite3.connect(filename) as db: db.executescript(ddl)
        before = bootstrap.accepted_tree(self.old)
        self.updater = {'codingConfig': str(self.code), 'codingDatabase': str(code_db), 'gitDatabase': str(git_db),
                        'dataDirectory': str(state_dir), 'healthConfig': '/fixture/health.json', 'releasesRoot': str(self.app_release.parent),
                        'protectedFiles': {name: value['sha256'] for name, value in before.items()}}
        self.updater_path.write_text(json.dumps(self.updater)); self.updater_path.chmod(0o600)
        self.acceptance = {'sourceCommit': 'b' * 40, 'artifactSha256': hashlib.sha256(json.dumps(bootstrap.accepted_tree(self.source), sort_keys=True).encode()).hexdigest()}
        self.backup = self.root / 'backup'; self.backup.mkdir(mode=0o700)
        self.commands = []
        self.addCleanup(patch.stopall)
        patch.multiple(maintenance, CONTROL=self.control, APP=self.app, UPDATER_CONFIG=self.updater_path,
                       GIT_CONFIG=self.git, CONTROL_ENV=self.env, HELPERS=self.helpers).start()
        patch.multiple(bootstrap, FENCE=self.fence, ADMISSION_GATE=self.gate, ADMISSION_DROPIN=self.dropin).start()
        patch.object(bootstrap, 'confirm_startup', return_value=None).start()
        patch.object(bootstrap, 'confirm_authenticated_startup', return_value={'passed': True, 'release': 'app-existing'}).start()
        self.paths = [self.control, self.app, self.code, self.git, self.env, self.updater_path, self.fence, self.gate, self.dropin,
                      *map(Path, self.helpers.values())]

    def command(self, argv, **kwargs):
        self.commands.append(argv)
        if argv[0] == '/usr/bin/curl': return SimpleNamespace(stdout='{"ok":true}', returncode=0)
        if '-p' in argv: return SimpleNamespace(stdout='ActiveState=inactive\nMainPID=0\n', returncode=0)
        if '--property=ActiveState' in argv: return SimpleNamespace(stdout='active\n', returncode=0)
        if '--property=LoadState' in argv: return SimpleNamespace(stdout='loaded\n', returncode=0)
        if argv[:2] == ['systemctl', 'is-enabled']: return SimpleNamespace(stdout='enabled\n', returncode=0)
        return SimpleNamespace(stdout='', returncode=0)

    def activate(self, **extra):
        return maintenance.activate(bootstrap, self.source, self.acceptance, 'a' * 12, self.backup, self.updater,
                                    paths=self.paths, command=self.command, **extra)

    def test_success_preserves_application_and_databases_and_pins_helper_hashes(self):
        code_before, app_before = self.code.read_bytes(), os.readlink(self.app)
        databases = {path: path.read_bytes() for path in self.root.rglob('*.sqlite')}
        result = self.activate()
        self.assertEqual(result['phase'], 'completed')
        self.assertEqual(self.control.resolve().name, 'b' * 12)
        self.assertEqual(self.code.read_bytes(), code_before); self.assertEqual(os.readlink(self.app), app_before)
        self.assertEqual({path: path.read_bytes() for path in databases}, databases)
        self.assertEqual(Path(self.helpers['deploy/deploy-project.py']).read_text(), 'fixed project')
        self.assertIn(maintenance.UTILITY, json.loads(self.updater_path.read_text())['protectedFiles'])
        self.assertEqual(json.loads(self.fence.read_text())['state'], 'active'); self.assertFalse(self.gate.exists())

    def test_failed_health_restores_helper_config_link_services_without_database_restore(self):
        before = {path: path.read_bytes() for path in self.paths if path.is_file() and not path.is_symlink()}
        with patch.object(bootstrap, 'confirm_authenticated_startup', side_effect=RuntimeError('health failed')):
            with self.assertRaisesRegex(RuntimeError, 'health failed'): self.activate()
        self.assertEqual(self.control.resolve(), self.old)
        for path, contents in before.items(): self.assertEqual(path.read_bytes(), contents)
        self.assertTrue(json.loads((self.backup / 'rollback-result.json').read_text())['restored'])
        self.assertTrue((self.old.parent / ('b' * 12)).exists(), 'Accepted new tree remains available for diagnosis')

    def test_pending_updater_blocks_before_stopping_backends(self):
        with sqlite3.connect(Path(self.updater['dataDirectory']) / 'releases.sqlite') as db:
            db.execute("INSERT INTO releases VALUES('failed','restoration_failed')")
        with self.assertRaisesRegex(RuntimeError, 'Pending edits or updater'): self.activate()
        self.assertNotIn(['systemctl', 'stop', 'praxis-code.service', 'praxis-git.service'], self.commands)
        self.assertEqual(self.control.resolve(), self.old); self.assertFalse(self.gate.exists())

    def test_failure_after_admission_opens_never_rolls_back_over_new_work(self):
        install = bootstrap.install_json
        def after_open(path, data, *args, **kwargs):
            if Path(path) == self.backup / 'control-maintenance-receipt.json' and data.get('phase') == 'completed':
                raise RuntimeError('receipt filesystem failed after opening')
            return install(path, data, *args, **kwargs)
        with patch.object(bootstrap, 'install_json', side_effect=after_open):
            with self.assertRaisesRegex(RuntimeError, 'after opening'): self.activate()
        self.assertEqual(self.control.resolve().name, 'b' * 12)
        self.assertEqual(json.loads(self.fence.read_text())['state'], 'active')
        self.assertFalse((self.backup / 'rollback-result.json').exists())




class ImportClosure(unittest.TestCase):
    def test_real_closure_and_inert_app_changes(self):
        root = Path(__file__).parents[1]
        graph = maintenance._closure.control_closure(root)
        self.assertIn('src/arguments.js', graph)
        for name in ['src/code/schema.js', 'src/code/host-schema.js', 'src/code/client.js', 'src/code/git-client.js', 'src/code/git.js', 'src/code/projects.js']:
            self.assertNotIn(name, graph)
        entry = ChangePolicy().entry
        before = {name: entry('old') for name in [*maintenance.HELPERS, 'src/code/projects.js', 'src/auth.js']}
        after = {**before, 'src/code/projects.js': entry('new app'), 'deploy/deploy-discord.py': entry('new helper')}
        self.assertEqual(maintenance.accepted_changes(before, after, {}, root, root), ['deploy/deploy-discord.py'])
        with self.assertRaises(RuntimeError):
            maintenance.accepted_changes(before, {**after, 'src/auth.js': entry('new auth')}, {}, root, root)

    def test_union_rejects_removed_and_new_dependencies_and_dynamic_imports(self):
        with tempfile.TemporaryDirectory() as tmp:
            old, new = Path(tmp) / 'old', Path(tmp) / 'new'
            for root in (old, new):
                for name in maintenance._closure.ENTRY_POINTS:
                    path = root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('export {};')
                (root / 'src/dep.js').write_text('export const value = 1;')
            (old / 'src/server.js').write_text("import './dep.js';")
            (new / 'src/new.js').write_text('export {};')
            (new / 'src/server.js').write_text("import './new.js';")
            before, after = bootstrap.accepted_tree(old), bootstrap.accepted_tree(new)
            active = maintenance._closure.policy_paths(old, new, before, after, {})
            self.assertIn('src/dep.js', active); self.assertIn('src/new.js', active)
            (new / 'src/server.js').write_text('import(process.env.MODULE);')
            with self.assertRaisesRegex(RuntimeError, 'dynamic'):
                maintenance._closure.control_closure(new)


    def test_reachable_documentation_and_unchanged_new_imports_need_allowlisting(self):
        with tempfile.TemporaryDirectory() as tmp:
            old, new = Path(tmp) / 'old', Path(tmp) / 'new'
            for root in (old, new):
                for name in maintenance._closure.ENTRY_POINTS:
                    path = root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('export {};')
                (root / 'test').mkdir(); (root / 'test/live.js').write_text('export {};')
                for name in maintenance.HELPERS:
                    path = root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('helper')
            (new / 'src/server.js').write_text("import '../test/live.js';")
            with self.assertRaisesRegex(RuntimeError, 'test/live.js'):
                maintenance.accepted_changes(bootstrap.accepted_tree(old), bootstrap.accepted_tree(new), {}, old, new)

if __name__ == '__main__': unittest.main()
