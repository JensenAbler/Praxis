#!/usr/bin/env python3
"""Offline archive verification/extraction. Requires only Python, GNU tar, zstd."""
import argparse,pathlib,json,hashlib,subprocess,os,shutil
def chain(root,snapshot):
 result=[];seen=set()
 while snapshot:
  if snapshot in seen or '/' in snapshot or snapshot in ('.','..'):raise ValueError('Invalid snapshot chain')
  seen.add(snapshot);folder=root/'snapshots'/snapshot
  m=json.loads((folder/'COMPLETE.json').read_text())
  if m['snapshot']!=snapshot:raise ValueError('Snapshot identity mismatch')
  result.append((folder,m));snapshot=m.get('parent')
 if not result or result[-1][1]['kind']!='full':raise ValueError('Missing full snapshot')
 return list(reversed(result))
def restore(root,target,snapshot=None):
 root=pathlib.Path(root).resolve();target=pathlib.Path(target).resolve()
 if target==pathlib.Path('/') or target==root or root.is_relative_to(target):raise ValueError('Unsafe target')
 if target.exists() and any(target.iterdir()):raise ValueError('Restore target must be empty')
 if snapshot is None:snapshot=json.loads((root/'last-success.json').read_text())['snapshot']
 snapshots=chain(root,snapshot)
 # Validate all local input before creating recovery files.
 for folder,m in snapshots:
  for p in m['parts']:
   if pathlib.Path(p['name']).name!=p['name']:raise ValueError('Invalid part path')
   f=folder/p['name'];h=hashlib.sha256()
   with f.open('rb') as stream:
    for data in iter(lambda:stream.read(4*1024*1024),b''):h.update(data)
   if f.stat().st_size!=p['bytes'] or h.hexdigest()!=p['sha256']:raise ValueError('Checksum failed: '+str(f))
  print('Verified',m['snapshot'],flush=True)
 target.mkdir(parents=True,exist_ok=True)
 for folder,m in snapshots:
  z=subprocess.Popen(['zstd','-d','-c','-q'],stdin=subprocess.PIPE,stdout=subprocess.PIPE)
  tar=subprocess.Popen(['tar','--extract','--listed-incremental=/dev/null','--acls','--xattrs','--numeric-owner','-C',str(target)],stdin=z.stdout)
  z.stdout.close()
  try:
   for p in m['parts']:
    with (folder/p['name']).open('rb') as f:shutil.copyfileobj(f,z.stdin,4*1024*1024)
   z.stdin.close()
   if z.wait() or tar.wait():raise RuntimeError('Extraction failed')
  except:
   z.terminate();tar.terminate();z.wait();tar.wait();raise
  print('Extracted',m['snapshot'],flush=True)
 print('Recovery files are in',target)
 print('Follow BOOTSTRAP.md to restore database exports and start Praxis. No running service was changed.')
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('backup_folder');p.add_argument('empty_target');p.add_argument('--snapshot')
 a=p.parse_args();restore(a.backup_folder,a.empty_target,a.snapshot)
