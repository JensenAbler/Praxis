import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const script = readFileSync(new URL('../deploy/qualify-autonomy.sh', import.meta.url), 'utf8');
const source = script.split("<<'QUALIFY_PYTHON'\n")[1]?.split('\nQUALIFY_PYTHON')[0];
const python = process.platform === 'win32' ? 'python' : 'python3';

test('qualification archive verification binds commits and rejects unsafe extraction', () => {
  assert.ok(source);
  const fixture = String.raw`
import io,json,pathlib,tarfile,tempfile
namespace={'__name__':'qualification_fixture'}
exec(compile(json.loads(sys.stdin.readline()),'qualify-autonomy.sh','exec'),namespace)
commit='a'*40
required=['package.json','package-lock.json','scripts/export-tool-manifest.js','scripts/release-candidate-check.js','src/code/server.js','deploy/registry-proxy.py','deploy/registry-relay.mjs','deploy/praxis_updater_host.py','deploy/bootstrap-autonomy.py']
def archive_file(path,extras=(),comment=commit):
    with tarfile.open(path,'w',format=tarfile.PAX_FORMAT,pax_headers={'comment':comment}) as archive:
        for name in required:
            member=tarfile.TarInfo(name);member.size=2;member.mode=0o644
            archive.addfile(member,io.BytesIO(b'{}'))
        for member,data in extras: archive.addfile(member,io.BytesIO(data) if data is not None else None)
def rejected(path):
    try:
        with tarfile.open(path) as archive: namespace['archive_entries'](archive,commit)
    except RuntimeError:return
    raise AssertionError('unsafe archive accepted')
with tempfile.TemporaryDirectory(prefix='praxis-qualify-test-') as temporary:
    directory=pathlib.Path(temporary);path=directory/'candidate.tar'
    archive_file(path)
    namespace['extract_archive'](path,commit,directory/'source')
    tree=namespace['safe_tree'](directory/'source')
    assert set(tree)==set(required)
    assert all(value['bytes']==2 for value in tree.values())
    archive_file(path,comment='b'*40);rejected(path)
    for name in ['../escape','/absolute','folder/../../escape','folder//file','.env','nested/.ssh/id','node_modules/x','coding-tools.json','package.json']:
        member=tarfile.TarInfo(name);member.size=1;member.mode=0o644
        archive_file(path,[(member,b'x')]);rejected(path)
    for kind in [tarfile.SYMTYPE,tarfile.LNKTYPE,tarfile.CHRTYPE,tarfile.FIFOTYPE]:
        member=tarfile.TarInfo('unsafe');member.type=kind;member.linkname='../escape'
        archive_file(path,[(member,None)]);rejected(path)
    member=tarfile.TarInfo('privileged');member.mode=0o4755
    archive_file(path,[(member,b'')]);rejected(path)
    parent=tarfile.TarInfo('parent');parent.mode=0o644
    child=tarfile.TarInfo('parent/child');child.mode=0o644
    archive_file(path,[(parent,b''),(child,b'')]);rejected(path)
print('archive checks passed')
`;
  const result = spawnSync(python, ['-c', 'import sys\n' + fixture], { input: JSON.stringify(source) + '\n', encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /archive checks passed/);
});

test('qualification artifact hash matches the updater format and detects source changes', () => {
  const helper = readFileSync(new URL('../deploy/praxis_updater_host.py', import.meta.url), 'utf8');
  const fixture = String.raw`
import ast,hashlib,json,os,pathlib,stat,tempfile
qualification={'__name__':'qualification_fixture'};updater=dict(globals(),__name__='updater_fixture')
exec(compile(json.loads(sys.stdin.readline()),'qualification','exec'),qualification)
definitions=ast.parse(json.loads(sys.stdin.readline()))
definitions.body=[node for node in definitions.body if isinstance(node,ast.FunctionDef) and node.name in ('require','file_hash','safe_tree')]
exec(compile(definitions,'updater','exec'),updater)
with tempfile.TemporaryDirectory(prefix='praxis-qualify-tree-') as temporary:
    root=pathlib.Path(temporary)
    (root/'source.js').write_text('export const answer=42;')
    (root/'node_modules').mkdir();(root/'node_modules/dependency.js').write_text('export default true;')
    first=qualification['safe_tree'](root,allow_dependency_links=True)
    assert first==updater['safe_tree'](root,allow_dependency_links=True)
    original=qualification['artifact_hash'](first)
    (root/'source.js').write_text('export const answer=43;')
    assert qualification['artifact_hash'](qualification['safe_tree'](root,True))!=original
    (root/'.env').write_text('fixture only')
    try:qualification['safe_tree'](root,True)
    except RuntimeError:pass
    else:raise AssertionError('protected source accepted')
print('artifact checks passed')
`;
  const result = spawnSync(python, ['-c', 'import sys\n' + fixture], {
    input: JSON.stringify(source) + '\n' + JSON.stringify(helper) + '\n', encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /artifact checks passed/);
});
