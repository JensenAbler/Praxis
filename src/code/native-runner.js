import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, realpath, lstat } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { containerName, PodmanRunner, RunnerError } from './runner.js';

const NAME = /^praxis-code-[0-9a-f-]{36}$/;
const ROOT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const clock = () => new Date().toISOString();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => JSON.stringify(value, Object.keys(value).sort());

function control(binary, args, env, timeoutMs = 30000) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks = { stdout: [], stderr: [] }; let size = 0, error;
    const timer = setTimeout(() => {
      error = new RunnerError('RUNNER_TIMEOUT', 'Native service control timed out; inspect the existing job before taking further action.');
      child.kill('SIGKILL');
    }, timeoutMs);
    for (const name of ['stdout', 'stderr']) child[name].on('data', chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        error = new RunnerError('RUNNER_OUTPUT_LIMIT', 'Native service control returned too much metadata.');
        child.kill('SIGKILL');
      } else chunks[name].push(chunk);
    });
    child.on('error', () => { clearTimeout(timer); reject(new RunnerError('RUNNER_UNAVAILABLE', 'Native service control could not be invoked.')); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolveResult({ code, signal, stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8') });
    });
  });
}

async function syncDirectory(path) {
  if (process.platform === 'win32') return;
  const fd = await open(path, 'r'); try { await fd.sync(); } finally { await fd.close(); }
}
async function json(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function exclusive(path, contents) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
}
async function atomic(path, value) {
  const pending = `${path}.next-${process.pid}-${Date.now()}`;
  await exclusive(pending, JSON.stringify(value) + '\n');
  await rename(pending, path); await syncDirectory(resolve(path, '..'));
}
function sameRequest(left, right) {
  return left.name === right.name && left.cwd === right.cwd && left.timeoutSeconds === right.timeoutSeconds &&
    left.executionIdentity === right.executionIdentity && JSON.stringify(left.argv) === JSON.stringify(right.argv) &&
    encode(left.env) === encode(right.env);
}

/** Owner-authorized native host execution. This is not a sandbox. */
export class NativeRunner {
  constructor({ jobsDirectory = '/var/lib/praxis-root/jobs', homeDirectory = '/var/lib/praxis-root/home',
    workerPath = fileURLToPath(new URL('./native-worker.py', import.meta.url)), pythonPath = '/usr/bin/python3',
    systemdRunPath = '/usr/bin/systemd-run', systemctlPath = '/usr/bin/systemctl',
    executionIdentity = `native-root:${process.platform}:${process.arch}:node-${process.versions.node}`,
    env = {}, invoke = control } = {}) {
    this.jobsDirectory = resolve(jobsDirectory); this.homeDirectory = resolve(homeDirectory);
    this.workerPath = resolve(workerPath); this.pythonPath = pythonPath;
    this.systemdRunPath = systemdRunPath; this.systemctlPath = systemctlPath; this.invoke = invoke;
    this.kind = 'native-root'; this.nativeExecution = invoke === control;
    this.executionIdentity = executionIdentity;
    this.image = executionIdentity; // Compatibility with existing dependency provenance; not an OCI digest.
    this.env = { PATH: ROOT_PATH, LANG: 'C.UTF-8', HOME: this.homeDirectory, USER: 'root', LOGNAME: 'root', ...env };
  }
  get registryAccessEnabled() { return true; }
  get unrestrictedNetwork() { return true; }
  directory(name) {
    if (!NAME.test(name)) throw new RunnerError('RUNNER_INPUT', 'Invalid internal native job name.');
    return join(this.jobsDirectory, name);
  }
  logPath(name) { return join(this.directory(name), 'output.log'); }
  describeLogs(name) {
    return { stdout: join(this.directory(name), 'stdout.raw'), stderr: join(this.directory(name), 'stderr.raw'), events: this.logPath(name) };
  }
  async call(args, timeoutMs) { return this.invoke(this.systemctlPath, args, this.env, timeoutMs); }

