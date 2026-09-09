"""Real-Git, fake-systemd deployment safety and crash recovery checks.

Run on Linux: python3 -m unittest discover -s test -p test_deploy_discord.py
No production repository, network credential, or actual service is used.
"""
import importlib.util
import datetime
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import tarfile
import time
import unittest
import uuid

SPEC = importlib.util.spec_from_file_location('deploy_discord', Path(__file__).resolve().parents[1] / 'deploy' / 'deploy-discord.py')
deployment = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deployment)


def git(path, *args):
    return subprocess.check_output(['git', '-C', str(path), *args], stderr=subprocess.PIPE).decode().strip()


class Crash(BaseException):
    pass


class FakeServiceDeployment(deployment.Deployment):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs, grace_seconds=0)
        self.invocation = 'initial-invocation'
        self.restart_count = 0
        self.crash_phase = None
        self.crash_after_restart = False
        self.fail_restart = False
        self.ready = True
        self.active = True

    def _git(self, *args, input_bytes=None):
        # The actual CLI always forbids file transport. Only this test instance
        # permits its disposable local bare remote.
        return self._run(['/usr/bin/git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
                          '-c', 'credential.helper=', '-c', 'protocol.file.allow=always', *args],
                         input_bytes=input_bytes)

    def _service(self):
        if not self.ready:
            raise deployment.DeploymentError('SERVICE_NOT_MANAGED', 'Fixture service not adopted.')
        return {'ActiveState': 'active' if self.active else 'failed', 'SubState': 'running' if self.active else 'failed', 'MainPID': str(100 + self.restart_count) if self.active else '0',
                'InvocationID': self.invocation, 'ExecMainStatus': '0',
                'ExecMainStartTimestampMonotonic': str(1000 + self.restart_count)}

    def _run(self, argv, timeout=60, input_bytes=None):
        if argv[:2] == ['/usr/bin/systemctl', 'restart']:
            self.restart_count += 1
            if self.fail_restart:
                raise deployment.DeploymentError('COMMAND_FAILED', 'Fixture restart failed.', 1)
            self.invocation = 'replacement-' + str(self.restart_count)
            self.active = True
            if self.crash_after_restart:
                self.crash_after_restart = False
                raise Crash()
            return b''
        return super()._run(argv, timeout=timeout, input_bytes=input_bytes)

    def _save(self, record, phase=None, **values):
        result = super()._save(record, phase, **values)
        if self.crash_phase is not None and phase == self.crash_phase:
            self.crash_phase = None
            raise Crash()
        return result


