#!/usr/bin/env node
// Run as praxis-code under the installed service's hardened systemd policy.
// Reuse the explicit run ID after interruption; durable requests prevent reruns.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync, fsyncSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CodeStore } from '../src/code/store.js';
import { WorkspaceManager } from '../src/code/workspaces.js';
import { CodeJobs } from '../src/code/jobs.js';
import { PodmanRunner } from '../src/code/runner.js';

assert.equal(process.platform, 'linux');
assert.notEqual(process.getuid(), 0, 'Never execute project code as host root.');
assert.equal(process.argv.length, 4, 'Supply protected config path and a stable UUID run ID.');
const runId = process.argv[3];
assert.match(runId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const configBytes = readFileSync(resolve(process.argv[2]));
const config = JSON.parse(configBytes);
const hash = value => createHash('sha256').update(value).digest('hex');
const root = `/var/lib/praxis-code/project-validation-${runId}`;
const dataDirectory = join(root, 'state');
const workspaceDirectory = `/srv/praxis-code/storage/workspaces/validation-${runId}`;
const logDirectory = `/srv/praxis-code/storage/container-logs/validation-${runId}`;
mkdirSync(root, { recursive: true, mode: 0o700 });
const controlPath = join(root, 'control.json');
const evidencePath = join(root, 'evidence.json');
function durableJson(path, value) {
  const fd = openSync(`${path}.pending`, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(`${path}.pending`, path);
  const directory = openSync(root, 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
const control = existsSync(controlPath) ? JSON.parse(readFileSync(controlPath)) : {
  configSha256: hash(configBytes), runId, startedAt: new Date().toISOString(), requests: {}, workspaces: {}, results: {},
};
assert.equal(control.configSha256, hash(configBytes), 'Resume requires the same protected configuration.');
const evidence = existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath)) : {
  evidenceKind: 'actual-rootless-container-clean-project-validation', runId, startedAt: control.startedAt,
  release: config.release, image: config.runnerConfig.image, hostUid: process.getuid(), projects: [],
  scope: 'Clean immutable registered snapshots, offline prepared dependencies, separate disposable workspaces; no implementation attempt or phone run.',
  dependencyPreparation: { default: 'npm ci --ignore-scripts --no-audit --no-fund',
    historicalReplay: 'npm ci --ignore-scripts --legacy-peer-deps --no-audit --no-fund',
    ffmpegStatic: 'Read-only symlink to the image system ffmpeg; lifecycle scripts were not run.' },
};
const checkpoint = () => { durableJson(controlPath, control); durableJson(evidencePath, evidence); };
checkpoint();
const store = new CodeStore(dataDirectory);
const runner = new PodmanRunner({ ...config.runnerConfig, workspaceRoot: workspaceDirectory, logDirectory });
const jobs = new CodeJobs({ store, dataDirectory, runner });
const workspaces = new WorkspaceManager({ store, dataDirectory, workspaceDirectory, projects: config.projects });
jobs.workspaces = workspaces;
const owner = 'jensen';
const active = new Set(['queued', 'starting', 'running', 'canceling']);
function logs(jobId) {
  let cursor = 0, text = '', pages = 0;
  for (;;) {
    const page = jobs.logs({ owner, jobId, cursor, limit: 100 });
    text += page.records.filter(row => row.stream !== 'system').map(row => row.text).join('');
    assert.ok(page.nextCursor >= cursor); cursor = page.nextCursor; pages++;
    if (!page.hasMore) return { text, pages, records: cursor, truncated: page.truncated };
    assert.ok(pages < 1000);
  }
}
function workspace(project) {
  if (control.workspaces[project.id]) return control.workspaces[project.id];
  // Input is deterministic: replaying this receipt after interruption cannot create a second workspace.
  const receipt = workspaces.create({ owner, projectId: project.id, baseRevision: project.revision,
    idempotencyKey: `validation-workspace-${runId}-${project.id}`, label: `Clean validation ${project.id}` });
  control.workspaces[project.id] = receipt.result.workspaceId; checkpoint();
  return receipt.result.workspaceId;
}
async function run(key, workspaceId, argv) {
  if (!control.requests[key]) {
    control.requests[key] = { owner, workspaceId, expectedRevision: workspaces.getExecutionWorkspace({ owner, workspaceId }).revision,
      idempotencyKey: `validation-${runId}-${key}`, label: `Clean validation ${key}`, argv, timeoutSeconds: 180 };
    checkpoint();
  }
  const accepted = jobs.start(control.requests[key]);
  control.results[key] ??= { jobId: accepted.id }; checkpoint();
  const deadline = Date.now() + 330000;
  for (;;) {
    await jobs.tick();
    const job = jobs.get({ owner, jobId: accepted.id });
    if (!active.has(job.status)) {
      const output = logs(job.id);
      const summary = { jobId: job.id, status: job.status, exitCode: job.exitCode, terminationReason: job.terminationReason,
        startedAt: job.startedAt, finishedAt: job.finishedAt, outputBytes: job.outputBytes,
        logSha256: hash(output.text), logRecords: output.records, logPages: output.pages,
        truncated: job.truncated || output.truncated, executionError: job.executionError };
      control.results[key] = summary; checkpoint();
      return { summary, text: output.text };
    }
    if (Date.now() >= deadline) throw new Error('Observation deadline reached; recover this same run ID before further action.');
    await delay(200);
  }
}
const provenanceProgram = `
  const fs = require('node:fs'), cp = require('node:child_process'), crypto = require('node:crypto');
  const versions = {};
  for (const [name, command, args] of [
    ['node','node',['--version']], ['npm','npm',['--version']], ['python','python3',['--version']],
    ['git','git',['--version']], ['ripgrep','rg',['--version']], ['ffmpeg','ffmpeg',['-version']]
  ]) {
    const result = cp.spawnSync(command,args,{encoding:'utf8'});
    if (result.status !== 0) throw new Error('Version command failed: '+name);
    versions[name] = result.stdout.trim().split('\\n')[0];
  }
  const bundles = {};
  for (const id of ['discord','discord-replay-speech-first','praxis']) {
    bundles[id] = {};
    for (const file of ['package.json','package-lock.json']) {
      bundles[id][file] = crypto.createHash('sha256').update(fs.readFileSync('/opt/praxis/deps/'+id+'/'+file)).digest('hex');
    }
    bundles[id].nodeModulesExists = fs.statSync('/opt/praxis/deps/'+id+'/node_modules').isDirectory();
  }
  console.log('PRAXIS_RUNTIME_PROVENANCE '+JSON.stringify({versions,bundles}));
`;
// The wrapper observes child closure. Suite-specific summaries below separately prove suite completion.
const wrapped = argv => ['node', '--input-type=module', '-e', `
  import { spawn } from 'node:child_process';
  const argv = ${JSON.stringify(argv)};
  const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit' });
  child.on('error', () => { console.error('PRAXIS_VALIDATION_SPAWN_ERROR'); process.exitCode = 1; });
  child.on('close', (code, signal) => {
    console.log('PRAXIS_VALIDATION_CHILD_CLOSED '+JSON.stringify({code,signal}));
    process.exitCode = Number.isInteger(code) && code >= 0 ? code : 1;
  });
`];
function suiteSummary(projectId, text) {
  const custom = [...text.matchAll(/Tests complete: (\d+) passed, (\d+) failed/g)].map(match => ({ passed: +match[1], failed: +match[2] }));
  const tap = {};
  for (const name of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const values = [...text.matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, 'gm'))];
    if (values.length) tap[name] = +values.at(-1)[1];
  }
  const python = /Ran (\d+) tests? in ([\d.]+)s\s+([\s\S]*?)(?=PRAXIS_VALIDATION_CHILD_CLOSED|$)/.exec(text);
  const pythonSummary = python ? { tests: +python[1], durationSeconds: +python[2], result: /^OK(?:\s|$)/.test(python[3]) ? 'OK' : 'FAILED' } : null;
  const child = /PRAXIS_VALIDATION_CHILD_CLOSED (\{[^\n]+\})/.exec(text);
  const childClosure = child ? JSON.parse(child[1]) : null;
  const customPassed = custom.length > 0 && custom.at(-1).passed > 0 && custom.at(-1).failed === 0;
  const tapPassed = tap.tests > 0 && tap.fail === 0 && tap.cancelled === 0;
  const suiteCompleted = projectId === 'production' ? Boolean(pythonSummary)
    : projectId === 'praxis' ? Boolean(tap.tests) : custom.length > 0 && (projectId !== 'discord' || Boolean(tap.tests));
  const suitePassed = projectId === 'production' ? pythonSummary?.result === 'OK'
    : projectId === 'praxis' ? tapPassed : customPassed && (projectId !== 'discord' || tapPassed);
  return { custom, tap, python: pythonSummary, childClosure, suiteCompleted, suitePassed: Boolean(suitePassed) };
}

