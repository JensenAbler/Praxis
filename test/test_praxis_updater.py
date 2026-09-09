import importlib.util
import pathlib
import tempfile
import unittest
import uuid

spec = importlib.util.spec_from_file_location('praxis_updater', pathlib.Path(__file__).parents[1] / 'deploy' / 'praxis-updater.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Host:
    def __init__(self):
        self.release = 'old'
        self.healthy = {'old': True, 'candidate': True}
        self.busy = False
        self.switches = []
        self.builds = 0
        self.fenced = False

    def active(self): return {'release': self.release}
    def release_source(self, target): return 'a' * 40
    def prepare(self, operation, args):
        self.builds += 1
        return {'release': 'candidate', 'testEvidence': {'npmTestPassed': True, 'authenticatedMcpPassed': True}}
    def recover_preparation(self, operation, args):
        raise module.UpdateError('PREPARATION_INTERRUPTED', 'Inspect the existing build; it was not restarted.')
    def reserve(self, operation):
        if self.busy: return False
        self.fenced = True
        return True
    def reservation_held(self, operation): return self.fenced
    def switch(self, target, operation):
        self.switches.append(target)
        self.release = target
    def restore(self, target, operation): self.switch(target, operation)
    def health(self, target): return {'ok': self.release == target and self.healthy[target]}
    def open(self, operation): self.fenced = False
    def release_reservation(self, operation): self.fenced = False


class UpdaterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.host = Host()
        self.updater = module.Updater(self.temp.name, self.host, clock=lambda: 1000)
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self.updater.close)

    def request(self, action, **extra):
        return {'action': action, 'owner': 'jensen', 'operationId': str(uuid.uuid4()), 'idempotencyKey': str(uuid.uuid4()),
                'expectedRelease': self.host.release, **extra}

    def plan(self):
        args = self.request('plan', exportId=str(uuid.uuid4()), sourceCommit='a' * 40, sourceDigest='b' * 64)
        receipt = self.updater.call(args)
        self.assertEqual(receipt['status'], 'queued')
        self.updater.tick()
        return self.updater.receipt(self.updater.row(receipt['operationId']))

    def apply(self, plan):
        return self.request('apply', planId=plan['operationId'], planDigest=plan['result']['planDigest'])

    def test_complete_plan_and_activate_independent_of_request(self):
        plan = self.plan()
        self.assertEqual(plan['status'], 'ready')
        self.assertEqual(self.host.release, 'old')
        request = self.apply(plan)
        self.updater.call(request)
        self.assertEqual(self.host.switches, [])
        self.updater.tick()
        receipt = self.updater.receipt(self.updater.row(request['operationId']))
        self.assertEqual(receipt['status'], 'completed')
        self.assertEqual(self.host.release, 'candidate')
        self.assertFalse(self.host.fenced)

    def test_duplicate_survives_current_release_change_without_second_restart(self):
        plan = self.plan()
        request = self.apply(plan)
        self.updater.call(request)
        self.updater.tick()
        self.assertEqual(self.updater.call(request)['status'], 'completed')
        self.assertEqual(self.host.switches, ['candidate'])
        with self.assertRaisesRegex(module.UpdateError, 'different inputs'):
            self.updater.call({**request, 'expectedRelease': 'candidate'})

    def test_active_jobs_defer_activation(self):
        request = self.apply(self.plan())
        self.updater.call(request)
        self.host.busy = True
        self.assertFalse(self.updater.tick())
        self.assertEqual(self.updater.row(request['operationId'])['status'], 'waiting')
        self.assertEqual(self.host.switches, [])
        self.host.busy = False
        self.updater.tick()
        self.assertEqual(self.host.switches, ['candidate'])

    def test_failed_candidate_restores_previous_without_database_restore(self):
        request = self.apply(self.plan())
        self.updater.call(request)
        self.host.healthy['candidate'] = False
        self.updater.tick()
        receipt = self.updater.receipt(self.updater.row(request['operationId']))
        self.assertEqual(receipt['status'], 'rolled_back')
        self.assertFalse(receipt['result']['restoresDatabase'])
        self.assertEqual(self.host.switches, ['candidate', 'old'])

    def test_interrupted_switch_observes_success_without_restart(self):
        request = self.apply(self.plan())
        self.updater.call(request)
        row = self.updater.row(request['operationId'])
        self.updater.save(row, 'running', 'switch_intent', {'release': 'candidate', 'previousRelease': 'old'})
        self.host.release = 'candidate'
        self.updater.tick()
        self.assertEqual(self.host.switches, [])
        self.assertEqual(self.updater.row(row['id'])['status'], 'completed')

    def test_interrupted_failed_switch_restores_previous(self):
        request = self.apply(self.plan())
        self.updater.call(request)
        row = self.updater.row(request['operationId'])
        self.updater.save(row, 'running', 'switched', {'release': 'candidate', 'previousRelease': 'old'})
        self.host.release = 'candidate'
        self.host.healthy['candidate'] = False
        self.updater.tick()
        self.assertEqual(self.host.switches, ['old'])
        self.assertEqual(self.updater.row(row['id'])['status'], 'rolled_back')

    def test_lost_drain_response_restores_service_using_persisted_intent(self):
        request = self.apply(self.plan())
        self.updater.call(request)
        def reserve(operation):
            row = self.updater.row(operation)
            self.assertEqual(row['phase'], 'drain_intent')
            self.assertIn('previousRelease', row['result'])
            self.host.fenced = True
            self.host.healthy['old'] = False
            raise TimeoutError('Lost stop response')
        def restore(target, operation):
            self.host.switch(target, operation)
            self.host.healthy[target] = True
        self.host.reserve, self.host.restore = reserve, restore
        self.updater.tick()
        self.assertEqual(self.host.switches, ['old'])
        self.assertFalse(self.host.fenced)
        self.assertEqual(self.updater.row(request['operationId'])['status'], 'rolled_back')

    def test_interrupted_drain_does_not_activate_candidate(self):
        request = self.apply(self.plan())
        self.updater.call(request)
        row = self.updater.row(request['operationId'])
        self.updater.save(row, 'running', 'drain_intent', {'release': 'candidate', 'previousRelease': 'old'})
        self.host.fenced = True
        self.updater.tick()
        self.assertEqual(self.host.switches, [])
        self.assertEqual(self.updater.row(row['id'])['status'], 'rolled_back')
        self.assertFalse(self.host.fenced)

    def test_failed_reservation_does_not_open_another_operations_fence(self):
        request = self.apply(self.plan())
        self.updater.call(request)
        self.host.fenced = True
        self.host.reservation_held = lambda operation: False
        def reserve(operation): raise RuntimeError('Another activation holds the fence')
        self.host.reserve = reserve
        self.updater.tick()
        self.assertTrue(self.host.fenced)
        self.assertEqual(self.host.switches, [])
        self.assertEqual(self.updater.row(request['operationId'])['status'], 'failed')

    def test_recovery_health_exception_restores_and_does_not_open_early(self):
        request = self.apply(self.plan())
        self.updater.call(request)
        row = self.updater.row(request['operationId'])
        self.updater.save(row, 'running', 'switched', {'release': 'candidate', 'previousRelease': 'old'})
        self.host.release, self.host.fenced = 'candidate', True
        health = self.host.health
        def fail_candidate(target):
            if target == 'candidate': raise TimeoutError('Lost health response')
            return health(target)
        self.host.health = fail_candidate
        self.updater.tick()
        self.assertEqual(self.host.switches, ['old'])
        self.assertEqual(self.updater.row(row['id'])['status'], 'rolled_back')
        self.assertFalse(self.host.fenced)

    def test_unobservable_recovery_retains_fence_and_explicit_retry_path(self):
        request = self.apply(self.plan())
        self.updater.call(request)
        row = self.updater.row(request['operationId'])
        self.updater.save(row, 'running', 'switched', {'release': 'candidate', 'previousRelease': 'old'})
        self.host.release, self.host.fenced = 'candidate', True
        active = self.host.active
        def fail_active(): raise RuntimeError('Active state temporarily unreadable')
        self.host.active = fail_active
        self.updater.tick()
        self.assertEqual(self.updater.row(row['id'])['phase'], 'restoration_failed')
        self.assertTrue(self.host.fenced)
        self.assertEqual(self.host.switches, [])
        self.host.active = active
        self.updater.call(request)
        self.updater.tick()
        self.assertEqual(self.host.switches, ['old'])
        self.assertFalse(self.host.fenced)

    def test_preparation_status_exposes_only_owned_plan_diagnostics(self):
        inspected = []
        def diagnostics(operation):
            inspected.append(operation)
            return [{'phase': 'build', 'exitCode': 1, 'tail': 'Useful fixture error'}]
        self.host.diagnostics = diagnostics
        plan = self.plan()
        status = self.updater.call({'action': 'status', 'owner': 'jensen', 'operationId': plan['operationId']})
        self.assertEqual(status['diagnostics'][0]['tail'], 'Useful fixture error')
        with self.assertRaises(module.UpdateError):
            self.updater.call({'action': 'status', 'owner': 'jensen', 'operationId': str(uuid.uuid4())})
        self.assertEqual(inspected, [plan['operationId']])
        history = self.updater.call({'action': 'history', 'owner': 'jensen'})
        self.assertNotIn('diagnostics', history['operations'][0])
        request = self.apply(plan)
        self.updater.call(request)
        status = self.updater.call({'action': 'status', 'owner': 'jensen', 'operationId': request['operationId']})
        self.assertNotIn('diagnostics', status)

    def test_failed_restoration_explicit_identical_retry_recovers_same_operation(self):
        request = self.apply(self.plan())
        self.updater.call(request)
        self.host.healthy['candidate'] = False
        original_restore = self.host.restore
        def fail_restore(target, operation):
            raise RuntimeError('Temporary service control failure')
        self.host.restore = fail_restore
        self.updater.tick()
        failed = self.updater.receipt(self.updater.row(request['operationId']))
        self.assertEqual((failed['status'], failed['phase']), ('failed', 'restoration_failed'))
        self.assertTrue(self.host.fenced)
        before = list(self.host.switches)
        # Read-only status does not retry effects.
        self.updater.call({'action': 'status', 'owner': 'jensen', 'operationId': request['operationId']})
        self.assertEqual(self.host.switches, before)
        retry = self.updater.call(request)
        self.assertEqual((retry['status'], retry['phase']), ('queued', 'rollback_intent'))
        self.assertEqual(retry['operationId'], failed['operationId'])
        self.assertEqual(retry['result']['recoveryAttempts'], 1)
        self.assertEqual(self.updater.call(request)['result']['recoveryAttempts'], 1)
        self.host.restore = original_restore
        self.updater.tick()
        self.assertEqual(self.updater.row(request['operationId'])['status'], 'rolled_back')
        self.assertEqual(self.host.switches, ['candidate', 'old'])
        self.assertFalse(self.host.fenced)

    def test_restoration_retry_observes_healthy_previous_without_another_restart(self):
        request = self.apply(self.plan())
        self.updater.call(request)
        self.host.healthy['candidate'] = False
        self.host.healthy['old'] = False
        self.updater.tick()
        self.assertEqual(self.updater.row(request['operationId'])['phase'], 'restoration_failed')
        self.host.healthy['old'] = True
        before = list(self.host.switches)
        self.updater.call(request)
        self.updater.tick()
        self.assertEqual(self.host.switches, before)
        self.assertEqual(self.updater.row(request['operationId'])['status'], 'rolled_back')

    def test_stale_release_and_changed_plan_rejected(self):
        plan = self.plan()
        with self.assertRaisesRegex(module.UpdateError, 'exact prepared plan'):
            self.updater.call({**self.apply(plan), 'planDigest': '0' * 64})
        self.host.release = 'third'
        with self.assertRaisesRegex(module.UpdateError, 'active release changed'):
            self.updater.call({**self.apply(plan), 'expectedRelease': 'old'})

    def test_interrupted_build_not_reexecuted(self):
        request = self.request('plan', exportId=str(uuid.uuid4()), sourceCommit='a'*40, sourceDigest='b'*64)
        self.updater.call(request)
        self.updater.save(self.updater.row(request['operationId']), 'running', 'building')
        self.updater.tick()
        self.assertEqual(self.host.builds, 0)
        self.assertEqual(self.updater.row(request['operationId'])['status'], 'failed')

    def test_explicit_rollback_uses_recorded_previous_release(self):
        request = self.apply(self.plan())
        self.updater.call(request)
        self.updater.tick()
        rollback = self.request('rollback', deploymentOperationId=request['operationId'])
        self.updater.call(rollback)
        self.updater.tick()
        self.assertEqual(self.host.release, 'old')
        self.assertEqual(self.updater.row(rollback['operationId'])['status'], 'completed')

    def test_authorization_arbitrary_fields_and_bounded_history(self):
        with self.assertRaises(module.UpdateError): self.updater.call({'action': 'status', 'owner': 'attacker'})
        with self.assertRaises(module.UpdateError): self.updater.call({'action': 'status', 'owner': 'jensen', 'command': 'anything'})
        self.plan()
        self.plan()
        page = self.updater.call({'action': 'history', 'owner': 'jensen', 'limit': 1})
        following = self.updater.call({'action': 'history', 'owner': 'jensen', 'limit': 1, 'cursor': page['nextCursor']})
        self.assertNotEqual(page['operations'][0]['operationId'], following['operations'][0]['operationId'])
        self.assertIsNone(following['nextCursor'])


if __name__ == '__main__': unittest.main()
