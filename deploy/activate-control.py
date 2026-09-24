#!/usr/bin/python3
"""Promote the live, qualified application release to the control slot.

Usage (root): activate-control.py APP_RELEASE_NAME

The gateway, Claude facade and Git broker run from /srv/praxis-control/current,
which routine releases never touch. This copies the application release that
is currently live (so it already passed the updater's npm test, authenticated
MCP and manifest checks), swaps the control symlink atomically, restarts the
three control services, and verifies each one. Any failed check restores the
previous control release, label and services. Nothing is repeated on retry
unless the owner runs it again; every attempt is journaled.
"""
import json
import os
import pathlib
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass

SERVICES = ['praxis-git', 'praxis-probe', 'praxis-claude-facade']


@dataclass
class Paths:
    app_releases: pathlib.Path = pathlib.Path('/srv/praxis-app/releases')
    app_current: pathlib.Path = pathlib.Path('/srv/praxis-app/current')
    control_releases: pathlib.Path = pathlib.Path('/srv/praxis-control/releases')
    control_current: pathlib.Path = pathlib.Path('/srv/praxis-control/current')
    control_env: pathlib.Path = pathlib.Path('/etc/praxis-updater/control.env')
    git_config: pathlib.Path = pathlib.Path('/etc/praxis-git/config.json')
    updater_config: pathlib.Path = pathlib.Path('/etc/praxis-updater/config.json')
    journal: pathlib.Path = pathlib.Path('/var/lib/praxis-control/control-history.jsonl')


def check(value, message):
    if not value: raise RuntimeError(message)


def atomic_write(path, text):
    info = path.stat()
    temporary = path.with_name('.' + path.name + '.next')
    temporary.write_text(text)
    os.chmod(temporary, info.st_mode & 0o7777)
    os.chown(temporary, info.st_uid, info.st_gid)
    os.replace(temporary, path)


def point(link, target):
    temporary = link.with_name(link.name + '.next')
    if temporary.is_symlink() or temporary.exists(): temporary.unlink()
    temporary.symlink_to(target)
    os.replace(temporary, link)


def http_json(url, host=None):
    request = urllib.request.Request(url, headers={'Host': host} if host else {})
    with urllib.request.urlopen(request, timeout=5) as response: return json.load(response)


def default_health(label):
    """Each control service answers with the expected release before success."""
    git = http_json('http://127.0.0.1:8793/healthz')
    facade = http_json('http://127.0.0.1:8791/healthz')
    gateway = http_json('http://127.0.0.1:8790/praxis/healthz', host='mcp.jensenabler.com')
    check(git.get('ok') and git.get('release') == label, 'Git broker is not serving ' + label)
    check(facade.get('ok'), 'Claude facade health failed')
    check(gateway.get('name') == 'Praxis', 'Gateway health failed')
    return {'git': git.get('release'), 'facade': True, 'gateway': gateway.get('release')}


def ensure_idle(paths):
    """Never restart the broker under an in-flight Git or release operation."""
    config = json.loads(paths.updater_config.read_text())
    with sqlite3.connect('file:' + config['gitDatabase'] + '?mode=ro', uri=True, timeout=5) as db:
        busy = db.execute("SELECT COUNT(*) FROM git_operations WHERE status IN ('queued','running','uncertain')").fetchone()[0]
    check(busy == 0, f'{busy} Git operation(s) are in flight; wait for them to settle first.')


def activate(name, paths=Paths(), run=None, health=default_health, idle=ensure_idle, settle_seconds=30, sleep=time.sleep):
    run = run or (lambda argv: subprocess.run(argv, check=True, capture_output=True, text=True))
    source = paths.app_releases / name
    check(name.startswith('app-') and '/' not in name and source.is_dir(), 'Unknown application release: ' + name)
    check(paths.app_current.resolve() == source.resolve(), 'Only the live application release can be promoted; activate it through the updater first.')
    commit = name.split('-')[1] if name.count('-') >= 2 else name[4:]
    check(len(commit) == 12 and all(c in '0123456789abcdef' for c in commit), 'Release name does not carry a 12-hex commit.')
    label, target = 'control-' + commit, paths.control_releases / commit
    previous = paths.control_current.resolve()
    previous_env, previous_git = paths.control_env.read_text(), paths.git_config.read_text()
    record = {'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'appRelease': name, 'label': label,
              'previous': str(previous), 'target': str(target)}
    idle(paths)
    if not target.exists():
        staging = target.with_name('.' + commit + '.staging')
        if staging.exists(): shutil.rmtree(staging)
        shutil.copytree(source, staging, symlinks=True)
        for root, dirs, files in os.walk(staging):
            for entry in [root] + [os.path.join(root, item) for item in dirs + files]:
                os.lchown(entry, 0, 0)
                if not os.path.islink(entry): os.chmod(entry, os.stat(entry).st_mode & ~0o022)
        os.replace(staging, target)

    def switch(to, env, git):
        point(paths.control_current, to)
        atomic_write(paths.control_env, env)
        atomic_write(paths.git_config, git)
        for service in SERVICES: run(['systemctl', 'restart', service + '.service'])

    git_config = json.loads(previous_git)
    git_config['release'] = label
    env_lines = [line for line in previous_env.splitlines() if not line.startswith('PRAXIS_RELEASE=')] + ['PRAXIS_RELEASE=' + label]
    try:
        switch(target, '\n'.join(env_lines) + '\n', json.dumps(git_config, indent=2) + '\n')
        deadline, error = time.monotonic() + settle_seconds, None
        while True:
            try: record['health'] = health(label); break
            except Exception as failure:  # services may still be starting
                error = failure
                if time.monotonic() >= deadline: raise RuntimeError(f'Health did not pass: {error}')
                sleep(1)
        record['outcome'] = 'activated'
    except Exception as failure:
        record['outcome'], record['error'] = 'restored', str(failure)
        try:
            switch(previous, previous_env, previous_git)
            prior = next((line.split('=', 1)[1] for line in previous_env.splitlines() if line.startswith('PRAXIS_RELEASE=')), None)
            record['restoredHealth'] = health(prior)
        except Exception as restore_failure:
            record['outcome'], record['restoreError'] = 'restoration_failed', str(restore_failure)
        raise
    finally:
        paths.journal.parent.mkdir(parents=True, exist_ok=True)
        with paths.journal.open('a') as journal: journal.write(json.dumps(record) + '\n')
    return record


if __name__ == '__main__':
    check(len(sys.argv) == 2 and os.geteuid() == 0, __doc__)
    print(json.dumps(activate(sys.argv[1]), indent=2))
