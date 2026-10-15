import unittest,tempfile,pathlib,subprocess,json,hashlib,importlib.util
spec=importlib.util.spec_from_file_location('restore',pathlib.Path(__file__).parents[1]/'scripts/alpha-restore.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class RestoreTest(unittest.TestCase):
 def test_full_incremental_and_corruption(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d);source=p/'source';source.mkdir();backup=p/'backup';backup.mkdir()
   (source/'file').write_text('old');(source/'file').chmod(0o640);(source/'gone').write_text('gone');(source/'link').symlink_to('file')
   for i in range(2):
    name=str(i);folder=backup/'snapshots'/name;folder.mkdir(parents=True)
    if i:(source/'file').write_text('new');(source/'gone').unlink()
    tar=p/'archive.tar';z=p/'archive.tar.zst'
    subprocess.run(['tar','-cf',str(tar),'--listed-incremental='+str(p/'snar'),'-C',str(source),'.'],check=True)
    subprocess.run(['zstd','-q','-f',str(tar),'-o',str(z)],check=True)
    data=z.read_bytes();parts=[]
    for n,pos in enumerate(range(0,len(data),50)):
     chunk=data[pos:pos+50];filename='part'+str(n);(folder/filename).write_bytes(chunk)
     parts.append({'name':filename,'bytes':len(chunk),'sha256':hashlib.sha256(chunk).hexdigest()})
    (folder/'COMPLETE.json').write_text(json.dumps({'snapshot':name,'kind':'full' if i==0 else 'incremental','parent':None if i==0 else '0','parts':parts}))
   (backup/'last-success.json').write_text(json.dumps({'snapshot':'1'}))
   target=p/'restored';module.restore(backup,target)
   self.assertEqual((target/'file').read_text(),'new');self.assertFalse((target/'gone').exists())
   self.assertTrue((target/'link').is_symlink());self.assertEqual((target/'file').stat().st_mode&0o777,0o640)
   (backup/'snapshots/1/part0').write_bytes(b'bad')
   with self.assertRaises(ValueError):module.restore(backup,p/'corrupted')
   self.assertFalse((p/'corrupted').exists())
if __name__=='__main__':unittest.main()
