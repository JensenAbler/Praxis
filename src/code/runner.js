import { spawn } from 'node:child_process';
import { mkdir, open, lstat, realpath, rm } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

const NAME = /^praxis-code-[0-9a-f-]{36}$/;
const MAX_LOG_BYTES = 16 * 1024 * 1024;

export class RunnerError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Spawn only the administrator-selected Podman binary, never a host shell. */
function command(binary, args, env, timeoutMs = 30000) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const buffers = { stdout: [], stderr: [] };
    let bytes = 0;
    let problem;
    const timeout = setTimeout(() => {
      problem = new RunnerError('RUNNER_TIMEOUT', 'The container control command did not return in time; inspect the existing job.');
      child.kill('SIGKILL');
    }, timeoutMs);
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        problem = new RunnerError('RUNNER_OUTPUT_LIMIT', 'The container control response exceeded its limit.');
        child.kill('SIGKILL');
      } else buffers[stream].push(chunk);
    });
    child.on('error', () => { clearTimeout(timeout); reject(new RunnerError('RUNNER_UNAVAILABLE', 'The container runtime could not be invoked.')); });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (problem) reject(problem);
      else resolveResult({ code, signal, stdout: Buffer.concat(buffers.stdout).toString('utf8'), stderr: Buffer.concat(buffers.stderr).toString('utf8') });
    });
  });
}

export function containerName(jobId) {
  const name = `praxis-code-${jobId}`;
  if (!NAME.test(name)) throw new RunnerError('RUNNER_INPUT', 'Invalid internal job identifier.');
  return name;
}

/** The containing systemd unit supplies aggregate CPU/memory/PID limits. */
export class PodmanRunner {
  constructor({ image, workspaceRoot, logDirectory, storageRoot = '/srv/praxis-code/storage/containers', runRoot = '/run/praxis-code/storage', runtimeBinary = '/usr/bin/crun', binary = '/usr/bin/podman', env, invoke = command }) {
    if (typeof image !== 'string' || !/^(?:[a-z0-9./:_-]+@)?sha256:[0-9a-f]{64}$/.test(image)) {
      throw new RunnerError('RUNNER_CONFIG', 'The executor image must be an immutable SHA-256 digest.');
    }
    if (!workspaceRoot || !logDirectory) throw new RunnerError('RUNNER_CONFIG', 'Protected executor paths are required.');
    this.image = image;
    this.workspaceRoot = resolve(workspaceRoot);
    this.logDirectory = resolve(logDirectory);
    this.binary = binary;
    this.globalArgs = ['--root', resolve(storageRoot), '--runroot', resolve(runRoot), '--cgroup-manager=cgroupfs', `--runtime=${runtimeBinary}`];
    // No process.env spread: OAuth, SSH, proxy, and registry credentials cannot flow in accidentally.
    this.env = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', ...env };
    this.invoke = invoke;
  }

  async call(args, timeoutMs) { return this.invoke(this.binary, [...this.globalArgs, ...args], this.env, timeoutMs); }

  logPath(name) {
    if (!NAME.test(name)) throw new RunnerError('RUNNER_INPUT', 'Invalid internal container name.');
    return join(this.logDirectory, `${name}.log`);
  }

