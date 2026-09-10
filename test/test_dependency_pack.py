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

    def run_pack(self, root, image=IMAGE):
        return subprocess.run([sys.executable, str(PACKER), image], cwd=root, capture_output=True, text=True)

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

    def test_missing_lock_refused_but_hardlinked_packages_are_independent_archive_files(self):
        root = self.fixture()
        (root / 'package-lock.json').unlink()
        self.assertNotEqual(self.run_pack(root).returncode, 0)
        (root / 'package-lock.json').write_text('{}')
        os.link(root / 'node_modules' / 'fixture' / 'index.js', root / 'node_modules' / 'fixture' / 'copy.js')
        for image in (IMAGE, 'native-root:linux:x64:fixture'):
            result = self.run_pack(root, image)
            self.assertEqual(result.returncode, 0, result.stderr)
            with tarfile.open(root / '.cache' / 'praxis-dependencies.tar') as archive:
                for name in ('index.js', 'copy.js'):
                    member = archive.getmember('node_modules/fixture/' + name)
                    self.assertTrue(member.isfile())
                    self.assertFalse(member.islnk())
                    self.assertEqual(archive.extractfile(member).read(), b'module.exports = 42;')

    def test_native_large_manifest_and_long_package_paths_keep_exact_provenance(self):
        root = self.fixture()
        (root / 'package-lock.json').write_text(json.dumps({'padding': 'x' * (3 * 1024 * 1024)}))
        nested = root / 'node_modules' / 'fixture'
        for number in range(5):
            nested /= ('long-package-component-' + str(number)) * 2
        nested.mkdir(parents=True)
        (nested / 'data.json').write_text('{}')
        self.assertNotEqual(self.run_pack(root).returncode, 0)
        identity = 'native-root:linux:x64:fixture'
        result = self.run_pack(root, identity)
        self.assertEqual(result.returncode, 0, result.stderr)
        metadata = json.loads((root / '.cache' / 'praxis-dependencies.json').read_text())
        self.assertEqual(metadata['executionMode'], 'native')
        self.assertEqual(metadata['executionIdentity'], identity)
        with tarfile.open(root / '.cache' / 'praxis-dependencies.tar') as archive:
            self.assertEqual(archive.extractfile((nested / 'data.json').relative_to(root).as_posix()).read(), b'{}')

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
