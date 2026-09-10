import { constants, mkdirSync, openSync, closeSync, fstatSync, readSync, writeSync, fsyncSync, fchmodSync, renameSync, readFileSync, lstatSync, existsSync, realpathSync, unlinkSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readSafe } from './paths.js';

export const DEPENDENCY_LIMITS = Object.freeze({ archiveBytes: 512 * 1024 * 1024, expandedBytes: 1024 * 1024 * 1024, fileBytes: 256 * 1024 * 1024, files: 100000,
  retainedBundles: 20, totalArchiveBytes: 2 * 1024 * 1024 * 1024 });
const PACK_SCRIPT = readFileSync(fileURLToPath(new URL('./dependency-pack.py', import.meta.url)), 'utf8');
export const dependencyPackCommand = image => ['python3', '-c', PACK_SCRIPT, image];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function failure(message) { return Object.assign(new Error(message), { code: 'DEPENDENCY_BUNDLE_FAILED' }); }

function hashPath(path) {
  const fd = openSync(path, constants.O_RDONLY), hash = createHash('sha256'), chunk = Buffer.alloc(1024 * 1024);
  try {
    if (!fstatSync(fd).isFile()) throw failure('Dependency manifest is not a regular file.');
    while (true) { const count = readSync(fd, chunk, 0, chunk.length, null); if (!count) break; hash.update(chunk.subarray(0, count)); }
    return hash.digest('hex');
  } finally { closeSync(fd); }
}

export function dependencyManifestHashes(workspacePath, { native = false } = {}) {
  const result = {};
  for (const [key, name] of [['packageJsonSha256', 'package.json'], ['packageLockSha256', 'package-lock.json'], ['shrinkwrapSha256', 'npm-shrinkwrap.json']]) {
    try { result[key] = native ? hashPath(join(workspacePath, name)) : digest(readSafe(workspacePath, name)); }
    catch (error) { if (error.code === 'ENOENT') result[key] = null; else throw error; }
  }
  return result;
}

