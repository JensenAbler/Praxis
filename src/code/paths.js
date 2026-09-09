import { lstatSync, fstatSync, readdirSync, openSync, closeSync, readFileSync, constants } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';

export class WorkspaceError extends Error {
  constructor(code, message) { super(message); this.name = 'WorkspaceError'; this.code = code; }
}
export function requireValue(condition, message, code = 'VALIDATION_ERROR') {
  if (!condition) throw new WorkspaceError(code, message);
}
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const LIMITS = Object.freeze({ files: 20000, sourceBytes: 128 * 1024 * 1024, fileBytes: 2 * 1024 * 1024,
  readCharacters: 32768, writeCharacters: 131072, applyBytes: 256 * 1024, changes: 32, workspaces: 20, operations: 10000,
  diffCacheBytes: 600 * 1024 * 1024, operationJournalBytes: 128 * 1024 * 1024 });
export const IGNORED = new Set(['node_modules', '.cache', '.npm', '.pytest_cache', '__pycache__', '.venv', 'venv']);
const protectedName = name => {
  const lower = name.toLowerCase();
  return lower === '.git' || lower === '.ssh' || lower === '.aws' || lower === '.gnupg'
    || lower === '.env' || lower.startsWith('.env.') || lower.startsWith('.praxis-tmp-')
    || /^(?:credentials|secrets?)(?:\.|$)/i.test(name) || /\.(?:pem|key|p12|pfx)$/i.test(name);
};

export function normalizePath(value, { directory = false } = {}) {
  requireValue(typeof value === 'string' && value.length <= 1024, 'path must be a relative path of at most 1024 characters.');
  if (directory && value === '') return '';
  requireValue(value.length > 0 && !value.includes('\\') && !value.includes('\0') && !value.includes(':')
    && !value.startsWith('/') && !/[\x00-\x1f\x7f]/.test(value), 'Only normalized relative POSIX paths are accepted.');
  const parts = value.split('/');
  requireValue(parts.every(part => part && part !== '.' && part !== '..' && !protectedName(part)), 'The path contains a protected or invalid component.', 'PATH_REJECTED');
  return parts.join('/');
}

export function safePath(root, value, options = {}) {
  const normalized = normalizePath(value, options);
  const absoluteRoot = resolve(root);
  const rootStat = lstatSync(absoluteRoot);
  requireValue(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'Workspace root is not a safe directory.', 'UNSAFE_PATH');
  const target = resolve(absoluteRoot, ...normalized.split('/').filter(Boolean));
  const rel = relative(absoluteRoot, target);
  requireValue(!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`), 'Path escapes the workspace.', 'PATH_REJECTED');
  let current = absoluteRoot;
  for (const [index, part] of normalized.split('/').filter(Boolean).entries()) {
    current = resolve(current, part);
    let stat;
    try { stat = lstatSync(current); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
    requireValue(!stat.isSymbolicLink() && (!stat.isFile() || stat.nlink === 1), 'Linked paths cannot be accessed by filesystem tools.', 'UNSAFE_PATH');
    if (index < normalized.split('/').length - 1) requireValue(stat.isDirectory(), 'A path parent is not a directory.', 'UNSAFE_PATH');
  }
  return target;
}

export function readSafe(root, path, maximum = LIMITS.fileBytes) {
  const target = safePath(root, path);
  const stat = lstatSync(target);
  requireValue(stat.isFile() && stat.nlink === 1, 'Only ordinary unlinked files can be read.', 'UNSAFE_PATH');
  requireValue(stat.size <= maximum, `File exceeds the ${maximum}-byte read limit.`, 'LIMIT_EXCEEDED');
  const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(fd);
    requireValue(opened.isFile() && opened.nlink === 1 && opened.size <= maximum && opened.ino === stat.ino && opened.dev === stat.dev,
      'File identity changed while opening it.', 'UNSAFE_PATH');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

/** Never follow a directory entry. Unsafe entries remain visible as review issues. */
export function manifest(root) {
  const entries = Object.create(null);
  let bytes = 0;
  let count = 0;
  safePath(root, '', { directory: true });
  function visit(dir, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (IGNORED.has(entry.name) || protectedName(entry.name)) continue;
      requireValue(++count <= LIMITS.files, 'Workspace exceeds the source entry limit.', 'LIMIT_EXCEEDED');
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      normalizePath(path);
      const target = resolve(dir, entry.name);
      const stat = lstatSync(target);
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(target, path);
      else if (stat.isFile() && stat.nlink === 1) {
        bytes += stat.size;
        requireValue(bytes <= LIMITS.sourceBytes && stat.size <= LIMITS.fileBytes, 'Workspace exceeds the source size limit.', 'LIMIT_EXCEEDED');
        entries[path] = { kind: 'file', sha256: sha256(readSafe(root, path)), size: stat.size, mode: stat.mode & 0o111 ? '100755' : '100644' };
      } else entries[path] = { kind: 'unsafe', issue: stat.isSymbolicLink() ? 'symbolic_link' : stat.isFile() ? 'hard_link' : 'special_file', mode: 'unsafe' };
    }
  }
  visit(resolve(root));
  const sorted = Object.assign(Object.create(null), Object.fromEntries(Object.keys(entries).sort().map(path => [path, entries[path]])));
  return { entries: sorted, revision: sha256(JSON.stringify(sorted)), bytes, entryCount: count };
}
