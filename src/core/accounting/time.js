// Sessions, time and days (rules A20 to A25, A27).
//
// A21  every timestamp is UTC; day, hour and weekday buckets use the viewer's local zone.
// A22  active time: per session, the union of user and assistant timestamps across the whole
//      session tree (main, subagents, workflow agents), line uuids deduped globally (a forked
//      line counts once), sorted; gaps of at most the idle cutoff are summed. Never wall-clock.
// A23  agent time: the same per FILE, summed (parallel agents counted separately).
// A24  work block: a maximal run with no gap above the cutoff; a lone timestamp is a 0 s block.
// A25  prompts, interrupts, active days, streak, peak hour (prompts come from the adapter).
// A27  coverage from event timestamps, never file mtime.
//
// Isomorphic: no node:* imports and no DOM. Local time uses Intl only.

import { compareByFileOrder } from '../adapters/contract.js';
import { FALLBACK_TIME_ZONE } from '../constants.js';
import { createStringPool } from './intern.js';

const QUARTER_HOUR_MS = 15 * 60 * 1000;
const WEEKDAYS = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/**
 * @typedef {Object} LocalParts
 * @property {string} date     'YYYY-MM-DD'
 * @property {string} month    'YYYY-MM'
 * @property {number} hour     0 to 23
 * @property {number} weekday  0 = Monday ... 6 = Sunday
 */

/**
 * @typedef {Object} LocalClock
 * @property {string} tz             the zone actually used
 * @property {boolean} fellBack      true when the requested zone was unknown and UTC was used
 * @property {(ms: number) => LocalParts} parts
 */

/** @param {number} n */
const pad2 = (n) => (n < 10 ? '0' : '') + n;

/**
 * A clock that turns epoch ms into local calendar parts for one IANA zone, a fixed offset
 * ("+05:30", "-08:00") or "UTC". Results are cached per UTC quarter hour: every current zone
 * offset and every DST transition falls on a quarter-hour boundary.
 * @param {string} [tz]
 * @returns {LocalClock}
 */
export function createLocalClock(tz = FALLBACK_TIME_ZONE) {
  const want = typeof tz === 'string' && tz ? tz : FALLBACK_TIME_ZONE;
  /** @type {(ms: number) => LocalParts} */
  let compute;
  let used = want;
  let fellBack = false;
  const off = /^([+-])(\d{2}):(\d{2})$/.exec(want);
  const utcParts = (/** @type {number} */ ms) => {
    const d = new Date(ms);
    const y = d.getUTCFullYear();
    const mo = pad2(d.getUTCMonth() + 1);
    return { date: y + '-' + mo + '-' + pad2(d.getUTCDate()), month: y + '-' + mo, hour: d.getUTCHours(), weekday: (d.getUTCDay() + 6) % 7 };
  };
  if (want === 'UTC' || want === 'Etc/UTC' || want === 'Z') {
    compute = utcParts;
    used = 'UTC';
  } else if (off) {
    const shift = (off[1] === '+' ? 1 : -1) * (Number(off[2]) * 60 + Number(off[3])) * 60000;
    compute = (ms) => utcParts(ms + shift);
  } else {
    let fmt = null;
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: want, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short',
      });
    } catch {
      fmt = null;
    }
    if (!fmt) {
      compute = utcParts;
      used = FALLBACK_TIME_ZONE;
      fellBack = true;
    } else {
      const f = fmt;
      compute = (ms) => {
        /** @type {Record<string, string>} */
        const p = {};
        for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
        const hour = Number(p.hour) % 24;
        return { date: p.year + '-' + p.month + '-' + p.day, month: p.year + '-' + p.month, hour, weekday: WEEKDAYS[/** @type {keyof typeof WEEKDAYS} */ (p.weekday)] ?? 0 };
      };
    }
  }
  /** @type {Map<number, LocalParts>} */
  const cache = new Map();
  return {
    tz: used,
    fellBack,
    parts(ms) {
      const q = Math.floor(ms / QUARTER_HOUR_MS);
      let base = cache.get(q);
      if (!base) {
        base = compute(q * QUARTER_HOUR_MS);
        if (cache.size > 200000) cache.clear();
        cache.set(q, base);
      }
      return base;
    },
  };
}

