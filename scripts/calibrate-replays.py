#!/usr/bin/env python3
"""Bootstrap operator: calibrate trusted graders in the existing rootless sandbox.

This does not change the live release, register projects, or execute an agent.
Each historical revision is mounted alone; neither source nor prompts are printed.
An existing run directory is refused: inspect its units/results instead of rerunning.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid


def command(*args):
    return subprocess.check_output(args, text=True, timeout=45).strip()


def protected(path):
    path = Path(path)
    if path.is_symlink() or not path.exists():
        raise ValueError('Expected an existing protected path')
    for part in [path, *path.parents]:
        if part.stat().st_uid != 0 or part.stat().st_mode & 0o022:
            raise ValueError('Evaluator inputs must be root-owned and not group/world writable')
    return path.resolve(strict=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checker-root', required=True)
    parser.add_argument('--repository', default='/opt/podcast-discord')
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--case', action='append', required=True)
    args = parser.parse_args()
    if os.geteuid() != 0 or str(uuid.UUID(args.run_id)) != args.run_id:
        raise ValueError('Use the bootstrap administrator and a canonical UUID')
    checker = protected(args.checker_root)
    for path in [checker / 'scripts/eval-check.js', checker / 'scripts/export-project.py', checker / 'eval/catalog.json', *list((checker / 'eval/checkers').glob('*.js'))]:
        protected(path)
    catalog = json.loads((checker / 'eval/catalog.json').read_text())
    entries = [next(item for item in catalog['cases'] if item['id'] == key) for key in args.case]
    if len(set(args.case)) != len(args.case):
        raise ValueError('Duplicate cases are not allowed')
    for entry in entries:
        if not re.fullmatch(r'[a-z0-9-]{1,40}', entry['id']):
            raise ValueError('Invalid case ID')
        for key in ['baseCommit', 'referenceCommit']:
            if not re.fullmatch(r'[a-f0-9]{40}', entry[key]):
                raise ValueError('Require full immutable commits')
    config = json.loads(protected('/etc/praxis-code/config.json').read_text())
    image = config['runnerConfig']['image']
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', image):
        raise ValueError('Require the installed immutable image')
    root = Path('/root/praxis-replay-calibration') / args.run_id
    root.mkdir(parents=True, mode=0o700, exist_ok=False)
    template = protected('/etc/systemd/system/praxis-code.service').read_text()
    receipt = {
        'schemaVersion': 1, 'runId': args.run_id,
        'evidenceKind': 'historical-base-reference-calibration-in-rootless-containers',
        'agentRun': False, 'nativePhoneRun': False, 'liveServicesExercised': False,
        'release': config['release'], 'image': image,
        'checkerFilesSha256': {str(path.relative_to(checker)): hashlib.sha256(path.read_bytes()).hexdigest()
                               for path in [checker / 'scripts/eval-check.js', checker / 'scripts/export-project.py', checker / 'eval/catalog.json', *sorted((checker / 'eval/checkers').glob('*.js'))]},
        'isolation': {'network': 'none', 'candidateMount': 'read-only', 'checkerMount': 'read-only',
                      'credentialsMounted': False, 'memoryMax': '1536M', 'swapMax': 0, 'cpuQuota': '100%', 'tasksMax': 256},
        'status': 'running', 'cases': [],
    }
    def checkpoint():
        temporary = root / 'receipt.next.json'
        temporary.write_text(json.dumps(receipt, indent=2) + '\n')
        os.replace(temporary, root / 'receipt.json')
    checkpoint()
    for entry in entries:
        item = {'caseId': entry['id'], 'promptSha256': entry['promptSha256'], 'revisions': []}
        receipt['cases'].append(item)
        for role, key in [('base', 'baseCommit'), ('reference', 'referenceCommit')]:
            revision = entry[key]
            exported = json.loads(command('python3', str(checker / 'scripts/export-project.py'),
                                          '--repository', args.repository, '--revision', revision,
                                          '--project', 'cal-' + entry['id'] + '-' + role))
            source = protected(exported['snapshotPath'])
            token = f'{args.run_id}-{entry["id"]}-{role}'
            unit = 'praxis-replay-' + token + '.service'
            output, errors = root / (entry['id'] + '-' + role + '.json'), root / (entry['id'] + '-' + role + '.stderr')
            argv = ['/usr/bin/podman', '--root', '/srv/praxis-code/storage/containers', '--runroot', '/run/praxis-code/storage',
                    '--cgroup-manager=cgroupfs', '--runtime=/usr/bin/crun', '--events-backend=none', 'run',
                    '--name', 'praxis-cal-' + token, '--pull=never', '--network=none', '--cgroups=disabled', '--read-only',
                    '--read-only-tmpfs=false', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--image-volume=ignore',
                    '--http-proxy=false', '--systemd=false', '--userns=keep-id', '--pids-limit=-1', '--timeout=30', '--stop-timeout=2',
                    '--log-driver=none', '--shm-size=16m', '--tmpfs', '/tmp:rw,nosuid,nodev,size=67108864,mode=1777',
                    '--mount', f'type=bind,src={source},dst=/candidate,ro', '--mount', f'type=bind,src={checker},dst=/checker,ro',
                    '--workdir', '/candidate', '--env', 'HOME=/tmp', '--env', 'TMPDIR=/tmp', '--env', 'LANG=C.UTF-8',
                    '--entrypoint=', image, 'node', '/checker/scripts/eval-check.js', '--workspace', '/candidate', '--case', entry['id']]
            # All strings passed into systemd are fixed values or validated paths.
            # JSON quoting matches systemd's double-quoted argument syntax here;
            # reject specifier/environment expansion and control characters first.
            if any(re.search(r'[%$\x00-\x1f\x7f]', value) for value in argv):
                raise ValueError('Unsafe unit argument')
            lines = []
            for line in template.splitlines():
                if line.startswith(('ExecStart=', 'Restart=', 'RestartSec=', 'Environment=PRAXIS_CODING_CONFIG=', 'WantedBy=', 'ConditionPathExists=')) or line == '[Install]':
                    continue
                if line.startswith('WorkingDirectory='):
                    line = 'WorkingDirectory=' + str(checker)
                lines.append(line)
            lines.extend(['ExecStart=' + ' '.join(json.dumps(value) for value in argv), 'Restart=no', 'RuntimeMaxSec=60',
                          'InaccessiblePaths=/etc/praxis-code/config.json', 'StandardOutput=file:' + str(output),
                          'StandardError=file:' + str(errors)])
            unit_path = Path('/run/systemd/system') / unit
            with unit_path.open('x') as handle:
                handle.write('\n'.join(lines) + '\n')
            record = {'role': role, 'commit': revision, 'sourceDigest': exported['sourceDigest'], 'unit': unit, 'status': 'submitted'}
            item['revisions'].append(record)
            checkpoint()
            command('systemctl', 'daemon-reload')
            command('systemctl', 'start', unit)
            deadline = time.monotonic() + 75
            while time.monotonic() < deadline:
                state = command('systemctl', 'show', unit, '-p', 'ActiveState', '--value')
                if state in ('inactive', 'failed'):
                    break
                time.sleep(0.25)
            else:
                raise RuntimeError('Unit completion is ambiguous; inspect it, do not resubmit')
            record['status'] = state
            record['exitCode'] = int(command('systemctl', 'show', unit, '-p', 'ExecMainStatus', '--value'))
            try:
                result = json.loads(output.read_text())
                if result.get('complete') is not True or not isinstance(result.get('checks'), list):
                    raise ValueError('Incomplete checker result')
                record['result'] = result
            except (ValueError, OSError):
                record['result'] = {'complete': False, 'passed': False, 'error': 'NO_COMPLETE_CHECKER_RECEIPT'}
            checkpoint()
            print(json.dumps({'caseId': entry['id'], 'role': role, 'exitCode': record['exitCode'],
                              'complete': record['result']['complete'], 'passed': record['result']['passed']}), flush=True)
        base, reference = item['revisions']
        item['discriminatesHistoricalChange'] = (base['result']['complete'] and not base['result']['passed']
                                               and base['exitCode'] == 1 and reference['result']['complete']
                                               and reference['result']['passed'] and reference['exitCode'] == 0)
        checkpoint()
    receipt['status'] = 'completed'
    receipt['passed'] = all(item['discriminatesHistoricalChange'] for item in receipt['cases'])
    checkpoint()
    print(json.dumps({'receiptPath': str(root / 'receipt.json'), 'passed': receipt['passed']}))
    return 0 if receipt['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