try {
  await jobs.recover();
  const ids = ['discord', 'production', 'praxis', 'discord-replay-speech-first'];
  const projects = ids.map(id => { const p = config.projects.find(value => value.id === id); assert.ok(p); return p; });
  const provenance = await run('provenance', workspace(projects[0]), ['node', '-e', provenanceProgram]);
  const match = /^PRAXIS_RUNTIME_PROVENANCE (.+)$/m.exec(provenance.text);
  assert.equal(provenance.summary.status, 'completed'); assert.equal(provenance.summary.exitCode, 0);
  assert.ok(match); evidence.runtime = { ...JSON.parse(match[1]), job: provenance.summary }; checkpoint();
  for (const project of projects) {
    const workspaceId = workspace(project);
    const item = { projectId: project.id, sourceRevision: project.revision, workspaceId, commands: [], sourceManifests: {} };
    for (const file of ['package.json', 'package-lock.json']) {
      const path = join(project.snapshotPath, file);
      if (existsSync(path)) item.sourceManifests[file] = hash(readFileSync(path));
    }
    const bundle = evidence.runtime.bundles[project.id];
    item.dependencyManifestsMatchSource = bundle ? Object.entries(item.sourceManifests).every(([file, value]) => bundle[file] === value) : null;
    for (let i = 0; i < project.validationCommands.length; i++) {
      const result = await run(`${project.id}-${i}`, workspaceId, wrapped(project.validationCommands[i]));
      const summary = suiteSummary(project.id, result.text);
      item.commands.push({ commandIndex: i, ...result.summary, ...summary,
        acceptedAsPassing: result.summary.status === 'completed' && result.summary.exitCode === 0 && !result.summary.truncated && summary.suitePassed && summary.childClosure?.code === 0 });
    }
    item.passed = item.commands.every(command => command.acceptedAsPassing) && item.dependencyManifestsMatchSource !== false;
    evidence.projects = [...evidence.projects.filter(value => value.projectId !== project.id), item]; checkpoint();
    process.stdout.write(JSON.stringify({ event: 'PROJECT_VALIDATED', projectId: project.id, passed: item.passed,
      commands: item.commands.map(({ status, exitCode, suiteCompleted, custom, tap, python }) => ({ status, exitCode, suiteCompleted, custom, tap, python })) }) + '\n');
  }
  evidence.completedAt = new Date().toISOString();
  evidence.status = 'completed'; evidence.passed = evidence.projects.every(project => project.passed);
  if (!evidence.passed) process.exitCode = 1;
} catch (error) {
  evidence.status = 'interrupted'; evidence.passed = false;
  evidence.failure = { name: error.name, code: error.code ?? null, message: error.message.slice(0, 500) };
  process.exitCode = 1;
} finally {
  checkpoint(); store.close();
  process.stdout.write(JSON.stringify({ event: 'RESULT', runId, status: evidence.status, passed: evidence.passed, evidencePath }) + '\n');
}
