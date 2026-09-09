"""Real-Git, fake-systemd deployment safety and crash recovery checks.

Run on Linux: python3 -m unittest discover -s test -p test_deploy_discord.py
No production repository, network credential, or actual service is used.
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
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

    def _git(self, *args, input_bytes=None):
        # The actual CLI always forbids file transport. Only this test instance
        # permits its disposable local bare remote.
        return self._run(['/usr/bin/git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
                          '-c', 'credential.helper=', '-c', 'protocol.file.allow=always', *args],
                         input_bytes=input_bytes)

    def _service(self):
        if not self.ready:
            raise deployment.DeploymentError('SERVICE_NOT_MANAGED', 'Fixture service not adopted.')
        return {'ActiveState': 'active', 'SubState': 'running', 'MainPID': str(100 + self.restart_count),
                'InvocationID': self.invocation, 'ExecMainStatus': '0',
                'ExecMainStartTimestampMonotonic': str(1000 + self.restart_count)}

    def _run(self, argv, timeout=60, input_bytes=None):
        if argv[:2] == ['/usr/bin/systemctl', 'restart']:
            self.restart_count += 1
            if self.fail_restart:
                raise deployment.DeploymentError('COMMAND_FAILED', 'Fixture restart failed.', 1)
            self.invocation = 'replacement-' + str(self.restart_count)
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
        self.worker = FakeServiceDeployment(self.repo, self.root / 'state', str(self.remote), expected_uid=os.getuid())

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


if __name__ == '__main__':
    unittest.main()
