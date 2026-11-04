import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

test('Alpha backup preserves unique data and fails on real archive errors',()=>{
 const result=spawnSync('python3',[fileURLToPath(new URL('./alpha_backup_archive_test.py',import.meta.url))],{encoding:'utf8',timeout:120000});
 assert.ifError(result.error);
 assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
 assert.match(result.stderr,/Ran 6 tests/);
 assert.match(result.stderr,/\bOK\b/);
});