function syncDirectory(path) {
  if (process.platform === 'win32') return;
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Copy only after the preparation job is terminal. Prepared bytes are untrusted;
 * deployment independently validates archive entries and exact Git manifests. */
export function sealDependencies({ workspacePath, directory, workspaceId, revision, jobId, image }) {
  const native = typeof image === 'string' && image.startsWith('native-root:');
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink() || realpathSync(root) !== root) throw failure('Unsafe dependency storage.');
  const hashes = dependencyManifestHashes(workspacePath, { native });
  if (!hashes.packageJsonSha256 || !(hashes.packageLockSha256 || hashes.shrinkwrapSha256)) throw failure('A package manifest and lockfile are required.');
  const metadata = JSON.parse(readSafe(workspacePath, '.cache/praxis-dependencies.json', 16384));
  if (Object.entries(hashes).some(([key, value]) => metadata[key] !== value)) throw failure('Dependency manifests changed during preparation.');
  if (!Number.isInteger(metadata.nodeMajor) || metadata.nodeMajor < 1 || typeof metadata.platform !== 'string' || typeof metadata.arch !== 'string'
    || (!native && (metadata.platform !== 'linux' || !['x64', 'arm64'].includes(metadata.arch) || metadata.nodeMajor < 22))) throw failure('Unsupported dependency runtime.');
  if (metadata.executionIdentity !== undefined && metadata.executionIdentity !== image) throw failure('Dependency execution identity changed.');
  // readSafe's small source limit does not apply to this bounded generated archive.
  const cache = join(workspacePath, '.cache');
  if (!lstatSync(cache).isDirectory() || lstatSync(cache).isSymbolicLink()) throw failure('Unsafe dependency cache.');
  const source = join(cache, 'praxis-dependencies.tar');
  const sourceStat = lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1 || (!native && sourceStat.size > DEPENDENCY_LIMITS.archiveBytes) || sourceStat.size < 1024) throw failure('Invalid dependency archive.');
  for (const name of readdirSync(root).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
    const saved = JSON.parse(readSafe(root, name, 16384));
    if (saved.jobId !== jobId) continue;
    if (saved.archiveSha256 !== name.slice(0, -5) || saved.workspaceId !== workspaceId || saved.revision !== revision
      || saved.image !== image || Object.entries(hashes).some(([key, value]) => saved[key] !== value)) throw failure('Saved preparation does not match this job.');
    const archive = lstatSync(join(root, `${saved.archiveSha256}.tar`));
    if (!archive.isFile() || archive.isSymbolicLink() || archive.nlink !== 1 || archive.size !== saved.archiveBytes) throw failure('Saved preparation archive is unavailable.');
    return saved; // Recover a sealed result after a crash before the DB receipt.
  }
  const retained = readdirSync(root).filter(name => /^[a-f0-9]{64}\.tar$/.test(name)).map(name => {
    const value = lstatSync(join(root, name));
    if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1) throw failure('Unsafe retained dependency bundle.');
    return { name, size: value.size };
  });
  // Reserve the incoming copy before any writes outside hard-capped workspaces.
  // Full retention needs explicit maintenance; old published bundles are never
  // silently removed while a deployment or recovery may still reference them.
  if (!native && (retained.length >= DEPENDENCY_LIMITS.retainedBundles || retained.reduce((total, file) => total + file.size, 0) + sourceStat.size > DEPENDENCY_LIMITS.totalArchiveBytes)) {
    throw failure('Dependency bundle retention is full; recover published references before owner maintenance.');
  }
  const temporary = join(root, `${jobId}.pending`);
  // A prior interrupted copy can be safely discarded: this name is derived from
  // the durable job UUID in protected storage, never from candidate input.
  if (existsSync(temporary)) {
    const old = lstatSync(temporary);
    if (!old.isFile() || old.isSymbolicLink() || old.nlink !== 1) throw failure('Unsafe pending dependency archive.');
    unlinkSync(temporary);
  }
  const output = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  let input;
  const hasher = createHash('sha256');
  let archiveSha256;
  try {
    input = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(input);
    if (before.ino !== sourceStat.ino || before.dev !== sourceStat.dev || before.nlink !== 1 || before.size !== sourceStat.size) throw failure('Dependency archive identity changed.');
    const chunk = Buffer.alloc(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const count = readSync(input, chunk, 0, Math.min(chunk.length, before.size - offset), offset);
      if (!count) throw failure('Dependency archive was shortened.');
      hasher.update(chunk.subarray(0, count));
      let written = 0;
      while (written < count) written += writeSync(output, chunk, written, count - written);
      offset += count;
    }
    const after = fstatSync(input);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw failure('Dependency archive changed while sealing.');
    if (process.platform !== 'win32') fchmodSync(output, 0o640);
    fsyncSync(output); archiveSha256 = hasher.digest('hex');
  } finally {
    if (input !== undefined) closeSync(input); closeSync(output);
    if (!archiveSha256) unlinkSync(temporary);
  }
  renameSync(temporary, join(root, `${archiveSha256}.tar`));
  const savedPath = join(root, `${archiveSha256}.json`);
  if (existsSync(savedPath)) {
    const saved = JSON.parse(readSafe(root, `${archiveSha256}.json`, 16384));
    if (saved.archiveSha256 !== archiveSha256 || Object.entries(hashes).some(([key, value]) => saved[key] !== value)
      || saved.image !== image || saved.nodeMajor !== metadata.nodeMajor || saved.platform !== metadata.platform || saved.arch !== metadata.arch) {
      throw failure('Identical archive already has different immutable dependency metadata; reinstall dependencies before preparing.');
    }
    return saved;
  }
  const manifest = { version: 1, archiveSha256, archiveBytes: sourceStat.size, ...hashes,
    workspaceId, revision, jobId, image, platform: metadata.platform, arch: metadata.arch, nodeMajor: metadata.nodeMajor,
    ...(native ? { executionMode: 'native', executionIdentity: image } : {}),
    nodeVersion: metadata.nodeVersion, createdAt: new Date().toISOString(), validation: 'Prepared bytes only; run application tests separately.' };
  const manifestPath = join(root, `${archiveSha256}.json.pending`);
  const manifestFd = openSync(manifestPath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeSync(manifestFd, JSON.stringify(manifest)); if (process.platform !== 'win32') fchmodSync(manifestFd, 0o640); fsyncSync(manifestFd); } finally { closeSync(manifestFd); }
  renameSync(manifestPath, savedPath); syncDirectory(root);
  return manifest;
}
