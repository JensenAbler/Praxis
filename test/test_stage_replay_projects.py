"""Bootstrap helper validation only; never exports source or changes host config."""
import copy
import hashlib
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import stat
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'stage-replay-projects.py'
SPEC = importlib.util.spec_from_file_location('stage_replay_projects', SCRIPT)
STAGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(STAGE)


class StageReplayProjectsTest(unittest.TestCase):
    def catalog(self):
        return {'cases': [{'id': case_id, 'baseCommit': 'a' * 40, 'referenceCommit': 'b' * 40,
                           'promptSha256': 'c' * 64, 'promptIncluded': False,
                           'promptEncoding': 'UTF-8, LF, final newline'} for case_id in STAGE.BUNDLES]}

    def test_fixed_batch_requires_all_cases_with_unique_bounded_identities(self):
        catalog = self.catalog()
        self.assertEqual(list(STAGE.selected_entries(catalog)), list(STAGE.BUNDLES))
        duplicate = copy.deepcopy(catalog)
        duplicate['cases'].append(duplicate['cases'][0])
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            STAGE.selected_entries(duplicate)
        for field, value in [('baseCommit', '--help'), ('promptSha256', 'x' * 64), ('promptIncluded', True)]:
            changed = copy.deepcopy(catalog)
            changed['cases'][0][field] = value
            with self.assertRaises(ValueError):
                STAGE.selected_entries(changed)
        with self.assertRaisesRegex(ValueError, 'missing'):
            STAGE.selected_entries({'cases': catalog['cases'][:-1]})

    def test_prompt_validation_rejects_hash_changes_bare_cr_and_oversized_input(self):
        content = b'Synthetic task\n'
        digest = hashlib.sha256(content).hexdigest()
        self.assertEqual(STAGE.verified_prompt(content, digest), content.decode())
        for bad in [b'Synthetic task\r\n', b'Synthetic\rtask\n', b'Changed task\n', b'a' * 65537]:
            with self.assertRaises(ValueError):
                STAGE.verified_prompt(bad, digest)

    def test_export_receipt_cannot_redirect_snapshot_or_revision(self):
        project, revision = 'discord-replay-buffer-settling', 'a' * 40
        expected = STAGE.PROJECT_ROOT / project / revision
        valid = {'projectId': project, 'revision': revision, 'snapshotPath': str(expected),
                 'sourceDigest': 'b' * 64, 'fileCount': 3, 'bytes': 100}
        self.assertEqual(STAGE.validate_export(valid, project, revision), expected)
        for field, value in [('snapshotPath', '/etc'), ('revision', 'c' * 40), ('fileCount', 0), ('bytes', True)]:
            with self.assertRaises(ValueError):
                STAGE.validate_export({**valid, field: value}, project, revision)

    def test_protected_input_rejects_writable_or_symlinked_parent(self):
        path = Path('/trusted/release/scripts/export-project.py').absolute()
        parent = path.parent
        normal = SimpleNamespace(st_uid=0, st_mode=stat.S_IFREG | 0o644)
        for unsafe in [stat.S_IFDIR | 0o775, stat.S_IFLNK | 0o777]:
            def lstat(item):
                return SimpleNamespace(st_uid=0, st_mode=unsafe) if item == parent else normal
            with patch.object(type(path), 'lstat', lstat):
                with self.assertRaisesRegex(ValueError, 'writable ancestors'):
                    STAGE.protected(path)


if __name__ == '__main__':
    unittest.main()
