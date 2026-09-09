import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

PACKER = Path(__file__).resolve().parents[1] / 'src' / 'code' / 'dependency-pack.py'
IMAGE = 'sha256:' + 'b' * 64


class DependencyPack(unittest.TestCase):
    def fixture(self):
        directory = tempfile.TemporaryDirectory(prefix='praxis-deps-pack-')
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        (root / 'package.json').write_text('{"name":"fixture","version":"1.0.0"}')
        (root / 'package-lock.json').write_text('{"lockfileVersion":3,"packages":{}}')
        (root / 'node_modules' / 'fixture').mkdir(parents=True)
        (root / 'node_modules' / 'fixture' / 'index.js').write_text('module.exports = 42;')
        return root

    def run_pack(self, root):
        return subprocess.run([sys.executable, str(PACKER), IMAGE], cwd=root, capture_output=True, text=True)

    def test_package_tree_and_exact_manifest_provenance(self):
        root = self.fixture()
        result = self.run_pack(root)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('DEPENDENCIES_PREPARED', result.stdout)
        first = (root / '.cache' / 'praxis-dependencies.tar').read_bytes()
        with tarfile.open(fileobj=io.BytesIO(first)) as archive:
            members = archive.getmembers()
            self.assertTrue(all(member.name == 'node_modules' or member.name.startswith('node_modules/') for member in members))
            provenance = json.load(archive.extractfile('node_modules/.praxis-preparation.json'))
            self.assertEqual(provenance['image'], IMAGE)
            self.assertIsNotNone(provenance['packageLockSha256'])
        self.assertEqual(self.run_pack(root).returncode, 0)
        self.assertEqual(first, (root / '.cache' / 'praxis-dependencies.tar').read_bytes())
        (root / 'package.json').write_text('{"name":"fixture","version":"2.0.0"}')
        self.assertEqual(self.run_pack(root).returncode, 0)
        self.assertNotEqual(first, (root / '.cache' / 'praxis-dependencies.tar').read_bytes())

    def test_missing_lock_and_hardlinked_package_refused(self):
        root = self.fixture()
        (root / 'package-lock.json').unlink()
        self.assertNotEqual(self.run_pack(root).returncode, 0)
        (root / 'package-lock.json').write_text('{}')
        os.link(root / 'node_modules' / 'fixture' / 'index.js', root / 'node_modules' / 'fixture' / 'copy.js')
        self.assertNotEqual(self.run_pack(root).returncode, 0)

    def test_symlink_escape_refused_and_confined_bin_preserved(self):
        root = self.fixture()
        (root / 'node_modules' / '.bin').mkdir()
        link = root / 'node_modules' / '.bin' / 'fixture'
        try:
            link.symlink_to('../fixture/index.js')
        except OSError:
            self.skipTest('Host does not permit symlinks; Linux qualification must exercise.')
        self.assertEqual(self.run_pack(root).returncode, 0)
        with tarfile.open(root / '.cache' / 'praxis-dependencies.tar') as archive:
            self.assertTrue(archive.getmember('node_modules/.bin/fixture').issym())
        link.unlink()
        link.symlink_to('../../package.json')
        self.assertNotEqual(self.run_pack(root).returncode, 0)


if __name__ == '__main__':
    unittest.main()
