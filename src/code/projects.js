import { requireValue, readSafe, safePath, manifest } from './paths.js';
import { ownedProjectId } from '../git/projects.js';

const COMMIT = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** Source-facing project adapter. No credential or trusted host path is returned to coding work. */
export class CodeProjects {
  constructor({ git }) {
    this.git = git; this.db = git.db; this.workspaces = git.workspaces;
    this.db.exec(`CREATE TABLE IF NOT EXISTS code_created_projects (
      project_id TEXT PRIMARY KEY, owner TEXT NOT NULL, create_operation_id TEXT NOT NULL,
      project_json TEXT NOT NULL, updated_at TEXT NOT NULL);`);
    for (const row of this.db.prepare('SELECT * FROM code_created_projects').all()) this.restore(row);
  }
  restore(row) {
    const project = JSON.parse(row.project_json);
    requireValue(project.id === row.project_id && project.owner === row.owner,
      'Saved project registration is inconsistent.', 'INVALID_CONFIGURATION');
    this.workspaces.projects.set(row.project_id, project);
    return project;
  }
  async create({ owner, name, template = 'node', idempotencyKey }) {
    const projectId = ownedProjectId(owner, name);
    requireValue(['node', 'python', 'static'].includes(template), 'template must be node, python, or static.');
    const input = { kind: 'projectCreate', name, template };
    const row = this.git.store.transaction(() => {
      const existing = this.git._existing(owner, idempotencyKey, input); if (existing) return existing;
      requireValue(!this.workspaces.projects.has(projectId), 'A project with this name already exists. Recover it or choose another name.', 'PROJECT_EXISTS');
      return this.git._prepare({ owner, idempotencyKey, input, projectId, request: { name, template } });
    });
    return this.git._submit(row);
  }
  async publish({ owner, projectId, visibility = 'private', commitOperationId, idempotencyKey }) {
    requireValue(['private', 'public'].includes(visibility), 'visibility must be private or public.');
    const input = { kind: 'projectPublish', projectId, visibility, ...(commitOperationId ? { commitOperationId } : {}) };
    const row = this.git.store.transaction(() => {
      const existing = this.git._existing(owner, idempotencyKey, input); if (existing) return existing;
      const project = this.db.prepare('SELECT * FROM code_created_projects WHERE owner=? AND project_id=?').get(owner, projectId);
      requireValue(project, 'Project not found.', 'NOT_FOUND');
      let workspaceId;
      if (commitOperationId) {
        const commit = this.git._row(owner, commitOperationId);
        requireValue(commit.kind === 'commit' && commit.project_id === projectId && JSON.parse(commit.receipt_json).status === 'completed',
          'commitOperationId must identify a completed commit for this project.', 'COMMIT_NOT_READY');
        workspaceId = commit.workspace_id;
      }
      return this.git._prepare({ owner, idempotencyKey, input, projectId, workspaceId, request: {
        projectId, visibility, ...(commitOperationId ? { commitOperationId } : {}) } });
    });
    return this.git._submit(row);
  }
  /** Called inside CodeGit._observe's transaction before marking a project operation integrated. */
  integrate(row, receipt) {
    const result = receipt.result, metadata = result?.project;
    requireValue(metadata && metadata.projectId === row.project_id && metadata.owner === row.owner
      && ownedProjectId(row.owner, metadata.name) === row.project_id && ['node', 'python', 'static'].includes(metadata.template),
      'Project receipt does not match the authenticated owner or project.', 'BROKER_PROTOCOL_ERROR');
    let project;
    if (row.kind === 'projectCreate') {
      requireValue(result.exportId === row.id && COMMIT.test(result.commit) && DIGEST.test(result.revision) && result.branch === 'main'
        && metadata.publication === 'local' && metadata.repository === null, 'Project scaffold export metadata is invalid.', 'BROKER_PROTOCOL_ERROR');
      const root = safePath(this.git.exportDirectory, row.id, { directory: true });
      const exported = JSON.parse(readSafe(root, 'manifest.json', 16 * 1024 * 1024));
      const snapshotPath = safePath(root, 'files', { directory: true }), state = manifest(snapshotPath);
      requireValue(exported.version === 1 && exported.projectId === row.project_id && exported.commit === result.commit
        && exported.revision === result.revision && state.revision === result.revision && equal(exported.entries, state.entries)
        && Object.values(state.entries).every(entry => entry.kind === 'file'), 'Project source does not match its creation receipt.', 'SNAPSHOT_CHANGED');
      requireValue(Array.isArray(metadata.validationCommands) && metadata.validationCommands.length <= 5
        && metadata.validationCommands.every(command => Array.isArray(command)
          && command.length > 0 && command.length <= 20 && command.every(arg => typeof arg === 'string' && arg.length <= 500)),
        'Project validation command metadata is invalid.', 'BROKER_PROTOCOL_ERROR');
      project = { id: row.project_id, owner: row.owner, name: metadata.name, template: metadata.template,
        repository: null, publication: 'local', revision: result.commit, snapshotPath,
        validationCommands: metadata.validationCommands, runtime: metadata.runtime,
        instructions: 'This owner-created project is isolated from production. Run its validation commands before committing. Publish through project_publish once, then use git_commit and git_push for later updates.' };
    } else {
      const previous = this.db.prepare('SELECT * FROM code_created_projects WHERE owner=? AND project_id=?').get(row.owner, row.project_id);
      requireValue(previous, 'The publication project is not registered.', 'BROKER_PROTOCOL_ERROR');
      const requested = JSON.parse(row.input_json);
      requireValue(metadata.publication === requested.visibility && /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[a-z][a-z0-9-]{0,39}$/.test(metadata.repository)
        && result.repositoryUrl === metadata.repository && COMMIT.test(result.commit) && result.branch === 'main',
        'Project publication metadata is invalid.', 'BROKER_PROTOCOL_ERROR');
      project = { ...JSON.parse(previous.project_json), repository: metadata.repository, publication: metadata.publication };
    }
    const prior = this.db.prepare('SELECT create_operation_id FROM code_created_projects WHERE project_id=?').get(row.project_id);
    this.db.prepare(`INSERT INTO code_created_projects(project_id,owner,create_operation_id,project_json,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET project_json=excluded.project_json,updated_at=excluded.updated_at`)
      .run(row.project_id, row.owner, prior?.create_operation_id || row.id, JSON.stringify(project), new Date().toISOString());
    this.workspaces.projects.set(row.project_id, project);
  }
}
