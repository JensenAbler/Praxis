#!/usr/bin/env python3
"""Disposable owned-origin acceptance fixtures; no third-party credentials."""
import pathlib,tempfile,subprocess,socket,http.client,json,time,os,pwd,hashlib,shutil
class UnixHTTP(http.client.HTTPConnection):
 def connect(self):
  self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.settimeout(20);self.sock.connect('/run/patronus/api.sock')
def call(action,args):
 c=UnixHTTP('localhost');c.request('POST','/call',json.dumps({'action':action,'args':args}),{'Content-Type':'application/json'})
 d=json.loads(c.getresponse().read());c.close()
 if not d['ok']:raise RuntimeError(d['error'])
 return d['data']
def wait(job):
 deadline=time.time()+150
 while time.time()<deadline:
  d=call('patronus_status',{'jobId':job})
  if d['state'] in ['succeeded','partial','failed','cancelled']:return d
  time.sleep(.5)
 raise RuntimeError('Fixture deadline')
def run(*args):subprocess.run(args,check=True,stdout=subprocess.DEVNULL)
def submit(name,**kw):
 return call('patronus_start',dict(urls=[base+'/'+name],idempotencyKey='fixture-'+nonce+'-'+name,**kw))['jobId']
nonce=str(int(time.time()));prefix='/patronus-check-'+nonce;base='https://clawcast.jensenabler.com'+prefix
config=pathlib.Path('/etc/nginx/sites-available/podcast');original=config.read_text()
profile=pathlib.Path('/var/lib/patronus/profiles')/('fixture_'+nonce)
fixture=pathlib.Path(tempfile.mkdtemp(prefix='patronus-public-fixture-',dir='/run'));os.chmod(fixture,0o755)
try:
 # Existing runs finish before any service lifecycle changes.
 for job in call('patronus_jobs',{})['jobs']:
  if job['state'] in ['running','queued']:wait(job['jobId'])
 (fixture/'page.html').write_text('<html><head><title>Patronus fixture</title></head><body><h1 id="result">Pending</h1><script>setTimeout(()=>document.getElementById("result").textContent="JavaScript rendered successfully",50)</script></body></html>')
 (fixture/'private.html').write_text('<html><body>Authorized fixture content</body></html>')
 payload=b'patronus-download-fixture\n'*(8*1024*1024//26)
 (fixture/'file.bin').write_bytes(payload)
 for f in fixture.iterdir():os.chmod(f,0o644)
 locations=f'''
    location = {prefix}/page {{ alias {fixture}/page.html; default_type text/html; }}
    location = {prefix}/private {{
        if ($cookie_patronus_fixture != "authorized") {{ return 401; }}
        alias {fixture}/private.html; default_type text/html;
    }}
    location = {prefix}/file {{
        alias {fixture}/file.bin; default_type application/octet-stream;
        limit_rate 1m;
    }}
 '''
 config.write_text(original.replace('    root /var/www/podcast;',locations+'\n    root /var/www/podcast;'))
 run('nginx','-t');run('systemctl','reload','nginx')
 run('systemctl','stop','patronus')
 profile.mkdir(mode=0o700)
 cookie={'name':'patronus_fixture','value':'authorized','domain':'clawcast.jensenabler.com','path':prefix,'secure':True,'httpOnly':True,'sameSite':'Lax','expires':time.time()+600}
 (profile/'access.json').write_text(json.dumps({'cookies':[cookie]}))
 account=pwd.getpwnam('patronus')
 os.chown(profile,account.pw_uid,account.pw_gid);os.chown(profile/'access.json',account.pw_uid,account.pw_gid);os.chmod(profile/'access.json',0o600)
 run('systemctl','start','patronus')
 for _ in range(40):
  if pathlib.Path('/run/patronus/api.sock').exists():break
  time.sleep(.25)
 reports=[]
 for name,kw,expected in [('page',{'rendering':'browser'},'succeeded'),('private',{'rendering':'browser'},'failed'),('private',{'rendering':'browser','profile':profile.name},'succeeded')]:
  args=dict(urls=[base+'/'+name],idempotencyKey='fixture-'+nonce+'-'+name+'-'+kw.get('profile','public'),**kw)
  job=call('patronus_start',args)['jobId'];d=wait(job)
  result=json.loads(call('patronus_result',{'jobId':job})['content'])
  if name=='page':assert 'JavaScript rendered successfully' in result[0]['markdown']
  if name=='private' and expected=='succeeded':assert 'Authorized fixture content' in result[0]['markdown']
  assert d['state']==expected,d
  reports.append({'case':name,'profile':kw.get('profile','public'),'jobId':job,'state':d['state'],'obstacles':d['obstacles']})
 job=submit('file',mode='download',maxBytes=16*1024*1024)
 deadline=time.time()+20
 while time.time()<deadline:
  d=call('patronus_status',{'jobId':job})
  if d['bytes']>0:break
  time.sleep(.25)
 call('patronus_cancel',{'jobId':job});d=wait(job)
 assert d['state']=='cancelled' and any(a.get('resumable') for a in d['artifacts']),d
 resumed=call('patronus_start',{'urls':[base+'/file'],'mode':'download','maxBytes':16*1024*1024,'resumeJobId':job,'idempotencyKey':'fixture-'+nonce+'-resume'})['jobId']
 d=wait(resumed);assert d['state']=='succeeded',d
 a=d['artifacts'][0];assert a['bytes']==len(payload) and a['sha256']==hashlib.sha256(payload).hexdigest(),a
 reports.append({'case':'cancel-and-resume','originalJobId':job,'jobId':resumed,'bytes':a['bytes'],'sha256Verified':True,'state':d['state']})
 print(json.dumps({'ok':True,'reports':reports}),flush=True)
finally:
 config.write_text(original);run('nginx','-t');run('systemctl','reload','nginx')
 run('systemctl','stop','patronus');shutil.rmtree(profile,ignore_errors=True);run('systemctl','start','patronus')
 shutil.rmtree(fixture,ignore_errors=True)
