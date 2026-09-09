import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

test('coding server starts through the release directory link and shuts down after serving health', { timeout: 20000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'praxis-code-entry-'));
  const release = fileURLToPath(new URL('../', import.meta.url));
  const current = join(directory, 'current');
  symlinkSync(release, current, process.platform === 'win32' ? 'junction' : 'dir');
  const configPath = join(directory, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    port: 0, release: 'entrypoint-fixture', issuer: 'https://fixture.invalid/oauth', resourceUrl: 'https://fixture.invalid/mcp',
    publicJwks: { keys: [] }, dataDirectory: join(directory, 'data'), workspaceDirectory: join(directory, 'workspaces'), projects: [],
    runnerConfig: { image: `sha256:${'0'.repeat(64)}`, workspaceRoot: join(directory, 'workspaces'), logDirectory: join(directory, 'logs'),
      binary: join(directory, 'no-container-runtime') },
  }));
  // Windows cannot deliver SIGTERM. This test-only preload invokes the same installed shutdown handler via IPC.
  const preload = `data:text/javascript,${encodeURIComponent("process.once('message', () => process.emit('SIGTERM')); process.channel?.unref();")}`;
  const child = spawn(process.execPath, ['--import', preload, join(current, 'src', 'code', 'server.js')], {
    cwd: directory, env: { ...process.env, PRAXIS_CODING_CONFIG: configPath }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  const closed = new Promise(resolveClose => child.once('close', (code, signal) => resolveClose({ code, signal })));
  let stderr = '', stdout = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    unlinkSync(current);
    assert.ok(resolve(directory).startsWith(resolve(join(tmpdir(), 'praxis-code-entry-'))));
    rmSync(directory, { recursive: true, force: true });
  });
  const listening = await new Promise((resolveListening, reject) => {
    const timer = setTimeout(() => reject(new Error(`Coding server never listened: ${stderr}`)), 10000);
    const fail = error => { clearTimeout(timer); reject(error); };
    child.once('error', fail);
    child.once('exit', (code, signal) => fail(new Error(`Coding server exited before listening: code=${code} signal=${signal} ${stderr}`)));
    child.stdout.on('data', chunk => {
      stdout += chunk;
      for (const line of stdout.split('\n')) {
        if (!line.startsWith('{')) continue;
        let record; try { record = JSON.parse(line); } catch { continue; }
        if (record.event === 'coding_listening') { clearTimeout(timer); resolveListening(record); return; }
      }
    });
  });
  assert.ok(Number.isInteger(listening.port) && listening.port > 0);
  const health = await fetch(`http://127.0.0.1:${listening.port}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).release, 'entrypoint-fixture');
  if (process.platform === 'win32') child.send('shutdown');
  else child.kill('SIGTERM');
  assert.deepEqual(await closed, { code: 0, signal: null });
  await assert.rejects(fetch(`http://127.0.0.1:${listening.port}/healthz`));
});

test('importing the coding service does not start a listener or require protected configuration', { timeout: 10000 }, async () => {
  const moduleUrl = new URL('../src/code/server.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(moduleUrl)}); console.log('IMPORTED');`, 'nonexistent-entrypoint'], {
    env: { ...process.env, PRAXIS_CODING_CONFIG: '' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const result = await new Promise((done, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => done({ code, signal }));
  });
  assert.deepEqual(result, { code: 0, signal: null }, stderr);
  assert.equal(stdout.trim(), 'IMPORTED');
});
