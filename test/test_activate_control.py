import importlib.util
import json
import os
import pathlib
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('activate_control', pathlib.Path(__file__).parents[1] / 'deploy' / 'activate-control.py')
activate_control = importlib.util.module_from_spec(spec); spec.loader.exec_module(activate_control)


class ActivateControlTest(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp())
        r = self.root
        p = activate_control.Paths(app_releases=r / 'app/releases', app_current=r / 'app/current', control_releases=r / 'control/releases',
                                   control_current=r / 'control/current', control_env=r / 'control.env', git_config=r / 'git.json',
                                   updater_config=r / 'updater.json', journal=r / 'journal.jsonl')
        self.paths = p
        for directory in [p.app_releases / 'app-a838ea7c65f2-f61f433a/src', p.control_releases / 'ad80644e8869/src']: directory.mkdir(parents=True)
        (p.app_releases / 'app-a838ea7c65f2-f61f433a/src/mcp.js').write_text('new')
        (p.app_releases / 'app-oldoldoldold-00000000').mkdir()
        p.app_current.symlink_to(p.app_releases / 'app-a838ea7c65f2-f61f433a')
        p.control_current.symlink_to(p.control_releases / 'ad80644e8869')
        p.control_env.write_text('PRAXIS_RELEASE=control-ad80644e8869\nOTHER=kept\n')
        p.git_config.write_text(json.dumps({'release': 'control-ad80644e8869', 'keep': 1}))
        self.restarts = []
        self.kw = dict(paths=p, run=lambda argv: self.restarts.append(argv[-1]), idle=lambda paths: None, sleep=lambda s: None, settle_seconds=0)
        for name in ['lchown', 'chown']:  # tests are not root
            patcher = mock.patch.object(activate_control.os, name, lambda *a: None); patcher.start(); self.addCleanup(patcher.stop)

    def test_promotes_live_release_and_relabels(self):
        record = activate_control.activate('app-a838ea7c65f2-f61f433a', health=lambda label: {'label': label}, **self.kw)
        p = self.paths
        self.assertEqual(record['outcome'], 'activated')
        self.assertEqual(p.control_current.resolve(), (p.control_releases / 'a838ea7c65f2').resolve())
        self.assertEqual((p.control_current / 'src/mcp.js').read_text(), 'new')
        self.assertIn('PRAXIS_RELEASE=control-a838ea7c65f2', p.control_env.read_text())
        self.assertIn('OTHER=kept', p.control_env.read_text())
        self.assertEqual(json.loads(p.git_config.read_text()), {'release': 'control-a838ea7c65f2', 'keep': 1})
        self.assertEqual(self.restarts, ['praxis-git.service', 'praxis-probe.service', 'praxis-claude-facade.service'])

    def test_failed_health_restores_previous_release_label_and_services(self):
        def health(label):
            if label == 'control-a838ea7c65f2': raise RuntimeError('facade down')
            return {'label': label}
        with self.assertRaises(RuntimeError): activate_control.activate('app-a838ea7c65f2-f61f433a', health=health, **self.kw)
        p = self.paths
        self.assertEqual(p.control_current.resolve(), (p.control_releases / 'ad80644e8869').resolve())
        self.assertEqual(p.control_env.read_text(), 'PRAXIS_RELEASE=control-ad80644e8869\nOTHER=kept\n')
        self.assertEqual(json.loads(p.git_config.read_text())['release'], 'control-ad80644e8869')
        self.assertEqual(len(self.restarts), 6)
        entry = json.loads(p.journal.read_text().splitlines()[-1])
        self.assertEqual((entry['outcome'], entry['restoredHealth']), ('restored', {'label': 'control-ad80644e8869'}))

    def test_refuses_a_release_that_is_not_live(self):
        with self.assertRaisesRegex(RuntimeError, 'Only the live'): activate_control.activate('app-oldoldoldold-00000000', health=lambda l: {}, **self.kw)
        self.assertEqual(self.restarts, [])


if __name__ == '__main__':
    unittest.main()
