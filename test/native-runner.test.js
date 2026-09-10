import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, appendFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NativeRunner } from '../src/code/native-runner.js';
import { containerName } from '../src/code/runner.js';

const workerPath = fileURLToPath(new URL('../src/code/native-worker.py', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, implementation) {
  const root = await mkdtemp(join(tmpdir(), 'praxis-native-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'), outside = join(root, 'other-work');
  await mkdir(workspace); await mkdir(outside);
  const calls = [], unit = { load: 'not-found', active: 'inactive', sub: 'dead', pid: 0 };
  const invoke = async (binary, args, env, timeout) => {
    calls.push({ binary, args, env, timeout });
    if (implementation) return implementation({ binary, args, env, timeout, unit });
    if (binary.endsWith('systemd-run')) { unit.load = 'loaded'; unit.active = 'active'; unit.sub = 'running'; unit.pid = 123; }
    if (args[0] === 'show') return { code: 0, stdout: `LoadState=${unit.load}\nActiveState=${unit.active}\nSubState=${unit.sub}\nMainPID=${unit.pid}\nInvocationID=fixture-invocation\nResult=success\n` };
    if (args[0] === 'stop') { unit.active = 'inactive'; unit.sub = 'dead'; unit.pid = 0; }
    return { code: 0, stdout: '', stderr: '' };
  };
  const options = { jobsDirectory: join(root, 'jobs'), homeDirectory: join(root, 'home'), workerPath, invoke };
  const runner = new NativeRunner(options), job = { id: randomUUID(), argv: ['node', '-e', 'console.log("hello")'], cwd: '.', env: { CUSTOM_SETTING: 'literal value' }, timeoutSeconds: 0, network: 'host' };
  return { root, workspace, outside, calls, options, runner, job, unit, name: containerName(job.id) };
}

test('native jobs persist exact host argv/cwd/env and separate root home without inheriting service credentials', async t => {
  const f = await fixture(t);
  const previous = process.env.PRAXIS_TEST_GATEWAY_SECRET;
  process.env.PRAXIS_TEST_GATEWAY_SECRET = 'fixture-should-not-flow';
  t.after(() => { if (previous === undefined) delete process.env.PRAXIS_TEST_GATEWAY_SECRET; else process.env.PRAXIS_TEST_GATEWAY_SECRET = previous; });
  f.job.cwd = f.outside;
  f.job.argv = ['/bin/sh', '-c', 'printf "%s" "$CUSTOM_SETTING"', 'literal $(not-expanded-by-launcher)'];
  const created = await f.runner.create({ job: f.job, workspacePath: f.workspace });
  const saved = JSON.parse(await readFile(join(f.runner.directory(f.name), 'request.json')));
  assert.deepEqual(saved.argv, f.job.argv);
  assert.equal(saved.cwd, f.outside);
  assert.equal(saved.env.HOME, f.options.homeDirectory);
  assert.equal(saved.env.CUSTOM_SETTING, 'literal value');
  assert.equal(saved.env.PRAXIS_TEST_GATEWAY_SECRET, undefined);
  assert.equal(saved.timeoutSeconds, 0);
  assert.equal(f.runner.kind, 'native-root');
  assert.equal(f.runner.image, f.runner.executionIdentity);
  assert.equal((await f.runner.inspect({ name: f.name })).status, 'created');
  assert.deepEqual(await new NativeRunner(f.options).create({ job: f.job, workspacePath: f.workspace }), created);
  await assert.rejects(f.runner.create({ job: { ...f.job, argv: ['different'] }, workspacePath: f.workspace }), { code: 'RUNNER_CONFLICT' });
});

test('native service admission has no sandbox or default deadline and restart recovery never launches again', async t => {
  const f = await fixture(t);
  await f.runner.create({ job: f.job, workspacePath: f.workspace });
  await f.runner.start({ name: f.name });
  const admission = f.calls.find(call => call.binary.endsWith('systemd-run'));
  for (const option of ['--property=User=root', '--property=KillMode=control-group', '--property=ExitType=cgroup']) assert.ok(admission.args.includes(option));
  assert.ok(!admission.args.some(arg => /PrivateNetwork|ProtectSystem|NoNewPrivileges|RuntimeMaxSec|ReadWritePaths/.test(arg)));
  for (const option of ['--property=TasksMax=infinity', '--property=MemoryMax=infinity', '--property=MemoryHigh=infinity', '--property=CPUQuota=']) assert.ok(admission.args.includes(option));
  assert.deepEqual(admission.args.slice(-4), ['/usr/bin/python3', '-I', workerPath, f.runner.directory(f.name)]);
  const recovered = new NativeRunner(f.options);
  assert.equal((await recovered.inspect({ name: f.name })).running, true);
  await recovered.start({ name: f.name });
  assert.equal(f.calls.filter(call => call.binary.endsWith('systemd-run')).length, 1);
});

test('lost native admission is observed if running and stays unresolved if no launch result survives', async t => {
  for (const admitted of [true, false]) {
    let launches = 0;
    const f = await fixture(t, async ({ binary, args, unit }) => {
      if (binary.endsWith('systemd-run')) {
        launches++;
        if (admitted) { unit.load = 'loaded'; unit.active = 'active'; unit.sub = 'running'; }
        throw new Error('fixture lost transport response');
      }
      assert.equal(args[0], 'show');
      return { code: 0, stdout: `LoadState=${unit.load}\nActiveState=${unit.active}\nSubState=${unit.sub}\nMainPID=321\n` };
    });
    await f.runner.create({ job: f.job, workspacePath: f.workspace });
    await assert.rejects(f.runner.start({ name: f.name }), /lost transport/);
    const recovered = new NativeRunner(f.options);
    if (admitted) {
      assert.equal((await recovered.inspect({ name: f.name })).running, true);
      await recovered.start({ name: f.name });
    } else {
      await assert.rejects(recovered.inspect({ name: f.name }), { code: 'RUNNER_START_UNCERTAIN' });
      await assert.rejects(recovered.start({ name: f.name }), { code: 'RUNNER_START_UNCERTAIN' });
    }
    assert.equal(launches, 1);
  }
});

test('native cancellation targets the complete unit and terminal cleanup preserves raw output and receipts', async t => {
  const f = await fixture(t);
  await f.runner.create({ job: { ...f.job, timeoutSeconds: 30 }, workspacePath: f.workspace });
  await f.runner.start({ name: f.name });
  assert.ok(f.calls.find(call => call.binary.endsWith('systemd-run')).args.includes('--property=RuntimeMaxSec=35'));
  await f.runner.stop({ name: f.name });
  assert.ok(f.calls.some(call => call.args[0] === 'stop' && call.args[1] === `${f.name}.service`));
  const terminal = { terminal: true, exitCode: 7, signal: null, reason: 'exit', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:02Z' };
  await writeFile(join(f.runner.directory(f.name), 'state.json'), JSON.stringify(terminal));
  const raw = Buffer.alloc(17 * 1024 * 1024, 65);
  await appendFile(f.runner.describeLogs(f.name).stdout, raw);
  const line = '2026-01-01T00:00:01Z stdout F retained output\n';
  await appendFile(f.runner.logPath(f.name), line.repeat(Math.ceil(raw.length / line.length)));
  const result = await new NativeRunner(f.options).logs({ name: f.name, limitBytes: 1024 });
  assert.equal(result.truncated, false, 'Native logs do not inherit the old 16 MiB container retention flag');
  assert.equal(result.hasMore, true);
  assert.equal(result.retention, 'persistent-native-log');
  const inspected = await f.runner.inspect({ name: f.name });
  assert.equal(inspected.exitCode, 7);
  await f.runner.remove({ name: f.name });
  assert.equal((await stat(f.runner.describeLogs(f.name).stdout)).size, raw.length);
  assert.deepEqual(JSON.parse(await readFile(join(f.runner.directory(f.name), 'state.json'))), terminal);
});

async function runWorker(f) {
  const child = spawn('/usr/bin/python3', ['-I', workerPath, f.runner.directory(f.name)], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', INVOCATION_ID: 'test-native-worker' } });
  let error = '';
  child.stderr.on('data', data => { error += data; });
  const finished = new Promise((resolveResult, reject) => {
    child.once('error', reject);
    child.once('close', code => resolveResult({ code, error }));
  });
  return { child, finished };
}

test('real native worker preserves binary stdout/stderr, outside-workspace writes, exit evidence, and refuses a second execution', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t), marker = join(f.outside, 'ran');
  f.job.argv = [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(marker)},'once'); process.stdout.write(Buffer.from([0,255,226,130,172,10])); process.stderr.write('error-output\\n'); process.exitCode=7;`];
  await f.runner.create({ job: f.job, workspacePath: f.workspace });
  await f.runner.start({ name: f.name });
  const run = await runWorker(f);
  assert.equal((await run.finished).code, 0);
  const state = JSON.parse(await readFile(join(f.runner.directory(f.name), 'state.json')));
  assert.equal(state.terminal, true); assert.equal(state.exitCode, 7); assert.equal(state.reason, 'exit');
  assert.deepEqual(await readFile(f.runner.describeLogs(f.name).stdout), Buffer.from([0, 255, 226, 130, 172, 10]));
  assert.equal(await readFile(f.runner.describeLogs(f.name).stderr, 'utf8'), 'error-output\n');
  assert.notEqual((await (await runWorker(f)).finished).code, 0);
  assert.equal(await readFile(marker, 'utf8'), 'once');
});

test('real native worker enforces a positive deadline and records explicit cancellation', { skip: process.platform !== 'linux' }, async t => {
  for (const cancelled of [false, true]) {
    const f = await fixture(t);
    f.job.timeoutSeconds = cancelled ? 0 : 1;
    f.job.argv = [process.execPath, '-e', 'process.stdout.write("started"); setInterval(()=>{},1000)'];
    await f.runner.create({ job: f.job, workspacePath: f.workspace }); await f.runner.start({ name: f.name });
    const run = await runWorker(f);
    t.after(() => { if (run.child.exitCode === null) run.child.kill('SIGKILL'); });
    if (cancelled) {
      for (let attempt = 0; attempt < 100 && (await stat(f.runner.describeLogs(f.name).stdout)).size === 0; attempt++) await sleep(20);
      run.child.kill('SIGTERM');
    }
    assert.equal((await run.finished).code, 0);
    const state = JSON.parse(await readFile(join(f.runner.directory(f.name), 'state.json')));
    assert.equal(state.terminal, true);
    assert.equal(state.reason, cancelled ? 'cancelled' : 'timeout');
    assert.equal(state.signal, 'SIGTERM');
    assert.equal(state.exitCode, null);
  }
});
