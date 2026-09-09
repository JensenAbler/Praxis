import hashlib
import io
import json
import os
import posixpath
import stat
import subprocess
import sys
import tarfile

MAX_BYTES = 1024 * 1024 * 1024
MAX_FILES = 100000
MANIFESTS = {'packageJsonSha256': 'package.json', 'packageLockSha256': 'package-lock.json', 'shrinkwrapSha256': 'npm-shrinkwrap.json'}

def hashes():
    result = {}
    for key, path in MANIFESTS.items():
        if not os.path.lexists(path):
            result[key] = None
            continue
        value = os.lstat(path)
        if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_size > 2 * 1024 * 1024:
            raise ValueError('Unsafe dependency manifest')
        with open(path, 'rb') as handle:
            result[key] = hashlib.file_digest(handle, 'sha256').hexdigest()
    if not result['packageJsonSha256'] or not (result['packageLockSha256'] or result['shrinkwrapSha256']):
        raise ValueError('A package.json and npm lockfile are required')
    return result

before = hashes()
runtime = json.loads(subprocess.check_output(['node', '-e', 'console.log(JSON.stringify({platform:process.platform,arch:process.arch,nodeVersion:process.version,nodeMajor:Number(process.versions.node.split(".")[0])}))'], text=True))
provenance = json.dumps({**before, **runtime, 'image': sys.argv[1]}, sort_keys=True).encode()
if not os.path.isdir('node_modules') or os.path.islink('node_modules'):
    raise ValueError('Install node_modules in this workspace before preparation')
if os.path.lexists('.cache') and (not os.path.isdir('.cache') or os.path.islink('.cache')):
    raise ValueError('Unsafe cache directory')
os.makedirs('.cache', exist_ok=True)
archive = '.cache/praxis-dependencies.tar'
metadata = '.cache/praxis-dependencies.json'
for path in (archive, metadata):
    if os.path.lexists(path):
        value = os.lstat(path)
        if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1:
            raise ValueError('Unsafe existing preparation output')
        os.unlink(path)

total = 0
count = 0
with tarfile.open(archive, 'x', format=tarfile.USTAR_FORMAT, dereference=False) as output:
    def add(path):
        global total, count
        value = os.lstat(path)
        if path == 'node_modules/.praxis-preparation.json':
            raise ValueError('Reserved dependency provenance path already exists')
        count += 1
        if count > MAX_FILES or len(path.encode()) > 240 or '\\' in path or any(ord(char) < 32 for char in path):
            raise ValueError('Dependency entry limit or invalid name')
        if stat.S_ISREG(value.st_mode):
            total += value.st_size
            if value.st_nlink != 1 or value.st_size > 256 * 1024 * 1024 or total > MAX_BYTES:
                raise ValueError('Dependency size or hardlink limit')
        elif stat.S_ISLNK(value.st_mode):
            target = os.readlink(path)
            normalized = posixpath.normpath(posixpath.join(posixpath.dirname(path), target))
            resolved = os.path.realpath(path)
            root = os.path.realpath('node_modules')
            if target.startswith('/') or '\\' in target or any(ord(char) < 32 for char in target) or not normalized.startswith('node_modules/') or os.path.commonpath([root, resolved]) != root:
                raise ValueError('Dependency symlink escapes node_modules')
        elif not stat.S_ISDIR(value.st_mode):
            raise ValueError('Special dependency files are not allowed')
        info = output.gettarinfo(path, arcname=path)
        info.uid = info.gid = 0
        info.uname = info.gname = ''
        info.mtime = 0
        info.mode = 0o755 if info.isdir() or value.st_mode & 0o111 else 0o644
        if info.isfile():
            with open(path, 'rb') as data:
                output.addfile(info, data)
        else:
            output.addfile(info)
        if info.isdir():
            for entry in sorted(os.listdir(path)):
                add(path + '/' + entry)
    add('node_modules')
    info = tarfile.TarInfo('node_modules/.praxis-preparation.json')
    info.size = len(provenance)
    info.mode = 0o644
    output.addfile(info, io.BytesIO(provenance))
if os.path.getsize(archive) > 512 * 1024 * 1024:
    raise ValueError('Dependency archive exceeds 512 MiB')
if hashes() != before:
    raise ValueError('Dependency manifests changed during preparation')
with open(metadata, 'x') as handle:
    json.dump({**before, **runtime, 'files': count, 'expandedBytes': total}, handle)
print(json.dumps({'event': 'DEPENDENCIES_PREPARED', 'files': count, 'expandedBytes': total, **before, **runtime}))