/**
 * Day number of a 'YYYY-MM-DD' date (days since 1970-01-01), for streaks.
 * @param {string} date
 * @returns {number}
 */
export function dayNumber(date) {
  return Math.round(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 86_400_000);
}

/**
 * Active milliseconds and work blocks of one sorted-or-not timestamp list (rules A22, A24).
 * A gap counts iff gap <= idleMs; a gap above the cutoff starts a new block.
 * @param {number[]} tl  epoch ms (sorted in place)
 * @param {number} idleMs
 * @returns {{ activeMs: number, blocksMs: number[], first: number|null, last: number|null }}
 */
export function activeTime(tl, idleMs) {
  if (tl.length === 0) return { activeMs: 0, blocksMs: [], first: null, last: null };
  tl.sort((a, b) => a - b);
  let activeMs = 0;
  const blocksMs = [];
  let start = tl[0];
  for (let i = 1; i < tl.length; i++) {
    const g = tl[i] - tl[i - 1];
    if (g <= idleMs) activeMs += g;
    else { blocksMs.push(tl[i - 1] - start); start = tl[i]; }
  }
  blocksMs.push(tl[tl.length - 1] - start);
  return { activeMs, blocksMs, first: tl[0], last: tl[tl.length - 1] };
}

/** @param {number} ms */
const sec = (ms) => ms / 1000;

/**
 * Longest run of consecutive dates in a sorted list.
 * @param {string[]} dates sorted 'YYYY-MM-DD'
 * @returns {number}
 */
export function longestStreak(dates) {
  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of dates) {
    const n = dayNumber(d);
    run = prev !== null && n - prev === 1 ? run + 1 : 1;
    if (run > best) best = run;
    prev = n;
  }
  return best;
}

/**
 * Per-session figures the accounting pipeline needs for SessionAggregate.
 * @typedef {{ activeSeconds: number, workBlocks: number, firstTs: number|null, lastTs: number|null }} SessionTime
 */

/**
 * @param {import('../adapters/contract.js').FileRef[]} files
 * @param {{ clock: LocalClock, idleSeconds: number, inWindow?: (ts: number|null) => boolean }} opts
 */
