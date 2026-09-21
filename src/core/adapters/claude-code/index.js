// The Claude Code adapter object (INTERFACES 3.2): path shapes, roots, the line parser and the
// rule A1 / A3 reference key and merge from the adapter contract.
//
// Isomorphic: no node:* imports and no DOM.

import { defineAdapter, defaultDedupKey, defaultMerge } from '../contract.js';
import { classifyClaudePath, claudeCodeRoots } from './shapes.js';
import { parseClaudeLine } from './parse.js';

/** @type {import('../contract.js').Adapter} */
export const claudeCodeAdapter = defineAdapter({
  id: 'claude-code',
  displayName: 'Claude Code',
  roots: claudeCodeRoots,
  classify: classifyClaudePath,
  parseLine: parseClaudeLine,
  dedupKey: defaultDedupKey,
  merge: defaultMerge,
});

export default claudeCodeAdapter;
export { classifyClaudePath, claudeCodeRoots, parseClaudeLine };
