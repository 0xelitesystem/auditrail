// personas (DESIGN 9.5): three seeded fake HOMEs with every trap and exact ground truth.
//   solo-night-owl      main-thread heavy, late-night prompts, a 16-day streak, a truncated tail line
//   subagent-lead       heavy delegation: subagents, workflow agents and journals, forks, an orphaned
//                       copy, quota rejections, synthetic 429s, cost-state noise, a 1.35 MB line
//   cache-miss-spender  long idle gaps that rewrite the cache, model switches, Fable 5 and 5.1, fast
//                       mode, US geo, fallback iterations, an unknown model, missing and mismatched
//                       TTL splits, web search, a dated Haiku id, a CRLF file, a superseded copy
// Output: test/fixtures/personas/<persona>/projects/... and ground-truth.json (UTC, 15-minute cutoff).

import { Persona } from './_persona-engine.mjs';
import { utc, prettyJson, mulberry32, fnv1a } from './_lib.mjs';

export const name = 'personas';

const IDLE_MINUTES = 15;
const SRC_FILES = ['parser.js', 'widget.js', 'config.js', 'router.js', 'store.js', 'view.js', 'util.js', 'api.js'];

/** A tool call with its eventual result status. */
function toolCall(p, proj, kinds) {
  const kind = p.pick(kinds);
  const file = `/fake/${proj}/src/${p.pick(SRC_FILES)}`;
  const nl = (k) => Array.from({ length: k }, (_, i) => 'fictional line ' + i).join('\n');
  switch (kind) {
    case 'Edit': {
      const failed = p.chance(0.06);
      return { name: 'Edit', input: { file_path: file, old_string: 'old fictional text', new_string: nl(p.int(1, 14)) }, status: failed ? 'error' : 'ok', content: failed ? 'String to replace not found in file.' : undefined };
    }
    case 'MultiEdit':
      return { name: 'MultiEdit', input: { file_path: file, edits: [{ old_string: 'a', new_string: nl(p.int(1, 4)) }, { old_string: 'b', new_string: nl(p.int(1, 3)) }] }, status: 'ok' };
    case 'Write': {
      const denied = p.chance(0.05);
      return { name: 'Write', input: { file_path: `/fake/${proj}/src/new_${p.int(1, 999)}.js`, content: nl(p.int(3, 40)) }, status: denied ? 'denied' : 'ok' };
    }
    case 'Bash': {
      const failed = p.chance(0.1);
      return { name: 'Bash', input: { command: p.pick(['npm test', 'git status', 'git commit -m "fictional change"', 'npm run build', 'ls src', 'git push', 'npm install']), description: 'fictional step' }, status: failed ? 'error' : 'ok' };
    }
    case 'Read': return { name: 'Read', input: { file_path: file }, status: 'ok', content: 'fictional file body' };
    case 'Grep': return { name: 'Grep', input: { pattern: 'fictionalName', path: `/fake/${proj}` }, status: 'ok' };
    case 'Glob': return { name: 'Glob', input: { pattern: '**/*.js' }, status: 'ok' };
    case 'WebFetch': return { name: 'WebFetch', input: { url: 'https://example.com/fictional-doc', prompt: 'summarize' }, status: p.chance(0.1) ? 'error' : 'ok' };
    case 'WebSearch': return { name: 'WebSearch', input: { query: 'fictional query' }, status: 'ok' };
    case 'mcp': return { name: 'mcp__fake-notes__search', input: { q: 'fictional' }, status: 'ok' };
    case 'TodoWrite': return { name: 'TodoWrite', input: { todos: [{ content: 'fictional todo', status: 'pending' }] }, status: 'ok' };
    default: throw new Error('unknown tool kind ' + kind);
  }
}

/** Cache-shaped usage for the next response in a thread (5m on sidechains, 1h on main). */
function nextUsage(p, thread, o = {}) {
  const fresh = thread.ctx === 0 || o.rewrite;
  const write = fresh ? Math.max(thread.ctx, p.int(12000, 30000)) : p.int(150, 3000);
  const u = { input: p.int(1, 40), cw5m: thread.ttl === '5m' ? write : 0, cw1h: thread.ttl === '1h' ? write : 0, read: fresh ? 0 : thread.ctx, output: p.int(60, 1600) };
  thread.ctx = (fresh ? write : thread.ctx + write) + u.output;
  return u;
}

