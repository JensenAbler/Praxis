import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { devNull } from 'node:os';

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MODES = new Set(['100644', '100755']);
const MAX_BLOB_BYTES = 2 * 1024 * 1024;
const MAX_TREE_BYTES = 16 * 1024 * 1024;
const MAX_CHANGE_BYTES = 128 * 1024 * 1024;
// Git for Windows accepts NUL, whereas Node's \\.\nul spelling is rejected by Git's config reader.
const GIT_DEV_NULL = process.platform === 'win32' ? 'NUL' : devNull;

export class GitTransportError extends Error {
  constructor(code, message, details = {}) {
    super(message); this.name = 'GitTransportError'; this.code = code;
    Object.assign(this, details);
  }
}

function requireValue(condition, message, code = 'INVALID_ARGUMENT') {
  if (!condition) throw new GitTransportError(code, message);
}

function oid(value) {
  requireValue(typeof value === 'string' && OID.test(value), 'A full Git object ID is required.');
  return value;
}

export function validateGitPath(value) {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= 1024
    && !/[\\:\x00-\x1f\x7f]/.test(value) && !value.startsWith('/'), 'Invalid repository path.');
  requireValue(value.split('/').every(part => part && part !== '.' && part !== '..'
    && !/^\.git(?:[ .]|$)/i.test(part) && !/^git~[1-9]$/i.test(part)), 'Invalid repository path.');
  return value;
}