  async create({ job, workspacePath }) {
    const name = containerName(job.id), directory = this.directory(name);
    if (!Array.isArray(job.argv) || !job.argv.length || job.argv.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !job.argv[0]) {
      throw new RunnerError('RUNNER_INPUT', 'Native jobs require a nonempty argv with no NUL characters.');
    }
    const timeoutSeconds = job.timeoutSeconds ?? 0;
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 0) throw new RunnerError('RUNNER_INPUT', 'Native timeout must be zero or positive whole seconds.');
    const cwd = await realpath(isAbsolute(job.cwd || '') ? job.cwd : resolve(workspacePath || this.homeDirectory, job.cwd || '.'));
    if (!(await lstat(cwd)).isDirectory()) throw new RunnerError('RUNNER_INPUT', 'Native command working directory must exist.');
    const environment = { PATH: ROOT_PATH, HOME: this.homeDirectory, USER: 'root', LOGNAME: 'root', SHELL: '/bin/bash', LANG: 'C.UTF-8', ...job.env };
    for (const [key, value] of Object.entries(environment)) {
      if (!key || /[=\0]/.test(key) || typeof value !== 'string' || value.includes('\0')) throw new RunnerError('RUNNER_INPUT', 'Invalid native environment entry.');
    }
    const request = { version: 1, name, argv: job.argv, cwd, env: environment, timeoutSeconds, executionIdentity: this.executionIdentity };
    await mkdir(this.homeDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.jobsDirectory, { recursive: true, mode: 0o700 });
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const saved = await json(join(directory, 'request.json'));
      if (!saved || !sameRequest(saved, request)) throw new RunnerError('RUNNER_CONFLICT', 'An existing native job has different or incomplete creation evidence; it will not be recreated.');
      return { id: name, name, logCursor: saved.logCursor, logFingerprint: saved.logFingerprint };
    }
    const seed = Buffer.from(`${clock()} stdout F PRAXIS_LOG_START ${name}\n`);
    await exclusive(this.logPath(name), seed);
    await exclusive(join(directory, 'stdout.raw'), Buffer.alloc(0));
    await exclusive(join(directory, 'stderr.raw'), Buffer.alloc(0));
    request.logCursor = seed.length; request.logFingerprint = `${seed.length}:${digest(seed)}`;
    request.createdAt = clock();
    await exclusive(join(directory, 'request.json'), JSON.stringify(request) + '\n');
    await syncDirectory(directory); await syncDirectory(this.jobsDirectory);
    return { id: name, name, logCursor: seed.length, logFingerprint: request.logFingerprint };
  }

  async start({ name }) {
    if (this.nativeExecution && (typeof process.getuid !== 'function' || process.getuid() !== 0)) {
      throw new RunnerError('RUNNER_ROOT_REQUIRED', 'Native host jobs require the root-owned Praxis runner service.');
    }
    const directory = this.directory(name), request = await json(join(directory, 'request.json'));
    if (!request) throw new RunnerError('RUNNER_NOT_FOUND', 'Native job creation evidence is missing.');
    try { await exclusive(join(directory, 'start-intent.json'), JSON.stringify({ name, intendedAt: clock() }) + '\n'); await syncDirectory(directory); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const state = await this.inspect({ name });
      if (state.running || state.exitCode !== null && state.exitCode !== undefined) return;
      throw new RunnerError('RUNNER_START_UNCERTAIN', 'This job already has a launch intent; no second launch will be issued.');
    }
    const args = ['--quiet', `--unit=${name}.service`, '--service-type=exec',
      '--property=User=root', '--property=Group=root', '--property=Restart=no',
      '--property=KillMode=control-group', '--property=ExitType=cgroup', '--property=RemainAfterExit=yes',
      '--property=TasksMax=infinity', '--property=MemoryMax=infinity', '--property=MemoryHigh=infinity', '--property=CPUQuota=',
      '--property=TimeoutStopSec=5', '--property=SendSIGKILL=yes', '--property=UMask=0077',
      '--property=StandardOutput=null', '--property=StandardError=journal',
      this.pythonPath, '-I', this.workerPath, directory];
    if (request.timeoutSeconds > 0) args.splice(args.indexOf(this.pythonPath), 0, `--property=RuntimeMaxSec=${request.timeoutSeconds + 5}`);
    const result = await this.invoke(this.systemdRunPath, args, this.env, 30000);
    if (result.code !== 0) throw new RunnerError('RUNNER_START_UNCERTAIN', 'Native service admission did not confirm success; inspect the existing job.');
    await atomic(join(directory, 'admission.json'), { name, acceptedAt: clock() });
  }

  async inspect({ name }) {
    const directory = this.directory(name), request = await json(join(directory, 'request.json'));
    if (!request) return { exists: false };
    const state = await json(join(directory, 'state.json'));
    const intent = await json(join(directory, 'start-intent.json'));
    if (!intent) return { exists: true, id: name, status: 'created', running: false, exitCode: null, monitorExitCode: null, startedAt: null, finishedAt: null };
    const response = await this.call(['show', `${name}.service`, '--no-pager',
      '--property=LoadState,ActiveState,SubState,MainPID,InvocationID,Result,ExecMainCode,ExecMainStatus,ControlGroup']);
    const values = Object.fromEntries(response.stdout.trim().split('\n').filter(line => line.includes('=')).map(line => {
      const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
    }));
    if (!values.LoadState || response.code !== 0 && values.LoadState !== 'not-found') {
      throw new RunnerError('RUNNER_INSPECT_FAILED', 'Native service state is unavailable; this job remains unresolved.');
    }
    const running = ['activating', 'deactivating', 'reloading'].includes(values.ActiveState) ||
      values.ActiveState === 'active' && values.SubState !== 'exited';
    if (running) return { exists: true, id: name, status: 'running', running: true,
      pid: Number(values.MainPID) || state?.pid || null, invocationId: values.InvocationID || null,
      exitCode: null, monitorExitCode: null, startedAt: state?.startedAt || null, finishedAt: null };
    if (state?.terminal === true) return { exists: true, id: name, status: 'exited', running: false,
      exitCode: state.exitCode, monitorExitCode: state.exitCode, signal: state.signal || null,
      oomKilled: values.Result === 'oom-kill', startedAt: state.startedAt, finishedAt: state.finishedAt,
      terminationReason: state.reason, invocationId: values.InvocationID || state.invocationId || null };
    // A start-intent with no surviving service/worker receipt never permits another start.
    // Expose uncertainty as an error, not absence: CodeJobs must retain its workspace lock.
    if (values.LoadState === 'not-found') throw new RunnerError('RUNNER_START_UNCERTAIN', 'Native launch outcome is unconfirmed; no second launch will be issued.');
    return { exists: true, id: name, status: 'exited', running: false, exitCode: null,
      monitorExitCode: null, signal: null, oomKilled: values.Result === 'oom-kill',
      startedAt: state?.startedAt || null, finishedAt: clock(), terminationReason: 'exit_unconfirmed' };
  }

  async stop({ name }) {
    this.directory(name);
    const state = await this.inspect({ name });
    if (!state.running) return;
    await atomic(join(this.directory(name), 'cancel-intent.json'), { requestedAt: clock() });
    const result = await this.call(['stop', `${name}.service`], 15000);
    if (result.code !== 0 || (await this.inspect({ name })).running) {
      throw new RunnerError('RUNNER_STOP_UNCONFIRMED', 'Native process-group termination is not confirmed; inspect the existing job.');
    }
  }

  async logs(options) {
    // The disk stream deliberately uses the existing CRI record syntax, keeping
    // cursors, UTF-8 continuation and partial records compatible with old jobs.
    const result = await PodmanRunner.prototype.logs.call(this, options);
    if (result.retention) {
      result.truncated = Boolean(result.recycled || result.skippedBytes);
      result.retention = 'persistent-native-log';
    }
    return { ...result, rawPaths: this.describeLogs(options.name) };
  }

  async remove({ name }) {
    const state = await this.inspect({ name });
    if (state.running) throw new RunnerError('RUNNER_RUNNING', 'A running native job cannot be removed.');
    // Keep request, complete raw output and terminal evidence for later diagnosis.
    // Stop clears RemainAfterExit without starting any command; reset-failed only
    // releases the transient unit's failure marker.
    await this.call(['stop', `${name}.service`], 15000);
    await this.call(['reset-failed', `${name}.service`]);
  }
}