  async create({ job, workspacePath }) {
    const name = containerName(job.id);
    const root = await realpath(this.workspaceRoot);
    const workspace = await realpath(workspacePath);
    const child = relative(root, workspace);
    if (!child || child.startsWith('..') || isAbsolute(child) || /[,\n\r]/.test(workspace)) {
      throw new RunnerError('WORKSPACE_PATH', 'The execution workspace is outside its configured storage.');
    }
    if (!(await lstat(workspacePath)).isDirectory() || (await lstat(workspacePath)).isSymbolicLink()) {
      throw new RunnerError('WORKSPACE_PATH', 'Execution requires a regular workspace directory.');
    }
    await mkdir(this.logDirectory, { recursive: true, mode: 0o700 });
    // Seed a private prefix before execution. If output recycles before the first poll, its loss is detectable.
    const seed = Buffer.from(`${new Date().toISOString()} stdout F PRAXIS_LOG_START ${name}\n`);
    const seededLog = await open(this.logPath(name), 'wx', 0o600);
    try { await seededLog.writeFile(seed); await seededLog.sync(); } finally { await seededLog.close(); }
    if (process.platform !== 'win32') {
      const directory = await open(this.logDirectory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
    const logFingerprint = `${seed.length}:${createHash('sha256').update(seed).digest('hex')}`;
    const args = [
      '--events-backend=none', 'create', '--name', name, '--pull=never',
      '--network=none', '--cgroups=disabled', '--read-only', '--read-only-tmpfs=false',
      '--cap-drop=ALL', '--security-opt=no-new-privileges', '--image-volume=ignore',
      '--http-proxy=false', '--systemd=false', '--userns=keep-id', '--pids-limit=-1',
      '--hostname=praxis-workspace', '--timeout', String(job.timeoutSeconds), '--stop-timeout=2',
      '--log-driver=k8s-file', '--log-opt', `path=${this.logPath(name)}`,
      '--log-opt', `max-size=${MAX_LOG_BYTES}`, '--shm-size=32m',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=134217728,mode=1777',
      '--tmpfs', '/home:rw,nosuid,nodev,size=67108864,mode=1777',
      '--tmpfs', '/run:rw,nosuid,nodev,size=16777216,mode=755',
      '--mount', `type=bind,src=${workspace},dst=/workspace,rw`,
      '--workdir', job.cwd === '.' ? '/workspace' : `/workspace/${job.cwd}`,
      '--env', 'HOME=/home', '--env', 'TMPDIR=/tmp', '--env', 'CI=1',
      '--env', 'LANG=C.UTF-8', '--env', 'GIT_CONFIG_NOSYSTEM=1', '--env', 'GIT_CONFIG_GLOBAL=/dev/null',
      '--env', 'GIT_TERMINAL_PROMPT=0', '--env', 'NPM_CONFIG_CACHE=/tmp/npm-cache',
    ];
    for (const [key, value] of Object.entries(job.env)) args.push('--env', `${key}=${value}`);
    // Empty image entrypoint ensures that argv is exactly the sandbox command supplied by the caller.
    args.push('--entrypoint=', this.image, ...job.argv);
    // Initial keep-id preparation may materialize a shifted image layer. It remains a persisted starting job.
    const result = await this.call(args, 120000);
    if (result.code !== 0) throw new RunnerError('CONTAINER_CREATE_FAILED', 'Container preparation failed. The persisted job will be reconciled before another execution is allowed.');
    const id = result.stdout.trim();
    if (!/^[0-9a-f]{64}$/.test(id)) throw new RunnerError('RUNNER_RESPONSE', 'Container creation returned an invalid identifier.');
    return { id, name, logCursor: seed.length, logFingerprint };
  }

  async start({ name }) {
    this.logPath(name);
    const result = await this.call(['--events-backend=none', 'start', name]);
    if (result.code !== 0) throw new RunnerError('CONTAINER_START_FAILED', 'The container start result is uncertain; inspect the persisted job.');
  }

  async inspect({ name }) {
    this.logPath(name);
    const result = await this.call(['--events-backend=none', 'container', 'inspect', name]);
    if (result.code !== 0) {
      const exists = await this.call(['--events-backend=none', 'container', 'exists', name]);
      if (exists.code === 1) return { exists: false };
      throw new RunnerError('CONTAINER_INSPECT_FAILED', 'The container runtime cannot currently establish this job’s state.');
    }
    let value;
    try { value = JSON.parse(result.stdout)[0]; } catch { throw new RunnerError('RUNNER_RESPONSE', 'The container runtime returned invalid state.'); }
    if (!value?.Id || !value?.State) throw new RunnerError('RUNNER_RESPONSE', 'The container runtime returned incomplete state.');
    const state = value.State;
    return {
      exists: true, id: value.Id, pid: state.Pid ?? null, status: state.Status, running: Boolean(state.Running),
      exitCode: state.Running || ['configured', 'created'].includes(state.Status) || state.ExitCode < 0 ? null : state.ExitCode,
      monitorExitCode: state.Running || ['configured', 'created'].includes(state.Status) ? null : state.ExitCode,
      signal: null, oomKilled: Boolean(state.OOMKilled),
      startedAt: state.StartedAt && !state.StartedAt.startsWith('0001-') ? state.StartedAt : null,
      finishedAt: state.FinishedAt && !state.FinishedAt.startsWith('0001-') ? state.FinishedAt : null,
    };
  }

  async stop({ name }) {
    this.logPath(name);
    const result = await this.call(['--events-backend=none', 'stop', '--time=2', name], 15000);
    if (result.code !== 0) {
      const state = await this.inspect({ name });
      if (state.running) throw new RunnerError('CONTAINER_STOP_FAILED', 'Cancellation has not been confirmed; the workspace remains locked.');
    }
  }

  async logs({ name, cursor = 0, fingerprint = null, limitBytes = 262144, final = false }) {
    const path = this.logPath(name);
    let handle;
    try { handle = await open(path, 'r'); } catch (error) {
      if (error.code === 'ENOENT') return { records: [], cursor, fingerprint, truncated: cursor > 0 || Boolean(fingerprint), hasMore: false };
      throw error;
    }
    try {
      const stat = await handle.stat();
      const head = Buffer.alloc(Math.min(stat.size, 256));
      await handle.read(head, 0, head.length, 0);
      // Persist the prefix length as well as its digest: appending a partial first record is not recycling.
      const firstEnd = head.indexOf(10);
      const prefixLength = firstEnd >= 0 ? firstEnd + 1 : head.length;
      const candidateFingerprint = prefixLength ? `${prefixLength}:${createHash('sha256').update(head.subarray(0, prefixLength)).digest('hex')}` : null;
      const previous = fingerprint && /^(\d+):([a-f0-9]{64})$/.exec(fingerprint);
      const changedPrefix = previous && (head.length < Number(previous[1]) || createHash('sha256').update(head.subarray(0, Number(previous[1]))).digest('hex') !== previous[2]);
      const recycled = stat.size < cursor || Boolean(changedPrefix);
      const headDigest = recycled ? candidateFingerprint : fingerprint ?? candidateFingerprint;
      const begin = recycled ? 0 : cursor;
      const buffer = Buffer.alloc(Math.min(limitBytes, Math.max(0, stat.size - begin)));
      await handle.read(buffer, 0, buffer.length, begin);
      let complete = buffer.lastIndexOf(10) + 1;
      const incompleteFinal = final && begin + buffer.length >= stat.size && complete < buffer.length;
      if (incompleteFinal) complete = buffer.length;
      // A malicious very long line must not stall the collector indefinitely.
      if (!complete && buffer.length === limitBytes) complete = buffer.length;
      const data = buffer.subarray(0, complete).toString('utf8');
      const records = data.split('\n').filter(Boolean).map(line => {
        const match = /^(\S+) (stdout|stderr) ([FP]) (.*)$/.exec(line);
        return match ? { timestamp: match[1], stream: match[2], partial: match[3] === 'P', text: match[4] + (match[3] === 'F' ? '\n' : '') }
          : { timestamp: new Date().toISOString(), stream: 'stdout', partial: true, text: line };
      });
      return {
        records, cursor: begin + complete, fingerprint: headDigest ?? fingerprint,
        truncated: recycled || incompleteFinal || stat.size >= MAX_LOG_BYTES - 8192,
        hasMore: begin + complete < stat.size, retention: 'bounded-container-log',
      };
    } finally { await handle.close(); }
  }

  async remove({ name }) {
    this.logPath(name);
    const state = await this.inspect({ name });
    if (state.running) throw new RunnerError('CONTAINER_RUNNING', 'A running container cannot be removed by cleanup.');
    if (state.exists) {
      const result = await this.call(['--events-backend=none', 'rm', name]);
      if (result.code !== 0) throw new RunnerError('CONTAINER_REMOVE_FAILED', 'Completed container cleanup failed.');
    }
    await rm(this.logPath(name), { force: true });
  }
}