@unittest.skipUnless(deployment.fcntl is not None and Path('/usr/bin/git').exists(), 'Linux real-Git fixture')
class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='praxis-deploy-test-')
        self.root = Path(self.temp.name)
        self.author = self.root / 'author'
        self.author.mkdir()
        git(self.author, 'init', '-b', 'main')
        git(self.author, 'config', 'user.name', 'Fixture')
        git(self.author, 'config', 'user.email', 'fixture@example.invalid')
        (self.author / 'bot.js').write_text('old source\n')
        (self.author / 'package.json').write_text('{"name":"fixture"}\n')
        (self.author / '.gitignore').write_text('.env*\nnode_modules/\nruntime/\n')
        git(self.author, 'add', '.')
        git(self.author, 'commit', '-m', 'fixture base')
        self.base = git(self.author, 'rev-parse', 'HEAD')
        self.remote = self.root / 'remote.git'
        git(self.root, 'clone', '--bare', str(self.author), str(self.remote))
        self.repo = self.root / 'production'
        git(self.root, 'clone', str(self.remote), str(self.repo))
        (self.repo / '.env').write_text('FIXTURE_SECRET=never-echo-this\n')
        self.worker = FakeServiceDeployment(self.repo, self.root / 'state', str(self.remote), expected_uid=os.getuid(),
                                            log_path=self.root / 'bot-stdout.log', dependencies=self.root / 'dependencies',
                                            dependency_uid=os.getuid())
        self.bundle_sequence = 0

    def tearDown(self):
        self.temp.cleanup()

    def commit(self, filename='bot.js', text='new source\n'):
        (self.author / filename).parent.mkdir(parents=True, exist_ok=True)
        (self.author / filename).write_text(text)
        git(self.author, 'add', '-f', filename)
        git(self.author, 'commit', '-m', 'fixture change')
        git(self.author, 'push', str(self.remote), 'main')
        return git(self.author, 'rev-parse', 'HEAD')

    def request(self, target=None, expected=None):
        return {'action': 'apply', 'operationId': str(uuid.uuid4()),
                'expectedHead': expected or self.base, 'targetCommit': target or self.commit()}

    def test_fast_forward_and_restart_are_idempotent_and_credentials_untouched(self):
        request = self.request()
        hook = self.repo / '.git/hooks/post-merge'
        marker = self.root / 'hook-ran'
        hook.write_text('#!/bin/sh\ntouch "' + str(marker) + '"\n')
        hook.chmod(0o755)
        before = (self.repo / '.env').read_bytes()
        result = self.worker.handle(request)
        self.assertEqual(result['phase'], 'completed')
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), request['targetCommit'])
        self.assertEqual((self.repo / 'bot.js').read_text(), 'new source\n')
        self.assertEqual(self.worker.restart_count, 1)
        self.assertFalse(marker.exists())
        self.assertEqual((self.repo / '.env').read_bytes(), before)
        self.assertFalse(result['health']['discordConnectionVerified'])
        self.assertEqual(self.worker.handle(request)['phase'], 'completed')
        self.assertEqual(self.worker.restart_count, 1)
        saved = (self.root / 'state' / (request['operationId'] + '.json')).read_text()
        self.assertNotIn('never-echo-this', saved)

    def test_already_current_checkout_still_requires_real_activation(self):
        result = self.worker.handle(self.request(target=self.base))
        self.assertTrue(result['checkoutAlreadyCurrent'])
        self.assertEqual(result['phase'], 'completed')
        self.assertEqual(self.worker.restart_count, 1)

    def test_changed_request_cannot_reuse_operation_id(self):
        request = self.request()
        self.worker.handle(request)
        with self.assertRaises(deployment.DeploymentError) as caught:
            self.worker.handle({**request, 'expectedHead': request['targetCommit']})
        self.assertEqual(caught.exception.code, 'IDEMPOTENCY_CONFLICT')

    def test_stale_expected_head_does_not_change_checkout(self):
        result = self.worker.handle(self.request(expected='0' * 40))
        self.assertEqual(result['error']['code'], 'DEPLOYMENT_CONFLICT')
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), self.base)
        self.assertEqual(self.worker.restart_count, 0)

    def test_dirty_checkout_and_untracked_files_are_rejected(self):
        request = self.request()
        (self.repo / 'operator-note.txt').write_text('keep this')
        result = self.worker.handle(request)
        self.assertEqual(result['error']['code'], 'DIRTY_DEPLOYMENT')
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), self.base)

    def test_dependency_changes_require_separate_preparation(self):
        target = self.commit('package.json', '{"name":"changed"}\n')
        result = self.worker.handle(self.request(target=target))
        self.assertEqual(result['error']['code'], 'DEPENDENCY_CHANGE_UNSUPPORTED')
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), self.base)

    def test_exact_remote_tip_required(self):
        target = self.commit()
        self.commit('second.js', 'next\n')
        result = self.worker.handle(self.request(target=target))
        self.assertEqual(result['error']['code'], 'REMOTE_HEAD_CHANGED')
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), self.base)

    def test_ignored_runtime_collision_and_credentials_are_rejected(self):
        target = self.commit('.env', 'malicious replacement')
        result = self.worker.handle(self.request(target=target))
        self.assertEqual(result['error']['code'], 'PROTECTED_DEPLOYMENT_PATH')
        self.assertEqual((self.repo / '.env').read_text(), 'FIXTURE_SECRET=never-echo-this\n')

    def test_ignored_noncredential_runtime_collision_is_rejected(self):
        (self.repo / 'runtime').mkdir()
        (self.repo / 'runtime' / 'record.json').write_text('real runtime data')
        target = self.commit('runtime/record.json', 'candidate data')
        result = self.worker.handle(self.request(target=target))
        self.assertEqual(result['error']['code'], 'RUNTIME_PATH_COLLISION')
        self.assertEqual((self.repo / 'runtime' / 'record.json').read_text(), 'real runtime data')

    def test_unmanaged_service_blocks_checkout(self):
        self.worker.ready = False
        result = self.worker.handle(self.request())
        self.assertEqual(result['error']['code'], 'SERVICE_NOT_MANAGED')
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), self.base)

    def test_checkout_intent_before_effect_recovers_without_duplicate_effect(self):
        request = self.request()
        self.worker.crash_phase = 'checkout_intent'
        with self.assertRaises(Crash):
            self.worker.handle(request)
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), self.base)
        result = self.worker.handle(request)
        self.assertEqual(result['phase'], 'completed')
        self.assertEqual(self.worker.restart_count, 1)

    def test_completed_checkout_recovers_and_activates_once(self):
        request = self.request()
        self.worker.crash_phase = 'checkout_updated'
        with self.assertRaises(Crash):
            self.worker.handle(request)
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), request['targetCommit'])
        self.assertEqual(self.worker.restart_count, 0)
        result = self.worker.handle(request)
        self.assertEqual(result['phase'], 'completed')
        self.assertEqual(self.worker.restart_count, 1)

    def test_restart_intent_without_proof_becomes_uncertain_and_never_restarts(self):
        request = self.request()
        self.worker.crash_phase = 'restart_intent'
        with self.assertRaises(Crash):
            self.worker.handle(request)
        result = self.worker.handle(request)
        self.assertEqual(result['phase'], 'uncertain')
        self.assertEqual(self.worker.restart_count, 0)
        self.assertEqual(self.worker.handle(request)['phase'], 'uncertain')
        with self.assertRaises(deployment.DeploymentError) as caught:
            self.worker.handle(self.request(target=request['targetCommit'], expected=request['targetCommit']))
        self.assertEqual(caught.exception.code, 'DEPLOYMENT_BUSY')

    def test_restart_return_lost_recovers_active_invocation_without_repeat(self):
        request = self.request()
        self.worker.crash_after_restart = True
        with self.assertRaises(Crash):
            self.worker.handle(request)
        result = self.worker.handle({'action': 'status', 'operationId': request['operationId']})
        self.assertEqual(result['phase'], 'completed')
        self.assertEqual(self.worker.restart_count, 1)
        self.assertEqual(self.worker.handle(request)['phase'], 'completed')
        self.assertEqual(self.worker.restart_count, 1)

    def test_failed_restart_keeps_updated_checkout_and_never_rolls_back(self):
        request = self.request()
        self.worker.fail_restart = True
        result = self.worker.handle(request)
        self.assertEqual(result['phase'], 'failed')
        self.assertTrue(result['activationFailed'])
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), request['targetCommit'])
        self.worker.handle(request)
        self.assertEqual(self.worker.restart_count, 1)

    def test_checkout_drift_after_crash_blocks_restart(self):
        request = self.request()
        self.worker.crash_phase = 'checkout_updated'
        with self.assertRaises(Crash):
            self.worker.handle(request)
        (self.repo / 'bot.js').write_text('operator edit')
        result = self.worker.handle(request)
        self.assertEqual(result['phase'], 'uncertain')
        self.assertEqual(self.worker.restart_count, 0)
        self.assertEqual((self.repo / 'bot.js').read_text(), 'operator edit')

    def test_ref_updated_but_worktree_not_written_is_reported_uncertain(self):
        request = self.request()
        original = self.worker._git

        def crash_before_read_tree(*args, **kwargs):
            if args[0] == 'read-tree':
                raise Crash()
            return original(*args, **kwargs)

        self.worker._git = crash_before_read_tree
        with self.assertRaises(Crash):
            self.worker.handle(request)
        self.worker._git = original
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), request['targetCommit'])
        self.assertEqual((self.repo / 'bot.js').read_text(), 'old source\n')
        result = self.worker.handle(request)
        self.assertEqual(result['phase'], 'uncertain')
        self.assertEqual(self.worker.restart_count, 0)
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), request['targetCommit'])

    def test_atomic_ref_compare_and_swap_preserves_concurrent_external_head(self):
        request = self.request()
        git(self.author, 'checkout', '-b', 'external', self.base)
        (self.author / 'other.js').write_text('external change')
        git(self.author, 'add', 'other.js')
        git(self.author, 'commit', '-m', 'external operator')
        external = git(self.author, 'rev-parse', 'HEAD')
        git(self.repo, 'fetch', str(self.author), 'external')
        original = self.worker._git

        def external_update_before_cas(*args, **kwargs):
            if args[0] == 'update-ref':
                git(self.repo, 'update-ref', 'refs/heads/main', external, self.base)
            return original(*args, **kwargs)

        self.worker._git = external_update_before_cas
        result = self.worker.handle(request)
        self.assertEqual(result['phase'], 'uncertain')
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), external)
        self.assertEqual(self.worker.restart_count, 0)

    def test_non_fast_forward_remote_head_is_rejected(self):
        request = self.request()
        result = self.worker.handle(request)
        self.assertEqual(result['phase'], 'completed')
        git(self.author, 'reset', '--hard', self.base)
        git(self.author, 'push', '--force', str(self.remote), 'main')
        result = self.worker.handle(self.request(target=self.base, expected=request['targetCommit']))
        self.assertEqual(result['phase'], 'failed')
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), request['targetCommit'])
        self.assertEqual(self.worker.restart_count, 1)

    def test_candidate_symlinks_are_rejected(self):
        os.symlink('/etc/passwd', self.author / 'host-link')
        git(self.author, 'add', 'host-link')
        git(self.author, 'commit', '-m', 'symlink candidate')
        git(self.author, 'push', str(self.remote), 'main')
        target = git(self.author, 'rev-parse', 'HEAD')
        result = self.worker.handle(self.request(target=target))
        self.assertEqual(result['error']['code'], 'UNSUPPORTED_TREE_ENTRY')
        self.assertFalse((self.repo / 'host-link').exists())

    def test_symlink_journal_and_unsafe_repository_config_are_rejected(self):
        request = self.request()
        git(self.repo, 'config', 'filter.bad.smudge', 'false')
        result = self.worker.handle(request)
        self.assertEqual(result['error']['code'], 'UNSUPPORTED_GIT_CONFIGURATION')
        path = self.root / 'state' / (request['operationId'] + '.json')
        path.unlink()
        os.symlink(self.repo / '.env', path)
        with self.assertRaises(deployment.DeploymentError) as caught:
            self.worker.handle({'action': 'status', 'operationId': request['operationId']})
        self.assertEqual(caught.exception.code, 'UNTRUSTED_PATH')

    def test_explicit_restart_recovers_failed_service_without_checkout_or_duplicate_restart(self):
        self.worker.active = False
        request = {'action': 'restart', 'operationId': str(uuid.uuid4()), 'expectedHead': self.base}
        result = self.worker.handle(request)
        self.assertEqual(result['phase'], 'completed')
        self.assertEqual(result['action'], 'restart')
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), self.base)
        self.assertEqual(self.worker.handle(request)['phase'], 'completed')
        self.assertEqual(self.worker.restart_count, 1)

    def test_explicit_restart_requires_exact_head(self):
        result = self.worker.handle({'action': 'restart', 'operationId': str(uuid.uuid4()), 'expectedHead': '0' * 40})
        self.assertEqual(result['error']['code'], 'DEPLOYMENT_CONFLICT')
        self.assertEqual(self.worker.restart_count, 0)

    def test_uncertain_restart_requires_named_recovery_and_preserves_original_uncertainty(self):
        request = self.request()
        self.worker.crash_phase = 'restart_intent'
        with self.assertRaises(Crash):
            self.worker.handle(request)
        self.assertEqual(self.worker.handle({'action': 'status', 'operationId': request['operationId']})['phase'], 'uncertain')
        recovery = {'action': 'restart', 'operationId': str(uuid.uuid4()), 'expectedHead': request['targetCommit'],
                    'recoverOperationId': request['operationId']}
        self.assertEqual(self.worker.handle(recovery)['phase'], 'completed')
        original = self.worker.handle({'action': 'status', 'operationId': request['operationId']})
        self.assertEqual(original['phase'], 'uncertain')
        self.assertEqual(original['resolvedBy'], recovery['operationId'])
        self.assertEqual(self.worker.restart_count, 1)

    def test_rollback_restores_only_recorded_previous_revision_and_preserves_runtime(self):
        deploy = self.request()
        self.worker.handle(deploy)
        runtime = self.repo / 'runtime'
        runtime.mkdir()
        (runtime / 'record.json').write_text('retained recording')
        request = {'action': 'rollback', 'operationId': str(uuid.uuid4()), 'expectedHead': deploy['targetCommit'],
                   'deploymentOperationId': deploy['operationId']}
        result = self.worker.handle(request)
        self.assertEqual(result['phase'], 'completed')
        self.assertEqual(result['targetCommit'], self.base)
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), self.base)
        self.assertEqual(git(self.remote, 'rev-parse', 'main'), deploy['targetCommit'])
        self.assertEqual((runtime / 'record.json').read_text(), 'retained recording')
        self.assertEqual((self.repo / '.env').read_text(), 'FIXTURE_SECRET=never-echo-this\n')
        self.worker.handle(request)
        self.assertEqual(self.worker.restart_count, 2)

    def test_rollback_of_failed_activation_can_restore_a_working_revision(self):
        deploy = self.request()
        self.worker.fail_restart = True
        self.assertEqual(self.worker.handle(deploy)['phase'], 'failed')
        self.worker.fail_restart = False
        self.worker.active = False
        request = {'action': 'rollback', 'operationId': str(uuid.uuid4()), 'expectedHead': deploy['targetCommit'],
                   'deploymentOperationId': deploy['operationId']}
        self.assertEqual(self.worker.handle(request)['phase'], 'completed')
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), self.base)

    def test_rollback_lost_restart_response_recovers_without_repeating(self):
        deploy = self.request()
        self.worker.handle(deploy)
        request = {'action': 'rollback', 'operationId': str(uuid.uuid4()), 'expectedHead': deploy['targetCommit'],
                   'deploymentOperationId': deploy['operationId']}
        self.worker.crash_after_restart = True
        with self.assertRaises(Crash):
            self.worker.handle(request)
        result = self.worker.handle({'action': 'status', 'operationId': request['operationId']})
        self.assertEqual(result['phase'], 'completed')
        self.assertEqual(self.worker.restart_count, 2)

    def test_rollback_cannot_reference_an_arbitrary_commit_or_unrelated_operation(self):
        request = {'action': 'rollback', 'operationId': str(uuid.uuid4()), 'expectedHead': self.base,
                   'deploymentOperationId': str(uuid.uuid4())}
        with self.assertRaises(deployment.DeploymentError) as caught:
            self.worker.handle(request)
        self.assertEqual(caught.exception.code, 'ROLLBACK_REFERENCE_INVALID')
        with self.assertRaises(deployment.DeploymentError):
            self.worker.handle({**request, 'targetCommit': self.base})
        self.assertEqual(self.worker.restart_count, 0)

    def test_history_has_stable_bounded_cursor_and_no_private_journal_fields(self):
        first = self.request()
        self.worker.handle(first)
        second = {'action': 'restart', 'operationId': str(uuid.uuid4()), 'expectedHead': first['targetCommit']}
        self.worker.handle(second)
        page = self.worker.handle({'action': 'history', 'limit': 1})
        self.assertEqual(page['operations'][0]['operationId'], second['operationId'])
        self.assertEqual(page['nextCursor'], second['operationId'])
        last = self.worker.handle({'action': 'history', 'limit': 1, 'cursor': page['nextCursor']})
        self.assertEqual(last['operations'][0]['operationId'], first['operationId'])
        self.assertIsNone(last['nextCursor'])
        self.assertNotIn('request', page['operations'][0])

    def test_diagnosis_exports_only_operational_events_and_safe_error_codes(self):
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        self.worker.log_path.write_text('\n'.join([
            f'[{now}] [INFO] [Bot] Logged in as private-user#1234',
            f'[{now}] [INFO] [GeminiLive] Input transcript: private conversation',
            f'[{now}] [ERROR] Request failed with ECONNREFUSED token=never-echo-this private conversation',
            f'[{now}] [INFO] [Shutdown] SIGTERM received; awaiting bot cleanup',
            f'[{now}] [INFO] [Shutdown] SIGTERM: cleanup complete; exiting with code 0',
        ]))
        result = self.worker.handle({'action': 'diagnosis', 'limit': 10})
        serialized = json.dumps(result)
        for secret in ('private-user', 'private conversation', 'never-echo-this', 'token='):
            self.assertNotIn(secret, serialized)
        self.assertIn('ECONNREFUSED', serialized)
        self.assertEqual(result['logs']['omittedLines'], 1)
        self.assertTrue(result['health']['processRunning'])
        self.assertTrue(result['health']['discordLoginObservedForCurrentInvocation'])
        self.assertFalse(result['health']['discordConnectionVerified'])

    def test_diagnosis_does_not_call_old_login_current_and_rejects_symlink_logs(self):
        self.worker.log_path.write_text('[2000-01-01T00:00:00.000Z] [INFO] [Bot] Logged in as old-user\n')
        result = self.worker.handle({'action': 'diagnosis'})
        self.assertFalse(result['health']['discordLoginObservedForCurrentInvocation'])
        self.worker.log_path.unlink()
        self.worker.log_path.symlink_to(self.repo / '.env')
        with self.assertRaises(deployment.DeploymentError) as caught:
            self.worker.handle({'action': 'diagnosis'})
        self.assertEqual(caught.exception.code, 'UNTRUSTED_LOG')

    def bundle(self, target, members=None, changes=None):
        directory = self.worker.dependencies
        directory.mkdir(mode=0o750, exist_ok=True)
        memory = io.BytesIO()
        with tarfile.open(fileobj=memory, mode='w') as archive:
            if members is None:
                members = [('node_modules/package/index.js', b'new dependency', None),
                           ('node_modules/.bin/package', b'', '../package/index.js')]
            for name, content, link in members:
                info = tarfile.TarInfo(name)
                if link is not None:
                    info.type = tarfile.SYMTYPE
                    info.linkname = link
                else:
                    info.size = len(content)
                archive.addfile(info, io.BytesIO(content) if link is None else None)
        data = memory.getvalue()
        artifact = hashlib.sha256(data).hexdigest()
        (directory / (artifact + '.tar')).write_bytes(data)
        node = subprocess.check_output(['/usr/bin/node', '--version']).decode().strip()
        manifest = {'version': 1, 'archiveSha256': artifact, 'platform': 'linux', 'arch': 'x64',
                    'nodeMajor': int(node.lstrip('v').split('.')[0]), 'nodeVersion': node,
                    **self.worker._dependency_manifest_hashes(target), **(changes or {})}
        (directory / (artifact + '.json')).write_text(json.dumps(manifest))
        return artifact

    def dependency_request(self, members=None, changes=None):
        self.bundle_sequence += 1
        self.commit('package-lock.json', json.dumps({'lockfileVersion': 3, 'fixtureRevision': self.bundle_sequence}) + '\n')
        target = self.commit('package.json', json.dumps({'name': 'changed', 'dependencies': {'package': '1.0.0'},
                                                       'fixtureRevision': self.bundle_sequence}) + '\n')
        # Fetch only repository objects so the fixture manifest can independently
        # hash the exact target. Production helper does its own fixed fetch.
        git(self.repo, 'fetch', str(self.remote), 'main')
        return {**self.request(target=target), 'preparedDependenciesId': self.bundle(target, members, changes)}

    def test_prepared_dependencies_are_swapped_and_rollback_restores_original_modules(self):
        modules = self.repo / 'node_modules'
        modules.mkdir()
        (modules / 'old.js').write_text('old dependency')
        request = self.dependency_request()
        result = self.worker.handle(request)
        self.assertEqual(result['phase'], 'completed', result)
        self.assertEqual((modules / 'package/index.js').read_text(), 'new dependency')
        self.assertEqual((modules / '.bin/package').resolve(), modules / 'package/index.js')
        self.assertFalse((modules / 'old.js').exists())
        rollback = {'action': 'rollback', 'operationId': str(uuid.uuid4()), 'expectedHead': request['targetCommit'],
                    'deploymentOperationId': request['operationId']}
        restored = self.worker.handle(rollback)
        self.assertEqual(restored['phase'], 'completed', restored)
        self.assertEqual((modules / 'old.js').read_text(), 'old dependency')
        self.assertFalse((modules / 'package').exists())

    def test_prepared_dependencies_do_not_execute_install_scripts(self):
        marker = self.root / 'candidate-script-ran'
        request = self.dependency_request(members=[('node_modules/package/package.json',
            json.dumps({'scripts': {'install': 'touch ' + str(marker)}}).encode(), None)])
        self.assertEqual(self.worker.handle(request)['phase'], 'completed')
        self.assertFalse(marker.exists())

    def test_dependency_manifest_and_runtime_mismatches_block_checkout(self):
        for changes in ({'packageJsonSha256': '0' * 64}, {'nodeMajor': 999}, {'arch': 'arm64'}):
            request = self.dependency_request(changes=changes)
            result = self.worker.handle(request)
            self.assertIn(result['error']['code'], ('DEPENDENCIES_MISMATCH', 'DEPENDENCIES_RUNTIME_MISMATCH'))
            self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), self.base)
            # Vary the next fixture commit content without rewriting main.
            git(self.author, 'commit', '--allow-empty', '-m', 'separate candidate')

    def test_unsafe_dependency_archive_is_rejected_before_checkout(self):
        for name, link in [('node_modules/../../outside', None), ('node_modules/.bin/bad', '/etc/passwd'),
                           ('node_modules/.bin/bad', '../../../outside')]:
            request = self.dependency_request(members=[(name, b'unsafe', link)])
            result = self.worker.handle(request)
            self.assertEqual(result['error']['code'], 'DEPENDENCIES_ARCHIVE_INVALID')
            self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), self.base)
            git(self.author, 'commit', '--allow-empty', '-m', 'separate candidate')

    def test_dependency_swap_crashes_recover_without_duplicate_swaps(self):
        for phase in ('dependencies_intent', 'dependencies_previous_saved', 'dependencies_updated'):
            with self.subTest(phase=phase):
                request = self.dependency_request()
                self.worker.crash_phase = phase
                with self.assertRaises(Crash):
                    self.worker.handle(request)
                result = self.worker.handle(request)
                self.assertEqual(result['phase'], 'completed', result)
                self.assertEqual((self.repo / 'node_modules/package/index.js').read_text(), 'new dependency')
                self.worker.handle(request)
                rollback = {'action': 'rollback', 'operationId': str(uuid.uuid4()), 'expectedHead': request['targetCommit'],
                            'deploymentOperationId': request['operationId']}
                self.assertEqual(self.worker.handle(rollback)['phase'], 'completed')
                git(self.author, 'commit', '--allow-empty', '-m', 'separate candidate')

    def test_dependency_rename_effect_before_journal_update_recovers(self):
        modules = self.repo / 'node_modules'
        modules.mkdir()
        (modules / 'old.js').write_text('old')
        request = self.dependency_request()
        save = self.worker._save
        interrupted = False

        def crash_before_completed_swap_journal(record, phase=None, **values):
            nonlocal interrupted
            if phase == 'dependencies_updated' and not interrupted:
                interrupted = True
                raise Crash()
            return save(record, phase, **values)

        self.worker._save = crash_before_completed_swap_journal
        with self.assertRaises(Crash):
            self.worker.handle(request)
        self.assertTrue((modules / 'package/index.js').exists())
        result = self.worker.handle(request)
        self.assertEqual(result['phase'], 'completed')
        self.assertEqual(self.worker.restart_count, 1)

    def test_dependency_archive_symlink_ancestors_and_digest_mismatch_are_rejected(self):
        request = self.dependency_request(members=[('node_modules/path', b'', 'package'),
                                                   ('node_modules/path/index.js', b'unsafe', None)])
        result = self.worker.handle(request)
        self.assertEqual(result['error']['code'], 'DEPENDENCIES_ARCHIVE_INVALID')
        request = self.dependency_request()
        (self.worker.dependencies / (request['preparedDependenciesId'] + '.tar')).write_bytes(b'corrupted archive')
        result = self.worker.handle(request)
        self.assertEqual(result['error']['code'], 'DEPENDENCIES_HASH_MISMATCH')
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), self.base)


