#!/usr/bin/env python3
"""Owner-authorized incremental Alpha backup. Never prunes remote snapshots."""
import os,sys,json,subprocess,pathlib,datetime,sqlite3,hashlib,stat,re,fcntl,shutil,time
BASE=pathlib.Path('/var/lib/alpha-backup')
STAGE=BASE/'stage'
REMOTE='alpha-backup:Alpha-VPS-Backup'
ENV={**os.environ,'RCLONE_CONFIG':str(BASE/'rclone.conf'),'GIT_TERMINAL_PROMPT':'0'}
ROOTS=['/etc','/root','/home','/opt','/srv','/var/lib','/usr/local']
PRUNE={'.git','node_modules','.cache','.npm','.rustup','__pycache__','site-packages'}
EXCLUDED=['/proc','/sys','/dev','/run','/tmp','/var/tmp','/snap','/var/cache',str(BASE/'cache'),str(BASE/'spool'),str(BASE/'state'),str(BASE/'restore-test'),str(BASE/'run.log'),'/swap.img','/swapfile']
def run(args,timeout=None):
 return subprocess.check_output(args,env=ENV,stderr=subprocess.DEVNULL,timeout=timeout)
def write(path,obj):
 path=pathlib.Path(path);path.parent.mkdir(parents=True,exist_ok=True)
 tmp=path.with_name(path.name+'.new');tmp.write_text(json.dumps(obj,indent=2)+'\n');tmp.chmod(0o600);tmp.replace(path)
def pattern(path):
 return path
def git(repo,*args):
 return run(['git','-C',repo,*args],timeout=60)
def repos_and_sqlite():
 repos=[];dbs=[]
 for root in ROOTS:
  for here,dirs,files in os.walk(root,followlinks=False):
   if here==str(BASE): dirs[:]=[];continue
   if '.git' in dirs or '.git' in files: repos.append(here)
   dirs[:]=[d for d in dirs if d not in PRUNE and not pathlib.Path(here,d).is_symlink()]
   for name in files:
    if not (name.endswith(('.db','.sqlite','.sqlite3')) or name in {'Cookies','History','Login Data','Web Data','Favicons','Network Action Predictor','Top Sites','Shortcuts'}):continue
    p=pathlib.Path(here,name)
    try:
     if p.is_file() and not p.is_symlink() and p.open('rb').read(16)==b'SQLite format 3\x00':dbs.append(str(p))
    except FileNotFoundError:pass
 return sorted(set(repos)),sorted(set(dbs))
def repo_exclusions(repos):
 manifest=[];excluded=[]
 for repo in repos:
  entry={'path':repo,'excluded_files':0}
  try:
   url=git(repo,'remote','get-url','origin').decode().strip()
   match=re.fullmatch(r'(?:https://github.com/|git@github.com:)([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?',url)
   if not match:raise ValueError('not a plain GitHub remote')
   entry['url']='https://github.com/'+match[1]+'.git'
   head=git(repo,'rev-parse','HEAD').decode().strip();entry['commit']=head
   remote=git(repo,'ls-remote','origin').decode()
   if head not in {line.split()[0] for line in remote.splitlines()}:raise ValueError('HEAD not verified at a remote ref')
   # Do not trust skip-worktree/assume-unchanged: hash actual bytes against HEAD.
   for row in git(repo,'ls-tree','-rz','--full-tree','HEAD').split(b'\0'):
    if not row:continue
    meta,name=row.split(b'\t',1);mode,kind,oid=meta.split()
    if kind!=b'blob':continue
    relative=os.fsdecode(name);p=pathlib.Path(repo,relative)
    if '\n' in str(p) or '\r' in str(p):continue
    try:
     if mode==b'120000':
      if not p.is_symlink():continue
      data=os.fsencode(os.readlink(p))
     else:
      if not p.is_file() or p.is_symlink():continue
      data=p.read_bytes()
     h=hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
     if h==oid.decode():excluded.append(str(p));entry['excluded_files']+=1
    except FileNotFoundError:continue
   entry['status']='verified; Git metadata and all other files retained'
  except (subprocess.SubprocessError,ValueError) as e:
   entry['status']='retained: '+type(e).__name__
  manifest.append(entry)
 return manifest,excluded