/** One prompt and its responses on the main thread. */
function mainTurn(p, s, o) {
  p.prompt(s, o.promptKind || 'text');
  const n = o.responses ?? p.int(1, 3);
  for (let r = 0; r < n; r++) {
    p.tick(s, 3, 25);
    const tool = r < n - 1 || p.chance(0.5) ? toolCall(p, s.project, o.kinds) : null;
    const u = nextUsage(p, s.thread, { rewrite: r === 0 && o.rewrite });
    const res = p.respond(s, s.main, { model: o.model, tool: tool && { name: tool.name, input: tool.input }, u, dropRequestIdOnLine: o.dropRequestIdFirst && r === 0 ? 0 : undefined, quota: o.quota && r === 0 ? o.quota : undefined, ...(o.respond || {}) });
    if (tool) p.result(s, s.main, res.toolId, tool.status, { content: tool.content });
  }
}

/** A subagent run: an Agent call on main, a subagent file, and the Agent result on main. */
function subagentRun(p, s, o) {
  p.tick(s, 3, 15);
  const agentTool = { name: 'Agent', input: { description: 'fictional task', prompt: 'do the fictional task', subagent_type: 'general-purpose' } };
  const call = p.respond(s, s.main, { model: o.parentModel, tool: agentTool, u: nextUsage(p, s.thread) });
  const agentId = 'a' + (fnv1a(call.toolId) >>> 0).toString(16).padStart(8, '0');
  const rel = `projects/-fake-${s.project}/${s.sid}/subagents/agent-${agentId}.jsonl`;
  const f = p.file(rel, 'subagent');
  if (o.crlf) f.crlf = true;
  if (o.forkFrom) for (const rec of o.forkFrom) p.put(f, JSON.parse(JSON.stringify(rec)), false); // forked copy of parent lines
  p.tick(s, 1, 3);
  p.put(f, { ...p.base(s, true, { agentId }), type: 'user', timestamp: p.ts(s), uuid: p.uuid(), message: { role: 'user', content: 'fictional delegated task' } });
  const thread = { ctx: 0, ttl: '5m' };
  let sum = 0;
  for (let r = 0; r < o.responses; r++) {
    p.tick(s, 2, 20);
    const complete = !p.chance(o.incompleteRate);
    const tool = toolCall(p, s.project, o.kinds);
    const u = nextUsage(p, thread);
    sum += u.input + u.cw5m + u.read + u.output;
    const res = p.respond(s, f, { model: o.model, side: true, agentId, tool: { name: tool.name, input: tool.input }, u, complete, attribution: o.attribution });
    if (o.bigResultAt === r) p.result(s, f, res.toolId, 'ok', { agentId, content: 'fictional words '.repeat(85000) });
    else if (!complete && p.chance(o.unpairedRate || 0)) { /* interrupted: no result ever written (unpaired) */ }
    else p.result(s, f, res.toolId, tool.status, { agentId, content: tool.content });
  }
  // Agent result on main carries a toolUseResult usage snapshot that must NEVER be added (rule A16).
  p.result(s, s.main, call.toolId, 'ok', { content: 'fictional subagent summary', toolUseResult: { status: 'completed', totalTokens: Math.floor(sum / 7), usage: { input_tokens: 5, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 } } });
  return f;
}

