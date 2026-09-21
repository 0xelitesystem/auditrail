// Regression for the Claude Code path classifier that feeds the accounting (DESIGN 4.1, 8.5).
// shapes.js once shipped with its backslash regexes collapsed ('/\/g' and a bare '\' string),
// which made the whole adapter fail to load. These cases pin the separator handling.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyClaudePath, claudeCodeRoots } from '../../src/core/adapters/claude-code/shapes.js';

const BS = String.fromCharCode(92); // one backslash, built from its char code

test('classify accepts forward and back slashes alike', () => {
  const shapes = [
    [['-fake-alpha', 's1.jsonl'], 'main', 0],
    [['-fake-alpha', 's1', 'subagents', 'agent-a1.jsonl'], 'subagent', 1],
    [['-fake-alpha', 's1', 'subagents', 'workflows', 'wf_1', 'agent-w1.jsonl'], 'workflow_agent', 2],
    [['-fake-alpha', 's1', 'subagents', 'workflows', 'wf_1', 'journal.jsonl'], 'workflow_journal', 3],
    [['-fake-alpha', 's1.jsonl.superseded-1'], 'main', 0],
    [['-fake-alpha', 's1', 'subagents', '.orphaned-agent-a1.jsonl'], 'subagent', 1],
  ];
  for (const [parts, fileClass, depth] of shapes) {
    for (const sep of ['/', BS]) {
      assert.deepEqual(classifyClaudePath(parts.join(sep)), { action: 'read', fileClass, depth }, parts.join(sep));
    }
  }
  assert.deepEqual(classifyClaudePath(['-fake-alpha', 's1.jsonl.zst'].join(BS)), { action: 'skip', reason: 'compressed' });
  assert.deepEqual(classifyClaudePath(['-fake-alpha', 'notes.txt'].join(BS)), { action: 'skip', reason: 'unknown-extension' });
});

test('win32 roots join with a backslash and trim trailing separators of either kind', () => {
  const home = ['D:', 'fakehome'].join(BS);
  const roots = claudeCodeRoots({ home: home + BS, platform: 'win32', env: {} });
  assert.deepEqual(roots, [[home, '.claude', 'projects'].join(BS), [home, '.config', 'claude', 'projects'].join(BS)]);
  const posix = claudeCodeRoots({ home: '/fake/u/', platform: 'linux', env: { CLAUDE_CONFIG_DIR: '/fake/cfg' } });
  assert.deepEqual(posix, ['/fake/cfg/projects', '/fake/u/.claude/projects', '/fake/u/.config/claude/projects']);
});
