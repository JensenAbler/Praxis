#!/usr/bin/env python3
"""Stage additional immutable evaluation projects without changing the live config.

Run as the independent bootstrap operator. Prompts/configuration remain private.
Use the staged config for fixture validation before applying a reviewed update.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import uuid


BUNDLES = {
    'buffer-settling': ('discord', 'The package lock matches the frozen discord bundle; package scripts differ.'),
    'provider-stream-errors': ('discord-replay-speech-first', 'The package lock matches the frozen speech-first bundle; package scripts differ.'),
    'vad-flap': ('discord-replay-speech-first', 'Historical package and lock differ from the frozen speech-first bundle. Qualify the actual clean suite with this explicitly adapted dependency environment; do not claim exact historical dependency reproduction.'),
}
FROZEN_RELEASE = 'coding-a41abbbbb51e'
FROZEN_IMAGE = 'sha256:a807793c27f53bf93480fc3dcfe73b2ab1b6bdf8b3aa1aca820118fd43767170'
PROJECT_ROOT = Path('/srv/praxis-code/projects')


def protected(path, kind=None):
    """Check every lexical path component before resolving symlinks away."""
    path = Path(os.path.abspath(path))
    for part in [path, *path.parents]:
        info = part.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Require root-owned inputs without symlinks or writable ancestors')
    if kind == 'file' and not path.is_file() or kind == 'directory' and not path.is_dir():
        raise ValueError('Protected input has the wrong filesystem type')
    return path.resolve(strict=True)


def read_bounded(path, maximum):
    if path.stat().st_size > maximum:
        raise ValueError('Protected input exceeds its size limit')
    with path.open('rb') as stream:
        content = stream.read(maximum + 1)
    if len(content) > maximum:
        raise ValueError('Protected input exceeds its size limit')
    return content


def selected_entries(catalog):
    if not isinstance(catalog, dict) or not isinstance(catalog.get('cases'), list) or not 1 <= len(catalog['cases']) <= 64:
        raise ValueError('Require a bounded evaluation catalog')
    indexed = {}
    for item in catalog['cases']:
        if not isinstance(item, dict) or not isinstance(item.get('id'), str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,49}', item['id']):
            raise ValueError('Invalid evaluation case ID')
        if item['id'] in indexed:
            raise ValueError('Duplicate evaluation case ID')
        indexed[item['id']] = item
    selected = {}
    for case_id in BUNDLES:
        if case_id not in indexed:
            raise ValueError('The fixed batch is missing a reviewed case')
        item = indexed[case_id]
        for field, width in [('baseCommit', 40), ('referenceCommit', 40), ('promptSha256', 64)]:
            if not isinstance(item.get(field), str) or not re.fullmatch('[a-f0-9]{' + str(width) + '}', item[field]):
                raise ValueError('Require full immutable commits and a canonical worker prompt hash')
        if item.get('promptIncluded') is not False or item.get('promptEncoding') != 'UTF-8, LF, final newline':
            raise ValueError('Require separate private canonical worker prompts')
        selected[case_id] = item
    return selected


def verified_prompt(content, expected_hash):
    if not content or len(content) > 65536:
        raise ValueError('Private worker prompt exceeds its size bounds')
    text = content.decode('utf-8')
    if not text.strip() or text.startswith('\ufeff') or text.replace('\r\n', '\n').replace('\r', '\n').rstrip('\n') + '\n' != text:
        raise ValueError('Require canonical UTF-8 LF prompt with one final newline')
    if hashlib.sha256(content).hexdigest() != expected_hash:
        raise ValueError('Private worker prompt does not match reviewed catalog')
    return text


def validate_export(exported, project_id, revision):
    expected = PROJECT_ROOT / project_id / revision
    if not isinstance(exported, dict) or exported.get('projectId') != project_id or exported.get('revision') != revision or exported.get('snapshotPath') != str(expected):
        raise ValueError('Exporter did not return the exact expected immutable snapshot')
    if not isinstance(exported.get('sourceDigest'), str) or not re.fullmatch(r'[a-f0-9]{64}', exported['sourceDigest']):
        raise ValueError('Exporter did not return a source digest')
    for field, maximum in [('fileCount', 20000), ('bytes', 134217728)]:
        if type(exported.get(field)) is not int or not 1 <= exported[field] <= maximum:
            raise ValueError('Exporter returned invalid source bounds')
    return expected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checker-root', required=True)
    parser.add_argument('--prompts-root', required=True)
    parser.add_argument('--run-id', required=True)
    args = parser.parse_args()
    if not hasattr(os, 'geteuid') or os.geteuid() != 0 or str(uuid.UUID(args.run_id)) != args.run_id:
        raise ValueError('Use the independent bootstrap operator and a canonical UUID')
    import grp
    protected(__file__, 'file')
    checker = protected(args.checker_root, 'directory')
    exporter = protected(checker / 'scripts/export-project.py', 'file')
    catalog_path = protected(checker / 'eval/catalog.json', 'file')
    prompts = protected(args.prompts_root, 'directory')
    config_path = protected('/etc/praxis-code/config.json', 'file')
    current_bytes = read_bounded(config_path, 2097152)
    config = json.loads(current_bytes)
    if config.get('release') != FROZEN_RELEASE or config.get('runnerConfig', {}).get('image') != FROZEN_IMAGE:
        raise ValueError('Batch v1 requires the frozen accepted tool release and image')
    if not isinstance(config.get('projects'), list) or not 1 <= len(config['projects']) <= 32:
        raise ValueError('Require a bounded existing project configuration')
    existing_ids = [item.get('id') for item in config['projects'] if isinstance(item, dict)]
    if len(existing_ids) != len(config['projects']) or any(not isinstance(key, str) for key in existing_ids) or len(set(existing_ids)) != len(existing_ids):
        raise ValueError('Existing project identities are invalid or ambiguous')
    entries = selected_entries(json.loads(read_bounded(catalog_path, 2097152)))
    requests = {}
    for case_id, entry in entries.items():
        private = protected(prompts / case_id, 'directory')
        prompt_path = private / 'worker-prompt.txt'
        if not prompt_path.exists():
            prompt_path = private / 'prompt.txt'
        requests[case_id] = verified_prompt(read_bounded(protected(prompt_path, 'file'), 65536), entry['promptSha256'])
        if 'discord-replay-' + case_id in existing_ids:
            raise ValueError('Project already registered; inspect instead of overwriting it')
    stage = Path('/etc/praxis-code') / ('replay-stage-' + args.run_id)
    protected(stage.parent, 'directory')
    stage.mkdir(mode=0o750, exist_ok=False)
    os.chown(stage, 0, grp.getgrnam('praxis-code').gr_gid)
    project_ids, dependencies, adaptations = [], {}, {}
    for case_id, (bundle, adaptation) in BUNDLES.items():
        entry = entries[case_id]
        project_id = 'discord-replay-' + case_id
        exported = json.loads(subprocess.check_output([
            '/usr/bin/python3', '-I', str(exporter), '--repository', '/opt/podcast-discord',
            '--revision', entry['baseCommit'], '--project', project_id], text=True, timeout=60,
            env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}))
        snapshot = protected(validate_export(exported, project_id, entry['baseCommit']), 'directory')
        instructions = (
            'Isolated historical coding evaluation. The request below is authorized only in a new workspace at this registered base. '
            'No publishing, deployment, production changes, credentials, live providers, or external network. '
            'Do not look up the historical fix or evaluator implementation. Node, npm, Python, Git, ripgrep and ffmpeg are installed. '
            f'Prepared read-only dependencies are at /opt/praxis/deps/{bundle}/node_modules. '
            'Use the registered validation command before and after editing; require the final suite summary and exit code. '
            + adaptation + '\n\nTask:\n' + requests[case_id])
        if case_id in ('buffer-settling', 'provider-stream-errors'):
            instructions += ('\n\nKnown clean-baseline limitation in the frozen sandbox: the test titled '
                             '"Recording metadata stores selected episode plan pointer" fails after native FFmpeg exits '
                             'and audio-recording-metadata.json is absent. Its cause is unresolved. Record whether this '
                             'same failure recurs; distinguish it from any new regression. Keep unrelated recording repairs '
                             'outside this task. A nonzero full-suite exit must still be reported accurately.')
        command = ['bash', '-lc', f'set -e; export CLAWCAST_CONTENT_ROOT=/tmp/praxis-content; mkdir -p "$CLAWCAST_CONTENT_ROOT"; if [ ! -e node_modules ]; then ln -s /opt/praxis/deps/{bundle}/node_modules node_modules; fi; npm test']
        config['projects'].append({
            'id': project_id, 'name': project_id, 'repository': 'https://github.com/JensenAbler/podcast-discord',
            'revision': entry['baseCommit'], 'snapshotPath': str(snapshot),
            'validationCommands': [command], 'instructions': instructions,
        })
        project_ids.append(project_id)
        dependencies[project_id], adaptations[project_id] = bundle, adaptation
    config['evaluationProjects'] = project_ids
    config['evaluationDependencyBundles'] = dependencies
    config['evaluationDependencyAdaptations'] = adaptations
    output = stage / 'config.json'
    with output.open('x') as handle:
        handle.write(json.dumps(config, indent=2) + '\n')
        handle.flush()
        os.fsync(handle.fileno())
    os.chown(output, 0, grp.getgrnam('praxis-code').gr_gid)
    output.chmod(0o640)
    receipt = {'runId': args.run_id, 'status': 'staged-not-applied', 'release': config['release'],
               'image': config['runnerConfig']['image'], 'projectIds': project_ids,
               'previousConfigSha256': hashlib.sha256(current_bytes).hexdigest(),
               'stagedConfigSha256': hashlib.sha256(output.read_bytes()).hexdigest(),
               'dependencyAdaptations': adaptations, 'stagedConfigPath': str(output)}
    (stage / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
