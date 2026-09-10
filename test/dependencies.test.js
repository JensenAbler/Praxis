import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { dependencyManifestHashes, sealDependencies, DEPENDENCY_LIMITS } from '../src/code/dependencies.js';

const digest = value => createHash('sha256').update(value).digest('hex');
function fixture(t, { native = true, largeManifest = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'praxis-dependency-seal-')), workspacePath = join(root, 'workspace'), directory = join(root, 'sealed');
  mkdirSync(join(workspacePath, '.cache'), { recursive: true }); mkdirSync(directory);
  writeFileSync(join(workspacePath, 'package.json'), '{"name":"fixture"}');
  writeFileSync(join(workspacePath, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, padding: largeManifest ? 'x'.repeat(3 * 1024 * 1024) : '' }));
  const image = native ? 'native-root:linux:x64:fixture' : `sha256:${'a'.repeat(64)}`;
  const hashes = dependencyManifestHashes(workspacePath, { native });
  const metadata = { ...hashes, platform: 'linux', arch: 'x64', nodeMajor: 22, nodeVersion: 'v22.23.2', ...(native ? { executionMode: 'native', executionIdentity: image } : {}) };
  const archive = Buffer.alloc(10240, 42);
  writeFileSync(join(workspacePath, '.cache', 'praxis-dependencies.tar'), archive);
  writeFileSync(join(workspacePath, '.cache', 'praxis-dependencies.json'), JSON.stringify(metadata));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, archive, hashes, metadata, options: { workspacePath, directory, workspaceId: randomUUID(), revision: 'live-native-revision', jobId: randomUUID(), image } };
}

test('native preparation seals exact bytes and large manifest hashes without claiming a container image', t => {
  const f = fixture(t, { largeManifest: true });
  const result = sealDependencies(f.options);
  assert.equal(result.version, 1);
  assert.equal(result.executionMode, 'native');
  assert.equal(result.executionIdentity, f.options.image);
  assert.equal(result.image, f.options.image); // Legacy field remains for existing readers.
  assert.equal(result.packageLockSha256, f.hashes.packageLockSha256);
  assert.equal(result.archiveSha256, digest(f.archive));
  assert.deepEqual(readFileSync(join(f.options.directory, `${result.archiveSha256}.tar`)), f.archive);
  assert.deepEqual(sealDependencies(f.options), result); // Recover after seal but before the job receipt.
});

test('native retention has no legacy count quota while container compatibility keeps its prior limit', t => {
  for (const native of [true, false]) {
    const f = fixture(t, { native });
    for (let number = 0; number < DEPENDENCY_LIMITS.retainedBundles + 1; number++) writeFileSync(join(f.options.directory, `${number.toString(16).padStart(64, '0')}.tar`), 'retained fixture');
    if (native) assert.equal(sealDependencies(f.options).executionMode, 'native');
    else assert.throws(() => sealDependencies(f.options), /retention is full/);
  }
});

test('legacy manifests remain compatible and native preparation still rejects stale manifests and execution identities', t => {
  const legacy = fixture(t, { native: false });
  const sealed = sealDependencies(legacy.options);
  assert.equal(sealed.executionMode, undefined);
  assert.equal(sealed.image, legacy.options.image);
  const native = fixture(t);
  writeFileSync(join(native.options.workspacePath, 'package.json'), '{"name":"changed"}');
  assert.throws(() => sealDependencies(native.options), /manifests changed/);
  const identity = fixture(t);
  writeFileSync(join(identity.options.workspacePath, '.cache', 'praxis-dependencies.json'), JSON.stringify({ ...identity.metadata, executionIdentity: 'native-root:different' }));
  assert.throws(() => sealDependencies(identity.options), /execution identity changed/);
});
