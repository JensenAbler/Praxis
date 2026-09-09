import { z } from 'zod';
import { mkdirSync, existsSync, lstatSync, readFileSync, chmodSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sha256 } from '../code/paths.js';
import { GitTransportError } from './git.js';

const execute = promisify(execFile);
const name = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const projectId = z.string().regex(/^p-[a-f0-9]{16}-[a-z][a-z0-9-]{0,39}$/);
const base = { operationId: z.string().uuid(), idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/) };
export const projectBrokerSchemas = {
  projectCreate: z.object({ ...base, name, template: z.enum(['node', 'python', 'static']).default('node') }).strict(),
  projectPublish: z.object({ ...base, projectId, visibility: z.enum(['private', 'public']).default('private'),
    commitOperationId: z.string().uuid().optional() }).strict()
};
export class ProjectError extends GitTransportError {
  constructor(code, message, uncertain = false) { super(code, message); this.uncertain = uncertain; }
}
function check(value, code, message) { if (!value) throw new ProjectError(code, message); }
export function ownedProjectId(owner, projectName) {
  check(typeof owner === 'string' && owner.length > 0 && owner.length <= 100 && name.safeParse(projectName).success,
    'INVALID_ARGUMENT', 'Project names must be lowercase words separated by hyphens, up to 40 characters.');
  return `p-${sha256(owner).slice(0, 16)}-${projectName}`;
}

/** Templates contain source only; provisioning never executes any template or user source. */
export function projectScaffold(projectName, template) {
  check(name.safeParse(projectName).success && ['node', 'python', 'static'].includes(template), 'INVALID_ARGUMENT', 'Invalid project template.');
  const common = {
    '.gitignore': 'node_modules/\n.venv/\n__pycache__/\n*.pyc\n.env\n.env.*\n!.env.example\ncoverage/\ndist/\n',
    'README.md': `# ${projectName}\n\nCreated with Praxis.\n\n`
  };
  if (template === 'node') return { files: { ...common,
    'README.md': `${common['README.md']}Run tests with \`npm test\` and start with \`npm start\`. The server uses \`PORT\` (default 3000) and exposes \`/healthz\`.\n`,
    'package.json': `${JSON.stringify({ name: projectName, version: '0.1.0', private: true, type: 'module',
      scripts: { start: 'node server.js', test: 'node --test' }, engines: { node: '>=22' } }, null, 2)}\n`,
    'package-lock.json': `${JSON.stringify({ name: projectName, version: '0.1.0', lockfileVersion: 3, requires: true,
      packages: { '': { name: projectName, version: '0.1.0', engines: { node: '>=22' } } } }, null, 2)}\n`,
    'app.js': `export function handler(request, response) {\n  response.writeHead(200, { 'content-type': 'application/json' });\n  response.end(JSON.stringify(request.url === '/healthz' ? { ok: true } : { message: '${projectName}' }));\n}\n`,
    'server.js': "import { createServer } from 'node:http';\nimport { handler } from './app.js';\nconst server = createServer(handler);\nserver.listen(Number(process.env.PORT || 3000), '0.0.0.0');\nlet closing = false;\nfor (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {\n  if (closing) return;\n  closing = true;\n  const deadline = setTimeout(() => process.exit(1), 25000);\n  server.close(error => { clearTimeout(deadline); process.exitCode = error ? 1 : 0; });\n});\n",
    'app.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { handler } from './app.js';\ntest('health endpoint reports readiness', () => {\n  let status, body;\n  handler({ url: '/healthz' }, { writeHead(code) { status = code; }, end(value) { body = value; } });\n  assert.equal(status, 200);\n  assert.deepEqual(JSON.parse(body), { ok: true });\n});\n"
  }, validationCommands: [['npm', 'test']], runtime: 'node' };
  if (template === 'python') return { files: { ...common,
    'README.md': `${common['README.md']}Run tests with \`python3 -m unittest discover -v\` and start with \`python3 app.py\`. The server uses \`PORT\` (default 3000) and exposes \`/healthz\`.\n`,
    'requirements.txt': '# Add application dependencies here.\n',
    'app.py': `import json\nimport os\nfrom http.server import BaseHTTPRequestHandler, ThreadingHTTPServer\n\ndef response_for(path):\n    return {"ok": True} if path == "/healthz" else {"message": "${projectName}"}\n\nclass Handler(BaseHTTPRequestHandler):\n    def do_GET(self):\n        payload = json.dumps(response_for(self.path)).encode()\n        self.send_response(200)\n        self.send_header("Content-Type", "application/json")\n        self.send_header("Content-Length", str(len(payload)))\n        self.end_headers()\n        self.wfile.write(payload)\n\nif __name__ == "__main__":\n    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "3000"))), Handler).serve_forever()\n`,
    'test_app.py': 'import unittest\nfrom app import response_for\n\nclass HealthTests(unittest.TestCase):\n    def test_health(self):\n        self.assertEqual(response_for("/healthz"), {"ok": True})\n\nif __name__ == "__main__":\n    unittest.main()\n'
  }, validationCommands: [['python3', '-m', 'unittest', 'discover', '-v']], runtime: 'python' };
  return { files: { ...common,
    'README.md': `${common['README.md']}Serve this directory with a static web server. Validate with \`python3 -m unittest discover -v\`.\n`,
    'index.html': `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${projectName}</title><link rel="stylesheet" href="style.css"></head>\n<body><main><h1>${projectName}</h1><p>Your new project starts here.</p></main></body>\n</html>\n`,
    'style.css': 'body { margin: 0; padding: 3rem 1.5rem; font: 18px/1.5 system-ui, sans-serif; color: #172235; background: #f6f8fb; }\nmain { max-width: 60rem; margin: auto; }\n',
    'healthz': '{"ok":true}\n',
    'test_site.py': 'import pathlib\nimport unittest\n\nclass SiteTests(unittest.TestCase):\n    def test_document_and_stylesheet(self):\n        page = pathlib.Path(__file__).with_name("index.html").read_text()\n        self.assertIn("<!doctype html>", page.lower())\n        self.assertIn("style.css", page)\n        self.assertTrue(pathlib.Path(__file__).with_name("style.css").is_file())\n'
  }, validationCommands: [['python3', '-m', 'unittest', 'discover', '-v']], runtime: 'static' };
}

