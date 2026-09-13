#!/usr/bin/env python3
"""Install a reviewed published source tree as a versioned unprivileged service."""
import os,pathlib,subprocess,sys,shutil,hashlib,json
source=pathlib.Path(sys.argv[1]).resolve()
revision=sys.argv[2]
if len(revision)!=40 or any(c not in '0123456789abcdef' for c in revision): raise SystemExit('Exact published commit required')
def run(*args,**kw): subprocess.run(args,check=True,**kw)
target=pathlib.Path('/srv/patronus/releases')/revision
run('id','patronus') if subprocess.run(['id','patronus'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0 else run('useradd','--system','--home-dir','/var/lib/patronus','--shell','/usr/sbin/nologin','patronus')
os.umask(0o022)
target.mkdir(parents=True,exist_ok=True)
# Only the installation parent needs traversal; profile/state paths are elsewhere.
os.chmod('/srv/patronus',0o755)
for name in ['src','package.json','package-lock.json']:
 p=source/name
 if p.is_dir(): shutil.copytree(p,target/name,dirs_exist_ok=True)
 else: shutil.copy2(p,target/name)
run('npm','ci','--omit=dev','--no-audit','--no-fund',cwd=target)
run('npx','playwright','install','--with-deps','chromium',cwd=target,env={**os.environ,'PLAYWRIGHT_BROWSERS_PATH':str(target/'browsers')})
# Installed code and browser binaries are public; runtime profiles remain private.
for root,dirs,files in os.walk(target):
 os.chmod(root,0o755)
 for name in files:
  p=pathlib.Path(root)/name
  if not p.is_symlink(): os.chmod(p,0o755 if p.stat().st_mode&0o111 else 0o644)
for p in ['/var/lib/patronus','/run/patronus']:
 pathlib.Path(p).mkdir(parents=True,exist_ok=True);run('chown','patronus:patronus',p);os.chmod(p,0o700)
unit=f"""[Unit]
Description=Patronus persistent web reader
After=network-online.target
[Service]
Type=simple
User=patronus
Group=patronus
ExecStart=/usr/bin/node {target}/src/patronus/server.js
Environment=PLAYWRIGHT_BROWSERS_PATH={target}/browsers
Environment=HOME=/var/lib/patronus
UMask=0077
RuntimeDirectory=patronus
RuntimeDirectoryMode=0700
StateDirectory=patronus
StateDirectoryMode=0700
Restart=on-failure
RestartSec=3
TimeoutStopSec=25
KillMode=control-group
MemoryMax=2G
TasksMax=256
CPUQuota=150%
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/patronus /run/patronus
InaccessiblePaths=-/opt -/root -/var/lib/praxis-root -/srv/praxis-code -/srv/praxis-control -/etc/praxis
[Install]
WantedBy=multi-user.target
"""
pathlib.Path('/etc/systemd/system/patronus.service').write_text(unit)
run('systemctl','daemon-reload');run('systemctl','enable','--now','patronus.service');run('systemctl','restart','patronus.service')
run('systemctl','is-active','patronus.service')
print(json.dumps({'revision':revision,'service':'patronus','source':str(target)}))
