"""Exercise the updater's embedded hashing code against disposable fixtures."""
import ast
import base64
import contextlib
import hashlib
import json
from pathlib import Path
import re
import signal
import sqlite3
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest


SCRIPT = (Path(__file__).resolve().parents[1] / 'deploy' / 'update-coding-release.sh').read_text()


def embedded(marker):
    return re.split("<<'" + marker + "'[^\n]*\n", SCRIPT, maxsplit=1)[1].split('\n' + marker + '\n', 1)[0]


class ReleaseEvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Compile every Python block; importing privileged Linux-only modules is unnecessary.
        for marker in ('TREE_HASH', 'DEPENDENCY_LINKS', 'PREPARE', 'STATE_HELPER', 'NGINX_DRAIN', 'ROLLBACK_HEALTH', 'VERIFY_HEALTH', 'RECEIPT', 'COMMITTED'):
            compile(embedded(marker), marker, 'exec')
        function = next(node for node in ast.parse(embedded('STATE_HELPER')).body
                        if isinstance(node, ast.FunctionDef) and node.name == 'table_fingerprint')
        namespace = {'base64': base64, 'hashlib': hashlib, 'json': json}
        exec(compile(ast.Module(body=[function], type_ignores=[]), 'table_fingerprint', 'exec'), namespace)
        cls.fingerprint = staticmethod(namespace['table_fingerprint'])

    def stop_fixture(self, code_path, probe_path, run, git_path=None):
        functions = [node for node in ast.parse(embedded('STATE_HELPER')).body
                     if isinstance(node, ast.FunctionDef) and node.name in ('existing_tables', 'pending_code_git_requests', 'stop_idle_services')]
        namespace = {
            'pathlib': __import__('pathlib'), 'sqlite3': sqlite3, 'json': json,
            'contextlib': __import__('contextlib'),
            'DATABASES': {'coding': (str(code_path),), 'probe': (str(probe_path),)},
            'private_file': lambda *args, **kwargs: None,
            'state_snapshot': lambda: {'fixture': True},
            'signal': SimpleNamespace(SIGINT=signal.SIGINT, SIGTERM=signal.SIGTERM, signal=lambda *args: None),
            'subprocess': SimpleNamespace(run=run, check_output=lambda *args, **kwargs: 'inactive\n'),
        }
        if git_path is not None:
            namespace['DATABASES']['git'] = (str(git_path),)
        exec(compile(ast.Module(body=functions, type_ignores=[]), 'stop_idle_services', 'exec'), namespace)
        return namespace['stop_idle_services']

    def initialize_queues(self, code, probe):
        code.executescript('PRAGMA journal_mode=WAL; CREATE TABLE code_jobs(status TEXT); CREATE TABLE operations(status TEXT);')
        probe.executescript('PRAGMA journal_mode=WAL; CREATE TABLE jobs(status TEXT);')

    def test_admission_reservation_covers_both_service_shutdowns(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            code_path, probe_path = root / 'coding.sqlite', root / 'probe.sqlite'
            code, probe = sqlite3.connect(code_path), sqlite3.connect(probe_path)
            try:
                self.initialize_queues(code, probe)
                stopped = []

                def stop(command, **kwargs):
                    stopped.append(command[-1])
                    with contextlib.closing(sqlite3.connect(code_path, timeout=0, isolation_level=None)) as contender:
                        with self.assertRaisesRegex(sqlite3.OperationalError, 'locked'):
                            contender.execute('BEGIN IMMEDIATE')

                self.stop_fixture(code_path, probe_path, stop)(root / 'before.json')
                self.assertEqual(stopped, ['praxis-code.service', 'praxis-probe-worker.service'])
                self.assertEqual(json.loads((root / 'before.json').read_text()), {'fixture': True})
                code.execute('BEGIN IMMEDIATE')  # The reservation is released only afterward.
                code.rollback()
                self.assertEqual(code.execute('SELECT COUNT(*) FROM code_jobs').fetchone()[0], 0)
            finally:
                code.close()
                probe.close()

    def test_active_jobs_and_prepared_operations_prevent_shutdown(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            code_path, probe_path = root / 'coding.sqlite', root / 'probe.sqlite'
            code, probe = sqlite3.connect(code_path), sqlite3.connect(probe_path)
            try:
                self.initialize_queues(code, probe)
                stopped = []
                stop = self.stop_fixture(code_path, probe_path, lambda *args, **kwargs: stopped.append(args))
                for database, table, status in ((code, 'code_jobs', 'running'), (code, 'operations', 'prepared'), (probe, 'jobs', 'queued')):
                    database.execute(f'INSERT INTO {table} VALUES (?)', (status,))
                    database.commit()
                    with self.assertRaisesRegex(RuntimeError, 'Update rejected'):
                        stop(root / 'before.json')
                    self.assertEqual(stopped, [])
                    self.assertFalse((root / 'before.json').exists())
                    self.assertEqual(database.execute(f'SELECT status FROM {table}').fetchone()[0], status)
                    database.execute(f'DELETE FROM {table}')
                    database.commit()
            finally:
                code.close()
                probe.close()

    def test_git_admission_reservations_cover_broker_and_coding_shutdown(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            code_path, probe_path, git_path = root / 'coding.sqlite', root / 'probe.sqlite', root / 'git.sqlite'
            code, probe, git_db = sqlite3.connect(code_path), sqlite3.connect(probe_path), sqlite3.connect(git_path)
            try:
                self.initialize_queues(code, probe)
                git_db.executescript('PRAGMA journal_mode=WAL; CREATE TABLE git_operations(status TEXT);')
                stopped = []

                def stop(command, **kwargs):
                    stopped.append(command[-1])
                    for path in (code_path, git_path):
                        with contextlib.closing(sqlite3.connect(path, timeout=0, isolation_level=None)) as contender:
                            with self.assertRaisesRegex(sqlite3.OperationalError, 'locked'):
                                contender.execute('BEGIN IMMEDIATE')

                self.stop_fixture(code_path, probe_path, stop, git_path)(root / 'before.json')
                self.assertEqual(stopped, ['praxis-git.service', 'praxis-code.service', 'praxis-probe-worker.service'])
                for connection in (code, git_db):
                    connection.execute('BEGIN IMMEDIATE')
                    connection.rollback()
            finally:
                code.close(); probe.close(); git_db.close()

    def test_unfinished_broker_and_unintegrated_code_git_requests_prevent_shutdown(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            code_path, probe_path, git_path = root / 'coding.sqlite', root / 'probe.sqlite', root / 'git.sqlite'
            code, probe, git_db = sqlite3.connect(code_path), sqlite3.connect(probe_path), sqlite3.connect(git_path)
            try:
                self.initialize_queues(code, probe)
                code.execute('CREATE TABLE code_git_requests(receipt_json TEXT, integrated INTEGER, kind TEXT)')
                code.commit()
                git_db.executescript('PRAGMA journal_mode=WAL; CREATE TABLE git_operations(status TEXT);')
                stopped = []
                stop = self.stop_fixture(code_path, probe_path, lambda *a, **k: stopped.append(a), git_path)
                for status in ('queued', 'running', 'uncertain'):
                    git_db.execute('INSERT INTO git_operations VALUES (?)', (status,)); git_db.commit()
                    with self.assertRaisesRegex(RuntimeError, 'Update rejected'):
                        stop(root / 'before.json')
                    self.assertEqual(stopped, [])
                    git_db.execute('DELETE FROM git_operations'); git_db.commit()
                for status, integrated, kind in [('queued', 0, 'push'), ('uncertain', 0, 'deploy'), ('completed', 0, 'sync'), ('completed', 0, 'commit')]:
                    code.execute('INSERT INTO code_git_requests VALUES (?,?,?)', (json.dumps({'status': status}), integrated, kind)); code.commit()
                    with self.assertRaisesRegex(RuntimeError, 'pending coding Git requests'):
                        stop(root / 'before.json')
                    self.assertEqual(stopped, [])
                    code.execute('DELETE FROM code_git_requests'); code.commit()
            finally:
                code.close(); probe.close(); git_db.close()

    def snapshot_fixture(self, databases):
        functions = [node for node in ast.parse(embedded('STATE_HELPER')).body
                     if isinstance(node, ast.FunctionDef) and node.name in ('table_fingerprint', 'existing_tables', 'state_snapshot')]
        namespace = {'pathlib': __import__('pathlib'), 'sqlite3': sqlite3, 'json': json,
                     'contextlib': contextlib, 'hashlib': hashlib, 'base64': base64,
                     'DATABASES': databases, 'OPTIONAL_DATABASES': {'git'},
                     'private_file': lambda path, *a, **k: {'identity': str(path)},
                     'credential_fingerprint': lambda: 'oauth-key-hash', 'git_credential_fingerprint': lambda: 'git-key-hash'}
        exec(compile(ast.Module(body=functions, type_ignores=[]), 'state_snapshot', 'exec'), namespace)
        return namespace['state_snapshot']

    def test_existing_additive_tables_preserved_and_new_empty_git_database_allowed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            code_path, git_path = root / 'code.sqlite', root / 'git.sqlite'
            with contextlib.closing(sqlite3.connect(code_path)) as code:
                code.executescript('PRAGMA journal_mode=WAL; CREATE TABLE workspaces(id); CREATE TABLE code_tail_records(text); CREATE TABLE code_runner_lock(pid); CREATE TABLE worker_lock(pid); INSERT INTO code_tail_records VALUES ("retained tail");')
                code.commit()
                snapshot = self.snapshot_fixture({'coding': (str(code_path), 'fixture', ('workspaces',)), 'git': (str(git_path), 'fixture', ('git_operations',))})
                before = snapshot()
                self.assertIn('code_tail_records', before['databases']['coding']['tables'])
                self.assertNotIn('code_runner_lock', before['databases']['coding']['tables'])
                self.assertNotIn('worker_lock', before['databases']['coding']['tables'])
                with contextlib.closing(sqlite3.connect(git_path)) as git_db:
                    git_db.executescript('PRAGMA journal_mode=WAL; CREATE TABLE git_operations(status);')
                    code.execute('CREATE TABLE code_git_requests(id)'); code.commit()
                    self.assertEqual(snapshot(before), before)
                    git_db.execute('INSERT INTO git_operations VALUES ("queued")'); git_db.commit()
                    with self.assertRaisesRegex(RuntimeError, 'unexpected operation data'):
                        snapshot(before)
                    git_db.execute('DELETE FROM git_operations'); git_db.commit()
                    code.execute('UPDATE code_tail_records SET text="changed"'); code.commit()
                    self.assertNotEqual(snapshot(before), before)

    def test_existing_git_operation_rows_and_database_are_required_after_update(self):
        with tempfile.TemporaryDirectory() as temporary:
            git_path = Path(temporary) / 'git.sqlite'
            with contextlib.closing(sqlite3.connect(git_path)) as git_db:
                git_db.executescript('PRAGMA journal_mode=WAL; CREATE TABLE git_operations(id,status); INSERT INTO git_operations VALUES ("saved", "completed");')
                snapshot = self.snapshot_fixture({'git': (str(git_path), 'fixture', ('git_operations',))})
                before = snapshot()
                git_db.execute('ALTER TABLE git_operations ADD COLUMN additive TEXT'); git_db.commit()
                self.assertEqual(snapshot(before), before)
                git_db.execute('UPDATE git_operations SET status="failed"'); git_db.commit()
                self.assertNotEqual(snapshot(before), before)
            git_path.unlink()
            with self.assertRaisesRegex(RuntimeError, 'optional database disappeared'):
                snapshot(before)

    def test_prepare_preserves_optional_broker_configuration_except_release(self):
        for enabled in (False, True):
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                old = {'release': 'old', 'issuer': 'https://mcp.jensenabler.com/praxis/oauth',
                       'resourceUrl': 'https://mcp.jensenabler.com/praxis/mcp', 'dataDirectory': '/var/lib/praxis-code/live',
                       'fixture': {'unchanged': True}}
                (root / 'config.json').write_text(json.dumps(old))
                (root / 'release.env').write_text('PRAXIS_RELEASE=old\n')
                (root / 'nginx-snippet').write_text('    proxy_pass http://127.0.0.1:8790;\n' * 4)
                acceptance = {'release': 'new', 'treeSha256': 'tree-hash', 'npmTestPassed': True,
                              'authenticatedMcpPassed': True, 'sourceCommit': 'a' * 40, 'fixtureReceiptSha256': 'b' * 64}
                (root / 'acceptance.json').write_text(json.dumps(acceptance))
                if enabled:
                    old_git = {**old, 'dataDirectory': '/var/lib/praxis-git', 'port': 8793, 'repositories': [{'projectId': 'discord'}]}
                    (root / 'git-config.json').write_text(json.dumps(old_git))
                subprocess.check_call([sys.executable, '-c', embedded('PREPARE'), str(root), 'new', '/srv/praxis-probe/releases/old', 'tree-hash'])
                self.assertEqual(json.loads((root / 'config.next.json').read_text()), {**old, 'release': 'new'})
                if enabled:
                    self.assertEqual(json.loads((root / 'git-config.next.json').read_text()), {**old_git, 'release': 'new'})
                    self.assertEqual(json.loads((root / 'git-config.json').read_text()), old_git)
                else:
                    self.assertFalse((root / 'git-config.next.json').exists())

    def test_candidate_hash_excludes_only_top_level_dependencies(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'node_modules').mkdir()
            (root / 'src').mkdir()
            (root / 'src' / 'node_modules').mkdir()
            source = root / 'src' / 'answer.js'
            source.write_text('const answer = "🙂";\n', encoding='utf-8')
            lock = root / 'package-lock.json'
            lock.write_text('{"dependencies":"pinned"}\n')
            calculate = lambda: subprocess.check_output([sys.executable, '-c', embedded('TREE_HASH'), str(root)], text=True).strip()
            initial = calculate()
            self.assertRegex(initial, '^[0-9a-f]{64}$')
            (root / 'node_modules' / 'installed.js').write_text('Runtime dependencies are installed separately.')
            self.assertEqual(calculate(), initial)
            lock.write_text('{"dependencies":"changed"}\n')
            self.assertNotEqual(calculate(), initial)
            lock.write_text('{"dependencies":"pinned"}\n')
            self.assertEqual(calculate(), initial)
            (root / 'src' / 'node_modules' / 'source.txt').write_text('This nested source path is included.')
            self.assertNotEqual(calculate(), initial)

    def test_table_hash_preserves_original_columns_and_detects_row_changes(self):
        with sqlite3.connect(':memory:') as db:
            db.execute('CREATE TABLE jobs (id TEXT, data BLOB)')
            db.executemany('INSERT INTO jobs VALUES (?, ?)', [('first', b'\x00payload'), ('second', b'other')])
            initial = self.fingerprint(db, 'jobs')
            self.assertEqual(initial['rows'], 2)
            self.assertNotIn('payload', json.dumps(initial))
            db.execute('ALTER TABLE jobs ADD COLUMN additive TEXT DEFAULT "new"')
            db.execute('CREATE TABLE new_tail_records (id TEXT)')
            self.assertEqual(self.fingerprint(db, 'jobs', initial['columns']), initial)
            db.execute('UPDATE jobs SET data=? WHERE id=?', (b'changed', 'first'))
            self.assertNotEqual(self.fingerprint(db, 'jobs', initial['columns']), initial)
            db.execute('ALTER TABLE jobs RENAME COLUMN data TO renamed')
            with self.assertRaisesRegex(RuntimeError, 'original column is missing'):
                self.fingerprint(db, 'jobs', initial['columns'])

    def test_hash_is_row_order_independent_but_retains_types_and_duplicates(self):
        with sqlite3.connect(':memory:') as db:
            db.execute('CREATE TABLE records (value)')
            db.executemany('INSERT INTO records VALUES (?)', [('a',), (b'a',), (1,), ('1',)])
            initial = self.fingerprint(db, 'records')
            db.execute('DELETE FROM records')
            db.executemany('INSERT INTO records VALUES (?)', [('1',), (1,), (b'a',), ('a',)])
            self.assertEqual(self.fingerprint(db, 'records'), initial)
            db.execute('INSERT INTO records VALUES (?)', ('a',))
            self.assertNotEqual(self.fingerprint(db, 'records'), initial)


if __name__ == '__main__':
    unittest.main()