/** A workflow run: a Workflow call on main, a journal and several workflow agent files. */
function workflowRun(p, s, o) {
  p.tick(s, 3, 15);
  const call = p.respond(s, s.main, { model: o.parentModel, tool: { name: 'Workflow', input: { name: 'fictional-review' } }, u: nextUsage(p, s.thread) });
  const run = 'wf_' + (fnv1a(call.toolId) >>> 0).toString(16).padStart(8, '0') + '-' + String(p.int(100, 999));
  const dir = `projects/-fake-${s.project}/${s.sid}/subagents/workflows/${run}`;
  const journal = p.file(`${dir}/journal.jsonl`, 'workflow_journal');
  if (o.launched) { p.put(journal, { type: 'launched' }); p.truth.workflows.launched++; }
  for (let a = 0; a < o.agents; a++) {
    const agentId = 'w' + (fnv1a(run + a) >>> 0).toString(16).padStart(8, '0');
    p.put(journal, { type: 'started', key: 'step-' + a, agentId, label: 'fictional step ' + a, phase: 'review' });
    p.truth.workflows.started++;
    const f = p.file(`${dir}/agent-${agentId}.jsonl`, 'workflow_agent');
    p.tick(s, 1, 5);
    p.put(f, { ...p.base(s, true, { agentId }), type: 'user', timestamp: p.ts(s), uuid: p.uuid(), message: { role: 'user', content: 'fictional workflow step' } });
    const thread = { ctx: 0, ttl: '5m' };
    const n = p.int(o.minResponses, o.maxResponses);
    for (let r = 0; r < n; r++) {
      p.tick(s, 2, 15);
      const complete = !p.chance(o.incompleteRate);
      const tool = toolCall(p, s.project, o.kinds);
      const res = p.respond(s, f, { model: o.model, side: true, agentId, tool: { name: tool.name, input: tool.input }, u: nextUsage(p, thread), complete });
      if (!complete && r === n - 1 && p.chance(o.unpairedRate || 0)) continue;
      p.result(s, f, res.toolId, tool.status, { agentId, content: tool.content });
    }
    const failed = a === o.failAgent;
    p.put(journal, failed ? { type: 'failed', key: 'step-' + a, agentId } : { type: 'result', key: 'step-' + a, agentId, result: { verdict: 'fictional', summary: 'fictional workflow result text' } });
    p.truth.workflows[failed ? 'failed' : 'result']++;
  }
  p.result(s, s.main, call.toolId, 'ok', { content: 'fictional workflow summary' });
}

/* ------------------------------------------------------------------------------------------ */

function soloNightOwl(rng) {
  const p = new Persona('solo-night-owl', rng, { anchorMs: utc(2026, 3, 2), tz: 'UTC' });
  const kinds = ['Edit', 'Edit', 'Edit', 'Write', 'Bash', 'Bash', 'Read', 'Read', 'Grep', 'MultiEdit', 'TodoWrite'];
  let last = null;
  for (let d = 0; d < 16; d++) {
    const s = p.session({ n: d + 1, project: 'nightowl-app', cwd: '/fake/nightowl-app', startMs: utc(2026, 3, 2 + d, 21, p.int(0, 50), p.int(0, 59)) });
    s.thread = { ctx: 0, ttl: '1h' };
    if (d === 0) p.noise(s);
    const prompts = p.int(3, 6);
    const model = d % 4 === 3 ? 'claude-opus-5[1m]' : 'claude-opus-5';
    for (let k = 0; k < prompts; k++) {
      if (k > 0) p.tick(s, 60, k === 3 ? 1500 : 480);
      mainTurn(p, s, { model, kinds, promptKind: d === 5 && k === 1 ? 'block' : 'text', dropRequestIdFirst: d === 2 && k === 0 });
      if (d === 7 && k === 1) { p.tick(s, 5, 10); p.prompt(s, 'interrupt'); }
      if (d === 9 && k === 0) { p.tick(s, 1, 2); p.prompt(s, 'meta'); p.tick(s, 1, 2); p.prompt(s, 'system'); }
      if (d === 11 && k === 0) { p.tick(s, 1, 2); p.prompt(s, 'compact'); }
    }
    if (d % 4 === 1) subagentRun(p, s, { parentModel: model, model: 'claude-sonnet-5', responses: p.int(2, 4), incompleteRate: 0.2, kinds: ['Read', 'Grep', 'Glob', 'Bash'] });
    last = s;
  }
  last.main.tail = '{"type":"assistant","message":{"id":"msg_truncated_tail"'; // live file caught mid-write
  return p;
}