function validateBranch(value) {
  requireValue(typeof value === 'string' && value.length <= 200 && value.length > 0
    && !value.startsWith('-') && !value.startsWith('/') && !value.endsWith('/') && !value.endsWith('.')
    && !value.includes('..') && !value.includes('@{') && !/[\s~^:?*\[\\\x00-\x1f\x7f]/.test(value)
    && value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock')),
  'Invalid Git branch.');
  return value;
}

function identity(value) {
  requireValue(value && typeof value.name === 'string' && value.name.trim().length > 0 && value.name.length <= 200
    && !/[<>\x00-\x1f\x7f]/.test(value.name) && typeof value.email === 'string'
    && /^[^<>\s@]+@[^<>\s@]+$/.test(value.email) && value.email.length <= 254, 'A valid Git author identity is required.');
  return { name: value.name, email: value.email };
}

function remote(value, allowLocalRemotes) {
  requireValue(typeof value === 'string', 'A configured repository remote is required.', 'INVALID_CONFIGURATION');
  if (allowLocalRemotes && isAbsolute(value)) return resolve(value);
  requireValue(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(value)
    || /^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(value)
    || /^ssh:\/\/git@github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(value),
  'Only a fixed GitHub HTTPS or SSH remote is allowed.', 'INVALID_CONFIGURATION');
  return value;
}

/** Only trusted bare repositories and fixed transport configuration enter this class. No checkout occurs. */
export class TrustedGit {
  constructor({ repositories, homeDirectory, gitPath = 'git', transportEnv = {}, allowLocalRemotes = false }) {
    requireValue(Array.isArray(repositories) && repositories.length > 0, 'Repository configuration is required.', 'INVALID_CONFIGURATION');
    requireValue(isAbsolute(homeDirectory), 'Git home must be an absolute protected directory.', 'INVALID_CONFIGURATION');
    const home = lstatSync(homeDirectory);
    requireValue(home.isDirectory() && !home.isSymbolicLink(), 'Git home must be an ordinary protected directory.', 'INVALID_CONFIGURATION');
    this.gitPath = gitPath;
    this.allowLocalRemotes = allowLocalRemotes;
    this.repositories = new Map();
    for (const item of repositories) {
      requireValue(typeof item.projectId === 'string' && item.projectId && !this.repositories.has(item.projectId),
        'Unique configured project IDs are required.', 'INVALID_CONFIGURATION');
      requireValue(isAbsolute(item.directory), 'Git repository must have an absolute protected path.', 'INVALID_CONFIGURATION');
      const stat = lstatSync(item.directory);
      requireValue(stat.isDirectory() && !stat.isSymbolicLink(), 'Git repository must be an ordinary protected directory.', 'INVALID_CONFIGURATION');
      const defaultBranch = validateBranch(item.defaultBranch || 'main');
      const allowedBranches = (item.allowedBranches || [defaultBranch]).map(validateBranch);
      requireValue(allowedBranches.includes(defaultBranch), 'Default branch must be allowed.', 'INVALID_CONFIGURATION');
      this.repositories.set(item.projectId, Object.freeze({ ...item, directory: resolve(item.directory),
        remoteUrl: remote(item.remoteUrl, allowLocalRemotes), defaultBranch, allowedBranches: Object.freeze(allowedBranches),
        author: identity(item.author || { name: 'Praxis', email: 'praxis@users.noreply.github.com' }) }));
    }
    this.env = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP']) {
      if (process.env[key] !== undefined) this.env[key] = process.env[key];
    }
    Object.assign(this.env, { HOME: homeDirectory, USERPROFILE: homeDirectory, XDG_CONFIG_HOME: homeDirectory,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: GIT_DEV_NULL, GIT_CONFIG_GLOBAL: GIT_DEV_NULL,
      GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1',
      GIT_OPTIONAL_LOCKS: '0', GIT_PROTOCOL_FROM_USER: '0', LC_ALL: 'C', LANG: 'C' });
    const allowedEnv = new Set(['GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'GIT_ASKPASS', 'SSH_ASKPASS']);
    for (const [key, value] of Object.entries(transportEnv)) {
      requireValue(allowedEnv.has(key) && typeof value === 'string' && !value.includes('\0'),
        'Unsupported Git transport environment setting.', 'INVALID_CONFIGURATION');
      this.env[key] = value;
    }
  }

  repository(projectId) {
    const repository = this.repositories.get(projectId);
    requireValue(repository, 'Project has no configured Git publication target.', 'PROJECT_NOT_FOUND');
    return repository;
  }

  branch(repository, value) {
    const branch = validateBranch(value || repository.defaultBranch);
    requireValue(repository.allowedBranches.includes(branch), 'Branch is not an allowed publication target.', 'BRANCH_NOT_ALLOWED');
    return branch;
  }

  async command(repository, args, { input, maxBuffer = MAX_TREE_BYTES, env, timeout = 120000, acceptedCodes = [0] } = {}) {
    const fixed = ['--git-dir', repository.directory,
      '-c', `core.hooksPath=${GIT_DEV_NULL}`, '-c', 'core.fsmonitor=false',
      '-c', 'core.sshCommand=ssh', '-c', 'credential.helper=', '-c', 'commit.gpgSign=false',
      '-c', 'tag.gpgSign=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
      '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always',
      '-c', `protocol.file.allow=${this.allowLocalRemotes ? 'always' : 'never'}`];
    return new Promise((resolvePromise, reject) => {
      const child = execFile(this.gitPath, [...fixed, ...args], { env: { ...this.env, ...env },
        cwd: repository.directory, windowsHide: true, encoding: 'buffer', maxBuffer, timeout }, (error, stdout, stderr) => {
        const exitCode = error ? error.code : 0;
        if (!acceptedCodes.includes(exitCode)) {
          // Never return Git stderr: helpers and transport errors may contain credentials or private paths.
          reject(new GitTransportError('GIT_COMMAND_FAILED', 'The configured Git operation failed.',
            { exitCode: Number.isInteger(exitCode) ? exitCode : null, timedOut: Boolean(error?.killed) }));
        } else resolvePromise({ stdout, stderr, exitCode });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }

  async verifyRepository(projectId) {
    const repository = this.repository(projectId);
    const result = await this.command(repository, ['rev-parse', '--is-bare-repository']);
    requireValue(result.stdout.toString().trim() === 'true', 'Configured Git repository is not bare.', 'INVALID_CONFIGURATION');
    return { projectId, branch: repository.defaultBranch };
  }

  async fetch(projectId, { ref } = {}) {
    const repository = this.repository(projectId);
    ref ||= `refs/heads/${repository.defaultBranch}`;
    requireValue(typeof ref === 'string' && ref.startsWith('refs/heads/'), 'Only a branch source may be fetched.');
    validateBranch(ref.slice('refs/heads/'.length));
    const localRef = `refs/praxis-fetch/${randomUUID()}`;
    try {
      await this.command(repository, ['fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules',
        repository.remoteUrl, `+${ref}:${localRef}`]);
      const result = await this.command(repository, ['rev-parse', '--verify', `${localRef}^{commit}`]);
      return { commit: oid(result.stdout.toString().trim()) };
    } finally {
      await this.command(repository, ['update-ref', '-d', localRef]).catch(() => {});
    }
  }

  async readTree(projectId, commit) {
    const repository = this.repository(projectId);
    const result = await this.command(repository, ['ls-tree', '-rz', '--full-tree', oid(commit)]);
    const entries = [];
    for (const record of result.stdout.toString('utf8').split('\0').filter(Boolean)) {
      const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(record);
      requireValue(match, 'Repository contains an unsupported tree entry.', 'UNSUPPORTED_TREE');
      // Parent paths are retained byte-for-byte by Git; reject non-roundtrippable UTF-8 names.
      requireValue(!match[4].includes('\ufffd'), 'Repository contains unsupported non-UTF-8 paths.', 'UNSUPPORTED_TREE');
      entries.push({ path: match[4], mode: match[1], type: match[2], oid: oid(match[3]) });
    }
    return entries;
  }

  async readBlob(projectId, objectId) {
    const result = await this.command(this.repository(projectId), ['cat-file', 'blob', oid(objectId)], { maxBuffer: MAX_BLOB_BYTES });
    return result.stdout;
  }

  async createCommit(projectId, { parent, changes, message, timestamp }) {
    const repository = this.repository(projectId);
    oid(parent);
    requireValue(Array.isArray(changes) && changes.length > 0 && changes.length <= 20000, 'A bounded changed-file set is required.');
    requireValue(typeof message === 'string' && message.trim().length > 0 && Buffer.byteLength(message) <= 16384
      && !message.includes('\0'), 'Commit message must contain 1 to 16384 bytes.');
    requireValue(typeof timestamp === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(timestamp)
      && Number.isFinite(Date.parse(timestamp)), 'A fixed UTC timestamp is required for deterministic commits.');
    const author = repository.author, committer = repository.author;
    let changedBytes = 0;
    const paths = new Set();
    for (const change of changes) {
      validateGitPath(change.path);
      requireValue(!paths.has(change.path), 'Changed-file paths must be unique.'); paths.add(change.path);
      if (change.delete === true) requireValue(change.content === undefined && change.mode === undefined, 'Delete entries cannot carry content or mode.');
      else {
        requireValue(MODES.has(change.mode) && (Buffer.isBuffer(change.content) || change.content instanceof Uint8Array),
          'Changed files require exact bytes and a regular-file Git mode.');
        changedBytes += change.content.byteLength;
        requireValue(change.content.byteLength <= MAX_BLOB_BYTES && changedBytes <= MAX_CHANGE_BYTES, 'Changed file bytes exceed publication limits.', 'LIMIT_EXCEEDED');
      }
    }
    const entries = new Map((await this.readTree(projectId, parent)).map(entry => [entry.path, entry]));
    for (const change of changes) {
      if (change.delete === true) {
        requireValue(entries.has(change.path), 'Deleted file does not exist in the parent tree.', 'PUBLISH_CONFLICT');
        entries.delete(change.path);
      } else {
        const previous = entries.get(change.path);
        requireValue(!previous || (previous.type === 'blob' && MODES.has(previous.mode)),
          'Publication cannot replace a symbolic link or submodule.', 'UNSUPPORTED_TREE');
        const result = await this.command(repository, ['hash-object', '-w', '--stdin', '--no-filters'], { input: change.content });
        entries.set(change.path, { path: change.path, mode: change.mode, type: 'blob', oid: oid(result.stdout.toString().trim()) });
      }
    }
    const root = new Map();
    for (const entry of entries.values()) {
      const components = entry.path.split('/');
      let directory = root;
      for (const component of components.slice(0, -1)) {
        if (!directory.has(component)) directory.set(component, new Map());
        requireValue(directory.get(component) instanceof Map, 'A changed file conflicts with a parent directory.', 'PUBLISH_CONFLICT');
        directory = directory.get(component);
      }
      const name = components.at(-1);
      requireValue(!directory.has(name), 'A changed file conflicts with a parent directory.', 'PUBLISH_CONFLICT');
      directory.set(name, entry);
    }
    const writeTree = async directory => {
      const rows = [];
      for (const [name, entry] of directory) {
        const value = entry instanceof Map ? { mode: '040000', type: 'tree', oid: await writeTree(entry) } : entry;
        rows.push(Buffer.from(`${value.mode} ${value.type} ${value.oid}\t${name}\0`));
      }
      const result = await this.command(repository, ['mktree', '-z', '--missing'], { input: Buffer.concat(rows) });
      return oid(result.stdout.toString().trim());
    };
    const tree = await writeTree(root);
    const env = { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_AUTHOR_DATE: timestamp,
      GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email, GIT_COMMITTER_DATE: timestamp };
    const result = await this.command(repository, ['commit-tree', tree, '-p', parent, '-F', '-'],
      { input: Buffer.from(message.endsWith('\n') ? message : `${message}\n`), env });
    return { commit: oid(result.stdout.toString().trim()), tree, parent };
  }

  async isAncestor(projectId, ancestor, descendant) {
    const result = await this.command(this.repository(projectId), ['merge-base', '--is-ancestor', oid(ancestor), oid(descendant)],
      { acceptedCodes: [0, 1] });
    return result.exitCode === 0;
  }

  async remoteHead(projectId, branch) {
    const repository = this.repository(projectId);
    branch = this.branch(repository, branch);
    const ref = `refs/heads/${branch}`;
    const result = await this.command(repository, ['ls-remote', '--refs', '--exit-code', repository.remoteUrl, ref],
      { acceptedCodes: [0, 2], maxBuffer: 4096 });
    if (result.exitCode === 2) return { commit: null };
    const lines = result.stdout.toString().trim().split('\n');
    requireValue(lines.length === 1 && lines[0].split('\t')[1] === ref, 'Remote returned an ambiguous branch head.', 'PUBLISH_UNCERTAIN');
    return { commit: oid(lines[0].split('\t')[0]) };
  }

  async push(projectId, { commit, expectedHead, branch }) {
    const repository = this.repository(projectId);
    branch = this.branch(repository, branch); oid(commit);
    requireValue(expectedHead === null || (typeof expectedHead === 'string' && OID.test(expectedHead)), 'Expected remote head must be a full commit ID or null.');
    if (expectedHead !== null) requireValue(await this.isAncestor(projectId, expectedHead, commit),
      'Publication must descend from the expected remote head.', 'PUBLISH_CONFLICT');
    const before = await this.remoteHead(projectId, branch);
    if (before.commit === commit) return { commit, branch, remoteHead: commit, alreadyPublished: true };
    requireValue(before.commit === expectedHead, 'Remote branch advanced. Refresh its source before publishing.', 'PUBLISH_CONFLICT');
    const ref = `refs/heads/${branch}`;
    let pushError;
    try {
      // Exact CAS prevents a race from overwriting an external update. Ancestry was checked above.
      await this.command(repository, ['push', '--porcelain', '--no-verify', '--recurse-submodules=no',
        `--force-with-lease=${ref}:${expectedHead || ''}`, repository.remoteUrl, `${commit}:${ref}`], { maxBuffer: 16384 });
    } catch (error) { pushError = error; }
    let after;
    try { after = await this.remoteHead(projectId, branch); }
    catch { throw new GitTransportError('PUBLISH_UNCERTAIN', 'Push outcome is unknown. Reconcile this commit with the remote branch before retrying.', { commit, branch, pushAttempted: true }); }
    if (after.commit === commit) return { commit, branch, remoteHead: commit, alreadyPublished: false };
    if (after.commit !== expectedHead) throw new GitTransportError('PUBLISH_CONFLICT',
      'Remote branch changed during publication. Reconcile the existing commit before proceeding.', { commit, branch, remoteHead: after.commit, pushAttempted: true });
    if (pushError) throw new GitTransportError('GIT_PUSH_FAILED', 'The remote did not accept the commit; its branch head is unchanged.', { commit, branch, pushAttempted: true });
    throw new GitTransportError('PUBLISH_UNCERTAIN', 'Push reported success but the expected commit is not the current branch head. Reconcile before retrying.', { commit, branch, pushAttempted: true });
  }
}
