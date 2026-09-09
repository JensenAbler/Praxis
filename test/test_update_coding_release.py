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

    def stop_fixture(self, code_path, probe_path, run):
        function = next(node for node in ast.parse(embedded('STATE_HELPER')).body
                        if isinstance(node, ast.FunctionDef) and node.name == 'stop_idle_services')
        namespace = {
            'pathlib': __import__('pathlib'), 'sqlite3': sqlite3, 'json': json,
            'contextlib': __import__('contextlib'),
            'DATABASES': {'coding': (str(code_path),), 'probe': (str(probe_path),)},
            'private_file': lambda *args, **kwargs: None,
            'state_snapshot': lambda: {'fixture': True},
            'signal': SimpleNamespace(SIGINT=signal.SIGINT, SIGTERM=signal.SIGTERM, signal=lambda *args: None),
            'subprocess': SimpleNamespace(run=run, check_output=lambda *args, **kwargs: 'inactive\n'),
        }
        exec(compile(ast.Module(body=[function], type_ignores=[]), 'stop_idle_services', 'exec'), namespace)
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
