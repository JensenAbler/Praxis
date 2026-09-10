"""Fixed new-project deployer fixtures: no real services, nginx or candidate execution."""
import hashlib
import errno
import io
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import subprocess
import tarfile
import unittest
from unittest.mock import patch
import uuid

SPEC = importlib.util.spec_from_file_location('deploy_project', Path(__file__).resolve().parents[1] / 'deploy/deploy-project.py')
deployment = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deployment)
PROJECT = 'p-0123456789abcdef-example'
HEAD = 'a' * 40


class Crash(BaseException):
    pass


class FixtureDeployment(deployment.ProjectDeployment):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs, grace_seconds=0, ready_seconds=0)
        self.invocations = {}
        self.commands = []
        self.restart_count = 0
        self.reload_count = 0
        self.crash_phase = None
        self.crash_after_restart = False
        self.crash_after_reload = False
        self.health_fails = False
        self.nginx_fails = False

    def _service(self, project_id):
        invocation = self.invocations.get(project_id, '')
        return {'LoadState': 'loaded' if invocation else 'not-found',
                'ActiveState': 'active' if invocation else 'inactive', 'SubState': 'running' if invocation else 'dead',
                'MainPID': '123' if invocation else '0', 'InvocationID': invocation, 'NRestarts': '0'}

    def _run(self, argv, timeout=60):
        self.commands.append(argv)
        if argv[:2] == ['/usr/bin/systemctl', 'restart']:
            self.restart_count += 1
            project = argv[2].removeprefix('praxis-app-').removesuffix('.service')
            self.invocations[project] = str(self.restart_count)
            if self.crash_after_restart:
                self.crash_after_restart = False
                raise Crash()
        if argv == ['/usr/sbin/nginx', '-t'] and self.nginx_fails:
            raise deployment.ProjectDeploymentError('COMMAND_FAILED', 'fixture validation failure', 1)
        if argv == ['/usr/bin/systemctl', 'reload', 'nginx']:
            self.reload_count += 1
            if self.crash_after_reload:
                self.crash_after_reload = False
                raise Crash()
        return b''

    def _health(self, record, public=False):
        if self.health_fails or public and not (self.routes / (record['projectId'] + '.conf')).exists():
            raise deployment.ProjectDeploymentError('COMMAND_FAILED', 'fixture health failure', 1)

    def _save(self, record, phase=None, **values):
        result = super()._save(record, phase, **values)
        if self.crash_phase is not None and phase == self.crash_phase:
            self.crash_phase = None
            raise Crash()
        return result