/** API access is restricted to one configured account and new-repository provisioning. */
export class GitHubProvisioningClient {
  constructor({ account, tokenFile, fetchImpl = fetch }) {
    check(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(account), 'INVALID_CONFIGURATION', 'A fixed GitHub account is required.');
    check(!tokenFile || isAbsolute(tokenFile), 'INVALID_CONFIGURATION', 'Provisioning credentials require an absolute protected file.');
    this.account = account; this.tokenFile = tokenFile; this.fetch = fetchImpl;
  }
  token() {
    check(this.tokenFile && existsSync(this.tokenFile), 'GITHUB_SETUP_REQUIRED', 'GitHub project creation needs a protected provisioning credential. Local projects remain usable.');
    const stat = lstatSync(this.tokenFile);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 8192
      && (process.platform === 'win32' || !(stat.mode & 0o077)), 'INVALID_CONFIGURATION', 'The GitHub provisioning credential file must be private and unlinked.');
    const token = readFileSync(this.tokenFile, 'utf8').trim();
    check(/^[A-Za-z0-9_]{16,8192}$/.test(token), 'INVALID_CONFIGURATION', 'The provisioning credential is invalid.');
    return token;
  }
  async request(method, path, body, { allowMissing = false } = {}) {
    const token = this.token();
    let response;
    try { response = await this.fetch(`https://api.github.com${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json',
        'x-github-api-version': '2022-11-28', 'user-agent': 'Praxis-project-provisioner' }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
    catch { throw new ProjectError('GITHUB_UNAVAILABLE', 'GitHub did not return a confirmed result. Recover the existing operation.'); }
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) {
      const error = new ProjectError([401, 403].includes(response.status) ? 'GITHUB_AUTHORIZATION_REQUIRED' : 'GITHUB_REQUEST_FAILED',
        [401, 403].includes(response.status) ? 'The provisioning credential lacks access or has expired.' : `GitHub rejected the provisioning request (HTTP ${response.status}).`);
      // A confirmed 4xx is a definite rejection. A 5xx can follow an effect and
      // remains uncertain after a durable mutation intent.
      error.definiteFailure = response.status >= 400 && response.status < 500;
      throw error;
    }
    try { return await response.json(); } catch { throw new ProjectError('GITHUB_UNAVAILABLE', 'GitHub returned an unreadable result. Recover the existing operation.'); }
  }
  repoPath(repositoryName) { check(name.safeParse(repositoryName).success, 'INVALID_ARGUMENT', 'Invalid repository name.'); return `/repos/${this.account}/${repositoryName}`; }
  getRepository(repositoryName) { return this.request('GET', this.repoPath(repositoryName), undefined, { allowMissing: true }); }
  async checkIdentity() {
    const user = await this.request('GET', '/user');
    check(user.login?.toLowerCase() === this.account.toLowerCase(), 'GITHUB_ACCOUNT_MISMATCH', 'The provisioning credential belongs to a different GitHub account.');
  }
  async createRepository(repositoryName, visibility, marker) {
    this.repoPath(repositoryName);
    return this.request('POST', '/user/repos', { name: repositoryName, private: visibility !== 'public', description: marker,
      auto_init: false, has_issues: true, has_projects: false, has_wiki: false });
  }
  async findDeployKey(repositoryName, publicKey) {
    const expected = publicKey.trim().split(/\s+/).slice(0, 2).join(' ');
    for (let page = 1; page <= 10; page++) {
      const keys = await this.request('GET', `${this.repoPath(repositoryName)}/keys?per_page=100&page=${page}`);
      check(Array.isArray(keys), 'GITHUB_UNAVAILABLE', 'GitHub returned an invalid key listing.');
      const found = keys.find(key => key.key?.trim().split(/\s+/).slice(0, 2).join(' ') === expected);
      if (found) { check(found.read_only === false, 'GITHUB_KEY_CONFLICT', 'The saved deploy key is not writable.'); return found; }
      if (keys.length < 100) return null;
    }
    throw new ProjectError('LIMIT_EXCEEDED', 'GitHub deploy-key listing exceeded its recovery bound.');
  }
  addDeployKey(repositoryName, publicKey, operationId) {
    return this.request('POST', `${this.repoPath(repositoryName)}/keys`, { title: `Praxis ${operationId}`, key: publicKey.trim(), read_only: false });
  }
}

/** Uses the broker's durable operation journal. All files remain in protected broker storage. */
export class ProjectProvisioner {
  constructor({ broker, directory, account, github, author, knownHostsFile, maximumProjects = 50 }) {
    check(isAbsolute(directory) && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(account), 'INVALID_CONFIGURATION', 'Protected project storage and GitHub account are required.');
    this.broker = broker; this.db = broker.db; this.git = broker.git; this.directory = resolve(directory);
    this.account = account; this.github = github; this.author = author; this.knownHostsFile = knownHostsFile; this.maximumProjects = maximumProjects;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    check(!lstatSync(this.directory).isSymbolicLink(), 'INVALID_CONFIGURATION', 'Project storage cannot be a symbolic link.');
    this.db.exec(`CREATE TABLE IF NOT EXISTS git_created_projects (
      project_id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, template TEXT NOT NULL,
      create_operation_id TEXT NOT NULL UNIQUE, initial_commit TEXT, repository_json TEXT,
      published INTEGER NOT NULL DEFAULT 0, publish_operation_id TEXT, created_at TEXT NOT NULL,
      UNIQUE(owner,name));`);
    for (const row of this.db.prepare('SELECT * FROM git_created_projects WHERE repository_json IS NOT NULL').all()) this.register(row);
  }
  get(owner, id) {
    const row = this.db.prepare('SELECT * FROM git_created_projects WHERE owner=? AND project_id=?').get(owner, id);
    check(row, 'NOT_FOUND', 'Project not found.'); return row;
  }
  admit(kind, owner, args) {
    if (kind === 'projectCreate') {
      const id = ownedProjectId(owner, args.name);
      const existing = this.db.prepare('SELECT * FROM git_created_projects WHERE project_id=?').get(id);
      check(!existing || existing.create_operation_id === args.operationId, 'PROJECT_EXISTS', 'A project with this name already exists for this owner. Recover it or use another name.');
      const pending = this.db.prepare("SELECT id FROM git_operations WHERE kind='projectCreate' AND project_id=? AND id!=?").get(id, args.operationId);
      check(!pending, 'PROJECT_EXISTS', 'A project creation receipt already exists for this name. Recover it before starting another creation.');
      check(existing || this.db.prepare("SELECT COUNT(*) AS n FROM git_operations WHERE kind='projectCreate'").get().n < this.maximumProjects,
        'LIMIT_EXCEEDED', 'New-project quota reached.');
      return { projectId: id };
    }
    const row = this.get(owner, args.projectId);
    check(row.initial_commit && row.repository_json, 'PROJECT_NOT_READY', 'The project creation must finish before publication.');
    check(!row.published, 'PROJECT_ALREADY_PUBLISHED', 'This project already has a GitHub repository. Use git_commit and git_push for later changes.');
    const active = this.db.prepare("SELECT id FROM git_operations WHERE kind='projectPublish' AND project_id=? AND status IN ('queued','running','uncertain') AND id!=?").get(args.projectId, args.operationId);
    check(!active, 'GIT_OPERATION_PENDING', 'A project publication is unresolved. Recover its existing operation.');
    if (args.commitOperationId) {
      const commit = this.broker.row(owner, args.commitOperationId);
      check(commit.kind === 'commit' && commit.project_id === args.projectId && commit.status === 'completed', 'COMMIT_NOT_READY', 'A completed commit for this project is required.');
    }
    return { projectId: args.projectId };
  }
  register(row) {
    const repository = JSON.parse(row.repository_json);
    check(repository.projectId === row.project_id && repository.owner === row.owner
      && repository.directory === join(this.directory, row.project_id, 'repository.git'), 'INVALID_CONFIGURATION', 'Saved project storage is inconsistent.');
    this.git.registerRepository({ ...repository, localOnly: !row.published }, { replace: true });
    this.broker.repositories.set(row.project_id, { ...repository, localOnly: !row.published, initialCommit: row.initial_commit });
    return repository;
  }
  async runCreate(operation, args) {
    const id = ownedProjectId(operation.owner, args.name);
    this.db.prepare(`INSERT OR IGNORE INTO git_created_projects(project_id,owner,name,template,create_operation_id,created_at) VALUES(?,?,?,?,?,?)`)
      .run(id, operation.owner, args.name, args.template, operation.id, operation.created_at);
    const row = this.get(operation.owner, id);
    check(row.create_operation_id === operation.id, 'PROJECT_EXISTS', 'The project belongs to another creation receipt.');
    const root = join(this.directory, id), directory = join(root, 'repository.git');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    check(!lstatSync(root).isSymbolicLink(), 'UNSAFE_PATH', 'Project storage contains a symbolic link.');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    check(!lstatSync(directory).isSymbolicLink(), 'UNSAFE_PATH', 'Repository storage contains a symbolic link.');
    await execute(this.git.gitPath, ['-c', 'init.templateDir=', 'init', '--bare', '--initial-branch=main', directory],
      { env: this.git.env, windowsHide: true, timeout: 30000, maxBuffer: 8192 });
    const repository = { projectId: id, owner: operation.owner, directory, remoteUrl: `git@github.com:${this.account}/${args.name}.git`,
      defaultBranch: 'main', allowedBranches: ['main'], localOnly: true, ...(this.author ? { author: this.author } : {}) };
    this.git.registerRepository(repository, { replace: true }); this.broker.repositories.set(id, repository);
    const scaffold = projectScaffold(args.name, args.template);
    const result = await this.git.createCommit(id, { parent: null, timestamp: operation.created_at,
      message: `Initialize ${args.name} with Praxis`, changes: Object.entries(scaffold.files).map(([path, content]) => ({ path, content: Buffer.from(content), mode: '100644' })) });
    await this.git.command(this.git.repository(id), ['update-ref', 'refs/heads/main', result.commit]);
    this.db.prepare('UPDATE git_created_projects SET initial_commit=?,repository_json=? WHERE project_id=?')
      .run(result.commit, JSON.stringify(repository), id);
    this.broker.repositories.set(id, { ...repository, initialCommit: result.commit });
    // run_sync uses the already-recorded commit and never contacts the unpublished remote.
    this.broker.update(operation, 'running', 'scaffold_created', { commit: result.commit });
    const exported = await this.broker.run_sync({ ...operation, project_id: id, result_json: JSON.stringify({ commit: result.commit }) }, {});
    return { ...exported, project: { projectId: id, name: args.name, template: args.template, owner: operation.owner,
      repository: null, publication: 'local', validationCommands: scaffold.validationCommands, runtime: scaffold.runtime } };
  }
  async keyPair(id, { allowCreate = true } = {}) {
    const keyPath = join(this.directory, id, 'publish-key');
    const env = { ...this.git.env };
    // Windows OpenSSH requires this OS directory even for local key generation.
    if (process.platform === 'win32' && process.env.ProgramData) env.ProgramData = process.env.ProgramData;
    check(!/[\r\n']/.test(keyPath) && (!this.knownHostsFile || !/[\r\n']/.test(this.knownHostsFile)), 'INVALID_CONFIGURATION', 'SSH paths contain unsupported characters.');
    check(allowCreate || existsSync(keyPath), 'PROJECT_CREDENTIAL_MISSING', 'The saved project deploy key is unavailable. It will not be replaced during recovery.');
    if (!existsSync(keyPath)) await execute('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `praxis-${id}`, '-f', keyPath],
      { env, windowsHide: true, timeout: 30000, maxBuffer: 8192 });
    const stat = lstatSync(keyPath);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'UNSAFE_PATH', 'Project deploy key is not a private ordinary file.');
    chmodSync(keyPath, 0o600);
    // Derive the public half from the saved private key if creation was interrupted.
    const derived = await execute('ssh-keygen', ['-y', '-f', keyPath], { env, windowsHide: true, timeout: 30000, maxBuffer: 8192 });
    return { publicKey: derived.stdout.trim(), transportEnv: { GIT_SSH_COMMAND: `ssh -i '${keyPath.replaceAll('\\', '/')}' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes${this.knownHostsFile ? ` -o UserKnownHostsFile='${this.knownHostsFile.replaceAll('\\', '/')}'` : ''}` } };
  }
  async runPublish(operation, args) {
    let row = this.get(operation.owner, args.projectId);
    check(this.github, 'GITHUB_SETUP_REQUIRED', 'GitHub project creation needs a protected provisioning credential. Local projects remain usable.');
    const commit = args.commitOperationId ? JSON.parse(this.broker.row(operation.owner, args.commitOperationId).result_json).commit : row.initial_commit;
    let state = operation.result_json ? JSON.parse(operation.result_json) : { commit, visibility: args.visibility };
    check(state.commit === commit, 'COMMIT_CONFLICT', 'The saved publication commit differs from this operation.');
    const save = (phase, changes = {}) => { state = { ...state, ...changes }; this.broker.update(operation, 'running', phase, state); operation.phase = phase; };
    const marker = `Created by Praxis (${operation.id})`;
    if (!state.repositoryId) {
      await this.github.checkIdentity();
      let remote = await this.github.getRepository(row.name);
      if (operation.phase === 'project_remote_intent') {
        if (!remote) throw new ProjectError('PROJECT_PUBLICATION_UNCERTAIN', 'Repository creation was attempted, but no matching repository can be observed. It will not be repeated automatically.', true);
      } else {
        check(!remote, 'REPOSITORY_EXISTS', 'That GitHub repository already exists. Praxis will not adopt or overwrite it.');
        save('project_remote_intent');
        remote = await this.github.createRepository(row.name, args.visibility, marker);
      }
      check(remote?.name?.toLowerCase() === row.name && remote.owner?.login?.toLowerCase() === this.account.toLowerCase()
        && remote.private === (args.visibility === 'private') && remote.description === marker && Number.isSafeInteger(remote.id),
        'REPOSITORY_CONFLICT', 'The observed repository does not match this project creation receipt.');
      save('project_remote_created', { repositoryId: remote.id, repositoryUrl: `https://github.com/${this.account}/${row.name}` });
    }
    const pair = await this.keyPair(row.project_id, { allowCreate: !state.deployKeyId && !['project_key_intent', 'project_push_intent'].includes(operation.phase) });
    if (!state.deployKeyId) {
      let key = await this.github.findDeployKey(row.name, pair.publicKey);
      if (operation.phase === 'project_key_intent') {
        if (!key) throw new ProjectError('PROJECT_PUBLICATION_UNCERTAIN', 'Deploy-key creation was attempted, but its result cannot be observed. It will not be repeated automatically.', true);
      } else if (!key) { save('project_key_intent'); key = await this.github.addDeployKey(row.name, pair.publicKey, operation.id); }
      check(Number.isSafeInteger(key?.id), 'GITHUB_UNAVAILABLE', 'GitHub did not confirm the deploy key.');
      save('project_key_created', { deployKeyId: key.id });
    }
    const repository = { ...JSON.parse(row.repository_json), transportEnv: pair.transportEnv };
    this.db.prepare('UPDATE git_created_projects SET repository_json=? WHERE project_id=?').run(JSON.stringify(repository), row.project_id);
    this.git.registerRepository(repository, { replace: true });
    const observed = await this.git.remoteHead(row.project_id, 'main');
    if (operation.phase === 'project_push_intent') {
      if (observed.commit !== commit) throw new ProjectError('PROJECT_PUBLICATION_UNCERTAIN', 'Initial publication was attempted, but the expected main commit is not observed. It will not be repeated automatically.', true);
    } else if (observed.commit !== commit) {
      check(observed.commit === null, 'REMOTE_CONFLICT', 'The new repository has an unexpected main commit. Nothing was overwritten.');
      save('project_push_intent');
      await this.git.push(row.project_id, { commit, expectedHead: null, branch: 'main' });
    }
    this.db.prepare('UPDATE git_created_projects SET published=1,publish_operation_id=? WHERE project_id=?').run(operation.id, row.project_id);
    row = this.get(operation.owner, row.project_id); this.register(row);
    const exported = await this.broker.run_sync({ ...operation, project_id: row.project_id, result_json: JSON.stringify({ commit }) }, {});
    return { ...state, ...exported, commit, publishedCommit: commit, observedRemoteHead: commit, branch: 'main', repositoryUrl: state.repositoryUrl,
      project: { projectId: row.project_id, name: row.name, template: row.template, owner: row.owner, repository: state.repositoryUrl, publication: args.visibility } };
  }
}