def databases(dbs):
 dest=STAGE/'databases';dest.mkdir(parents=True,exist_ok=True)
 records=[];excluded=[]
 for p in dbs:
  target=dest/'sqlite'/p.lstrip('/');target.parent.mkdir(parents=True,exist_ok=True)
  temp=target.with_name(target.name+'.new')
  if temp.exists():temp.unlink()
  start=time.monotonic()
  def progress(*unused):
   if time.monotonic()-start>180:raise TimeoutError('SQLite backup timed out')
  source=sqlite3.connect(pathlib.Path(p).as_uri()+'?mode=ro',uri=True,timeout=30)
  out=sqlite3.connect(temp)
  try:
   source.backup(out,pages=1024,progress=progress,sleep=0.1)
   if out.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise RuntimeError('SQLite integrity check failed')
  finally:out.close();source.close()
  temp.chmod(0o600);temp.replace(target)
  st=os.stat(p);records.append({'source':p,'backup':str(target),'uid':st.st_uid,'gid':st.st_gid,'mode':stat.S_IMODE(st.st_mode)})
  excluded.extend([p,p+'-wal',p+'-shm',p+'-journal'])
 for name,cmd,raw in [
  ('host-postgresql.sql',['runuser','-u','postgres','--','pg_dumpall'],'/var/lib/postgresql/16/main'),
  ('onecli-postgresql.sql',['docker','exec','onecli-postgres-1','sh','-c','exec pg_dumpall -U "$POSTGRES_USER"'],'/var/lib/docker/volumes/onecli_pgdata/_data')]:
  target=dest/name;temp=target.with_suffix('.new')
  with temp.open('wb') as f:subprocess.run(cmd,stdout=f,check=True,env=ENV,timeout=600)
  if temp.stat().st_size<100:raise RuntimeError('Empty PostgreSQL export')
  temp.chmod(0o600);temp.replace(target);excluded.append(raw)
  records.append({'source':raw,'backup':str(target),'format':'pg_dumpall SQL'})
 write(STAGE/'databases.json',records)
 return excluded