function subagentLead(rng) {
  const p = new Persona('subagent-lead', rng, { anchorMs: utc(2026, 3, 2), tz: 'UTC' });
  const kinds = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'WebFetch', 'mcp'];
  const dayOffsets = [0, 1, 2, 3, 4, 5, 7, 8, 9, 10];
  let n = 0;
  const RESET_A = 1772899200; // fictional epoch seconds
  const RESET_B = 1773331200;
  for (const [i, d] of dayOffsets.entries()) {
    for (const slot of [0, 1]) {
      n++;
      const project = slot === 0 ? 'beta-service' : 'gamma-web';
      const s = p.session({ n, project, cwd: '/fake/' + project, startMs: utc(2026, 3, 2 + d, slot === 0 ? 9 : 14, p.int(0, 40), p.int(0, 59)) });
      s.thread = { ctx: 0, ttl: '1h' };
      const model = i % 3 === 2 ? 'claude-opus-5' : 'claude-opus-4-8';
      if (n === 1) { p.noise(s); p.costState(s); }
      if (slot === 0 && i % 2 === 1) s.cwd = '/fake/beta-service/api'; // per-line cwd below the launch folder (rule A29)
      const quota = (i === 3 && slot === 1) ? { status: 'rejected', resetsAt: RESET_A, rateLimitType: 'five_hour', unifiedRateLimitFallbackAvailable: false, overageStatus: 'rejected' }
        : (i === 7 && slot === 0) ? { status: 'rejected', resetsAt: RESET_B, rateLimitType: 'five_hour', unifiedRateLimitFallbackAvailable: false, overageStatus: 'rejected' }
          : (i === 2 && slot === 0) ? { status: 'allowed_warning', resetsAt: RESET_A, rateLimitType: 'five_hour' } : undefined;
      if (quota && quota.status === 'rejected') p.truth.quotaResets.add(quota.resetsAt);
      mainTurn(p, s, { model, kinds, responses: p.int(1, 2), quota });
      if (i === 3 && slot === 1) { for (let k = 0; k < 3; k++) p.synthetic429(s); }
      if (i === 7 && slot === 0) { for (let k = 0; k < 2; k++) p.synthetic429(s); }
      const forkFrom = n === 1 ? s.main.records.filter((r) => r.type === 'assistant' && r.message && r.message.model !== '<synthetic>').slice(-2) : null;
      const runs = p.int(1, 2);
      for (let r = 0; r < runs; r++) {
        const f = subagentRun(p, s, {
          parentModel: model, model: 'claude-sonnet-5', responses: p.int(3, 6), incompleteRate: 0.2, unpairedRate: 0.1, kinds,
          forkFrom: r === 0 ? forkFrom : null, bigResultAt: n === 11 && r === 0 ? 1 : undefined,
          attribution: r === 1 ? { attributionAgent: 'fictional-reviewer', attributionSkill: 'fictional-skill' } : undefined,
        });
        if (n === 5 && r === 0) {
          const orphan = p.file(f.rel.replace(/agent-([^/]+)\.jsonl$/, '.orphaned-agent-$1.jsonl'), 'subagent', false);
          for (const rec of f.records) p.put(orphan, JSON.parse(JSON.stringify(rec)), false);
        }
      }
      if (n % 2 === 0) workflowRun(p, s, { parentModel: model, model: n % 4 === 0 ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-5', agents: 3, minResponses: 2, maxResponses: 5, incompleteRate: 0.25, unpairedRate: 0.2, kinds, failAgent: n % 6 === 0 ? 1 : -1, launched: n % 4 === 0 });
      p.tick(s, 120, 600);
      mainTurn(p, s, { model, kinds, responses: 1 });
    }
  }
  return p;
}

function cacheMissSpender(rng) {
  const p = new Persona('cache-miss-spender', rng, { anchorMs: utc(2026, 3, 9), tz: 'UTC' });
  const kinds = ['Read', 'Edit', 'Bash', 'WebSearch', 'Write', 'Grep'];
  let supersedeSource = null;
  for (let d = 0; d < 8; d++) {
    const s = p.session({ n: d + 1, project: 'spender-lab', cwd: '/fake/spender-lab', startMs: utc(2026, 3, 9 + d, 13, p.int(0, 30), p.int(0, 59)) });
    s.thread = { ctx: 0, ttl: '1h' };
    const model = d < 4 ? 'claude-fable-5' : 'claude-fable-5-1';
    if (d === 3) s.cwd = '/fake/spender-lab/tools';
    const prompts = p.int(3, 5);
    for (let k = 0; k < prompts; k++) {
      const longGap = k > 0 && (k % 2 === 1);
      if (k > 0) p.tick(s, longGap ? 4200 : 240, longGap ? 7200 : 700);
      mainTurn(p, s, { model: d === 2 && k === 2 ? 'claude-opus-4-8' : model, kinds, rewrite: longGap, responses: p.int(1, 2) });
    }
    const special = (o) => { p.tick(s, 20, 60); p.prompt(s, 'text'); p.tick(s, 3, 10); return p.respond(s, s.main, o); };
    const ctx = s.thread.ctx;
    if (d === 1) special({ model: 'claude-opus-5', u: { input: 800, cw5m: 0, cw1h: 2000, read: ctx, output: 900 }, speed: 'fast', lines: 2 });
    if (d === 2) special({ model: 'claude-opus-5', u: { input: 700, cw5m: 0, cw1h: 1500, read: ctx, output: 600 }, geo: 'us', lines: 2 });
    if (d === 3) {
      special({
        model: 'claude-opus-4-8', lines: 2, u: { input: 1200, cw5m: 0, cw1h: 0, read: ctx, output: 300 },
        iterations: [
          { type: 'message', model: 'claude-fable-5', input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: ctx, cache_creation_input_tokens: 0 },
          { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: ctx, cache_creation_input_tokens: 0 },
        ],
      });
    }
    if (d === 4) {
      special({
        model: 'claude-opus-4-8', lines: 1, u: { input: 900, cw5m: 0, cw1h: 0, read: ctx, output: 150 },
        iterations: [
          { type: 'message', model: 'claude-fable-5-1', input_tokens: 900, output_tokens: 0, cache_read_input_tokens: ctx, cache_creation_input_tokens: 0 },
          { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 900, output_tokens: 150, cache_read_input_tokens: ctx, cache_creation_input_tokens: 0 },
        ],
      });
      subagentRun(p, s, { parentModel: model, model: 'claude-haiku-4-5-20251001', responses: 3, incompleteRate: 0, kinds: ['Read', 'Grep'], crlf: true });
    }
    if (d === 5) {
      special({ model: 'claude-imaginary-9', u: { input: 10, cw5m: 0, cw1h: 0, read: 0, output: 20 }, lines: 1 });
      special({ model: model, u: { input: 30, cw5m: 0, cw1h: 5000, read: 0, output: 200 }, noSplit: true, lines: 2 });
    }
    if (d === 6) {
      special({ model: model, u: { input: 30, cw5m: 300, cw1h: 700, read: ctx, output: 250 }, splitOverride: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 900 }, lines: 2 });
      const ws = special({ model: model, u: { input: 40, cw5m: 0, cw1h: 800, read: ctx, output: 400 }, webSearch: 2, lines: 3, tool: { name: 'WebSearch', input: { query: 'fictional query' } } });
      p.result(s, s.main, ws.toolId, 'ok', { content: 'fictional search results' });
    }
    if (d === 7) {
      const sid = subagentRun(p, s, { parentModel: model, model: 'claude-sonnet-5', responses: 4, incompleteRate: 0.25, kinds });
      void sid;
    }
    if (d === 0) supersedeSource = s;
  }
  // A superseded copy of day 0's main file: a strict prefix, ending after a complete tool result.
  const src = supersedeSource.main;
  let cut = 0;
  src.records.forEach((r, i) => { if (i < src.records.length * 0.6 && r.type === 'user' && Array.isArray(r.message && r.message.content)) cut = i + 1; });
  const sup = p.file(src.rel + '.superseded-1', 'main', false);
  for (const rec of src.records.slice(0, cut)) p.put(sup, JSON.parse(JSON.stringify(rec)), false);
  return p;
}

export function build(ctx) {
  const files = [];
  for (const [label, make] of [['solo-night-owl', soloNightOwl], ['subagent-lead', subagentLead], ['cache-miss-spender', cacheMissSpender]]) {
    const p = make(mulberry32((ctx.seed ^ fnv1a('persona:' + label)) >>> 0));
    for (const f of p.render()) files.push({ path: `${label}/${f.path}`, content: f.content });
    files.push({ path: `${label}/ground-truth.json`, content: prettyJson(p.groundTruth({ idleMinutes: IDLE_MINUTES })) });
  }
  return { files };
}
