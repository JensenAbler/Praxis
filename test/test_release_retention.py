"""Release retention: keep the active release plus one rollback target."""
import importlib.util
import json
import os
import pathlib
import tempfile
import unittest
import uuid

DEPLOY = pathlib.Path(__file__).parents[1] / 'deploy'


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, DEPLOY / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


updater = load('praxis_updater_retention', 'praxis-updater.py')
control = load('activate_control_retention', 'activate-control.py')
host_module = load('praxis_updater_host_retention', 'praxis_updater_host.py') if os.name == 'posix' else None


@unittest.skipUnless(os.name == 'posix', 'Host retention uses POSIX paths.')
class HostRetention(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='praxis-retention-')
        self.addCleanup(temp.cleanup)
        base = pathlib.Path(temp.name)
        self.host = object.__new__(host_module.Host)
        self.host.root, self.host.stages, self.host.state = base / 'releases', base / 'stages', base / 'state'
        for path in (self.host.root, self.host.stages, self.host.state): path.mkdir()
        self.active = 'app-cccccccccccc-00000003'
        self.host.active = lambda: {'release': self.active}

    def release(self, name):
        (self.host.root / name).mkdir()
        (self.host.root / name / 'release.json').write_text('{}')

    def stage(self, operation, prepared):
        (self.host.stages / operation).mkdir()
        (self.host.stages / (operation + '-smoke')).mkdir()
        if prepared: (self.host.state / (operation + '-prepared.json')).write_text('{}')

    def test_keeps_active_and_previous_and_drops_finished_stages(self):
        for name in ('app-aaaaaaaaaaaa-00000001', 'app-bbbbbbbbbbbb-00000002', self.active): self.release(name)
        (self.host.root / 'notes').mkdir()
        done, broken = str(uuid.uuid4()), str(uuid.uuid4())
        self.stage(done, True); self.stage(broken, False)
        result = self.host.prune(self.active, 'app-bbbbbbbbbbbb-00000002')
        self.assertEqual(result['kept'], ['app-bbbbbbbbbbbb-00000002', self.active])
        self.assertEqual(result['removedReleases'], ['app-aaaaaaaaaaaa-00000001'])
        self.assertEqual(sorted(result['removedStages']), sorted([done, done + '-smoke']))
        self.assertTrue((self.host.root / 'notes').is_dir())
        self.assertTrue((self.host.stages / broken).is_dir() and (self.host.stages / (broken + '-smoke')).is_dir())

    def test_missing_previous_keeps_only_active(self):
        for name in ('app-aaaaaaaaaaaa-00000001', self.active): self.release(name)
        result = self.host.prune(self.active, 'app-gone00000000-00000000')
        self.assertEqual(result['kept'], [self.active])
        self.assertEqual(result['removedReleases'], ['app-aaaaaaaaaaaa-00000001'])

    def test_refuses_when_active_release_differs(self):
        for name in ('app-aaaaaaaaaaaa-00000001', self.active): self.release(name)
        with self.assertRaises(Exception):
            self.host.prune('app-aaaaaaaaaaaa-00000001', self.active)
        self.assertTrue((self.host.root / 'app-aaaaaaaaaaaa-00000001').is_dir())


class FakeHost:
    def __init__(self, prune_error=None):
        self.release, self.fenced, self.pruned, self.prune_error = 'old', False, [], prune_error
    def active(self): return {'release': self.release}
    def release_source(self, target): return 'a' * 40
    def prepare(self, operation, args): return {'release': 'candidate', 'testEvidence': {}}
    def reserve(self, operation): self.fenced = True; return True
    def reservation_held(self, operation): return self.fenced
    def switch(self, target, operation): self.release = target
    def restore(self, target, operation): self.release = target
    def health(self, target): return {'ok': self.release == target and target != 'broken'}
    def open(self, operation): self.fenced = False
    def release_reservation(self, operation): self.fenced = False
    def prune(self, active, previous):
        self.pruned.append((active, previous))
        if self.prune_error: raise RuntimeError(self.prune_error)
        return {'kept': [active, previous]}


class UpdaterRetention(unittest.TestCase):
    def run_apply(self, host):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        engine = updater.Updater(temp.name, host, clock=lambda: 1000)
        self.addCleanup(engine.close)
        base = lambda action, **extra: {'action': action, 'owner': 'jensen', 'operationId': str(uuid.uuid4()),
                                        'idempotencyKey': str(uuid.uuid4()), 'expectedRelease': host.release, **extra}
        plan = engine.call(base('plan', exportId=str(uuid.uuid4()), sourceCommit='a' * 40, sourceDigest='b' * 64))
        engine.tick()
        plan = engine.receipt(engine.row(plan['operationId']))
        request = base('apply', planId=plan['operationId'], planDigest=plan['result']['planDigest'])
        engine.call(request)
        engine.tick()
        return engine.receipt(engine.row(request['operationId']))

    def test_confirmed_activation_prunes_with_rollback_target(self):
        host = FakeHost()
        receipt = self.run_apply(host)
        self.assertEqual(receipt['status'], 'completed')
        self.assertEqual(host.pruned, [('candidate', 'old')])
        self.assertEqual(receipt['result']['retention'], {'kept': ['candidate', 'old']})

    def test_retention_failure_never_fails_activation(self):
        host = FakeHost(prune_error='disk busy')
        receipt = self.run_apply(host)
        self.assertEqual(receipt['status'], 'completed')
        self.assertEqual(host.release, 'candidate')
        self.assertIn('disk busy', receipt['result']['retention']['error'])


class ControlRetention(unittest.TestCase):
    def test_keeps_live_and_previous_control_releases(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        base = pathlib.Path(temp.name)
        releases = base / 'releases'
        for name in ('111111111111', '222222222222', '333333333333', '.444444444444.staging'): (releases / name).mkdir(parents=True)
        current = base / 'current'
        current.symlink_to(releases / '333333333333')
        paths = control.Paths(control_releases=releases, control_current=current)
        result = control.prune_control(paths, [releases / '333333333333', releases / '222222222222'])
        self.assertEqual(result['removed'], ['111111111111'])
        self.assertEqual(result['kept'], ['222222222222', '333333333333'])
        self.assertTrue((releases / '.444444444444.staging').is_dir())


if __name__ == '__main__':
    unittest.main()
