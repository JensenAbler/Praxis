import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('deploy_targets', Path(__file__).resolve().parents[1] / 'deploy' / 'deploy-discord.py')
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)

APOCRYPHA = {'repository': '/srv/apocrypha', 'repositoryName': 'JensenAbler/apocrypha',
             'origin': 'https://github.com/JensenAbler/apocrypha.git', 'unit': 'apocrypha.service',
             'protectedPaths': ['/var/lib/apocrypha'], 'execStart': ['/usr/bin/node', '/srv/apocrypha/src/server.js'],
             'user': 'apocrypha'}


def systemctl_show(user, exec_start, directory='/srv/apocrypha'):
    argv = ' '.join(exec_start)
    return ('LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=42\nInvocationID=abc\n'
            f'WorkingDirectory={directory}\nUser={user}\nFragmentPath=/etc/systemd/system/x.service\n'
            f'ExecStart={{ path={exec_start[0]} ; argv[]={argv} ; ignore_errors=no }}\n').encode()


class TargetRegistryTests(unittest.TestCase):
    def write(self, value, mode=0o644):
        directory = tempfile.mkdtemp(prefix='praxis-targets-')
        path = Path(directory) / 'targets.json'
        path.write_text(json.dumps(value))
        path.chmod(mode)
        return path

    def test_missing_registry_keeps_only_discord(self):
        targets = helper.load_targets(Path('/nonexistent/praxis/targets.json'), expected_uid=os.geteuid())
        self.assertEqual(list(targets), ['discord'])
        self.assertEqual(targets['discord']['unit'], 'podcast-discord.service')
        self.assertEqual(targets['discord']['health'], 'discord-login')

    def test_registry_adds_declarative_target_with_systemd_health_default(self):
        targets = helper.load_targets(self.write({'apocrypha': APOCRYPHA}), expected_uid=os.geteuid())
        self.assertEqual(targets['apocrypha']['health'], 'systemd')
        self.assertIsNone(targets['apocrypha']['logPath'])
        self.assertIn('discord', targets)

    def test_malformed_target_blocks_only_itself(self):
        broken = {key: value for key, value in APOCRYPHA.items() if key != 'execStart'}
        other = {**APOCRYPHA, 'repository': '/srv/other', 'repositoryName': 'JensenAbler/other', 'unit': 'other.service'}
        targets = helper.load_targets(self.write({'apocrypha': broken, 'other': other, 'discord': {'bad': True}}), expected_uid=os.geteuid())
        deployment, _ = helper.deployment_for({'action': 'status'}, targets)
        self.assertEqual(deployment.repository, helper.REPOSITORY, 'built-in discord survives a malformed override')
        self.assertEqual(str(helper.deployment_for({'action': 'status', 'projectId': 'other'}, targets)[0].repository), '/srv/other')
        with self.assertRaises(helper.DeploymentError) as caught:
            helper.deployment_for({'action': 'status', 'projectId': 'apocrypha'}, targets)
        self.assertEqual(caught.exception.code, 'INVALID_TARGETS')

    def test_writable_registry_is_refused(self):
        with self.assertRaises(helper.DeploymentError) as caught:
            helper.load_targets(self.write({'apocrypha': APOCRYPHA}, mode=0o666), expected_uid=os.geteuid())
        self.assertEqual(caught.exception.code, 'UNTRUSTED_PATH')

    def test_protected_path_may_not_overlap_checkout(self):
        for protected in ('/srv/apocrypha', '/srv/apocrypha/data', '/srv'):
            with self.subTest(protected=protected), self.assertRaises(helper.DeploymentError) as caught:
                helper.validate_target('apocrypha', {**APOCRYPHA, 'protectedPaths': [protected]})
            self.assertEqual(caught.exception.code, 'PROTECTED_PATH_CONFLICT')

    def test_malformed_targets_are_refused(self):
        bad = [('Apocrypha', APOCRYPHA), ('apocrypha', {**APOCRYPHA, 'repository': 'srv/apocrypha'}),
               ('apocrypha', {**APOCRYPHA, 'repository': '/srv/../etc'}), ('apocrypha', {**APOCRYPHA, 'unit': 'x; rm'}),
               ('apocrypha', {**APOCRYPHA, 'health': 'shell:true'}), ('apocrypha', {**APOCRYPHA, 'hook': 'echo'}),
               ('apocrypha', {**APOCRYPHA, 'repository': '/'})]
        for project_id, spec in bad:
            with self.subTest(project_id=project_id, spec=spec), self.assertRaises(helper.DeploymentError) as caught:
                helper.validate_target(project_id, spec)
            self.assertEqual(caught.exception.code, 'INVALID_TARGETS')

    def test_project_id_selects_target_and_is_stripped_from_request(self):
        targets = {**helper.DEFAULT_TARGETS, 'apocrypha': helper.validate_target('apocrypha', APOCRYPHA)}
        deployment, request = helper.deployment_for({'action': 'status', 'projectId': 'apocrypha'}, targets)
        self.assertEqual(request, {'action': 'status'})
        self.assertEqual(str(deployment.repository), '/srv/apocrypha')
        self.assertEqual(deployment.unit, 'apocrypha.service')
        self.assertEqual(deployment.state, helper.STATE_ROOT / 'apocrypha')
        self.assertEqual(deployment.repository_name, 'JensenAbler/apocrypha')
        self.assertIsNone(deployment.log_path)

    def test_absent_project_id_keeps_legacy_discord_behavior(self):
        deployment, request = helper.deployment_for({'action': 'status'}, helper.load_targets(Path('/nonexistent/t.json')))
        self.assertEqual(request, {'action': 'status'})
        self.assertEqual(deployment.state, helper.STATE)
        self.assertEqual(deployment.repository, helper.REPOSITORY)

    def test_unregistered_project_is_forbidden(self):
        with self.assertRaises(helper.DeploymentError) as caught:
            helper.deployment_for({'action': 'status', 'projectId': 'production'}, dict(helper.DEFAULT_TARGETS))
        self.assertEqual(caught.exception.code, 'FORBIDDEN')

    def test_unconfigured_log_reports_unavailable(self):
        deployment = helper.Deployment(repository='/srv/apocrypha', log_path=None, health='systemd')
        self.assertEqual(deployment._logs(10)['reason'], 'no-log-configured')

    def service(self, spec, show):
        deployment, _ = helper.deployment_for({'action': 'status', 'projectId': 'apocrypha'},
                                              {'apocrypha': helper.validate_target('apocrypha', spec)})
        deployment._run = lambda argv, **kwargs: show
        deployment._trusted_path = lambda path, **kwargs: None
        return deployment._service()

    def test_declared_entrypoint_contract_is_enforced(self):
        exec_start = APOCRYPHA['execStart']
        self.assertEqual(self.service(APOCRYPHA, systemctl_show('apocrypha', exec_start))['MainPID'], '42')
        for show in [systemctl_show('root', exec_start),
                     systemctl_show('apocrypha', ['/usr/bin/node', '/srv/apocrypha/src/other.js']),
                     systemctl_show('apocrypha', exec_start, directory='/tmp')]:
            with self.subTest(show=show), self.assertRaises(helper.DeploymentError) as caught:
                self.service(APOCRYPHA, show)
            self.assertEqual(caught.exception.code, 'SERVICE_CONFIGURATION_CHANGED')

    def test_discord_default_contract_is_unchanged(self):
        deployment = helper.Deployment()
        deployment._trusted_path = lambda path, **kwargs: None
        for user in ('', 'root'):
            deployment._run = lambda argv, user=user, **kwargs: systemctl_show(user, ['/usr/bin/node', 'bot.js'], '/opt/podcast-discord')
            self.assertEqual(deployment._service()['MainPID'], '42')
        deployment._run = lambda argv, **kwargs: systemctl_show('apocrypha', ['/usr/bin/node', 'bot.js'], '/opt/podcast-discord')
        with self.assertRaises(helper.DeploymentError):
            deployment._service()

    def test_entrypoint_contract_is_required_and_validated(self):
        missing = {key: value for key, value in APOCRYPHA.items() if key != 'execStart'}
        for spec in [missing, {**APOCRYPHA, 'execStart': ['node', 'x.js']}, {**APOCRYPHA, 'execStart': ['/usr/bin/node', 'a b']},
                     {**APOCRYPHA, 'execStart': []}, {**APOCRYPHA, 'user': 'Root;'}]:
            with self.subTest(spec=spec), self.assertRaises(helper.DeploymentError):
                helper.validate_target('apocrypha', spec)


if __name__ == '__main__':
    unittest.main()