class RequestValidationTests(unittest.TestCase):
    def test_no_arbitrary_paths_commands_repositories_or_units(self):
        for extra in ['repository', 'origin', 'unit', 'command', 'argv', 'stateDirectory']:
            with self.assertRaises(deployment.DeploymentError):
                deployment.validate_request({'action': 'status', extra: 'arbitrary'})

    def test_exact_commit_and_uuid_syntax(self):
        for value in ['main', 'HEAD', '--help', '../escape', 'A' * 40, 'x' * 40]:
            with self.assertRaises(deployment.DeploymentError):
                deployment.validate_request({'action': 'apply', 'operationId': str(uuid.uuid4()),
                                             'expectedHead': 'a' * 40, 'targetCommit': value})
        with self.assertRaises(deployment.DeploymentError):
            deployment.validate_request({'action': 'status', 'operationId': '../escape'})

    def test_read_limits_and_recovery_inputs_are_bounded(self):
        for limit in (0, 101, True, '10', None):
            with self.assertRaises(deployment.DeploymentError):
                deployment.validate_request({'action': 'diagnosis', 'limit': limit})
        with self.assertRaises(deployment.DeploymentError):
            deployment.validate_request({'action': 'restart', 'operationId': str(uuid.uuid4())})


if __name__ == '__main__':
    unittest.main()