def main():
 BASE.mkdir(mode=0o700,exist_ok=True);os.umask(0o077)
 lock=(BASE/'lock').open('w');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 started=datetime.datetime.now(datetime.timezone.utc).isoformat()
 write(BASE/'status.json',{'status':'preparing','started':started})
 STAGE.mkdir(exist_ok=True)
 repos,dbs=repos_and_sqlite();manifest,excluded=repo_exclusions(repos)
 write(STAGE/'repositories.json',manifest)
 print('Repository scan:',len(manifest),'repositories;',len(excluded),'verified GitHub files excluded',flush=True)
 excluded+=databases(dbs)
 print('Consistent database exports:',len(dbs),'SQLite and 2 PostgreSQL instances',flush=True)
 png=json.loads((BASE/'png-exclusion.json').read_text())
 # Exclude only the specific previously uploaded files with unchanged SHA-256.
 for item in png['files']:
  p=pathlib.Path(png['source'],item['name'])
  if p.exists() and hashlib.sha256(p.read_bytes()).hexdigest()==item['sha256']:excluded.append(str(p))
 write(STAGE/'png-exclusion.json',png)
 for name,cmd in [('packages.txt',['dpkg-query','-W']),('services.txt',['systemctl','list-unit-files']),('mounts.txt',['findmnt','-J']),('containers.json',['docker','inspect','onecli','onecli-postgres-1'])]:
  (STAGE/name).write_bytes(run(cmd))
 (STAGE/'restore-sample.txt').write_text('Alpha backup restore verification\n')
 excludes=EXCLUDED+excluded
 (BASE/'excludes.txt').write_text('\n'.join(pattern(p) for p in excludes)+'\n')
 write(STAGE/'scope.json',{'roots':['/','/boot','/boot/efi'],'one_file_system':True,'excluded_paths':excludes,'notes':['SQLite copies and PostgreSQL exports are in stage/databases; restore them using databases.json.','Running files are captured individually, not as one atomic machine image.','Git metadata is retained conservatively for local refs and reflogs.','Other mounted filesystems are not followed; see mounts.txt.','No automatic pruning.']})

 write(BASE/'status.json',{'status':'uploading','started':started})
 spool=BASE/'spool';spool.mkdir(exist_ok=True)
 state=BASE/'state';state.mkdir(exist_ok=True)
 previous=state/'tar.snar';pending=state/'pending.snar'
 if pending.exists():pending.unlink()
 full=not previous.exists()
 if not full:shutil.copy2(previous,pending)
 name=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
 destination=REMOTE+'/snapshots/'+name
 # Literal exclusions; shell/glob expansion is never used.
 cmd=['tar','--create','--format=pax','--listed-incremental='+str(pending),'--xattrs','--acls','--numeric-owner','--one-file-system','--no-wildcards','-C','/']
 (BASE/'tar-excludes.txt').write_text('\n'.join('.'+p for p in excludes)+'\n')
 cmd+=['--exclude-from='+str(BASE/'tar-excludes.txt')]
 cmd+=['--file=-','.','./boot','./boot/efi']
 manifest={'format':'GNU tar incremental, zstd compression, split byte stream; no encryption','snapshot':name,'kind':'full' if full else 'incremental','parent':None if full else json.loads((state/'last.json').read_text())['snapshot'],'started':started,'parts':[]}
 warnings=spool/'tar-warnings.txt'
 with warnings.open('wb') as err:
  tar=subprocess.Popen(cmd,env=ENV,stdout=subprocess.PIPE,stderr=err)
  compressor=subprocess.Popen(['zstd','-T2','-3','-q','-c'],stdin=tar.stdout,stdout=subprocess.PIPE)
  tar.stdout.close()
  try:
   index=0
   while True:
    chunk=spool/'part.tmp';sha=hashlib.sha256();md5=hashlib.md5();size=0
    with chunk.open('wb') as f:
     while size<512*1024*1024:
      data=compressor.stdout.read(min(1024*1024,512*1024*1024-size))
      if not data:break
      f.write(data);sha.update(data);md5.update(data);size+=len(data)
    if not size:chunk.unlink();break
    filename='archive.tar.zst.part'+str(index).zfill(5)
    subprocess.run(['rclone','copyto',str(chunk),destination+'/'+filename,'--retries','5','--low-level-retries','10'],env=ENV,check=True)
    remote_md5=run(['rclone','md5sum',destination+'/'+filename]).decode().split()[0]
    if remote_md5!=md5.hexdigest():raise RuntimeError('Uploaded chunk checksum mismatch')
    manifest['parts'].append({'name':filename,'bytes':size,'sha256':sha.hexdigest(),'md5':md5.hexdigest()})
    chunk.unlink();index+=1
    print('Uploaded and checksum-verified part',index,flush=True)
   if compressor.wait()!=0:raise RuntimeError('Compression failed')
   tarcode=tar.wait()
   if tarcode not in (0,1):raise RuntimeError('Archive failed; see spool/tar-warnings.txt')
   manifest['tar_exit']=tarcode
  except:
   tar.terminate();compressor.terminate();tar.wait();compressor.wait();raise
 manifest['finished']=datetime.datetime.now(datetime.timezone.utc).isoformat()
 write(spool/'COMPLETE.json',manifest)
 # Publish completion only after every uploaded chunk passes checksum comparison.
 subprocess.run(['rclone','copyto',str(warnings),destination+'/tar-warnings.txt'],env=ENV,check=True)
 subprocess.run(['rclone','copyto',str(spool/'COMPLETE.json'),destination+'/COMPLETE.json'],env=ENV,check=True)
 pending.replace(previous);write(state/'last.json',manifest)
 status={'status':'success','started':started,'finished':manifest['finished'],'snapshot':name,'kind':manifest['kind'],'parts':len(manifest['parts']),'uploaded_bytes':sum(p['bytes'] for p in manifest['parts']),'all_upload_checksums_verified':True,'tar_exit':manifest['tar_exit']}
 write(BASE/'status.json',status);write(BASE/'last-success.json',status)
 subprocess.run(['rclone','copyto',str(BASE/'last-success.json'),REMOTE+'/last-success.json'],env=ENV,check=True)
 print(json.dumps(status),flush=True)

if __name__=='__main__':
 try:main()
 except Exception as e:
  write(BASE/'status.json',{'status':'failed','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'error':str(e)})
  raise
