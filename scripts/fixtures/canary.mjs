// canary (DESIGN 9.7): synthetic logs that plant a unique canary string in every place a
// private value can live. The privacy tests assert where each canary may and may not appear.
// The secret canary deliberately does NOT match a real vendor key format end to end.

import { jsonl, usage, fakeSessionId, prettyJson } from './_lib.mjs';

export const name = 'canary';

const S3 = fakeSessionId(3);
const PROJECT = 'CANARY-PROJECT-7f3a';
const CWD = '/fake/' + PROJECT + '/app';

/** Every canary, with where it is planted and where it may legally appear. */
export const CANARIES = Object.freeze({
  project: { value: PROJECT, planted: ['projects/ folder name', 'cwd'], mayAppearIn: ['report HTML when --redact is off'] },
  prompt: { value: 'CANARY-PROMPT-51d0', planted: ['user prompt text', 'user text block'], mayAppearIn: [] },
  title: { value: 'CANARY-TITLE-0b9e', planted: ['custom-title', 'ai-title', 'last-prompt', 'queue-operation'], mayAppearIn: [] },
  agentName: { value: 'CANARY-AGENTNAME-77aa', planted: ['agent-name record'], mayAppearIn: [] },
  secret: { value: 'sk-ant-api03-CANARY-x7Qp2Lm9Vt4Rz8Kd1Nw6Hs3Jf5Yb0Gc', planted: ['Bash tool_result content'], mayAppearIn: [] },
  path: { value: 'CANARY-PATH-91c2', planted: ['Edit and Write file_path, as a folder above the parent folder (I8 shows only parent/basename, never the full path)'], mayAppearIn: [] },
  mcp: { value: 'CANARY-MCP-3e11', planted: ['mcp__ tool name', 'attributionMcpServer'], mayAppearIn: ['report HTML per-server breakdown when --redact is off (see INTERFACES.md open question)'] },
  skill: { value: 'CANARY-SKILL-c4d2', planted: ['attributionSkill'], mayAppearIn: ['report HTML when --redact is off'] },
  attributionAgent: { value: 'CANARY-ATTRAGENT-9a61', planted: ['attributionAgent'], mayAppearIn: ['report HTML when --redact is off'] },
  branch: { value: 'CANARY-BRANCH-2f70', planted: ['gitBranch'], mayAppearIn: [] },
  assistantText: { value: 'CANARY-ASSISTANT-6c3b', planted: ['assistant text block'], mayAppearIn: [] },
  toolInput: { value: 'CANARY-TOOLINPUT-e5f8', planted: ['Bash command', 'Write content'], mayAppearIn: [] },
});

const C = Object.fromEntries(Object.entries(CANARIES).map(([k, v]) => [k, v.value]));

/** @param {number} m @param {number} s */
const ts = (m, s) => `2026-03-04T08:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`;

const common = (t, side = false) => ({ sessionId: S3, isSidechain: side, timestamp: t, cwd: CWD, gitBranch: C.branch, version: '2.1.200' });

export function build() {
  const main = [
    { type: 'custom-title', sessionId: S3, customTitle: C.title },
    { type: 'ai-title', sessionId: S3, aiTitle: C.title },
    { type: 'agent-name', sessionId: S3, agentName: C.agentName },
    { type: 'queue-operation', sessionId: S3, operation: 'enqueue', content: C.title, timestamp: ts(0, 0) },
    { type: 'user', ...common(ts(0, 1)), uuid: 'cu-1', message: { role: 'user', content: 'please look at ' + C.prompt } },
    {
      type: 'assistant', ...common(ts(0, 5)), uuid: 'ca-1', requestId: 'req_c1', attributionSkill: C.skill, attributionAgent: C.attributionAgent,
      message: { id: 'msg_c1', model: 'claude-opus-5', role: 'assistant', stop_reason: null, content: [{ type: 'text', text: 'Reading ' + C.assistantText }], usage: usage(10, 0, 100, 0, 3) },
    },
    {
      type: 'assistant', ...common(ts(0, 6)), uuid: 'ca-2', requestId: 'req_c1', attributionSkill: C.skill, attributionAgent: C.attributionAgent,
      message: {
        id: 'msg_c1', model: 'claude-opus-5', role: 'assistant', stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_c1', name: 'Bash', input: { command: 'cat /fake/' + C.path + '/env.txt # ' + C.toolInput } }],
        usage: { ...usage(10, 0, 100, 0, 40), speed: 'standard' },
      },
    },
    { type: 'user', ...common(ts(0, 9)), uuid: 'cu-2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_c1', content: 'ANTHROPIC_API_KEY=' + C.secret }] } },
    {
      type: 'assistant', ...common(ts(0, 12)), uuid: 'ca-3', requestId: 'req_c2', attributionMcpServer: C.mcp,
      message: {
        id: 'msg_c2', model: 'claude-opus-5', role: 'assistant', stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_c2', name: 'mcp__' + C.mcp + '__lookup', input: { q: C.prompt } }],
        usage: { ...usage(10, 0, 0, 200, 20), speed: 'standard' },
      },
    },
    { type: 'user', ...common(ts(0, 14)), uuid: 'cu-3', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_c2', content: 'fictional lookup result' }] } },
    {
      type: 'assistant', ...common(ts(0, 20)), uuid: 'ca-4', requestId: 'req_c3',
      message: {
        id: 'msg_c3', model: 'claude-opus-5', role: 'assistant', stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_c3', name: 'Edit', input: { file_path: '/fake/' + C.path + '/docs/notes.md', old_string: 'a', new_string: 'b\n' + C.toolInput } }],
        usage: { ...usage(10, 0, 0, 300, 30), speed: 'standard' },
      },
    },
    { type: 'user', ...common(ts(0, 22)), uuid: 'cu-4', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_c3', content: 'ok' }] } },
    { type: 'user', ...common(ts(1, 0)), uuid: 'cu-5', message: { role: 'user', content: [{ type: 'text', text: 'second prompt ' + C.prompt }] } },
    {
      type: 'assistant', ...common(ts(1, 4)), uuid: 'ca-5', requestId: 'req_c4',
      message: {
        id: 'msg_c4', model: 'claude-opus-5', role: 'assistant', stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_c4', name: 'Write', input: { file_path: '/fake/' + C.path + '/docs/new.txt', content: C.toolInput + '\nline two' } }],
        usage: { ...usage(10, 0, 0, 400, 25), speed: 'standard' },
      },
    },
    { type: 'user', ...common(ts(1, 6)), uuid: 'cu-6', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_c4', content: 'written' }] } },
    { type: 'last-prompt', sessionId: S3, lastPrompt: C.title },
  ];
  const expected = {
    fixture: name,
    description: 'DESIGN 9.7 canary corpus. No canary may appear in a PublicSummary, the card manifest, any string drawn on the card, terminal output or the ledger. Only the listed exceptions may appear in the local report HTML, and only with --redact off.',
    canaries: CANARIES,
    responses: 4,
    tools: { calls: 4, callsByDisplayName: { Bash: 1, 'MCP tools': 1, Edit: 1, Write: 1 } },
    prompts: 2,
  };
  return {
    files: [
      { path: `projects/-fake-${PROJECT}/${S3}.jsonl`, content: jsonl(main) },
      { path: 'expected.json', content: prettyJson(expected) },
    ],
  };
}
