// showcase: one seeded, entirely SYNTHETIC heavy user for the README and share-card showcase.
//   power-user   26 weeks (2026-03-02 to 2026-08-30), long agentic sessions on big contexts,
//                a crew of subagents, a 52-day streak, mornings, afternoons and late nights.
// Nothing here is anyone's real usage: every project is /fake/..., every text is "fictional",
// every number comes from the seeded generator below. The card built from it is labeled as
// synthetic wherever it is shown.
//
// Records are lean (one line per response, short tool inputs) so a heavy half-year stays a few
// megabytes. The trap coverage lives in the personas builder; this one exists for the pictures.
// Output: test/fixtures/showcase/power-user/projects/... and ground-truth.json (UTC, 15-minute cutoff).

import { Persona } from './_persona-engine.mjs';
import { utc, prettyJson, mulberry32, fnv1a } from './_lib.mjs';

export const name = 'showcase';

const IDLE_MINUTES = 15;
const DAYS = 182;
/** Day offsets (from Monday 2026-03-02) of the unbroken streak; the days either side are off. */
const STREAK = [49, 100];
const PROJECTS = ['atlas-app', 'orbit-api', 'lumen-docs'];
const FILES = ['index.js', 'store.js', 'router.js', 'view.js', 'api.js', 'util.js'];
/** Main-thread tool mix (weights). */
const MAIN_TOOLS = [['Read', 25], ['Edit', 22], ['Bash', 25], ['Grep', 10], ['Write', 10], ['Glob', 3], ['TodoWrite', 5]];
const SUB_TOOLS = [['Read', 30], ['Grep', 15], ['Bash', 30], ['Edit', 20], ['Glob', 5]];

/** One response per line, no thinking or iteration echoes: same accounting, a third of the bytes. */
class LeanPersona extends Persona {
  base(s, side, extra = {}) { return { isSidechain: side, sessionId: s.sid, cwd: s.cwd, ...extra }; }

  respond(s, f, o) {
    const side = !!o.side;
    const mid = this.nextId('msg');
    const rid = this.nextId('req');
    const toolId = o.tool ? this.nextId('toolu') : null;
    const u = o.u;
    const usage = {
      input_tokens: u.input, cache_creation_input_tokens: u.cw5m + u.cw1h, cache_read_input_tokens: u.read, output_tokens: u.output,
      cache_creation: { ephemeral_5m_input_tokens: u.cw5m, ephemeral_1h_input_tokens: u.cw1h },
    };
    const block = o.tool ? { type: 'tool_use', id: toolId, name: o.tool.name, input: o.tool.input } : { type: 'text', text: 'fictional summary' };
    this.put(f, {
      ...this.base(s, side, o.agentId ? { agentId: o.agentId } : {}), type: 'assistant', timestamp: this.ts(s), uuid: this.uuid(), requestId: rid,
      message: { id: mid, model: o.model, role: 'assistant', type: 'message', stop_reason: o.tool ? 'tool_use' : 'end_turn', content: [block], usage },
    });
    this.truth.responses.push({ key: mid, cls: f.cls, side, model: o.model, usage, complete: true });
    if (o.tool) this.truth.tools.set(toolId, { name: o.tool.name, input: o.tool.input, status: 'unpaired' });
    s.lastModel = o.model;
    return { mid, toolId };
  }
}

/** @param {LeanPersona} p @param {[string, number][]} mix */
function weighted(p, mix) {
  let x = p.rng() * mix.reduce((a, [, w]) => a + w, 0);
  for (const [n, w] of mix) { if (x < w) return n; x -= w; }
  return mix[0][0];
}

/** A short fictional tool call and its result status. */
function tool(p, s, mix) {
  const kind = weighted(p, mix);
  const file = s.cwd + '/src/' + p.pick(FILES);
  switch (kind) {
    case 'Read': return { name: 'Read', input: { file_path: file }, status: 'ok' };
    case 'Edit': return { name: 'Edit', input: { file_path: file, old_string: 'a', new_string: Array.from({ length: p.int(4, 30) }, () => 'b').join('\n') }, status: p.chance(0.04) ? 'error' : 'ok' };
    case 'Write': return { name: 'Write', input: { file_path: s.cwd + '/src/new_' + p.int(1, 9999) + '.js', content: 'x\ny\nz' }, status: 'ok' };
    case 'Bash': return { name: 'Bash', input: { command: p.pick(['npm test', 'npm run build', 'git status', 'git diff']) }, status: p.chance(0.08) ? 'error' : 'ok' };
    case 'Grep': return { name: 'Grep', input: { pattern: 'fictionalName' }, status: 'ok' };
    case 'Glob': return { name: 'Glob', input: { pattern: '**/*.js' }, status: 'ok' };
    default: return { name: 'TodoWrite', input: { todos: [] }, status: 'ok' };
  }
}

/** Usage for the next response of a thread that keeps its context cached. */
function nextUsage(p, th, grow) {
  const fresh = th.ctx === 0;
  const write = fresh ? p.int(th.base[0], th.base[1]) : p.int(grow[0], grow[1]);
  const u = { input: p.int(2, 60), cw5m: th.ttl === '5m' ? write : 0, cw1h: th.ttl === '1h' ? write : 0, read: th.ctx, output: p.int(th.out[0], th.out[1]) };
  th.ctx += write + u.output;
  return u;
}

