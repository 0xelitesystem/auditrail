// Claude Code path shapes and discovery roots (DESIGN 4.1, 8.5; INTERFACES 3.1).
//
// classify() decides from the relative path alone. Discovery must walk each root RECURSIVELY:
// main-thread transcripts at the top level are a small minority of files (trap 1); subagent and
// workflow agent transcripts live two and four folders deeper.
//
// Isomorphic: no node:* imports and no DOM.

import { FILE_CLASS_DEPTH } from '../contract.js';

/**
 * Shapes under <config>/projects (relative path, '/' separators):
 *   main              <proj>/<sessionUuid>.jsonl
 *   subagent          <proj>/<sessionUuid>/subagents/agent-<id>.jsonl
 *   workflow_agent    <proj>/<sessionUuid>/subagents/workflows/<run>/agent-<id>.jsonl
 *   workflow_journal  <proj>/<sessionUuid>/subagents/workflows/<run>/journal.jsonl  (or <run>/<run>.jsonl)
 * Variants keep the class of their base shape: <name>.jsonl.superseded-<n>, .orphaned-<name>.jsonl.
 */
export const PATH_SHAPES = Object.freeze({
  main: '<proj>/<sessionUuid>.jsonl',
  subagent: '<proj>/<sessionUuid>/subagents/agent-<id>.jsonl',
  workflow_agent: '<proj>/<sessionUuid>/subagents/workflows/<run>/agent-<id>.jsonl',
  workflow_journal: '<proj>/<sessionUuid>/subagents/workflows/<run>/journal.jsonl',
});

const SUPERSEDED_RE = /\.jsonl\.superseded-[^/]+$/;
const COMPRESSED_RE = /\.jsonl(\.superseded-[^/]+)?\.zst$/;
const ORPHANED_PREFIX = '.orphaned-';

/**
 * Decide what discovery does with one file (FileDecision). Pure; looks at the path only.
 * @param {string} relPath path relative to a root; '/' or '\' separators accepted
 * @returns {import('../contract.js').FileDecision}
 */
export function classifyClaudePath(relPath) {
  if (typeof relPath !== 'string' || relPath === '') return { action: 'skip', reason: 'unknown-shape' };
  const parts = relPath.replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.');
  const name = parts[parts.length - 1] || '';
  if (COMPRESSED_RE.test(name)) return { action: 'skip', reason: 'compressed' };
  if (!name.endsWith('.jsonl') && !SUPERSEDED_RE.test(name)) return { action: 'skip', reason: 'unknown-extension' };
  const stem = name.startsWith(ORPHANED_PREFIX) ? name.slice(ORPHANED_PREFIX.length) : name;
  const base = stem.slice(0, stem.indexOf('.jsonl'));
  if (base === '') return { action: 'skip', reason: 'unknown-shape' };
  if (parts.length === 2) return read('main');
  if (parts.length === 4 && parts[2] === 'subagents') return read('subagent');
  if (parts.length === 6 && parts[2] === 'subagents' && parts[3] === 'workflows') {
    if (base.startsWith('agent-')) return read('workflow_agent');
    if (base === 'journal' || base === parts[4]) return read('workflow_journal');
  }
  return { action: 'skip', reason: 'unknown-shape' };
}

/**
 * @param {import('../contract.js').FileClass} fileClass
 * @returns {import('../contract.js').FileDecision}
 */
function read(fileClass) {
  return { action: 'read', fileClass, depth: FILE_CLASS_DEPTH[fileClass] };
}

/**
 * Candidate roots in DESIGN 8.5 order (after any --dir, which the CLI handles): the documented
 * $CLAUDE_CONFIG_DIR/projects, the documented ~/.claude/projects, then the XDG location, probed
 * only by the caller if it exists. Pure: builds strings, touches nothing. Duplicates removed.
 * @param {import('../contract.js').RootsEnv} env
 * @returns {string[]}
 */
export function claudeCodeRoots(env) {
  const e = (env && env.env) || {};
  const platform = (env && env.platform) || 'linux';
  const home = (env && env.home) || '';
  const sep = platform === 'win32' ? '\\' : '/';
  const join = (/** @type {string[]} */ ...xs) => {
    const [first, ...rest] = xs;
    let out = String(first).replace(/[\\/]+$/, '');
    for (const x of rest) out += sep + x;
    return out;
  };
  const out = [];
  if (typeof e.CLAUDE_CONFIG_DIR === 'string' && e.CLAUDE_CONFIG_DIR.trim()) out.push(join(e.CLAUDE_CONFIG_DIR.trim(), 'projects'));
  if (home) out.push(join(home, '.claude', 'projects'));
  if (typeof e.XDG_CONFIG_HOME === 'string' && e.XDG_CONFIG_HOME.trim()) out.push(join(e.XDG_CONFIG_HOME.trim(), 'claude', 'projects'));
  else if (home) out.push(join(home, '.config', 'claude', 'projects'));
  return [...new Set(out)];
}
