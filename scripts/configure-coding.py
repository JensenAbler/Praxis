#!/usr/bin/env python3
"""Write first-activation configuration from independently registered, immutable sources."""
import argparse
import grp
import json
import os
from pathlib import Path
import re
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--release', required=True)
parser.add_argument('--image', required=True)
parser.add_argument('--praxis-revision', required=True)
args = parser.parse_args()
if os.geteuid() != 0 or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]*', args.release):
    raise SystemExit('Use the independent bootstrap administrator and an exact release.')
if not re.fullmatch(r'sha256:[a-f0-9]{64}', args.image) or not re.fullmatch(r'[a-f0-9]{40}', args.praxis_revision):
    raise SystemExit('Exact image and source digests are required.')
target = Path('/etc/praxis-code/config.json')
if target.exists() or target.is_symlink():
    raise SystemExit('Configuration already exists; review an update rather than overwriting bootstrap state.')
base = 'https://mcp.jensenabler.com/praxis-probe'
with urllib.request.urlopen(base + '/oauth/jwks', timeout=15) as response:
    public_jwks = json.load(response)
if not public_jwks.get('keys') or any(key.get('kty') != 'RSA' or any(part in key for part in ('d', 'p', 'q', 'k')) for key in public_jwks['keys']):
    raise SystemExit('Expected public RSA verification keys only.')
revisions = {
    'discord': 'feef620f1958b24e2a0de50f28361a9d9e2db4ef',
    'production': '2b5c4273d3f7b249f8626a8575ba79fe0f66c339',
    'praxis': args.praxis_revision,
    'discord-replay-speech-first': '06fb2784454e3641960a1e1782a0c92a68a341b7',
}
repositories = {'discord': 'podcast-discord', 'production': 'podcast-production', 'praxis': 'Praxis', 'discord-replay-speech-first': 'podcast-discord'}
projects = []
for project_id, revision in revisions.items():
    inventory = json.loads((Path('/srv/praxis-code/projects') / project_id / (revision + '.json')).read_text())
    snapshot = Path(inventory['snapshotPath'])
    if inventory['revision'] != revision or snapshot.is_symlink() or snapshot.stat().st_uid != 0:
        raise SystemExit('Snapshot registration is not protected or does not match its revision.')
    if project_id == 'production':
        checks = [['python3', '-m', 'unittest', 'discover', '-s', 'tests']]
        instructions = 'Immutable source snapshot. Work in a new isolated workspace. No production deployment, publishing, network, or credentials are available. Python and ffmpeg are installed.'
    else:
        preparation = f'if [ ! -e node_modules ]; then ln -s /opt/praxis/deps/{project_id}/node_modules node_modules; fi'
        checks = [['bash', '-lc', 'set -e; ' + preparation + '; npm test']]
        instructions = ('Immutable source snapshot. Work in a new isolated workspace. Node, npm, Python, Git, ripgrep, and ffmpeg are installed. '
                        f'Read-only dependencies for this exact package lock are available at /opt/praxis/deps/{project_id}/node_modules. '
                        'Use the registered validation command to link them into the workspace before testing. General commands have no network or production credentials. '
                        'Require the test suite final summary as well as exit code; an unfinished Promise can let Node exit early.')
    if project_id == 'praxis':
        instructions += '\n\n' + (snapshot / 'AGENTS.md').read_text()
    if project_id == 'discord-replay-speech-first':
        instructions += ('\n\nThis is the speech-first replay case at its clean historical parent commit. Do not read a reference solution or deploy this task. '
                         'Live provider checks are excluded; report that limitation. Preserve the original task meaning below.\n\n'
                         + Path('/etc/praxis-code/tasks/speech-first.txt').read_text())
    projects.append({'id': project_id, 'name': project_id, 'repository': 'https://github.com/JensenAbler/' + repositories[project_id],
                     'revision': revision, 'snapshotPath': str(snapshot), 'validationCommands': checks, 'instructions': instructions})
config = {
    'issuer': base + '/oauth', 'resourceUrl': base + '/mcp', 'publicJwks': public_jwks,
    'dataDirectory': '/var/lib/praxis-code/live', 'workspaceDirectory': '/srv/praxis-code/storage/workspaces/live',
    'port': 8792, 'release': args.release, 'runtimeDescription': 'Node 22, npm, Python 3, Git, ripgrep, ffmpeg; pinned read-only dependency trees; no network',
    'projects': projects,
    'runnerConfig': {'image': args.image, 'workspaceRoot': '/srv/praxis-code/storage/workspaces/live',
                     'logDirectory': '/srv/praxis-code/storage/container-logs/live',
                     'storageRoot': '/srv/praxis-code/storage/containers', 'runRoot': '/run/praxis-code/storage',
                     'env': {'HOME': '/var/lib/praxis-code', 'XDG_RUNTIME_DIR': '/run/praxis-code', 'CONTAINERS_STORAGE_CONF': '/etc/praxis-code/storage.conf'}},
}
with target.open('x') as handle:
    json.dump(config, handle, indent=2)
    handle.write('\n')
    handle.flush()
    os.fsync(handle.fileno())
os.chown(target, 0, grp.getgrnam('praxis-code').gr_gid)
target.chmod(0o640)
print(json.dumps({'configured': True, 'release': args.release, 'image': args.image, 'projects': list(revisions), 'serviceStarted': False}))
