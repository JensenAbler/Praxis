// Shared evaluator helpers have no CLI entrypoint or top-level evaluation work.
// Run candidates only in an OS sandbox; node:vm is not a security boundary.
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, sep, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const inside = (root, path) => { const part = relative(root, path); return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part)); };
const ensure = (condition, message) => { if (!condition) throw new Error(message); };

export async function bounded(promise, milliseconds = 1200) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Required result did not settle before the deadline')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

export function loadCandidate(workspace, entry) {
  const cache = new Map(), hashes = {}, timers = new Set();
  let fetchHandler = async () => { throw new Error('No mock response was registered; network access is prohibited'); };
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} }, process: { env: Object.freeze({}) },
    URL, AbortController, TextEncoder, TextDecoder, ReadableStream, Response, Headers,
    fetch: (...args) => fetchHandler(...args),
    setTimeout: (fn, ms, ...args) => { const timer = setTimeout(() => { timers.delete(timer); fn(...args); }, ms); timers.add(timer); return timer; },
    clearTimeout: timer => { timers.delete(timer); clearTimeout(timer); }
  }, { codeGeneration: { strings: false, wasm: false } });
  function load(name) {
    ensure(entry.allowedModules.includes(name), 'Candidate requested a module outside the evaluation allowlist');
    if (cache.has(name)) return cache.get(name).exports;
    const path = realpathSync(resolve(workspace, name));
    ensure(inside(workspace, path), 'Candidate module escapes its workspace');
    const source = readFileSync(path, 'utf8');
    ensure(Buffer.byteLength(source) <= 2 * 1024 * 1024, 'Candidate module exceeds the size limit');
    hashes[name] = createHash('sha256').update(source).digest('hex');
    const module = { exports: {} }; cache.set(name, module);
    const token = `__load${cache.size}`;
    context[token] = { module, require(request) {
      ensure(typeof request === 'string' && request.startsWith('./') && !request.includes('..'), 'Only allowlisted relative modules may load');
      const dependency = request.slice(2).endsWith('.js') ? request.slice(2) : `${request.slice(2)}.js`;
      return load(dependency);
    } };
    try { new vm.Script(`(function(require,module,exports){\n${source}\n})(${token}.require,${token}.module,${token}.module.exports)`, { filename: name }).runInContext(context, { timeout: 1000 }); }
    finally { delete context[token]; }
    return module.exports;
  }
  context.subject = load(entry.entrypoint);
  return { hashes, context, evaluate(code) { return new vm.Script(code).runInContext(context, { timeout: 1000 }); },
    mockFetch(handler) { fetchHandler = handler; }, close() { for (const timer of timers) clearTimeout(timer); } };
}