export function createTimeTracker(files, opts) {
  const idleMs = opts.idleSeconds * 1000;
  const inWindow = opts.inWindow || (() => true);
  /** Deduped activity keyed by line uuid: [ts, fileIdx, lineNo, sessionId]. */
  /** @type {Map<string, { ts: number, fileIdx: number, lineNo: number, sessionId: string|null }>} */
  const byUuid = new Map();
  /** @type {{ ts: number, fileIdx: number, lineNo: number, sessionId: string|null }[]} */
  const noUuid = [];
  /** @type {Map<string, { ts: number, fileIdx: number, lineNo: number }>} */
  const prompts = new Map();
  /** @type {Map<string, { ts: number, fileIdx: number, lineNo: number }>} */
  const interrupts = new Map();
  // One activity record is kept per line uuid for the length of the scan, so the session id on
  // it is interned: without that a long session holds one copy of its own id per line.
  const intern = createStringPool();

  /**
   * @param {Map<string, any>} map
   * @param {string} key
   * @param {{ ts: number, fileIdx: number, lineNo: number }} rec
   */
  function keep(map, key, rec) {
    const cur = map.get(key);
    if (!cur || compareByFileOrder(rec, cur, files) < 0) map.set(key, rec);
  }

  return {
    /** @param {import('../adapters/contract.js').ActivityEvent} ev */
    addActivity(ev) {
      if (!inWindow(ev.ts)) return;
      const rec = { ts: ev.ts, fileIdx: ev.fileIdx, lineNo: ev.lineNo, sessionId: intern(ev.sessionId) };
      if (ev.uuid) keep(byUuid, ev.uuid, rec);
      else noUuid.push(rec);
    },
    /** @param {import('../adapters/contract.js').PromptEvent|import('../adapters/contract.js').InterruptEvent} ev */
    addPrompt(ev) {
      if (!inWindow(ev.ts)) return;
      const map = ev.kind === 'interrupt' ? interrupts : prompts;
      keep(map, ev.uuid || 'line:' + ev.fileIdx + ':' + ev.lineNo, { ts: ev.ts, fileIdx: ev.fileIdx, lineNo: ev.lineNo });
    },

    /**
     * @returns {{ time: import('./contract.js').TimeResult, sessions: Map<string|null, SessionTime>, sessionCount: number }}
     */
    finish() {
      const clock = opts.clock;
      /** @type {Map<string|null, number[]>} */
      const bySession = new Map();
      /** @type {Map<number, number[]>} */
      const byFile = new Map();
      let earliestMainTs = null;
      let earliestAnyTs = null;
      let latestTs = null;
      const all = [...byUuid.values(), ...noUuid];
      for (const a of all) {
        let s = bySession.get(a.sessionId);
        if (!s) { s = []; bySession.set(a.sessionId, s); }
        s.push(a.ts);
        let f = byFile.get(a.fileIdx);
        if (!f) { f = []; byFile.set(a.fileIdx, f); }
        f.push(a.ts);
        if (earliestAnyTs === null || a.ts < earliestAnyTs) earliestAnyTs = a.ts;
        if (latestTs === null || a.ts > latestTs) latestTs = a.ts;
        const file = files[a.fileIdx];
        if (file && file.fileClass === 'main' && (earliestMainTs === null || a.ts < earliestMainTs)) earliestMainTs = a.ts;
      }
      let activeMs = 0;
      /** @type {number[]} */
      const blocksMs = [];
      /** @type {Map<string|null, SessionTime>} */
      const sessions = new Map();
      for (const [sid, tl] of bySession) {
        const w = activeTime(tl, idleMs);
        activeMs += w.activeMs;
        for (const b of w.blocksMs) blocksMs.push(b);
        sessions.set(sid, { activeSeconds: sec(w.activeMs), workBlocks: w.blocksMs.length, firstTs: w.first, lastTs: w.last });
      }
      let agentMs = 0;
      const agentMsByClass = { main: 0, subagent: 0, workflow_agent: 0 };
      for (const [fi, tl] of byFile) {
        const w = activeTime(tl, idleMs);
        agentMs += w.activeMs;
        const cls = files[fi] ? files[fi].fileClass : 'main';
        if (cls === 'main' || cls === 'subagent' || cls === 'workflow_agent') agentMsByClass[cls] += w.activeMs;
      }

      /** @type {Record<string, number>} */
      const byDay = {};
      const byHour = new Array(24).fill(0);
      const heatmap = Array.from({ length: 7 }, () => new Array(24).fill(0));
      for (const p of prompts.values()) {
        const lp = clock.parts(p.ts);
        byDay[lp.date] = (byDay[lp.date] || 0) + 1;
        byHour[lp.hour]++;
        heatmap[lp.weekday][lp.hour]++;
      }
      const activeDays = Object.keys(byDay).sort();
      /** @type {Record<string, number>} */
      const promptsByLocalDay = {};
      for (const d of activeDays) promptsByLocalDay[d] = byDay[d];
      let peakHourLocal = null;
      if (prompts.size > 0) {
        peakHourLocal = 0;
        for (let h = 1; h < 24; h++) if (byHour[h] > byHour[peakHourLocal]) peakHourLocal = h;
      }
      const sessionCount = [...bySession.keys()].filter((k) => k !== null).length;
      return {
        time: {
          tz: clock.tz,
          idleSeconds: opts.idleSeconds,
          activeSeconds: sec(activeMs),
          agentSeconds: sec(agentMs),
          agentSecondsByClass: { main: sec(agentMsByClass.main), subagent: sec(agentMsByClass.subagent), workflow_agent: sec(agentMsByClass.workflow_agent) },
          workBlockSeconds: blocksMs.sort((a, b) => a - b).map(sec),
          prompts: prompts.size,
          interrupts: interrupts.size,
          promptsByLocalDay,
          promptsByLocalHour: byHour,
          promptHeatmap: heatmap,
          activeDays,
          longestStreakDays: longestStreak(activeDays),
          peakHourLocal,
          earliestMainTs,
          earliestAnyTs,
          latestTs,
        },
        sessions,
        sessionCount,
      };
    },
  };
}
