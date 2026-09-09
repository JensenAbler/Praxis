#!/usr/bin/env python3
"""Bootstrap-only source exporter. Reads Git objects; never checks out or executes repository code."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tempfile

ROOT = Path('/srv/praxis-code/projects')
SKIP_DIRS = {'.git', '.ssh', '.aws', '.gnupg', 'node_modules', '__pycache__', '.venv', 'venv', '.cache', '.npm'}
SECRET = re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{50,}|\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{35,}')

def excluded(path):
    parts = PurePosixPath(path).parts
    return any(part in SKIP_DIRS or part == '.npmrc' or part == '.netrc' or part.startswith('.env')
               or re.search(r'^(?:secrets?|credentials)(?:\.|$)|\.(?:pem|key|p12|pfx|sqlite|db)(?:-|$)', part, re.I)
               for part in parts)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repository', required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--project', required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit('Source registration requires the independent bootstrap administrator.')
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', args.project) or not re.fullmatch(r'[a-f0-9]{40}', args.revision):
        raise SystemExit('Supply a fixed project ID and full commit SHA.')
    repo = Path(args.repository).resolve(strict=True)
    env = {'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0',
           'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_NO_LAZY_FETCH': '1', 'GIT_ALLOW_PROTOCOL': '', 'LC_ALL': 'C.UTF-8'}
    def git(*arguments):
        return subprocess.check_output(['/usr/bin/git', '--no-pager', '--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
                                        '-c', 'core.attributesFile=/dev/null', '-C', str(repo), *arguments], env=env, timeout=30)
    if git('rev-parse', '--verify', args.revision + '^{commit}').decode().strip() != args.revision:
        raise SystemExit('Revision did not resolve to the exact requested commit.')
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o755)
    if ROOT.is_symlink() or ROOT.stat().st_uid != 0 or ROOT.stat().st_mode & 0o022:
        raise SystemExit('Project registry root must be protected and root-owned.')
    parent = ROOT / args.project
    parent.mkdir(exist_ok=True, mode=0o755)
    if parent.is_symlink() or parent.stat().st_uid != 0 or parent.stat().st_mode & 0o022:
        raise SystemExit('Project directory must be protected and root-owned.')
    destination = parent / args.revision
    inventory_path = parent / (args.revision + '.json')
    if destination.exists():
        if destination.is_symlink() or not inventory_path.is_file():
            raise SystemExit('Existing export is incomplete or unsafe; inspect it independently.')
        print(inventory_path.read_text())
        return
    candidate = Path(tempfile.mkdtemp(prefix='.export-', dir=parent))
    rows, skipped, total = [], [], 0
    try:
        for item in git('ls-tree', '-r', '-l', '-z', args.revision).split(b'\0'):
            if not item:
                continue
            metadata, encoded_path = item.split(b'\t', 1)
            mode, kind, oid, size = metadata.split()
            path = encoded_path.decode('utf-8', 'strict')
            parts = PurePosixPath(path).parts
            if not parts or path.startswith('/') or '\\' in path or any(part in ('', '.', '..') for part in parts) or re.search(r'[\x00-\x1f\x7f]', path):
                raise ValueError('Unsafe tracked source path')
            if kind != b'blob' or mode not in (b'100644', b'100755') or excluded(path):
                skipped.append(path)
                continue
            length = int(size)
            total += length
            if len(rows) >= 20000 or length > 2097152 or total > 134217728:
                raise ValueError('Registered source exceeds the documented snapshot limits')
            content = git('cat-file', 'blob', oid.decode('ascii'))
            if len(content) != length:
                raise ValueError('Git blob size changed')
            if SECRET.search(content):
                raise ValueError('Credential-like content found in ' + path + '; inspect it privately before exporting')
            target = candidate.joinpath(*parts)
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            with target.open('xb') as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            target.chmod(0o555 if mode == b'100755' else 0o444)
            rows.append({'path': path, 'bytes': length, 'sha256': hashlib.sha256(content).hexdigest(), 'mode': mode.decode()})
        candidate.chmod(0o755)
        inventory = {'projectId': args.project, 'revision': args.revision, 'snapshotPath': str(destination),
                     'fileCount': len(rows), 'bytes': total, 'sourceDigest': hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest(),
                     'excludedCount': len(skipped), 'provenance': 'tracked Git blobs only; no live environment, Git metadata, hooks, or filters'}
        os.rename(candidate, destination)
        inventory_path.write_text(json.dumps(inventory, indent=2) + '\n')
        inventory_path.chmod(0o444)
        print(json.dumps(inventory))
    finally:
        if candidate.exists():
            if candidate.parent.resolve() != parent.resolve() or not candidate.name.startswith('.export-'):
                raise RuntimeError('Refusing cleanup outside the fixed export directory')
            shutil.rmtree(candidate)

if __name__ == '__main__':
    main()
