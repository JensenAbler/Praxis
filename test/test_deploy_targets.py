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
             'protectedPaths': ['/var/lib/apocrypha']}


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


if __name__ == '__main__':
    unittest.main()