@unittest.skipUnless(deployment.fcntl is not None, 'Linux flock fixture')
class ProjectTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='praxis-project-deploy-')
        self.root = Path(self.temp.name)
        paths = {name: self.root / name for name in ('state', 'applications', 'exports', 'units', 'routes')}
        for path in paths.values():
            path.mkdir(mode=0o755)
        self.worker = FixtureDeployment(**paths, expected_uid=os.getuid(), export_uid=os.getuid())

    def tearDown(self):
        self.temp.cleanup()

    def request(self, project=PROJECT, commit=HEAD, expected=None, runtime='node', files=None):
        export = str(uuid.uuid4())
        root = self.worker.exports / export
        (root / 'files').mkdir(parents=True)
        if files is None:
            files = {'node': {'server.js': 'throw new Error("must never execute as helper");\n',
                              'package.json': '{"name":"fixture","type":"module"}\n'},
                     'python': {'app.py': 'raise Exception("must never execute as helper")\n'},
                     'static': {'index.html': '<h1>Example</h1>\n', 'healthz': '{"ok":true}\n'}}[runtime]
        entries = {}
        for name, content in sorted(files.items()):
            destination = root / 'files' / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            data = content.encode()
            destination.write_bytes(data)
            entries[name] = {'kind': 'file', 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data), 'mode': '100644'}
        revision = hashlib.sha256(json.dumps(entries, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
        (root / 'manifest.json').write_text(json.dumps({'version': 1, 'projectId': project, 'commit': commit,
                                                      'revision': revision, 'entries': entries}))
        return {'action': 'apply', 'projectId': project, 'operationId': str(uuid.uuid4()), 'exportId': export,
                'targetCommit': commit, 'expectedHead': expected, 'runtime': runtime}

    def test_new_project_stages_exact_source_and_runs_only_fixed_unprivileged_unit(self):
        request = self.request()
        result = self.worker.handle(request)
        self.assertEqual(result['phase'], 'completed', result)
        self.assertEqual(self.worker._head(PROJECT), HEAD)
        self.assertEqual(self.worker.restart_count, 1)
        self.assertEqual(self.worker.reload_count, 1)
        unit = (self.worker.units / self.worker._service_name(PROJECT)).read_text()
        for setting in ('DynamicUser=yes', 'NoNewPrivileges=yes', 'ProtectSystem=strict', 'MemoryMax=256M',
                        'CPUQuota=25%', 'SocketBindDeny=any', 'ExecStart=/usr/bin/node server.js',
                        'TemporaryFileSystem=/tmp:rw,size=64M,mode=1777 /var/tmp:rw,size=16M,mode=1777'):
            self.assertIn(setting, unit)
        self.assertNotIn('StateDirectory=', unit)
        self.assertFalse(any(command[0] in ('/usr/bin/node', '/usr/bin/python3', '/bin/sh') for command in self.worker.commands))
        self.assertEqual(self.worker.handle(request)['phase'], 'completed')
        self.assertEqual(self.worker.restart_count, 1)
        self.assertEqual(self.worker.reload_count, 1)
        self.assertEqual(result['url'], deployment.PUBLIC_ORIGIN + '/apps/' + PROJECT + '/')

    def test_update_retains_previous_release_and_requires_exact_head(self):
        self.worker.handle(self.request())
        request = self.request(commit='b' * 40, expected=HEAD)
        result = self.worker.handle(request)
        self.assertEqual(result['phase'], 'completed')
        self.assertTrue((self.worker.applications / PROJECT / 'releases' / HEAD / 'files/server.js').exists())
        stale = self.worker.handle(self.request(commit='c' * 40, expected=HEAD))
        self.assertEqual(stale['error']['code'], 'DEPLOYMENT_CONFLICT')
        self.assertEqual(self.worker._head(PROJECT), 'b' * 40)

    def test_pre_restart_crashes_resume_only_proven_no_restart_effect(self):
        for phase in ('activation_intent', 'activated'):
            project = PROJECT + '-' + phase.replace('_', '-')[:15]
            request = self.request(project=project)
            self.worker.crash_phase = phase
            with self.assertRaises(Crash):
                self.worker.handle(request)
            result = self.worker.handle(request)
            self.assertEqual(result['phase'], 'completed', result)

    def test_restart_intent_without_observation_stays_uncertain_and_never_repeats(self):
        request = self.request()
        self.worker.crash_phase = 'restart_intent'
        with self.assertRaises(Crash):
            self.worker.handle(request)
        result = self.worker.handle(request)
        self.assertEqual(result['phase'], 'uncertain')
        self.assertEqual(self.worker.restart_count, 0)
        self.worker.handle(request)
        self.assertEqual(self.worker.restart_count, 0)

    def test_lost_restart_result_is_recovered_then_route_finishes(self):
        request = self.request()
        self.worker.crash_after_restart = True
        with self.assertRaises(Crash):
            self.worker.handle(request)
        result = self.worker.handle(request)
        self.assertEqual(result['phase'], 'completed')
        self.assertEqual(self.worker.restart_count, 1)
        self.assertEqual(self.worker.reload_count, 1)

    def test_lost_reload_result_is_observed_without_another_reload(self):
        request = self.request()
        self.worker.crash_after_reload = True
        with self.assertRaises(Crash):
            self.worker.handle(request)
        result = self.worker.handle({'action': 'status', 'projectId': PROJECT, 'operationId': request['operationId']})
        self.assertEqual(result['phase'], 'completed')
        self.assertEqual(self.worker.reload_count, 1)

    def test_invalid_nginx_config_restores_new_include_and_does_not_reload(self):
        request = self.request()
        self.worker.nginx_fails = True
        result = self.worker.handle(request)
        self.assertEqual(result['phase'], 'failed')
        self.assertEqual(result['error']['code'], 'ROUTE_VALIDATION_FAILED')
        self.assertFalse((self.worker.routes / (PROJECT + '.conf')).exists())
        self.assertEqual(self.worker.reload_count, 0)

    def test_source_hash_and_manifest_identity_are_verified_before_activation(self):
        request = self.request()
        (self.worker.exports / request['exportId'] / 'files/server.js').write_text('different length')
        result = self.worker.handle(request)
        self.assertEqual(result['error']['code'], 'SOURCE_UNTRUSTED')
        self.assertIsNone(self.worker._head(PROJECT))
        self.assertEqual(self.worker.restart_count, 0)

    def test_source_symlinks_and_credentials_are_rejected(self):
        request = self.request()
        source = self.worker.exports / request['exportId'] / 'files/server.js'
        source.unlink()
        source.symlink_to('/etc/passwd')
        result = self.worker.handle(request)
        self.assertEqual(result['phase'], 'failed')
        self.assertEqual(result['error']['code'], 'DEPLOYMENT_IO_FAILED')
        self.assertIsNone(self.worker._head(PROJECT))
        request = self.request(project=PROJECT + '-env', files={'server.js': '//server', '.env': 'SECRET=private'})
        result = self.worker.handle(request)
        self.assertEqual(result['error']['code'], 'SOURCE_INVALID')

    def test_missing_dependency_artifact_and_runtime_changes_are_rejected(self):
        request = self.request(files={'server.js': '//server', 'package.json': '{"dependencies":{"example":"1.0.0"}}'})
        result = self.worker.handle(request)
        self.assertEqual(result['error']['code'], 'DEPENDENCIES_REQUIRED')
        self.assertEqual(self.worker.restart_count, 0)
        request = self.request(project=PROJECT + '-py', runtime='python')
        self.assertEqual(self.worker.handle(request)['phase'], 'completed')
        changed = self.worker.handle(self.request(project=PROJECT + '-py', runtime='node', expected=HEAD, commit='b' * 40))
        self.assertEqual(changed['error']['code'], 'RUNTIME_MISMATCH')

    def test_static_runtime_uses_fixed_isolated_standard_library_server(self):
        self.assertEqual(self.worker.handle(self.request(runtime='static'))['phase'], 'completed')
        unit = (self.worker.units / self.worker._service_name(PROJECT)).read_text()
        self.assertIn('/usr/bin/python3 -I -m http.server 18700 --bind 127.0.0.1', unit)

    def test_private_broker_umask_does_not_hide_source_from_dynamic_runtime_user(self):
        request = self.request(files={'server.js': '//server', 'assets/site.css': 'body {}'})
        previous = os.umask(0o077)
        try:
            self.assertEqual(self.worker.handle(request)['phase'], 'completed')
        finally:
            os.umask(previous)
        app = self.worker.applications / PROJECT
        files = app / 'releases' / HEAD / 'files'
        for directory in (app, app / 'releases', files.parent, files, files / 'assets'):
            self.assertEqual(directory.stat().st_mode & 0o777, 0o755)
        self.assertEqual((files / 'server.js').stat().st_mode & 0o777, 0o644)
        self.assertEqual((self.worker.units / self.worker._service_name(PROJECT)).stat().st_mode & 0o777, 0o644)

    def test_five_app_limit_and_unique_fixed_ports(self):
        ports = []
        for index in range(5):
            result = self.worker.handle(self.request(project=PROJECT + '-' + str(index)))
            self.assertEqual(result['phase'], 'completed')
            ports.append(result['port'])
        self.assertEqual(ports, list(range(18700, 18705)))
        rejected = self.worker.handle(self.request(project=PROJECT + '-six'))
        self.assertEqual(rejected['error']['code'], 'APP_LIMIT')
        self.assertEqual(self.worker.restart_count, 5)

    def test_failed_first_readiness_allows_explicit_repaired_deployment(self):
        initial = self.request()
        self.worker.health_fails = True
        result = self.worker.handle(initial)
        self.assertEqual(result['phase'], 'uncertain')
        self.assertEqual(self.worker._head(PROJECT), HEAD)
        repaired = self.request(commit='b' * 40, expected=HEAD)
        repaired['recoverOperationId'] = initial['operationId']
        self.worker.health_fails = False
        result = self.worker.handle(repaired)
        self.assertEqual(result['phase'], 'completed', result)
        original = self.worker.handle({'action': 'status', 'projectId': PROJECT, 'operationId': initial['operationId']})
        self.assertEqual(original['phase'], 'uncertain')
        self.assertEqual(original['resolvedBy'], repaired['operationId'])
        self.assertEqual(self.worker.restart_count, 2)
        self.worker.handle(repaired)
        self.assertEqual(self.worker.restart_count, 2)

    def test_uncertain_health_observation_can_recover_when_original_invocation_becomes_ready(self):
        request = self.request()
        self.worker.health_fails = True
        self.assertEqual(self.worker.handle(request)['phase'], 'uncertain')
        self.worker.health_fails = False
        observed = self.worker.handle({'action': 'status', 'projectId': PROJECT, 'operationId': request['operationId']})
        self.assertEqual(observed['phase'], 'service_ready')
        self.assertEqual(self.worker.restart_count, 1)
        self.assertEqual(self.worker.reload_count, 0)
        self.assertEqual(self.worker.handle(request)['phase'], 'completed')
        self.assertEqual(self.worker.restart_count, 1)

    def test_retained_release_budget_blocks_before_service_activation(self):
        app = self.worker.applications / PROJECT
        app.mkdir()
        with (app / 'retained-sparse-fixture').open('wb') as out:
            out.truncate(2 * 1024 * 1024 * 1024)
        result = self.worker.handle(self.request())
        self.assertEqual(result['error']['code'], 'RELEASE_STORAGE_LIMIT')
        self.assertEqual(self.worker.restart_count, 0)

    def test_prepared_node_dependency_adapter_remains_readable_under_private_umask(self):
        module_path = Path(__file__).resolve().parents[1] / 'deploy/deploy-discord.py'
        spec = importlib.util.spec_from_file_location('discord_dependency_fixture', module_path)
        shared = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(shared)
        directory = self.root / 'dependencies'
        directory.mkdir()
        self.worker.dependency_adapter = lambda **kwargs: shared.Deployment(**kwargs, dependencies=directory, dependency_uid=os.getuid())
        package = '{"name":"example","dependencies":{"example":"1.0.0"}}'
        lock = '{"lockfileVersion":3}'
        request = self.request(files={'server.js': '//server', 'package.json': package, 'package-lock.json': lock})
        memory = io.BytesIO()
        with tarfile.open(fileobj=memory, mode='w') as archive:
            info = tarfile.TarInfo('node_modules/example/index.js')
            content = b'export default 1;'
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
        data = memory.getvalue()
        artifact = hashlib.sha256(data).hexdigest()
        (directory / (artifact + '.tar')).write_bytes(data)
        node = subprocess.check_output(['/usr/bin/node', '--version']).decode().strip().lstrip('v').split('.')[0]
        (directory / (artifact + '.json')).write_text(json.dumps({'version': 1, 'archiveSha256': artifact,
            'packageJsonSha256': hashlib.sha256(package.encode()).hexdigest(),
            'packageLockSha256': hashlib.sha256(lock.encode()).hexdigest(), 'shrinkwrapSha256': None,
            'platform': 'linux', 'arch': 'x64', 'nodeMajor': int(node)}))
        request['preparedDependenciesId'] = artifact
        rename = os.rename
        renamed = []

        def mounted_rename(source, destination):
            source, destination = Path(source), Path(destination)
            if source.is_relative_to(self.worker.state) != destination.is_relative_to(self.worker.state):
                raise OSError(errno.EXDEV, 'fixture: distinct journal and application bind mounts')
            renamed.append((source, destination))
            return rename(source, destination)

        previous = os.umask(0o077)
        try:
            with patch.object(deployment.os, 'rename', side_effect=mounted_rename):
                result = self.worker.handle(request)
        finally:
            os.umask(previous)
        self.assertEqual(result['phase'], 'completed', result)
        modules = self.worker.applications / PROJECT / 'releases' / HEAD / 'files/node_modules'
        self.assertEqual(modules.stat().st_mode & 0o777, 0o755)
        self.assertEqual((modules / 'example').stat().st_mode & 0o777, 0o755)
        self.assertEqual((modules / 'example/index.js').stat().st_mode & 0o777, 0o644)
        self.assertEqual(len(renamed), 2)
        self.assertTrue(all(source.is_relative_to(self.worker.applications) and destination.is_relative_to(self.worker.applications)
                            for source, destination in renamed))
        private = modules.parent.parent / '.dependency-state'
        self.assertEqual(private.stat().st_mode & 0o777, 0o700)
        self.assertTrue((private / (request['operationId'] + '.dependencies') / 'ready.json').is_file())
        self.assertFalse((self.worker.state / (request['operationId'] + '.dependencies')).exists())


class ValidationTests(unittest.TestCase):
    def test_generated_units_mask_protected_host_data_without_hiding_app_source(self):
        worker = deployment.ProjectDeployment()
        required = {
            '/opt', '/etc/letsencrypt', '/srv/apocrypha',
            *('/etc/' + name for name in ('praxis-code', 'praxis-control', 'praxis-git', 'praxis-probe', 'praxis-updater')),
            *('/var/lib/' + name for name in ('praxis-bootstrap', 'praxis-code', 'praxis-code-disk', 'praxis-control',
                                             'praxis-deploy', 'praxis-git', 'praxis-probe', 'praxis-stage', 'praxis-updater')),
            *('/srv/' + name for name in ('praxis-app', 'praxis-code', 'praxis-control', 'praxis-git-exchange',
                                         'praxis-probe', 'praxis-qualification', 'praxis-qualified', 'praxis-stage')),
            *('/run/' + name for name in ('praxis-code', 'praxis-control', 'praxis-dependencies', 'praxis-git',
                                         'praxis-registry', 'praxis-registry-relay')),
        }
        for runtime in ('node', 'python', 'static'):
            unit = worker._unit({'projectId': PROJECT, 'port': 18700, 'runtime': runtime}).decode()
            masks = [path for line in unit.splitlines() if line.startswith('InaccessiblePaths=')
                     for path in line.split('=', 1)[1].split()]
            self.assertTrue(all(path.startswith('-/') for path in masks))
            self.assertTrue(required.issubset({path[1:] for path in masks}))
            current = '/srv/praxis-apps/' + PROJECT + '/current'
            self.assertFalse(any(current == path[1:] or current.startswith(path[1:] + '/') for path in masks))
            self.assertIn('WorkingDirectory=', unit)

    def test_no_arbitrary_project_paths_commands_domains_or_env(self):
        for name in ('command', 'path', 'unit', 'domain', 'environment', 'port'):
            with self.assertRaises(deployment.ProjectDeploymentError):
                deployment.validate({'action': 'status', 'projectId': PROJECT, name: 'arbitrary'})
        for project in ('../escape', 'p-' + 'a' * 16 + '-../../x', PROJECT + '%n', 'podcast-discord'):
            with self.assertRaises(deployment.ProjectDeploymentError):
                deployment.validate({'action': 'status', 'projectId': project})


if __name__ == '__main__':
    unittest.main()
