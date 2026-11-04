import importlib.util,io,os,pathlib,shlex,shutil,subprocess,tarfile,tempfile,unittest
from unittest import mock

spec=importlib.util.spec_from_file_location('backup',pathlib.Path(__file__).parents[1]/'scripts/alpha-backup.py')
backup=importlib.util.module_from_spec(spec);spec.loader.exec_module(backup)

class BackupArchiveTest(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory()
  self.addCleanup(self.temp.cleanup)
  self.base=pathlib.Path(self.temp.name)
  self.root=self.base/'root'
  (self.root/'boot/efi').mkdir(parents=True)
  self.excludes=self.base/'excludes'
  self.excludes.write_text('')
 def put(self,path,content='unique data'):
  p=self.root/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(content)
  return p
 def command(self,name='snapshot',extra=()):
  cmd=backup.tar_command(self.base/(name+'.snar'),self.excludes)
  cmd[cmd.index('-C')+1]=str(self.root)
  return cmd[:1]+list(extra)+cmd[1:]
 def archive(self,name='snapshot',extra=()):
  return subprocess.run(self.command(name,extra),stdout=subprocess.PIPE,stderr=subprocess.PIPE,env={**os.environ,'LC_ALL':'C'})
 def names(self,data):
  with tarfile.open(fileobj=io.BytesIO(data)) as archive:
   return {n.removeprefix('./').rstrip('/') for n in archive.getnames()}
 def test_only_exact_generated_paths_are_excluded(self):
  excluded=[
   'var/lib/apocrypha/codex/summary-AbC123/result.txt',
   'var/lib/apocrypha/codex/tmp/arg0-linux/codex-arg0AbC123/runner',
  ]
  retained=[
   'var/lib/apocrypha/codex/auth.json',
   'var/lib/apocrypha/codex/state.sqlite',
   'var/lib/apocrypha/codex/sessions/unique.jsonl',
   'var/lib/apocrypha/codex/shell_snapshots/unique.sh',
   'var/lib/apocrypha/codex/summary-AbC12/result.txt',
   'var/lib/apocrypha/codex/summary-AbC1234/result.txt',
   'var/lib/apocrypha/codex/summary-a/bcde/result.txt',
   'var/lib/apocrypha/codex/tmp/arg0-linux/codex-arg0AbC12/unique',
   'var/lib/apocrypha/codex/tmp/arg0-linux/codex-arg0AbC1234/unique',
   'var/lib/apocrypha/codex/tmp/important.txt',
   'other/var/lib/apocrypha/codex/summary-AbC123/unique',
   'var/lib/apocrypha/state.sqlite',
   'home/user/summary-AbC123/unique',
  ]
  for p in excluded+retained:self.put(p)
  result=self.archive()
  self.assertEqual(result.returncode,0,result.stderr.decode())
  names=self.names(result.stdout)
  for p in excluded:self.assertNotIn(p,names)
  for p in retained:self.assertIn(p,names)
 def test_repository_exclusion_metacharacters_stay_literal(self):
  for p in ['root/repo/file[1].txt','root/repo/file1.txt','root/repo/file*.txt','root/repo/file2.txt']:self.put(p)
  self.excludes.write_text('./root/repo/file[1].txt\n./root/repo/file*.txt\n')
  result=self.archive()
  self.assertEqual(result.returncode,0,result.stderr.decode())
  names=self.names(result.stdout)
  self.assertNotIn('root/repo/file[1].txt',names)
  self.assertNotIn('root/repo/file*.txt',names)
  self.assertIn('root/repo/file1.txt',names)
  self.assertIn('root/repo/file2.txt',names)
 def test_disappearing_scratch_directories_do_not_abort_archive(self):
  self.put('var/lib/apocrypha/codex/000-padding','x'*131072)
  keep=self.put('var/lib/apocrypha/codex/important.txt','preserve this')
  scratch=['var/lib/apocrypha/codex/summary-AbC123','var/lib/apocrypha/codex/tmp/arg0-linux/codex-arg0AbC123']
  script=self.base/'remove-scratch.py'
  script.write_text('import pathlib,shutil\n'+''.join('shutil.rmtree('+repr(str(self.root/p))+',ignore_errors=True)\n' for p in scratch))
  options=['--sort=name','--checkpoint=1','--checkpoint-action=exec=python3 '+shlex.quote(str(script))]
  for p in scratch:self.put(p+'/result.txt')
  with mock.patch.object(backup,'EPHEMERAL_EXCLUSIONS',[]):
   original=self.archive('old',options)
  self.assertEqual(original.returncode,2,original.stderr.decode())
  self.assertIn(b'Cannot stat',original.stderr)
  for p in scratch:self.put(p+'/result.txt')
  fixed=self.archive('fixed',options)
  self.assertIn(fixed.returncode,(0,1),fixed.stderr.decode())
  self.assertNotIn(b'Cannot stat',fixed.stderr)
  self.assertIn('var/lib/apocrypha/codex/important.txt',self.names(fixed.stdout))
  self.assertEqual(keep.read_text(),'preserve this')
 def test_incremental_checkpoint_preserves_unique_changes(self):
  self.put('root/unique.txt','before')
  scratch='var/lib/apocrypha/codex/summary-AbC123'
  self.put(scratch+'/result.txt')
  with mock.patch.object(backup,'EPHEMERAL_EXCLUSIONS',[]):first=self.archive()
  self.assertEqual(first.returncode,0,first.stderr.decode())
  self.put('root/unique.txt','after')
  shutil.rmtree(self.root/scratch)
  fresh='var/lib/apocrypha/codex/summary-XyZ789/result.txt'
  self.put(fresh)
  second=self.archive()
  self.assertEqual(second.returncode,0,second.stderr.decode())
  self.assertNotIn(fresh,self.names(second.stdout))
  restore=self.base/'restored';restore.mkdir()
  for result in [first,second]:
   subprocess.run(['tar','--extract','--listed-incremental=/dev/null','-C',str(restore),'-f','-'],input=result.stdout,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  self.assertEqual((restore/'root/unique.txt').read_text(),'after')
 def test_real_missing_input_stays_fatal(self):
  self.put('root/important.txt')
  cmd=self.command()+['./root/important-missing']
  self.assertNotIn('--ignore-failed-read',cmd)
  result=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env={**os.environ,'LC_ALL':'C'})
  self.assertEqual(result.returncode,2)
  self.assertIn(b'important-missing',result.stderr)
 def test_real_permission_error_stays_fatal(self):
  self.base.chmod(0o777)
  denied=self.put('root/private.txt')
  denied.chmod(0)
  # Do not let the caller's private umask make an unrelated fixture path fail.
  self.excludes.chmod(0o644)
  self.root.chmod(0o755)
  for directory in self.root.rglob('*'):
   if directory.is_dir():directory.chmod(0o755)
  kwargs={'user':65534,'group':65534,'extra_groups':[]} if os.geteuid()==0 else {}
  result=subprocess.run(self.command(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,env={**os.environ,'LC_ALL':'C'},**kwargs)
  self.assertEqual(result.returncode,2,result.stderr.decode())
  self.assertIn(b'Permission denied',result.stderr)
  self.assertIn(b'root/private.txt',result.stderr)

if __name__=='__main__':unittest.main(verbosity=2)
