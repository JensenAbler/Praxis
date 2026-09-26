"""Parse the control plane import graph without importing candidate code."""
import json
import pathlib
import subprocess

ENTRY_POINTS = ('src/server.js', 'src/claude-facade/server.js', 'src/git/server.js')
OWNER_COMPONENTS = (
    'deploy/update-control.py', 'deploy/control_closure.py',
    'deploy/bootstrap-autonomy.py', 'deploy/activate-control.py',
    'deploy/praxis-updater.py', 'deploy/praxis_updater_host.py',
    'deploy/deploy-discord.py', 'deploy/deploy-project.py',
    'scripts/release-build.js', 'scripts/release-candidate-check.js',
    'scripts/release-live-check.js', 'scripts/autonomy-live-qualification.js',
)
PARSER = r"""
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = fs.realpathSync(process.argv[1]), pending = JSON.parse(process.argv[2]), seen = new Set();
while (pending.length) {
  const name = pending.pop();
  if (seen.has(name)) continue;
  const file = path.resolve(root, name);
  if (!file.startsWith(root + path.sep) || fs.realpathSync(file) !== file) throw Error('Escaping or linked control import: ' + name);
  seen.add(name);
  if (!/\.[cm]?js$/.test(name)) continue;
  const source = fs.readFileSync(file, 'utf8');
  // Conservative: dynamic loaders need explicit resolver policy. Comments can trigger review.
  if (/\bimport\s*\(|\brequire\s*\(|\bcreateRequire\b|\b(?:eval|Function)\s*\(/.test(source))
    throw Error('Unresolved dynamic control dependency: ' + name);
  const module = new vm.SourceTextModule(source, { identifier: file });
  for (const specifier of module.dependencySpecifiers) {
    if (specifier.startsWith('node:')) continue;
    if (!specifier.startsWith('.')) {
      if (!/^(?:@[a-zA-Z0-9_-]+\/)?[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(specifier))
        throw Error('Unsupported control import: ' + specifier);
      continue; // The installed dependency bundle is pinned separately.
    }
    const target = path.resolve(path.dirname(file), specifier);
    if (!target.startsWith(root + path.sep)) throw Error('Escaping control import: ' + specifier);
    pending.push(path.relative(root, target).split(path.sep).join('/'));
  }
}
process.stdout.write(JSON.stringify([...seen].sort()));
"""

def control_closure(root, entry_points=ENTRY_POINTS):
    root = pathlib.Path(root).resolve(strict=True)
    result = subprocess.run(['/usr/bin/node', '--experimental-vm-modules', '-e', PARSER,
                             str(root), json.dumps(list(entry_points))],
                            capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError('Cannot resolve control import closure: ' + result.stderr[-1500:])
    return set(json.loads(result.stdout))

def policy_paths(before_root, after_root, before, after, protected):
    # Removing an import cannot hide a changed old dependency in the same transaction.
    paths = control_closure(before_root) | control_closure(after_root)
    paths.update(OWNER_COMPONENTS)
    paths.update(name for name in protected if not name.startswith('src/'))
    paths.update(name for name in before.keys() | after.keys()
                 if name.startswith('node_modules/') or name in ('package.json', 'package-lock.json', 'npm-shrinkwrap.json'))
    return paths
