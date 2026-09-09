"""Bootstrap path protection and admission checks; no live service mutation."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock

SPEC = importlib.util.spec_from_file_location('bootstrap_git', Path(__file__).resolve().parents[1] / 'deploy' / 'bootstrap-git.py')
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)


@unittest.skipUnless(hasattr(os, 'geteuid') and os.geteuid() == 0, 'Root-owned disposable Linux filesystem fixture')
class FileSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='praxis-bootstrap-test-')
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_install_is_idempotent_and_never_overwrites_different_privileged_file(self):
        target = self.root / 'helper'
        bootstrap.install_same(b'reviewed helper\n', target, 0o755)
        before = target.stat()
        bootstrap.install_same(b'reviewed helper\n', target, 0o755)
        self.assertEqual(before.st_ino, target.stat().st_ino)
        with self.assertRaises(bootstrap.Refused):
            bootstrap.install_same(b'unreviewed replacement\n', target, 0o755)
        self.assertEqual(target.read_bytes(), b'reviewed helper\n')

    def test_existing_directory_data_and_mode_are_preserved(self):
        state = self.root / 'state'
        bootstrap.directory(state, 0, 0, 0o700)
        (state / 'credential').write_text('fixture secret')
        bootstrap.directory(state, 0, 0, 0o700)
        self.assertEqual((state / 'credential').read_text(), 'fixture secret')
        with self.assertRaises(bootstrap.Refused):
            bootstrap.directory(state, 0, 0, 0o750)
        self.assertEqual(state.stat().st_mode & 0o7777, 0o700)

    def test_symlink_install_target_cannot_overwrite_other_file(self):
        protected = self.root / 'private'
        protected.write_text('fixture secret')
        target = self.root / 'helper'
        target.symlink_to(protected)
        with self.assertRaises(bootstrap.Refused):
            bootstrap.install_same(b'new helper', target)
        self.assertEqual(protected.read_text(), 'fixture secret')

    def test_symlink_parent_and_writable_control_path_are_rejected(self):
        actual = self.root / 'actual'
        actual.mkdir(mode=0o700)
        link = self.root / 'linked'
        link.symlink_to(actual, target_is_directory=True)
        with self.assertRaises(bootstrap.Refused):
            bootstrap.install_same(b'helper', link / 'helper')
        actual.chmod(0o777)
        with self.assertRaises(bootstrap.Refused):
            bootstrap.install_same(b'helper', actual / 'helper')

    def test_exchange_directory_retains_setgid_mode(self):
        target = self.root / 'outbox'
        bootstrap.directory(target, 0, 0, 0o2750)
        self.assertEqual(target.stat().st_mode & 0o7777, 0o2750)
        bootstrap.directory(target, 0, 0, 0o2750)


class AdmissionTests(unittest.TestCase):
    def query(self, counts, active=False, port=False):
        sock = Mock()
        sock.connect_ex.return_value = 0 if port else 111
        context = Mock()
        context.__enter__ = Mock(return_value=sock)
        context.__exit__ = Mock(return_value=False)
        return patch.multiple(bootstrap, run=Mock(return_value=json.dumps(counts).encode())), \
            patch.object(bootstrap.subprocess, 'run', return_value=Mock(returncode=0 if active else 3)), \
            patch.object(bootstrap.socket, 'socket', return_value=context)

    def test_active_broker_or_occupied_port_blocks_preparation(self):
        for active, port in [(True, False), (False, True)]:
            a, b, c = self.query({'activeJobs': 0, 'preparedOperations': 0}, active, port)
            with a, b, c, self.assertRaises(bootstrap.Refused):
                bootstrap.assert_idle()

    def test_active_jobs_or_prepared_mutation_block_preparation(self):
        for counts in [{'activeJobs': 1, 'preparedOperations': 0}, {'activeJobs': 0, 'preparedOperations': 1}]:
            a, b, c = self.query(counts)
            with a, b, c, self.assertRaises(bootstrap.Refused):
                bootstrap.assert_idle()

    def test_idle_query_uses_readonly_sqlite_as_coding_identity(self):
        a, b, c = self.query({'activeJobs': 0, 'preparedOperations': 0})
        with a, b, c:
            self.assertEqual(bootstrap.assert_idle()['activeJobs'], 0)
            argv = bootstrap.run.call_args.args[0]
            self.assertEqual(argv[:4], ['/usr/sbin/runuser', '-u', 'praxis-code', '--'])
            self.assertIn('mode=ro', argv[-1])
            self.assertNotIn('UPDATE ', argv[-1])


if __name__ == '__main__':
    unittest.main()