/** A subagent run: an Agent call on main, the subagent transcript, and the Agent result. */
function subagentRun(p, s, model) {
  p.tick(s, 3, 12);
  const call = p.respond(s, s.main, { model: s.model, tool: { name: 'Agent', input: { description: 'fictional task', subagent_type: 'general-purpose' } }, u: nextUsage(p, s.thread, [900, 2500]) });
  const agentId = 'a' + (fnv1a(call.toolId) >>> 0).toString(16).padStart(8, '0');
  const f = p.file(`projects/-fake-${s.project}/${s.sid}/subagents/agent-${agentId}.jsonl`, 'subagent');
  p.put(f, { ...p.base(s, true, { agentId }), type: 'user', timestamp: p.ts(s), uuid: p.uuid(), message: { role: 'user', content: 'fictional delegated task' } });
  const th = { ctx: 0, ttl: '5m', base: [30000, 52000], out: [600, 3000] };
  const n = p.int(3, 7);
  for (let r = 0; r < n; r++) {
    p.tick(s, 10, 70);
    const last = r === n - 1;
    const t = last ? null : tool(p, s, SUB_TOOLS);
    const res = p.respond(s, f, { model, side: true, agentId, tool: t && { name: t.name, input: t.input }, u: nextUsage(p, th, [9000, 42000]) });
    if (t) p.result(s, f, res.toolId, t.status, { agentId });
  }
  p.result(s, s.main, call.toolId, 'ok', { content: 'fictional subagent summary' });
}

/** One working session: prompts, agentic loops on the main thread, subagent runs. */
function session(p, n, day, hour, minute, kind) {
  const project = PROJECTS[(day + n) % PROJECTS.length];
  const s = p.session({ n, project, cwd: '/fake/' + project, startMs: utc(2026, 3, 2 + day, hour, minute, p.int(0, 59)) });
  s.model = p.chance(0.7) ? 'claude-fable-5' : 'claude-opus-5[1m]';
  s.thread = { ctx: 0, ttl: '1h', base: [38000, 70000], out: [700, 4200] };
  const prompts = kind === 'night' ? p.int(4, 6) : p.int(3, 5);
  for (let k = 0; k < prompts; k++) {
    if (k > 0) p.tick(s, 240, 860);
    if (s.thread.ctx > 820000) { p.prompt(s, 'compact'); s.thread.ctx = 0; p.tick(s, 20, 60); }
    p.prompt(s, 'text');
    const loop = p.int(2, 4);
    for (let r = 0; r < loop; r++) {
      p.tick(s, 20, 120);
      const last = r === loop - 1;
      const t = last ? null : tool(p, s, MAIN_TOOLS);
      const res = p.respond(s, s.main, { model: s.model, tool: t && { name: t.name, input: t.input }, u: nextUsage(p, s.thread, [6000, 50000]) });
      if (t) p.result(s, s.main, res.toolId, t.status);
    }
    if (p.chance(0.6)) subagentRun(p, s, p.chance(0.7) ? 'claude-fable-5' : 'claude-opus-5');
  }
}

function powerUser(rng) {
  const p = new LeanPersona('power-user', rng, { anchorMs: utc(2026, 3, 2), tz: 'UTC' });
  let n = 0;
  for (let d = 0; d < DAYS; d++) {
    const wd = d % 7; // 0 = Monday
    const inStreak = d >= STREAK[0] && d <= STREAK[1];
    if (d === STREAK[0] - 1 || d === STREAK[1] + 1) continue;
    const active = inStreak || p.chance(wd < 5 ? 0.86 : wd === 5 ? 0.45 : 0.5);
    if (!active) continue;
    /** @type {[number, number, string][]} */
    const slots = [];
    const at = (chance, hours, kind) => { if (p.chance(chance)) slots.push([weighted(p, hours), p.int(0, 55), kind]); };
    if (wd < 5) {
      at(0.45, [[7, 1], [8, 3], [9, 4], [10, 2]], 'day');
      at(0.45, [[12, 1], [13, 3], [14, 3], [15, 2], [16, 1]], 'day');
      at(wd >= 1 && wd <= 3 ? 0.72 : 0.45, [[19, 1], [20, 2], [21, 4], [22, 4], [23, 2]], 'night');
    } else if (wd === 5) {
      at(0.7, [[10, 2], [11, 3], [12, 2]], 'day');
      at(0.45, [[21, 1], [22, 2], [23, 2]], 'night');
    } else {
      at(0.45, [[14, 1], [15, 2], [16, 2]], 'day');
      at(0.7, [[19, 1], [20, 3], [21, 3], [22, 1]], 'night');
    }
    if (!slots.length) slots.push([10, p.int(0, 50), 'day']);
    for (const [h, m, kind] of slots) session(p, ++n, d, h, m, kind);
  }
  return p;
}

export function build(ctx) {
  const p = powerUser(mulberry32((ctx.seed ^ fnv1a('showcase:power-user')) >>> 0));
  const files = p.render().map((f) => ({ path: 'power-user/' + f.path, content: f.content }));
  // Ground truth without the per-response and per-block lists (they would dwarf the summary).
  const { responseValueNano, time, ...truth } = p.groundTruth({ idleMinutes: IDLE_MINUTES });
  void responseValueNano;
  truth.fixture = 'showcase/power-user';
  truth.description = 'Synthetic showcase persona power-user. Ground truth computed from each response\'s true usage at creation.';
  truth.time = { activeSeconds: time.activeSeconds, agentSeconds: time.agentSeconds, workBlocks: time.workBlockSeconds.length };
  files.push({ path: 'power-user/ground-truth.json', content: prettyJson(truth) });
  return { files };
}
